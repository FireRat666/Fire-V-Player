/**
 * @fileoverview Fast, keyless YouTube search. Posts straight to YouTube's own web search endpoint
 * (the one youtube.com uses, so results match the site), asking for videos only, with a timeout
 * and a short-lived cache. Falls back to the youtubei.js scraper if that request fails.
 * No Google API key is needed or used.
 * @module server/youtube/search
 */

const { TtlCache } = require('../cache.js');

const SEARCH_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const WEB_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } };
/** The "Type: Video" search filter. */
const VIDEOS_ONLY = 'EgIQAQ%3D%3D';
const TIMEOUT_MS = 8000;
/**
 * Results a search gives: YouTube sends about 20 a page, so the second page is asked for too
 * (about 0.8s more). A third page adds next to nothing.
 */
const SEARCH_RESULTS = 50;
const MAX_PAGES = 2;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new TtlCache({ maxEntries: 300 });

let fallbackScraper = null;
/** The old youtubei.js search, only loaded if it is ever needed. */
function scraper() {
  if (!fallbackScraper) {
    const Scraper = require('./scraper.js');
    fallbackScraper = new Scraper();
  }
  return fallbackScraper;
}

/** Text of a YouTube "runs" / "simpleText" object. */
function text(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || '').join('');
  return '';
}

/** Every value stored under `key` anywhere in a response, in document order. */
function findAll(root, key, out = [], depth = 0) {
  if (!root || typeof root !== 'object' || depth > 40) return out;
  if (Array.isArray(root)) {
    for (const item of root) findAll(item, key, out, depth + 1);
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(root, key)) out.push(root[key]);
  for (const value of Object.values(root)) {
    if (value && typeof value === 'object') findAll(value, key, out, depth + 1);
  }
  return out;
}

/** "1:02:03" / "3:45" to seconds; 0 if it isn't a clock time. */
function clockSeconds(t) {
  if (!/^\d+(:\d+)*$/.test(String(t || '').trim())) return 0;
  return String(t).trim().split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

/**
 * One search result in the shape the clients and the rest of the server use (the same shape the
 * youtubei.js scraper returns): duration in milliseconds, a watch link, thumbnail and channel.
 * @param {Object} r - A videoRenderer from the search response.
 * @returns {Object|null}
 */
function parseVideoRenderer(r) {
  if (!r || typeof r.videoId !== 'string') return null;
  const id = r.videoId;
  const durationRaw = text(r.lengthText);
  const seconds = clockSeconds(durationRaw);
  const thumbs = (r.thumbnail && Array.isArray(r.thumbnail.thumbnails)) ? r.thumbnail.thumbnails : [];
  const owner = (r.ownerText && r.ownerText.runs && r.ownerText.runs[0]) || (r.longBylineText && r.longBylineText.runs && r.longBylineText.runs[0]);
  const channelPath = owner && owner.navigationEndpoint && owner.navigationEndpoint.commandMetadata
    && owner.navigationEndpoint.commandMetadata.webCommandMetadata && owner.navigationEndpoint.commandMetadata.webCommandMetadata.url;
  const badges = (r.ownerBadges || []).map(b => b && b.metadataBadgeRenderer && b.metadataBadgeRenderer.style);
  const snippet = r.detailedMetadataSnippets && r.detailedMetadataSnippets[0] && r.detailedMetadataSnippets[0].snippetText;
  return {
    description: text(snippet || r.descriptionSnippet),
    duration: seconds * 1000,
    duration_raw: durationRaw || '00:00',
    uploaded: text(r.publishedTimeText),
    views: parseInt(text(r.viewCountText).replace(/[^0-9]/g, ''), 10) || 0,
    channel: {
      name: (owner && owner.text) || 'Unknown Channel',
      link: channelPath ? `https://www.youtube.com${channelPath}` : '',
      verified: badges.includes('BADGE_STYLE_TYPE_VERIFIED') || badges.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST')
    },
    id,
    link: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    title: text(r.title) || 'Unknown Title',
    shareLink: `https://youtu.be/${id}`
  };
}

/** One request to YouTube's web search endpoint: a search, or the next page of one. */
async function searchRequest(body) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.youtube.com',
      referer: 'https://www.youtube.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9'
    },
    body: JSON.stringify({ context: WEB_CONTEXT, ...body })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The token that asks for the next page of results, or ''. */
function nextPageToken(json) {
  const command = findAll(json, 'continuationCommand').find(c => c && typeof c.token === 'string');
  return command ? command.token : '';
}

/**
 * Asks YouTube's web search endpoint directly. No API key: it is the same request youtube.com makes.
 * @param {string} term
 * @param {Object} [options]
 * @param {number} [options.max] - Most results; more than a page's (about 20) asks for the next pages.
 * @returns {Promise<Array<Object>>} Video results.
 */
async function directSearch(term, { max = 0 } = {}) {
  const seen = new Set();
  const videos = [];
  const take = json => {
    for (const r of findAll(json, 'videoRenderer')) {
      const v = parseVideoRenderer(r);
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      videos.push(v);
    }
  };
  let json = await searchRequest({ query: term, params: VIDEOS_ONLY });
  take(json);
  // More pages, while they keep adding videos. A page that fails just ends the list there.
  for (let page = 1; page < MAX_PAGES && max && videos.length < max; page++) {
    const token = nextPageToken(json);
    if (!token) break;
    const before = videos.length;
    try {
      json = await searchRequest({ continuation: token });
    } catch (e) {
      break;
    }
    take(json);
    if (videos.length === before) break;
  }
  return max ? videos.slice(0, max) : videos;
}

/**
 * Searches YouTube for videos. Tries the direct request first, then the youtubei.js scraper.
 * Results are cached for a few minutes, and identical searches made together share one request.
 *
 * @param {string} term - What to search for.
 * @returns {Promise<{videos: Array<Object>, via: string}>} The videos and which path found them
 *   ('direct', 'youtubei' or 'cache'). Never throws: no results is an empty list.
 */
async function searchVideos(term) {
  const q = String(term || '').trim();
  if (!q) return { videos: [], via: 'direct' };
  // Its own namespace, apart from videoById's id: keys.
  const key = `search:${q.toLowerCase()}`;
  let via = cache.get(key) !== undefined ? 'cache' : 'direct';
  try {
    const videos = await cache.remember(key, CACHE_TTL_MS, async () => {
      try {
        const found = await directSearch(q, { max: SEARCH_RESULTS });
        if (found.length) return found;
        throw new Error('no results');
      } catch (err) {
        console.warn(`[SEARCH] Direct YouTube search failed for ${JSON.stringify(q)} (${err.message}); trying youtubei.js.`);
        via = 'youtubei';
        const results = await scraper().search(q);
        const found = (results && results.videos) || [];
        // Don't keep an empty answer for long: it may be a passing problem.
        if (!found.length) throw new Error('no results');
        return found;
      }
    });
    return { videos, via };
  } catch (err) {
    return { videos: [], via };
  }
}

/**
 * One video's details by its id (for a pasted link). A search for the id returns the video itself,
 * which is quicker than loading youtubei.js; that is still used if the search doesn't find it.
 *
 * @param {string} id - 11-character YouTube video ID.
 * @returns {Promise<Object>} {id, title, link, thumbnail, duration (ms), channel}, as the scraper's getVideoByUrl.
 * @throws {Error} If the video can't be found.
 */
async function videoById(id) {
  try {
    const found = await cache.remember(`id:${id}`, CACHE_TTL_MS, async () => {
      const v = (await directSearch(id)).find(r => r.id === id);
      if (!v || !v.duration) throw new Error('not found by search'); // live or missing: ask youtubei.js
      return v;
    });
    return found;
  } catch (e) {
    return scraper().getVideoByUrl(`https://www.youtube.com/watch?v=${id}`);
  }
}

module.exports = { searchVideos, videoById, parseVideoRenderer, directSearch };
