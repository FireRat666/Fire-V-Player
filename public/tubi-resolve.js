/**
 * @fileoverview Tubi lookups from this viewer's own device. It runs on tubitv.com itself
 * (https://tubitv.com/robots.txt), in a tiny hidden BS Browser that tubi-native.js keeps in the
 * world, so Tubi's pages answer it with no CORS wall, from the viewer's own address (Tubi only
 * serves some countries, and the server may be in another one).
 *
 * - search: Tubi's own search page runs in a same-origin frame, shrunk to a dot so every result is
 *   on screen (its pictures load only then), and the results it shows are read.
 * - stream / content / series: a movie, episode or series page is fetched and its site data
 *   (window.__data) read, as server/streaming.js does on the server.
 *
 * Messages in (BS Browser "postmessage" actions, as bsmessage events):
 *   { type: 'search', n, term }
 *   { type: 'stream', n, kind, id }      kind 'movie' or 'episode'
 *   { type: 'series', n, id }
 * Messages out (window.O.sendMessage), all with from: 'tubi-resolve':
 *   { type: 'ready' }
 *   { type: 'result', n, ok: true, ... } or { type: 'result', n, ok: false, reason }
 */
(function () {
  if (window.__fvpTubiResolve) return;
  window.__fvpTubiResolve = true;

  var MAX_RESULTS = 40;
  var MAX_EPISODES = 300;
  var SEARCH_TIMEOUT_MS = 20000;

  function log(msg) { try { console.log('[tubi-resolve] ' + msg); } catch (e) {} }

  function send(msg) {
    msg.from = 'tubi-resolve';
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

  function clean(s, max) {
    return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  function https(u) { u = String(u || ''); return u.indexOf('//') === 0 ? 'https:' + u : u; }

  // "1h 56m" or "45m" as milliseconds.
  function parseLength(text) {
    var m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(String(text || ''));
    if (!m || (!m[1] && !m[2])) return 0;
    return ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60) * 1000;
  }

  // ---------------------------------------------------------------- search

  // Only one search runs at a time; a newer one replaces it.
  var searching = null;

  function search(n, term) {
    if (searching) searching.cancel('A newer search replaced it.');
    var frame = document.createElement('iframe');
    // Big enough for its results, then shrunk to a dot in the corner: on screen, so its pictures load.
    frame.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:12000px;border:0;transform:scale(0.01);transform-origin:0 0;opacity:0.01;pointer-events:none;';
    frame.src = '/search/' + encodeURIComponent(term);
    var done = false, timer = 0, started = Date.now(), prev = -1, stable = 0;
    function finish(msg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (searching && searching.n === n) searching = null;
      try { frame.remove(); } catch (e) {}
      msg.type = 'result';
      msg.n = n;
      send(msg);
    }
    searching = { n: n, cancel: function (reason) { finish({ ok: false, reason: reason }); } };
    function read(doc) {
      var tiles = doc.querySelectorAll('[data-test-id="web-ui-content-tile"]');
      var out = [], seen = {};
      for (var i = 0; i < tiles.length && out.length < MAX_RESULTS; i++) {
        var t = tiles[i];
        var a = t.querySelector('a.web-content-tile__title') || t.querySelector('a[href]');
        var href = a ? a.getAttribute('href') || '' : '';
        var m = /^\/(movies|tv-shows|series)\/(\d{1,12})(?:\/|$)/.exec(href);
        if (!m || seen[m[2]]) continue;
        seen[m[2]] = true;
        var img = t.querySelector('img');
        var year = t.querySelector('.web-content-tile__year');
        var length = t.querySelector('.web-content-tile__duration');
        var tags = t.querySelector('.web-content-tile__tags');
        out.push({
          kind: m[1] === 'series' ? 'series' : m[1] === 'tv-shows' ? 'episode' : 'movie',
          id: m[2],
          title: clean(a.textContent, 150),
          year: clean(year && year.textContent, 4),
          duration: parseLength(length && length.textContent),
          tags: clean(tags && tags.textContent, 120),
          thumbnail: img ? String(img.currentSrc || img.src || '') : ''
        });
      }
      return { tiles: tiles.length, items: out };
    }
    function poll() {
      if (done) return;
      var doc = null;
      try { doc = frame.contentDocument; } catch (e) {}
      if (doc && doc.body) {
        var got = read(doc);
        // "No results" (Tubi shows a message and no tiles) once the page has had time to answer.
        var empty = !got.tiles && Date.now() - started > 8000 && /no results|couldn.t find|try searching/i.test(doc.body.innerText || '');
        if (empty) { finish({ ok: true, items: [] }); return; }
        if (got.tiles && got.tiles === prev) stable++; else stable = 0;
        prev = got.tiles;
        // The list has stopped growing, and its pictures have had a moment to load.
        var pictures = got.items.filter(function (x) { return x.thumbnail; }).length;
        if (got.tiles && stable >= 3 && (pictures >= got.items.length || stable >= 6)) {
          finish({ ok: true, items: got.items });
          return;
        }
      }
      if (Date.now() - started > SEARCH_TIMEOUT_MS) {
        var last = doc && doc.body ? read(doc) : null;
        if (last && last.items.length) finish({ ok: true, items: last.items });
        else finish({ ok: false, reason: "Tubi's search page didn't answer in time." });
        return;
      }
      timer = setTimeout(poll, 400);
    }
    document.body.appendChild(frame);
    timer = setTimeout(poll, 800);
  }

  // ---------------------------------------------------------------- pages

  function pageData(path) {
    return fetch('/' + path, { credentials: 'omit' }).then(function (res) {
      if (res.status === 404) throw new Error("That Tubi page doesn't exist (or isn't available here).");
      if (!res.ok) throw new Error('Tubi answered ' + res.status + '.');
      return res.text();
    }).then(function (html) {
      var start = html.indexOf('window.__data=');
      if (start < 0) throw new Error("Couldn't read that Tubi page here.");
      var end = html.indexOf('</script>', start);
      var body = html.slice(start + 'window.__data='.length, end).trim().replace(/;\s*$/, '').replace(/:undefined(?=[,}\]])/g, ':null');
      return JSON.parse(body);
    });
  }

  function picture(c) {
    var list = (c && (c.thumbnails || c.landscape_images || c.posterarts)) || [];
    return https(list[0] || '');
  }

  // The playable stream of a movie or episode: a plain HLS one, H.264 if there is one (as the server picks).
  function stream(n, kind, id) {
    pageData((kind === 'episode' ? 'tv-shows/' : 'movies/') + id).then(function (data) {
      var c = data.video && data.video.byId && data.video.byId[id];
      if (!c) throw new Error("That Tubi video isn't available here.");
      var plain = (c.video_resources || []).filter(function (r) {
        return r && r.manifest && r.manifest.url && /^hls/i.test(r.type || '') && !/widevine|playready|fairplay|drm/i.test(r.type || '') && !r.license_server;
      });
      var pick = plain.filter(function (r) { return /264|avc/i.test(r.codec || ''); })[0]
        || plain.filter(function (r) { return !/265|hevc/i.test(r.codec || ''); })[0] || plain[0];
      if (!pick) throw new Error(c.needs_login ? 'Tubi only plays this one for signed-in viewers.' : "Tubi only offers this one with copy protection, which can't play here.");
      send({ type: 'result', n: n, ok: true, url: pick.manifest.url, title: clean(c.title, 200), duration: Math.round(Number(c.duration) || 0) * 1000, thumbnail: picture(c) });
    }).catch(function (e) { send({ type: 'result', n: n, ok: false, reason: String(e && e.message || e) }); });
  }

  // A series' episodes, season 1 first and each in order (Tubi lists the newest season first, and
  // at most 20 episodes of each).
  function series(n, id) {
    pageData('series/' + id).then(function (data) {
      var byId = (data.video && data.video.byId) || {};
      var s = byId['0' + id] || byId[id];
      if (!s) throw new Error("That Tubi series isn't available here.");
      function num(v, fallback) { return isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : fallback; }
      var seasons = (s.seasons || []).map(function (season, i) { return { season: season, n: num(season.number, 1000 + i) }; })
        .sort(function (a, b) { return a.n - b.n; });
      var items = [];
      seasons.forEach(function (x) {
        var eps = (x.season.episodes || []).map(function (ep, i) { return { c: byId[ep.id] || ep, i: i }; })
          .filter(function (e) { return e.c && e.c.id; })
          .sort(function (a, b) { return num(a.c.episode_number, 1000 + a.i) - num(b.c.episode_number, 1000 + b.i); });
        eps.forEach(function (e) {
          if (items.length >= MAX_EPISODES) return;
          var c = e.c;
          var title = clean(c.title, 150) || 'Tubi video';
          if (!/^S\d+\s*:?\s*E\d+/i.test(title) && x.n < 1000 && Number(c.episode_number) > 0) {
            title = 'S' + String(x.n).padStart(2, '0') + ':E' + String(c.episode_number).padStart(2, '0') + ' - ' + title;
          }
          items.push({ title: title, thumbnail: picture(c), duration: Math.max(0, Math.round(Number(c.duration) || 0)) * 1000, link: 'https://tubitv.com/tv-shows/' + c.id });
        });
      });
      send({ type: 'result', n: n, ok: true, title: clean(s.title, 120) || 'Tubi series', items: items });
    }).catch(function (e) { send({ type: 'result', n: n, ok: false, reason: String(e && e.message || e) }); });
  }

  window.addEventListener('bsmessage', function (e) {
    var msg = e && e.detail;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (err) { return; } }
    if (!msg || typeof msg !== 'object' || typeof msg.n !== 'number') return;
    if (msg.type === 'search' && typeof msg.term === 'string') search(msg.n, clean(msg.term, 100));
    else if (msg.type === 'stream' && /^\d{1,12}$/.test(String(msg.id))) stream(msg.n, msg.kind === 'episode' ? 'episode' : 'movie', String(msg.id));
    else if (msg.type === 'series' && /^\d{1,12}$/.test(String(msg.id))) series(msg.n, String(msg.id));
  });

  send({ type: 'ready' });
  log('Ready.');
})();
