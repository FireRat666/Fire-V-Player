/**
 * @fileoverview Library of Congress films: its item pages, film handles and video files become
 * direct https://tile.loc.gov/... .mp4 links, which play and sync like any video file.
 *
 * The Library keeps its films' videos at
 * tile.loc.gov/storage-services/service/mbrs/<collection>/<number>/<number>.mp4, named by the
 * film's handle (hdl.loc.gov/loc.mbrsmi/<collection>.<number>). An item whose id is "mbrs" and
 * eight digits is in the ntscrm collection under those digits, so it needs no lookup, and the
 * public-domain National Film Registry films are listed below.
 *
 * loc.gov's pages and catalogue sit behind a bot check that often refuses servers, so nothing
 * here depends on them: other items are looked up there once, as a best effort, and a link that
 * can't be looked up gets a message saying to paste the film's video link instead. The video
 * files themselves (tile.loc.gov) are served to anyone.
 * @module server/loc
 */

const { TtlCache } = require('./cache.js');
const MediaSources = require('../public/media-sources.js');

const TIMEOUT_MS = 8000;
const TTL_MS = 24 * 60 * 60 * 1000;
const TILE = 'https://tile.loc.gov/storage-services/service/mbrs';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Fire-V-Player)' };
/** Most films a free-to-use page gives, and lookups at once. */
const MAX_LIST = 100;
const CONCURRENCY = 3;
const NOT_FOUND = "I couldn't find that Library of Congress film's video. Open its page on loc.gov and paste the link from its Download menu (the MP4) instead.";

/** The public-domain films of the National Film Registry (loc.gov/free-to-use), with their files. */
const REGISTRY_PAGE = 'https://www.loc.gov/free-to-use/public-domain-films-from-the-national-film-registry/';
const REGISTRY_PICTURES = 'https://www.loc.gov/static/portals/free-to-use/public-domain/national-film-registry/';
const REGISTRY_TITLE = 'Public Domain Films from the National Film Registry';
/** [item id, title, handle (collection.number), picture]; a film whose file isn't known yet has no handle. */
const REGISTRY = [
  ['mbrs00063365', 'St. Louis Blues', 'ntscrm.00063365', 'image1.jpg'],
  ['mbrs00068306', 'Popeye the Sailor Meets Sindbad the Sailor', 'ntscrm.00068306', 'image2.jpg'],
  ['mbrs00009167', 'The House I Live In', 'ntscrm.00009167', 'image3.jpg'],
  ['mbrs00021068', "The Middleton Family at the New York World's Fair", 'ntscrm.00021068', 'image4.jpg'],
  ['mbrs00045468', 'Modesta', 'ntscrm.00045468', 'image5.jpg'],
  ['mbrs02297907', 'Master Hands', 'ntscrm.02297907', 'image6.jpg'],
  ['mbrs00009301', 'The Memphis Belle: A Story of a Flying Fortress', 'ntscrm.00009301', 'image7.jpg'],
  ['2017604960', "All My Babies: A Midwife's Own Story", 'ntscrm.00197476', 'image8.jpg'],
  ['mbrs02023537', 'Under Western Stars', 'ntscrm.02023537', 'image9.jpg'],
  ['mbrs01836081', 'Duck and Cover', 'ntscrm.01836081', 'image10.jpg'],
  ['mbrs00047382', 'The Hitch-Hiker', 'ntscrm.00047382', 'image11.jpg'],
  ['mbrs02425201', 'Trance and Dance in Bali', 'ntscrm.02425201', 'image12.jpg'],
  ['mbrs00046435', 'Within Our Gates', 'ntscrm.00046435', 'image13.jpg'],
  ['00694425', 'San Francisco Earthquake and Fire, April 18, 1906', '', 'image14.jpg'],
  ['00694336', 'President McKinley Taking the Oath', '', 'image15.jpg'],
  ['00694220', 'The Great Train Robbery', 'ntscrm.00000765', 'image16.jpg'],
  ['96522104', 'Panorama of Machine Co. Aisle, Westinghouse Co. Works', 'westhpp.2122', 'image17.jpg'],
  ['00694131', 'May Irwin Kiss', '', 'image18.jpg']
].map(([id, title, handle, picture]) => ({ id, title, handle, thumbnail: REGISTRY_PICTURES + picture }));

const cache = new TtlCache({ maxEntries: 500 });

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeEntities = s => String(s || '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function fetchOk(url, opts = {}) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** The video file of a film handle ("ntscrm.00063365", or its collection and number). */
function fileFor(collection, number) {
  if (number === undefined) [collection, number] = String(collection).split('.');
  return `${TILE}/${collection}/${number}/${number}.mp4`;
}

/** Whether a tile.loc.gov file is there. A file found is remembered, as the files don't move. */
async function fileExists(url) {
  try {
    return await cache.remember(`exists:${url}`, TTL_MS, async () => {
      await fetchOk(url, { method: 'HEAD' });
      return true;
    });
  } catch (e) {
    return false;
  }
}

/** The Registry film with this item id or video file, or null. */
function registryFilm(id, url) {
  return REGISTRY.find(f => (id && f.id === id) || (url && f.handle && fileFor(f.handle) === url)) || null;
}

/** From the catalogue's record of an item (MODS): its title and video file. */
async function catalogueRecord(id) {
  const xml = await (await fetchOk(`https://lccn.loc.gov/${encodeURIComponent(id)}/mods`)).text();
  const handle = /hdl\.loc\.gov\/loc\.mbrsmi\/([a-z]+)\.(\d{1,12})/.exec(xml);
  const titleInfo = /<titleInfo(?![^>]*type=)[^>]*>([\s\S]*?)<\/titleInfo>/.exec(xml);
  const part = tag => {
    const m = titleInfo && new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(titleInfo[1]);
    return m ? decodeEntities(m[1]) : '';
  };
  return { title: clean([part('nonSort'), part('title')].join(' ')), url: handle ? fileFor(handle[1], handle[2]) : '' };
}

/** From loc.gov's JSON for an item: its title and its mp4 on tile.loc.gov. */
async function apiRecord(id) {
  const data = await (await fetchOk(`https://www.loc.gov/item/${encodeURIComponent(id)}/?fo=json`)).json();
  const urls = [];
  for (const r of (data.resources || [])) {
    if (typeof r.video === 'string') urls.push(r.video);
    for (const f of [].concat(...(r.files || []))) {
      if (f && typeof f.url === 'string' && /video\/mp4/i.test(String(f.mimetype || ''))) urls.push(f.url);
    }
  }
  return { title: clean((data.item && data.item.title) || ''), url: urls.find(u => /^https:\/\/tile\.loc\.gov\/.+\.mp4$/i.test(u)) || '' };
}

/**
 * A film as a playlist item, from its item id: {title, thumbnail, duration, link}. Cached a day.
 * @param {string} id - The item's id (loc.gov/item/<id>/), such as mbrs00063365 or 00694220.
 */
function itemById(id) {
  return cache.remember(`item:${id}`, TTL_MS, async () => {
    const film = registryFilm(id);
    let title = film ? film.title : '';
    let url = '';
    const direct = /^mbrs(\d{8})$/i.exec(id);
    const known = film && film.handle ? fileFor(film.handle) : (direct ? fileFor('ntscrm', direct[1]) : '');
    if (known && await fileExists(known)) url = known;
    // Anything else is asked of loc.gov once each way; it may well refuse.
    for (const lookup of [catalogueRecord, apiRecord]) {
      if (url && title) break;
      try {
        const rec = await lookup(id);
        title = title || rec.title;
        if (!url && rec.url && await fileExists(rec.url)) url = rec.url;
      } catch (e) { /* refused or not found */ }
    }
    if (!url) throw new Error(NOT_FOUND);
    return { title: title || `Library of Congress film ${id}`, thumbnail: film ? film.thumbnail : '', duration: 0, link: url };
  });
}

/**
 * A Library of Congress link as a playlist item: an item page (loc.gov/item/<id>/, lccn.loc.gov/<id>),
 * a film handle or resource page, or a tile.loc.gov video file. The length is learnt when it plays.
 * @param {string} link
 * @returns {Promise<Object>}
 */
async function resolveLink(link) {
  const media = MediaSources.detect(link);
  if (!media || (media.type !== 'loc' && !media.loc)) throw new Error(NOT_FOUND);
  if (media.type === 'loc' && media.id) return itemById(media.id);

  const url = media.type === 'loc' ? fileFor(media.collection, media.number) : String(link).trim();
  if (media.type === 'loc' && !await fileExists(url)) throw new Error(NOT_FOUND);
  const film = registryFilm('', url);
  return { title: film ? film.title : MediaSources.nameFromLink(url), thumbnail: film ? film.thumbnail : '', duration: 0, link: url };
}

/** A loc.gov/free-to-use/<name>/ page as a list for Lists and the playlist settings, or null. */
function listSource(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'loc.gov' && parts[0] === 'free-to-use' && parts.length === 2 && /^[a-z0-9-]{1,120}$/.test(parts[1])) {
    return { kind: 'loc', url: `https://www.loc.gov/free-to-use/${parts[1]}/`, name: 'Library of Congress' };
  }
  return null;
}

/**
 * A free-to-use page's gallery: {title, items: [{id, title, thumbnail}]}, from its JSON (?fo=json).
 * The National Film Registry's page is known here, so it isn't fetched.
 */
function freeToUsePage(page) {
  if (page === REGISTRY_PAGE) return Promise.resolve({ title: REGISTRY_TITLE, items: REGISTRY });
  return cache.remember(`ftu:${page}`, TTL_MS, async () => {
    let data;
    try {
      data = await (await fetchOk(`${page}?fo=json`)).json();
    } catch (e) {
      throw new Error("loc.gov didn't let me read that page. Paste its films' video links (each film's Download menu, the MP4) into a list file instead.");
    }
    const items = [];
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (Array.isArray(node)) { node.forEach(n => visit(n, depth + 1)); return; }
      const m = typeof node.link === 'string' && /^(?:https?:\/\/(?:www\.)?loc\.gov)?\/item\/([A-Za-z0-9]{6,20})\/?$/.exec(node.link);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        const image = typeof node.image === 'string' ? node.image : '';
        items.push({
          id: m[1],
          title: clean(decodeEntities(node.title)),
          thumbnail: /^\/[^/]/.test(image) ? `https://www.loc.gov${image}` : (/^https:\/\//.test(image) ? image : '')
        });
      }
      Object.values(node).forEach(n => visit(n, depth + 1));
    };
    visit(data.content, 0);
    return { title: clean(decodeEntities(data.title), 120) || 'Library of Congress', items: items.slice(0, MAX_LIST) };
  });
}

/**
 * Loads a free-to-use page's films that have videos: {title, items}. Items that aren't films
 * (pictures), or films whose video can't be found, are left out.
 * @param {{url: string}} source - From listSource.
 */
async function loadList(source) {
  const page = await freeToUsePage(source.url);
  const results = new Array(page.items.length);
  let next = 0;
  const worker = async () => {
    while (next < page.items.length) {
      const i = next++;
      try {
        results[i] = await itemById(page.items[i].id);
      } catch (e) {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, page.items.length) }, worker));
  const items = results.map((item, i) => item && {
    ...item,
    title: page.items[i].title || item.title,
    thumbnail: page.items[i].thumbnail || item.thumbnail
  }).filter(Boolean);
  return { title: page.title, items };
}

module.exports = { resolveLink, listSource, loadList, fileFor, REGISTRY };
