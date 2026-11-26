/**
 * @fileoverview Internet radio: Shoutcast's station directory (its search and its stations'
 * tune-in links), radio playlist files (.pls, .m3u, .xspf) and the streams they name.
 *
 * A station in the playlist keeps the link it was added by (a Shoutcast tune-in link, or the
 * playlist file's), as a station's stream address can change. The player asks for the stream
 * when it plays (/api/stream, as for Tubi). Most stations stream over plain http, which a player
 * page served over https can't load, so a station plays from its https address when it answers
 * there. One that doesn't can't play, unless the server's host turns on the relay through this
 * server (/api/radio) with RADIO_RELAY=on: it's off unless that is set, as it uses the server's
 * data transfer. Only the server's own settings can turn it on; nothing in a world or panel can.
 * It only ever sends sound (it refuses any other type).
 *
 * Only addresses on the public internet are read or relayed (see lists.fetchPublic).
 * @module server/radio
 */

const { Readable } = require('stream');
const { TtlCache } = require('./cache.js');
const MediaSources = require('../public/media-sources.js');

const SHOUTCAST = 'https://directory.shoutcast.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
/**
 * The relay's name to stations. A Shoutcast server sends its HTML status page, not the stream, to
 * anything that says it's a browser ("Mozilla"), at its root address.
 */
const RELAY_UA = 'FireVPlayer/1.0 (radio relay)';
const TIMEOUT_MS = 10000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
/** A station's stream addresses, and whether its stream answers over https. */
const STATION_TTL_MS = 10 * 60 * 1000;
const HTTPS_TTL_MS = 60 * 60 * 1000;
const MAX_RESULTS = 40;
/** The biggest radio playlist file read. Real ones are a few hundred bytes. */
const MAX_PLAYLIST_BYTES = 64 * 1024;
/** Relayed streams at once, in all and per address, and the longest one relay lasts. */
const MAX_RELAYS = Number(process.env.RADIO_RELAY_MAX) > 0 ? Number(process.env.RADIO_RELAY_MAX) : 40;
const MAX_RELAYS_PER_IP = 3;
const MAX_RELAY_MS = 8 * 60 * 60 * 1000;
/** What a stream may be sent as: sound, or a type that some servers send sound as. */
const AUDIO_TYPE = /^(audio\/|application\/ogg|video\/mp2t|application\/octet-stream)/i;
/** A playlist's types, which are sent as audio/... too. */
const PLAYLIST_TYPE = /mpegurl|scpls|xspf|x-pls/i;

const cache = new TtlCache({ maxEntries: 500 });
const relays = { total: 0, byIp: new Map() };

// lists.js needs media.js, which needs this module, so it's read when first used.
const lists = () => require('./lists.js');

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeEntities = s => String(s || '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Whether the relay is on: only when the server's RADIO_RELAY setting is on (off by default). */
function relayOn() {
  return /^(on|true|1|yes)$/i.test(String(process.env.RADIO_RELAY || '').trim());
}

/** A Shoutcast station's tune-in link, the link a station is kept by. */
function stationLink(id) {
  return `${SHOUTCAST}/sbin/tunein-station.m3u?id=${id}`;
}

// ------------------------------------------------------------------ playlist files

/**
 * The streams in a radio playlist file: PLS ([playlist], File1=...), XSPF (XML, <location>) or
 * M3U (one address per line, #EXTINF titles).
 * @param {string} text
 * @returns {{title: string, streams: {url: string, title: string}[], format: 'pls'|'xspf'|'m3u'}}
 */
function parsePlaylist(text) {
  const body = String(text || '').replace(/^﻿/, '');
  const isUrl = s => /^https?:\/\/\S+$/i.test(s);
  if (/^\s*<\?xml|<playlist[\s>]/i.test(body) && /<location>/i.test(body)) {
    const streams = [];
    for (const m of body.matchAll(/<track>([\s\S]*?)<\/track>/gi)) {
      const url = decodeEntities(((/<location>([\s\S]*?)<\/location>/i.exec(m[1]) || [])[1] || '').trim());
      const title = decodeEntities(((/<title>([\s\S]*?)<\/title>/i.exec(m[1]) || [])[1] || '').trim());
      if (isUrl(url)) streams.push({ url, title: clean(title) });
    }
    // The playlist's own title is the first one outside its tracks.
    const outside = body.replace(/<trackList>[\s\S]*<\/trackList>/i, '');
    const title = decodeEntities(((/<title>([\s\S]*?)<\/title>/i.exec(outside) || [])[1] || '').trim());
    return { title: clean(title) || (streams[0] && streams[0].title) || '', streams, format: 'xspf' };
  }
  if (/^\s*\[playlist\]/i.test(body)) {
    const files = {};
    const titles = {};
    for (const raw of body.split(/\r?\n/)) {
      const m = /^\s*(File|Title)(\d+)\s*=\s*(.*?)\s*$/i.exec(raw);
      if (!m) continue;
      (m[1].toLowerCase() === 'file' ? files : titles)[m[2]] = m[3];
    }
    const streams = Object.keys(files).sort((a, b) => a - b).filter(n => isUrl(files[n]))
      .map(n => ({ url: files[n], title: clean(titles[n]) }));
    return { title: (streams[0] && streams[0].title) || '', streams, format: 'pls' };
  }
  const streams = [];
  let pending = '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const inf = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (inf) pending = inf[1].trim();
      continue;
    }
    if (isUrl(line)) streams.push({ url: line, title: clean(pending) });
    pending = '';
  }
  return { title: (streams[0] && streams[0].title) || '', streams, format: 'm3u' };
}

/**
 * Whether a list file's text (and the type it was sent as) is a radio station rather than a list
 * of videos: a PLS or XSPF file, or an M3U whose addresses aren't ones the player knows (a
 * station's stream has no file name, like http://host:8000/).
 */
function looksLikeRadio(text, type) {
  const parsed = parsePlaylist(text);
  if (!parsed.streams.length) return false;
  if (parsed.format !== 'm3u') return true;
  if (parsed.streams.some(s => MediaSources.detect(s.url) && MediaSources.detect(s.url).type !== 'radio')) return false;
  return /mpegurl|scpls/i.test(type || '') || parsed.streams.length <= 10;
}

/**
 * What an address gives: a playlist file's streams, or the stream itself when it's sound.
 * @returns {Promise<{title: string, streams: string[]}>}
 */
async function readStation(url) {
  const res = await lists().fetchPublic(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const cancel = async () => { try { await res.body?.cancel(); } catch (e) {} };
  if (!res.ok) {
    await cancel();
    throw new Error(res.status === 404 ? "That station doesn't exist (any more)." : `The station's site answered ${res.status}.`);
  }
  if (AUDIO_TYPE.test(type) && !PLAYLIST_TYPE.test(type)) {
    // The stream itself: its name comes from its icy-name header.
    await cancel();
    return { title: clean(res.headers.get('icy-name'), 120), streams: [url] };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PLAYLIST_BYTES) {
      try { await reader.cancel(); } catch (e) {}
      throw new Error("That isn't a radio station's playlist (it's too big).");
    }
    chunks.push(value);
  }
  // Shoutcast's .pls and .m3u say they are ISO-8859-1; the others are UTF-8 in practice.
  const latin = /charset=iso-8859-1/i.test(type) && !/xspf/i.test(type);
  const text = Buffer.concat(chunks).toString(latin ? 'latin1' : 'utf8');
  const parsed = parsePlaylist(text);
  if (!parsed.streams.length) throw new Error("That link has no radio stream in it.");
  return { title: parsed.title, streams: parsed.streams.map(s => s.url).slice(0, 10) };
}

/** A radio link's address to read: the link without its #radio mark. */
function fetchAddress(link, media) {
  if (media.site === 'shoutcast') return `${SHOUTCAST}/sbin/tunein-station.xspf?id=${media.id}`; // its title is UTF-8
  const u = new URL(link);
  u.hash = '';
  return u.href;
}

/** A radio link's station: its name and stream addresses, kept for a few minutes. */
function station(link) {
  const media = MediaSources.detect(link);
  if (!media || media.type !== 'radio') return Promise.reject(new Error("That isn't a radio station's link."));
  const key = media.site === 'shoutcast' ? `shoutcast:${media.id}` : `link:${fetchAddress(link, media)}`;
  return cache.remember(`station:${key}`, STATION_TTL_MS, async () => {
    try {
      return await readStation(fetchAddress(link, media));
    } catch (e) {
      console.warn(`[RADIO] ${key}: ${e.message}`);
      throw new Error(e instanceof lists().ListError || /station|radio|answered/.test(e.message) ? e.message : "Couldn't reach that radio station. Try again in a moment.");
    }
  });
}

/** Shoutcast's titles start with its rank, "(#1 - 32959/35000) ", in its .m3u and .pls. */
const stationTitle = t => clean(String(t || '').replace(/^\(#\d+\s*-\s*\d+\/\d+\)\s*/, ''), 120);

/**
 * A radio link as a playlist item (a Shoutcast tune-in link of any of its three kinds is kept as
 * its .m3u one), or null when it isn't one.
 */
async function resolveLink(link) {
  const media = MediaSources.detect(link);
  if (!media || media.type !== 'radio') return null;
  const s = await station(link);
  const keep = media.site === 'shoutcast' ? stationLink(media.id) : String(link).trim();
  return { title: `${stationTitle(s.title) || MediaSources.nameFromLink(keep)} (radio)`, thumbnail: '', duration: 0, link: keep };
}

/**
 * Whether a link (one the player doesn't know) is a radio station or stream, found from what it
 * sends: a radio playlist, or sound. The playlist item's link gets a #radio mark, so the player
 * knows it from then on.
 * @returns {Promise<Object|null>} A playlist item, or null.
 */
async function sniff(link) {
  const u = MediaSources.parseUrl(link);
  if (!u || MediaSources.detect(link)) return null;
  u.hash = 'radio';
  try {
    // A list of videos (an .m3u of video links) isn't a station.
    const s = await station(u.href);
    if (s.streams.some(url => MediaSources.detect(url) && MediaSources.detect(url).type !== 'radio')) return null;
    return await resolveLink(u.href);
  } catch (e) {
    return null;
  }
}

/** Whether a stream answers at `url` with sound, to a browser. */
async function answersWithSound(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await lists().fetchPublic(url, { signal: controller.signal, headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' } });
    clearTimeout(timer);
    const ok = res.ok && AUDIO_TYPE.test(res.headers.get('content-type') || '');
    controller.abort();
    try { await res.body?.cancel(); } catch (e) {}
    return ok;
  } catch (e) {
    return false;
  }
}

/**
 * The https address a browser can play a stream at, if the station answers over https, or ''. A
 * Shoutcast server's root address gives a browser its status page, but "/;" gives the stream.
 */
function httpsVersion(url) {
  return cache.remember(`https:${url}`, HTTPS_TTL_MS, async () => {
    const u = new URL(url);
    u.protocol = 'https:';
    if (u.port === '80') u.port = '';
    const tries = [u.href];
    if (u.pathname === '/' && !u.search) tries.push(`${u.origin}/;`);
    for (const t of tries) if (await answersWithSound(t)) return t;
    return '';
  });
}

/**
 * The stream to play for a radio link: the station's own https address, or the relay's.
 * @param {string} link
 * @returns {Promise<{url: string, live: true, audio: true}>}
 */
async function streamFor(link) {
  const s = await station(link);
  for (const url of s.streams.slice(0, 3)) {
    const https = await httpsVersion(url);
    if (https) return { url: https, live: true, audio: true };
  }
  if (!relayOn()) throw new Error("This station only streams over http, which can't play here (only https streams can). Try another station.");
  return { url: `/api/radio?link=${encodeURIComponent(link)}`, live: true, audio: true };
}

/**
 * Sends a station's stream on to the player page (GET /api/radio?link=<radio link>). Only a
 * radio link that `allowed(link)` says yes to (one in a room's playlist) is taken, and its stream
 * comes from the station's own playlist, so this relays those stations only, not any address.
 */
async function relay(req, res, allowed) {
  const link = String(req.query.link || '').slice(0, 1000);
  const ip = String(req.ip || '');
  if (!relayOn()) { res.status(403).json({ error: 'The radio relay is turned off on this server.' }); return; }
  if (!allowed(link)) { res.status(403).json({ error: 'Only stations in a playlist here are relayed.' }); return; }
  if (relays.total >= MAX_RELAYS || (relays.byIp.get(ip) || 0) >= MAX_RELAYS_PER_IP) {
    res.status(429).json({ error: 'Too many radio streams at once. Try again in a moment.' });
    return;
  }
  let s;
  try {
    s = await station(link);
  } catch (e) {
    res.status(422).json({ error: e.message });
    return;
  }
  relays.total++;
  relays.byIp.set(ip, (relays.byIp.get(ip) || 0) + 1);
  const controller = new AbortController();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    controller.abort();
    clearTimeout(firstByte);
    clearTimeout(longest);
    relays.total--;
    const n = (relays.byIp.get(ip) || 1) - 1;
    if (n > 0) relays.byIp.set(ip, n); else relays.byIp.delete(ip);
  };
  const firstByte = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const longest = setTimeout(release, MAX_RELAY_MS);
  req.on('close', release);
  let lastError = 'The station sent no sound.';
  for (const url of s.streams.slice(0, 3)) {
    if (released) return;
    try {
      const upstream = await lists().fetchPublic(url, { signal: controller.signal, headers: { 'User-Agent': RELAY_UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' } });
      const type = String(upstream.headers.get('content-type') || '');
      if (!upstream.ok || !AUDIO_TYPE.test(type) || PLAYLIST_TYPE.test(type)) {
        lastError = upstream.ok ? "The station's stream isn't sound." : `The station answered ${upstream.status}.`;
        try { await upstream.body?.cancel(); } catch (e) {}
        continue;
      }
      clearTimeout(firstByte);
      // AAC+ is sent as audio/aacp, which browsers don't all take: it's AAC to them.
      const sent = type.split(';')[0].trim().replace(/^audio\/aacp$/i, 'audio/aac');
      res.status(200).set({ 'Content-Type': sent, 'Cache-Control': 'no-store' });
      const body = Readable.fromWeb(upstream.body);
      body.on('error', () => { release(); res.destroy(); });
      body.on('end', () => { release(); res.end(); });
      body.pipe(res);
      return;
    } catch (e) {
      lastError = e && e.name === 'AbortError' ? "The station didn't answer." : (e && e.message) || "Couldn't reach the station.";
    }
  }
  release();
  if (!res.headersSent) res.status(502).json({ error: lastError });
}

// ------------------------------------------------------------------ Shoutcast

/** A station from Shoutcast's search as a search result. */
function shoutcastItem(st) {
  const bits = [clean(st.Genre, 40), st.Bitrate ? `${st.Bitrate} kbps` : '', st.Listeners ? `${st.Listeners} listening` : ''].filter(Boolean);
  return {
    id: String(st.ID),
    title: `${clean(st.Name, 120) || 'Radio station'} (radio)`,
    thumbnail: '',
    duration: 0,
    link: stationLink(st.ID),
    channel: { name: bits.length ? `Shoutcast: ${bits.join(', ')}` : 'Shoutcast', link: '' },
    description: clean(st.CurrentTrack, 200),
    source: 'shoutcast'
  };
}

/** Searches Shoutcast's directory (station names, genres and what they're playing). */
function searchShoutcast(term) {
  const q = clean(term, 100);
  if (!q) return Promise.resolve([]);
  return cache.remember(`search:${q.toLowerCase()}`, SEARCH_TTL_MS, async () => {
    const res = await fetch(`${SHOUTCAST}/Search/UpdateSearch`, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      body: new URLSearchParams({ query: q }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    return (Array.isArray(list) ? list : [])
      .filter(st => st && /^\d{1,12}$/.test(String(st.ID)))
      .slice(0, MAX_RESULTS).map(shoutcastItem);
  });
}

module.exports = { parsePlaylist, looksLikeRadio, resolveLink, sniff, streamFor, relay, searchShoutcast, stationLink };
