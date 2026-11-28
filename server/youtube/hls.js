/**
 * @fileoverview HLS playlists for a YouTube video on the world's own video player (native-video.js).
 * Each viewer's device looks the video up itself (public/yt-resolve.js, in a hidden browser on
 * youtube.com), as YouTube ties the stream addresses to the address that asked. It packs what it
 * found (the video-only H.264 stream, the AAC stream, and each one's fragment index) into one
 * parameter, `m`, and this turns that into playlists with byte ranges. Nothing is stored, and the
 * video itself goes straight from googlevideo.com to the viewer: this server is not a relay.
 *
 *   GET /yt-hls/master.m3u8?m=…   the video and its sound, together
 *   GET /yt-hls/video.m3u8?m=…    the video stream's fragments
 *   GET /yt-hls/audio.m3u8?m=…    the sound's
 *
 * The three are in one folder, as the master playlist points at the others by relative address.
 * @module server/youtube/hls
 */

const zlib = require('zlib');

/** The longest `m` taken: about as long as an address can be before Node refuses the request. */
const MAX_PARAM = 14000;
/** The most an unpacked `m` may be. */
const MAX_UNPACKED = 200000;
/** The most fragments one stream may have (about 8 hours of 5-second fragments). */
const MAX_REFS = 6000;
/** The most one stream's playlist may be: each fragment repeats the stream's address. */
const MAX_PLAYLIST = 16 * 1024 * 1024;
/** Per fragment, the playlist lines around its address (#EXTINF and #EXT-X-BYTERANGE), at most. */
const LINES_PER_REF = 80;

/** The playlists this answers, by file name. */
const PLAYLISTS = new Map([['master.m3u8', 'master'], ['video.m3u8', 'video'], ['audio.m3u8', 'audio']]);

/** A whole number from 0 up to the largest a byte offset can safely be. */
function isCount(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

/** A [start, end] byte range. */
function isRange(r) {
  return Array.isArray(r) && r.length === 2 && isCount(r[0]) && isCount(r[1]) && r[1] >= r[0];
}

/**
 * True for an https address on googlevideo.com (or one of its hosts): the only place these
 * playlists may point, so the endpoint can't be made to write playlists for anywhere else.
 * @param {string} u
 */
function isGoogleVideo(u) {
  if (typeof u !== 'string' || u.length > 4000) return false;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password
      && (host === 'googlevideo.com' || host.endsWith('.googlevideo.com'));
  } catch (e) {
    return false;
  }
}

/**
 * One stream from the spec, checked, or null.
 * @param {Object} t - { u, init, idx, codecs, bw, first, refs, w?, h? }
 * @param {boolean} video - Whether it's the video stream, which also has w and h.
 */
function checkTrack(t, video) {
  if (!t || typeof t !== 'object' || !isGoogleVideo(t.u)) return null;
  if (!isRange(t.init) || !isRange(t.idx) || !isCount(t.first) || !isCount(t.bw)) return null;
  if (typeof t.codecs !== 'string' || !/^[A-Za-z0-9.]{1,40}$/.test(t.codecs)) return null;
  if (!Array.isArray(t.refs) || !t.refs.length || t.refs.length > MAX_REFS) return null;
  if (t.refs.length * (Buffer.byteLength(safeUri(t.u)) + LINES_PER_REF) > MAX_PLAYLIST) return null;
  if (!t.refs.every(r => Array.isArray(r) && r.length === 2 && isCount(r[0]) && r[0] > 0 && isCount(r[1]) && r[1] > 0)) return null;
  if (video && !(isCount(t.w) && t.w > 0 && isCount(t.h) && t.h > 0)) return null;
  return t;
}

/**
 * Unpacks and checks `m`: JSON, deflated (raw), in unpadded base64url. Null when it isn't a spec.
 * @param {string} m
 * @returns {{v: Object, a: Object, durMs?: number}|null}
 */
function unpack(m) {
  if (typeof m !== 'string' || !m || m.length > MAX_PARAM || !/^[A-Za-z0-9_-]+$/.test(m)) return null;
  let spec;
  try {
    const raw = zlib.inflateRawSync(Buffer.from(m, 'base64url'), { maxOutputLength: MAX_UNPACKED });
    spec = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!spec || typeof spec !== 'object') return null;
  if (!checkTrack(spec.v, true) || !checkTrack(spec.a, false)) return null;
  return spec;
}

/** An address as an HLS attribute's quoted value, or a URI line: nothing that ends either. */
function safeUri(u) {
  return String(u).replace(/["\r\n]/g, encodeURIComponent);
}

/**
 * The master playlist: the video stream, with the sound as its audio group.
 * @param {Object} spec
 * @param {string} m - The parameter, as it came (the other two playlists get it too).
 */
function masterPlaylist(spec, m) {
  const { v, a } = spec;
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8?m=${m}"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${v.bw + a.bw},CODECS="${v.codecs},${a.codecs}",RESOLUTION=${v.w}x${v.h},AUDIO="a"`,
    `video.m3u8?m=${m}`,
    ''
  ].join('\n');
}

/**
 * One stream's playlist: its init section, then each fragment as a byte range of the same file.
 * @param {Object} t - The stream (spec.v or spec.a).
 */
function mediaPlaylist(t) {
  const u = safeUri(t.u);
  const longest = t.refs.reduce((max, r) => Math.max(max, r[1]), 0);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longest / 1000))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${u}",BYTERANGE="${t.init[1] - t.init[0] + 1}@${t.init[0]}"`
  ];
  let offset = t.first;
  for (const [size, ms] of t.refs) {
    lines.push(`#EXTINF:${(ms / 1000).toFixed(3)},`, `#EXT-X-BYTERANGE:${size}@${offset}`, u);
    offset += size;
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/**
 * Adds the three playlist routes to the Express app.
 * @param {import('express').Express} app
 */
function setupRoutes(app) {
  app.get('/yt-hls/:file', (req, res, next) => {
    const name = PLAYLISTS.get(req.params.file);
    if (!name) { next(); return; }
    const m = typeof req.query.m === 'string' ? req.query.m : '';
    const spec = unpack(m);
    res.set('Cache-Control', 'no-store');
    if (!spec) {
      res.status(400).type('text/plain').send('Not a YouTube stream this server can describe.');
      return;
    }
    const body = name === 'master' ? masterPlaylist(spec, m) : mediaPlaylist(name === 'video' ? spec.v : spec.a);
    res.set('Content-Type', 'application/vnd.apple.mpegurl').send(body);
  });
}

module.exports = { setupRoutes, unpack, masterPlaylist, mediaPlaylist };
