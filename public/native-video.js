/**
 * @fileoverview Native in-world 3D video screen adapter for Banter / Unity.
 * Substitutes an embedded web browser with a native Unity `BanterVideoPlayer` component
 * rendered directly onto a 3D Plane mesh, bypassing CORS/cross-origin iframe barriers
 * while synchronizing playback with the server. A Bilibili video takes the same place as a web page
 * of its own (Bilibili's embed page in a BS Browser, run by a script on it: see PageVideo), synced
 * the same way.
 * @module public/native-video
 */

var FireNativeScreen = (() => {
  /** Default screen dimensions in meters [width, height] prior to snippet scale. */
  const DEFAULT_SIZE = [1, 0.5625];
  /** Polling interval in milliseconds to query Unity player state. */
  const POLL_MS = 1000;
  /** Property query timeout in milliseconds to prevent stalling. */
  const GET_TIMEOUT_MS = 3000;
  /** Maximum poll attempts to retrieve duration before giving up on live/unknown streams. */
  const DURATION_TRIES = 15;
  /** Periodic time synchronization interval in milliseconds. */
  const SYNC_EVERY_MS = 5000;
  /** Maximum allowable drift in seconds before hard-seeking to catch up. */
  const MAX_DRIFT_S = 1.0;
  /** The most a jump aims ahead to make up for the time the player takes to play again (see seekLead). */
  const MAX_SEEK_LEAD_S = 6;
  /** Cooldown in milliseconds after toggling playback state. */
  const TOGGLE_COOLDOWN_MS = 1500;
  /** Timeout in milliseconds before warning that video failed to prepare. */
  const PREPARE_TIMEOUT_MS = 20000;
  /** The same for WebM, which most often fails for its codec (VP9), and loads as fast as MP4 when it plays. */
  const WEBM_PREPARE_TIMEOUT_MS = 10000;
  /**
   * The same for YouTube, counted from the start of its lookup (youtube-native.js), which takes
   * a few seconds, and the video starts in about 2 s after that when it plays.
   */
  const YOUTUBE_PREPARE_TIMEOUT_MS = 20000;
  /**
   * A YouTube video whose time stands still this long while it should be playing is stalling.
   * STALLS of them within STALL_WINDOW_MS, or one of LONG_STALL_MS, drops it a quality for this viewer.
   */
  const STALL_MS = 2500, LONG_STALL_MS = 8000, STALLS = 3, STALL_WINDOW_MS = 60000;
  /** Not counted as stalls: the time just after it starts, a seek, or a play or pause. */
  const STALL_GRACE_MS = 6000;
  /**
   * How long a new track sits loaded at its first frame, paused, before this screen tells the room
   * it's ready (TRACK_READY), so it has some of the video in hand when everyone starts together
   * and doesn't stutter or skip in its first seconds. Longer on a standalone headset (a Quest).
   */
  const SETTLE_MS = 1500, SETTLE_STANDALONE_MS = 3000;
  /** Skip jump increment in seconds for standard and karaoke mode. */
  const SKIP_S = 5, SKIP_KARAOKE_S = 0.25;
  /**
   * An object in the world's Unity scene with this name (in any case) holds the video player: it's
   * made under it, so a Unity graph that knows the object can find the player and share its picture
   * (the Fire-V-Player video kit's Video Walls and Video Screens do). It must be at the world's
   * origin, unturned and unscaled, as the screen's place is given in world terms.
   */
  const HOME_NAME = 'fire-v-player world video';
  /**
   * The words over the screen while a track loads, or a karaoke song counts down (see
   * overlayState): a UI panel just in front of the picture, as the browser page that shows them
   * elsewhere is gone while this player is up. Laid out on OVERLAY_W pixels across, updated every
   * OVERLAY_TICK_MS. The numbers come in the last COUNTDOWN_NUMBERS_S, as on the browser page.
   */
  const OVERLAY_W = 1600, OVERLAY_TICK_MS = 200, COUNTDOWN_NUMBERS_S = 3;
  /** How long after a countdown its video must be moving, and how often it's nudged if not (see watchStart). */
  const START_CHECK_MS = 3000, START_KICKS = 2;
  /**
   * How long after a track's player is made, and after a countdown lets it go, every step of its
   * start is logged (see trace): what the page asked of Unity and what Unity said back.
   */
  const TRACE_MS = 20000;
  /**
   * Warming (see warmUp): a video that has loaded while a countdown holds it plays muted through
   * the countdown instead of waiting paused at its first frame, as Unity's player sometimes then
   * plays its sound over a black picture. WARM_REWIND_MS before the countdown ends it jumps back to
   * its start (still muted): such a jump took about 1.3 s to play again on PC, so it's playing from
   * the start as the countdown ends and its sound comes on. The server starts a track 2 s after
   * every screen has loaded it (READY_LEAD_S), which leaves room for that. With less than
   * WARM_MIN_MS of the countdown left once it has loaded, it waits paused as before.
   */
  const WARM_REWIND_MS = 1500, WARM_MIN_MS = 2000;

  /**
   * Put on Bilibili's embed page (player.bilibili.com/player.html) when it's the screen's page (see
   * PageVideo). It runs once per page (window.__fvpBili), so the injection can repeat. The page's
   * own player object (window.player) does the playing: what's wanted (play, volume, a seek) comes
   * from set(), and the page reports its time and state every half second (O.sendMessage). Its
   * title, controls, comments and end screen are hidden, and a cover takes every click, so nobody's
   * click pauses or seeks one screen only; a click on the cover is a gesture that lets it play.
   */
  const BILIBILI_SCRIPT = `(function () {
  if (window.__fvpBili) return;
  var want = { play: false, volume: 1, seek: 0, seekN: 0 }, seekN = 0, blocked = '';
  function send(o) {
    o.from = 'fvp-bili';
    try { if (window.O && typeof window.O.sendMessage === 'function') window.O.sendMessage('app', JSON.stringify(o)); } catch (e) {}
  }
  function player() { var p = window.player; return p && typeof p.play === 'function' && typeof p.getCurrentTime === 'function' ? p : null; }
  function video() { return document.querySelector('video'); }
  function paused(p, v) { try { return typeof p.isPaused === 'function' ? !!p.isPaused() : v.paused; } catch (e) { return v.paused; } }
  function apply() {
    var p = player(), v = video();
    if (!p || !v) return;
    try { if (Math.abs(Number(p.getVolume()) - want.volume) > 0.001) p.setVolume(want.volume); } catch (e) {}
    if (want.seekN > seekN) { seekN = want.seekN; try { p.seek(want.seek); } catch (e) {} }
    var now = paused(p, v);
    if (want.play && now && !v.ended) {
      try {
        var r = p.play();
        if (r && typeof r.then === 'function') r.then(function () { blocked = ''; }, function (e) { blocked = String((e && e.name) || e); });
      } catch (e) { blocked = String((e && e.name) || e); }
    } else if (!want.play && !now) {
      try { p.pause(); } catch (e) {}
    }
  }
  function report() {
    var p = player(), v = video();
    var dur = 0, t = 0;
    try { dur = Number(p && p.getDuration()) || 0; t = Number(p && p.getCurrentTime()) || 0; } catch (e) {}
    /* Ready once it has a frame to show (HAVE_CURRENT_DATA), not just its length. */
    send({ type: 'state', ready: !!(p && v && v.readyState >= 2), t: t, dur: dur,
      paused: !p || !v || paused(p, v), ended: !!(v && v.ended), blocked: blocked });
  }
  function dress() {
    if (!document.head || !document.body) return false;
    var css = document.createElement('style');
    css.textContent = '.bpx-player-top-wrap,.bpx-player-control-wrap,.bpx-player-state-wrap,.bpx-player-ending-wrap,'
      + '.bpx-player-toast-wrap,.bpx-player-sending-area,.bpx-player-row-dm-wrap,.bpx-player-adv-dm-wrap,'
      + '.bpx-player-bas-dm-wrap,.bpx-player-cmd-dm-wrap,.bpx-player-share-panel,.bpx-player-relation-wrap,'
      + '.bpx-player-enter-button{display:none!important}';
    document.head.appendChild(css);
    var cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:transparent';
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu', 'wheel'].forEach(function (n) {
      cover.addEventListener(n, function (e) { e.preventDefault(); e.stopPropagation(); if (n === 'click') apply(); }, true);
    });
    document.body.appendChild(cover);
    return true;
  }
  window.__fvpBili = { set: function (w) { if (w && typeof w === 'object') want = w; apply(); report(); } };
  var dressed = dress();
  setInterval(function () { if (!dressed) dressed = dress(); apply(); report(); }, 500);
  send({ type: 'hello' });
})();`;

  /** Bilibili's embed page for a detected video, paused at its start (PageVideo starts it). */
  function bilibiliEmbed(media) {
    const id = String(media.id || '');
    const key = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${encodeURIComponent(id)}`;
    return `https://player.bilibili.com/player.html?${key}&p=${media.part || 1}&autoplay=0&danmaku=0&high_quality=1`;
  }

  /**
   * A web page's video as the world's video player would be (time, volume, PlayToggle, and the
   * state readState reads), for a video that plays as the screen's own page: a Bilibili video, in
   * Bilibili's embed page in a BS Browser, run by BILIBILI_SCRIPT. The page is sent what's wanted
   * every couple of seconds as well as on each change, so a reloaded page catches up.
   */
  class PageVideo {
    constructor(go, component, volume, play) {
      this.go = go;
      this.component = component;
      this.want = { play: !!play, volume: Number(volume) || 0, seek: 0, seekN: 0 };
      this.reported = { ready: false, t: 0, dur: 0, paused: true, ended: false };
      this.t = 0;
      this.seekAt = -Infinity;
      this.scriptIn = false;
      this.clickedAt = -Infinity;
      this.hellos = 0;
      go.On('browser-message', e => this.onMessage(e));
      this.tick();
    }

    get time() { return this.t; }
    set time(t) {
      this.t = Math.max(0, Number(t) || 0);
      this.want.seek = this.t;
      this.want.seekN++;
      this.seekAt = performance.now();
      this.reported.ended = false; // until the page says so again, from where it went
      this.push();
    }
    get volume() { return this.want.volume; }
    set volume(v) {
      this.want.volume = Math.max(0, Math.min(1, Number(v) || 0));
      this.push();
    }
    /** Plays if it says it's paused, and pauses if it says it's playing (as the world's player does). */
    PlayToggle() {
      this.want.play = !this.read('isPlaying');
      this.push();
    }
    WatchProperties() {}
    /** What readState asks for: isPlaying, isPrepared or duration. */
    read(name) {
      const r = this.reported;
      if (name === 'isPlaying') return r.ready && !r.paused && !r.ended;
      if (name === 'isPrepared') return r.ready;
      if (name === 'duration') return r.dur;
      return undefined;
    }
    /** The page's picture as a texture second screens (and so the Video Walls) can show. */
    textureId() {
      const id = this.component && this.component.unityId;
      return id != null && id !== '' ? `asset_browser_${id}` : null;
    }

    run(scripts) {
      if (this.destroyed) return;
      const actions = scripts.map(s => ({ actionType: 'runscript', strParam1: s }));
      try { this.component.RunActions(JSON.stringify({ actions })); } catch (e) {}
    }
    setScript() { return `window.__fvpBili&&window.__fvpBili.set(${JSON.stringify(this.want)})`; }
    push() { this.run([this.setScript()]); }

    /** The whole script until the page says it has it, then what's wanted (and whether it's lost it). */
    tick() {
      if (this.destroyed) return;
      const scripts = [];
      if (!this.scriptIn) scripts.push(BILIBILI_SCRIPT);
      scripts.push(`window.__fvpBili?window.__fvpBili.set(${JSON.stringify(this.want)}):(window.O&&O.sendMessage&&O.sendMessage('app','{"from":"fvp-bili","type":"gone"}'))`);
      this.run(scripts);
      this.timer = setTimeout(() => this.tick(), this.scriptIn ? 2000 : 1000);
    }

    onMessage(e) {
      let msg = e && e.detail;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (err) { return; } }
      if (!msg || typeof msg !== 'object' || msg.from !== 'fvp-bili' || this.destroyed) return;
      if (msg.type === 'hello') {
        this.scriptIn = true;
        this.push();
        // A page loaded again (not the first): it starts over, so the screen goes to where the world is.
        if (this.hellos++ && typeof this.onFresh === 'function') this.onFresh();
        return;
      }
      if (msg.type === 'gone') { this.scriptIn = false; return; }
      if (msg.type !== 'state') return;
      const r = this.reported;
      r.ready = msg.ready === true;
      r.dur = Number(msg.dur) > 0 ? Number(msg.dur) : 0;
      r.paused = msg.paused !== false;
      r.ended = msg.ended === true;
      // Its time, except a report from before a seek of ours reached it.
      const t = Number(msg.t);
      if (Number.isFinite(t) && (performance.now() - this.seekAt > 1500 || Math.abs(t - this.want.seek) < 1.5)) this.t = Math.max(0, t);
      // The browser wants a gesture before it plays sound: a click on the page's cover is one (at
      // most every few seconds, while it should be playing and isn't).
      if (msg.blocked && this.want.play && r.paused && performance.now() - this.clickedAt > 4000) {
        this.clickedAt = performance.now();
        console.log(`[NativeScreen] The page couldn't start playing (${msg.blocked}), so it gets a click.`);
        const [w, h] = [Number(this.component.pageWidth) || 1280, Number(this.component.pageHeight) || 720];
        try { this.component.RunActions(JSON.stringify({ actions: [{ actionType: 'click2d', numParam1: Math.round(w / 2), numParam2: Math.round(h / 2) }] })); } catch (err) {}
      }
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.timer);
    }
  }

  /**
   * Controller class managing the lifecycle of an in-world native video screen.
   */
  return class {
    /**
     * @param {Object} core - Core FirePlayer instance.
     * @param {string} link - Direct video file or stream URL.
     */
    constructor(core, link) {
      this.core = core;
      this.link = link;
      // A YouTube video plays from the HLS playlists this viewer's own lookup gives (see create).
      this.youtubeId = typeof MediaSources !== 'undefined' ? MediaSources.youtubeId(link) || null : null;
      // A Bilibili video plays as the screen's own page instead: Bilibili's embed page in a BS
      // Browser, run by a script on it (see PageVideo).
      const detected = typeof MediaSources !== 'undefined' ? MediaSources.detect(link) : null;
      this.bilibili = detected && detected.type === 'bilibili' ? detected : null;
      this.destroyed = false;
      this.prepared = false;
      // The viewer's Auto Sync choice (off unless they turn it on, as on the browser screen). Off,
      // the file still goes to where the world is when it loads, on a host seek, a track change
      // and a resume (see settle), but isn't pulled back into step every few seconds.
      this.autoSync = core.autoSync === true;
      this.settleLeft = 0;    // checks still to make that a forced jump landed where the world is
      this.wantPaused = !this.isPreview() && !!(core.player && core.player.paused);
      this.volume = Number.isFinite(Number(core.tempVolume)) ? Number(core.tempVolume) : Number(core.params.volume);
      this.muted = core.params.mute === 'true' || core.params.mute === true;
      this.baseTime = 0;      // where the video was at baseAt (performance.now())
      this.baseAt = performance.now();
      this.lastToggleAt = -Infinity;
      this.pendingSync = null;
      this.hostSyncPending = false; // a host seek or track change waiting for its sync (resync)
      this.holdUntil = 0;     // held at its start until then (performance.now()): a karaoke countdown
      // How long this app's player takes to play again after a seek (about 2s where it loads the
      // file anew), learnt from jumps that came up short. Jumps aim that far ahead: without it
      // every jump lands that far behind, which is out of step again, so it jumps for ever.
      this.seekLead = Number(core.nativeSeekLead) || 0; // kept on the core, so the next file starts with it
      this.lastJumpAt = -Infinity;
      // Played as a viewer's preview: back on the room's track it's made again (see core.js updateScreen).
      this.previewed = this.isPreview();
      this.startedAt = performance.now(); // a YouTube video's deadline counts its lookup too (see create)
      this.traceFrom = performance.now();
      this.traceUntil = this.traceFrom + TRACE_MS;
      this.holdFromCore();
      this.ready = this.create().catch(e => {
        console.error('[NativeScreen] Could not set up the video player.', e);
        if (this.destroyed) return;
        // The loading words go, and the browser plays it instead (its own toast says so).
        this.overlayDone = true;
        clearInterval(this.overlayTimer);
        this.showOverlay(false);
        if (typeof this.core.playFileInBrowser === 'function') this.core.playFileInBrowser(this.link, 'setup failed');
        else this.core.showToast("Couldn't start the world's video player.", 6000);
      });
    }

    /**
     * Parses the configured screen dimensions from snippet params or returns default.
     * @returns {[number, number]} Width and height in meters.
     */
    size() {
      // A page is the browser screen's size (see core.js browserScale).
      if (this.bilibili) return [SCREEN_WIDTH_M, SCREEN_WIDTH_M * 9 / 16];
      const parts = String(this.core.params['native-screen-size'] || '').trim().split(/\s+/).map(Number);
      return parts.length === 2 && parts.every(n => n > 0) ? parts : DEFAULT_SIZE;
    }

    /**
     * Logs a step of the track's start, while TRACE_MS lasts (from the player's making, or from a
     * countdown letting it go): seconds since the player was made, then what happened.
     * @param {string} what
     */
    trace(what) {
      if (performance.now() > this.traceUntil) return;
      console.log(`[NativeScreen] +${((performance.now() - this.traceFrom) / 1000).toFixed(2)}s ${what}`);
    }

    /**
     * Instantiates the in-world GameObject, attaches Plane mesh, Material, and BanterVideoPlayer.
     * @returns {Promise<void>}
     */
    async create() {
      const core = this.core;
      if (!core.inWorld()) throw new Error('No BS SDK scene.');
      if (this.bilibili ? !(BS.Browser || BS.BanterBrowser) : !(BS.VideoPlayer || BS.BanterVideoPlayer)) throw new Error('No BS SDK video player or browser.');
      // In the browser screen's place, under the world's video home if it has one (see HOME_NAME).
      // Made first, so its words ("Loading...") show while a YouTube video is looked up.
      const t = core.screenTransform();
      const home = this.findHome();
      const go = this.go = await core.makeObject('FireVPlayer_VideoScreen', { parent: home || undefined, position: t.position, rotation: t.rotation, scale: t.scale });
      if (this.destroyed) { core.destroyObject(go); return; }
      this.overlayTimer = setInterval(() => { this.updateOverlay(); this.updateCaptions(); }, OVERLAY_TICK_MS);
      this.updateOverlay();
      // The lookup failed: the browser plays it, and these words go.
      const toBrowser = (why) => {
        this.overlayDone = true;
        clearInterval(this.overlayTimer);
        this.showOverlay(false);
        core.playFileInBrowser(this.link, why);
      };
      if (this.bilibili) {
        await this.createPage(go);
        return;
      }
      // YouTube: this viewer's own streams first. Each viewer looks a video up for themselves, as
      // YouTube ties the addresses to whoever asked; the room shares only the link and the time.
      let url = this.link;
      if (this.youtubeId) {
        this.maxHeight = core.youtubeMaxHeight();
        // One deadline for the lookup and the loading: past it the browser plays it, and a lookup
        // that answers later is ignored.
        let late;
        const left = YOUTUBE_PREPARE_TIMEOUT_MS - (performance.now() - this.startedAt);
        const found = await Promise.race([
          core.youtubeResolver().resolve(this.youtubeId, this.maxHeight),
          new Promise(resolve => { late = setTimeout(() => resolve(null), Math.max(0, left)); })
        ]);
        clearTimeout(late);
        if (this.destroyed) return;
        if (!found) {
          this.warned = true;
          console.warn(`[NativeScreen] ${this.link} wasn't looked up after ${YOUTUBE_PREPARE_TIMEOUT_MS / 1000}s.`);
          toBrowser('not loaded in time');
          return;
        }
        if (!found.ok) {
          // Live streams, Shorts, and anything else it can't play go to YouTube's own player.
          toBrowser(found.live ? 'live' : found.shorts ? 'shorts' : found.reason);
          return;
        }
        this.height = found.height;
        url = found.url;
        // The same deadline covers making the player: one whose setup never finishes goes to the
        // browser too (poll's check takes over once the player exists).
        this.setupTimer = setTimeout(() => {
          if (this.destroyed || this.vp || this.warned) return;
          this.warned = true;
          console.warn(`[NativeScreen] ${this.link} wasn't set up after ${YOUTUBE_PREPARE_TIMEOUT_MS / 1000}s.`);
          toBrowser('not loaded in time');
        }, Math.max(0, YOUTUBE_PREPARE_TIMEOUT_MS - (performance.now() - this.startedAt)));
        // Its captions, shown over the picture while the viewer has captions on (see updateCaptions).
        this.cues = Array.isArray(found.cues) ? found.cues : [];
      }
      const [w, h] = this.size();
      // The plane's renderer has to exist before the video player, which draws onto its material.
      await core.addComponent(go, core.bsComponent('Plane', { width: w, height: h }, 'BanterPlane', [w, h]));
      await core.addComponent(go, core.bsComponent('Material', { shaderName: 'Unlit/Diffuse' }, 'BanterMaterial', ['Unlit/Diffuse']));
      if (this.destroyed || (this.youtubeId && this.warned)) return;
      const settings = { url, volume: this.unityVolume(), loop: false, playOnAwake: !this.wantPaused && !this.held(), skipOnDrop: true, waitForFirstFrame: true };
      const vp = await core.addComponent(go, core.bsComponent('VideoPlayer', settings,
        'BanterVideoPlayer', [settings.url, settings.volume, settings.loop, settings.playOnAwake, settings.skipOnDrop, settings.waitForFirstFrame]));
      clearTimeout(this.setupTimer);
      if (this.destroyed || (this.youtubeId && this.warned)) return;
      this.vp = vp;
      this.trace(`made the player: playOnAwake ${settings.playOnAwake}, volume ${settings.volume}, held ${this.held()}, wantPaused ${this.wantPaused}`);
      // time only reaches the page when watched. The other read-only values (isPrepared,
      // isPlaying, duration) keep their first value unless asked for with GetProperty, which
      // poll() does (see readState).
      const P = BS.PN || BS.PropertyName;
      try { vp.WatchProperties([P.time]); } catch (e) {}
      if (!this.youtubeId) this.startedAt = performance.now();
      this.startPolling();
      console.log(`[NativeScreen] Playing ${this.link}${this.youtubeId ? ` (${this.height}p)` : ''} on the world's video player.`);
    }

    /** Starts reading the player's state, and Auto Sync's checks. */
    startPolling() {
      this.state = { isPrepared: false, isPlaying: false, duration: 0 };
      this.lastRaw = this.vp.time;
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
      this.syncTimer = setInterval(() => { if (this.autoSync && !this.wantPaused) this.requestSync(false); }, SYNC_EVERY_MS);
    }

    /**
     * A Bilibili video: Bilibili's embed page in a BS Browser where the browser screen would be, the
     * same size (the player page's browser is gone meanwhile, so it's the only one). A script on the
     * page plays it (see PageVideo), so it syncs, pauses, seeks and takes the volume like a file on
     * the world's video player. Its picture is the browser's texture, for second screens and the
     * Video Walls. A page that doesn't load in time goes to the player page instead (core.js
     * playFileInBrowser), where Bilibili plays in a frame.
     * @param {Object} go - This screen's object.
     */
    async createPage(go) {
      const core = this.core;
      const [w, h] = core.screenPageSize();
      const holder = this.pageGo = await core.makeObject('FireVPlayer_ScreenPage', {
        parent: go, position: new BS.Vector3(0, 0, 0), rotation: new BS.Vector3(0, 0, 0), scale: this.pageScale(w), layer: LAYER_UI
      });
      if (this.destroyed) return;
      const url = bilibiliEmbed(this.bilibili);
      const mips = core.params['mip-maps'];
      const component = await core.addComponent(holder, core.bsComponent('Browser',
        { url, pageWidth: w, pageHeight: h, mipMaps: mips, pixelsPerUnit: SCREEN_PIXELS_PER_M },
        'BanterBrowser', [url, mips, SCREEN_PIXELS_PER_M, w, h, null]));
      if (this.destroyed) return;
      // As the browser screen's: the same volume everywhere, and core.js applyAudio places it.
      if ('rolloffMode' in component || core.modernSdk()) component.rolloffMode = 0;
      this.pageSize = [w, h];
      this.vp = new PageVideo(holder, component, this.unityVolume(), !this.wantPaused && !this.held());
      this.vp.onFresh = () => { if (!this.destroyed) this.requestSync(true); };
      this.applyResolution(); // the viewer may have changed it while the page was being made
      this.startedAt = performance.now();
      this.startPolling();
      core.applyAudio(true);
      console.log(`[NativeScreen] Playing ${this.link} as the screen's own page (Bilibili's player).`);
    }

    /** The page's scale under this screen's object: the browser screen's, without the snippet's own scale. */
    pageScale(width) {
      const k = SCREEN_WIDTH_M * SCREEN_PIXELS_PER_M / width;
      return new BS.Vector3(k, k, 1);
    }

    /** A Bilibili page takes the viewer's new screen resolution, keeping its size in the world. */
    applyResolution() {
      const component = this.vp && this.vp.component;
      if (!this.bilibili || !component) return;
      const [w, h] = this.core.screenPageSize();
      if (this.pageSize && this.pageSize[0] === w) return;
      this.pageSize = [w, h];
      component.pageWidth = w;
      component.pageHeight = h;
      try { if (this.pageGo && typeof this.pageGo.SetLocalScale === 'function') this.pageGo.SetLocalScale(this.pageScale(w)); } catch (e) {}
    }

    /**
     * The scene's "Fire-V-Player World Video" object (see HOME_NAME), or null. The page knows every
     * object with a BS component; the home has a BS Object Id for that.
     * @returns {Object|null}
     */
    findHome() {
      try {
        const scene = this.core.banterScene();
        const home = Object.values((scene && scene.objects) || {})
          .find(go => go && String(go.name || '').trim().toLowerCase() === HOME_NAME);
        if (home) console.log('[NativeScreen] Playing under the world\'s video home, so the world can share the picture.');
        return home || null;
      } catch (e) {
        return null;
      }
    }

    /**
     * Queries Unity for component state (`isPlaying`, `isPrepared`, `duration`).
     * @returns {Promise<void>}
     */
    async readState() {
      const vp = this.vp;
      const P = BS.PN || BS.PropertyName;
      if (!vp || (!P && typeof vp.read !== 'function')) return;
      const get = (name) => {
        if (typeof vp.read === 'function') return Promise.resolve(vp.read(name)); // a page's video (PageVideo)
        if (typeof vp.GetProperty !== 'function') return Promise.resolve(vp[name]);
        // No answer (an error or a timeout) leaves that value as it was: the component's own field
        // is stale, so it isn't used as a reading.
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve(undefined), GET_TIMEOUT_MS);
          const done = v => { clearTimeout(timer); resolve(v); };
          try { Promise.resolve(vp.GetProperty(P[name])).then(done, () => done(undefined)); } catch (e) { done(undefined); }
        });
      };
      const names = ['isPlaying'];
      if (!this.state.isPrepared) names.push('isPrepared');
      // A file that hasn't given its length a while after loading won't, so stop asking.
      if (!(this.state.duration > 0) && (this.durationTries || 0) < DURATION_TRIES) {
        names.push('duration');
        if (this.prepared) this.durationTries = (this.durationTries || 0) + 1;
      }
      const values = await Promise.all(names.map(get));
      if (this.destroyed || vp !== this.vp) return;
      const said = names.map((n, i) => `${n} ${values[i]}`).join(', ');
      if (said !== this.lastSaid) { this.lastSaid = said; this.trace(`Unity says ${said} (time ${vp.time})`); }
      names.forEach((n, i) => {
        const v = values[i];
        if (v === undefined || v === null) return;
        if (n === 'duration') { const d = Number(v); this.state.duration = Number.isFinite(d) && d > 0 ? d : 0; }
        else this.state[n] = v === true || v === 'true' || v === 1;
      });
      // Stopped by itself while it should be playing: the file has ended. Without a length that's
      // the only way to tell, and playing again would start it over, so it stays stopped until
      // someone seeks, skips or changes track. Only a stop after Unity itself said it was playing
      // since the last toggle counts, so a reading that hasn't caught up with a toggle doesn't.
      const isPlaying = names.indexOf('isPlaying');
      const reported = isPlaying >= 0 && values[isPlaying] !== undefined && values[isPlaying] !== null;
      // A Bilibili page says when its video has ended; not playing there is a pause, a reload or a wait.
      if (typeof vp.read === 'function') {
        if (vp.reported && vp.reported.ended && this.endedAt == null && !this.wantPaused) this.endedAt = this.localTimeAt(true);
        else if (reported && this.state.isPlaying) this.seenPlaying = true;
        return;
      }
      if (reported && this.state.isPlaying) this.seenPlaying = true;
      // A YouTube video stops by itself while it waits for more of the stream too, so there only
      // a stop near its end is the end, and with no known length it never is (the server moves on).
      else if (reported && this.seenPlaying && !this.wantPaused && this.endedAt == null
        && (!this.youtubeId || (this.duration() > 0 && this.localTimeAt(true) >= this.duration() - 3))) {
        this.endedAt = this.localTimeAt(true);
      }
    }

    /**
     * Periodic poll handler querying Unity properties and updating base clock.
     * @returns {Promise<void>}
     */
    async poll() {
      if (!this.vp || this.destroyed || this.polling) return;
      this.polling = true;
      try { await this.readState(); } finally { this.polling = false; }
      const vp = this.vp;
      if (!vp || this.destroyed) return;
      const now = performance.now();
      // Unity sends the time once a second, as each second starts, so it is exact when it arrives.
      if (vp.time !== this.lastRaw) {
        this.trace(`Unity's time ${this.lastRaw} -> ${vp.time}`);
        this.lastRaw = vp.time;
        this.lastTimeAt = now;
        this.baseTime = Number(vp.time) || 0;
        this.baseAt = now;
        this.lastMovedAt = now;
      }
      // Loaded once Unity says so, or once the time starts moving (in case it never does).
      // A page's video only once it says it has a frame: its length can come first.
      const page = typeof vp.read === 'function';
      if (!this.prepared && (this.state.isPrepared || (!page && this.state.duration > 0) || Number(vp.time) > 0)) {
        this.prepared = true;
        this.trace(`prepared (isPrepared ${this.state.isPrepared}, duration ${this.state.duration}, time ${vp.time})`);
        this.core.syncSecondScreens(); // its picture is a texture they can show now (see textureId)
        this.reportDuration();
        this.requestSync(true); // start where everyone else is
        this.reportReadySoon();
      }
      // Not loaded in time: the browser tries it instead (it plays more formats). WebM gets less
      // time, as Unity's player takes only VP8 WebM on PC, and most WebM now is VP9.
      // The path only, as core.js's wantsNativeScreen reads it, so a query can't make a link look like WebM.
      const u = typeof MediaSources !== 'undefined' ? MediaSources.parseUrl(String(this.link)) : null;
      const webm = !!u && /\.webm$/i.test(u.pathname);
      const timeout = this.youtubeId ? YOUTUBE_PREPARE_TIMEOUT_MS : webm ? WEBM_PREPARE_TIMEOUT_MS : PREPARE_TIMEOUT_MS;
      if (!this.prepared && now - this.startedAt > timeout && !this.warned) {
        this.warned = true;
        console.warn(`[NativeScreen] ${this.link} hasn't loaded after ${timeout / 1000}s.`);
        if (typeof this.core.playFileInBrowser === 'function') this.core.playFileInBrowser(this.link, this.youtubeId ? 'not loaded in time' : undefined);
        else this.core.showToast("This file won't load on the world's video player. The link may be wrong, or the format unsupported.", 8000);
      }
      if (this.prepared) {
        if (!this.durationReported) this.reportDuration(); // the length may come later than the first frame
        this.warmUp();
        this.applyPaused();
        if (this.youtubeId) this.watchStalls(now);
      }
    }

    /**
     * YouTube only: whether the video keeps stalling for this viewer (its time standing still while
     * it should be playing), and if so, a quality down (core.js dropYouTubeQuality). The world's
     * player says nothing of buffering, so the time is all there is to go by.
     * @param {number} now - performance.now()
     */
    watchStalls(now) {
      if (this.stallsDone) return;
      if (this.preparedAt == null) this.preparedAt = now;
      if (this.lastMovedAt == null) this.lastMovedAt = now;
      const d = this.duration();
      const calm = now - Math.max(this.preparedAt, this.lastPlayPauseAt || -Infinity, this.lastSeekAt || -Infinity) > STALL_GRACE_MS;
      const shouldPlay = calm && !this.wantPaused && !this.held() && this.endedAt == null && !(d && this.localTimeAt(false) >= d - 2);
      const still = now - this.lastMovedAt;
      if (!shouldPlay || still < STALL_MS) {
        this.inStall = false;
        return;
      }
      if (!this.inStall) {
        this.inStall = true;
        this.stalls = (this.stalls || []).filter(t => now - t < STALL_WINDOW_MS);
        this.stalls.push(now);
        console.log(`[NativeScreen] Stalling at ${this.height}p (${this.stalls.length} in the last minute).`);
      }
      if (this.stalls.length >= STALLS || still >= LONG_STALL_MS) {
        this.stallsDone = true;
        this.core.dropYouTubeQuality(this.height);
      }
    }

    /**
     * The SDK's name for this video's picture as a texture other materials can show (see
     * core.js's second screens): "asset_video_" and the video player's id, from its first frame
     * on. Null before that, and on a client whose video player has no such texture.
     * @returns {string|null}
     */
    textureId() {
      if (this.vp && typeof this.vp.textureId === 'function') return this.prepared ? this.vp.textureId() : null;
      const id = this.vp && this.vp.unityId;
      return this.prepared && id != null && id !== '' ? `asset_video_${id}` : null;
    }

    /** Gets media duration in seconds. @returns {number} */
    duration() { return this.state && this.state.duration > 0 ? this.state.duration : 0; }
    /** Checks if video is currently actively playing. @returns {boolean} */
    playing() { return !!(this.vp && this.state && this.state.isPlaying); }
    /** Gets extrapolated local playback timestamp. @returns {number} */
    localTime() { return this.localTimeAt(this.playing()); }

    /**
     * Calculates extrapolated timestamp given playing status.
     * @param {boolean} playing - Whether video is currently advancing.
     * @returns {number} Time in seconds.
     */
    localTimeAt(playing) {
      if (this.endedAt != null) return this.endedAt;
      const t = this.baseTime + (playing ? (performance.now() - this.baseAt) / 1000 : 0);
      const d = this.duration();
      return d ? Math.min(t, d) : t;
    }

    /** True when this screen is playing a viewer's local karaoke preview rather than the room's track. */
    isPreview() {
      return !!(this.core.previewVideo && this.core.previewVideo.link === this.link);
    }

    /** Reports media duration to server via MEDIA_DURATION command. */
    reportDuration() {
      if (this.isPreview()) return;
      const d = this.duration();
      if (!d) return;
      this.durationReported = true;
      const track = this.currentTrack();
      if (track && track.link === this.link && !track.duration) {
        // native: from the world's video player, over the space page's socket (see the server's setMediaDuration).
        this.core.sendMessage({ path: Commands.MEDIA_DURATION, data: { link: this.link, duration: d, native: true } });
      }
    }

    /** Gets active track object from player state. @returns {Object|null} */
    currentTrack() {
      const p = this.core.player;
      return p && Array.isArray(p.playlist) ? p.playlist[p.currentTrack] : null;
    }

    /**
     * Tells the room this screen has the track loaded (see the server's holdForReady), once it
     * has settled at its first frame for SETTLE_MS. Over the space page's socket, as the world's
     * video player has no page of its own. A track that isn't waiting for anyone is ignored there.
     */
    reportReadySoon() {
      if (this.isPreview()) return;
      clearTimeout(this.readyTimer);
      const standalone = typeof this.core.isStandaloneDevice === 'function' && this.core.isStandaloneDevice();
      // The start this is for (see App.trackReady): a restart of the same song is a new wait.
      const start = this.core.player ? Number(this.core.player.lastStartTime) : NaN;
      const send = () => {
        if (this.destroyed || !this.prepared || this.isPreview()) return;
        const track = this.currentTrack();
        if (!track || track.link !== this.link) return;
        // The same start still: a newer one gets its own report.
        const now = this.core.player ? Number(this.core.player.lastStartTime) : NaN;
        if (Number.isFinite(start) && now !== start) return;
        // Not connected (a reconnect): sent again once it is, so the room isn't kept waiting.
        if (!this.core.sendMessage({ path: Commands.TRACK_READY, data: Object.assign({ link: this.link, native: true }, Number.isFinite(start) ? { start } : {}) })) {
          this.readyTimer = setTimeout(send, 1000);
        }
      };
      this.readyTimer = setTimeout(send, standalone ? SETTLE_STANDALONE_MS : SETTLE_MS);
    }

    /**
     * Whether this player has played the file away from its start. Held at the start again, Unity's
     * player on Quest then plays its sound with a black picture, so a countdown makes it anew.
     * @returns {boolean}
     */
    hasPlayed() {
      return this.previewed || (this.prepared && !this.warming && (this.endedAt != null || this.localTime() > 0.5));
    }

    /**
     * What the words over the screen should say now, or null for none (see OVERLAY_W): a karaoke
     * countdown, or that the track is still loading or waiting for the room to load it.
     * @returns {{key: string, big: string, top: string, bottom: string, karaoke: boolean}|null}
     */
    overlayState() {
      if (this.destroyed) return null;
      const preview = this.isPreview();
      const track = preview ? this.core.previewVideo : this.currentTrack();
      const title = (track && track.title) || '';
      const karaoke = this.core.isKaraoke === true && !preview;
      if (karaoke && this.held()) {
        const left = Math.ceil((this.holdUntil - performance.now()) / 1000);
        const singer = track && track.user && track.user.name;
        const big = left <= COUNTDOWN_NUMBERS_S ? String(Math.max(1, left)) : '';
        return { key: `k|${big}|${title}|${singer || ''}`, karaoke: true, top: singer ? `Now singing: ${singer}` : '', big, bottom: big ? title : `Get ready\n${title}` };
      }
      if (!this.prepared) return { key: `l|${title}|${karaoke}`, karaoke, top: '', big: 'Loading...', bottom: title };
      if (this.held()) return { key: `w|${title}`, karaoke, top: '', big: 'Starting soon', bottom: 'Waiting for everyone to load it' };
      return null;
    }

    /** Puts up, changes or takes down the words over the screen (see overlayState). */
    updateOverlay() {
      if (this.destroyed || !this.go || this.overlayDone) return;
      const want = this.overlayState();
      const key = want ? want.key : '';
      if (key === this.overlayKey) return;
      if (!want && !this.overlay) { this.overlayKey = key; return; }
      if (this.overlayBuilding) return; // the next tick picks it up
      this.overlayKey = key;
      if (!want) { this.showOverlay(false); return; }
      this.overlayBuilding = true;
      this.buildOverlay().then(o => {
        if (!o || this.destroyed) return;
        if (this.overlayDone) { this.showOverlay(false); return; } // gone to the browser meanwhile
        // What's wanted may have changed while the panel was being made: put up only what's
        // still wanted, and let the next tick show whatever is now.
        const now = this.overlayState();
        if (!now || now.key !== want.key) {
          this.overlayKey = undefined;
          this.showOverlay(false);
          return;
        }
        const set = (el, text) => { try { if (el.text !== text) el.text = text; } catch (e) {} };
        set(o.top, want.top);
        set(o.big, want.big);
        set(o.bottom, want.bottom);
        try {
          o.root.SetStyles({ backgroundColor: want.karaoke ? 'rgba(40, 12, 80, 0.94)' : 'rgba(0, 0, 0, 0.78)' });
          o.big.SetStyles({ fontSize: /^\d$/.test(want.big) ? `${Math.round(o.h * 0.45)}px` : `${Math.round(o.h * 0.12)}px`, color: /^\d$/.test(want.big) ? '#00e5ff' : '#ffffff' });
        } catch (e) {}
        this.showOverlay(true);
      }).catch(e => {
        console.warn("[NativeScreen] Couldn't show the words over the screen:", e);
        this.overlayFailed = true;
      }).finally(() => { this.overlayBuilding = false; });
    }

    /**
     * The panel for the words over the screen, made the first time it's wanted, in front of the
     * picture and the same size. Null on a client without the SDK's UI panels.
     * @returns {Promise<Object|null>}
     */
    async buildOverlay() {
      if (this.overlay) return this.overlay;
      if (this.overlayFailed) return null;
      const UIClass = BS.UI || BS.BanterUI;
      if (typeof UIClass !== 'function' || !this.go) return null;
      const [w, h] = this.size();
      const W = OVERLAY_W, H = Math.round(OVERLAY_W * h / w);
      const s = w / (W / 100); // a panel is 100 pixels per metre
      // Just in front of the picture (Unity's -z), so it covers it.
      const go = await this.core.makeObject('FireVPlayer_VideoScreenWords', {
        parent: this.go, position: new BS.Vector3(0, 0, -0.01), scale: new BS.Vector3(s, s, s)
      });
      if (this.destroyed) { this.core.destroyObject(go); return null; }
      const made = new UIClass(new BS.Vector2(W, H), false);
      const ui = (await go.AddComponent(made)) || made;
      if (this.destroyed) return null;
      if (typeof ui.SetBackgroundColor === 'function') ui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
      const root = await ui.CreateVisualElement();
      root.SetStyles({ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.78)' });
      const label = async (styles) => {
        const el = await ui.CreateLabel(undefined, root);
        el.SetStyles(Object.assign({ color: '#ffffff', backgroundColor: 'rgba(0,0,0,0)', textAlign: 'center', whiteSpace: 'normal', maxWidth: '90%' }, styles));
        el.text = '';
        return el;
      };
      const top = await label({ fontSize: `${Math.round(H * 0.08)}px`, color: '#ffd54f', fontWeight: 'bold' });
      const big = await label({ fontSize: `${Math.round(H * 0.12)}px`, fontWeight: 'bold' });
      const bottom = await label({ fontSize: `${Math.round(H * 0.055)}px`, color: '#dddddd', marginTop: `${Math.round(H * 0.02)}px` });
      if (this.destroyed) return null;
      this.overlay = { go, ui, root, top, big, bottom, h: H };
      return this.overlay;
    }

    /**
     * A YouTube video's captions, at the bottom of the picture: the line for now, while the viewer
     * has captions on (core.captions, the panel's CC) and no words cover the screen (loading, a
     * countdown). The world's video player has no captions of its own, so the lookup brings them
     * (see yt-resolve.js), and each viewer's own choice shows or hides them.
     */
    updateCaptions() {
      if (this.destroyed || !this.go || this.captionsFailed) return;
      const cues = this.cues || [];
      let text = '';
      if (cues.length && this.core.captions !== false && this.prepared && !this.overlayState()) {
        const t = this.localTime() * 1000;
        // The last line started by now that hasn't ended (lines are in order of their start).
        let lo = 0, hi = cues.length - 1, at = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid][0] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
        for (let i = at; i >= 0 && i > at - 4; i--) {
          if (t < cues[i][0] + Math.max(cues[i][1], 500)) { text = cues[i][2]; break; }
        }
      }
      if (text === this.captionText) return;
      if (!text && !this.captionPanel) { this.captionText = text; return; }
      if (this.captionBuilding) return; // the next tick picks it up
      this.captionText = text;
      this.captionBuilding = true;
      this.buildCaptions().then(c => {
        if (!c || this.destroyed) return;
        const now = this.captionText;
        try { if (c.label.text !== now) c.label.text = now; } catch (e) {}
        try {
          if (typeof c.go.SetActive === 'function') c.go.SetActive(!!now);
          else c.root.SetStyles({ display: now ? 'flex' : 'none' });
        } catch (e) {}
      }).catch(e => {
        console.warn("[NativeScreen] Couldn't show captions:", e);
        this.captionsFailed = true;
      }).finally(() => { this.captionBuilding = false; });
    }

    /** The panel captions show on, made the first time a line is shown: the picture's size, just in front of it. */
    async buildCaptions() {
      if (this.captionPanel) return this.captionPanel;
      const UIClass = BS.UI || BS.BanterUI;
      if (typeof UIClass !== 'function' || !this.go) return null;
      const [w, h] = this.size();
      const W = OVERLAY_W, H = Math.round(OVERLAY_W * h / w);
      const s = w / (W / 100);
      const go = await this.core.makeObject('FireVPlayer_VideoScreenCaptions', {
        parent: this.go, position: new BS.Vector3(0, 0, -0.008), scale: new BS.Vector3(s, s, s)
      });
      if (this.destroyed) { this.core.destroyObject(go); return null; }
      const made = new UIClass(new BS.Vector2(W, H), false);
      const ui = (await go.AddComponent(made)) || made;
      if (this.destroyed) return null;
      if (typeof ui.SetBackgroundColor === 'function') ui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
      const root = await ui.CreateVisualElement();
      root.SetStyles({ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', width: '100%', height: '100%', backgroundColor: 'rgba(0, 0, 0, 0)' });
      const label = await ui.CreateLabel(undefined, root);
      label.SetStyles({ color: '#ffffff', backgroundColor: 'rgba(0, 0, 0, 0.75)', textAlign: 'center', whiteSpace: 'normal', maxWidth: '86%',
        fontSize: `${Math.round(H * 0.05)}px`, paddingLeft: `${Math.round(H * 0.015)}px`, paddingRight: `${Math.round(H * 0.015)}px`,
        paddingTop: `${Math.round(H * 0.006)}px`, paddingBottom: `${Math.round(H * 0.006)}px`, marginBottom: `${Math.round(H * 0.06)}px` });
      label.text = '';
      if (this.destroyed) return null;
      this.captionPanel = { go, ui, root, label };
      return this.captionPanel;
    }

    /** Shows or hides the words over the screen (moves them out of sight, so they're kept for the next track). */
    showOverlay(on) {
      const o = this.overlay;
      if (!o || o.shown === on) return;
      o.shown = on;
      try {
        if (typeof o.go.SetActive === 'function') o.go.SetActive(on);
        else o.root.SetStyles({ display: on ? 'flex' : 'none' });
      } catch (e) {}
    }

    /** True while a karaoke song is counting down to its start: the file waits, paused, at 0:00. */
    holding() { return performance.now() < this.holdUntil; }
    /** The same, for the room's track only: a viewer's own preview of the same file plays through it. */
    held() { return this.holding() && !this.isPreview(); }

    /** Starts a hold from a track change the core has just had, if it's counting down. */
    holdFromCore() {
      if (this.isPreview()) return;
      const left = (Number(this.core.countdownUntil) || 0) - performance.now();
      if (left > 0) this.setHold(left / 1000);
      else this.clearHold();
    }

    /**
     * Holds the file at its start for `seconds`, then plays it and checks where the world is.
     * @param {number} seconds
     */
    setHold(seconds) {
      if (!this.holding()) this.warmSkipped = false; // a new countdown: it may warm this time
      this.holdUntil = performance.now() + seconds * 1000;
      clearTimeout(this.countdownTimer);
      this.countdownTimer = setTimeout(() => {
        const warmed = this.warming;
        this.clearHold(); // its sound comes on now, at the viewer's own level (see clearHold)
        this.lastToggleAt = -Infinity;
        this.applyPaused();
        // Where it is as the sound comes on, to tune WARM_REWIND_MS: Unity's last time, and when
        // it said it (it says it once a second), against when it went back to the start.
        const at = t => t == null ? '?' : `+${((t - this.traceFrom) / 1000).toFixed(2)}s`;
        if (warmed) console.log(`[NativeScreen] Countdown over at ${at(performance.now())}: sound on. Went back to the start at ${at(this.rewoundAt)}; Unity last said ${this.vp && this.vp.time} at ${at(this.lastTimeAt)}.`);
        this.traceUntil = performance.now() + TRACE_MS;
        this.trace('countdown over');
        console.log(`[NativeScreen] Countdown over, playing (Unity says ${this.state && this.state.isPlaying ? 'playing' : 'not playing'}, at ${this.localTime().toFixed(2)}s).`);
        this.watchStart(performance.now(), 0);
        // Once it has had a moment to start. Not a forced jump, which would be heard on every
        // screen as the song starts.
        this.countdownTimer = setTimeout(() => this.requestSync(false), 1000);
      }, seconds * 1000);
      if (this.warming) this.scheduleRewind(); // the countdown's end may have moved
      else if (this.prepared && this.localTime() > 0.2) this.seek(0);
      this.lastToggleAt = -Infinity;
      this.warmUp();
      this.applyPaused();
    }

    /**
     * Checks that a video let go after its countdown really plays: its time moves. If it hasn't
     * after START_CHECK_MS, it goes to where the world is (a seek) and plays, as a viewer's pause
     * and play would, up to START_KICKS times.
     * @param {number} since - performance.now() when it was let go.
     * @param {number} kicks - How many times it has been nudged already.
     */
    watchStart(since, kicks) {
      clearTimeout(this.startTimer);
      // Where it's measured from: where it was let go, or where a jump meanwhile landed (seek
      // starts the wait again from there, with the nudges already used).
      this.startFrom = Number(this.vp && this.vp.time) || 0;
      this.startKicks = kicks;
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (this.destroyed || this.wantPaused || this.held() || this.isPreview() || this.endedAt != null) return;
        // Unity's own time, which it sends in whole seconds: counting its reports instead took a
        // start that was playing (at 3 s) for a stuck one, and the jump was heard as a stutter.
        const moved = (Number(this.vp && this.vp.time) || 0) - this.startFrom >= 1;
        console.log(`[NativeScreen] ${START_CHECK_MS / 1000}s after the countdown: time ${moved ? 'moving' : 'not moving'} (Unity: time ${Number(this.vp && this.vp.time).toFixed(2)}, ${this.state && this.state.isPlaying ? 'playing' : 'not playing'}).`);
        if (moved || kicks >= START_KICKS) return;
        console.warn('[NativeScreen] It hasn\'t started, so it goes to where the world is and plays.');
        this.lastToggleAt = -Infinity;
        this.requestSync(true);
        this.applyPaused();
        this.watchStart(performance.now(), kicks + 1);
      }, START_CHECK_MS);
    }

    /**
     * A video on the world's own video player (not a page's) that has loaded while a countdown
     * holds it plays muted until the countdown ends, rather than waiting paused at its first frame
     * (see WARM_REWIND_MS). It goes back to its start before the end (scheduleRewind).
     */
    warmUp() {
      if (this.warming || this.warmSkipped || !this.vp || typeof this.vp.read === 'function' || !this.prepared) return;
      if (!this.held() || this.wantPaused || this.endedAt != null) return;
      const left = this.holdUntil - performance.now();
      if (left < WARM_MIN_MS) {
        this.warmSkipped = true;
        console.log(`[NativeScreen] Loaded with ${(left / 1000).toFixed(2)}s of the countdown left, too little to play it muted first: it waits at its start.`);
        return;
      }
      this.warming = true;
      this.applyVolume();
      console.log(`[NativeScreen] Loaded with ${(left / 1000).toFixed(2)}s of the countdown left: playing it muted until then (Unity's time ${this.vp.time}).`);
      this.lastToggleAt = -Infinity;
      this.applyPaused();
      this.scheduleRewind();
    }

    /** While warming: back to the start WARM_REWIND_MS before the countdown ends, still muted. */
    scheduleRewind() {
      // Already back at the start for this countdown: a sync that moves its end by a moment (as
      // each sync's own delay does) doesn't send it back again.
      if (this.rewoundFor != null && Math.abs(this.holdUntil - this.rewoundFor) < 500) return;
      clearTimeout(this.rewindTimer);
      this.rewindTimer = setTimeout(() => {
        if (this.destroyed || !this.warming || !this.vp) return;
        this.rewoundAt = performance.now();
        this.rewoundFor = this.holdUntil;
        console.log(`[NativeScreen] Back to the start, muted, ${((this.holdUntil - this.rewoundAt) / 1000).toFixed(2)}s before the countdown ends (Unity's time ${this.vp.time}).`);
        this.seek(0);
      }, Math.max(0, this.holdUntil - WARM_REWIND_MS - performance.now()));
    }

    /** Ends a hold, so the next applyPaused may play. @returns {boolean} whether there was one. */
    clearHold() {
      const was = this.holding();
      this.holdUntil = 0;
      clearTimeout(this.countdownTimer);
      // Warming ends with the hold, and its sound comes on.
      clearTimeout(this.rewindTimer);
      this.rewoundFor = null;
      if (this.warming) { this.warming = false; this.applyVolume(); }
      if (was) this.lastToggleAt = -Infinity;
      return was;
    }

    /** Computes Unity normalized volume (0.0 to 1.0). @returns {number} */
    unityVolume() {
      return this.muted || this.warming ? 0 : Math.max(0, Math.min(1, Number(this.volume) / 100 || 0));
    }

    /** Applies volume to Unity video player component. */
    applyVolume() {
      if (!this.vp) return;
      const v = this.unityVolume();
      if (this.vp.volume !== v) this.vp.volume = v;
    }

    /** Toggles play/pause state in Unity until matching desired state. */
    applyPaused() {
      const vp = this.vp;
      if (!vp || !this.prepared) return;
      const now = performance.now();
      if (now - this.lastToggleAt < TOGGLE_COOLDOWN_MS) return;
      // A countdown keeps the room's track paused too, unless it's warming (playing muted).
      const paused = this.wantPaused || (this.held() && !this.warming);
      // A play or pause, for watchStalls' grace: not a retry of the same one, as a stalling
      // video that says it isn't playing is retried every few seconds and would never be calm.
      if (paused !== this.lastWantPaused) { this.lastWantPaused = paused; this.lastPlayPauseAt = now; }
      if (this.playing() === !paused) return;
      // At the end, playing again would start the file over. The server moves on instead.
      const d = this.duration();
      if (!paused && (this.endedAt != null || (d && this.localTime() >= d - 0.5))) return;
      this.lastToggleAt = now;
      this.seenPlaying = false; // wait for Unity to say it's playing again
      this.trace(`PlayToggle to ${paused ? 'pause' : 'play'} (we had Unity as ${this.state.isPlaying ? 'playing' : 'not playing'}, time ${vp.time})`);
      vp.PlayToggle();
      this.state.isPlaying = !this.state.isPlaying; // until the next readState confirms it
    }

    /**
     * Seeks playback to timestamp in seconds.
     * @param {number} t - Time in seconds.
     */
    seek(t) {
      if (!this.vp) return;
      const d = this.duration();
      t = Math.max(0, d ? Math.min(t, d - 0.25) : t);
      // Seeking back from the end plays again; seeking to or past it stays at the end.
      if (this.endedAt != null) {
        if (t >= this.endedAt) return;
        this.endedAt = null;
        this.seenPlaying = false; // still stopped until it's started again
      }
      this.trace(`seek to ${t.toFixed(2)} (Unity's time ${this.vp.time})`);
      this.vp.time = t;
      // A jump while the start is being checked (a sync's, a host seek): only playing from where it
      // landed counts, and it gets the whole wait to do that in.
      if (this.startTimer) this.watchStart(performance.now(), this.startKicks || 0);
      this.lastSeekAt = performance.now();
      this.lastRaw = this.vp.time; // the setter keeps the new value until Unity sends its own
      this.baseTime = t;
      this.baseAt = performance.now();
    }

    /**
     * Sends time sync request to the server.
     * @param {boolean} hard - If true, forces jump regardless of small drift.
     */
    requestSync(hard) {
      if (this.destroyed || this.isPreview()) return;
      this.pendingSync = { hard: !!hard || (this.pendingSync && this.pendingSync.hard) };
      // native: the server answers the world's own connection, not only a browser page's.
      this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now(), native: true } });
    }

    /** Re-synchronizes after track changes or host seek events. */
    resync() {
      if (this.isPreview()) return;
      this.autoSync = this.core.autoSync === true;
      if (this.core.player) this.wantPaused = !!this.core.player.paused;
      this.hostSyncPending = true;
      this.holdFromCore();
      this.requestSync(true);
      // The same file started again (a restart, a one-song playlist): the room waits for it again.
      if (this.prepared && this.holding()) this.reportReadySoon();
    }

    /**
     * Handles incoming `SYNC_TIME` response from server, adjusting drift.
     * @param {Object} data - Time sync payload.
     */
    onSync(data) {
      if (!data || !this.prepared || this.isPreview()) return;
      const p = this.core.player;
      if (p && typeof data.currentTrack === 'number' && data.currentTrack !== p.currentTrack) return; // stale
      let hard = this.pendingSync && this.pendingSync.hard;
      const settling = !hard && !!this.settling; // checking a forced jump: corrects with Auto Sync off too
      this.settling = false;
      this.pendingSync = null;
      this.resumeSyncPending = false;
      this.hostSyncPending = false;
      const latency = Math.max(0, Date.now() - Number(data.clientTimestamp || Date.now())) / 2000;
      const serverTime = Number(data.currentTime) + (this.wantPaused ? 0 : latency);
      if (!Number.isFinite(serverTime)) return;
      // A karaoke song counting down to its start: it waits at 0:00, paused, until then.
      if (serverTime < 0) {
        if (!this.wantPaused) this.setHold(-serverTime);
        return;
      }
      // Held, but the world has started: play, and go to where it is.
      if (this.clearHold()) { hard = true; this.applyPaused(); }
      const d = this.duration();
      if (d && serverTime >= d - 0.5) return; // about to end; the server moves on
      // Ended with no known length: the server keeps counting until someone skips, so only a
      // host seek or track change (hard) moves it.
      if (this.endedAt != null && !hard) return;
      const drift = serverTime - this.localTime();
      if (hard || ((this.autoSync || settling) && Math.abs(drift) > MAX_DRIFT_S)) {
        // Still off just after a jump: that is what the jump itself cost, so the next aims ahead by it.
        const now = performance.now();
        // Not from a forced sync: a host seek or track change moves the world, not the jump's cost.
        if (!hard && !this.wantPaused && now - this.lastJumpAt < SYNC_EVERY_MS * 2.5 && Math.abs(drift) <= MAX_SEEK_LEAD_S) {
          this.seekLead = Math.max(0, Math.min(MAX_SEEK_LEAD_S, this.seekLead + drift));
          this.core.nativeSeekLead = this.seekLead;
        }
        this.lastJumpAt = now;
        const lead = this.wantPaused ? 0 : this.seekLead;
        if (!hard) console.log(`[NativeScreen] ${drift > 0 ? 'Behind' : 'Ahead'} by ${Math.abs(drift).toFixed(2)}s, jumping${lead ? ` (${lead.toFixed(2)}s ahead, for the time a jump takes here)` : ''}.`);
        this.seek(serverTime + lead);
        // A forced jump is checked once it has had time to play again (twice at most), as the
        // jump itself takes time and nothing else corrects it while Auto Sync is off.
        if (hard) this.settleLeft = 2;
        clearTimeout(this.settleTimer);
        if (this.settleLeft > 0 && !this.wantPaused) {
          this.settleLeft--;
          this.settleTimer = setTimeout(() => { this.settling = true; this.requestSync(false); }, SYNC_EVERY_MS);
        }
      }
    }

    /**
     * Dispatches simulated browser command messages (volume, mute, skips, pause).
     * @param {Object} msg - Command object.
     */
    handle(msg) {
      if (!msg || this.destroyed) return;
      switch (msg.path) {
        case Commands.SET_VOLUME:
          if (Number(msg.data) >= 0 && Number(msg.data) <= 100) {
            this.volume = Number(msg.data);
            this.applyVolume();
          }
          break;
        case Commands.MUTE:
          this.muted = msg.data === true || msg.data === 'true';
          this.applyVolume();
          break;
        case Commands.SKIP_BACK:
        case Commands.SKIP_FORWARD: {
          if (this.isPreview()) {
            this.seek(this.localTime() + (msg.path === Commands.SKIP_FORWARD ? SKIP_S : -SKIP_S));
            break;
          }
          // A viewer's own skip: stop pulling them back into step until the next track or host seek.
          clearTimeout(this.settleTimer); // a check still to come would undo the skip
          clearTimeout(this.startTimer);  // so would the check that it started after its countdown (watchStart)
          this.startTimer = null;         // which the skip's own seek would otherwise start again
          // and the answer to a forced sync that check already asked for, unless a host seek or
          // track change is waiting for its sync, which still moves everyone.
          if (!this.hostSyncPending) this.pendingSync = null;
          this.settleLeft = 0;
          this.settling = false; // and so would the answer to a check already asked for
          if (this.autoSync) {
            this.autoSync = false;
            this.core.autoSync = false;
            // So the panel's Auto Sync button shows Off, as the browser page's skip does.
            if (typeof this.core.notifyListeners === 'function') {
              this.core.notifyListeners({ path: Commands.AUTO_SYNC_STATE_CHANGED, data: { enabled: false } });
            }
          }
          // The skip wins over a resume sync still waiting or on its way (see PAUSE_STATE_CHANGED),
          // but not over a host seek or track change: its sync still moves everyone, the skipper too.
          clearTimeout(this.resumeSyncTimer);
          if (this.resumeSyncPending) {
            this.resumeSyncPending = false;
            this.pendingSync = this.hostSyncPending ? { hard: true } : null;
          }
          const amount = this.core.isKaraoke ? SKIP_KARAOKE_S : SKIP_S;
          this.seek(this.localTime() + (msg.path === Commands.SKIP_FORWARD ? amount : -amount));
          break;
        }
        case Commands.PAUSE_STATE_CHANGED: {
          if (this.isPreview()) break;
          const data = msg.data || {};
          this.wantPaused = !!data.paused;
          this.clearHold(); // the sync after a resume starts it again if the song is still counting down
          const at = Number(data.currentTime);
          // Resumed during a karaoke countdown: wait out what's left of it at 0:00, as onSync does.
          if (!this.wantPaused && Number.isFinite(at)) {
            if (at < 0) this.setHold(-at);
            else this.seek(at + this.seekLead);
          }
          this.lastToggleAt = -Infinity;
          this.applyPaused();
          // On resume, everyone goes to the host's point (above, whatever they skipped to while
          // paused), then one sync a moment later corrects for the time the message took.
          clearTimeout(this.resumeSyncTimer);
          if (!this.wantPaused) {
            this.resumeSyncTimer = setTimeout(() => {
              if (this.wantPaused) return;
              this.resumeSyncPending = true;
              this.requestSync(true);
            }, 1500);
          }
          break;
        }
        case Commands.SYNC_TIME:
          this.onSync(msg.data);
          break;
        case Commands.AUTO_SYNC:
          // The viewer's own Auto Sync button: on pulls them back into step straight away.
          this.autoSync = msg.data === true || msg.data === 'true';
          this.core.autoSync = this.autoSync;
          if (this.autoSync) this.requestSync(false);
          break;
      }
    }

    /** Destroys screen timers, removes Unity GameObject, and frees resources. */
    destroy() {
      this.destroyed = true;
      clearInterval(this.pollTimer);
      clearInterval(this.syncTimer);
      clearTimeout(this.resumeSyncTimer);
      clearTimeout(this.countdownTimer);
      clearTimeout(this.settleTimer);
      clearTimeout(this.readyTimer);
      clearInterval(this.overlayTimer);
      clearTimeout(this.startTimer);
      clearTimeout(this.rewindTimer);
      clearTimeout(this.setupTimer);
      if (this.vp && typeof this.vp.destroy === 'function') this.vp.destroy();
      // Destroying the object destroys the video player (or a page's browser) with it.
      if (this.go) this.core.destroyObject(this.go);
      this.go = null;
      this.vp = null;
    }
  };
})();
