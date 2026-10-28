/**
 * @fileoverview Unified media player abstraction and multi-source switch.
 * Adapts non-YouTube media sources (HTML5 video, HLS streams, Twitch streams/VODs/clips,
 * Vimeo, and VDO.Ninja) to expose the same interface as the YouTube iframe API,
 * allowing synchronized playback, seek, volume, and state management.
 * @module public/media-players
 */

/**
 * Standard playback states matching YouTube iframe API (YT.PlayerState).
 * @readonly
 * @enum {number}
 */
const MEDIA_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };

/**
 * External player library script CDNs loaded on-demand.
 * @type {Record<string, string>}
 */
const MEDIA_SCRIPTS = {
  hls: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
  mpegts: 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js',
  twitch: 'https://player.twitch.tv/js/embed/v1.js',
  vimeo: 'https://player.vimeo.com/api/player.js'
};

const mediaScriptLoads = {};

/**
 * Dynamically loads an external media player JavaScript SDK by name.
 * @param {'hls'|'mpegts'|'twitch'|'vimeo'} name - Player library key.
 * @returns {Promise<Event>} Resolves when script is loaded.
 */
function loadMediaScript(name) {
  if (!mediaScriptLoads[name]) {
    mediaScriptLoads[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MEDIA_SCRIPTS[name];
      s.onload = resolve;
      s.onerror = () => { delete mediaScriptLoads[name]; reject(new Error(`Could not load the ${name} player.`)); };
      document.head.appendChild(s);
    });
  }
  return mediaScriptLoads[name];
}

/**
 * Abstract base class for non-YouTube media source player adapters.
 * @class BaseMediaSource
 */
class BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   * @param {HTMLElement} opts.container - Parent DOM container element.
   * @param {string} opts.link - Canonical media playback URL.
   * @param {number} opts.start - Initial playback start timestamp in seconds.
   * @param {number} opts.volume - Initial volume level (0-100).
   * @param {boolean} opts.muted - Initial muted state.
   * @param {function(number): void} opts.onDuration - Callback invoked when media duration is determined.
   * @param {function(string): void} opts.onError - Callback invoked on player errors.
   */
  constructor(opts) {
    this.opts = opts;           // { container, link, start, volume, muted, onDuration, onError }
    this.wantPaused = false;
    this.live = false;
    this.ready = false;
  }
  /** Sets playback rate. @param {number} r */
  setRate(r) {}
  /** Gets playback rate. @returns {number} */
  rate() { return 1; }
  /** Checks if media is a live stream. @returns {boolean} */
  isLive() { return this.live; }
  /**
   * Reports discovered media duration to host/server.
   * @param {number} seconds - Media duration in seconds.
   */
  reportDuration(seconds) {
    if (seconds > 0 && isFinite(seconds) && !this.reported) {
      this.reported = true;
      this.opts.onDuration(seconds);
    }
  }
}

/**
 * Player adapter for direct HTML5 video/audio files (.mp4, .webm, etc.), HLS streams (.m3u8)
 * and MPEG-TS streams (VRCDN's .live.ts).
 * @class VideoElementSource
 * @extends {BaseMediaSource}
 */
class VideoElementSource extends BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   * @param {Object} media - What MediaSources.detect found: type 'file', 'hls' or 'mpegts'.
   */
  constructor(opts, media) {
    super(opts);
    const hls = media.type === 'hls';
    // A live MPEG-TS stream has no length or position to seek to, as with a live .m3u8.
    if (media.type === 'mpegts' && media.live) this.live = true;
    const el = this.el = document.createElement('video');
    el.playsInline = true;
    el.autoplay = true;
    el.crossOrigin = null;
    Object.assign(el.style, { width: '100%', height: '100%', objectFit: 'contain', background: '#000' });
    opts.container.appendChild(el);
    this.setVolume(opts.volume);
    this.setMuted(opts.muted);

    el.addEventListener('loadedmetadata', () => {
      this.ready = true;
      // No length doesn't mean live: a file can just not say how long it is. Only an .m3u8 the
      // browser plays itself (no hls.js stream details to go by) counts as live from that.
      if (el.duration === Infinity && hls && !this.hls) this.live = true;
      this.reportDuration(el.duration);
      this.applyPendingSeek();
      this.wantPaused ? el.pause() : this.tryPlay();
    });
    // A file without a length up front may give one later, and can only seek as far as it has loaded.
    el.addEventListener('durationchange', () => { this.reportDuration(el.duration); this.applyPendingSeek(); });
    el.addEventListener('progress', () => this.applyPendingSeek());
    el.addEventListener('error', () => opts.onError("Couldn't play this video. The link may be wrong, or the site may not allow it here."));
    this.pendingSeek = opts.start > 0 ? opts.start : null; // a seek waiting until the file can go there

    if (media.type === 'mpegts') {
      // Browsers can't play MPEG-TS themselves; mpegts.js feeds it to the video element.
      loadMediaScript('mpegts').then(() => {
        if (this.destroyed) return;
        if (!window.mpegts || !mpegts.isSupported()) { opts.onError("This browser can't play this stream."); return; }
        const m = this.mpegts = mpegts.createPlayer({ type: 'mpegts', isLive: !!media.live, url: media.url || opts.link },
          { liveBufferLatencyChasing: !!media.live, lazyLoad: !media.live });
        m.on(mpegts.Events.ERROR, () => opts.onError("Couldn't play this stream. It may be offline, or the site may not allow it here."));
        m.attachMediaElement(el);
        m.load();
      }).catch(err => opts.onError(err.message));
    } else if (!hls || el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = opts.link;
    } else {
      loadMediaScript('hls').then(() => {
        if (this.destroyed) return;
        if (!window.Hls || !Hls.isSupported()) { el.src = opts.link; return; }
        const h = this.hls = new Hls({ liveDurationInfinity: true });
        h.on(Hls.Events.LEVEL_LOADED, (e, data) => { if (data.details && data.details.live) this.live = true; });
        h.on(Hls.Events.ERROR, (e, data) => { if (data.fatal) opts.onError("Couldn't play this stream. It may be offline, or the site may not allow it here."); });
        h.loadSource(opts.link);
        h.attachMedia(el);
      }).catch(err => opts.onError(err.message));
    }
  }

  /**
   * Attempts playback, gracefully falling back to muted autoplay if browser autoplay policy blocks sound.
   */
  tryPlay() {
    const p = this.el.play();
    // If the browser won't start it with sound, start it muted rather than not at all, and turn
    // the sound on at the first click on the screen (which the browser counts as permission).
    if (p && p.catch) p.catch(err => {
      if (err && err.name === 'NotAllowedError' && !this.el.muted) {
        this.el.muted = true;
        this.el.play().catch(() => {});
        this.autoMuted = true;
        if (!this.unmuteOnClick) {
          this.unmuteOnClick = () => {
            if (this.autoMuted && !this.destroyed) { this.autoMuted = false; this.el.muted = !!this.wantMuted; }
          };
          document.addEventListener('pointerdown', this.unmuteOnClick, true);
          document.addEventListener('click', this.unmuteOnClick, true);
        }
        this.opts.requestClick();
      }
    });
  }

  play() { this.wantPaused = false; if (this.ready) this.tryPlay(); }
  pause() { this.wantPaused = true; if (this.ready) this.el.pause(); }
  seek(t) {
    if (this.live) return;
    this.pendingSeek = Math.max(0, Number(t) || 0);
    if (this.ready) this.applyPendingSeek();
  }

  /** Moves to the waiting seek once the file can go there: within its length, or what has loaded. */
  applyPendingSeek() {
    const el = this.el, t = this.pendingSeek;
    if (!this.ready || this.live || t == null) return;
    if (isFinite(el.duration)) {
      el.currentTime = Math.min(t, el.duration); // past the end goes to the end, as a direct seek would
      this.pendingSeek = null;
      return;
    }
    const s = el.seekable;
    if (s && s.length && t <= s.end(s.length - 1)) { el.currentTime = t; this.pendingSeek = null; }
  }
  time() { return this.ready && this.pendingSeek == null ? this.el.currentTime : (this.pendingSeek || 0); }
  state() {
    const el = this.el;
    if (!this.ready) return MEDIA_STATE.UNSTARTED;
    if (el.ended) return MEDIA_STATE.ENDED;
    if (el.paused) return MEDIA_STATE.PAUSED;
    return el.readyState < 3 ? MEDIA_STATE.BUFFERING : MEDIA_STATE.PLAYING;
  }
  setRate(r) { if (!this.live) this.el.playbackRate = r; }
  rate() { return this.el.playbackRate; }
  setVolume(v) { this.el.volume = Math.max(0, Math.min(1, Number(v) / 100)); }
  setMuted(m) { this.wantMuted = !!m; if (!this.autoMuted) this.el.muted = !!m; }
  destroy() {
    this.destroyed = true;
    if (this.unmuteOnClick) {
      document.removeEventListener('pointerdown', this.unmuteOnClick, true);
      document.removeEventListener('click', this.unmuteOnClick, true);
    }
    if (this.hls) this.hls.destroy();
    if (this.mpegts) this.mpegts.destroy();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el.remove();
  }
}

/**
 * The hosts Twitch must be told about in its `parent` option: the player page's own, plus every
 * page it's framed inside (the 2D fallback outside a world puts it in an iframe on another page).
 * Twitch refuses to play if any ancestor frame's host is missing.
 * @returns {string[]}
 */
function twitchParents() {
  const hosts = [location.hostname];
  const add = url => {
    try { const h = new URL(url).hostname; if (h && !hosts.includes(h)) hosts.push(h); } catch (e) {}
  };
  if (location.ancestorOrigins) Array.from(location.ancestorOrigins).forEach(add);
  else if (window.top !== window && document.referrer) add(document.referrer);
  return hosts;
}

/**
 * What Twitch's autoplay check can see, for the log when a stream won't start: Twitch refuses to
 * autoplay an embed it doesn't think is visible ("style visibility").
 * @returns {string}
 */
function twitchVisibility() {
  const frame = twitchEmbed.div && twitchEmbed.div.querySelector('iframe');
  const parts = [`page ${document.visibilityState}`, `focus ${document.hasFocus()}`, `dpr ${window.devicePixelRatio}`];
  const stage = document.getElementById('stage');
  if (stage) parts.push(`stage transform ${getComputedStyle(stage).transform}`);
  if (frame) {
    const r = frame.getBoundingClientRect();
    parts.push(`embed ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`);
    for (let el = frame; el && el !== document.documentElement; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) < 1) {
        parts.push(`hidden by ${el.id || el.tagName} (display ${s.display}, visibility ${s.visibility}, opacity ${s.opacity})`);
      }
    }
  }
  return parts.join(', ');
}

/** Logs whether the browser itself counts the embed as visible (IntersectionObserver v2). */
function logTwitchSeen() {
  const frame = twitchEmbed.div && twitchEmbed.div.querySelector('iframe');
  if (!frame || typeof IntersectionObserver !== 'function') return;
  try {
    const io = new IntersectionObserver(entries => {
      const e = entries[entries.length - 1];
      console.log(`[Twitch] the browser says the embed is ${e.isVisible === undefined ? 'of unknown visibility' : e.isVisible ? 'visible' : 'not visible'} (${Math.round(e.intersectionRatio * 100)}% in view)`);
      io.disconnect();
    }, { trackVisibility: true, delay: 100 });
    io.observe(frame);
  } catch (e) {
    console.log('[Twitch] could not ask the browser about visibility:', e.message);
  }
}

/** Twitch's `time` parameter for a VOD start offset, e.g. 1h2m3s. */
function twitchTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

/**
 * The one Twitch embed for the life of the page. Twitch.Player's constructor adds a window
 * 'message' listener that its destroy() never removes, so every `new Twitch.Player` would leak
 * one. It's built once, kept in the page (hidden while something else plays) and re-pointed with
 * setChannel/setVideo, or by reloading its iframe. `owner` is the TwitchSource using it now.
 */
const twitchEmbed = { player: null, div: null, ready: false, owner: null, key: '' };

/**
 * Player adapter for live Twitch channels and recorded Twitch VODs.
 *
 * After pause() the embed sits in "Idle", and neither play(), seek() nor setVideo() brings it
 * back; reloading its iframe with autoplay=true does. So whenever playback is asked for, it gets a
 * moment to start, and if it hasn't the iframe is reloaded. A simulated click on the screen is the
 * last resort.
 * @class TwitchSource
 * @extends {BaseMediaSource}
 */
class TwitchSource extends BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   * @param {Object} media - Detected Twitch media descriptor.
   */
  constructor(opts, media) {
    super(opts);
    this.media = media;
    this.live = !!media.channel;
    this.channel = media.channel || '';
    this.video = media.video ? 'v' + String(media.video).replace(/^v/, '') : '';
    this.key = this.live ? 'c:' + this.channel : 'v:' + this.video;
    this.muted = !!opts.muted;
    this.volume = opts.volume;
    this.playing = false;
    this.pendingSeek = this.live ? 0 : Math.max(0, opts.start || 0);
    this.setPos(this.pendingSeek);
    loadMediaScript('twitch').then(() => {
      if (this.destroyed) return;
      if (!window.Twitch || !Twitch.Player) throw new Error('Could not load the Twitch player.');
      this.attach();
    }).catch(err => { if (!this.destroyed) opts.onError(err.message); });
  }

  /** True while this source is the one using the shared embed. */
  mine() { return !this.destroyed && twitchEmbed.owner === this; }
  get p() { return twitchEmbed.player; }

  /** Builds the shared embed, or points it at this source's channel or video. */
  attach() {
    const e = twitchEmbed;
    e.owner = this;
    if (!e.div) {
      e.div = document.createElement('div');
      e.div.id = 'twitch-embed';
      Object.assign(e.div.style, { width: '100%', height: '100%' });
    }
    // Moving an iframe reloads it, so it's only moved if the container has changed.
    if (e.div.parentNode !== this.opts.container) this.opts.container.appendChild(e.div);
    e.div.style.display = '';
    if (!e.player) {
      const o = {
        width: '100%', height: '100%', autoplay: true, muted: this.muted, parent: twitchParents()
      };
      if (this.live) o.channel = this.channel; else o.video = this.video;
      if (this.pendingSeek > 0) o.time = twitchTime(this.pendingSeek);
      e.key = this.key;
      e.player = new Twitch.Player(e.div.id, o);
      this.listen(e.player);
      this.ensurePlaying(6000); // a new embed takes a few seconds to load
      return;
    }
    if (e.key !== this.key) {
      e.key = this.key;
      try { this.live ? e.player.setChannel(this.channel) : e.player.setVideo(this.video); } catch (err) {
        console.log('[Twitch] re-point failed', err);
      }
    }
    this.ready = e.ready;
    this.applyAudio();
    if (this.wantPaused) { try { e.player.pause(); } catch (err) {} return; }
    try { e.player.play(); } catch (err) {}
    this.ensurePlaying();
  }

  /** The embed's events, added once for the life of the page and passed to whichever source owns it. */
  listen(p) {
    const T = Twitch.Player;
    const owner = () => twitchEmbed.owner && twitchEmbed.owner.mine() ? twitchEmbed.owner : null;
    p.addEventListener(T.READY, () => {
      twitchEmbed.ready = true;
      const s = owner();
      if (s) s.onReady();
    });
    // isPaused() can say "playing" while Twitch is still waiting for a click, so these events
    // are what count as playing.
    p.addEventListener(T.PLAYING, () => { const s = owner(); if (s) s.onPlaying(); });
    p.addEventListener(T.PAUSE, () => { const s = owner(); if (s) s.setPlaying(false); });
    if (T.ENDED) p.addEventListener(T.ENDED, () => { const s = owner(); if (s) { s.setPlaying(false); s.ended = true; } });
    if (T.OFFLINE) p.addEventListener(T.OFFLINE, () => {
      const s = owner();
      if (s && s.live) { s.offline = true; s.opts.onError(`${s.channel} isn't live on Twitch right now.`); }
    });
    if (T.ONLINE) p.addEventListener(T.ONLINE, () => { const s = owner(); if (s) s.offline = false; });
  }

  onReady() {
    this.ready = true;
    this.applyAudio();
    if (this.wantPaused) { try { this.p.pause(); } catch (e) {} return; }
    try { this.p.play(); } catch (e) {}
  }

  onPlaying() {
    this.setPlaying(true);
    this.ended = false;
    this.offline = false;
    if (!this.live) {
      try { this.reportDuration(this.p.getDuration()); } catch (e) {}
      // setVideo() takes only an id, so a start offset is a seek once the video is running.
      if (this.pendingSeek > 0) {
        const t = this.pendingSeek;
        this.pendingSeek = 0;
        try { if (Math.abs(this.p.getCurrentTime() - t) > 2) this.p.seek(t); } catch (e) {}
        this.setPos(t);
      }
    }
    if (this.wantPaused) { try { this.p.pause(); } catch (e) {} }
  }

  // getCurrentTime() reports ~0 for VODs in some embed builds even while playing, so the position
  // is also counted here.
  setPos(t) { this.posBase = Math.max(0, t || 0); this.posAt = performance.now(); }
  setPlaying(on) {
    if (on === this.playing) return;
    if (!on) this.posBase = this.localTime();
    this.posAt = performance.now();
    this.playing = on;
  }
  localTime() { return this.posBase + (this.playing ? (performance.now() - this.posAt) / 1000 : 0); }

  applyAudio() {
    if (!this.p) return;
    try {
      this.p.setVolume(Math.max(0, Math.min(1, Number(this.volume) / 100)));
      this.p.setMuted(this.muted);
    } catch (e) {}
  }

  /**
   * Reloads the embed's iframe pointed at this source, playing from `startAt`. Unlike a new
   * Twitch.Player it adds no listener, and it's the one thing that wakes an Idle embed.
   */
  reloadIframe(startAt) {
    const frame = twitchEmbed.div && twitchEmbed.div.querySelector('iframe');
    if (!frame || !frame.src) return false;
    let url;
    try { url = new URL(frame.src); } catch (e) { return false; }
    if (this.live) {
      url.searchParams.set('channel', this.channel);
      url.searchParams.delete('video');
      url.searchParams.delete('time');
    } else {
      url.searchParams.set('video', this.video);
      url.searchParams.delete('channel');
      if (startAt > 0) url.searchParams.set('time', twitchTime(startAt)); else url.searchParams.delete('time');
      this.pendingSeek = startAt;
    }
    url.searchParams.set('autoplay', 'true');
    url.searchParams.set('muted', String(this.muted));
    url.searchParams.delete('parent');
    twitchParents().forEach(h => url.searchParams.append('parent', h));
    this.setPlaying(false);
    frame.src = url.toString();
    return true;
  }

  /**
   * Makes sure the stream starts, and with sound unless muted is wanted. Each step waits, then
   * checks: play() is given ~1.5s (a newly built embed longer), then the iframe is reloaded; if
   * that didn't work either, the screen is clicked (twice at most).
   */
  ensurePlaying(ms = 1500) {
    if (this.kick) return; // already watching
    this.step = 0;
    this.check(ms);
  }
  check(ms) {
    this.kick = setTimeout(() => {
      this.kick = null;
      if (!this.mine() || this.wantPaused || !this.p || this.offline || this.ended) return;
      const step = this.step++;
      if (step > 8) return;
      let paused = true, muted = false;
      try { paused = this.p.isPaused(); muted = this.p.getMuted(); } catch (e) {}
      if (this.playing && !paused) {
        this.pendingSeek = 0;
        if (this.muted || !muted) return; // playing as it should
        // It started muted (the browser wouldn't allow sound): unmute it, then check that didn't
        // stop it.
        console.log('[Twitch] playing muted, unmuting');
        try { this.p.setMuted(false); } catch (e) {}
        this.unmuted = (this.unmuted || 0) + 1;
        if (this.unmuted <= 3) this.check(2500);
        return;
      }
      if (!this.reloaded) {
        this.reloaded = true;
        console.log('[Twitch] not playing yet, reloading the embed. ' + twitchVisibility());
        logTwitchSeen();
        // A VOD can take a while to start after a reload (an ad first), so it's given time
        // before the screen is clicked.
        if (this.reloadIframe(this.live ? 0 : (this.pendingSeek || this.time()))) { this.check(10000); return; }
      }
      if ((this.clicks || 0) < 2) {
        this.clicks = (this.clicks || 0) + 1;
        console.log('[Twitch] still not playing, clicking the screen');
        try { this.p.play(); } catch (e) {}
        this.opts.requestClick();
        this.check(3000);
      }
    }, ms);
  }

  play() {
    this.wantPaused = false;
    if (!this.mine() || !this.p) return;
    if (this.playing) return;
    try { this.p.play(); } catch (e) {}
    // A new play after a pause gets its own reload, since the pause left the embed Idle.
    this.reloaded = false;
    this.ensurePlaying();
  }
  pause() {
    this.wantPaused = true;
    clearTimeout(this.kick); this.kick = null;
    if (this.mine() && this.p) { try { this.p.pause(); } catch (e) {} }
  }
  seek(t) {
    if (this.live) return;
    t = Math.max(0, t);
    this.setPos(t);
    // Kept until the video is seen playing, so an iframe reload (or the PLAYING after an Idle
    // embed wakes) goes to the asked-for place rather than where the embed last was.
    this.pendingSeek = t;
    if (!this.ready || !this.mine()) return;
    try { this.p.seek(t); } catch (e) {}
    // A seek on an Idle embed does nothing either, so a seek while playing is checked too.
    if (!this.wantPaused) this.ensurePlaying();
  }
  time() {
    if (this.pendingSeek > 0 && !this.playing) return this.pendingSeek;
    let real = 0;
    try { if (this.ready && this.mine()) real = this.p.getCurrentTime() || 0; } catch (e) {}
    if (real > 1) { this.posBase = real; this.posAt = performance.now(); return real; }
    return this.localTime();
  }
  state() {
    if (!this.ready || !this.mine()) return MEDIA_STATE.UNSTARTED;
    try {
      if (this.ended || (this.p.getEnded && this.p.getEnded())) return MEDIA_STATE.ENDED;
      if (this.playing) return MEDIA_STATE.PLAYING;
      // Asked to play but not started yet (or being revived): buffering, so the sync code
      // doesn't keep calling play().
      if (!this.wantPaused && this.kick) return MEDIA_STATE.BUFFERING;
      return this.p.isPaused() ? MEDIA_STATE.PAUSED : MEDIA_STATE.PLAYING;
    } catch (e) { return MEDIA_STATE.UNSTARTED; }
  }
  setVolume(v) {
    this.volume = v;
    if (this.mine() && this.p) { try { this.p.setVolume(Math.max(0, Math.min(1, Number(v) / 100))); } catch (e) {} }
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.mine() && this.p) { try { this.p.setMuted(!!m); } catch (e) {} }
  }
  destroy() {
    const owned = this.mine();
    this.destroyed = true;
    clearTimeout(this.kick); this.kick = null;
    if (!owned) return;
    // The embed is kept for the next Twitch link (see twitchEmbed); it's only silenced and hidden.
    twitchEmbed.owner = null;
    try { this.p.pause(); } catch (e) {}
    if (twitchEmbed.div) twitchEmbed.div.style.display = 'none';
  }
}

/**
 * Player adapter for Twitch clips embedded via iframe.
 * @class TwitchClipSource
 * @extends {BaseMediaSource}
 */
class TwitchClipSource extends BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   * @param {Object} media - Detected clip descriptor with slug.
   */
  constructor(opts, media) {
    super(opts);
    this.live = true; // nothing to sync
    this.clip = media.clip;
    this.muted = !!opts.muted;
    this.startedAt = performance.now();
    this.load();
  }
  load() {
    if (this.frame) this.frame.remove();
    const f = this.frame = document.createElement('iframe');
    f.src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(this.clip)}&${twitchParents().map(h => `parent=${encodeURIComponent(h)}`).join('&')}&autoplay=true&muted=${this.muted}`;
    f.allow = 'autoplay; fullscreen';
    Object.assign(f.style, { width: '100%', height: '100%', border: '0' });
    this.opts.container.appendChild(f);
    this.ready = true;
  }
  play() { this.wantPaused = false; }
  pause() { this.wantPaused = true; }
  seek() {}
  time() { return (performance.now() - this.startedAt) / 1000; }
  state() { return MEDIA_STATE.PLAYING; }
  setVolume() {}
  setMuted(m) {
    if (!!m === this.muted) return;
    this.muted = !!m;
    if (!this.toldMute) {
      this.toldMute = true;
      this.opts.onError("Twitch clips can't be muted or turned down here.");
    }
  }
  destroy() {
    this.destroyed = true;
    if (this.frame) this.frame.remove();
  }
}

/**
 * Player adapter for VDO.Ninja streams embedded via iframe.
 * @class VdoNinjaSource
 * @extends {BaseMediaSource}
 */
class VdoNinjaSource extends BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   */
  constructor(opts) {
    super(opts);
    this.live = true;
    this.muted = !!opts.muted;
    this.volume = opts.volume;
    this.startedAt = performance.now();
    const f = this.frame = document.createElement('iframe');
    f.src = VdoNinjaSource.embedLink(opts.link);
    // No fullscreen: on an in-world screen it leaves the player blank until the space is rejoined.
    f.allow = 'autoplay';
    f.allowFullscreen = false;
    Object.assign(f.style, { width: '100%', height: '100%', border: '0' });
    f.addEventListener('load', () => {
      this.ready = true;
      this.sendSettings();
      // Browsers may hold its sound back until the page is clicked, so click it once.
      this.kick = setTimeout(() => { if (!this.destroyed) opts.requestClick(); }, 4000);
    });
    opts.container.appendChild(f);
  }

  /**
   * Adds nocontrols and cleanoutput to a VDO.Ninja link, unless it already has them.
   * cleanoutput also turns off VDO.Ninja's right-click menu, which the click that unlocks
   * the sound opened on Quest (it arrives there as a long press).
   * @param {string} link - Base VDO.Ninja link.
   * @returns {string} Embed URL.
   */
  static embedLink(link) {
    link = String(link);
    const hash = link.indexOf('#');
    let base = hash < 0 ? link : link.slice(0, hash);
    const tail = hash < 0 ? '' : link.slice(hash);
    const has = (...names) => names.some(n => new RegExp(`[?&]${n}(=|&|$)`).test(base));
    const add = name => { base += (base.includes('?') ? '&' : '?') + name; };
    if (!has('nocontrols')) add('nocontrols');
    if (!has('cleanoutput', 'clean', 'cleanish')) add('cleanoutput');
    return base + tail;
  }

  /**
   * Dispatches a message to the VDO.Ninja iframe window via postMessage.
   * @param {Object} msg - Command message.
   */
  post(msg) {
    try { this.frame.contentWindow.postMessage(msg, '*'); } catch (e) {}
  }

  sendSettings() {
    this.post({ volume: Math.max(0, Math.min(1, Number(this.volume) / 100)) });
    this.post({ mute: this.muted });
  }
  play() { this.wantPaused = false; }
  pause() { this.wantPaused = true; }
  seek() {}
  time() { return (performance.now() - this.startedAt) / 1000; }
  state() { return this.ready ? MEDIA_STATE.PLAYING : MEDIA_STATE.BUFFERING; }
  setVolume(v) { this.volume = v; if (this.ready) this.post({ volume: Math.max(0, Math.min(1, Number(v) / 100)) }); }
  setMuted(m) { this.muted = !!m; if (this.ready) this.post({ mute: this.muted }); }
  destroy() {
    this.destroyed = true;
    clearTimeout(this.kick);
    this.frame.remove();
  }
}

/**
 * Player adapter for Vimeo videos using the Vimeo SDK.
 * @class VimeoSource
 * @extends {BaseMediaSource}
 */
class VimeoSource extends BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   * @param {Object} media - Detected Vimeo video descriptor with ID and optional hash.
   */
  constructor(opts, media) {
    super(opts);
    this.div = document.createElement('div');
    Object.assign(this.div.style, { width: '100%', height: '100%' });
    opts.container.appendChild(this.div);
    this.t = opts.start || 0;
    this.tAt = performance.now();
    this.playing = false;
    this.r = 1;
    loadMediaScript('vimeo').then(() => {
      if (this.destroyed) return;
      const url = `https://player.vimeo.com/video/${media.id}${media.hash ? '?h=' + encodeURIComponent(media.hash) : ''}`;
      const p = this.p = new Vimeo.Player(this.div, { url, autoplay: true, controls: false, muted: !!opts.muted, dnt: true, title: false, byline: false, portrait: false });
      p.on('loaded', () => {
        this.ready = true;
        const iframe = this.div.querySelector('iframe');
        if (iframe) Object.assign(iframe.style, { width: '100%', height: '100%' });
        this.setVolume(opts.volume);
        if (this.t > 0) p.setCurrentTime(this.t).catch(() => {});
        (this.wantPaused ? p.pause() : p.play()).catch(() => {});
        p.getDuration().then(d => this.reportDuration(d)).catch(() => {});
      });
      p.on('timeupdate', d => { this.t = d.seconds; this.tAt = performance.now(); });
      p.on('playing', () => { this.playing = true; this.tAt = performance.now(); });
      p.on('pause', () => { this.playing = false; });
      p.on('ended', () => { this.playing = false; this.ended = true; });
      p.on('error', e => opts.onError(`Vimeo: ${(e && e.message) || "couldn't play this video."}`));
    }).catch(err => opts.onError(err.message));
  }
  play() { this.wantPaused = false; if (this.ready) this.p.play().catch(() => {}); }
  pause() { this.wantPaused = true; if (this.ready) this.p.pause().catch(() => {}); }
  seek(t) {
    this.t = Math.max(0, t);
    this.tAt = performance.now();
    this.ended = false;
    if (this.ready) this.p.setCurrentTime(this.t).catch(() => {});
  }
  time() { return this.playing ? this.t + (performance.now() - this.tAt) / 1000 * this.r : this.t; }
  state() {
    if (!this.ready) return MEDIA_STATE.UNSTARTED;
    if (this.ended) return MEDIA_STATE.ENDED;
    return this.playing ? MEDIA_STATE.PLAYING : MEDIA_STATE.PAUSED;
  }
  // Only some Vimeo videos allow speed changes; once one refuses, small drifts are left alone.
  setRate(r) {
    if (!this.ready || this.noRate || r === this.r) return;
    this.p.setPlaybackRate(r).then(() => { this.r = r; }).catch(() => { this.noRate = true; });
  }
  rate() { return this.r; }
  setVolume(v) { if (this.ready) this.p.setVolume(Math.max(0, Math.min(1, Number(v) / 100))).catch(() => {}); }
  setMuted(m) { if (this.ready) this.p.setMuted(!!m).catch(() => {}); }
  destroy() {
    this.destroyed = true;
    if (this.p) this.p.destroy().catch(() => {});
    this.div.remove();
  }
}

/**
 * Fallback display source shown when an untrusted media link is rejected.
 * @class NoticeSource
 * @extends {BaseMediaSource}
 */
class NoticeSource extends BaseMediaSource {
  /**
   * @param {Object} opts - Source configuration options.
   * @param {string} text - Message text to display.
   */
  constructor(opts, text) {
    super(opts);
    this.live = true;
    this.ready = true;
    const d = this.el = document.createElement('div');
    d.textContent = text;
    Object.assign(d.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      width: '100%', height: '100%', padding: '0 10%', boxSizing: 'border-box', color: '#ddd', background: '#000',
      font: '4vw sans-serif' });
    opts.container.appendChild(d);
  }
  play() {}
  pause() {}
  seek() {}
  time() { return 0; }
  state() { return MEDIA_STATE.PAUSED; }
  setVolume() {}
  setMuted() {}
  destroy() { this.el.remove(); }
}

/**
 * Controller class that transparently switches between YouTube and alternative media player sources.
 * Implements the standard YouTube player interface (`playVideo`, `pauseVideo`, `seekTo`, etc.)
 * so the player controller operates seamlessly with any media provider.
 * @class MediaSwitch
 */
class MediaSwitch {
  /**
   * @param {Object} yt - The YouTube player instance.
   * @param {Object} opts - Player configuration and callbacks.
   * @param {function(string): string} opts.getId - Extracts YouTube video ID.
   * @param {function(string, number): void} opts.onDuration - Duration reporting callback.
   * @param {function(string): void} opts.onError - Error handling callback.
   * @param {function(): boolean} [opts.allowUntrusted] - Permission check for untrusted sources.
   * @param {function(): void} [opts.requestClick] - Requests synthetic gesture/click for sound.
   */
  constructor(yt, opts) {
    this.yt = yt;
    this.opts = opts;
    this.source = null; // the player for a non-YouTube link, while one is playing
    this.volume = 100;
    this.muted = false;
    this.container = document.getElementById('media-other');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'media-other';
      Object.assign(this.container.style, { position: 'absolute', inset: '0', background: '#000', display: 'none', zIndex: '5' });
      // On the stage with the YouTube player (see fit-screen.js), or the page without one.
      (document.getElementById('stage') || document.body).appendChild(this.container);
    }
  }

  /**
   * Loads and initiates playback for a media URL with the appropriate player adapter.
   * @param {string} link - Canonical playback URL.
   * @param {number} start - Start playback offset in seconds.
   */
  loadMedia(link, start) {
    const media = window.MediaSources ? MediaSources.detect(link) : null;
    if (!media || media.type === 'youtube') {
      this.loadVideoById(this.opts.getId(link), start);
      return;
    }
    this.stopSource();
    try { this.yt.stopVideo(); } catch (e) {}
    this.showYouTube(false);
    // Files and streams from any site only play where this viewer's world allows them.
    if (!MediaSources.isTrusted(media) && !(this.opts.allowUntrusted && this.opts.allowUntrusted())) {
      this.source = new NoticeSource({ container: this.container }, MediaSources.UNTRUSTED_MESSAGE);
      this.opts.onError(MediaSources.UNTRUSTED_MESSAGE);
      return;
    }
    const opts = {
      container: this.container, link, start: Number(start) || 0, volume: this.volume, muted: this.muted,
      onDuration: seconds => this.opts.onDuration(link, seconds),
      onError: message => this.opts.onError(message),
      requestClick: () => { if (this.opts.requestClick) this.opts.requestClick(); }
    };
    if (media.type === 'twitch') this.source = new TwitchSource(opts, media);
    else if (media.type === 'twitchclip') this.source = new TwitchClipSource(opts, media);
    else if (media.type === 'vimeo') this.source = new VimeoSource(opts, media);
    else if (media.type === 'vdoninja') this.source = new VdoNinjaSource(opts, media);
    else this.source = new VideoElementSource(opts, media);
  }

  /** Destroys the active non-YouTube player source instance. */
  stopSource() {
    if (this.source) { this.source.destroy(); this.source = null; }
  }

  /** Toggles visibility between YouTube iframe and alternative media container. */
  showYouTube(show) {
    this.container.style.display = show ? 'none' : 'block';
    const iframe = this.yt.getIframe && this.yt.getIframe();
    if (iframe) iframe.style.visibility = show ? 'visible' : 'hidden';
  }

  /** Checks if the active media stream is live. @returns {boolean} */
  isLive() { return !!(this.source && this.source.isLive()); }
  /** Checks if currently playing a YouTube source. @returns {boolean} */
  isYouTube() { return !this.source; }

  // --- The YouTube player's methods that player.js uses ---
  loadVideoById(id, start) {
    if (this.source) { this.stopSource(); this.showYouTube(true); }
    this.yt.loadVideoById(id, start);
  }
  playVideo() { this.source ? this.source.play() : this.yt.playVideo(); }
  pauseVideo() { this.source ? this.source.pause() : this.yt.pauseVideo(); }
  seekTo(t) { this.source ? this.source.seek(t) : this.yt.seekTo(t); }
  getCurrentTime() { return this.source ? this.source.time() : this.yt.getCurrentTime(); }
  getPlayerState() { return this.source ? this.source.state() : this.yt.getPlayerState(); }
  setPlaybackRate(r) { this.source ? this.source.setRate(r) : this.yt.setPlaybackRate(r); }
  getPlaybackRate() { return this.source ? this.source.rate() : this.yt.getPlaybackRate(); }
  getVolume() { return this.source ? this.volume : this.yt.getVolume(); }
  setVolume(v) {
    this.volume = Number(v);
    this.yt.setVolume(v);
    if (this.source) this.source.setVolume(v);
  }
  mute() { this.muted = true; this.yt.mute(); if (this.source) this.source.setMuted(true); }
  unMute() { this.muted = false; this.yt.unMute(); if (this.source) this.source.setMuted(false); }
  // Captions are YouTube's own, so these do nothing while another source is playing.
  getVideoData() { return this.source ? { video_id: '' } : this.yt.getVideoData(); }
  loadModule(n) { if (!this.source) this.yt.loadModule(n); }
  unloadModule(n) { if (!this.source) this.yt.unloadModule(n); }
  setOption(a, b, c) { if (!this.source) this.yt.setOption(a, b, c); }
  getOption(a, b) { return this.source ? undefined : this.yt.getOption(a, b); }
}
window.MediaSwitch = MediaSwitch;

// Fullscreen breaks the in-world screen until the space is rejoined, so leave it at once if any
// embedded player (or its controls) asks for it.
['fullscreenchange', 'webkitfullscreenchange'].forEach(name => document.addEventListener(name, () => {
  const el = document.fullscreenElement || document.webkitFullscreenElement;
  if (!el) return;
  console.log('Fire-V-Player: leaving fullscreen');
  try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
}));
