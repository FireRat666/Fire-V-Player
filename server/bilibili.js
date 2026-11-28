/**
 * @fileoverview Bilibili videos: a video's page gives its title, picture and length, and the
 * video plays in Bilibili's own embed player (player.bilibili.com), the one its pages offer for
 * other sites. Bilibili's stream addresses are only served to its own pages, so nothing here
 * looks them up.
 *
 * Bilibili's videos have no ratings, so they count as for adults (see MediaSources.needsRating)
 * and only play where the world allows those.
 * @module server/bilibili
 */

const { TtlCache } = require('./cache.js');
const MediaSources = require('../public/media-sources.js');

const TIMEOUT_MS = 8000;
const TTL_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
/** How much of a video's page is read: its data is near the top. */
const MAX_PAGE_CHARS = 2 * 1024 * 1024;

const cache = new TtlCache({ maxEntries: 500 });

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A video's link: its BV (or av) id, and ?p= for a part after the first. */
function videoLink(id, part) {
  return `https://www.bilibili.com/video/${id}/${part > 1 ? `?p=${part}` : ''}`;
}

/** The page's `window.__INITIAL_STATE__`, which holds the video's data, or null. */
function pageState(html) {
  const start = html.indexOf('window.__INITIAL_STATE__=');
  if (start < 0) return null;
  const from = start + 'window.__INITIAL_STATE__='.length;
  const end = html.indexOf(';(function', from);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(from, end));
  } catch (e) {
    return null;
  }
}

/** A video's data from its page (videoData: bvid, title, pic, duration, pages). */
function videoData(id) {
  return cache.remember(`video:${id}`, TTL_MS, async () => {
    const res = await fetch(videoLink(id, 1), { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Couldn't reach Bilibili (it answered ${res.status}). Try again in a moment.`);
    const state = pageState((await res.text()).slice(0, MAX_PAGE_CHARS));
    const data = state && state.videoData;
    if (!data || !data.bvid) throw new Error("That Bilibili video doesn't exist, or can't be watched without signing in.");
    return data;
  });
}

/** An http picture on Bilibili's picture server, as https. */
function https(url) {
  const s = String(url || '');
  return /^https?:\/\/[a-z0-9.-]+\.hdslb\.com\//i.test(s) ? s.replace(/^http:/i, 'https:') : '';
}

/**
 * A Bilibili link as a playlist item: its title (and its part's name, for a video in several
 * parts), picture and length, with its link as www.bilibili.com/video/<BV id>/ (and ?p=).
 * `mature` is true, as Bilibili's videos aren't rated (see media.screenMature).
 * @param {string} link
 * @returns {Promise<{title: string, thumbnail: string, duration: number, link: string, mature: boolean}>}
 */
async function resolveLink(link) {
  const media = MediaSources.detect(link);
  if (!media || media.type !== 'bilibili') throw new Error("That isn't a Bilibili video link.");
  const data = await videoData(media.id);
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const page = pages.find(p => Number(p && p.page) === media.part) || (media.part === 1 ? pages[0] : null);
  if (media.part > 1 && !page) throw new Error(`That Bilibili video has no part ${media.part}.`);
  const title = clean(data.title) || `Bilibili video ${data.bvid}`;
  const part = page && pages.length > 1 ? clean(page.part, 120) : '';
  const seconds = Number((page && page.duration) || data.duration) || 0;
  // A thumbnail of 320 by 180, as the full picture can be large.
  const picture = https(data.pic);
  return {
    title: clean(part && part !== title ? `${title} (${part})` : title, 200),
    thumbnail: picture ? `${picture}@320w_180h.jpg` : '',
    duration: Math.max(0, Math.round(seconds)) * 1000,
    link: videoLink(data.bvid, media.part),
    mature: true
  };
}

module.exports = { resolveLink, pageState };
