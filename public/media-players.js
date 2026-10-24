// Plays playlist items that aren't on YouTube: video/audio files, HLS streams (.m3u8), Twitch and
// Vimeo. MediaSwitch has the same methods player.js already calls on the YouTube player, and passes
// each call to YouTube or to the player for the current link, so the sync code works with all of them.
// Needs media-sources.js (MediaSources) loaded first.

// The same numbers as YT.PlayerState, which player.js compares against.
const MEDIA_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };

const MEDIA_SCRIPTS = {
  hls: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
  twitch: 'https://player.twitch.tv/js/embed/v1.js',
  vimeo: 'https://player.vimeo.com/api/player.js'
};
const mediaScriptLoads = {};
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

// What each source player below provides:
//   play() pause() seek(seconds) time() state() setRate(r) rate() setVolume(0-100) setMuted(bool)
//   isLive() destroy()
// play/pause/seek asked for before the player is ready are remembered and applied once it is.
class BaseMediaSource {
  constructor(opts) {
    this.opts = opts;           // { container, link, start, volume, muted, onDuration, onError }
    this.wantPaused = false;
    this.live = false;
    this.ready = false;
  }
  setRate() {}
  rate() { return 1; }
  isLive() { return this.live; }
  reportDuration(seconds) {
    if (seconds > 0 && isFinite(seconds) && !this.reported) {
      this.reported = true;
      this.opts.onDuration(seconds);
    }
  }
}

// A video or audio file, or an HLS stream, in the page's own <video> element.
class VideoElementSource extends BaseMediaSource {
  constructor(opts, hls) {
    super(opts);
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
      if (el.duration === Infinity) this.live = true; // a live stream
      else {
        this.reportDuration(el.duration);
        if (this.pendingSeek > 0 && this.pendingSeek < el.duration) el.currentTime = this.pendingSeek;
      }
      this.pendingSeek = 0;
      this.wantPaused ? el.pause() : this.tryPlay();
    });
    el.addEventListener('error', () => opts.onError("Couldn't play this video. The link may be wrong, or the site may not allow it here."));
    this.pendingSeek = opts.start;

    if (!hls || el.canPlayType('application/vnd.apple.mpegurl')) {
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
    if (!this.ready) { this.pendingSeek = t; return; }
    this.el.currentTime = Math.max(0, t);
  }
  time() { return this.ready ? this.el.currentTime : (this.pendingSeek || 0); }
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
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el.remove();
  }
}

// A live Twitch channel, or a recorded Twitch video (which can seek, so it stays in sync).
class TwitchSource extends BaseMediaSource {
  constructor(opts, media) {
    super(opts);
    this.live = !!media.channel;
    this.muted = !!opts.muted;
    this.div = document.createElement('div');
    this.div.id = 'twitch-' + Date.now();
    Object.assign(this.div.style, { width: '100%', height: '100%' });
    opts.container.appendChild(this.div);
    this.pendingSeek = opts.start;
    loadMediaScript('twitch').then(() => {
      if (this.destroyed) return;
      const o = {
        width: '100%', height: '100%', autoplay: true, muted: !!opts.muted,
        // Twitch only plays inside pages on the sites listed here, so this is the player page's own.
        parent: [location.hostname]
      };
      if (media.channel) o.channel = media.channel; else o.video = media.video;
      const p = this.p = new Twitch.Player(this.div.id, o);
      p.addEventListener(Twitch.Player.READY, () => {
        this.ready = true;
        this.setVolume(opts.volume);
        if (!this.live && this.pendingSeek > 0) p.seek(this.pendingSeek);
        this.wantPaused ? p.pause() : p.play();
        this.kick = setTimeout(() => this.ensurePlaying(0), 3000);
      });
      p.addEventListener(Twitch.Player.PLAYING, () => {
        if (!this.live) this.reportDuration(p.getDuration());
      });
      if (Twitch.Player.OFFLINE) p.addEventListener(Twitch.Player.OFFLINE, () => opts.onError(`${media.channel} isn't live on Twitch right now.`));
    }).catch(err => opts.onError(err.message));
  }
  // Twitch's player sometimes waits for a click before it starts (it did in Altspace). If it's still
  // paused when it shouldn't be, ask it again, then have the world click the middle of the screen,
  // which is Twitch's play button. It stops after two clicks, and never clicks a playing stream,
  // as a click there would pause it.
  ensurePlaying(tries) {
    clearTimeout(this.kick);
    if (this.destroyed || this.wantPaused || !this.p) return;
    if (!this.p.isPaused()) {
      if (!this.muted && this.p.getMuted()) this.p.setMuted(false); // it may have started muted
      return;
    }
    if (tries === 0) this.p.play();
    else if (tries <= 2) this.opts.requestClick();
    else return;
    this.kick = setTimeout(() => this.ensurePlaying(tries + 1), 2500);
  }
  play() {
    this.wantPaused = false;
    if (this.ready) { this.p.play(); this.kick = setTimeout(() => this.ensurePlaying(1), 2500); }
  }
  pause() { this.wantPaused = true; clearTimeout(this.kick); if (this.ready) this.p.pause(); }
  seek(t) {
    if (this.live) return;
    if (!this.ready) { this.pendingSeek = t; return; }
    this.p.seek(Math.max(0, t));
  }
  time() { return this.ready ? this.p.getCurrentTime() : (this.pendingSeek || 0); }
  state() {
    if (!this.ready) return MEDIA_STATE.UNSTARTED;
    if (this.p.getEnded && this.p.getEnded()) return MEDIA_STATE.ENDED;
    return this.p.isPaused() ? MEDIA_STATE.PAUSED : MEDIA_STATE.PLAYING;
  }
  setVolume(v) { this.volume = v; if (this.ready) this.p.setVolume(Math.max(0, Math.min(1, Number(v) / 100))); }
  setMuted(m) { this.muted = !!m; if (this.ready) this.p.setMuted(!!m); }
  destroy() {
    this.destroyed = true;
    clearTimeout(this.kick);
    try { if (this.p) this.p.pause(); } catch (e) {}
    this.div.remove();
  }
}

// A Twitch clip, in Twitch's clip player. That player can't be controlled from the page: no
// pause, seek or volume, and it doesn't say how long the clip is. So a clip isn't kept in sync
// (it's under a minute), and mute reloads it muted or unmuted.
class TwitchClipSource extends BaseMediaSource {
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
    f.src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(this.clip)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true&muted=${this.muted}`;
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
    this.load();
  }
  destroy() {
    this.destroyed = true;
    if (this.frame) this.frame.remove();
  }
}

// A Vimeo video. Vimeo's player answers with promises, so the time is kept from its timeupdate
// events and counted on between them.
class VimeoSource extends BaseMediaSource {
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

// Shown instead of a link this world doesn't allow.
class NoticeSource extends BaseMediaSource {
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

class MediaSwitch {
  // yt: the YouTube player. opts: { getId(link), onDuration(link, seconds), onError(message),
  //   allowUntrusted() (may this viewer play files/streams?), requestClick() (click the screen's middle) }
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
      Object.assign(this.container.style, { position: 'fixed', inset: '0', background: '#000', display: 'none', zIndex: '5' });
      document.body.appendChild(this.container);
    }
  }

  // Plays a playlist item's link from `start` seconds, with whichever player suits it.
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
    else this.source = new VideoElementSource(opts, media.type === 'hls');
  }
  stopSource() {
    if (this.source) { this.source.destroy(); this.source = null; }
  }
  showYouTube(show) {
    this.container.style.display = show ? 'none' : 'block';
    const iframe = this.yt.getIframe && this.yt.getIframe();
    if (iframe) iframe.style.visibility = show ? 'visible' : 'hidden';
  }
  isLive() { return !!(this.source && this.source.isLive()); }
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
