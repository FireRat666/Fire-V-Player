/**
 * @fileoverview Media URL classifier and metadata extractor shared between browser and server.
 * Identifies supported media types (YouTube, Twitch live/VOD/clip, Vimeo, VDO.Ninja, HLS, direct files)
 * and enforces platform trust validation.
 * @module public/media-sources
 */

/**
 * @typedef {Object} DetectedMedia
 * @property {'youtube'|'file'|'hls'|'dash'|'mpegts'|'twitch'|'twitchclip'|'vimeo'|'vdoninja'|'archive'|'loc'|'tubi'|'nasa'} type - The detected media stream/source type.
 *   'tubi' is a Tubi movie, episode or series page, and 'nasa' a NASA+ video page: the player asks the
 *   server for the page's stream when it plays (`stream` is true), as Tubi's stream links expire.
 *   'archive' is an Internet Archive page or item (or a publicdomainmovie.net page) that the server
 *   turns into one of the item's files before it is played. 'loc' is a Library of Congress film page
 *   or handle, which the server turns into the film's video file on tile.loc.gov.
 * @property {string} [channel] - Twitch channel name if applicable.
 * @property {string} [video] - Twitch VOD ID if applicable.
 * @property {string} [clip] - Twitch clip slug if applicable.
 * @property {string} [id] - Vimeo video ID if applicable.
 * @property {string} [hash] - Vimeo unlisted hash token if applicable.
 * @property {string} [name] - VDO.Ninja stream/room identifier if applicable.
 * @property {boolean} [live] - True for an MPEG-TS link that is a live stream (VRCDN's .live.ts).
 * @property {string} [url] - The address to play, when it differs from the link (a VRCDN rtspt:// link,
 *   a Google Drive or Dropbox share link).
 * @property {boolean} [drive] - True for a Google Drive file.
 * @property {string} [archive] - For a 'file' on the Internet Archive: the item's identifier.
 * @property {boolean} [loc] - For a 'file' on the Library of Congress's tile.loc.gov.
 * @property {string} [collection] - For a Library of Congress film handle: its collection (ntscrm, say).
 * @property {string} [number] - For a Library of Congress film handle: its number.
 * @property {string} [file] - For an Internet Archive link to one of an item's video files: its name.
 * @property {string} [page] - For a publicdomainmovie.net page: the page to read the item from.
 * @property {'movie'|'episode'|'series'} [kind] - For Tubi: what the page is. A series is a list of episodes.
 * @property {string} [slug] - For NASA+: the video's name in its address.
 * @property {boolean} [stream] - True when the player gets the stream from the server (/api/stream).
 */

var MediaSources = (() => {
  /** Regular expression matching supported direct media file extensions. */
  const FILE_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v|mp3|m4a|wav|flac|aac|opus)$/i;

  /** Non-channel page segments for twitch.tv. */
  const TWITCH_PAGES = new Set(['videos', 'directory', 'p', 'downloads', 'jobs', 'settings', 'subscriptions',
    'inventory', 'wallet', 'search', 'friends', 'messages', 'drops', 'turbo', 'prime', 'store', 'login', 'signup']);

  /**
   * Safely parses a string into an HTTP/HTTPS URL instance.
   * @param {string} link - Raw link to parse.
   * @returns {URL|null} Parsed URL instance or null if invalid or unsupported protocol.
   */
  function parseUrl(link) {
    try {
      const u = new URL(String(link || '').trim());
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Analyzes an input URL and detects the media provider and stream metadata.
   *
   * @param {string} link - The media URL to analyze.
   * @returns {DetectedMedia|null} Metadata descriptor or null if unrecognized.
   */
  function detect(link) {
    // VRCDN's PC link (rtspt://stream.vrcdn.live/live/<name>) is RTSP, which no browser plays, but
    // the same stream is also at https://.../live/<name>.live.ts, its Quest link.
    const rtsp = /^rtspt?:\/\/((?:[a-z0-9-]+\.)*vrcdn\.(?:live|video|cloud))(?::\d+)?\/live\/([A-Za-z0-9_-]{1,100})\/?$/i.exec(String(link || '').trim());
    if (rtsp) return { type: 'mpegts', live: true, url: `https://${rtsp[1].toLowerCase()}/live/${rtsp[2]}.live.ts` };
    const u = parseUrl(link);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    const parts = u.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      return { type: 'youtube' };
    }

    // Clips: twitch.tv/<channel>/clip/<slug>, clips.twitch.tv/<slug>, clips.twitch.tv/embed?clip=<slug>
    const CLIP = /^[A-Za-z0-9_-]{3,100}$/;
    if (host === 'clips.twitch.tv') {
      const slug = parts[0] === 'embed' ? (u.searchParams.get('clip') || '') : (parts[0] || '');
      return CLIP.test(slug) ? { type: 'twitchclip', clip: slug, channel: '' } : null;
    }
    if (host === 'twitch.tv' && parts[1] === 'clip' && CLIP.test(parts[2] || '') && /^[a-zA-Z0-9_]{2,25}$/.test(parts[0])) {
      return { type: 'twitchclip', clip: parts[2], channel: parts[0].toLowerCase() };
    }
    if (host === 'twitch.tv' && parts[0] === 'clip' && CLIP.test(parts[1] || '')) {
      return { type: 'twitchclip', clip: parts[1], channel: '' };
    }

    if (host === 'twitch.tv' || host === 'player.twitch.tv') {
      if (host === 'player.twitch.tv') {
        const video = (u.searchParams.get('video') || '').replace(/^v/, '');
        if (/^\d+$/.test(video)) return { type: 'twitch', video };
        const channel = u.searchParams.get('channel') || '';
        return /^[a-zA-Z0-9_]{2,25}$/.test(channel) ? { type: 'twitch', channel: channel.toLowerCase() } : null;
      }
      if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return { type: 'twitch', video: parts[1] };
      // twitch.tv/<channel>, but not a clip (twitch.tv/<channel>/clip/...) or a site page.
      if (parts.length === 1 && /^[a-zA-Z0-9_]{2,25}$/.test(parts[0]) && !TWITCH_PAGES.has(parts[0].toLowerCase())) {
        return { type: 'twitch', channel: parts[0].toLowerCase() };
      }
      return null;
    }

    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, player.vimeo.com/video/123?h=abcdef
      const i = parts.findIndex(p => /^\d+$/.test(p));
      if (i === -1) return null;
      const next = parts[i + 1] || '';
      const hash = u.searchParams.get('h') || (/^[0-9a-f]{6,}$/i.test(next) ? next : '');
      return { type: 'vimeo', id: parts[i], hash };
    }

    // VDO.Ninja: vdo.ninja/?view=<stream id> (or ?room=<room>&scene for a whole room), also obs.ninja.
    if (/(^|\.)(vdo|obs)\.ninja$/.test(host)) {
      // Only links that watch: a room link without "scene" would join the room and ask for a camera.
      const q = (k) => u.searchParams.get(k) || '';
      const scene = u.searchParams.has('scene') || u.searchParams.has('s');
      const name = q('view') || q('v') || (scene ? q('room') || q('r') : '');
      return name ? { type: 'vdoninja', name: name.slice(0, 100) } : null;
    }

    // Internet Archive: archive.org/details/<id>, archive.org/embed/<id>, archive.org/download/<id>[/<file>],
    // and its storage servers' .../items/<id>/<file>. A playable file is a file (from the Archive);
    // anything else is an item the server picks a video file from.
    if (host === 'archive.org' || /\.archive\.org$/.test(host)) {
      const ID = /^[A-Za-z0-9._-]{1,200}$/;
      let i = -1;
      if (host === 'archive.org' && ['details', 'embed', 'download'].includes(parts[0])) i = 1;
      else if (host !== 'archive.org' && parts.indexOf('items') !== -1) i = parts.indexOf('items') + 1;
      const id = i > 0 ? parts[i] || '' : '';
      if (!ID.test(id)) return null;
      let file = '';
      try { file = parts.slice(i + 1).map(decodeURIComponent).join('/'); } catch (e) {}
      if (!FILE_EXT.test(file)) file = '';
      if (parts[0] !== 'details' && file) return { type: 'file', archive: id, file };
      return { type: 'archive', id, file };
    }
    // publicdomainmovie.net plays Internet Archive items: movie.php?id=<id> sends you to the file,
    // and a movie page names its item in a movie.php link (the server reads it).
    if (host === 'publicdomainmovie.net') {
      const id = parts[0] === 'movie.php' ? (u.searchParams.get('id') || '') : '';
      if (id) return /^[A-Za-z0-9._-]{1,200}$/.test(id) ? { type: 'archive', id, file: '' } : null;
      if (parts[0] === 'movie' && parts[1]) return { type: 'archive', page: `https://publicdomainmovie.net/movie/${encodeURIComponent(parts[1])}` };
      return null;
    }
    // Library of Congress films: an item page (loc.gov/item/<id>/ or lccn.loc.gov/<id>), a film's
    // handle (hdl.loc.gov/loc.mbrsmi/<collection>.<number>) or resource page
    // (loc.gov/resource/mbrsmi.<collection>.<number>/), which the server turns into the film's
    // tile.loc.gov video file. A file there is played as it is.
    if (host === 'loc.gov' || host === 'lccn.loc.gov' || host === 'hdl.loc.gov') {
      const ID = /^[A-Za-z]{0,8}\d{6,14}$/;
      if (host === 'loc.gov' && parts[0] === 'item' && ID.test(parts[1] || '')) return { type: 'loc', id: parts[1] };
      if (host === 'lccn.loc.gov' && parts.length === 1 && ID.test(parts[0])) return { type: 'loc', id: parts[0] };
      const handle = host === 'hdl.loc.gov' && parts[0] === 'loc.mbrsmi' ? parts[1]
        : (host === 'loc.gov' && parts[0] === 'resource' && /^mbrsmi\./.test(parts[1] || '') ? parts[1].slice(7) : '');
      const m = /^([a-z]{2,20})\.(\d{1,12})$/.exec(handle || '');
      if (m) return { type: 'loc', collection: m[1], number: m[2] };
    }
    if (host === 'tile.loc.gov' && FILE_EXT.test(u.pathname)) return { type: 'file', loc: true };
    // Tubi: tubitv.com/movies/<id>, /tv-shows/<id> (an episode) and /series/<id> (a list of episodes).
    if (host === 'tubitv.com') {
      const kinds = { movies: 'movie', 'tv-shows': 'episode', series: 'series' };
      const kind = kinds[parts[0]];
      const id = parts[1] || '';
      if (!kind || !/^\d{1,12}$/.test(id)) return null;
      return kind === 'series' ? { type: 'tubi', kind, id } : { type: 'tubi', kind, id, stream: true };
    }
    // NASA+: plus.nasa.gov/video/<name>/
    if (host === 'plus.nasa.gov') {
      const slug = parts[0] === 'video' ? parts[1] || '' : '';
      return /^[a-z0-9-]{1,200}$/.test(slug) ? { type: 'nasa', slug, stream: true } : null;
    }
    // A Google Drive file shared with anyone who has the link: played from its download address.
    // confirm=t skips the page Drive shows instead of a big file ("can't scan for viruses").
    if (host === 'drive.google.com') {
      const id = (parts[0] === 'file' && parts[1] === 'd') ? parts[2] : (/^(open|uc)$/.test(parts[0] || '') ? u.searchParams.get('id') : '');
      return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? { type: 'file', drive: true, url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t` } : null;
    }
    if (host === 'drive.usercontent.google.com') {
      const id = u.searchParams.get('id') || '';
      return parts[0] === 'download' && /^[A-Za-z0-9_-]{10,}$/.test(id) ? { type: 'file', drive: true } : null;
    }
    // A Dropbox share link opens Dropbox's page about the file; raw=1 gives the file itself.
    if (host === 'dropbox.com' && FILE_EXT.test(u.pathname)) {
      const url = new URL(u.href);
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
      return { type: 'file', url: url.href };
    }

    if (/\.m3u8$/i.test(u.pathname)) return { type: 'hls' };
    // A DASH stream; browsers need dash.js to play it.
    if (/\.mpd$/i.test(u.pathname)) return { type: 'dash' };
    // An MPEG-TS stream over HTTP (VRCDN's .live.ts links); browsers need mpegts.js to play it.
    if (/\.ts$/i.test(u.pathname)) return { type: 'mpegts', live: /\.live\.ts$/i.test(u.pathname) };
    if (FILE_EXT.test(u.pathname)) return { type: 'file' };
    return null;
  }

  /**
   * Generates a readable display title for a direct media file or stream URL when no title is provided.
   *
   * @param {string} link - Direct file or stream link.
   * @returns {string} Clean human-readable fallback name.
   */
  function nameFromLink(link) {
    const m = detect(link);
    if (m && m.drive) return 'Google Drive video';
    const u = parseUrl(m && m.url || link);
    if (!u) return 'Video';
    const file = u.pathname.split('/').filter(Boolean).pop() || '';
    let name = file;
    try { name = decodeURIComponent(file); } catch (e) {}
    name = name.replace(/(\.live)?\.[a-z0-9]{2,5}$/i, '').replace(/[_+]+/g, ' ').trim();
    // Streams are often called index.m3u8 or playlist.m3u8, so say where they're from instead.
    if (!name || /^(index|playlist|master|live|stream|chunklist|manifest|dash)$/i.test(name)) name = `Stream from ${u.hostname}`;
    return name.slice(0, 120);
  }

  /**
   * Set of media source types considered trusted by default. The Internet Archive is trusted too
   * (its links and its files): it is a well-known library hosting public-domain and Creative
   * Commons films, not an arbitrary server, much like Vimeo. So are Tubi (a free, licensed
   * streaming service) and NASA+ (NASA's own videos), whose streams the server looks up, and the
   * Library of Congress's films (its pages and its tile.loc.gov files).
   */
  const TRUSTED = new Set(['youtube', 'twitch', 'twitchclip', 'vimeo', 'archive', 'loc', 'tubi', 'nasa']);

  /**
   * Checks whether a detected media source is from an inherently trusted service.
   *
   * @param {DetectedMedia|null} media - The detected media object.
   * @returns {boolean} True if media source is trusted without requiring untrusted-links override.
   */
  function isTrusted(media) {
    return !!media && (TRUSTED.has(media.type) || (media.type === 'file' && (!!media.archive || !!media.loc)));
  }

  /** Rejection message displayed when untrusted direct media links are queued in restricted rooms. */
  const UNTRUSTED_MESSAGE = 'This world only plays YouTube, Twitch, Vimeo, Tubi, NASA+, Internet Archive and Library of Congress links. Its owner can allow other links with the untrusted-links snippet setting.';

  /**
   * The 11-character id of a YouTube video, from a bare id or a YouTube link (with or without
   * https://), or false. Only YouTube's own hosts count: a pattern like "v/<11 letters>" turns up
   * in other links too (twitch.tv/quarterjade is "tv/" and an 11-letter name).
   *
   * @param {string} link
   * @returns {string|false}
   */
  function youtubeId(link) {
    const s = String(link || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    const media = detect(full);
    if (!media || media.type !== 'youtube') return false;
    // Only the link's own path and query: a URL nested in another parameter doesn't count.
    const u = parseUrl(full);
    if (!u) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = parts[0] || '';
    else if (['embed', 'shorts', 'live', 'v', 'e'].includes(parts[0])) id = parts[1] || '';
    else id = u.searchParams.get('v') || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : false;
  }

  return { detect, nameFromLink, parseUrl, isTrusted, youtubeId, UNTRUSTED_MESSAGE };
})();

if ((typeof process !== 'undefined') && process.release && process.release.name.search(/node|io.js/) !== -1) {
  module.exports = MediaSources;
}
