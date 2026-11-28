/**
 * @fileoverview YouTube on the world's own video player (native-video.js). The video player plays
 * MP4, HLS and MPEG-TS, so a YouTube link is turned into HLS first: this viewer's own device asks
 * YouTube for the streams, from a tiny hidden BS Browser parked on youtube.com (yt-resolve.js runs
 * there), and the server writes playlists from what it found (server/youtube/hls.js). The video
 * itself comes straight from YouTube. YouTube ties the addresses to the viewer who asked, so each
 * viewer looks videos up for themselves; sync is still by the YouTube link and the time.
 *
 * The hidden browser is its own object, apart from the screen's browser (which is removed while
 * the world's video player is up, just when this is needed). It's made the first time a YouTube
 * video is wanted, and kept for the visit.
 * @module public/youtube-native
 */

var FireYouTubeResolver = (() => {
  /** The page the hidden browser sits on: on YouTube's own site, and tiny. */
  const PAGE_URL = 'https://www.youtube.com/robots.txt';
  /** Bump when yt-resolve.js changes, so browsers don't keep an old copy. */
  const SCRIPT_VERSION = 5;
  /** How often the loader is put on the page until it says it's ready, and for how long. */
  const INJECT_EVERY_MS = 500;
  const READY_TIMEOUT_MS = 20000;
  /** The longest one lookup may take. */
  const REQUEST_TIMEOUT_MS = 15000;
  /** How long a lookup is kept: YouTube's addresses last about 6 hours. */
  const CACHE_MS = 60 * 60 * 1000;
  /** The most lookups kept (each with its captions): the oldest go first. */
  const CACHE_MAX = 40;

  return class {
    /** @param {Object} core - The Core. */
    constructor(core) {
      this.core = core;
      this.n = 0;
      this.pending = new Map(); // n -> { resolve, timer }
      this.cache = new Map();   // `${id}@${maxHeight}` -> { at, answer }
      this.readyWaiters = [];
      this.isReady = false;
      this.failed = null;       // why the hidden page never became ready, once it hasn't
      this.createdAt = performance.now();
      // The page must be ready in time, making its object and browser included (they can stall).
      this.readyTimer = setTimeout(() => this.giveUp("The YouTube lookup page didn't start."), READY_TIMEOUT_MS);
      this.ready = this.create().catch(e => this.giveUp(`Couldn't make the YouTube lookup browser: ${e && e.message || e}`));
    }

    /** The resolver's script on this player's server. */
    scriptUrl() {
      return `${this.core.getProtocol()}://${this.core.hostUrl}/yt-resolve.js?v=${SCRIPT_VERSION}`;
    }

    async create() {
      const core = this.core;
      const t = core.screenTransform();
      // Out of sight (50 m below the screen) and too small to see or click.
      const position = new BS.Vector3(t.position.x, t.position.y - 50, t.position.z);
      const go = await core.makeObject('FireVPlayer_YouTubeLookup', { position, scale: new BS.Vector3(0.0001, 0.0001, 0.0001) });
      // Removed meanwhile: what was made goes.
      if (this.destroyed) { core.destroyObject(go); return; }
      this.go = go;
      go.On('browser-message', e => this.onMessage(e));
      const component = await core.addComponent(go, core.bsComponent('Browser',
        { url: PAGE_URL, pageWidth: 320, pageHeight: 180 }, 'BanterBrowser', [PAGE_URL, false, 1300, 320, 180, null]));
      if (this.destroyed) return; // destroy() has destroyed the object
      this.component = component;
      try { if (typeof component.ToggleInteraction === 'function') component.ToggleInteraction(false); } catch (e) {}
      // Quiet: it has no sound of its own, but it's a browser all the same.
      try { if ('volume' in component) component.volume = 0; } catch (e) {}
      // The browser starts on about:blank, so the loader is put on the page until it's there.
      // Already on the page, it's asked to say it's ready again (see handshake).
      const code = `(function(){if(location.hostname!=="www.youtube.com")return;if(window.__fvpYtLoader){if(window.__fvpYtHello)window.__fvpYtHello();return;}window.__fvpYtLoader=1;`
        + `var s=document.createElement("script");s.src=${JSON.stringify(this.scriptUrl())};`
        // A script that fails to load clears the mark, so the next try puts it on again.
        + `s.onerror=function(){window.__fvpYtLoader=0;s.remove();};`
        + `(document.head||document.documentElement).appendChild(s);})();`;
      this.injectJson = JSON.stringify({ actions: [{ actionType: 'runscript', strParam1: code }] });
      this.inject();
    }

    /** Puts the loader on the page every INJECT_EVERY_MS until it says it's ready (or it's given up on). */
    inject() {
      clearTimeout(this.injectTimer);
      if (this.isReady || this.destroyed || this.failed || !this.component) return;
      try { this.component.RunActions(this.injectJson); } catch (e) {}
      this.injectTimer = setTimeout(() => this.inject(), INJECT_EVERY_MS);
    }

    /**
     * A lookup went unanswered: the hidden page may have loaded again, without the script. It's
     * asked to say it's ready again (and given the script if it lost it), within READY_TIMEOUT_MS.
     */
    handshake() {
      if (!this.isReady || this.destroyed || !this.component) return;
      console.warn('[YouTubeNative] A lookup went unanswered, so the lookup page is checked again.');
      this.isReady = false;
      clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => this.giveUp("The YouTube lookup page stopped answering."), READY_TIMEOUT_MS);
      this.inject();
    }

    giveUp(reason) {
      if (this.isReady || this.failed) return;
      this.failed = reason;
      clearTimeout(this.injectTimer);
      clearTimeout(this.readyTimer);
      console.warn(`[YouTubeNative] ${reason}`);
      this.readyWaiters.splice(0).forEach(w => w(false));
    }

    whenReady() {
      if (this.isReady) return Promise.resolve(true);
      if (this.failed || this.destroyed) return Promise.resolve(false);
      return new Promise(resolve => this.readyWaiters.push(resolve));
    }

    /** Answers from the hidden page (window.O.sendMessage), as browser-message events. */
    onMessage(e) {
      let msg = e && e.detail;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch (err) { return; }
      }
      if (!msg || typeof msg !== 'object' || msg.from !== 'yt-resolve') return;
      if (msg.type === 'ready') {
        if (this.isReady) return;
        this.isReady = true;
        this.failed = null; // a late start still counts
        clearTimeout(this.injectTimer);
        clearTimeout(this.readyTimer);
        console.log(`[YouTubeNative] The lookup page is ready (${Math.round(performance.now() - this.createdAt)} ms).`);
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

    /**
     * Looks a video up for this viewer: the master playlist to play, or why it can't.
     * @param {string} id - The 11-character video id.
     * @param {number} maxHeight - The sharpest quality wanted (1080, 720, 480, 360 or 240).
     * @returns {Promise<{ok: true, url: string, height: number, title: string, cues: Array<[number, number, string]>}|{ok: false, reason: string, unplayable?: boolean, live?: boolean, shorts?: boolean}>}
     */
    async resolve(id, maxHeight) {
      const key = `${id}@${maxHeight}`;
      const cached = this.cache.get(key);
      const fresh = cached && Date.now() - cached.at < CACHE_MS ? cached.answer : null;
      // One whose captions came too late is looked up again (quick: the page keeps what it found),
      // so they come this time; that answer is kept if this one fails.
      if (fresh && !fresh.capsLate) return fresh;
      const found = await this.ask(id, maxHeight, key);
      return !found.ok && fresh ? fresh : found;
    }

    async ask(id, maxHeight, key) {
      if (!(await this.whenReady())) return { ok: false, reason: this.failed || 'The YouTube lookup page is gone.' };
      const n = ++this.n;
      const started = performance.now();
      const msg = await new Promise(resolve => {
        const timer = setTimeout(() => {
          this.pending.delete(n);
          this.handshake();
          resolve({ ok: false, reason: "YouTube didn't answer in time." });
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(n, { resolve, timer });
        const json = JSON.stringify({ actions: [{ actionType: 'postmessage', strParam1: JSON.stringify({ type: 'resolve', n, id, maxHeight }) }] });
        try { this.component.RunActions(json); } catch (e) {
          clearTimeout(timer);
          this.pending.delete(n);
          resolve({ ok: false, reason: `Couldn't ask the lookup page: ${e && e.message || e}` });
        }
      });
      if (!msg.ok) {
        console.warn(`[YouTubeNative] ${id}: ${msg.reason}`);
        return { ok: false, reason: String(msg.reason || ''), unplayable: !!msg.unplayable, live: !!msg.live, shorts: !!msg.shorts };
      }
      const url = `${this.core.getProtocol()}://${this.core.hostUrl}/yt-hls/master.m3u8?m=${msg.m}`;
      // Its captions, [startMs, durMs, text] each (see yt-resolve.js), for the world's player to show.
      const cues = (Array.isArray(msg.cues) ? msg.cues : []).filter(c => Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])) && typeof c[2] === 'string')
        .map(c => [Number(c[0]), Number(c[1]), c[2].slice(0, 300)]).sort((x, y) => x[0] - y[0]);
      const answer = { ok: true, url, height: Number(msg.height) || 0, title: String(msg.title || ''), cues, capsLate: !!msg.capsLate };
      console.log(`[YouTubeNative] ${id}: ${answer.height}p, looked up in ${Math.round(performance.now() - started)} ms.`);
      this.remember(key, answer);
      return answer;
    }

    /** Keeps a lookup: expired ones go, and the oldest past CACHE_MAX (captions and all). */
    remember(key, answer) {
      const now = Date.now();
      for (const [k, v] of this.cache) if (now - v.at >= CACHE_MS) this.cache.delete(k);
      this.cache.delete(key);
      this.cache.set(key, { at: now, answer });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
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
