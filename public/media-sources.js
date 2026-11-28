/**
 * @fileoverview Media URL classifier and metadata extractor shared between browser and server.
 * Identifies supported media types (YouTube, Twitch live/VOD/clip, Vimeo, VDO.Ninja, HLS, direct files)
 * and enforces platform trust validation.
 * @module public/media-sources
 */

/**
 * @typedef {Object} DetectedMedia
 * @property {'youtube'|'file'|'hls'|'dash'|'mpegts'|'twitch'|'twitchclip'|'vimeo'|'vdoninja'|'sdq'|'archive'|'loc'|'tubi'|'nasa'|'eso'|'radio'|'bilibili'} type - The detected media stream/source type.
 *   'tubi' is a Tubi movie, episode or series page, and 'nasa' a NASA+ video page: the player asks the
 *   server for the page's stream when it plays (`stream` is true), as Tubi's stream links expire.
 *   'archive' is an Internet Archive page or item (or a publicdomainmovie.net page) that the server
 *   turns into one of the item's files before it is played. 'loc' is a Library of Congress film page
 *   or handle, which the server turns into the film's video file on tile.loc.gov. 'eso' is an ESO or
 *   ESA/Hubble video page, which the server turns into the video's .mp4 on cdn.eso.org (or
 *   cdn.esahubble.org): a fulldome video's dome preview, or any other's 1080p file. 'radio' is an
 *   internet radio station: a Shoutcast tune-in link (site 'shoutcast'), a Radio Browser station
 *   page (site 'radiobrowser'), a SomaFM channel (site 'somafm'), an internet-radio.com station
 *   page (site 'internetradio'; a station it only lists, with no page, is its stream's address
 *   marked #internet-radio, with `listed` set and the address as its `id`), a .pls or .xspf playlist
 *   file, or a link the server found to be a station (a radio .m3u, or the stream itself), which it
 *   marks with #radio. The player asks the server for the station's stream when it plays.
 *   'bilibili' is a Bilibili video (www.bilibili.com/video/<BV id>, its /en/ page, or its embed
 *   player's link), which plays in Bilibili's own embed player.
 * @property {string} [channel] - Twitch channel name if applicable.
 * @property {string} [video] - Twitch VOD ID if applicable.
 * @property {string} [clip] - Twitch clip slug if applicable.
 * @property {string} [id] - Vimeo video ID if applicable; a Bilibili video's BV (or av) id.
 * @property {number} [part] - For Bilibili: which part of a video with several (its ?p=), from 1.
 * @property {string} [hash] - Vimeo unlisted hash token if applicable.
 * @property {string} [name] - VDO.Ninja stream/room identifier if applicable.
 * @property {boolean} [live] - True for an MPEG-TS link that is a live stream (VRCDN's .live.ts).
 * @property {string} [url] - The address to play, when it differs from the link (a VRCDN rtspt:// link,
 *   a Google Drive or Dropbox share link).
 * @property {boolean} [drive] - True for a Google Drive file.
 * @property {string} [archive] - For a 'file' on the Internet Archive: the item's identifier.
 * @property {boolean} [loc] - For a 'file' on the Library of Congress's tile.loc.gov.
 * @property {boolean} [eso] - For a 'file' on ESO's or ESA/Hubble's own servers.
 * @property {'eso'|'hubble'} [site] - For an 'eso' page: which site it's on.
 * @property {string} [collection] - For a Library of Congress film handle: its collection (ntscrm, say).
 * @property {string} [number] - For a Library of Congress film handle: its number.
 * @property {string} [file] - For an Internet Archive link to one of an item's video files: its name.
 * @property {string} [page] - For a publicdomainmovie.net page: the page to read the item from.
 * @property {'movie'|'episode'|'series'} [kind] - For Tubi: what the page is. A series is a list of episodes.
 * @property {number} [season] - For a Tubi series: the one season its link is for (a season's page).
 * @property {string} [slug] - For NASA+: the video's name in its address.
 * @property {boolean} [stream] - True when the player gets the stream from the server (/api/stream).
 * @property {boolean} [listed] - For an internet-radio.com station with no page there: `id` is its stream's address.
 * @property {'shoutcast'|'radiobrowser'|'somafm'|'internetradio'} [site] - For 'radio': a station in
 *   Shoutcast's, Radio Browser's or internet-radio.com's directory, or a SomaFM channel, by its `id`.
 */

var MediaSources = (() => {
  /** Regular expression matching supported direct media file extensions. */
  const FILE_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v|mp3|m4a|wav|flac|aac|opus)$/i;

  /** somafm.com's pages that aren't channels. */
  const SOMAFM_PAGES = new Set(['about', 'support', 'contact', 'faq', 'news', 'listen', 'player', 'player24', 'merch', 'store',
    'donate', 'privacy', 'legal', 'playlists', 'recent', 'songhistory', 'shop', 'app', 'apps', 'login', 'search', 'popular', 'archive']);

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

    // Bilibili: bilibili.com/video/<BV id or av id>/ (also /en/video/... and the like, ?p=<part>),
    // and its embed player, player.bilibili.com/player.html?bvid=<BV id> (or aid=<number>)&p=<part>.
    if (host === 'bilibili.com' || host === 'player.bilibili.com') {
      const part = Math.max(1, Math.min(999, parseInt(u.searchParams.get('p') || u.searchParams.get('page') || '1', 10) || 1));
      let id = '';
      if (host === 'player.bilibili.com') {
        const aid = u.searchParams.get('aid') || '';
        id = u.searchParams.get('bvid') || (/^\d{1,12}$/.test(aid) ? `av${aid}` : '');
      } else {
        const i = parts.indexOf('video');
        if (i === 0 || (i === 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]))) id = parts[i + 1] || '';
      }
      if (/^BV[0-9A-Za-z]{10}$/.test(id)) return { type: 'bilibili', id, part };
      if (/^av\d{1,12}$/i.test(id)) return { type: 'bilibili', id: id.toLowerCase(), part };
      return null;
    }

    // VDO.Ninja: vdo.ninja/?view=<stream id> (or ?room=<room>&scene for a whole room), also obs.ninja.
    if (/(^|\.)(vdo|obs)\.ninja$/.test(host)) {
      // Only links that watch: a room link without "scene" would join the room and ask for a camera.
      const q = (k) => u.searchParams.get(k) || '';
      const scene = u.searchParams.has('scene') || u.searchParams.has('s');
      const name = q('view') || q('v') || (scene ? q('room') || q('r') : '');
      return name ? { type: 'vdoninja', name: name.slice(0, 100) } : null;
    }

    // A screen shared through screen.sdq.st (a mediasoup server): its watch link
    // (screen.sdq.st:8443/?room=<room>), or its publish link, which names the same room. The
    // player joins the room as a watcher itself, so the publish page is never opened.
    if (host === 'screen.sdq.st' && u.protocol === 'https:') {
      const room = (u.searchParams.get('room') || '').trim();
      return room ? { type: 'sdq', room: room.slice(0, 100), origin: u.origin } : null;
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
    // Tubi: tubitv.com/movies/<id>, /tv-shows/<id> (an episode) and /series/<id> (a list of
    // episodes). A season's page, /series/<id>/<name>/season-<n> (or /series/<id>/season-<n>), is
    // that season's episodes.
    if (host === 'tubitv.com') {
      const kinds = { movies: 'movie', 'tv-shows': 'episode', series: 'series' };
      const kind = kinds[parts[0]];
      const id = parts[1] || '';
      if (!kind || !/^\d{1,12}$/.test(id)) return null;
      if (kind !== 'series') return { type: 'tubi', kind, id, stream: true };
      const season = /^season-(\d{1,3})$/.exec(parts[3] || parts[2] || '');
      return season ? { type: 'tubi', kind, id, season: Number(season[1]) } : { type: 'tubi', kind, id };
    }
    // ESO and ESA/Hubble videos: www.eso.org/public/videos/<id>/ (or /public/<country>/videos/<id>/)
    // and esahubble.org/videos/<id>/. Their archive pages (a category, a search) are lists.
    if (host === 'eso.org' || host === 'esahubble.org') {
      const at = host === 'eso.org' ? (parts[0] === 'public' ? parts.indexOf('videos') : -1) : (parts[0] === 'videos' ? 0 : -1);
      const rest = at >= 0 && at <= 2 ? parts.slice(at + 1) : [];
      const id = rest.length === 1 ? rest[0] : '';
      if (/^[A-Za-z0-9_.-]{1,120}$/.test(id) && !/^(archive|search|feed|list|category|viewall)$/.test(id)) {
        return { type: 'eso', site: host === 'eso.org' ? 'eso' : 'hubble', id };
      }
      return null;
    }
    if ((host === 'cdn.eso.org' || host === 'cdn.esahubble.org') && FILE_EXT.test(u.pathname)) return { type: 'file', eso: true };
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

    // Internet radio: a Shoutcast station's tune-in link (sbin/tunein-station.m3u, .pls or .xspf
    // with ?id=), a .pls or .xspf playlist, or a link the server marked as a station (#radio). An
    // .m3u is usually a list of videos (server/lists.js), so only the server, reading it, can tell
    // it's a station.
    if (/^(directory|yp)\.shoutcast\.com$/.test(host) && /^\/sbin\/tunein-station\.(m3u|pls|xspf)$/i.test(u.pathname)) {
      const id = u.searchParams.get('id') || '';
      return /^\d{1,12}$/.test(id) ? { type: 'radio', site: 'shoutcast', id, stream: true } : null;
    }
    // A Radio Browser station's page (www.radio-browser.info/history/<uuid>), and a SomaFM channel
    // (somafm.com/<channel>/, or its api.somafm.com/<channel>.pls playlist).
    if (host === 'radio-browser.info' && parts[0] === 'history') {
      const id = (parts[1] || '').toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? { type: 'radio', site: 'radiobrowser', id, stream: true } : null;
    }
    if (host === 'somafm.com' && parts.length === 1 && /^[a-z0-9]{2,40}$/.test(parts[0]) && !SOMAFM_PAGES.has(parts[0])) {
      return { type: 'radio', site: 'somafm', id: parts[0], stream: true };
    }
    // A station internet-radio.com only lists (it has no page there): its stream's address, marked.
    // Trusted like the directory's other stations, as a station only ever plays as sound (its
    // picture, if it has one, isn't shown: see media-players.js).
    if (u.hash === '#internet-radio' && /^https?:$/.test(u.protocol)) {
      const id = u.href.replace(/#.*$/, '');
      return id.length <= 500 ? { type: 'radio', site: 'internetradio', id, listed: true, stream: true } : null;
    }
    // An internet-radio.com station's page (www.internet-radio.com/station/<name>/).
    if (host === 'internet-radio.com' && parts[0] === 'station' && parts.length === 2 && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(parts[1])) {
      return { type: 'radio', site: 'internetradio', id: parts[1].toLowerCase(), stream: true };
    }
    // Its .pls names may end in a quality (groovesalad130.pls); a channel's own digits (7soul, sf1033) stay.
    const pls = host === 'api.somafm.com' && parts.length === 1 ? /^([a-z0-9]{2,40}?)(?:32|64|128|130|256|320)?\.pls$/i.exec(parts[0]) : null;
    if (pls) return { type: 'radio', site: 'somafm', id: pls[1].toLowerCase(), stream: true };
    if (u.hash === '#radio' || /\.(pls|xspf)$/i.test(u.pathname)) return { type: 'radio', stream: true };

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
   * Library of Congress's films (its pages and its tile.loc.gov files), and ESO's and ESA/Hubble's
   * videos (their pages and their own servers' files). Shoutcast's and Radio Browser's stations
   * are too, as they come from their directories (by id) rather than from an address anyone typed,
   * and SomaFM's channels and internet-radio.com's stations; other radio links aren't. Bilibili's
   * videos play in its own embed player, but have no ratings, so they only play where the world
   * allows titles for adults (see needsRating).
   */
  const TRUSTED = new Set(['youtube', 'twitch', 'twitchclip', 'vimeo', 'archive', 'loc', 'tubi', 'nasa', 'eso', 'bilibili']);

  /**
   * Checks whether a detected media source is from an inherently trusted service.
   *
   * @param {DetectedMedia|null} media - The detected media object.
   * @returns {boolean} True if media source is trusted without requiring untrusted-links override.
   */
  function isTrusted(media) {
    return !!media && (TRUSTED.has(media.type) || (media.type === 'file' && (!!media.archive || !!media.loc || !!media.eso))
      || (media.type === 'radio' && !!media.site));
  }

  /** Rejection message displayed when untrusted direct media links are queued in restricted rooms. */
  const UNTRUSTED_MESSAGE = 'This world only plays YouTube, Twitch, Vimeo, Tubi, NASA+, Internet Archive, Library of Congress, ESO and radio directory (Shoutcast, Radio Browser, SomaFM, internet-radio.com) links. Its owner can allow other links with the untrusted-links snippet setting.';

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
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, ''); // as detect() does
    let id = '';
    if (host === 'youtu.be') id = parts[0] || '';
    else if (['embed', 'shorts', 'live', 'v', 'e'].includes(parts[0])) id = parts[1] || '';
    else id = u.searchParams.get('v') || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : false;
  }

  /**
   * The US film and TV ratings that play without the mature-links setting: up to PG-13 and TV-14.
   * Anything else (R, NC-17, TV-MA, NR, unrated) is for adults, and so is a title with no rating.
   */
  const SUITABLE_RATINGS = new Set(['G', 'PG', 'PG-13', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'TV-14']);

  /**
   * Whether a Tubi title is for adults, from its ratings (its page data's `ratings`, [{value}], or
   * a rating's text such as "TV-MA", or a list of them). No rating counts as adult.
   *
   * @param {Array<{value?: string, code?: string}>|string|Array<string>|null} ratings
   * @returns {boolean}
   */
  function tubiMature(ratings) {
    const list = (Array.isArray(ratings) ? ratings : [ratings])
      .map(r => String((r && typeof r === 'object' ? r.value || r.code : r) || '').trim().toUpperCase())
      .filter(Boolean);
    return !list.length || list.some(r => !SUITABLE_RATINGS.has(r));
  }

  /**
   * Whether a detected link is from a site with adult titles among the rest (Tubi, the Internet
   * Archive), whose rating is looked up before it's added or played. Bilibili's videos have no
   * rating, so they count as for adults.
   *
   * @param {DetectedMedia|null} media
   * @returns {boolean}
   */
  function needsRating(media) {
    return !!media && (media.type === 'tubi' || media.type === 'archive' || media.type === 'bilibili' || (media.type === 'file' && !!media.archive));
  }

  /** Shown when a title for adults is refused because the world doesn't allow them. */
  const MATURE_MESSAGE = "This video is for adults, and this world doesn't allow those. Its owner can allow them with the mature-links snippet setting.";
  /** Shown instead for a Bilibili video, which has no rating to check. */
  const UNRATED_SITE_MESSAGE = "Bilibili videos have no ratings, so they only play where the world allows titles for adults. Its owner can allow them with the mature-links snippet setting.";

  /**
   * Why a link for adults is refused: MATURE_MESSAGE, or UNRATED_SITE_MESSAGE for a Bilibili video.
   * @param {DetectedMedia|string|null} media - A detected link, or a link.
   * @returns {string}
   */
  function matureMessage(media) {
    const m = typeof media === 'string' ? detect(media) : media;
    return m && m.type === 'bilibili' ? UNRATED_SITE_MESSAGE : MATURE_MESSAGE;
  }

  return { detect, nameFromLink, parseUrl, isTrusted, youtubeId, tubiMature, needsRating, matureMessage, UNTRUSTED_MESSAGE, MATURE_MESSAGE };
})();

if ((typeof process !== 'undefined') && process.release && process.release.name.search(/node|io.js/) !== -1) {
  module.exports = MediaSources;
}
