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
 *   { type: 'series', n, id, season }  season: one season's number, or 0 for them all
 * Messages out (window.O.sendMessage), all with from: 'tubi-resolve':
 *   { type: 'ready' }
 *   { type: 'result', n, ok: true, ... } or { type: 'result', n, ok: false, reason }
 *   (a series' result has partial: true when some episodes are listed without their details)
 */
(function () {
  if (window.__fvpTubiResolve) return;
  window.__fvpTubiResolve = true;

  var MAX_RESULTS = 40;
  var MAX_EPISODES = 300;
  // Episode pages read at a time, for a series' seasons after the first.
  var EPISODES_AT_ONCE = 4;
  // The longest those pages are read for: tubi-native.js waits 90 s for a series. Episodes not read
  // by then are listed by link, with their season and number for a title (partial: true).
  var SERIES_DEADLINE_MS = 60000;
  // The whole of a series' answer, its own page included, so the reply is sent before
  // tubi-native.js stops waiting (90 s); a few seconds are kept for sending it.
  var SERIES_BUDGET_MS = 85000;
  // The longest one page may take, its headers and its body.
  var PAGE_TIMEOUT_MS = 15000;
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
    var m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(String(text || '').trim());
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
        // Its rating's badge ("TV-MA"), for leaving titles for adults out (see MediaSources.tubiMature).
        var rating = t.querySelector('.web-content-tile__rating .web-rating') || t.querySelector('.web-rating');
        out.push({
          kind: m[1] === 'series' ? 'series' : m[1] === 'tv-shows' ? 'episode' : 'movie',
          id: m[2],
          title: clean(a.textContent, 150),
          year: clean(year && year.textContent, 4),
          duration: parseLength(length && length.textContent),
          tags: clean(tags && tags.textContent, 120),
          rating: clean(rating && rating.textContent, 20),
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

  // A page's site data. The read is given up (and aborted) after timeoutMs, headers and body both.
  function pageData(path, timeoutMs) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = 0;
    var expired = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        try { if (ctrl) ctrl.abort(); } catch (e) {}
        reject(new Error("Tubi didn't answer in time."));
      }, Math.max(1, timeoutMs || PAGE_TIMEOUT_MS));
    });
    var read = fetch('/' + path, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (res.status === 404) throw new Error("That Tubi page doesn't exist (or isn't available here).");
      if (!res.ok) throw new Error('Tubi answered ' + res.status + '.');
      return res.text();
    }).then(function (html) {
      var start = html.indexOf('window.__data=');
      if (start < 0) throw new Error("Couldn't read that Tubi page here.");
      var end = html.indexOf('</script>', start);
      var body = html.slice(start + 'window.__data='.length, end).trim().replace(/;\s*$/, '').replace(/:undefined(?=[,}\]])/g, ':null');
      var data = JSON.parse(body);
      if (/^series\//.test(path)) data.fvpSeasons = seasonsOf(html);
      return data;
    });
    return Promise.race([read, expired]).then(function (data) { clearTimeout(timer); return data; },
      function (e) { clearTimeout(timer); throw e; });
  }

  // Every season of a series page, from its query state (as server/streaming.js reads it):
  // [{number, episodes: [{id, num}]}], or null. The site data has the first season's episodes only.
  function seasonsOf(html) {
    var start = html.indexOf('window.__REACT_QUERY_STATE__=');
    if (start < 0) return null;
    var end = html.indexOf('</script>', start);
    try {
      var body = html.slice(start + 'window.__REACT_QUERY_STATE__='.length, end).trim().replace(/;\s*$/, '')
        .replace(/([:[,])undefined(?=[,}\]])/g, '$1null');
      var queries = JSON.parse(body).queries || [];
      for (var i = 0; i < queries.length; i++) {
        var q = queries[i];
        if (q && q.queryKey && q.queryKey[0] === 'seriesPaginationInfo') {
          var seasons = q.state && q.state.data && q.state.data.seasons;
          return Array.isArray(seasons) ? seasons : null;
        }
      }
    } catch (e) {}
    return null;
  }

  // A title's ratings' values (["TV-MA"]), as its page data has them.
  function ratings(c) {
    return ((c && c.ratings) || []).map(function (r) { return clean(r && (r.value || r.code), 20); }).filter(Boolean);
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
      send({ type: 'result', n: n, ok: true, url: pick.manifest.url, title: clean(c.title, 200), duration: Math.round(Number(c.duration) || 0) * 1000, thumbnail: picture(c), ratings: ratings(c) });
    }).catch(function (e) { send({ type: 'result', n: n, ok: false, reason: String(e && e.message || e) }); });
  }

  // An episode the series page has no details of (a season after the first), from its own page.
  var episodes = {};
  function episode(id) {
    if (!episodes[id]) {
      episodes[id] = pageData('tv-shows/' + id).then(function (data) {
        var c = data.video && data.video.byId && data.video.byId[id];
        if (!c) throw new Error("That Tubi episode isn't available here.");
        return c;
      });
      episodes[id].catch(function () { delete episodes[id]; });
    }
    return episodes[id];
  }

  // A series' episodes, season 1 first and each in order, or one season's (`season`: its number).
  // The series page has the details of its first season's episodes only (at most 20); every
  // season's are listed by id, and the rest are read from their own pages, a few at a time.
  function series(n, id, season) {
    var started = Date.now();
    function left() { return started + SERIES_BUDGET_MS - Date.now(); }
    pageData('series/' + id, Math.min(PAGE_TIMEOUT_MS, left())).then(function (data) {
      var byId = (data.video && data.video.byId) || {};
      var s = byId['0' + id] || byId[id];
      if (!s) throw new Error("That Tubi series isn't available here.");
      function num(v, fallback) { return v != null && isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : fallback; }
      var listed = (data.fvpSeasons && data.fvpSeasons.length ? data.fvpSeasons : s.seasons || []).map(function (x, i) {
        return {
          n: num(x.number, 1000 + i),
          eps: (x.episodes || []).map(function (ep, k) {
            var known = byId[ep.id] || {};
            return { id: String(ep.id || ''), num: num(ep.num != null ? ep.num : ep.episode_number != null ? ep.episode_number : known.episode_number, 1000 + k) };
          }).filter(function (ep) { return /^\d{1,12}$/.test(ep.id); })
        };
      }).sort(function (a, b) { return a.n - b.n; });
      var seasons = season ? listed.filter(function (x) { return x.n === season; }) : listed;
      if (season && !seasons.length) throw new Error('That Tubi series has no season ' + season + ' here.');
      var wanted = [];
      seasons.forEach(function (x) {
        x.eps.slice().sort(function (a, b) { return a.num - b.num; }).forEach(function (ep) {
          if (wanted.length < MAX_EPISODES) wanted.push({ season: x.n, ep: ep });
        });
      });
      var items = new Array(wanted.length);
      var partial = false, late = false, next = 0;
      // An episode with its season and number in its title; c is null without its details (not
      // read in time, or its page wouldn't load), and it's still listed, so it can be played.
      function entry(k, c) {
        var w = wanted[k];
        var title = c ? clean(c.title, 150) : '';
        if (!/^S\d+\s*:?\s*E\d+/i.test(title) && w.season < 1000 && w.ep.num < 1000) {
          title = 'S' + String(w.season).padStart(2, '0') + ':E' + String(w.ep.num).padStart(2, '0') + (title ? ' - ' + title : '');
        }
        return {
          title: title || 'Tubi episode',
          thumbnail: c ? picture(c) : '',
          duration: c ? Math.max(0, Math.round(Number(c.duration) || 0)) * 1000 : 0,
          link: 'https://tubitv.com/tv-shows/' + w.ep.id,
          // Without its details, the series' own rating stands for it.
          ratings: c ? ratings(c) : null
        };
      }
      function worker() {
        if (late || next >= wanted.length) return Promise.resolve();
        var k = next++;
        var known = byId[wanted[k].ep.id];
        return (known ? Promise.resolve(known) : episode(wanted[k].ep.id)).then(function (c) { return c; }, function () { partial = true; return null; }).then(function (c) {
          if (!late) items[k] = entry(k, c);
          return worker();
        });
      }
      var workers = [];
      for (var i = 0; i < EPISODES_AT_ONCE; i++) workers.push(worker());
      var timer;
      return Promise.race([Promise.all(workers), new Promise(function (resolve) { timer = setTimeout(resolve, Math.max(0, Math.min(SERIES_DEADLINE_MS, left()))); })]).then(function () {
        clearTimeout(timer);
        late = true;
        // A slot not reached in time still gets the series page's details where it has them.
        for (var k = 0; k < items.length; k++) {
          if (items[k]) continue;
          var known = byId[wanted[k].ep.id];
          items[k] = entry(k, known || null);
          if (!known) partial = true;
        }
        var name = clean(s.title, 120) || 'Tubi series';
        send({ type: 'result', n: n, ok: true, title: season ? clean(name + ', Season ' + season, 120) : name, items: items, partial: partial, ratings: ratings(s) });
      });
    }).catch(function (e) { send({ type: 'result', n: n, ok: false, reason: String(e && e.message || e) }); });
  }

  window.addEventListener('bsmessage', function (e) {
    // The action's text comes as e.detail.message (as yt-resolve.js reads it).
    var msg = e && e.detail;
    if (msg && typeof msg === 'object' && 'message' in msg) msg = msg.message;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (err) { return; } }
    if (!msg || typeof msg !== 'object' || typeof msg.n !== 'number') return;
    if (msg.type === 'search' && typeof msg.term === 'string') search(msg.n, clean(msg.term, 100));
    else if (msg.type === 'stream' && /^\d{1,12}$/.test(String(msg.id))) stream(msg.n, msg.kind === 'episode' ? 'episode' : 'movie', String(msg.id));
    else if (msg.type === 'series' && /^\d{1,12}$/.test(String(msg.id))) series(msg.n, String(msg.id), /^\d{1,3}$/.test(String(msg.season || '')) ? Number(msg.season) : 0);
  });

  send({ type: 'ready' });
  log('Ready.');
})();
