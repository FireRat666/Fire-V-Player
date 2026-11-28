/**
 * @fileoverview Internet Archive movies and TV: search and playable links, with no API key.
 * Searches the Archive's public-domain film and TV collections, and turns an Archive item (or a
 * publicdomainmovie.net page, which plays Archive items) into direct
 * https://archive.org/download/<id>/<file>.mp4 links, which play and sync like any video file.
 * @module server/archive
 */

const https = require('https');
const { TtlCache } = require('./cache.js');
const MediaSources = require('../public/media-sources.js');

const TIMEOUT_MS = 8000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const ITEM_TTL_MS = 60 * 60 * 1000;
const SEARCH_ROWS = 30;
/** Most files a pasted Archive link lists (a whole TV season is one item). */
const MAX_ITEM_FILES = 100;
const cache = new TtlCache({ maxEntries: 300 });

/**
 * The Archive's curated public-domain film and TV collections. The wider "moviesandfilms" and
 * TV collections are left out: anyone can upload there, so they are full of copyrighted uploads
 * and recorded broadcasts.
 */
const COLLECTIONS = ['feature_films', 'classic_tv', 'classic_tv_1950s', 'Film_Noir', 'SciFi_Horror',
  'silent_films', 'short_films', 'classic_cartoons', 'vintage_cartoons'];

const HEADERS = { 'user-agent': 'Mozilla/5.0 (Fire-V-Player)' };

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * A web page's HTML (the first 500 KB). Not fetch(): Node gives each address only 250ms to
 * connect before trying the next, and publicdomainmovie.net (one IPv4 address, far from many
 * hosts) often takes longer, so fetch() fails where a browser wouldn't.
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: TIMEOUT_MS, autoSelectFamilyAttemptTimeout: 2500 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        html += chunk;
        if (html.length > 500000) res.destroy();
      });
      res.on('close', () => resolve(html));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** The first value of a metadata field, which the Archive sends as a string or an array. */
function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function cleanText(value, max = 200) {
  return String(first(value) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Seconds from the Archive's free-form lengths: "1:31:44", "25 min", "Runtime: 30m 20s", "5504.57".
 * @param {*} value
 * @returns {number} Seconds, or 0 if it can't be read.
 */
function parseSeconds(value) {
  const t = String(first(value) || '').trim();
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const clock = /(\d+(?::\d{1,2}){1,2})(?:\.\d+)?/.exec(t);
  if (clock) return clock[1].split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  const h = /(\d+)\s*h/i.exec(t), m = /(\d+)\s*m/i.exec(t), s = /(\d+)\s*s/i.exec(t);
  if (h || m || s) return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
  return 0;
}

/**
 * The Archive's own marks for adult items: it puts them in these "collections", which hide their
 * pictures and keep them out of its listings.
 */
const ADULT_MARKS = new Set(['no-preview', 'deemphasize']);

/**
 * Words that mark an adult film wherever they are, its description included. Even the curated
 * collections have stag films, many without the Archive's own marks.
 */
const ADULT_WORDS = /\b(stag ?(films?|reels?|movies?|loops?)|vintage stag|porn|porno|pornography|pornographic|xxx|erotic[as]?|erotica|erotikon|sexploitation|nudie|nudist|nudism|nudes?|nudity|topless|strip-?tease|strippers?|fetish|peep ?shows?|roughies?|x-rated|hentai|sex scenes?|adult (films?|movies?|stars?|actress(es)?|entertainment|content)|adults only)\b/i;

/**
 * Words that mark one only in its title or subjects: a plot description uses them for other things
 * ("a penthouse apartment", "an aimless playboy"). They catch some classics too ("Lady of
 * Burlesque"); those play where mature-links is on.
 */
const ADULT_TITLE_WORDS = /\b(naked|burlesque|bondage|spank(ing|ed)?|pin-?ups?|sexy|sex|sexuality|lingerie|cheesecake|stags?|bares?|playgirls?|strips|strip-?off)\b/i;

/** A subject that is just one of these words. */
const ADULT_SUBJECTS = /^\s*(adult|adults|mature|erotic|18\+|nsfw)\s*$/i;

/**
 * Whether an Archive item is for adults, from its metadata: anything outside the curated
 * collections (where anyone can upload anything), anything the Archive marks as adult, and
 * anything whose title, subjects or description use an adult film's words.
 *
 * @param {Object} meta - The item's metadata (or a search result's fields): collection, subject, title, description.
 * @returns {boolean}
 */
function isMatureMeta(meta) {
  if (!meta) return true;
  const collections = [].concat(meta.collection || []).map(String);
  if (!collections.some(c => COLLECTIONS.includes(c))) return true;
  if (collections.some(c => ADULT_MARKS.has(c.toLowerCase()))) return true;
  const list = value => [].concat(value || []).map(String);
  const subjects = list(meta.subject).flatMap(s => s.split(/[;,]/));
  if (subjects.some(s => ADULT_SUBJECTS.test(s))) return true;
  // Runs of spaces count as one, so "stag  film" reads as "stag film".
  const named = list(meta.title).concat(subjects).join(' ').replace(/\s+/g, ' ');
  if (ADULT_TITLE_WORDS.test(named)) return true;
  // Its HTML's entities decoded (&nbsp; between "stag" and "film" included), so its words match.
  const description = decodeEntities(list(meta.description).join(' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
  const all = `${named} ${description}`;
  return ADULT_WORDS.test(all);
}

/** HTML entities as text: named ones (spaces, quotes, ...) and numeric ones. */
const NAMED_ENTITIES = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '-', mdash: '-' };
function decodeEntities(s) {
  const code = n => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
  return String(s || '')
    .replace(/&#(\d{1,7});/g, (m, n) => code(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => code(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, n.toLowerCase()) ? NAMED_ENTITIES[n.toLowerCase()] : m));
}

function thumbnailFor(id) {
  return `https://archive.org/services/img/${encodeURIComponent(id)}`;
}

function downloadLink(id, name) {
  return `https://archive.org/download/${encodeURIComponent(id)}/${String(name).split('/').map(encodeURIComponent).join('/')}`;
}

/** Only letters, numbers and a few joining characters reach the Archive's query language. */
function queryWords(term) {
  return String(term || '').replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).map(w => w.replace(/^[-']+|[-']+$/g, '')).filter(Boolean).slice(0, 12);
}

async function advancedSearch(query) {
  const params = new URLSearchParams({ q: query, rows: String(SEARCH_ROWS), output: 'json' });
  for (const f of ['identifier', 'title', 'runtime', 'year', 'collection', 'subject', 'description']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');
  const json = await fetchJson(`https://archive.org/advancedsearch.php?${params}`);
  return (json && json.response && json.response.docs) || [];
}

/**
 * Searches the Archive's public-domain movie and TV collections. Titles that contain every word
 * come first, most watched first; if no title matches, any item that mentions the words.
 *
 * Each result links to the item's page (archive.org/details/<id>). The file to play is chosen
 * when it is added (see resolveLink), so a search costs one request.
 *
 * @param {string} term
 * @returns {Promise<Array<Object>>} Results shaped like YouTube search results.
 */
async function search(term) {
  const words = queryWords(term);
  if (!words.length) return [];
  const key = words.join(' ').toLowerCase();
  return cache.remember(`search:${key}`, SEARCH_TTL_MS, async () => {
    const scope = `mediatype:movies AND collection:(${COLLECTIONS.join(' OR ')}) AND -access-restricted-item:true`;
    let docs = await advancedSearch(`title:(${words.join(' AND ')}) AND ${scope}`);
    if (!docs.length) docs = await advancedSearch(`(${words.join(' AND ')}) AND ${scope}`);
    return docs.filter(d => d && d.identifier).map(d => {
      const year = cleanText(d.year, 4);
      return {
        id: d.identifier,
        title: cleanText(d.title) || d.identifier,
        duration: parseSeconds(d.runtime) * 1000,
        thumbnail: thumbnailFor(d.identifier),
        link: `https://archive.org/details/${d.identifier}`,
        channel: { name: year ? `Internet Archive, ${year}` : 'Internet Archive', link: '' },
        description: '',
        source: 'archive',
        mature: isMatureMeta(d)
      };
    });
  });
}

/**
 * The item's details and its playable mp4 files, best first per video. Cached for an hour.
 * @param {string} id - Archive identifier.
 * @returns {Promise<{id: string, title: string, files: Array<Object>}>}
 */
async function getItem(id) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id || '')) throw new Error("That isn't an Internet Archive item.");
  return cache.remember(`item:${id}`, ITEM_TTL_MS, async () => {
    let json;
    try {
      json = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    } catch (e) {
      throw new Error("Couldn't reach the Internet Archive. Try again in a moment.");
    }
    if (!json || !json.metadata || !Array.isArray(json.files)) throw new Error("That Internet Archive item wasn't found.");
    const meta = json.metadata;
    if (json.is_dark || String(first(meta['access-restricted-item'])) === 'true') {
      throw new Error("That Internet Archive item can't be streamed (it is restricted).");
    }

    // Every mp4 that browsers can play, grouped by the video it was made from, so an item with
    // several videos (a TV season) gives one entry each and an item with several copies of one
    // video (360p, 512kb, ...) gives its best copy.
    const groups = new Map();
    for (const f of json.files) {
      if (!f || typeof f.name !== 'string' || !/\.(mp4|m4v)$/i.test(f.name) || String(f.private) === 'true') continue;
      if (!/h\.?264|mpeg-?4/i.test(f.format || '')) continue;
      const key = f.source === 'derivative' && f.original ? f.original : f.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    // h.264 derivatives (about 480p) play smoothly; 512kb ones are smaller; originals can be huge.
    const rank = f => {
      const fmt = String(f.format || '');
      const height = Number(f.height) || 0;
      if (/^h\.264$/i.test(fmt)) return 0;
      if (/512kb/i.test(fmt)) return 1;
      return height && height <= 720 ? 2 : 3;
    };
    const files = [];
    for (const list of groups.values()) {
      list.sort((a, b) => rank(a) - rank(b) || Math.abs((Number(a.height) || 480) - 480) - Math.abs((Number(b.height) || 480) - 480));
      files.push(list[0]);
    }
    // In name order, so a season's episodes stay in order even when their copies differ.
    files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));
    const describe = f => ({
      name: f.name,
      title: cleanText(f.title) || f.name.split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '),
      duration: parseSeconds(f.length) * 1000
    });
    return {
      id,
      title: cleanText(meta.title) || id,
      mature: isMatureMeta(meta),
      // The best copy of each video (each group above picked its own best).
      files: files.slice(0, MAX_ITEM_FILES).map(describe),
      // Every copy, for a link straight to one of them.
      allFiles: [].concat(...groups.values()).map(describe)
    };
  });
}

/** A playlist item for one of an item's files. */
function toVideo(item, file, many) {
  return {
    title: (many ? `${item.title} - ${file.title}` : item.title).slice(0, 200),
    thumbnail: thumbnailFor(item.id),
    duration: file.duration,
    link: downloadLink(item.id, file.name),
    channel: { name: 'Internet Archive', link: '' },
    source: 'archive',
    mature: item.mature
  };
}

/**
 * The Archive identifier a link points at, or an empty string. Reads publicdomainmovie.net pages,
 * which play an Archive item through movie.php?id=<identifier>.
 * @param {string} link
 * @returns {Promise<{id: string, file: string}>}
 */
async function identify(link) {
  const m = MediaSources.detect(link);
  if (!m || !(m.type === 'archive' || m.archive)) return { id: '', file: '' };
  if (m.id || m.archive) return { id: m.id || m.archive, file: m.file || '' };
  if (!m.page) return { id: '', file: '' };
  return cache.remember(`page:${m.page}`, ITEM_TTL_MS, async () => {
    let html = '';
    try {
      html = await fetchPage(m.page);
    } catch (e) { /* not found below */ }
    const found = /movie\.php\?id=([A-Za-z0-9._-]+)(?:\\u0026|&amp;|&)type=\.mp4/.exec(html);
    if (!found) throw new Error("Couldn't find the movie on that page.");
    return { id: found[1], file: '' };
  });
}

/**
 * Every video an Archive or publicdomainmovie.net link holds (for a pasted link's search results).
 * @param {string} link
 * @returns {Promise<Array<Object>>}
 */
async function resolveLinkAll(link) {
  const { id, file } = await identify(link);
  if (!id) throw new Error("That isn't an Internet Archive link.");
  const item = await getItem(id);
  if (file) {
    // A link straight to a file plays that file, with the item's title (and length, if known).
    const own = item.allFiles.find(f => f.name === file) || { name: file, title: '', duration: 0 };
    return [toVideo(item, own, item.files.length > 1 && !!own.title)];
  }
  if (!item.files.length) throw new Error("That Internet Archive item has no video that can be played here.");
  return item.files.map(f => toVideo(item, f, item.files.length > 1));
}

/**
 * The video to play for an Archive or publicdomainmovie.net link: the linked file, or the item's
 * first video.
 * @param {string} link
 * @returns {Promise<Object>} A playlist item whose link is an archive.org/download/... file.
 */
async function resolveLink(link) {
  const { id, file } = await identify(link);
  if (id && !file) {
    // The item someone picked (a search result): its first video, under the item's own title
    // rather than that file's name, which is often an encoding note like "720p H.264 (mkv)".
    const item = await getItem(id);
    if (!item.files.length) throw new Error("That Internet Archive item has no video that can be played here.");
    return toVideo(item, item.files[0], false);
  }
  return (await resolveLinkAll(link))[0];
}

/**
 * Whether an Archive or publicdomainmovie.net link (a page, an item or one of its files) is for
 * adults (see isMatureMeta).
 * @param {string} link
 * @returns {Promise<boolean>}
 */
async function isMature(link) {
  const { id } = await identify(link);
  if (!id) throw new Error("That isn't an Internet Archive link.");
  return (await getItem(id)).mature;
}

module.exports = { search, getItem, resolveLink, resolveLinkAll, parseSeconds, isMatureMeta, isMature, COLLECTIONS };
