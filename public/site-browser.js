/**
 * @fileoverview Browse: a site (Shoutcast's directory, or Tubi) in a BS Browser window beside the
 * playlist panel, for picking something to add by looking around the site itself.
 *
 * A small script is put on each page the window loads (a "runscript" action, again every second,
 * as the page changes under it). It tells the panel which page is open (Tubi's movie, episode and
 * series pages are what can be added), and on Shoutcast which station was played: the site plays
 * a station through its startPlayStation(station), which the script wraps. The page shows a bar
 * offering to add what was found, and the panel shows the same offer (see playlist-panel.js).
 *
 * Messages out (window.O.sendMessage), all with from: 'fvp-browse':
 *   { type: 'page', url, title }                 each time the page's address changes
 *   { type: 'station', id, name, genre }         a Shoutcast station was played
 *   { type: 'add', what }                        the page's Add button ('page' or 'station')
 * Messages in (BS Browser "postmessage" actions, as bsmessage events):
 *   { type: 'offer', text, add, extra }          shows the bar (add, extra: button labels; no text hides it)
 * @module public/site-browser
 */

var FireSiteBrowser = (() => {
  const SITES = {
    shoutcast: { url: 'https://directory.shoutcast.com/', name: 'Shoutcast' },
    tubi: { url: 'https://tubitv.com/', name: 'Tubi' }
  };
  /** The page's size in pixels, and how wide the window is in the world. */
  const PAGE_W = 1280;
  const PAGE_H = 800;
  const WIDTH_M = 1.6;
  /** As the screen's browser: a page this many pixels wide is 1 m at scale 1 (see core.js). */
  const PIXELS_PER_M = 1300;
  const INJECT_EVERY_MS = 1000;
  /** Once the page has the script, only a tiny check (and the volume) goes, this often. */
  const CHECK_EVERY_MS = 2000;
  /** The whole script is sent again every this many checks anyway, in case a page can't say it's gone. */
  const RESEND_EVERY = 5;

  // Put on each page. It runs once per page (window.__fvpBrowse), so the injection can repeat.
  const PAGE_SCRIPT = `(function () {
  if (window.__fvpBrowse) return;
  window.__fvpBrowse = true;
  function send(msg) {
    msg.from = 'fvp-browse';
    var json = JSON.stringify(msg), tries = 0;
    (function attempt() {
      if (window.O && typeof window.O.sendMessage === 'function') { try { window.O.sendMessage('app', json); } catch (e) {} return; }
      if (++tries < 200) setTimeout(attempt, 50);
    })();
  }
  // The panel stops sending this whole script once the page says it has it.
  send({ type: 'hello' });
  // The page's sound plays at the Fire Player's volume (window.__fvpSetVolume, from the panel):
  // each audio or video element's own volume is scaled by it, whatever the site sets.
  var level = 1;
  var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  function apply(el) { try { desc.set.call(el, Math.max(0, Math.min(1, (el.__fvpWant == null ? 1 : el.__fvpWant) * level))); } catch (e) {} }
  var made = [];
  if (desc && desc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true, enumerable: desc.enumerable,
      get: function () { return this.__fvpWant == null ? 1 : this.__fvpWant; },
      set: function (v) { this.__fvpWant = Number(v); apply(this); }
    });
    var play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (made.indexOf(this) < 0) { made.push(this); if (made.length > 50) made.shift(); }
      apply(this);
      return play.apply(this, arguments);
    };
  }
  window.__fvpSetVolume = function (v) {
    v = Math.max(0, Math.min(1, Number(v)));
    if (!isFinite(v) || v === level) return;
    level = v;
    made.forEach(apply);
    var els = document.querySelectorAll('audio,video');
    for (var i = 0; i < els.length; i++) apply(els[i]);
  };
  // A site that changes page without loading one (Tubi) sets the new title a moment later.
  var last = '', timer = 0;
  function checkPage() {
    if (location.href === last) return;
    last = location.href;
    clearTimeout(timer);
    timer = setTimeout(function () { send({ type: 'page', url: location.href, title: document.title }); }, 1200);
  }
  setInterval(checkPage, 700);
  checkPage();
  // Shoutcast plays a station with its own startPlayStation(station).
  var wrapped = false;
  function wrap() {
    if (wrapped || typeof window.startPlayStation !== 'function') return;
    wrapped = true;
    var play = window.startPlayStation;
    window.startPlayStation = function (st) {
      try { if (st && st.ID) send({ type: 'station', id: String(st.ID), name: String(st.Name || ''), genre: String(st.Genre || '') }); } catch (e) {}
      return play.apply(this, arguments);
    };
  }
  if (/shoutcast\\.com$/.test(location.hostname)) {
    wrap();
    var n = 0; var t = setInterval(function () { wrap(); if (wrapped || ++n > 60) clearInterval(t); }, 500);
    // A station's .m3u, .pls or .xspf download link would only download here: it offers the station.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href*="tunein-station"]');
      var m = a && /[?&]id=(\\d{1,12})/.exec(a.getAttribute('href') || '');
      if (!m) return;
      e.preventDefault(); e.stopPropagation();
      var row = a.closest('tr');
      var name = row && row.querySelector('td.radio-name');
      send({ type: 'station', id: m[1], name: name ? String(name.textContent || '').trim() : '', genre: '' });
    }, true);
  }
  // The offer bar, at the top of the page.
  var bar = null;
  function button(text, color, onClick) {
    var b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'margin-left:12px;padding:10px 22px;font:bold 22px sans-serif;border:0;border-radius:22px;color:#fff;cursor:pointer;background:' + color;
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); }, true);
    return b;
  }
  function offer(o) {
    if (bar) { bar.remove(); bar = null; }
    if (!o || !o.text) return;
    bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;display:flex;align-items:center;padding:12px 18px;background:rgba(21,101,192,0.96);color:#fff;font:22px sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.5)';
    var label = document.createElement('div');
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = o.text;
    bar.appendChild(label);
    if (o.add) bar.appendChild(button(o.add, '#2e7d32', function () { send({ type: 'add', what: o.what || 'page' }); }));
    if (o.extra) bar.appendChild(button(o.extra, '#6a1b9a', function () { send({ type: 'extra', what: o.what || 'page' }); }));
    bar.appendChild(button('\\u2715', '#455a64', function () { offer(null); }));
    (document.body || document.documentElement).appendChild(bar);
  }
  window.addEventListener('bsmessage', function (e) {
    // The action's text comes as e.detail.message.
    var msg = e && e.detail;
    if (msg && typeof msg === 'object' && 'message' in msg) msg = msg.message;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (err) { return; } }
    if (msg && msg.type === 'offer') offer(msg);
  });
})();`;

  return class {
    /**
     * @param {Object} core - The Core.
     * @param {Object} opts
     * @param {Object} opts.parent - The object the window is placed in (the panel's mover).
     * @param {Object} opts.position - Its place there (BS.Vector3), the window's middle.
     * @param {function(Object)} opts.onMessage - Gets each message from the page.
     * @param {function(): number} opts.getVolume - The Fire Player's volume (0-100), for the page's sound.
     */
    constructor(core, opts) {
      this.core = core;
      this.opts = opts;
      this.site = '';
      this.ready = this.create().catch(e => {
        console.warn('[SiteBrowser] Could not make the browser window:', e);
        this.failed = true;
        throw e;
      });
    }

    static sites() { return SITES; }

    async create() {
      const core = this.core;
      const k = WIDTH_M * PIXELS_PER_M / PAGE_W;
      const go = this.go = await core.makeObject('FireVPlayer_BrowseWindow', {
        parent: this.opts.parent, position: this.opts.position, rotation: new BS.Vector3(0, 0, 0),
        scale: new BS.Vector3(k, k, 1), layer: 5
      });
      if (this.destroyed) { core.destroyObject(go); return; }
      go.On('browser-message', e => this.onMessage(e));
      const url = 'about:blank';
      const component = this.component = await core.addComponent(go, core.bsComponent('Browser',
        { url, pageWidth: PAGE_W, pageHeight: PAGE_H, pixelsPerUnit: PIXELS_PER_M },
        'BanterBrowser', [url, false, PIXELS_PER_M, PAGE_W, PAGE_H, null]));
      if (this.destroyed) { core.destroyObject(go); return; }
      try { if (typeof component.ToggleInteraction === 'function') component.ToggleInteraction(true); } catch (e) {}
      // The whole script goes until the page says it has it ('hello'); after that only a tiny
      // check, which says when a new page has lost it ('gone'), and the volume. A busy page (a
      // headset's browser starting a stream) isn't sent 5 KB every second that way.
      this.scriptIn = false;
      let ticks = 0;
      const inject = () => {
        if (this.destroyed) return;
        // The page's sound follows the Fire Player's volume (see __fvpSetVolume in PAGE_SCRIPT).
        let volume = 1;
        try { volume = Math.max(0, Math.min(100, Number(this.opts.getVolume()))) / 100; } catch (e) {}
        if (!Number.isFinite(volume)) volume = 1;
        const actions = [];
        if (!this.scriptIn || ++ticks % RESEND_EVERY === 0) actions.push({ actionType: 'runscript', strParam1: PAGE_SCRIPT });
        actions.push({ actionType: 'runscript', strParam1: `window.__fvpBrowse?(window.__fvpSetVolume&&window.__fvpSetVolume(${volume})):(window.O&&O.sendMessage&&O.sendMessage('app','{"from":"fvp-browse","type":"gone"}'))` });
        try { component.RunActions(JSON.stringify({ actions })); } catch (e) {}
        this.injectTimer = setTimeout(inject, this.scriptIn ? CHECK_EVERY_MS : INJECT_EVERY_MS);
      };
      inject();
    }

    /** Opens a site ('shoutcast' or 'tubi') in the window. */
    async open(site) {
      const s = SITES[site];
      if (!s) return;
      this.site = site;
      await this.ready;
      if (this.component) this.component.url = s.url;
    }

    /** Shows the page's offer bar (see PAGE_SCRIPT), or hides it when `offer` is null. */
    offer(offer) {
      if (!this.component) return;
      const msg = Object.assign({ type: 'offer' }, offer || {});
      const json = JSON.stringify({ actions: [{ actionType: 'postmessage', strParam1: JSON.stringify(msg) }] });
      try { this.component.RunActions(json); } catch (e) {}
    }

    onMessage(e) {
      let msg = e && e.detail;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch (err) { return; }
      }
      if (!msg || typeof msg !== 'object' || msg.from !== 'fvp-browse') return;
      if (msg.type !== 'hello' && msg.type !== 'gone') console.log(`[SiteBrowser] From the page: ${msg.type}${msg.url ? ` ${String(msg.url).slice(0, 120)}` : ''}${msg.id ? ` ${msg.id}` : ''}`);
      if (msg.type === 'gone') { this.scriptIn = false; return; }
      if (msg.type === 'hello') { this.scriptIn = true; return; }
      try { this.opts.onMessage(msg); } catch (err) { console.warn('[SiteBrowser] Message failed:', err); }
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.injectTimer);
      const go = this.go;
      this.go = null;
      this.component = null;
      try { if (go) this.core.destroyObject(go); } catch (e) { console.warn('[SiteBrowser] Could not remove the window:', e); }
    }
  };
})();
window.FireSiteBrowser = FireSiteBrowser;
