/**
 * @fileoverview Tubi and NASA+: their videos, lists and streams, with no API key.
 *
 * A Tubi page (a movie, an episode, a series or a category) carries the site's data as
 * `window.__data`, including each video's streams. Tubi's stream links expire after about a week,
 * so the playlist keeps the page's link and the player asks for a stream (/api/stream) when it
 * plays. Only plain HLS streams are used; a title Tubi offers only with copy protection (DRM) or
 * only to signed-in viewers can't play here. Tubi has no search without an account token, so
 * searching Tubi looks through the titles in its categories.
 *
 * NASA+ is a WordPress site, whose public API gives each video's HLS stream, length and picture,
 * searches its videos and lists a series. Its stream links don't change.
 * @module server/streaming
 */

const { TtlCache } = require('./cache.js');
const MediaSources = require('../public/media-sources.js');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 12000;
/** A Tubi page's streams are good for about a week; its titles and lists change more often. */
const PAGE_TTL_MS = 3 * 60 * 60 * 1000;
/** How long the titles in every Tubi category are kept for searching. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const NASA_TTL_MS = 60 * 60 * 1000;
/** Most episodes a Tubi series gives, and results a search gives. */
const MAX_EPISODES = 200;
const MAX_RESULTS = 40;
/** Categories that depend on who's watching, or repeat others, aren't searched. */
const SKIP_CATEGORIES = new Set(['recommended_for_you', 'continue_watching', 'queue', 'weekly_watchlist']);

const cache = new TtlCache({ maxEntries: 400 });

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeEntities = s => String(s || '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const https = url => (String(url || '').startsWith('//') ? `https:${url}` : String(url || ''));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ------------------------------------------------------------------ Tubi

/** The site data on a Tubi page. Its script is JavaScript, close to JSON but with `undefined`. */
function parseTubiData(html) {
  const start = html.indexOf('window.__data=');
  if (start < 0) throw new Error("Couldn't read that Tubi page.");
  const end = html.indexOf('</script>', start);
  const body = html.slice(start + 'window.__data='.length, end).trim().replace(/;\s*$/, '')
    .replace(/:undefined(?=[,}\]])/g, ':null');
  return JSON.parse(body);
}

/** A Tubi page's data (path like "movies/123" or "category/westerns"), not cached. */
async function fetchTubiPage(path) {
  let html;
  try {
    html = await fetchText(`https://tubitv.com/${path}`);
  } catch (e) {
    throw new Error(/HTTP 404/.test(e.message) ? "That Tubi page doesn't exist (or isn't available here)." : "Couldn't reach Tubi. Try again in a moment.");
  }
  return parseTubiData(html);
}

/**
 * A movie, episode or series page's data, cached whole (a stream is read from it later). A
 * category page is much bigger and only its titles are needed, so it isn't kept (see tubiCategory).
 */
function tubiPage(path) {
  return cache.remember(`tubi:${path}`, PAGE_TTL_MS, () => fetchTubiPage(path));
}

function tubiPicture(c) {
  const list = (c && (c.thumbnails || c.landscape_images || c.posterarts)) || [];
  return https(list[0] || '');
}

/** A Tubi movie or episode (content type 'v') or series ('s') as a playlist item or search result. */
function tubiItem(c, kind) {
  const isSeries = kind === 'series' || c.type === 's';
  const path = isSeries ? 'series' : kind === 'episode' ? 'tv-shows' : 'movies';
  const year = c.year ? String(c.year).slice(0, 4) : '';
  return {
    id: String(c.id),
    title: clean(isSeries ? `${c.title} (series)` : c.title) || 'Tubi video',
    thumbnail: tubiPicture(c),
    duration: isSeries ? 0 : Math.max(0, Math.round(Number(c.duration) || 0)) * 1000,
    link: `https://tubitv.com/${path}/${c.id}`,
    channel: { name: year ? `Tubi, ${year}` : 'Tubi', link: '' },
    description: clean(c.description, 300),
    source: 'tubi'
  };
}

/** A Tubi movie or episode's details from its own page. */
async function tubiContent(kind, id) {
  const data = await tubiPage(`${kind === 'episode' ? 'tv-shows' : 'movies'}/${id}`);
  const c = data.video && data.video.byId && data.video.byId[id];
  if (!c) throw new Error("That Tubi video isn't available.");
  return c;
}

/** The playable stream of a Tubi movie or episode: a plain HLS one, H.264 if there is one. */
async function tubiStream(kind, id) {
  const c = await tubiContent(kind, id);
  const plain = (c.video_resources || []).filter(r => r && r.manifest && r.manifest.url
    && /^hls/i.test(r.type || '') && !/widevine|playready|fairplay|drm/i.test(r.type || '') && !r.license_server);
  const pick = plain.find(r => /264|avc/i.test(r.codec || '')) || plain.find(r => !/265|hevc/i.test(r.codec || '')) || plain[0];
  if (!pick) {
    if (c.needs_login) throw new Error('Tubi only plays this one for signed-in viewers.');
    throw new Error("Tubi only offers this one with copy protection, which can't play here.");
  }
  return { url: pick.manifest.url, live: false };
}

/** Every episode of a Tubi series, in order. */
async function tubiSeries(id) {
  const data = await tubiPage(`series/${id}`);
  const byId = (data.video && data.video.byId) || {};
  const series = byId[`0${id}`] || byId[id];
  if (!series) throw new Error("That Tubi series isn't available.");
  const items = [];
  for (const season of series.seasons || []) {
    for (const ep of season.episodes || []) {
      if (items.length >= MAX_EPISODES) break;
      const c = byId[ep.id] || ep;
      if (c && c.id) items.push(tubiItem(c, 'episode'));
    }
  }
  return { title: clean(series.title, 120) || 'Tubi series', items };
}

/** The titles in a Tubi category (up to 50, as its page shows). Only these are cached, not the page. */
function tubiCategory(slug) {
  return cache.remember(`tubi:category:${slug}`, PAGE_TTL_MS, async () => {
    const data = await fetchTubiPage(`category/${slug}`);
    const container = data.container || {};
    const ids = (container.containerChildrenIdMap || {})[slug] || [];
    const byId = (data.video && data.video.byId) || {};
    const info = (container.containerIdMap || {})[slug] || {};
    const items = ids.map(id => byId[id] || byId[String(id).replace(/^0/, '')]).filter(Boolean).map(c => tubiItem(c));
    return { title: clean(info.title ? `Tubi: ${info.title}` : `Tubi: ${slug}`, 120), items };
  });
}

/** Tubi's categories: [{slug, title}]. */
function tubiCategories() {
  return cache.remember('tubi:categories', CATALOG_TTL_MS, async () => {
    const data = await fetchTubiPage('category/featured');
    const container = data.container || {};
    const map = container.containerIdMap || {};
    return (container.containerMenuList || Object.keys(map))
      .filter(slug => /^[a-z0-9_-]{1,80}$/.test(slug) && !SKIP_CATEGORIES.has(slug))
      .map(slug => ({ slug, title: clean((map[slug] && map[slug].title) || slug, 80) }));
  });
}

/**
 * Every title in Tubi's categories, for searching. Loaded a few categories at a time. If a category
 * won't load, this search uses the rest, but they aren't kept, so a later search tries it again.
 */
async function tubiCatalog() {
  const { entries, partial } = await cache.remember('tubi:catalog', CATALOG_TTL_MS, async () => {
    const categories = await tubiCategories();
    const seen = new Map();
    let partial = false;
    let next = 0;
    const worker = async () => {
      while (next < categories.length) {
        const { slug, title } = categories[next++];
        try {
          const list = await tubiCategory(slug);
          for (const item of list.items) {
            const known = seen.get(item.link);
            if (known) known.categories.push(title);
            else seen.set(item.link, { item, categories: [title] });
          }
        } catch (e) { partial = true; /* left out of this search */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (!seen.size) throw new Error("Couldn't load Tubi's titles. Try again in a moment.");
    return { entries: [...seen.values()], partial };
  });
  if (partial) cache.delete('tubi:catalog');
  return entries;
}

/** Searches Tubi's titles (and category names) for every word of the search. */
async function searchTubi(term) {
  const words = clean(term, 100).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const catalog = await tubiCatalog();
  const score = ({ item, categories }) => {
    const title = item.title.toLowerCase();
    if (!words.every(w => title.includes(w) || categories.some(c => c.toLowerCase().includes(w)))) return -1;
    return (words.every(w => title.includes(w)) ? 2 : 0) + (title.startsWith(words[0]) ? 1 : 0);
  };
  return catalog.map(e => ({ e, s: score(e) })).filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s).slice(0, MAX_RESULTS).map(x => x.e.item);
}

// ------------------------------------------------------------------ NASA+

const NASA_API = 'https://plus.nasa.gov/wp-json/wp/v2';
const NASA_FIELDS = '_fields=id,link,title,meta,featured_image,date';

async function nasaApi(path) {
  const res = await fetch(`${NASA_API}/${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error("Couldn't reach NASA+. Try again in a moment.");
  return res.json();
}

/** A NASA+ video's stream: its HLS link on NASA's own servers, or its YouTube copy. */
function nasaStreamOf(v) {
  const meta = (v && v.meta) || {};
  const url = String(meta['video-url'] || '');
  const u = MediaSources.parseUrl(url);
  if (u && u.protocol === 'https:' && /(^|\.)(nasa\.gov|akamaized\.net)$/i.test(u.hostname) && /\.m3u8$/i.test(u.pathname)) return { url };
  const yt = MediaSources.youtubeId(String(meta['youtube-url'] || ''));
  return yt ? { youtube: `https://www.youtube.com/watch?v=${yt}` } : null;
}

function nasaItem(v) {
  const meta = v.meta || {};
  const stream = nasaStreamOf(v);
  const year = String(v.date || '').slice(0, 4);
  return {
    id: String(v.id),
    title: clean(decodeEntities(v.title && v.title.rendered)) || 'NASA+ video',
    thumbnail: typeof v.featured_image === 'string' ? v.featured_image : '',
    duration: Math.max(0, Math.round(Number(meta.runtime) || 0)) * 1000,
    // A video NASA+ only has on YouTube plays from YouTube.
    link: stream && stream.youtube ? stream.youtube : String(v.link || ''),
    channel: { name: year ? `NASA+, ${year}` : 'NASA+', link: '' },
    description: '',
    source: 'nasa'
  };
}

/** A NASA+ video by the name in its address. */
function nasaVideo(slug) {
  return cache.remember(`nasa:video:${slug}`, NASA_TTL_MS, async () => {
    const list = await nasaApi(`video?slug=${encodeURIComponent(slug)}&${NASA_FIELDS}`);
    if (!Array.isArray(list) || !list[0]) throw new Error("That NASA+ video doesn't exist.");
    return list[0];
  });
}

async function nasaStream(slug) {
  const stream = nasaStreamOf(await nasaVideo(slug));
  if (!stream || !stream.url) throw new Error("That NASA+ video has no stream that can play here.");
  // NASA+'s servers refuse requests that say another site sent them (a Referer), but not ones that don't.
  return { url: stream.url, live: false, noReferrer: true };
}

/** Searches NASA+ videos. */
function searchNasa(term) {
  const q = clean(term, 100);
  if (!q) return Promise.resolve([]);
  return cache.remember(`nasa:search:${q.toLowerCase()}`, NASA_TTL_MS, async () => {
    const list = await nasaApi(`video?search=${encodeURIComponent(q)}&per_page=${MAX_RESULTS}&${NASA_FIELDS}`);
    return (Array.isArray(list) ? list : []).filter(v => nasaStreamOf(v)).map(nasaItem);
  });
}

/** The videos of a NASA+ series (plus.nasa.gov/video_series/<name>/). */
function nasaSeries(slug) {
  return cache.remember(`nasa:series:${slug}`, NASA_TTL_MS, async () => {
    const terms = await nasaApi(`series?slug=${encodeURIComponent(slug)}&_fields=id,name`);
    if (!Array.isArray(terms) || !terms[0]) throw new Error("That NASA+ series doesn't exist.");
    const list = await nasaApi(`video?series=${terms[0].id}&per_page=100&${NASA_FIELDS}`);
    const items = (Array.isArray(list) ? list : []).filter(v => nasaStreamOf(v)).map(nasaItem).reverse();
    return { title: clean(`NASA+: ${decodeEntities(terms[0].name)}`, 120), items };
  });
}

// ------------------------------------------------------------------ shared

/**
 * A Tubi or NASA+ link as a playlist item (a series gives its first episode), or null for other links.
 * @param {string} link
 * @returns {Promise<Object|null>}
 */
async function resolveLink(link) {
  const media = MediaSources.detect(link);
  if (!media) return null;
  if (media.type === 'tubi') {
    if (media.kind === 'series') {
      const { items } = await tubiSeries(media.id);
      if (!items.length) throw new Error('That Tubi series has no episodes here.');
      return strip(items[0]);
    }
    return strip(tubiItem(await tubiContent(media.kind, media.id), media.kind));
  }
  if (media.type === 'nasa') return strip(nasaItem(await nasaVideo(media.slug)));
  return null;
}

/** Like resolveLink, but a Tubi series gives every episode. */
async function resolveLinks(link) {
  const media = MediaSources.detect(link);
  if (media && media.type === 'tubi' && media.kind === 'series') return (await tubiSeries(media.id)).items.map(strip);
  const one = await resolveLink(link);
  return one ? [one] : [];
}

/** A playlist item has a title, picture, length and link (search results carry more). */
function strip(item) {
  return { title: item.title, thumbnail: item.thumbnail, duration: item.duration, link: item.link };
}

/**
 * The stream to play for a Tubi movie or episode, or a NASA+ video.
 * @param {string} link
 * @returns {Promise<{url: string, live: boolean, noReferrer?: boolean}>} noReferrer: load it
 *   without saying which page asked (see NoReferrerLoader in public/media-players.js).
 */
function streamFor(link) {
  const media = MediaSources.detect(link);
  if (media && media.type === 'tubi' && media.kind !== 'series') return tubiStream(media.kind, media.id);
  if (media && media.type === 'nasa') return nasaStream(media.slug);
  return Promise.reject(new Error("That link doesn't have a stream to look up."));
}

/**
 * A Tubi category or series, or a NASA+ series, as a list for Lists and the playlist settings:
 * {kind: 'streaming', site, path}, or null.
 */
function listSource(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'tubitv.com' && parts[0] === 'category' && /^[a-z0-9_-]{1,80}$/.test(parts[1] || '')) return { kind: 'streaming', site: 'tubi-category', id: parts[1], name: 'Tubi category' };
  if (host === 'tubitv.com' && parts[0] === 'series' && /^\d{1,12}$/.test(parts[1] || '')) return { kind: 'streaming', site: 'tubi-series', id: parts[1], name: 'Tubi series' };
  if (host === 'plus.nasa.gov' && parts[0] === 'video_series' && /^[a-z0-9-]{1,200}$/.test(parts[1] || '')) return { kind: 'streaming', site: 'nasa-series', id: parts[1], name: 'NASA+ series' };
  return null;
}

/** Loads a list from listSource: {title, items}. */
async function loadList(source) {
  const list = source.site === 'tubi-category' ? await tubiCategory(source.id)
    : source.site === 'tubi-series' ? await tubiSeries(source.id)
      : await nasaSeries(source.id);
  // A list's videos go into the playlist as they are, and a series isn't one video (its link in a
  // search result is looked up when added, which picks its first episode).
  const videos = list.items.filter(item => !/^https:\/\/tubitv\.com\/series\//.test(item.link));
  return { title: list.title, items: videos.map(strip) };
}

module.exports = {
  resolveLink, resolveLinks, streamFor, listSource, loadList,
  searchTubi, searchNasa, tubiCategories, parseTubiData
};
