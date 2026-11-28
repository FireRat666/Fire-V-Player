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
/** How long a catalogue missing a category that wouldn't load is kept before that category is tried again. */
const CATALOG_RETRY_MS = 5 * 60 * 1000;
const NASA_TTL_MS = 60 * 60 * 1000;
/** Most episodes a Tubi series gives, and results a search gives. */
const MAX_EPISODES = 300;
/** Episode pages read at a time, for a series' seasons after the first. */
const EPISODES_AT_ONCE = 4;
/**
 * The longest a series' episode pages are read for (the panel waits LIST_REPLY_MS, 120 s, for the
 * list): episodes not read by then are listed by link, with their season and number for a title.
 * A list like that, or with an episode that wouldn't load, is kept only PARTIAL_TTL_MS.
 */
const SERIES_DEADLINE_MS = 60000;
const PARTIAL_TTL_MS = 60 * 1000;
const MAX_RESULTS = 40;
/** Categories that depend on who's watching, or repeat others, aren't searched. */
const SKIP_CATEGORIES = new Set(['recommended_for_you', 'continue_watching', 'queue', 'weekly_watchlist']);

const cache = new TtlCache({ maxEntries: 400 });
/** Episodes read from their own pages (a long series has hundreds), kept apart from the pages. */
const episodeCache = new TtlCache({ maxEntries: 3000 });

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeEntities = s => String(s || '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const https = url => (String(url || '').startsWith('//') ? `https:${url}` : String(url || ''));

async function fetchText(url, info) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (info) { info.status = res.status; info.url = res.url; }
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

/**
 * Every season of a Tubi series page, from the page's query state (window.__REACT_QUERY_STATE__):
 * [{number, episodes: [{id, num}]}], or null. The site data has the details of the first season's
 * episodes only (and at most 20 of them); this lists every season's episodes, by id.
 */
function parseTubiSeasons(html) {
  const start = html.indexOf('window.__REACT_QUERY_STATE__=');
  if (start < 0) return null;
  const end = html.indexOf('</script>', start);
  try {
    // Its `undefined`s are in lists too ("[undefined]"), not only after a name.
    const body = html.slice(start + 'window.__REACT_QUERY_STATE__='.length, end).trim().replace(/;\s*$/, '')
      .replace(/([:[,])undefined(?=[,}\]])/g, '$1null');
    const query = (JSON.parse(body).queries || []).find(q => q && Array.isArray(q.queryKey) && q.queryKey[0] === 'seriesPaginationInfo');
    const seasons = query && query.state && query.state.data && query.state.data.seasons;
    return Array.isArray(seasons) ? seasons : null;
  } catch (e) {
    return null;
  }
}

/** A Tubi page's data (path like "movies/123" or "category/westerns"), not cached. */
async function fetchTubiPage(path) {
  let html;
  const info = {};
  try {
    html = await fetchText(`https://tubitv.com/${path}`, info);
  } catch (e) {
    console.warn(`[TUBI] ${path}: ${e.message}${info.url ? ` from ${info.url}` : ''}`);
    throw new Error(/HTTP 404/.test(e.message) ? "That Tubi page doesn't exist (or isn't available here)." : "Couldn't reach Tubi. Try again in a moment.");
  }
  if (html.indexOf('window.__data=') < 0) {
    // Tubi answered with some other page. Log what it was, so a server Tubi treats differently
    // (another country, or an address it won't serve) can be told apart from a page change.
    const pageTitle = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const words = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.warn(`[TUBI] ${path}: no page data. HTTP ${info.status} from ${info.url}, ${html.length} bytes, title "${clean(pageTitle, 80)}", text "${clean(words, 300)}"`);
    if (/not (yet )?available in your|isn't available in your|unavailable in your|outside (of )?the|your (country|region|location)/i.test(words)) {
      throw new Error("Tubi isn't available in the country this server is in.");
    }
    throw new Error("Tubi sent this server a different page than usual, so its titles can't be read. It may not serve this server.");
  }
  const data = parseTubiData(html);
  if (/^series\//.test(path)) data.fvpSeasons = parseTubiSeasons(html);
  return data;
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

/** Tubi's picture server, and the biggest picture sent on from it. */
const TUBI_PICTURES = /^https:\/\/canvas-lb\.tubitv\.com\/[A-Za-z0-9_=\/.-]{1,400}$/;
const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
const pictureCache = new TtlCache({ maxEntries: 400 });

/**
 * A Tubi picture as a JPEG (or PNG), for the world's panel (/api/tubi-picture). Tubi's picture
 * server sends WebP to anything that doesn't ask for something else, and Unity can't show WebP,
 * so the panel's thumbnails come through here, asking for a JPEG.
 * @returns {Promise<{type: string, body: Buffer}>}
 */
function tubiPictureFile(url) {
  url = String(url || '');
  if (!TUBI_PICTURES.test(url)) return Promise.reject(new Error("That isn't a Tubi picture."));
  return pictureCache.remember(url, PAGE_TTL_MS, async () => {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/jpeg,image/png;q=0.9' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok) throw new Error(`Tubi answered ${res.status}.`);
    if (type !== 'image/jpeg' && type !== 'image/png') throw new Error(`Tubi sent ${type || 'something else'}.`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_PICTURE_BYTES) throw new Error('That picture is too big.');
    return { type, body };
  });
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
    source: 'tubi',
    // R, TV-MA, not rated (see MediaSources.tubiMature): only where the world allows them.
    mature: MediaSources.tubiMature(c.ratings)
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
  return { url: pick.manifest.url, live: false, mature: MediaSources.tubiMature(c.ratings) };
}

/**
 * An episode's playlist item from its own page, for the ones a series page has no details of
 * (every season after the first). Only the item is kept, not the page.
 */
function tubiEpisode(id) {
  return episodeCache.remember(`tubi:episode:${id}`, PAGE_TTL_MS, async () => {
    const data = await fetchTubiPage(`tv-shows/${id}`);
    const c = data.video && data.video.byId && data.video.byId[id];
    if (!c) throw new Error("That Tubi episode isn't available.");
    return tubiItem(c, 'episode');
  });
}

/**
 * A Tubi series' episodes, season 1 first and each season in order, or one season's
 * (`season`: its number, or 'first' for the lowest). Tubi's series page has the details of the
 * first season's episodes only; every season's episodes are listed by id (see parseTubiSeasons),
 * and the rest are read from their own pages, a few at a time. An episode's title says its season
 * and number ("S01:E03 - Name").
 */
async function tubiSeries(id, season, limit) {
  const key = `tubi:series:${id}:${season || 'all'}${limit ? `:${limit}` : ''}`;
  const list = await cache.remember(key, PAGE_TTL_MS, () => readTubiSeries(id, season, limit));
  // Missing some episodes' details: asked for again soon (the ones read are kept on their own).
  if (list.partial && !list.shortened) { list.shortened = true; cache.set(key, list, PARTIAL_TTL_MS); }
  return list;
}

/** readTubiSeries: `limit`, when given, is the most episodes listed (and read), from the first. */
async function readTubiSeries(id, season, limit) {
  const data = await tubiPage(`series/${id}`);
  const byId = (data.video && data.video.byId) || {};
  const series = byId[`0${id}`] || byId[id];
  if (!series) throw new Error("That Tubi series isn't available.");
  // A series for adults has every episode for adults, whatever an episode's own rating.
  const seriesMature = MediaSources.tubiMature(series.ratings);
  const num = (v, fallback) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : fallback);
  // [{n, eps: [{id, num}]}]: the full list where the page has it, else the site data's.
  const listed = (data.fvpSeasons && data.fvpSeasons.length ? data.fvpSeasons : series.seasons || []).map((s, i) => ({
    n: num(s.number, 1000 + i),
    eps: (s.episodes || []).map((ep, k) => ({ id: String(ep.id || ''), num: num(ep.num != null ? ep.num : ep.episode_number != null ? ep.episode_number : (byId[ep.id] || {}).episode_number, 1000 + k) }))
      .filter(ep => /^\d{1,12}$/.test(ep.id))
  })).sort((a, b) => a.n - b.n);
  let seasons = listed;
  if (season === 'first') seasons = listed.slice(0, 1);
  else if (season) seasons = listed.filter(s => s.n === Number(season));
  if (season && !seasons.length) throw new Error(`That Tubi series has no season ${season} here.`);
  const wanted = [];
  for (const s of seasons) {
    for (const ep of s.eps.slice().sort((a, b) => a.num - b.num)) {
      if (wanted.length < Math.min(MAX_EPISODES, limit || MAX_EPISODES)) wanted.push({ season: s.n, ep });
    }
  }
  const items = new Array(wanted.length);
  let partial = false;
  // An episode with its season and number in its title. Without details (not read in time, or
  // its page wouldn't load) it's still listed, so it can be played: its title and picture come
  // when it's looked up.
  const entry = (k, item) => {
    const { season: n, ep } = wanted[k];
    item = Object.assign({}, item || { title: '', thumbnail: '', duration: 0, link: `https://tubitv.com/tv-shows/${ep.id}` });
    // One without its details goes by the series' rating.
    item.mature = seriesMature || (typeof item.mature === 'boolean' ? item.mature : seriesMature);
    // Most titles already say "S01:E03 - ..."; one that doesn't gets it.
    if (!/^S\d+\s*:?\s*E\d+/i.test(item.title) && n < 1000 && ep.num < 1000) {
      item.title = clean(`S${String(n).padStart(2, '0')}:E${String(ep.num).padStart(2, '0')}${item.title ? ` - ${item.title}` : ''}`);
    }
    if (!item.title) item.title = 'Tubi episode';
    return item;
  };
  let next = 0;
  let late = false;
  const worker = async () => {
    while (next < wanted.length && !late) {
      const k = next++;
      const { ep } = wanted[k];
      let item = null;
      if (byId[ep.id]) item = tubiItem(byId[ep.id], 'episode');
      else {
        try { item = await tubiEpisode(ep.id); } catch (e) { partial = true; }
      }
      if (!late) items[k] = entry(k, item);
    }
  };
  let timer;
  await Promise.race([
    Promise.all(Array.from({ length: EPISODES_AT_ONCE }, worker)),
    new Promise(resolve => { timer = setTimeout(resolve, SERIES_DEADLINE_MS); })
  ]);
  clearTimeout(timer);
  late = true;
  for (let k = 0; k < items.length; k++) {
    if (items[k]) continue;
    // Not reached in time: the series page's own details of it, where it has them.
    const known = byId[wanted[k].ep.id];
    items[k] = entry(k, known ? tubiItem(known, 'episode') : null);
    if (!known) partial = true;
  }
  if (partial) console.warn(`[TUBI] series/${id}: some episodes are listed without their details.`);
  const title = clean(series.title, 120) || 'Tubi series';
  return { title: season && season !== 'first' ? clean(`${title}, Season ${season}`, 120) : title, items, partial, mature: seriesMature };
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

/** Every Tubi category page lists all the categories; these are tried in turn for that list. */
const MENU_PAGES = ['featured', 'most_popular', 'action'];

/** Tubi's categories: [{slug, title}]. */
function tubiCategories() {
  return cache.remember('tubi:categories', CATALOG_TTL_MS, async () => {
    let lastError;
    for (const page of MENU_PAGES) {
      try {
        const container = (await fetchTubiPage(`category/${page}`)).container || {};
        const map = container.containerIdMap || {};
        const list = (container.containerMenuList || Object.keys(map))
          .filter(slug => /^[a-z0-9_-]{1,80}$/.test(slug) && !SKIP_CATEGORIES.has(slug))
          .map(slug => ({ slug, title: clean((map[slug] && map[slug].title) || slug, 80) }));
        if (!list.length) throw new Error("Tubi's list of categories was empty.");
        return list;
      } catch (e) {
        console.warn(`[TUBI] No category list from category/${page}: ${e.message}`);
        lastError = e;
      }
    }
    throw lastError;
  });
}

/**
 * Every title in Tubi's categories, for searching. Loaded a few categories at a time. If a category
 * won't load, the rest are kept for a few minutes, then a search tries it again.
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
  if (partial) cache.set('tubi:catalog', { entries, partial }, CATALOG_RETRY_MS);
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
      // Only the first episode is read, not the rest of its season.
      const { items } = await tubiSeries(media.id, media.season || 'first', 1);
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
  if (media && media.type === 'tubi' && media.kind === 'series') return (await tubiSeries(media.id, media.season)).items.map(strip);
  const one = await resolveLink(link);
  return one ? [one] : [];
}

/**
 * A playlist item has a title, picture, length and link (search results carry more), and whether
 * it's for adults, which is taken off before it goes in the playlist (see media.screenMature).
 */
function strip(item) {
  const kept = { title: item.title, thumbnail: item.thumbnail, duration: item.duration, link: item.link };
  if (typeof item.mature === 'boolean') kept.mature = item.mature;
  return kept;
}

/**
 * Whether a Tubi link's title is for adults (see MediaSources.tubiMature): a movie or episode by
 * its own rating, a series by its own.
 * @param {string} link
 * @returns {Promise<boolean>}
 */
async function isMature(link) {
  const media = MediaSources.detect(link);
  if (!media || media.type !== 'tubi') throw new Error("That isn't a Tubi link.");
  if (media.kind === 'series') {
    const data = await tubiPage(`series/${media.id}`);
    const byId = (data.video && data.video.byId) || {};
    const series = byId[`0${media.id}`] || byId[media.id];
    if (!series) throw new Error("That Tubi series isn't available.");
    return MediaSources.tubiMature(series.ratings);
  }
  return MediaSources.tubiMature((await tubiContent(media.kind, media.id)).ratings);
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
  if (host === 'tubitv.com' && parts[0] === 'series' && /^\d{1,12}$/.test(parts[1] || '')) {
    // A season's page (series/<id>/<name>/season-2) is that season alone.
    const season = MediaSources.detect(u.href);
    return { kind: 'streaming', site: 'tubi-series', id: parts[1], season: season && season.season, name: 'Tubi series' };
  }
  if (host === 'plus.nasa.gov' && parts[0] === 'video_series' && /^[a-z0-9-]{1,200}$/.test(parts[1] || '')) return { kind: 'streaming', site: 'nasa-series', id: parts[1], name: 'NASA+ series' };
  return null;
}

/** Loads a list from listSource: {title, items}. */
async function loadList(source) {
  const list = source.site === 'tubi-category' ? await tubiCategory(source.id)
    : source.site === 'tubi-series' ? await tubiSeries(source.id, source.season)
      : await nasaSeries(source.id);
  // A list's videos go into the playlist as they are, and a series isn't one video (its link in a
  // search result is looked up when added, which picks its first episode).
  const videos = list.items.filter(item => !/^https:\/\/tubitv\.com\/series\//.test(item.link));
  // partial: some of a series' episodes are listed without their details (see readTubiSeries).
  return { title: list.title, items: videos.map(strip), partial: !!list.partial };
}

module.exports = {
  resolveLink, resolveLinks, streamFor, listSource, loadList, isMature,
  searchTubi, searchNasa, tubiCategories, parseTubiData, tubiPictureFile
};
