/**
 * @fileoverview Internet radio: Shoutcast's station directory (its search and its stations'
 * tune-in links), Radio Browser's, SomaFM's and internet-radio.com's (its search and its station
 * pages), radio playlist files (.pls, .m3u, .xspf) and the streams they name.
 *
 * A station in the playlist keeps the link it was added by (a Shoutcast tune-in link, or the
 * playlist file's), as a station's stream address can change. The player asks for the stream
 * when it plays (/api/stream, as for Tubi). Most stations stream over plain http, which a player
 * page served over https can't load, so a station plays from its https address when it answers
 * there. One that doesn't can't play, unless the server's host turns on the relay through this
 * server (/api/radio) with RADIO_RELAY=on: it's off unless that is set, as it uses the server's
 * data transfer. Only the server's own settings can turn it on; nothing in a world or panel can.
 * It only passes on audio types, and the MPEG-TS and generic binary types some stations send
 * sound as (which could hold a picture too: what's in them isn't checked).
 *
 * Only addresses on the public internet are read or relayed (see lists.fetchPublic).
 * @module server/radio
 */

const { Readable } = require('stream');
const httpsLib = require('https');
const { TtlCache } = require('./cache.js');
const MediaSources = require('../public/media-sources.js');
/** Sound files, which a station's list may give as its stream. */
const AUDIO_FILE = /\.(mp3|m4a|aac|wav|flac|opus|ogg|oga)$/i;

const SHOUTCAST = 'https://directory.shoutcast.com';
const INTERNET_RADIO = 'https://www.internet-radio.com';
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
/** How long a stream that sent no sound is taken at its word before it's asked again. */
const RETRY_TTL_MS = 60 * 1000;
const MAX_RESULTS = 40;
/** The biggest radio playlist file read. Real ones are a few hundred bytes. */
const MAX_PLAYLIST_BYTES = 64 * 1024;
/** Relayed streams at once, in all and per address, and the longest one relay lasts. */
const MAX_RELAYS = Number(process.env.RADIO_RELAY_MAX) > 0 ? Number(process.env.RADIO_RELAY_MAX) : 40;
const MAX_RELAYS_PER_IP = 3;
const MAX_RELAY_MS = 8 * 60 * 60 * 1000;
/** The longest one of a station's streams gets to send its first sound to the relay. */
const ATTEMPT_MS = 6000;
/** What a stream may be sent as: sound, or a type that some servers send sound as. */
const AUDIO_TYPE = /^(audio\/|application\/ogg|video\/mp2t|application\/octet-stream)/i;
/** A playlist's types, which are sent as audio/... too. */
const PLAYLIST_TYPE = /mpegurl|scpls|xspf|x-pls/i;
/** HLS's types (an .m3u8), which an HLS station's stream is sent as. */
const HLS_TYPE = /^(application|audio)\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/i;
/** What answersWithSound gives for an HLS stream (it plays with hls.js, not as sound). */
const HLS = 'application/vnd.apple.mpegurl';

const cache = new TtlCache({ maxEntries: 500 });
const relays = { total: 0, byIp: new Map() };

// lists.js needs media.js, which needs this module, so it's read when first used.
const lists = () => require('./lists.js');

const clean = (s, max = 200) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeEntities = s => String(s || '')
  .replace(/&#(\d+);/g, (m, n) => (Number(n) > 0 && Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => (parseInt(n, 16) > 0 && parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : m))
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
  // Video links make it a list of videos; a station's own addresses, radio links and sound files
  // (a live .mp3 stream, often given twice) don't (see isStationStream).
  if (!parsed.streams.every(s => isStationStream(s.url))) return false;
  return /mpegurl|scpls/i.test(type || '') || parsed.streams.length <= 10;
}

/**
 * What an address gives: a playlist file's streams, or the stream itself when it's sound.
 * @returns {Promise<{title: string, streams: string[]}>}
 */
async function readStation(url, asPlayer) {
  // A Shoutcast server sends a browser its status page at its root address, so an address with no
  // playlist on it is asked again as a player (RELAY_UA), which gets the stream.
  const res = await lists().fetchPublic(url, { headers: { 'User-Agent': asPlayer ? RELAY_UA : UA, 'Accept': '*/*' } });
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const cancel = async () => { try { await res.body?.cancel(); } catch (e) {} };
  if (!res.ok) {
    await cancel();
    throw new Error(res.status === 404 ? "That station doesn't exist (any more)." : `The station's site answered ${res.status}.`);
  }
  const stream = async () => {
    // The stream itself: its name comes from its icy-name header.
    await cancel();
    return { title: clean(res.headers.get('icy-name'), 120), streams: [url] };
  };
  const sound = AUDIO_TYPE.test(type) && !PLAYLIST_TYPE.test(type);
  // A generic type (application/octet-stream) is sent for playlist files too: its first bytes say
  // which it is. Any other sound type is the stream (its body is cancelled before it's locked).
  if (sound && !/^application\/octet-stream/i.test(type)) return stream();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  if (sound) {
    // The start may come split over chunks ("[" then "playlist]"), so 512 bytes (or the whole
    // body, if shorter) are read before deciding.
    let done = false;
    while (total < 512 && !done) {
      const next = await reader.read();
      done = next.done;
      if (next.value) { chunks.push(next.value); total += next.value.length; }
    }
    const head = Buffer.concat(chunks).toString('latin1', 0, 512).replace(/^\ufeff|^\xef\xbb\xbf/, '').trimStart();
    if (!/^(\[playlist\]|#EXTM3U|<\?xml|<playlist[\s>]|https?:\/\/)/i.test(head)) {
      try { await reader.cancel(); } catch (e) {}
      return { title: clean(res.headers.get('icy-name'), 120), streams: [url] };
    }
    if (done) return finish();
  }
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
  return finish();
  function finish() {
    // Shoutcast's .pls and .m3u say they are ISO-8859-1; the others are UTF-8 in practice.
    const latin = /charset=iso-8859-1/i.test(type) && !/xspf/i.test(type);
    const text = Buffer.concat(chunks).toString(latin ? 'latin1' : 'utf8');
    const parsed = parsePlaylist(text);
    if (!parsed.streams.length) {
      if (!asPlayer && /text\/html/i.test(type)) return readStation(url, true);
      throw new Error("That link has no radio stream in it.");
    }
    return { title: parsed.title, streams: parsed.streams.map(s => s.url).slice(0, 10) };
  }
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
  const key = media.site ? `${media.site}:${media.id}` : `link:${fetchAddress(link, media)}`;
  return cache.remember(`station:${key}`, STATION_TTL_MS, async () => {
    try {
      if (media.site === 'radiobrowser') return await radioBrowserStation(media.id);
      if (media.site === 'internetradio' && media.listed) return await readStation(media.id);
      if (media.site === 'internetradio') return await internetRadioStation(media.id);
      if (media.site === 'somafm') {
        const s = await readStation(`https://api.somafm.com/${media.id}.pls`);
        // "SomaFM: Groove Salad (#1): A nicely chilled plate of..." is each stream's title.
        return { title: s.title.replace(/\s*\(#\d+\).*$/, ''), streams: s.streams };
      }
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
  const keep = media.site === 'shoutcast' ? stationLink(media.id)
    : media.site === 'radiobrowser' ? `https://www.radio-browser.info/history/${media.id}`
      : media.site === 'somafm' ? `https://somafm.com/${media.id}/`
        : media.site === 'internetradio' ? (media.listed ? `${media.id}#internet-radio` : internetRadioLink(media.id)) : String(link).trim();
  return { title: `${stationTitle(s.title) || MediaSources.nameFromLink(keep)} (radio)`, thumbnail: '', duration: 0, link: keep };
}

/**
 * Whether a link (one the player doesn't know) is a radio station or stream, found from what it
 * sends: a radio playlist, or sound. The playlist item's link gets a #radio mark, so the player
 * knows it from then on.
 * @returns {Promise<Object|null>} A playlist item, or null.
 */
function isStationStream(url) {
  const m = MediaSources.detect(url);
  if (!m || m.type === 'radio') return true;
  const p = MediaSources.parseUrl(m.url || url);
  return m.type === 'file' && !!p && AUDIO_FILE.test(p.pathname);
}

async function sniff(link) {
  const u = MediaSources.parseUrl(link);
  if (!u || MediaSources.detect(link)) return null;
  u.hash = 'radio';
  try {
    // A list of videos (an .m3u of video links) isn't a station. Its streams may be the station's
    // own addresses (unknown links), radio links, or sound files (a live .mp3 stream). HLS (.m3u8)
    // and MPEG-TS (.ts) streams can carry video, and play as those links themselves, so a list of
    // them isn't one either.
    const s = await station(u.href);
    if (!s.streams.every(isStationStream)) return null;
    return await resolveLink(u.href);
  } catch (e) {
    return null;
  }
}

/**
 * The type a stream answers at `url` with, to a browser (or to `ua`, such as the relay's), when it's sound ('' when it answers with
 * something else), or HLS when it's an HLS stream (by its type and its first lines, whatever its
 * address: a station's may have no .m3u8). A PLS, XSPF or plain .m3u list isn't either. It throws
 * when the station can't be reached at all, which isn't kept.
 */
async function answersWithSound(url, ua = UA, httpsOnly = /^https:/i.test(url)) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // The https probe (for playing it directly) must stay on https: one redirected to http
    // couldn't play there either. The relay's may go where the relay would (see relayType).
    const res = await lists().fetchPublic(url, { signal: controller.signal, httpsOnly, headers: { 'User-Agent': ua, 'Accept': '*/*', 'Accept-Encoding': 'identity' } });
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // An .m3u8 address is read as one whatever its type (some servers send text/plain).
    if (res.ok && (HLS_TYPE.test(type) || /\.m3u8($|\?)/i.test(url))) {
      // An HLS playlist has #EXT-X- tags; a radio .m3u (the same types) doesn't.
      let head = '';
      try {
        const reader = res.body.getReader();
        while (head.length < 2048) {
          const { done, value } = await reader.read();
          if (done) break;
          head += Buffer.from(value).toString('latin1');
        }
        try { await reader.cancel(); } catch (e) {}
      } catch (e) {}
      controller.abort();
      return /^\s*#EXTM3U[\s\S]*#EXT-X-/.test(head) ? HLS : '';
    }
    controller.abort();
    try { await res.body?.cancel(); } catch (e) {}
    return res.ok && AUDIO_TYPE.test(type) && !PLAYLIST_TYPE.test(type) ? type : '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The https address a browser can play a stream at, and the type it's sent as, if the station
 * answers over https, or null. A Shoutcast server's root address gives a browser its status page,
 * but "/;" gives the stream. Only an answer is kept for HTTPS_TTL_MS: when the station couldn't be
 * reached over https at all, it's asked again next time.
 */
async function httpsVersion(url) {
  try {
    return await cache.remember(`https:${url}`, HTTPS_TTL_MS, async () => {
      const u = new URL(url);
      u.protocol = 'https:';
      if (u.port === '80') u.port = '';
      const tries = [u.href];
      if (u.pathname === '/' && !u.search) tries.push(`${u.origin}/;`);
      let unreachable = null;
      for (const t of tries) {
        try {
          const type = await answersWithSound(t);
          if (type) return { url: t, type };
        } catch (e) {
          unreachable = e;
        }
      }
      if (unreachable) throw unreachable; // not kept (see TtlCache.remember)
      return null;
    });
  } catch (e) {
    return null;
  }
}

/**
 * The stream to play for a radio link: the station's own https address, or the relay's.
 * @param {string} link
 * @returns {Promise<{url: string, live: true, audio?: true, type?: 'mpegts'}>} An MPEG-TS stream
 *   (video/mp2t) is played by mpegts.js (type 'mpegts'); sound by the browser itself (audio).
 */
async function streamFor(link) {
  const s = await station(link);
  for (const url of s.streams.slice(0, 3)) {
    // A station that streams HLS (some on Radio Browser) plays as an HLS stream, over https only:
    // one on http plays from its https address when it has one there, and not at all otherwise
    // (the relay passes on sound, not a playlist and its pieces).
    // An https one is checked first: it has to answer there, and not by sending the player to http.
    const m3u8 = /\.m3u8($|\?)/i.test(url);
    const https = await httpsVersion(url);
    if (m3u8 && /^https:/i.test(url)) {
      if (https) return { url: https.url, live: true };
      continue;
    }
    if (https && https.type === HLS) return { url: https.url, live: true };
    if (m3u8) continue;
    if (https) return /^video\/mp2t$/i.test(https.type) ? { url: https.url, live: true, type: 'mpegts' } : { url: https.url, live: true, audio: true };
  }
  if (!relayOn()) throw new Error("This station only streams over http, which can't play here (only https streams can). Try another station.");
  // The relay sends the stream as the station does: an MPEG-TS one is played by mpegts.js. The
  // player is told the kind of the first stream that answers with sound, and the relay sends only
  // streams of that kind, starting with that one (see relay).
  // Only sound the relay passes on (not an HLS playlist): with none, it can't play.
  let first = -1, type = '';
  for (let i = 0; i < Math.min(3, s.streams.length); i++) {
    const t = await relayType(s.streams[i]);
    if (t && t !== HLS && AUDIO_TYPE.test(t) && !PLAYLIST_TYPE.test(t)) { first = i; type = t; break; }
  }
  if (first < 0) throw new Error("This station's stream couldn't be reached as sound, so it can't play here. Try another station.");
  const ts = /^video\/mp2t$/i.test(type);
  const relayed = { url: `/api/radio?link=${encodeURIComponent(link)}&s=${first}&kind=${ts ? 'ts' : 'audio'}`, live: true };
  return ts ? { ...relayed, type: 'mpegts' } : { ...relayed, audio: true };
}

/**
 * The type a station's http stream is sent to the relay as ('' if unknown), kept as long as the
 * https check. Asked as the relay asks (RELAY_UA): a Shoutcast server sends a browser its status
 * page at its root address, and the relay its stream.
 */
async function relayType(url) {
  const key = `relaytype:${url}`;
  try {
    // As the relay fetches (it follows redirects to http too).
    const type = await cache.remember(key, HTTPS_TTL_MS, () => answersWithSound(url, RELAY_UA, false));
    // No sound this time may be a passing failure (a 503): asked again in a minute, not an hour.
    if (!type) cache.set(key, '', RETRY_TTL_MS);
    return type;
  } catch (e) {
    return '';
  }
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
  // The slot is taken before the station is looked up, so requests waiting on the same lookup
  // see it and are held to the limits too.
  relays.total++;
  relays.byIp.set(ip, (relays.byIp.get(ip) || 0) + 1);
  const controller = new AbortController();
  let released = false;
  let longest = 0;
  const release = () => {
    if (released) return;
    released = true;
    controller.abort();
    clearTimeout(longest);
    relays.total--;
    const n = (relays.byIp.get(ip) || 1) - 1;
    if (n > 0) relays.byIp.set(ip, n); else relays.byIp.delete(ip);
  };
  // The reply's close is the viewer leaving (or the reply ending).
  res.on('close', release);
  let s;
  try {
    s = await station(link);
  } catch (e) {
    release();
    if (!res.headersSent && !res.destroyed) res.status(422).json({ error: e.message });
    return;
  }
  if (released || res.destroyed) { release(); return; }
  longest = setTimeout(release, MAX_RELAY_MS);
  let lastError = 'The station sent no sound.';
  // The stream streamFor picked first, then the others, as long as they're the kind the player
  // was told (MPEG-TS or plain sound), which it was set up to play. Each gets up to ATTEMPT_MS (and
  // all of them TIMEOUT_MS) to send its first sound; only then does the viewer's reply start, so
  // one that answers and sends nothing gives way to the next.
  const streams = s.streams.slice(0, 3);
  const from = Math.max(0, Math.min(streams.length - 1, parseInt(req.query.s, 10) || 0));
  const kind = req.query.kind === 'ts' || req.query.kind === 'audio' ? req.query.kind : '';
  const startBy = Date.now() + TIMEOUT_MS;
  for (const url of [streams[from], ...streams.filter((u, i) => i !== from)].filter(Boolean)) {
    if (released) return;
    const left = startBy - Date.now();
    if (left <= 0) { lastError = "The station didn't answer."; break; }
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    controller.signal.addEventListener('abort', stop);
    const timer = setTimeout(stop, Math.min(left, ATTEMPT_MS));
    let started = false;
    try {
      const upstream = await lists().fetchPublic(url, { signal: attempt.signal, headers: { 'User-Agent': RELAY_UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' } });
      const type = String(upstream.headers.get('content-type') || '');
      const wrongKind = kind && (/^video\/mp2t/i.test(type) ? 'ts' : 'audio') !== kind;
      if (!upstream.ok || !AUDIO_TYPE.test(type) || PLAYLIST_TYPE.test(type) || wrongKind) {
        lastError = !upstream.ok ? `The station answered ${upstream.status}.` : wrongKind ? "The station's stream isn't the kind it was a moment ago." : "The station's stream isn't sound.";
        try { await upstream.body?.cancel(); } catch (e) {}
        continue;
      }
      const reader = upstream.body.getReader();
      let first = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) { first = value; break; }
      }
      if (!first) { lastError = 'The station sent no sound.'; continue; }
      if (released || res.destroyed) { try { await reader.cancel(); } catch (e) {} return; }
      started = true;
      clearTimeout(timer);
      // AAC+ is sent as audio/aacp, which browsers don't all take: it's AAC to them.
      const sent = type.split(';')[0].trim().replace(/^audio\/aacp$/i, 'audio/aac');
      res.status(200).set({ 'Content-Type': sent, 'Cache-Control': 'no-store' });
      async function* sound() {
        try {
          yield Buffer.from(first);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value && value.length) yield Buffer.from(value);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      }
      const body = Readable.from(sound());
      body.on('error', () => { release(); res.destroy(); });
      body.on('end', () => { release(); res.end(); });
      body.pipe(res);
      return;
    } catch (e) {
      lastError = e && e.name === 'AbortError' ? "The station didn't answer." : (e && e.message) || "Couldn't reach the station.";
    } finally {
      if (!started) { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); }
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

// ------------------------------------------------------------------ Radio Browser

/** Radio Browser asks its users to say who they are. */
const RB_UA = 'FireVPlayer/1.0';
/** Its API servers, looked up from all.api.radio-browser.info (these if that fails). */
const RB_FALLBACK = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info'];

/**
 * JSON from a Radio Browser server. Its servers have IPv6 addresses that some hosts can't reach,
 * and fetch() waits on those, so this tries IPv6 and IPv4 side by side (autoSelectFamily).
 */
function rbJson(url) {
  return new Promise((resolve, reject) => {
    const req = httpsLib.get(url, {
      headers: { 'user-agent': RB_UA, accept: 'application/json' },
      autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500, timeout: TIMEOUT_MS
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > 4 * 1024 * 1024) { req.destroy(new Error('Too big')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

function radioBrowserServers() {
  return cache.remember('rb:servers', 24 * 60 * 60 * 1000, async () => {
    try {
      const list = (await rbJson('https://all.api.radio-browser.info/json/servers')).map(x => String(x && x.name || '')).filter(n => /^[a-z0-9.-]+\.api\.radio-browser\.info$/.test(n));
      const unique = [...new Set(list)];
      return unique.length ? unique : RB_FALLBACK;
    } catch (e) {
      return RB_FALLBACK;
    }
  });
}

/** A Radio Browser API answer (path like "stations/search?..."), from the first server that answers. */
async function radioBrowserApi(path) {
  let lastError;
  for (const host of (await radioBrowserServers()).slice(0, 3)) {
    try {
      return await rbJson(`https://${host}/json/${path}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Couldn't reach Radio Browser.");
}

async function radioBrowserStation(id) {
  const list = await radioBrowserApi(`stations/byuuid/${id}`);
  const st = Array.isArray(list) && list[0];
  if (!st) throw new Error("That Radio Browser station doesn't exist (any more).");
  const streams = [st.url_resolved, st.url].map(u => String(u || '')).filter(u => /^https?:\/\//i.test(u));
  if (!streams.length) throw new Error('That Radio Browser station has no stream.');
  return { title: clean(st.name, 120), streams: [...new Set(streams)] };
}

function radioBrowserItem(st) {
  const tags = String(st.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 3).join(', ');
  const bits = [tags, st.countrycode, Number(st.bitrate) > 0 ? `${st.bitrate} kbps` : ''].filter(Boolean);
  const icon = String(st.favicon || '');
  return {
    id: String(st.stationuuid),
    title: `${clean(st.name, 120) || 'Radio station'} (radio)`,
    thumbnail: /^https:\/\//i.test(icon) ? icon : '',
    duration: 0,
    link: `https://www.radio-browser.info/history/${st.stationuuid}`,
    channel: { name: bits.length ? `Radio Browser: ${clean(bits.join(', '), 120)}` : 'Radio Browser', link: '' },
    description: '',
    source: 'radiobrowser'
  };
}

/**
 * Searches Radio Browser's stations by name and by tag (genre), most listened to first. With the
 * relay off (the default), only stations that stream over https are asked for, as no other can play.
 */
function searchRadioBrowser(term) {
  const q = clean(term, 100);
  if (!q) return Promise.resolve([]);
  const https = relayOn() ? '' : '&is_https=true';
  return cache.remember(`rb:search:${https}:${q.toLowerCase()}`, SEARCH_TTL_MS, async () => {
    const common = `limit=${MAX_RESULTS}&hidebroken=true&order=clickcount&reverse=true${https}`;
    const [byName, byTag] = await Promise.all([
      radioBrowserApi(`stations/search?name=${encodeURIComponent(q)}&${common}`),
      radioBrowserApi(`stations/search?tag=${encodeURIComponent(q.toLowerCase())}&${common}`).catch(() => [])
    ]);
    const seen = new Map();
    for (const st of [...(Array.isArray(byName) ? byName : []), ...(Array.isArray(byTag) ? byTag : [])]) {
      if (!st || !/^[0-9a-f-]{36}$/i.test(String(st.stationuuid)) || seen.has(st.stationuuid)) continue;
      if (Number(st.ssl_error) && !relayOn()) continue; // its https certificate is broken
      seen.set(st.stationuuid, st);
    }
    return [...seen.values()].sort((a, b) => (Number(b.clickcount) || 0) - (Number(a.clickcount) || 0))
      .slice(0, MAX_RESULTS).map(radioBrowserItem);
  });
}

// ------------------------------------------------------------------ SomaFM

/** SomaFM's channels (about 50), kept for ten minutes. */
function somaChannels() {
  return cache.remember('soma:channels', SEARCH_TTL_MS, async () => {
    const res = await fetch('https://api.somafm.com/channels.json', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = ((await res.json()) || {}).channels;
    return (Array.isArray(list) ? list : []).filter(c => c && /^[a-z0-9]{2,40}$/.test(String(c.id)));
  });
}

function somaItem(c) {
  const listeners = Number(c.listeners) || 0;
  const bits = [clean(c.genre, 60).replace(/\|/g, ', '), listeners ? `${listeners} listening` : ''].filter(Boolean);
  return {
    id: String(c.id),
    title: `SomaFM: ${clean(c.title, 100)} (radio)`,
    thumbnail: String(c.largeimage || c.image || ''),
    duration: 0,
    link: `https://somafm.com/${c.id}/`,
    channel: { name: bits.length ? `SomaFM: ${bits.join(', ')}` : 'SomaFM', link: '' },
    description: clean(c.description, 200),
    source: 'somafm'
  };
}

/**
 * Searches SomaFM's channels by name, genre, description and DJ, most listened to first. "somafm"
 * (or "soma") lists them all.
 */
async function searchSomaFM(term) {
  const words = clean(term, 100).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const all = await somaChannels();
  const everything = words.every(w => /^(soma|somafm|all|\*)$/.test(w));
  const text = c => [c.title, c.genre, c.description, c.dj, c.id].map(x => String(x || '').toLowerCase()).join(' ');
  return all.filter(c => everything || words.every(w => text(c).includes(w)))
    .sort((a, b) => (Number(b.listeners) || 0) - (Number(a.listeners) || 0))
    .slice(0, 100).map(somaItem); // all of them: SomaFM has about 50
}

// ------------------------------------------------------------------ internet-radio.com

/** An internet-radio.com station's page, the link its stations are kept by. */
const internetRadioLink = id => `${INTERNET_RADIO}/station/${id}/`;

/** A page of internet-radio.com, as text (its pages are about 100 KB). */
async function internetRadioPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) {
    try { await res.body?.cancel(); } catch (e) {}
    throw new Error("That internet-radio.com station doesn't exist (any more).");
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch (e) {}
    throw new Error(`internet-radio.com answered ${res.status}.`);
  }
  const text = await res.text();
  if (text.length > 2 * 1024 * 1024) throw new Error("internet-radio.com's page is too big.");
  return { url: res.url || url, text };
}

/**
 * What a station's Play button on internet-radio.com plays: its stream (often internet-radio.com's
 * own https proxy of it) and the station's own address, its name and what it's playing.
 */
function internetRadioButton(html) {
  const attr = name => decodeEntities(((new RegExp(`\\b${name}="([^"]*)"`)).exec(html) || [])[1] || '').trim();
  const streams = [...new Set([attr('data-stream-url'), attr('data-fallback-url')].filter(u => /^https?:\/\/\S+$/i.test(u)))];
  return { streams, title: clean(attr('data-title'), 120), meta: clean(attr('data-meta'), 200) };
}

/** A station's name and streams, from its page (the Play button at its top). */
async function internetRadioStation(id) {
  const { text } = await internetRadioPage(internetRadioLink(id));
  // The page's top band is the station; the stations under "You might also like" aren't.
  const start = text.indexOf('class="station-band"');
  const end = start < 0 ? -1 : text.indexOf('</section>', start);
  const band = start < 0 ? '' : text.slice(start, end < 0 ? undefined : end);
  const button = /<button\b[^>]*data-stream-url="[^>]*>/i.exec(band);
  const st = button ? internetRadioButton(button[0]) : { streams: [] };
  if (!st.streams.length) throw new Error('That internet-radio.com station has no stream.');
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(band);
  return { title: st.title || clean(decodeEntities(h1 ? h1[1].replace(/<[^>]*>/g, ' ') : ''), 120), streams: st.streams };
}

/**
 * A station row of internet-radio.com's search or genre pages as a search result, or null. A
 * station it hosts has a page there, which it's kept by; one it only lists has none, so it's kept
 * by its stream's address, marked #internet-radio.
 */
function internetRadioItem(row) {
  const slug = /href="\/station\/([a-z0-9][a-z0-9._-]{0,79})\/"/i.exec(row);
  const button = /<button\b[^>]*data-stream-url="[^>]*>/i.exec(row);
  if (!button) return null;
  const st = internetRadioButton(button[0]);
  if (!slug && !st.streams.length) return null;
  const link = slug ? internetRadioLink(slug[1].toLowerCase()) : `${st.streams[0].replace(/#.*$/, '')}#internet-radio`;
  const id = slug ? slug[1].toLowerCase() : link;
  const text = s => clean(decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')), 200);
  const genres = /Genres:([\s\S]*?)<\/div>/i.exec(row);
  const listeners = /([\d,]+)\s+listeners?\b/i.exec(row);
  const kbps = /(\d+)\s*kbps/i.exec(row);
  const bits = [genres ? text(genres[1]).split(/\s+/).slice(0, 3).join(', ') : '', kbps ? `${kbps[1]} kbps` : '',
    listeners ? `${listeners[1]} listening` : ''].filter(Boolean);
  const name = st.title || text((/<strong>([\s\S]*?)<\/strong>/i.exec(row) || [])[1]) || 'Radio station';
  const item = {
    id,
    title: `${clean(name, 120)} (radio)`,
    thumbnail: '',
    duration: 0,
    link,
    channel: { name: bits.length ? `internet-radio.com: ${bits.join(', ')}` : 'internet-radio.com', link: '' },
    description: st.meta,
    source: 'internetradio'
  };
  return item;
}

/**
 * Searches internet-radio.com's stations (names, genres and what they're playing), as its own
 * search does. A genre's name (jazz) goes to that genre's page, which is asked for 50 stations.
 */
function searchInternetRadio(term) {
  const q = clean(term, 100);
  // Its search takes 3 letters or more.
  if (q.length < 3) return Promise.resolve([]);
  return cache.remember(`ir:search:${q.toLowerCase()}`, SEARCH_TTL_MS, async () => {
    let page = await internetRadioPage(`${INTERNET_RADIO}/search/?radio=${encodeURIComponent(q)}&size=50`);
    const genre = /^https:\/\/www\.internet-radio\.com\/stations\/[^/?#]+\/$/i.test(page.url);
    if (genre) page = await internetRadioPage(`${page.url}?size=50`);
    const seen = new Set();
    const items = [];
    for (const row of page.text.split(/<tr\b[^>]*class="station-row/i).slice(1)) {
      const item = internetRadioItem(row.split(/<\/tr>/i)[0]);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items.slice(0, 50);
  });
}

module.exports = {
  parsePlaylist, looksLikeRadio, resolveLink, sniff, streamFor, relay, stationLink,
  searchShoutcast, searchRadioBrowser, searchSomaFM, searchInternetRadio
};
