/**
 * @fileoverview ESO and ESA/Hubble videos: their video pages become direct .mp4 links on their own
 * servers (cdn.eso.org, cdn.esahubble.org), which play and sync like any video file; their
 * archive pages (a category such as Fulldome, or a search) load as lists; and ESO's videos can be
 * searched, all of them or just the fulldome ones (for planetarium domes).
 *
 * Both sites run the same software, with no API: each video's page lists its files, length and
 * credit, and each archive page lists 50 videos with a link to the next 50. A fulldome video's
 * file is its dome preview (a 1024x1024 fisheye, the dome master made small enough to stream);
 * any other video's is its 1080p file, or the next best .mp4 it has. Pages are kept a day, as a
 * video's files don't change.
 *
 * Their videos are free to use with the credit shown (most under CC BY 4.0), so each item's
 * channel is its credit line.
 * @module server/eso
 */

const { TtlCache } = require('./cache.js');

const TIMEOUT_MS = 10000;
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_TTL_MS = 60 * 60 * 1000;
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; Fire-V-Player)' };
/** Most videos a list gives (two archive pages), most a search gives, and pages read at once. */
const MAX_LIST = 100;
const MAX_RESULTS = 30;
const CONCURRENCY = 4;
/** A video's id: its name in its page's address. */
const ID = /^[A-Za-z0-9_.-]{1,120}$/;
/** The files a video can be played from, best first (all H.264 MP4 or M4V). */
const FORMATS = ['dome_preview', 'hd_1080p25_screen', 'ultra_hd', 'hd_and_apple', 'medium_podcast'];

/** Each site: where its video pages and files are. */
const SITES = {
  eso: { name: 'ESO', host: 'eso.org', videos: 'https://www.eso.org/public/videos/', cdn: 'cdn.eso.org', files: 'https://cdn.eso.org/videos/' },
  hubble: { name: 'ESA/Hubble', host: 'esahubble.org', videos: 'https://esahubble.org/videos/', cdn: 'cdn.esahubble.org', files: 'https://cdn.esahubble.org/archives/videos/' }
};
/** Archive pages and other parts of /videos/ that aren't videos. */
const NOT_VIDEOS = new Set(['archive', 'search', 'feed', 'list', 'category', 'viewall']);

const cache = new TtlCache({ maxEntries: 2000 });

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeEntities = s => String(s || '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const text = html => clean(decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ')));

async function fetchPage(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) throw new Error("That ESO video doesn't exist.");
  if (!res.ok) throw new Error("Couldn't reach ESO's site. Try again in a moment.");
  return res.text();
}

/**
 * The site and path parts of an ESO or ESA/Hubble address, or null. ESO's pages are under
 * /public/videos/ (or /public/<country>/videos/, the same pages in other languages).
 * @param {URL} u
 * @returns {{site: string, parts: string[]}|null} parts: what comes after /videos/.
 */
function sitePath(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'eso.org' && parts[0] === 'public') {
    const at = parts.indexOf('videos');
    if (at === 1 || at === 2) return { site: 'eso', parts: parts.slice(at + 1) };
  }
  if (host === 'esahubble.org' && parts[0] === 'videos') return { site: 'hubble', parts: parts.slice(1) };
  return null;
}

/** A video page's link as {site, id}, or null (see public/media-sources.js, which detects the same). */
function videoOf(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  // A file on the site's own server: its name is the video's id.
  for (const [site, s] of Object.entries(SITES)) {
    if (host === s.cdn) {
      const name = (u.pathname.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
      return ID.test(name) ? { site, id: name, file: u.href } : null;
    }
  }
  const p = sitePath(u);
  if (!p || p.parts.length !== 1 || NOT_VIDEOS.has(p.parts[0]) || !ID.test(p.parts[0])) return null;
  return { site: p.site, id: p.parts[0] };
}

/** "31 m 22 s", "1 h 05 m 00 s" or "45 s" in milliseconds. */
function parseDuration(s) {
  const part = unit => { const m = new RegExp(`(\\d+)\\s*${unit}\\b`).exec(s || ''); return m ? Number(m[1]) : 0; };
  return ((part('h') * 60 + part('m')) * 60 + part('s')) * 1000;
}

/** What a video's page says: its title, length, credit, picture and files ({format: url}). */
function parseVideoPage(html, site, id) {
  const s = SITES[site];
  const og = name => { const m = new RegExp(`property="og:${name}" content="([^"]*)"`).exec(html); return m ? decodeEntities(m[1]) : ''; };
  const h1 = /<h1[^>]*>([^<]*)/.exec(html);
  const files = {};
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`https://${s.cdn.replace(/\./g, '\\.')}/(?:archives/)?videos/([a-z0-9_]+)/${escaped}\\.(mp4|m4v)`, 'g');
  for (let m; (m = re.exec(html));) if (!files[m[1]]) files[m[1]] = m[0];
  const credit = /<div class="credit">([\s\S]*?)<\/div>/.exec(html);
  // ESO's pages put the length in <td>s, ESA/Hubble's in a <th> and a <td>.
  const duration = /Duration:<\/t[dh]>\s*<td>([^<]*)/.exec(html);
  const picture = (og('image') || `${s.files}videoframe/${id}.jpg`).replace(/^http:\/\//, 'https://');
  // The credit's first line (who made it); the rest names each person's part.
  const firstLine = credit ? credit[1].split(/<br\s*\/?>|<\/p>/i).map(text).find(Boolean) : '';
  return {
    title: clean(og('title') || (h1 && decodeEntities(h1[1])) || id),
    duration: duration ? parseDuration(duration[1]) : 0,
    credit: clean(firstLine, 120) || s.name,
    thumbnail: /^https:\/\//.test(picture) ? picture : '',
    files
  };
}

/** A video's page, read once a day. */
function videoPage(site, id) {
  return cache.remember(`eso:video:${site}:${id}`, PAGE_TTL_MS, async () =>
    parseVideoPage(await fetchPage(`${SITES[site].videos}${id}/`), site, id));
}

/** A video as a playlist item: its best file, or the file it was asked for. */
async function videoItem(site, id, file) {
  const page = await videoPage(site, id);
  const link = file || FORMATS.map(f => page.files[f]).find(Boolean);
  if (!link) throw new Error(`That ${SITES[site].name} video has no MP4 file that can play here.`);
  return {
    title: page.title,
    thumbnail: page.thumbnail,
    duration: page.duration,
    link,
    channel: { name: page.credit || SITES[site].name, link: `${SITES[site].videos}${id}/` },
    source: 'eso'
  };
}

/**
 * An ESO or ESA/Hubble video page (or one of its files) as a playlist item.
 * @param {string} link
 */
async function resolveLink(link) {
  const v = videoOf(link);
  if (!v) throw new Error("That isn't an ESO or ESA/Hubble video's page.");
  try {
    return strip(await videoItem(v.site, v.id, v.file));
  } catch (e) {
    // A file whose page can't be read still plays, under its file name.
    if (v.file) return { title: v.id, thumbnail: '', duration: 0, link: v.file };
    throw e;
  }
}

/** An archive page's videos: [{id, title}] and its next page's link. */
function parseArchivePage(html, site, pageUrl) {
  const items = [];
  const seen = new Set();
  const re = /caption"><a href="([^"]*\/videos\/([A-Za-z0-9_.-]+)\/)"><span class="title">([^<]*)/g;
  for (let m; (m = re.exec(html));) {
    if (seen.has(m[2]) || NOT_VIDEOS.has(m[2])) continue;
    seen.add(m[2]);
    items.push({ id: m[2], title: clean(decodeEntities(m[3])) });
  }
  // The next page: .../list/<n + 1>/ with the same search.
  let next = '';
  try {
    const u = new URL(pageUrl);
    const m = /\/list\/(\d+)\/?$/.exec(u.pathname);
    const n = m ? Number(m[1]) : 1;
    const nextPath = m ? u.pathname.replace(/\/list\/\d+\/?$/, `/list/${n + 1}/`) : `${u.pathname.replace(/\/?$/, '/')}list/${n + 1}/`;
    if (html.includes(`list/${n + 1}/`)) next = `${u.origin}${nextPath}${u.search}`;
  } catch (e) {}
  const heading = /<h1[^>]*>([^<]*)/.exec(html);
  return { items, next, heading: heading ? clean(decodeEntities(heading[1])) : '' };
}

/** Up to `max` videos from an archive page and the pages after it: {heading, items}. */
function archiveVideos(site, url, max) {
  return cache.remember(`eso:archive:${max}:${url}`, LIST_TTL_MS, async () => {
    const items = [];
    let heading = '';
    for (let page = url, n = 0; page && items.length < max && n < 6; n++) {
      const parsed = parseArchivePage(await fetchPage(page), site, page);
      if (!heading) heading = parsed.heading;
      for (const item of parsed.items) if (items.length < max && !items.some(i => i.id === item.id)) items.push(item);
      page = parsed.items.length ? parsed.next : '';
    }
    return { heading, items };
  });
}

/** A playlist item has a title, picture, length and link (search results carry the credit too). */
function strip(item) {
  return { title: item.title, thumbnail: item.thumbnail, duration: item.duration, link: item.link };
}

/** Each video as a playlist item (its page read for its file), dropping those with nothing to play. */
async function itemsFor(site, videos) {
  const results = new Array(videos.length);
  let next = 0;
  const worker = async () => {
    while (next < videos.length) {
      const i = next++;
      try {
        const item = await videoItem(site, videos[i].id);
        results[i] = { ...item, title: videos[i].title || item.title };
      } catch (e) {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videos.length) }, worker));
  return results.filter(Boolean);
}

/**
 * An archive page (a category such as Fulldome, a search, or every video) as a list for Lists and
 * the playlist settings, or null.
 * @param {URL} u
 */
function listSource(u) {
  const p = sitePath(u);
  if (!p) return null;
  const all = p.parts.length === 0 && u.searchParams.get('search');
  const archive = p.parts[0] === 'archive' || p.parts[0] === 'list';
  if (!all && !archive) return null;
  const category = p.parts[0] === 'archive' && p.parts[1] === 'category' && /^[a-z0-9_-]{1,60}$/.test(p.parts[2] || '') ? p.parts[2] : '';
  const url = new URL(u.href);
  url.hash = '';
  return { kind: 'eso', site: p.site, url: url.href, category, name: SITES[p.site].name };
}

/** Loads an archive page's videos: {title, items}. @param {{site, url, category}} source - From listSource. */
async function loadList(source) {
  const { heading, items } = await archiveVideos(source.site, source.url, MAX_LIST);
  const name = SITES[source.site].name;
  const search = new URL(source.url).searchParams.get('search');
  const what = source.category ? source.category.replace(/^./, c => c.toUpperCase()) : (heading || 'Videos');
  const title = clean(`${name}: ${what}${search ? ` matching "${search}"` : ''}`, 120);
  return { title, items: (await itemsFor(source.site, items)).map(strip) };
}

/**
 * Searches ESO's videos, or only its fulldome ones.
 * @param {string} term
 * @param {boolean} [fulldome]
 */
function search(term, fulldome = false) {
  const q = clean(term, 120);
  if (!q) return Promise.resolve([]);
  const base = SITES.eso.videos + (fulldome ? 'archive/category/fulldome/' : '');
  return cache.remember(`eso:search:${fulldome}:${q.toLowerCase()}`, LIST_TTL_MS, async () => {
    const { items } = await archiveVideos('eso', `${base}?search=${encodeURIComponent(q)}`, MAX_RESULTS);
    return itemsFor('eso', items);
  });
}

module.exports = { resolveLink, listSource, loadList, search, videoOf, parseVideoPage, parseArchivePage, parseDuration, SITES };
