/**
 * @fileoverview Media link resolver and validator for non-YouTube media sources.
 * Resolves external links (Twitch, Vimeo, VDO.Ninja, the Internet Archive, audio/video files, and HLS streams)
 * into standardized playlist items, and enforces security trust policies.
 * @module server/media
 */

const MediaSources = require('../public/media-sources.js');
const archive = require('./archive.js');
const loc = require('./loc.js');
const eso = require('./eso.js');
const streaming = require('./streaming.js');
const radio = require('./radio.js');
const bilibili = require('./bilibili.js');

const FETCH_TIMEOUT_MS = 5000;

/**
 * @typedef {Object} PlaylistItem
 * @property {string} title - The title of the media item.
 * @property {string} thumbnail - URL to the media thumbnail image, if available.
 * @property {number} duration - Media duration in milliseconds (0 if live or unknown).
 * @property {string} link - The canonical playback URL.
 */

/**
 * Fetches JSON from a remote URL with a timeout.
 * @param {string} url - Target URL to fetch.
 * @returns {Promise<Object>} The parsed JSON response.
 * @throws {Error} If HTTP response status is not OK.
 */
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetches the OpenGraph title (`og:title`) from an HTML webpage.
 * Used primarily for Twitch stream or video pages where public API keys are unavailable.
 * @param {string} url - Web page URL to scrape.
 * @returns {Promise<string|null>} The parsed and unescaped title, or null if not found or on error.
 */
async function fetchPageTitle(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200000);
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (!m) return null;
    return m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  } catch (e) {
    return null;
  }
}

/**
 * Resolves an external media URL into a normalized playlist item.
 * Supports Twitch streams, clips, and VODs; Vimeo videos via oEmbed; VDO.Ninja streams;
 * and raw media files or HLS streams.
 *
 * @param {string} link - Media URL to resolve.
 * @returns {Promise<PlaylistItem|null>} The resolved playlist item, or null if unsupported or if YouTube.
 * @throws {Error} If media resolution fails (e.g. Vimeo embed restrictions).
 */
async function resolveMediaLink(link) {
  const media = MediaSources.detect(link);
  if (!media || media.type === 'youtube') return null;
  link = String(link).trim();

  if (media.type === 'twitchclip') {
    // Twitch shares nothing about a clip without an API key, and its clip player can't report its
    // length, so a clip gets 60 seconds, the longest a Twitch clip can be.
    return {
      title: media.channel ? `Clip from ${media.channel} (Twitch)` : 'Twitch clip',
      thumbnail: '',
      duration: 60000,
      link: media.channel ? `https://www.twitch.tv/${media.channel}/clip/${media.clip}` : `https://clips.twitch.tv/${media.clip}`
    };
  }

  if (media.type === 'twitch') {
    if (media.channel) {
      const page = `https://www.twitch.tv/${media.channel}`;
      const title = await fetchPageTitle(page);
      return {
        title: `${title && !/^twitch$/i.test(title) ? title.replace(/ - (Live on )?Twitch$/i, '') : media.channel} (live on Twitch)`,
        thumbnail: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${media.channel}-320x180.jpg`,
        duration: 0, // live: plays until someone skips
        link: page
      };
    }
    const page = `https://www.twitch.tv/videos/${media.video}`;
    const title = await fetchPageTitle(page);
    return {
      title: title && !/^twitch$/i.test(title) ? title.replace(/ - (Live on )?Twitch$/i, '') : `Twitch video ${media.video}`,
      thumbnail: '',
      duration: 0,
      link: page
    };
  }

  if (media.type === 'vimeo') {
    try {
      const info = await fetchJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(link)}`);
      return {
        title: String(info.title || `Vimeo video ${media.id}`).slice(0, 200),
        thumbnail: info.thumbnail_url || '',
        duration: Number(info.duration) > 0 ? Number(info.duration) * 1000 : 0,
        link
      };
    } catch (e) {
      // Vimeo only answers for videos that can be embedded on other sites.
      throw new Error("That Vimeo video can't be played here. Its owner may not allow it on other sites.");
    }
  }

  // An Internet Archive page or item (or a publicdomainmovie.net page) becomes one of the item's
  // mp4 files; a link straight to an Archive file keeps that file and gets the item's title.
  if (media.type === 'archive') return archive.resolveLink(link);
  if (media.type === 'file' && media.archive) {
    try {
      return await archive.resolveLink(link);
    } catch (e) { /* played as a plain file below */ }
  }

  // A Library of Congress film page or handle becomes its tile.loc.gov video file, and a file there
  // gets the film's title when the server knows it.
  if (media.type === 'loc' || (media.type === 'file' && media.loc)) return loc.resolveLink(link);

  // An ESO or ESA/Hubble video page becomes its .mp4 on the site's own server, and a file there gets
  // the video's title.
  if (media.type === 'eso') return eso.resolveLink(link);
  if (media.type === 'file' && media.eso) {
    try {
      return await eso.resolveLink(link);
    } catch (e) { /* played as a plain file below */ }
  }

  // Tubi and NASA+ pages keep their page link; the player asks for the stream (/api/stream).
  if (media.type === 'tubi' || media.type === 'nasa') return streaming.resolveLink(link);

  // A Bilibili video plays in Bilibili's own embed player; its page gives its title and length.
  if (media.type === 'bilibili') return bilibili.resolveLink(link);
  // A biliplayer.91vrchat.com link plays the video's .mp4 it redirects to; the Bilibili page gives
  // its title and length. It keeps the biliplayer link, as the .mp4's address expires.
  if (media.type === 'file' && media.bilibili) return { ...(await bilibili.resolveLink(media.bilibili)), link: media.url };

  // A radio station (Shoutcast, or a .pls or .xspf file) keeps its link too: the player asks for
  // its stream (/api/stream), as a station's stream address can change.
  if (media.type === 'radio') return radio.resolveLink(link);

  if (media.type === 'vdoninja') {
    return { title: `VDO.Ninja: ${media.name}`, thumbnail: '', duration: 0, link };
  }

  // A shared screen on screen.sdq.st: added whether or not anyone is sharing yet, as the player
  // waits in the room and shows the screen when it starts.
  if (media.type === 'sdq') {
    return { title: `Screen share: ${media.room}`, thumbnail: '', duration: 0, link };
  }

  // A file or stream: the player page learns its length when it loads. A VRCDN rtspt:// link is
  // kept as its .live.ts address, which browsers can play.
  const url = media.url || link;
  const vrcdn = media.type === 'mpegts' && media.live && /(^|\.)vrcdn\.(live|video|cloud)$/i.test(MediaSources.parseUrl(url).hostname);
  return { title: MediaSources.nameFromLink(link) + (vrcdn ? ' (live on VRCDN)' : ''), thumbnail: '', duration: 0, link: url };
}

/**
 * Like resolveMediaLink, but an Internet Archive link gives every video in its item (each episode
 * of a TV season, say), for showing as search results.
 *
 * @param {string} link - Media URL to resolve.
 * @returns {Promise<Array<PlaylistItem>>}
 */
async function resolveMediaLinks(link) {
  const media = MediaSources.detect(link);
  if (media && media.type === 'archive') return archive.resolveLinkAll(String(link).trim());
  // A Tubi series lists its episodes.
  if (media && media.type === 'tubi') return streaming.resolveLinks(String(link).trim());
  const one = await resolveMediaLink(link);
  return one ? [one] : [];
}

/**
 * Checks whether a WebSocket client connection is permitted to queue the specified media link.
 * Known trusted providers (YouTube, Twitch, Vimeo, the Internet Archive, the Library of Congress) are always permitted.
 * Direct links and files require untrusted link permissions enabled on the connection.
 *
 * @param {Object} ws - The client WebSocket connection object.
 * @param {boolean} [ws.allowUntrusted] - Whether untrusted links are allowed for this client.
 * @param {string} link - The media link to validate.
 * @returns {boolean} True if the link is permitted for this connection.
 */
function allowedFor(ws, link) {
  const m = MediaSources.detect(link);
  return MediaSources.isTrusted(m) || !!(ws && ws.allowUntrusted);
}

/**
 * Whether a Tubi or Internet Archive link is for adults (see MediaSources.tubiMature and
 * archive.isMatureMeta). A Bilibili video has no rating, so it is. Other links aren't rated,
 * and give false.
 * @param {string} link
 * @returns {Promise<boolean>} Rejects when the rating couldn't be looked up.
 */
async function isMature(link) {
  const m = MediaSources.detect(link);
  if (!MediaSources.needsRating(m)) return false;
  if (m.type === 'bilibili' || m.bilibili) return true;
  return m.type === 'tubi' ? streaming.isMature(link) : archive.isMature(link);
}

/** After a Tubi rating lookup fails, the server doesn't try another for this long. */
const TUBI_RETRY_MS = 60 * 1000;
const UNRATED_MESSAGE = "Couldn't check whether this title is for adults, which this world doesn't allow. Try again in a moment.";
let tubiDownUntil = 0;

/** Whether this client's world allows titles for adults (the snippet's mature-links). */
function allowsMature(ws) {
  return !!(ws && ws.allowMature);
}

/**
 * Checks a playlist item about to be added against the world's mature-links setting, and gives
 * it back without its `mature` mark. An item for adults is refused where the world doesn't allow
 * them. A Tubi or Archive item that came without a rating (one this device looked up, say) is
 * looked up here; if the server can't (Tubi may not serve its country), what the device said is
 * used, and failing that it isn't added (UNRATED_MESSAGE).
 *
 * @param {Object} ws - The client adding it.
 * @param {Object} item - The playlist item.
 * @param {boolean} [said] - Whether the device that looked it up said it's for adults.
 * @returns {Promise<Object>} The item, without `mature`.
 * @throws {Error} MATURE_MESSAGE, for an item for adults where the world doesn't allow them, or
 *   UNRATED_MESSAGE when its rating couldn't be found there.
 */
async function screenMature(ws, item, said) {
  if (!item || typeof item !== 'object') return item;
  const { mature, ...rest } = item;
  if (allowsMature(ws) || !MediaSources.needsRating(MediaSources.detect(rest.link || ''))) return rest;
  let adult = typeof mature === 'boolean' ? mature : null;
  const tubi = MediaSources.detect(rest.link).type === 'tubi';
  if (adult === null && !(tubi && Date.now() < tubiDownUntil)) {
    try {
      adult = await isMature(rest.link);
    } catch (e) {
      // Tubi may not serve this server's country: it isn't asked again for a while, so adding a
      // series' episodes one by one doesn't wait on a failed lookup each.
      if (tubi) tubiDownUntil = Date.now() + TUBI_RETRY_MS;
    }
  }
  if (adult === null) adult = typeof said === 'boolean' ? said : null;
  // Its rating couldn't be found: not added, where the world doesn't allow titles for adults.
  if (adult === null) throw new Error(UNRATED_MESSAGE);
  if (adult) throw new Error(MediaSources.matureMessage(rest.link));
  return rest;
}

/**
 * The items of a list or search that this client's world allows, by their `mature` marks (a
 * title for adults is left out where the world doesn't allow them), without the marks.
 * @param {Object} ws
 * @param {Object[]} items
 * @returns {{items: Object[], skipped: number}}
 */
function filterMature(ws, items) {
  const allow = allowsMature(ws);
  const kept = [];
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const { mature, ...rest } = item;
    if (mature === true && !allow) continue;
    kept.push(rest);
  }
  return { items: kept, skipped: (items || []).length - kept.length };
}

/**
 * A link the player doesn't know (detect gives null) that is a radio station after all, found by
 * what it sends (a radio .m3u, or the stream itself), as a playlist item whose link is marked
 * #radio, or null. Such a link isn't trusted: check allowedFor on the item's link.
 * @param {string} link
 * @returns {Promise<PlaylistItem|null>}
 */
function sniffRadio(link) {
  return radio.sniff(String(link || '').trim());
}

/** Whether a link is one whose rating is checked (Tubi, or the Internet Archive). */
function needsRating(link) {
  return MediaSources.needsRating(MediaSources.detect(String(link || '')));
}

module.exports = {
  resolveMediaLink, resolveMediaLinks, sniffRadio, detect: MediaSources.detect, allowedFor,
  isMature, allowsMature, screenMature, filterMature, needsRating, matureMessage: MediaSources.matureMessage,
  UNTRUSTED_MESSAGE: MediaSources.UNTRUSTED_MESSAGE, MATURE_MESSAGE: MediaSources.MATURE_MESSAGE
};
