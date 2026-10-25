// Plays a video or audio file (.mp4, .mp3, ...) on the world's own video player (Unity's, through
// the SDK's BanterVideoPlayer) instead of in the screen's web browser. Many file hosts tell browsers
// not to load their files on other sites; Unity's player isn't a web page, so it plays them anyway.
//
// Core puts one of these in place of the browser screen while a file is playing, and puts the
// browser back afterwards, so only one of them runs at a time (see Core.updateScreen). Each file
// gets a new one. It takes the messages the browser page would have been sent (volume, mute,
// skips, pause, sync) through Core.sendBrowserMessage.
//
// Unity's player can't change speed, so it keeps in time by jumping: it asks the server where the
// video should be every few seconds and jumps there when it is more than a second out.
var FireNativeScreen = (() => {
  // The browser screen's size before the snippet's scale (Core keeps it 1 x 0.5625 m at any
  // resolution). The native-screen-size setting ("width height") changes it.
  const DEFAULT_SIZE = [1, 0.5625];
  // How often to ask Unity for the player's state. Unity sends the time only once a second, so
  // asking more often gains nothing and costs frames on Quest.
  const POLL_MS = 1000;
  const GET_TIMEOUT_MS = 3000;      // a GetProperty Unity never answers mustn't stall the polling
  const DURATION_TRIES = 15;        // polls after loading to wait for a length before giving up
  const SYNC_EVERY_MS = 5000;
  const MAX_DRIFT_S = 1.0;          // jump when further out than this (time reports come once a second)
  const TOGGLE_COOLDOWN_MS = 1500;  // isPlaying takes a moment to catch up after PlayToggle
  const PREPARE_TIMEOUT_MS = 20000;
  const SKIP_S = 5, SKIP_KARAOKE_S = 0.25; // as the browser page's skip buttons

  return class {
    constructor(core, link) {
      this.core = core;
      this.link = link;
      this.destroyed = false;
      this.prepared = false;
      this.autoSync = true;
      this.wantPaused = !!(core.player && core.player.paused);
      this.volume = Number.isFinite(Number(core.tempVolume)) ? Number(core.tempVolume) : Number(core.params.volume);
      this.muted = core.params.mute === 'true' || core.params.mute === true;
      this.baseTime = 0;      // where the video was at baseAt (performance.now())
      this.baseAt = performance.now();
      this.lastToggleAt = -Infinity;
      this.pendingSync = null;
      this.ready = this.create().catch(e => {
        console.error('[NativeScreen] Could not set up the video player.', e);
        this.core.showToast("Couldn't start the world's video player.", 6000);
      });
    }

    size() {
      const parts = String(this.core.params['native-screen-size'] || '').trim().split(/\s+/).map(Number);
      return parts.length === 2 && parts.every(n => n > 0) ? parts : DEFAULT_SIZE;
    }

    async create() {
      const core = this.core;
      if (!core.inWorld() || !(BS.VideoPlayer || BS.BanterVideoPlayer)) throw new Error('No BS SDK scene or video player.');
      // In the browser screen's place.
      const t = core.screenTransform();
      const go = this.go = await core.makeObject('FireVPlayer_VideoScreen', { position: t.position, rotation: t.rotation, scale: t.scale });
      if (this.destroyed) { core.destroyObject(go); return; }
      const [w, h] = this.size();
      // The plane's renderer has to exist before the video player, which draws onto its material.
      await core.addComponent(go, core.bsComponent('Plane', { width: w, height: h }, 'BanterPlane', [w, h]));
      await core.addComponent(go, core.bsComponent('Material', { shaderName: 'Unlit/Diffuse' }, 'BanterMaterial', ['Unlit/Diffuse']));
      if (this.destroyed) return;
      const settings = { url: this.link, volume: this.unityVolume(), loop: false, playOnAwake: !this.wantPaused, skipOnDrop: true, waitForFirstFrame: true };
      const vp = await core.addComponent(go, core.bsComponent('VideoPlayer', settings,
        'BanterVideoPlayer', [settings.url, settings.volume, settings.loop, settings.playOnAwake, settings.skipOnDrop, settings.waitForFirstFrame]));
      if (this.destroyed) return;
      this.vp = vp;
      // time only reaches the page when watched. The other read-only values (isPrepared,
      // isPlaying, duration) keep their first value unless asked for with GetProperty, which
      // poll() does (see readState).
      const P = BS.PN || BS.PropertyName;
      try { vp.WatchProperties([P.time]); } catch (e) {}
      this.state = { isPrepared: false, isPlaying: false, duration: 0 };
      this.lastRaw = vp.time;
      this.startedAt = performance.now();
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
      this.syncTimer = setInterval(() => { if (this.autoSync && !this.wantPaused) this.requestSync(false); }, SYNC_EVERY_MS);
      console.log(`[NativeScreen] Playing ${this.link} on the world's video player.`);
    }

    // ------------------------------------------------------------------ state from Unity
    // Asks Unity for isPrepared, isPlaying and duration. Some files never report a length
    // (duration stays 0), which is fine: the controls work without it, and the playlist waits
    // for someone to skip instead of moving on at the end.
    async readState() {
      const vp = this.vp;
      const P = BS.PN || BS.PropertyName;
      if (!vp || !P) return;
      const get = (name) => {
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
      if (reported && this.state.isPlaying) this.seenPlaying = true;
      else if (reported && this.seenPlaying && !this.wantPaused && this.endedAt == null) {
        this.endedAt = this.localTimeAt(true);
      }
    }
    async poll() {
      if (!this.vp || this.destroyed || this.polling) return;
      this.polling = true;
      try { await this.readState(); } finally { this.polling = false; }
      const vp = this.vp;
      if (!vp || this.destroyed) return;
      const now = performance.now();
      // Unity sends the time once a second, as each second starts, so it is exact when it arrives.
      if (vp.time !== this.lastRaw) {
        this.lastRaw = vp.time;
        this.baseTime = Number(vp.time) || 0;
        this.baseAt = now;
      }
      // Loaded once Unity says so, or once the time starts moving (in case it never does).
      if (!this.prepared && (this.state.isPrepared || this.state.duration > 0 || Number(vp.time) > 0)) {
        this.prepared = true;
        this.reportDuration();
        this.requestSync(true); // start where everyone else is
      }
      if (!this.prepared && now - this.startedAt > PREPARE_TIMEOUT_MS && !this.warned) {
        this.warned = true;
        console.warn(`[NativeScreen] ${this.link} hasn't loaded after ${PREPARE_TIMEOUT_MS / 1000}s.`);
        this.core.showToast("This file won't load on the world's video player. The link may be wrong, or the format unsupported.", 8000);
      }
      if (this.prepared) {
        if (!this.durationReported) this.reportDuration(); // the length may come later than the first frame
        this.applyPaused();
      }
    }

    duration() { return this.state && this.state.duration > 0 ? this.state.duration : 0; }
    playing() { return !!(this.vp && this.state && this.state.isPlaying); }
    localTime() { return this.localTimeAt(this.playing()); }
    localTimeAt(playing) {
      if (this.endedAt != null) return this.endedAt;
      const t = this.baseTime + (playing ? (performance.now() - this.baseAt) / 1000 : 0);
      const d = this.duration();
      return d ? Math.min(t, d) : t;
    }

    // A file's length isn't known until it loads, and the server needs it to move on when it ends.
    reportDuration() {
      const d = this.duration();
      if (!d) return;
      this.durationReported = true;
      const track = this.currentTrack();
      if (track && track.link === this.link && !track.duration) {
        this.core.sendMessage({ path: Commands.MEDIA_DURATION, data: { link: this.link, duration: d } });
      }
    }
    currentTrack() {
      const p = this.core.player;
      return p && Array.isArray(p.playlist) ? p.playlist[p.currentTrack] : null;
    }

    // ------------------------------------------------------------------ control
    unityVolume() {
      return this.muted ? 0 : Math.max(0, Math.min(1, Number(this.volume) / 100 || 0));
    }
    applyVolume() {
      if (!this.vp) return;
      const v = this.unityVolume();
      if (this.vp.volume !== v) this.vp.volume = v;
    }
    // Unity's player only has a play/pause toggle, so this toggles until it matches wantPaused.
    applyPaused() {
      const vp = this.vp;
      if (!vp || !this.prepared) return;
      const now = performance.now();
      if (now - this.lastToggleAt < TOGGLE_COOLDOWN_MS) return;
      if (this.playing() === !this.wantPaused) return;
      // At the end, playing again would start the file over. The server moves on instead.
      const d = this.duration();
      if (!this.wantPaused && (this.endedAt != null || (d && this.localTime() >= d - 0.5))) return;
      this.lastToggleAt = now;
      this.seenPlaying = false; // wait for Unity to say it's playing again
      vp.PlayToggle();
      this.state.isPlaying = !this.state.isPlaying; // until the next readState confirms it
    }
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
      this.vp.time = t;
      this.lastRaw = this.vp.time; // the setter keeps the new value until Unity sends its own
      this.baseTime = t;
      this.baseAt = performance.now();
    }

    // ------------------------------------------------------------------ keeping in time
    requestSync(hard) {
      if (this.destroyed) return;
      this.pendingSync = { hard: !!hard || (this.pendingSync && this.pendingSync.hard) };
      // native: the server answers the world's own connection, not only a browser page's.
      this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now(), native: true } });
    }
    // Jump to the start of the track, or where it is now, after a track change or host seek.
    resync() {
      this.autoSync = true;
      if (this.core.player) this.wantPaused = !!this.core.player.paused;
      this.requestSync(true);
    }
    onSync(data) {
      if (!data || !this.prepared) return;
      const p = this.core.player;
      if (p && typeof data.currentTrack === 'number' && data.currentTrack !== p.currentTrack) return; // stale
      const hard = this.pendingSync && this.pendingSync.hard;
      this.pendingSync = null;
      const latency = Math.max(0, Date.now() - Number(data.clientTimestamp || Date.now())) / 2000;
      const serverTime = Number(data.currentTime) + (this.wantPaused ? 0 : latency);
      if (!Number.isFinite(serverTime)) return;
      const d = this.duration();
      if (d && serverTime >= d - 0.5) return; // about to end; the server moves on
      // Ended with no known length: the server keeps counting until someone skips, so only a
      // host seek or track change (hard) moves it.
      if (this.endedAt != null && !hard) return;
      const drift = serverTime - this.localTime();
      if (hard || (this.autoSync && Math.abs(drift) > MAX_DRIFT_S)) {
        if (!hard) console.log(`[NativeScreen] ${drift > 0 ? 'Behind' : 'Ahead'} by ${Math.abs(drift).toFixed(2)}s, jumping.`);
        this.seek(serverTime);
      }
    }

    // The messages the browser page would have had (see Core.sendBrowserMessage).
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
          // A viewer's own skip: stop pulling them back into step until the next track or host seek.
          if (this.autoSync) {
            this.autoSync = false;
            // So the panel's Auto Sync button shows Off, as the browser page's skip does.
            if (typeof this.core.notifyListeners === 'function') {
              this.core.notifyListeners({ path: Commands.AUTO_SYNC_STATE_CHANGED, data: { enabled: false } });
            }
          }
          const amount = this.core.isKaraoke ? SKIP_KARAOKE_S : SKIP_S;
          this.seek(this.localTime() + (msg.path === Commands.SKIP_FORWARD ? amount : -amount));
          break;
        }
        case Commands.PAUSE_STATE_CHANGED: {
          const data = msg.data || {};
          this.wantPaused = !!data.paused;
          if (!this.wantPaused && Number.isFinite(Number(data.currentTime))) this.seek(Number(data.currentTime));
          this.lastToggleAt = -Infinity;
          this.applyPaused();
          break;
        }
        case Commands.SYNC_TIME:
          this.onSync(msg.data);
          break;
        case Commands.AUTO_SYNC:
          // The viewer's own Auto Sync button: on pulls them back into step straight away.
          this.autoSync = msg.data === true || msg.data === 'true';
          if (this.autoSync) this.requestSync(false);
          break;
      }
    }

    destroy() {
      this.destroyed = true;
      clearInterval(this.pollTimer);
      clearInterval(this.syncTimer);
      // Destroying the object destroys the video player with it.
      if (this.go) this.core.destroyObject(this.go);
      this.go = null;
      this.vp = null;
    }
  };
})();
