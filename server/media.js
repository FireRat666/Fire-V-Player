/**
 * @fileoverview Media link resolver and validator for non-YouTube media sources.
 * Resolves external links (Twitch, Vimeo, VDO.Ninja, the Internet Archive, audio/video files, and HLS streams)
 * into standardized playlist items, and enforces security trust policies.
 * @module server/media
 */

const MediaSources = require('../public/media-sources.js');
const archive = require('./archive.js');
const streaming = require('./streaming.js');

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

  // Tubi and NASA+ pages keep their page link; the player asks for the stream (/api/stream).
  if (media.type === 'tubi' || media.type === 'nasa') return streaming.resolveLink(link);

  if (media.type === 'vdoninja') {
    return { title: `VDO.Ninja: ${media.name}`, thumbnail: '', duration: 0, link };
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
 * Known trusted providers (YouTube, Twitch, Vimeo, the Internet Archive) are always permitted.
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

module.exports = { resolveMediaLink, resolveMediaLinks, detect: MediaSources.detect, allowedFor, UNTRUSTED_MESSAGE: MediaSources.UNTRUSTED_MESSAGE };
