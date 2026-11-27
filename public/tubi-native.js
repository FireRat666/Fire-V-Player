/**
 * @fileoverview Tubi lookups from this viewer's own device: search, a movie or episode's stream,
 * and a series' episodes. A tiny hidden BS Browser parked on tubitv.com runs tubi-resolve.js,
 * so Tubi answers from the viewer's own address, as YouTube lookups do (youtube-native.js). The
 * server may be in a country Tubi doesn't serve (the main server is), so whatever this can't do
 * falls back to the server's own lookups.
 *
 * The hidden browser is made the first time it's wanted, and kept for the visit.
 * @module public/tubi-native
 */

var FireTubiResolver = (() => {
  /** The page the hidden browser sits on: on Tubi's own site, and tiny. */
  const PAGE_URL = 'https://tubitv.com/robots.txt';
  /** Bump when tubi-resolve.js changes, so browsers don't keep an old copy. */
  const SCRIPT_VERSION = 5;
  const INJECT_EVERY_MS = 500;
  const READY_TIMEOUT_MS = 20000;
  /** The longest a search, and any other lookup, may take. */
  const SEARCH_TIMEOUT_MS = 25000;
  const REQUEST_TIMEOUT_MS = 15000;
  /** A series reads a page for each episode after its first season, a few at a time. */
  const SERIES_TIMEOUT_MS = 90000;
  /** How long a stream is kept (Tubi's stream links last about a week), and a series' episodes. */
  const STREAM_CACHE_MS = 60 * 60 * 1000;
  const SERIES_CACHE_MS = 30 * 60 * 1000;

  return class {
    /** @param {Object} core - The Core. */
    constructor(core) {
      this.core = core;
      this.n = 0;
      this.pending = new Map(); // n -> { resolve, timer }
      this.cache = new Map();   // key -> { at, answer }
      this.readyWaiters = [];
      this.isReady = false;
      this.failed = null;
      this.createdAt = performance.now();
      // The page must be ready in time, making its object and browser included (they can stall).
      this.readyTimer = setTimeout(() => this.giveUp("The Tubi lookup page didn't start."), READY_TIMEOUT_MS);
      this.ready = this.create().catch(e => this.giveUp(`Couldn't make the Tubi lookup browser: ${e && e.message || e}`));
    }

    /** Whether this client can make the hidden browser at all. */
    static possible() {
      return !!window.isBanter && typeof BS !== 'undefined' && (typeof BS.Browser === 'function' || typeof BS.BanterBrowser === 'function');
    }

    scriptUrl() {
      return `${this.core.getProtocol()}://${this.core.hostUrl}/tubi-resolve.js?v=${SCRIPT_VERSION}`;
    }

    async create() {
      const core = this.core;
      const t = core.screenTransform();
      // Out of sight (52 m below the screen) and too small to see or click.
      const position = new BS.Vector3(t.position.x, t.position.y - 52, t.position.z);
      const go = await core.makeObject('FireVPlayer_TubiLookup', { position, scale: new BS.Vector3(0.0001, 0.0001, 0.0001) });
      if (this.destroyed) { core.destroyObject(go); return; }
      this.go = go;
      go.On('browser-message', e => this.onMessage(e));
      const component = await core.addComponent(go, core.bsComponent('Browser',
        { url: PAGE_URL, pageWidth: 320, pageHeight: 180 }, 'BanterBrowser', [PAGE_URL, false, 1300, 320, 180, null]));
      // Removed meanwhile: destroy() has already destroyed the object (this.go).
      if (this.destroyed) return;
      this.component = component;
      try { if (typeof component.ToggleInteraction === 'function') component.ToggleInteraction(false); } catch (e) {}
      // Quiet: Tubi's search page has no sound, but it's a browser all the same.
      try { if ('volume' in component) component.volume = 0; } catch (e) {}
      // The browser starts on about:blank, so the loader is put on the page until it's there.
      const code = `(function(){if(location.hostname!=="tubitv.com"||window.__fvpTubiLoader)return;window.__fvpTubiLoader=1;`
        + `var s=document.createElement("script");s.src=${JSON.stringify(this.scriptUrl())};`
        + `(document.head||document.documentElement).appendChild(s);})();`;
      const json = JSON.stringify({ actions: [{ actionType: 'runscript', strParam1: code }] });
      const inject = () => {
        if (this.isReady || this.destroyed || this.failed) return;
        try { component.RunActions(json); } catch (e) {}
        this.injectTimer = setTimeout(inject, INJECT_EVERY_MS);
      };
      inject();
    }

    giveUp(reason) {
      if (this.isReady || this.failed) return;
      this.failed = reason;
      clearTimeout(this.injectTimer);
      clearTimeout(this.readyTimer);
      console.warn(`[TubiNative] ${reason}`);
      this.readyWaiters.splice(0).forEach(w => w(false));
    }

    whenReady() {
      if (this.isReady) return Promise.resolve(true);
      if (this.failed || this.destroyed) return Promise.resolve(false);
      return new Promise(resolve => this.readyWaiters.push(resolve));
    }

    onMessage(e) {
      let msg = e && e.detail;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch (err) { return; }
      }
      if (!msg || typeof msg !== 'object' || msg.from !== 'tubi-resolve') return;
      if (msg.type === 'ready') {
        if (this.isReady) return;
        this.isReady = true;
        this.failed = null;
        clearTimeout(this.injectTimer);
        clearTimeout(this.readyTimer);
        console.log(`[TubiNative] The lookup page is ready (${Math.round(performance.now() - this.createdAt)} ms).`);
        this.readyWaiters.splice(0).forEach(w => w(true));
        return;
      }
      if (msg.type === 'result') {
        const p = this.pending.get(msg.n);
        if (!p) return;
        this.pending.delete(msg.n);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }

    /** Asks the lookup page; the answer is {ok: true, ...} or {ok: false, reason}. */
    async ask(request, timeoutMs) {
      if (!(await this.whenReady())) return { ok: false, reason: this.failed || 'The Tubi lookup page is gone.' };
      const n = ++this.n;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          this.pending.delete(n);
          resolve({ ok: false, reason: "Tubi didn't answer in time." });
        }, timeoutMs);
        this.pending.set(n, { resolve, timer });
        const json = JSON.stringify({ actions: [{ actionType: 'postmessage', strParam1: JSON.stringify(Object.assign({ n }, request)) }] });
        try { this.component.RunActions(json); } catch (e) {
          clearTimeout(timer);
          this.pending.delete(n);
          resolve({ ok: false, reason: `Couldn't ask the lookup page: ${e && e.message || e}` });
        }
      });
    }

    cached(key, ms) {
      const hit = this.cache.get(key);
      return hit && Date.now() - hit.at < ms ? hit.answer : null;
    }

    /**
     * Searches Tubi as its own site does, from this device.
     * @returns {Promise<Object[]|null>} Search results as the server gives them, or null when it couldn't.
     */
    async search(term) {
      const started = performance.now();
      const msg = await this.ask({ type: 'search', term: String(term || '').slice(0, 100) }, SEARCH_TIMEOUT_MS);
      if (!msg.ok || !Array.isArray(msg.items)) {
        console.warn(`[TubiNative] Search ${JSON.stringify(term)}: ${msg.reason || 'no answer'}`);
        return null;
      }
      console.log(`[TubiNative] Search ${JSON.stringify(term)}: ${msg.items.length} results in ${Math.round(performance.now() - started)} ms.`);
      return msg.items.filter(x => x && /^\d{1,12}$/.test(String(x.id))).map(x => {
        const series = x.kind === 'series';
        const path = series ? 'series' : x.kind === 'episode' ? 'tv-shows' : 'movies';
        const year = /^\d{4}$/.test(String(x.year || '')) ? x.year : '';
        return {
          id: String(x.id),
          title: `${String(x.title || 'Tubi video').slice(0, 150)}${series ? ' (series)' : ''}`,
          thumbnail: /^https:\/\//.test(String(x.thumbnail || '')) ? x.thumbnail : '',
          duration: series ? 0 : Math.max(0, Number(x.duration) || 0),
          link: `https://tubitv.com/${path}/${x.id}`,
          channel: { name: [year ? `Tubi, ${year}` : 'Tubi', String(x.tags || '').replace(/ /g, ' ')].filter(Boolean).join(': ').slice(0, 160), link: '' },
          description: '',
          source: 'tubi',
          // R, TV-MA, not rated (see MediaSources.tubiMature): left out where the world doesn't allow them.
          mature: MediaSources.tubiMature(x.rating)
        };
      });
    }

    /**
     * A movie or episode's stream, and its title, length, picture and whether it's for adults,
     * looked up from this device.
     * @returns {Promise<{ok: true, url: string, title: string, duration: number, thumbnail: string, mature: boolean}|{ok: false, reason: string}>}
     */
    async stream(link) {
      const media = window.MediaSources ? MediaSources.detect(link) : null;
      if (!media || media.type !== 'tubi' || media.kind === 'series') return { ok: false, reason: "That isn't a Tubi movie or episode." };
      const key = `stream:${media.kind}:${media.id}`;
      const hit = this.cached(key, STREAM_CACHE_MS);
      if (hit) return hit;
      const msg = await this.ask({ type: 'stream', kind: media.kind, id: media.id }, REQUEST_TIMEOUT_MS);
      if (!msg.ok || !/^https:\/\//.test(String(msg.url || ''))) {
        console.warn(`[TubiNative] Stream for ${link}: ${msg.reason || 'no address'}`);
        return { ok: false, reason: String(msg.reason || "Couldn't find the stream.") };
      }
      const answer = {
        ok: true, url: msg.url, title: String(msg.title || '').slice(0, 200), duration: Math.max(0, Number(msg.duration) || 0),
        thumbnail: /^https:\/\//.test(String(msg.thumbnail || '')) ? msg.thumbnail : '',
        mature: MediaSources.tubiMature(msg.ratings)
      };
      this.cache.set(key, { at: Date.now(), answer });
      return answer;
    }

    /**
     * A series' episodes, looked up from this device. Each is marked `mature` if it or the series
     * is for adults (an episode without its details goes by the series).
     * @returns {Promise<{title: string, items: Object[], mature: boolean}|null>}
     */
    async series(link) {
      const media = window.MediaSources ? MediaSources.detect(link) : null;
      if (!media || media.type !== 'tubi' || media.kind !== 'series') return null;
      const key = `series:${media.id}:${media.season || 'all'}`;
      const hit = this.cached(key, SERIES_CACHE_MS);
      if (hit) return hit;
      const msg = await this.ask({ type: 'series', id: media.id, season: media.season || 0 }, SERIES_TIMEOUT_MS);
      if (!msg.ok || !Array.isArray(msg.items)) {
        console.warn(`[TubiNative] Series ${link}: ${msg.reason || 'no answer'}`);
        return null;
      }
      const seriesMature = MediaSources.tubiMature(msg.ratings);
      const answer = {
        title: String(msg.title || 'Tubi series').slice(0, 120),
        mature: seriesMature,
        items: msg.items.filter(x => x && /^https:\/\/tubitv\.com\/tv-shows\/\d{1,12}$/.test(String(x.link))).map(x => ({
          title: String(x.title || 'Tubi video').slice(0, 200),
          thumbnail: /^https:\/\//.test(String(x.thumbnail || '')) ? x.thumbnail : '',
          duration: Math.max(0, Number(x.duration) || 0),
          link: x.link,
          mature: seriesMature || (Array.isArray(x.ratings) ? MediaSources.tubiMature(x.ratings) : false)
        }))
      };
      // Missing some episodes' details: not kept, so the next look reads them again.
      if (!msg.partial) this.cache.set(key, { at: Date.now(), answer });
      return answer;
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.injectTimer);
      clearTimeout(this.readyTimer);
      this.pending.forEach(p => { clearTimeout(p.timer); p.resolve({ ok: false, reason: 'The player was removed.' }); });
      this.pending.clear();
      this.readyWaiters.splice(0).forEach(w => w(false));
      if (this.go) this.core.destroyObject(this.go);
      this.go = null;
      this.component = null;
    }
  };
})();
window.FireTubiResolver = FireTubiResolver;
