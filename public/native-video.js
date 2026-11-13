/**
 * @fileoverview Native in-world 3D video screen adapter for Banter / Unity.
 * Substitutes an embedded web browser with a native Unity `BanterVideoPlayer` component
 * rendered directly onto a 3D Plane mesh, bypassing CORS/cross-origin iframe barriers
 * while synchronizing playback with the server.
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
      this.holdFromCore();
      this.ready = this.create().catch(e => {
        console.error('[NativeScreen] Could not set up the video player.', e);
        this.core.showToast("Couldn't start the world's video player.", 6000);
      });
    }

    /**
     * Parses the configured screen dimensions from snippet params or returns default.
     * @returns {[number, number]} Width and height in meters.
     */
    size() {
      const parts = String(this.core.params['native-screen-size'] || '').trim().split(/\s+/).map(Number);
      return parts.length === 2 && parts.every(n => n > 0) ? parts : DEFAULT_SIZE;
    }

    /**
     * Instantiates the in-world GameObject, attaches Plane mesh, Material, and BanterVideoPlayer.
     * @returns {Promise<void>}
     */
    async create() {
      const core = this.core;
      if (!core.inWorld() || !(BS.VideoPlayer || BS.BanterVideoPlayer)) throw new Error('No BS SDK scene or video player.');
      // In the browser screen's place, under the world's video home if it has one (see HOME_NAME).
      const t = core.screenTransform();
      const home = this.findHome();
      const go = this.go = await core.makeObject('FireVPlayer_VideoScreen', { parent: home || undefined, position: t.position, rotation: t.rotation, scale: t.scale });
      if (this.destroyed) { core.destroyObject(go); return; }
      const [w, h] = this.size();
      // The plane's renderer has to exist before the video player, which draws onto its material.
      await core.addComponent(go, core.bsComponent('Plane', { width: w, height: h }, 'BanterPlane', [w, h]));
      await core.addComponent(go, core.bsComponent('Material', { shaderName: 'Unlit/Diffuse' }, 'BanterMaterial', ['Unlit/Diffuse']));
      if (this.destroyed) return;
      const settings = { url: this.link, volume: this.unityVolume(), loop: false, playOnAwake: !this.wantPaused && !this.held(), skipOnDrop: true, waitForFirstFrame: true };
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
        this.lastRaw = vp.time;
        this.baseTime = Number(vp.time) || 0;
        this.baseAt = now;
      }
      // Loaded once Unity says so, or once the time starts moving (in case it never does).
      if (!this.prepared && (this.state.isPrepared || this.state.duration > 0 || Number(vp.time) > 0)) {
        this.prepared = true;
        this.core.syncSecondScreens(); // its picture is a texture they can show now (see textureId)
        this.reportDuration();
        this.requestSync(true); // start where everyone else is
      }
      // Not loaded in time: the browser tries it instead (it plays more formats). WebM gets less
      // time, as Unity's player takes only VP8 WebM on PC, and most WebM now is VP9.
      // The path only, as core.js's wantsNativeScreen reads it, so a query can't make a link look like WebM.
      const u = typeof MediaSources !== 'undefined' ? MediaSources.parseUrl(String(this.link)) : null;
      const webm = !!u && /\.webm$/i.test(u.pathname);
      const timeout = webm ? WEBM_PREPARE_TIMEOUT_MS : PREPARE_TIMEOUT_MS;
      if (!this.prepared && now - this.startedAt > timeout && !this.warned) {
        this.warned = true;
        console.warn(`[NativeScreen] ${this.link} hasn't loaded after ${timeout / 1000}s.`);
        if (typeof this.core.playFileInBrowser === 'function') this.core.playFileInBrowser(this.link);
        else this.core.showToast("This file won't load on the world's video player. The link may be wrong, or the format unsupported.", 8000);
      }
      if (this.prepared) {
        if (!this.durationReported) this.reportDuration(); // the length may come later than the first frame
        this.applyPaused();
      }
    }

    /**
     * The SDK's name for this video's picture as a texture other materials can show (see
     * core.js's second screens): "asset_video_" and the video player's id, from its first frame
     * on. Null before that, and on a client whose video player has no such texture.
     * @returns {string|null}
     */
    textureId() {
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
        this.core.sendMessage({ path: Commands.MEDIA_DURATION, data: { link: this.link, duration: d } });
      }
    }

    /** Gets active track object from player state. @returns {Object|null} */
    currentTrack() {
      const p = this.core.player;
      return p && Array.isArray(p.playlist) ? p.playlist[p.currentTrack] : null;
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
      this.holdUntil = performance.now() + seconds * 1000;
      clearTimeout(this.countdownTimer);
      this.countdownTimer = setTimeout(() => {
        this.clearHold();
        this.lastToggleAt = -Infinity;
        this.applyPaused();
        // Once it has had a moment to start. Not a forced jump, which would be heard on every
        // screen as the song starts.
        this.countdownTimer = setTimeout(() => this.requestSync(false), 1000);
      }, seconds * 1000);
      if (this.prepared && this.localTime() > 0.2) this.seek(0);
      this.lastToggleAt = -Infinity;
      this.applyPaused();
    }

    /** Ends a hold, so the next applyPaused may play. @returns {boolean} whether there was one. */
    clearHold() {
      const was = this.holding();
      this.holdUntil = 0;
      clearTimeout(this.countdownTimer);
      if (was) this.lastToggleAt = -Infinity;
      return was;
    }

    /** Computes Unity normalized volume (0.0 to 1.0). @returns {number} */
    unityVolume() {
      return this.muted ? 0 : Math.max(0, Math.min(1, Number(this.volume) / 100 || 0));
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
      const paused = this.wantPaused || this.held(); // a countdown keeps the room's track paused too
      if (this.playing() === !paused) return;
      // At the end, playing again would start the file over. The server moves on instead.
      const d = this.duration();
      if (!paused && (this.endedAt != null || (d && this.localTime() >= d - 0.5))) return;
      this.lastToggleAt = now;
      this.seenPlaying = false; // wait for Unity to say it's playing again
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
      this.vp.time = t;
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
      // Destroying the object destroys the video player with it.
      if (this.go) this.core.destroyObject(this.go);
      this.go = null;
      this.vp = null;
    }
  };
})();
