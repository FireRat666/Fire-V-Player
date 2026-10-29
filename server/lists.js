/**
 * @fileoverview Playlists kept outside YouTube: a text file of links (one per line) at a direct
 * link, on Dropbox, in a Google Doc or on Google Drive, a shared Google Drive folder of videos, or
 * an archive.org item. Also YouTube playlists, so every kind of list loads the same way.
 *
 * A list file can mix every source the player plays (YouTube videos and playlists, Twitch,
 * Vimeo, VDO.Ninja, HLS and MPEG-TS streams, video and audio files, Drive and Dropbox files,
 * archive.org items). Each list resolves to plain playlist items: { title, thumbnail, duration
 * (milliseconds), link }.
 * @module server/lists
 */

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { Readable } = require('stream');
const MediaSources = require('../public/media-sources.js');
const media = require('./media.js');
const streaming = require('./streaming.js');
const { getInnertube } = require('./youtube/youtubeiService.js');
const Scraper = require('./youtube/scraper.js');
const scraper = new Scraper();

/** The most links read from one list file (and the most items one list file gives). */
const MAX_ITEMS = 300;
/** The biggest list file read. */
const MAX_LIST_BYTES = 256 * 1024;
/** Links looked up at once while resolving a list file. */
const CONCURRENCY = 4;
/** How long a loaded list is kept: short, so an edited file shows on the next load. */
const LIST_TTL = 5 * 60 * 1000;
/** How long a YouTube video's title and length are kept. */
const VIDEO_TTL = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (compatible; Fire-V-Player)';

/** A small time-limited cache that also shares a lookup still running. */
class TtlCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  remember(key, ttl, fn) {
    const hit = this.map.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = Promise.resolve().then(fn);
    this.map.set(key, { value, expires: Date.now() + ttl });
    // A failed lookup isn't kept, so the next try asks again.
    value.catch(() => { if (this.map.get(key) && this.map.get(key).value === value) this.map.delete(key); });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }
}
const listCache = new TtlCache(100);
const videoCache = new TtlCache(3000);

/** An error whose message can be shown to the person who asked. */
class ListError extends Error {}

// ------------------------------------------------------------------ parsing

/**
 * One entry per line. Blank lines and `#` comments are skipped, except an m3u
 * `#EXTINF:<seconds>,<title>` line, which titles the link after it, and `#PLAYLIST:<title>`,
 * which names the list. Text next to a link on the same line ("https://... Opening night") is
 * its title too.
 *
 * @param {string} text - The list file's text.
 * @returns {{title: string, entries: {input: string, title?: string}[]}}
 */
function parseLinkList(text) {
  const entries = [];
  let title = '';
  let pendingTitle = '';
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const inf = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (inf) pendingTitle = inf[1].trim();
      const name = /^#PLAYLIST:(.*)$/i.exec(line);
      if (name && !title) title = name[1].trim();
      continue;
    }
    const tokens = line.split(/\s+/);
    const at = Math.max(0, tokens.findIndex(t => /^(https?|rtspt?):\/\//i.test(t)));
    const inline = tokens.filter((_, i) => i !== at).join(' ').replace(/^[\s\-–—|:,]+|[\s\-–—|:,]+$/g, '');
    const itemTitle = pendingTitle || inline;
    entries.push(itemTitle ? { input: tokens[at], title: itemTitle } : { input: tokens[at] });
    pendingTitle = '';
  }
  return { title, entries };
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Drive's embedded folder view (drive.google.com/embeddedfolderview?id=...): one `flip-entry`
 * per file, with the file's MIME type in its list icon's address.
 * @param {string} html
 * @returns {{title: string, files: {id: string, name: string, mimeType: string}[]}}
 */
function parseDriveFolderPage(html) {
  const title = decodeEntities((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '').trim();
  const files = [];
  for (const part of String(html || '').split('<div class="flip-entry" id="entry-').slice(1)) {
    const id = part.slice(0, part.indexOf('"'));
    const name = decodeEntities((/<div class="flip-entry-title">([^<]*)</.exec(part) || [])[1] || '').trim();
    const mimeType = (/\/type\/([a-z]+\/[a-z0-9.+-]+)"/i.exec(part) || [])[1] || (/aria-label="Folder"/.test(part) ? 'application/vnd.google-apps.folder' : '');
    if (id && name) files.push({ id, name, mimeType });
  }
  return { title, files };
}

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const stripExtension = (name) => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');

// ------------------------------------------------------------------ sources

/**
 * A YouTube playlist id from a link or a bare id, or null. Like app._getPlaylistId, but also
 * takes the other kinds of playlist id (OLAK5uy_ albums, UU uploads and so on), not mixes (RD),
 * which have no fixed list.
 * @param {string} input
 * @returns {string|null}
 */
function youtubePlaylistId(input) {
  const s = String(input || '').trim();
  if (/^(PL|OLAK5uy_|UU|FL|LL)[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  const u = MediaSources.parseUrl(s);
  if (!u || !MediaSources.detect(s) || MediaSources.detect(s).type !== 'youtube') return null;
  const list = u.searchParams.get('list') || '';
  return /^(PL|OLAK5uy_|UU|FL)[A-Za-z0-9_-]{10,}$/.test(list) ? list : null;
}

/** The 11-character id of a YouTube video link (or a bare id), or null. */
function youtubeVideoId(input) {
  return MediaSources.youtubeId(input) || null;
}

/**
 * What kind of list a link is, and where its text (or listing) is read from, or null when it
 * isn't a list (a YouTube link, a video or stream, or not a web link).
 *
 * @param {string} input
 * @returns {{kind: 'file'|'drivefolder'|'archive', url?: string, id?: string, name: string}|null}
 */
function listSource(input) {
  const s = String(input || '').trim();
  const u = MediaSources.parseUrl(s);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (MediaSources.detect(s) && MediaSources.detect(s).type === 'youtube') return null;
  // A Tubi category or series, or a NASA+ series.
  const site = streaming.listSource(u);
  if (site) return site;

  if (host === 'docs.google.com' && parts[0] === 'document' && parts[1] === 'd' && parts[2]) {
    return { kind: 'file', url: `https://docs.google.com/document/d/${encodeURIComponent(parts[2])}/export?format=txt`, name: 'Google Doc' };
  }
  if (host === 'drive.google.com') {
    const folder = parts.indexOf('folders');
    const folderId = folder >= 0 ? parts[folder + 1] : (parts[0] === 'embeddedfolderview' ? u.searchParams.get('id') : '');
    if (folderId && /^[A-Za-z0-9_-]{10,}$/.test(folderId)) return { kind: 'drivefolder', id: folderId, name: 'Google Drive folder' };
    // A text file kept on Drive (drive.google.com/file/d/<id>/view or open?id=<id>).
    const fileId = (parts[0] === 'file' && parts[1] === 'd') ? parts[2] : u.searchParams.get('id');
    if (fileId && /^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
      return { kind: 'file', url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`, name: 'Google Drive file' };
    }
    return null;
  }
  if (host === 'archive.org' && parts[0] === 'details' && parts[1]) {
    return { kind: 'archive', id: parts[1], name: parts[1] };
  }
  const fileName = () => {
    let name = parts[parts.length - 1] || u.hostname;
    try { name = decodeURIComponent(name); } catch (e) {}
    return stripExtension(name);
  };
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    // dl=1 gives the file itself instead of Dropbox's page about it.
    const url = new URL(u.href);
    if (host === 'dropbox.com') { url.searchParams.delete('raw'); url.searchParams.set('dl', '1'); }
    return { kind: 'file', url: url.href, name: fileName() };
  }
  // A video or stream link, not a list of them. (.m3u is a list; .m3u8 is an HLS stream.)
  if (MediaSources.detect(s)) return null;
  return { kind: 'file', url: u.href, name: fileName() };
}

/** Whether a playlist setting or import is a list this module loads (not a YouTube playlist). */
function isListSource(input) {
  return !!listSource(input);
}

// ------------------------------------------------------------------ fetching

/**
 * An IPv6 address as its 8 16-bit words (a dotted IPv4 tail is read as the last two), or null if
 * it isn't one.
 */
function ipv6Words(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!net.isIPv4(tail[2])) return null;
    const [a, b, c, d] = tail[2].split('.').map(Number);
    s = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...rest];
  if (parts.length !== 8 || parts.some(h => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return parts.map(h => parseInt(h, 16));
}

/**
 * Whether an address is private, loopback, link-local or otherwise not on the public internet.
 * An IPv6 address that carries an IPv4 one (mapped ::ffff:a.b.c.d, also written ::ffff:7f00:1;
 * the old ::a.b.c.d form; NAT64 64:ff9b::; 6to4 2002::) is judged by that IPv4 address.
 * Anything that can't be read is treated as private.
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const w = ipv6Words(ip);
  if (!w) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const firstFiveZero = w.slice(0, 5).every(x => x === 0);
  if (firstFiveZero && w[5] === 0xffff) return isPrivateAddress(v4(w[6], w[7])); // IPv4-mapped
  if (firstFiveZero && w[5] === 0) return (w[6] === 0 && w[7] <= 1) || isPrivateAddress(v4(w[6], w[7])); // ::, ::1, IPv4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) return isPrivateAddress(v4(w[6], w[7])); // NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true; // local-use NAT64
  if (w[0] === 0x2002) return isPrivateAddress(v4(w[1], w[2])); // 6to4
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo
  return (w[0] & 0xfe00) === 0xfc00 // unique local
    || (w[0] & 0xffc0) === 0xfe80 // link-local
    || (w[0] & 0xffc0) === 0xfec0 // site-local (deprecated)
    || (w[0] & 0xff00) === 0xff00; // multicast
}

/**
 * Refuses links that can't be public before any connection: not http(s), a local name, or an IP
 * address that is private. Names are checked when they're looked up for the connection itself
 * (publicLookup), so the address checked is the one connected to.
 */
function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new ListError('Only http and https links can be loaded.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new ListError('That link is not on the public internet.');
  if (net.isIP(host) && isPrivateAddress(host)) throw new ListError('That link is not on the public internet.');
}

/**
 * The DNS lookup for list fetches' connections: refuses a name if any of its addresses is private,
 * so a name can't pass a check and then resolve somewhere else for the connection.
 */
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(new ListError(`Could not find ${hostname}.`));
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
      return callback(new ListError('That link is not on the public internet.'));
    }
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** One request through publicLookup, as a fetch Response (redirects not followed). */
function requestPublic(url, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: publicLookup,
      signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/plain, */*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' }
    }, res => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        [].concat(value).forEach(v => headers.append(name, String(v)));
      }
      const status = res.statusCode || 0;
      if (status < 200 || status > 599 || [204, 205, 304].includes(status)) {
        res.resume();
        resolve(new Response(null, { status: status >= 200 && status <= 599 ? status : 502, headers }));
        return;
      }
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const unzip = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      const body = unzip ? res.pipe(unzip) : res;
      if (unzip) { res.on('error', e => unzip.destroy(e)); headers.delete('content-encoding'); headers.delete('content-length'); }
      resolve(new Response(Readable.toWeb(body), { status, headers }));
    });
    req.on('error', err => reject(err instanceof ListError ? err
      : err && err.name === 'AbortError' ? new ListError('That link took too long to answer.')
      : new ListError("Could not load that link.")));
    req.end();
  });
}

/** Fetches a public link, following up to 5 redirects and checking each one. */
async function fetchPublic(url) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; hop < 6; hop++) {
    assertPublicUrl(url);
    const res = await requestPublic(url, signal);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try { await res.body?.cancel(); } catch (e) {}
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    return res;
  }
  throw new ListError('That link redirects too many times.');
}

/** The name a download gives its file (Content-Disposition), without the extension. */
function dispositionName(res) {
  const cd = res.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  let name = '';
  if (star) { try { name = decodeURIComponent(star[1]); } catch (e) {} }
  if (!name) name = ((/filename\s*=\s*"([^"]*)"/.exec(cd) || /filename\s*=\s*([^;]+)/.exec(cd) || [])[1] || '').trim();
  return stripExtension(name);
}

/** A list file's text, refusing media, web pages and anything over MAX_LIST_BYTES. */
async function fetchListText(url) {
  const res = await fetchPublic(url);
  const cancel = async () => { try { await res.body?.cancel(); } catch (e) {} };
  if (!res.ok) {
    await cancel();
    if (res.status === 404) throw new ListError('List file not found.');
    if (res.status === 401 || res.status === 403) throw new ListError('That list file is not shared publicly.');
    throw new ListError(`The list file's site answered ${res.status}.`);
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  // An .m3u list is often sent as audio/x-mpegurl, so that one counts as text.
  if (/^(video|audio|image)\//.test(type) && !/mpegurl|scpls/.test(type)) {
    await cancel();
    throw new ListError('That link is a media file, not a list of links.');
  }
  if (Number(res.headers.get('content-length') || 0) > MAX_LIST_BYTES) {
    await cancel();
    throw new ListError('That list file is too big (256 KB at most).');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_LIST_BYTES) {
      try { await reader.cancel(); } catch (e) {}
      throw new ListError('That list file is too big (256 KB at most).');
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (/^\s*<(!doctype|html)/i.test(text)) throw new ListError('That link opens a web page, not a text file of links. Share it publicly, or use its direct or download link.');
  return { text, name: dispositionName(res) };
}

async function fetchJson(url) {
  const res = await fetchPublic(url);
  if (!res.ok) {
    try { await res.body?.cancel(); } catch (e) {}
    throw new ListError(`The site answered ${res.status}.`);
  }
  return res.json();
}

// ------------------------------------------------------------------ resolving

/** A YouTube video's title, length and picture, kept for a while. Throws if it can't play. */
function youtubeVideo(id) {
  return videoCache.remember(id, VIDEO_TTL, async () => {
    const v = await scraper.getVideoByUrl(`https://www.youtube.com/watch?v=${id}`);
    return { title: clean(v.title) || 'YouTube video', thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: Number(v.duration) || 0, link: `https://www.youtube.com/watch?v=${id}` };
  });
}

/** Reads a playlist item's text field from YouTube.js, which has several shapes. */
const ytText = (t) => (t == null ? '' : typeof t === 'string' ? t : typeof t.text === 'string' ? t.text : (typeof t.toString === 'function' && t.toString() !== '[object Object]' ? t.toString() : ''));

/**
 * One item of a YouTube.js playlist as a playlist item, or null.
 * (Moved from playlistHandler.fromPlaylist, which handled the same shapes.)
 */
function youtubePlaylistEntry(v) {
  const videoId = v.id || v.videoId || v.content_id;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  let title = v.title ? ytText(v.title) : (v.metadata && v.metadata.title ? ytText(v.metadata.title) : '');
  if (!title) title = 'Unknown Title';

  let durationMs = 0;
  let durationText = '';
  if (v.duration) {
    durationText = typeof v.duration.text === 'string' ? v.duration.text : (typeof v.duration === 'string' ? v.duration : '');
  } else if (v.content_image && Array.isArray(v.content_image.overlays)) {
    const bottomOverlay = v.content_image.overlays.find(o => o.type === 'ThumbnailBottomOverlayView');
    if (bottomOverlay && Array.isArray(bottomOverlay.badges) && bottomOverlay.badges.length > 0) {
      durationText = bottomOverlay.badges[0].text || '';
    }
  }
  if (durationText) {
    const parts = durationText.split(':').map(Number);
    if (parts.length === 2) durationMs = (parts[0] * 60 + parts[1]) * 1000;
    else if (parts.length === 3) durationMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  } else if (v.duration && typeof v.duration.seconds === 'number') {
    durationMs = v.duration.seconds * 1000;
  }
  if (!Number.isFinite(durationMs)) durationMs = 0;

  let thumbnail = '';
  if (Array.isArray(v.thumbnails) && v.thumbnails.length > 0) thumbnail = v.thumbnails[v.thumbnails.length - 1].url;
  else if (v.thumbnail && typeof v.thumbnail.url === 'string') thumbnail = v.thumbnail.url;
  else if (v.thumbnail && Array.isArray(v.thumbnail.thumbnails) && v.thumbnail.thumbnails.length > 0) thumbnail = v.thumbnail.thumbnails[v.thumbnail.thumbnails.length - 1].url;
  else if (v.content_image && Array.isArray(v.content_image.image) && v.content_image.image.length > 0) thumbnail = v.content_image.image[v.content_image.image.length - 1].url;
  else thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return { title: clean(title), thumbnail, duration: durationMs, link: `https://www.youtube.com/watch?v=${videoId}` };
}

/**
 * A YouTube playlist's title and up to `max` videos.
 * @param {string} playlistId
 * @param {number} max
 */
function youtubePlaylist(playlistId, max) {
  return listCache.remember(`yt:${max}:${playlistId}`, LIST_TTL, async () => {
    const yt = await getInnertube();
    let page;
    try {
      page = await yt.getPlaylist(playlistId);
    } catch (e) {
      throw new ListError('Could not load that YouTube playlist. It might be private or empty.');
    }
    const title = clean((page.info && ytText(page.info.title)) || '') || 'YouTube playlist';
    let videos = [...(page.items || [])];
    while (videos.length < max && page.has_continuation) {
      page = await page.getContinuation();
      if (!page.items || !page.items.length) break;
      videos = videos.concat(page.items);
    }
    const seen = new Set();
    const items = [];
    for (const v of videos) {
      const item = youtubePlaylistEntry(v);
      if (!item || seen.has(item.link)) continue;
      seen.add(item.link);
      items.push(item);
      if (items.length >= max) break;
    }
    if (!items.length) throw new ListError('That YouTube playlist has no videos that can be played.');
    return { title, items, truncated: videos.length > max };
  });
}

const ARCHIVE_EXT = /\.(mp4|m4v|webm|ogv|mp3|ogg|m4a|flac|wav|opus)$/i;

/** The video (or audio) files of an archive.org item, best format of each, at most `max`. */
function archiveItem(id, max) {
  return listCache.remember(`ia:${max}:${id}`, LIST_TTL, async () => {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new ListError('That is not an archive.org item.');
    const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    const files = Array.isArray(meta && meta.files) ? meta.files : [];
    const playable = files.filter(f => f && typeof f.name === 'string' && ARCHIVE_EXT.test(f.name) && !/\/?__ia_thumb|\.ia\.mp4$/i.test(f.name));
    // An item often has each video several times (the upload plus .mp4 / .ogv copies made from
    // it), so keep one file per video: an .mp4 when there is one, else a .webm, then anything.
    const rank = (n) => (/\.mp4$/i.test(n) ? 0 : /\.webm$/i.test(n) ? 1 : /\.(m4v|ogv)$/i.test(n) ? 2 : 3);
    const byVideo = new Map();
    for (const f of playable) {
      const key = String(f.original || f.name).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/(_512kb|\.ia)$/i, '');
      const had = byVideo.get(key);
      if (!had || rank(f.name) < rank(had.name)) byVideo.set(key, f);
    }
    const chosen = [...byVideo.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    if (!chosen.length) throw new ListError('That archive.org item has no video or audio files.');
    const itemTitle = clean((meta.metadata && [].concat(meta.metadata.title)[0]) || id);
    const items = chosen.slice(0, max).map(f => ({
      title: clean(chosen.length === 1 ? itemTitle : (f.title || stripExtension(f.name.split('/').pop()))) || itemTitle,
      thumbnail: `https://archive.org/services/img/${encodeURIComponent(id)}`,
      // Seconds ("370.3"), or sometimes "m:ss" / "h:mm:ss".
      duration: Math.round(String(f.length || '').split(':').reduce((acc, n) => acc * 60 + Number(n), 0) * 1000) || 0,
      link: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`
    }));
    return { title: itemTitle, items, truncated: chosen.length > max };
  });
}

/** The videos directly inside a shared Google Drive folder, sorted by name. */
async function driveFolder(id, max) {
  const res = await fetchPublic(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`);
  const html = await res.text();
  if (res.status === 404) throw new ListError('Drive folder not found, or not shared with anyone who has the link.');
  if (!res.ok) throw new ListError(`Google Drive answered ${res.status}.`);
  const listing = parseDriveFolderPage(html);
  const videos = listing.files
    .filter(f => /^(video|audio)\//i.test(f.mimeType))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (!videos.length) throw new ListError('That Drive folder has no videos in it (or is not shared publicly).');
  const items = [];
  for (const f of videos.slice(0, max)) {
    const link = `https://drive.google.com/file/d/${f.id}/view`;
    const m = MediaSources.detect(link);
    items.push({ title: clean(stripExtension(f.name)) || 'Google Drive video', thumbnail: '', duration: 0, link: (m && m.url) || link });
  }
  return { title: clean(listing.title) || 'Google Drive folder', items, truncated: videos.length > max };
}

/** One line of a list file as zero or more playlist items. Lines that can't play are dropped. */
async function resolveEntry(entry, limit) {
  const input = entry.input;
  if (!input || input.length > 2048) return [];
  const titled = (item) => (entry.title ? { ...item, title: clean(entry.title) || item.title } : item);
  const playlistId = youtubePlaylistId(input);
  const videoId = youtubeVideoId(input);
  if (playlistId && !videoId) return (await youtubePlaylist(playlistId, limit)).items;
  if (videoId) {
    try {
      return [titled(await youtubeVideo(videoId))];
    } catch (e) {
      return []; // private, removed or not found
    }
  }
  const source = listSource(input);
  if (source && source.kind === 'streaming') return (await streaming.loadList(source)).items.slice(0, limit);
  if (source && source.kind === 'archive') {
    const item = await archiveItem(source.id, limit);
    return item.items.length === 1 ? [titled(item.items[0])] : item.items;
  }
  if (!MediaSources.detect(input)) return []; // a list inside a list, a web page, or nonsense
  const item = await media.resolveMediaLink(input);
  return item ? [titled({ title: clean(item.title), thumbnail: item.thumbnail || '', duration: Number(item.duration) || 0, link: item.link })] : [];
}

async function resolveEntries(entries, limit) {
  const results = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      try {
        results[i] = await resolveEntry(entries[i], limit);
      } catch (e) {
        results[i] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  // The same video twice is skipped, as the playlist refuses duplicates anyway.
  const seen = new Set();
  const items = [];
  for (const item of results.flat()) {
    const key = youtubeVideoId(item.link) || item.link;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return { items: items.slice(0, limit), truncated: items.length > limit, dropped: entries.length - results.filter(r => r && r.length).length };
}

/**
 * Loads a list (not a YouTube playlist: see youtubePlaylist) as playlist items.
 *
 * @param {string} src - A list file link, Google Doc, Drive folder or archive.org item.
 * @param {number} [limit] - The most items to return.
 * @returns {Promise<{title: string, items: Object[], truncated: boolean, dropped: number}>}
 */
function loadList(src, limit = MAX_ITEMS) {
  const source = listSource(src);
  if (!source) return Promise.reject(new ListError('That link is not a playlist, a list file of links, a Google Doc, a Drive folder or an archive.org item.'));
  limit = Math.max(1, Math.min(MAX_ITEMS, limit));
  return listCache.remember(`list:${limit}:${src}`, LIST_TTL, async () => {
    if (source.kind === 'drivefolder') return { dropped: 0, ...(await driveFolder(source.id, limit)) };
    if (source.kind === 'archive') return { dropped: 0, ...(await archiveItem(source.id, limit)) };
    if (source.kind === 'streaming') {
      const list = await streaming.loadList(source);
      if (!list.items.length) throw new ListError('That list has nothing in it that can play here.');
      return { title: list.title, items: list.items.slice(0, limit), truncated: list.items.length > limit, dropped: 0 };
    }
    const { text, name } = await fetchListText(source.url);
    const parsed = parseLinkList(text);
    const entries = parsed.entries.slice(0, MAX_ITEMS);
    if (!entries.length) throw new ListError('That file has no links in it.');
    const { items, truncated, dropped } = await resolveEntries(entries, limit);
    if (!items.length) throw new ListError('None of the links in that file can be played.');
    return { title: clean(parsed.title || name || source.name, 120) || 'Playlist', items, truncated: truncated || parsed.entries.length > MAX_ITEMS, dropped };
  });
}

/**
 * Loads any playlist the player takes: a YouTube playlist (id or link) or a list (see loadList).
 *
 * @param {string} src
 * @param {number} [youtubeMax] - The most videos taken from a YouTube playlist.
 */
function loadAny(src, youtubeMax = 500) {
  const s = String(src || '').trim();
  const playlistId = youtubePlaylistId(s);
  if (playlistId) return youtubePlaylist(playlistId, youtubeMax);
  if (isSingleLink(s)) return loadSingle(s);
  return loadList(s);
}

/**
 * Whether this is one video or stream link (a YouTube video, a Twitch channel, a .m3u8 or VRCDN
 * stream...), not a playlist or a list. The playlists setting can hold these as examples: each
 * loads as a list of just that video.
 */
function isSingleLink(src) {
  const s = String(src || '').trim();
  if (!MediaSources.parseUrl(s) || youtubePlaylistId(s) || isListSource(s)) return false;
  return !!youtubeVideoId(s) || !!MediaSources.detect(s);
}

/** A single video or stream link as a list of one. */
function loadSingle(src, limit = MAX_ITEMS) {
  return listCache.remember(`single:${src}`, LIST_TTL, async () => {
    const { items } = await resolveEntries([{ input: src }], limit);
    if (!items.length) throw new ListError("That video or stream can't be found or played.");
    return { title: clean(items.length === 1 ? items[0].title : src, 120) || 'Video', items, truncated: false, dropped: 0 };
  });
}

/** Whether the player can load this as a playlist (a YouTube playlist, a list, or one video). */
function isPlaylistSource(src) {
  return !!youtubePlaylistId(src) || isListSource(src) || isSingleLink(src);
}

/** A message for an error from loading a list: its own, or a general one. */
function errorMessage(err) {
  return err instanceof ListError ? err.message : 'Could not load that playlist.';
}

module.exports = {
  parseLinkList,
  parseDriveFolderPage,
  listSource,
  isListSource,
  isPlaylistSource,
  isSingleLink,
  youtubePlaylistId,
  youtubePlaylist,
  loadList,
  loadAny,
  errorMessage,
  isPrivateAddress,
  ListError,
  MAX_ITEMS
};
