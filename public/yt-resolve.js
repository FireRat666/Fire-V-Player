/**
 * @fileoverview Finds a YouTube video's streams for the world's own video player. It runs on
 * youtube.com itself (https://www.youtube.com/robots.txt), in a tiny hidden BS Browser that
 * youtube-native.js keeps in the world, so YouTube's player API answers it with no CORS wall, and
 * the stream addresses it gives are tied to this viewer's own address, so they play for them.
 *
 * For each video it picks the video-only H.264 fragmented MP4 stream (as sharp as asked, and never
 * taller than wide) and the AAC sound, reads each one's fragment index (its sidx box), and packs
 * that into one parameter for the server's /yt-hls/ playlists (server/youtube/hls.js).
 *
 * Messages in (BS Browser "postmessage" actions, as bsmessage events):
 *   { type: 'resolve', n, id, maxHeight }
 * Messages out (window.O.sendMessage), all with from: 'yt-resolve':
 *   { type: 'ready' }                                                once, when it can take requests
 *   { type: 'result', n, ok: true, m, title, height, durMs }
 *   { type: 'result', n, ok: false, reason, unplayable, live }
 */
(function () {
  if (window.__fvpYtResolve) return;
  window.__fvpYtResolve = true;

  // VISIONOS gives plain stream addresses: no signature cipher, no n-parameter puzzle. IOS and
  // WEB answered with SABR only (no addresses), and TVHTML5 hit the bot check.
  var CLIENT = { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', gl: 'US' };
  var CLIENT_ID = '101';
  var VISITOR_KEY = 'fvpYtVisitor';
  var QUALITIES = [1080, 720, 480, 360, 240];
  // The longest packed parameter the server takes (server/youtube/hls.js), as it goes in an address.
  var MAX_PARAM = 14000;
  // And the server's other limits: the unpacked JSON's length, and each stream's fragments.
  var MAX_UNPACKED = 200000, MAX_REFS = 6000;
  // A long video's fragments are joined into longer segments until it fits: each n in a row as one
  // (a segment may hold several fragments). Longer segments make seeking a little slower.
  var JOINS = [1, 2, 3, 4, 6, 8];
  // Player answers kept for a few minutes, so a lower quality asked for after a stall is quick.
  var PLAYER_CACHE_MS = 5 * 60 * 1000;
  var playerCache = {};
  var visitor = '';

  function log(msg) { try { console.log('[yt-resolve] ' + msg); } catch (e) {} }

  // window.O appears a little after the page loads: keep trying for a while.
  function send(msg) {
    msg.from = 'yt-resolve';
    var json = JSON.stringify(msg);
    var tries = 0;
    (function attempt() {
      if (window.O && typeof window.O.sendMessage === 'function') {
        try { window.O.sendMessage('app', json); } catch (e) { log('Could not send: ' + e); }
        return;
      }
      if (++tries < 400) setTimeout(attempt, 50);
    })();
  }

  // Without a visitor id YouTube asks to sign in. One from a watch page, kept on this device.
  function fetchVisitor() {
    return fetch('/watch?v=jNQXAC9IVRw&bpctr=9999999999&has_verified=1', { credentials: 'omit' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var m = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(html) || /"visitorData"\s*:\s*"([^"]+)"/.exec(html);
        if (!m) throw new Error('No visitor id on the watch page.');
        visitor = m[1];
        try { localStorage.setItem(VISITOR_KEY, visitor); } catch (e) {}
        return visitor;
      });
  }

  function playerRequest(id) {
    return fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-youtube-client-name': CLIENT_ID, 'x-youtube-client-version': CLIENT.clientVersion, 'x-goog-visitor-id': visitor },
      body: JSON.stringify({ videoId: id, context: { client: Object.assign({}, CLIENT, { visitorData: visitor }) }, contentCheckOk: true, racyCheckOk: true })
    }).then(function (r) {
      if (!r.ok) throw new Error('YouTube answered ' + r.status + '.');
      return r.json();
    });
  }

  // The player's answer for a video. LOGIN_REQUIRED once means a stale visitor id: one more try
  // with a fresh one, and no more.
  function player(id) {
    var cached = playerCache[id];
    if (cached && Date.now() - cached.at < PLAYER_CACHE_MS) return Promise.resolve(cached.json);
    return playerRequest(id).then(function (json) {
      var status = json && json.playabilityStatus && json.playabilityStatus.status;
      if (status !== 'LOGIN_REQUIRED') return json;
      return fetchVisitor().then(function () { return playerRequest(id); }, function () { return json; });
    }).then(function (json) {
      var status = json && json.playabilityStatus && json.playabilityStatus.status;
      if (status === 'OK') playerCache[id] = { at: Date.now(), json: json };
      return json;
    });
  }

  function labelOf(f) {
    var q = parseInt(f.qualityLabel, 10);
    return Number.isFinite(q) ? q : Number(f.height) || 0;
  }
  function hasRanges(f) {
    return !!(f && f.url && f.indexRange && f.initRange);
  }

  // The video stream: H.264 in MP4, as sharp as allowed. By the label, not the height (a widescreen
  // film's "1080p" is 1920x804), and never taller than wide (Shorts, which a 16:9 screen stretches).
  // Within a quality, the lowest frame rate, then the lowest bitrate.
  function pickVideo(formats, maxHeight) {
    var usable = formats.filter(function (f) {
      return hasRanges(f) && /^video\/mp4/.test(f.mimeType || '') && /avc1/.test(f.mimeType || '')
        && !(Number(f.width) < Number(f.height));
    });
    var ladder = QUALITIES.filter(function (q) { return q <= maxHeight; });
    if (!ladder.length) ladder = [QUALITIES[QUALITIES.length - 1]];
    for (var i = 0; i < ladder.length; i++) {
      var at = usable.filter(function (f) { return labelOf(f) === ladder[i]; });
      if (!at.length) continue;
      at.sort(function (a, b) { return (Number(a.fps) || 0) - (Number(b.fps) || 0) || (Number(a.bitrate) || 0) - (Number(b.bitrate) || 0); });
      return at[0];
    }
    return null;
  }

  // The first sidx box in buf (which starts at byte idxStart of the file): each fragment's size in
  // bytes and length in ms, and the byte where the first one starts.
  function parseSidx(buf, idxStart) {
    var dv = new DataView(buf), off = 0;
    while (off + 8 <= dv.byteLength) {
      var size = dv.getUint32(off);
      var type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
      if (type === 'sidx') break;
      if (size < 8) return null;
      off += size;
    }
    if (off + 8 > dv.byteLength) return null;
    var boxSize = dv.getUint32(off);
    var q = off + 8;
    var version = dv.getUint8(q); q += 8;            // version + flags, reference_ID
    var timescale = dv.getUint32(q); q += 4;
    if (!timescale) return null;
    var firstOffset;
    if (version === 0) { q += 4; firstOffset = dv.getUint32(q); q += 4; }
    else { q += 8; firstOffset = Number(dv.getBigUint64(q)); q += 8; }
    q += 2;                                           // reserved
    var count = dv.getUint16(q); q += 2;
    var refs = [];
    for (var i = 0; i < count && q + 12 <= dv.byteLength; i++) {
      refs.push([dv.getUint32(q) & 0x7fffffff, Math.max(1, Math.round(dv.getUint32(q + 4) * 1000 / timescale))]);
      q += 12;
    }
    return refs.length ? { first: idxStart + off + boxSize + firstOffset, refs: refs } : null;
  }

  function readIndex(f) {
    var start = Number(f.indexRange.start), end = Number(f.indexRange.end);
    return fetch(f.url + '&range=' + start + '-' + end, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('The stream index answered ' + r.status + '.');
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var sidx = parseSidx(buf, start);
        if (!sidx) throw new Error("Couldn't read the stream's index.");
        return sidx;
      });
  }

  function track(f, sidx, video) {
    var codecs = /codecs="([^"]+)"/.exec(f.mimeType || '');
    var t = {
      u: f.url,
      init: [Number(f.initRange.start), Number(f.initRange.end)],
      idx: [Number(f.indexRange.start), Number(f.indexRange.end)],
      codecs: codecs ? codecs[1].replace(/\s+/g, '') : (video ? 'avc1.4d401f' : 'mp4a.40.2'),
      bw: Number(f.bitrate) || 0,
      first: sidx.first,
      refs: sidx.refs
    };
    if (video) { t.w = Number(f.width) || 0; t.h = Number(f.height) || 0; }
    return t;
  }

  // JSON, deflated (raw), as unpadded base64url: the server's `m` parameter.
  function pack(spec) {
    if (typeof CompressionStream !== 'function') return Promise.reject(new Error("This browser can't compress the stream's details."));
    var stream = new Blob([JSON.stringify(spec)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
  }

  // Each `k` fragments in a row as one segment: their sizes and lengths added up.
  function joinRefs(refs, k) {
    if (k <= 1) return refs;
    var out = [];
    for (var i = 0; i < refs.length; i += k) {
      var size = 0, ms = 0;
      for (var j = i; j < Math.min(i + k, refs.length); j++) { size += refs[j][0]; ms += refs[j][1]; }
      out.push([size, ms]);
    }
    return out;
  }

  // Packs the spec, joining fragments as much as it takes to fit (see JOINS).
  function packToFit(spec, i) {
    i = i || 0;
    var k = JOINS[i];
    var joined = { v: Object.assign({}, spec.v, { refs: joinRefs(spec.v.refs, k) }), a: Object.assign({}, spec.a, { refs: joinRefs(spec.a.refs, k) }), durMs: spec.durMs };
    var fits = joined.v.refs.length <= MAX_REFS && joined.a.refs.length <= MAX_REFS
      && new TextEncoder().encode(JSON.stringify(joined)).length <= MAX_UNPACKED;
    return (fits ? pack(joined) : Promise.resolve(null)).then(function (m) {
      if (m && m.length <= MAX_PARAM) {
        if (k > 1) log('Joined each ' + k + ' fragments to fit.');
        return m;
      }
      if (i + 1 >= JOINS.length) throw new Error("It's too long to play on the world's video player.");
      return packToFit(spec, i + 1);
    });
  }

  function fail(n, reason, extra) {
    var msg = { type: 'result', n: n, ok: false, reason: reason };
    if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
    send(msg);
  }

  function resolve(req) {
    var n = req.n;
    var id = String(req.id || '');
    var maxHeight = Number(req.maxHeight) || 1080;
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) { fail(n, 'Not a YouTube video id.'); return; }
    player(id).then(function (json) {
      var ps = (json && json.playabilityStatus) || {};
      if (ps.status !== 'OK') {
        fail(n, ps.reason || ps.status || "YouTube didn't say why.", { unplayable: true });
        return;
      }
      var details = json.videoDetails || {};
      if (details.isLive || details.isUpcoming) { fail(n, 'Live streams play in the browser.', { live: true }); return; }
      var formats = (json.streamingData && json.streamingData.adaptiveFormats) || [];
      var v = pickVideo(formats, maxHeight);
      var a = formats.filter(function (f) { return Number(f.itag) === 140 && hasRanges(f); })[0];
      if (!v || !a) {
        var tall = formats.some(function (f) { return /^video\//.test(f.mimeType || '') && Number(f.width) < Number(f.height); });
        fail(n, tall ? "It's a vertical video (a Short)." : 'YouTube gave no H.264 and AAC streams for it.', { shorts: tall });
        return;
      }
      return Promise.all([readIndex(v), readIndex(a)]).then(function (idx) {
        var spec = { v: track(v, idx[0], true), a: track(a, idx[1], false), durMs: Number(v.approxDurationMs) || Number(a.approxDurationMs) || 0 };
        return packToFit(spec).then(function (m) {
          send({ type: 'result', n: n, ok: true, m: m, title: details.title || '', height: labelOf(v), durMs: spec.durMs });
        });
      });
    }).catch(function (e) {
      fail(n, (e && e.message) || String(e));
    });
  }

  window.addEventListener('bsmessage', function (e) {
    var msg;
    try { msg = JSON.parse(e.detail.message); } catch (err) { return; }
    if (msg && msg.type === 'resolve') resolve(msg);
  });

  try { visitor = localStorage.getItem(VISITOR_KEY) || ''; } catch (e) {}
  (visitor ? Promise.resolve(visitor) : fetchVisitor())
    .catch(function (e) { log('No visitor id: ' + ((e && e.message) || e)); })
    .then(function () { send({ type: 'ready' }); });
})();
