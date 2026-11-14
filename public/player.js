/**
 * @fileoverview Browser / IFrame Video Player controller for Fire-V-Player.
 * Embedded inside Banter's in-world web browser or iframe. Handles YouTube
 * IFrame API integration, custom non-YouTube media playback via MediaSwitch,
 * multi-client adaptive synchronization, drift measurement, status graphs,
 * and bi-directional messaging with the world and server.
 * @module public/player
 */

/** @constant {number} Jump seek time in seconds when skipping in playlist mode */
const SkipJumpTimePlaylist = 5;
/** @constant {number} Jump seek time in seconds when skipping in karaoke mode */
const SkipJumpTimeKaraoke = 0.25; // 250ms for karaoke, to allow for more precise timing.

// --- Adaptive Sync Constants ---
/** @constant {number} Fast sync interval in ms used when drift is high or after track changes */
const SYNC_INTERVAL_FAST = 800;    // Sync every 0.8s when drift is high or after a change.
const DEFAULT_VIDEO_WAIT_MS = 8000; // The longest the world's track waits for the default video to play.
/** @constant {number} Normal sync interval in ms for moderate drift */
const SYNC_INTERVAL_NORMAL = 2000;   // Sync every 2s for moderate drift.
/** @constant {number} Slow sync interval in ms when player is well-synchronized */
const SYNC_INTERVAL_SLOW = 4000;   // Sync every 4s when well-synced.

/** @constant {number} Drift threshold in seconds above which a hard seek is executed */
const LARGE_DRIFT_THRESHOLD = 0.5; // Above 500ms, do a hard seek. This should be rare.
/** @constant {number} Drift threshold in seconds below which playback is considered in sync */
const SMALL_DRIFT_THRESHOLD = 0.15; // Below 150ms, we are considered in-sync (network jitter alone reaches tens of ms).
/** @constant {number} Drift in seconds at which a speed correction that has started stops */
const SETTLED_DRIFT_THRESHOLD = 0.05; // Stops well inside the band, so it doesn't start again straight away.
/** @constant {number} A sync answer that took longer than this (ms) to come back is too unsure to act on */
const MAX_SYNC_ROUND_TRIP_MS = 400;
/** @constant {number} Readings in a row over LARGE_DRIFT_THRESHOLD before a hard seek */
const LARGE_DRIFT_READINGS = 2;
/** @constant {number} Drift in seconds a new track is corrected for once it plays (see syncAfterLoad) */
const START_SYNC_THRESHOLD = 0.3;
/** @constant {number} How many times a new track is checked: a seek loads again, which can leave it behind again */
const START_SYNC_PASSES = 3;
/** @constant {number} Proportional gain multiplier for subtle playback rate adjustments */
const PROPORTIONAL_GAIN = 0.15;     // How aggressively to correct small drifts.
/** @constant {number} Maximum allowed playback rate deviation (+/- 5%) */
const MAX_SPEED_ADJUSTMENT = 0.05;  // Max speed change is now 5% (0.95x to 1.05x), making it less noticeable.
// --- End of Sync Constants ---

// YouTube can fail partway through a video ("Something went wrong. Refresh or try again later.")
// without telling the page, and the screen stays on the error. A track that should be playing
// but hasn't moved for this long is loaded again where the world is; if it still doesn't move,
// the YouTube player is replaced with a new one, as reloading the page would.
const STALL_CHECK_MS = 2000;
const STALL_RELOAD_MS = 15000;
// A live point report the server didn't take (it couldn't confirm the video is live) is sent again
// this long after, up to this many times in all (see reportLivePosition). The server waits 20 s between checks.
const LIVE_REPORT_RETRY_MS = 30000;
const LIVE_REPORT_TRIES = 3;
const STALL_REBUILD_MS = 15000;
const STALL_RETRY_MS = 60000; // after a new player, the wait before trying again from the start
// YouTube errors that mean the video can't play here at all, so waiting or reloading won't help.
const YT_PERMANENT_ERRORS = [2, 100, 101, 150, 153];

(() => {
  const playerScript = document.currentScript;

  // In Altspace this page can run in an iframe on the space page instead of in a browser of its
  // own (core.js, the `space-screen` setting). The space page then says so in the address
  // (embed=space, po = its origin), and messages go both ways by postMessage, with that page only.
  // Listening starts now, so messages that come before the player is set up aren't lost.
  const spaceFrame = (() => {
    const query = new URLSearchParams(location.search);
    if (query.get('embed') !== 'space' || window.parent === window) return null;
    const origin = query.get('po') || '';
    // Where the browser says which page embeds this one, it has to be the one named.
    const ancestors = location.ancestorOrigins;
    if (!origin || (ancestors && ancestors.length && ancestors[0] !== origin)) {
      console.warn('[Player] Framed by a page other than the one named, so not talking to it.');
      return null;
    }
    const frame = { origin, target: origin === 'null' ? '*' : origin, buffer: [], listener: null };
    window.addEventListener('message', e => {
      if (e.source !== window.parent || e.origin !== origin || typeof e.data !== 'string') return;
      if (frame.listener) frame.listener(e.data);
      else if (frame.buffer.length < 100) frame.buffer.push(e.data);
    });
    return frame;
  })();

  const baseScript = document.createElement("script");
  const currentScriptUrl = new URL(playerScript.src);
  baseScript.setAttribute("src", `${currentScriptUrl.origin}/base-player.js`);

  baseScript.addEventListener("load", () => {
  /**
   * Main client-side player controller running in the browser iframe.
   * Extends {@link BasePlayer}.
   */
  var Player = class extends BasePlayer {
    /**
     * Creates an instance of Player.
     */
    constructor(){
      super(playerScript);
      this.pendingTrackChange = null;
      this.init();
    }
    /**
     * Initializes the player, loading core scripts, setting up websocket connection,
     * status overlays, and messaging hooks.
     * @returns {Promise<void>}
     */
    async init() {
      await super.init(); // Run common setup from BasePlayer

      // Now run the player-specific setup
      // Players for links that aren't on YouTube (Twitch, Vimeo, video files and streams).
      await this.core.setupScript(null, "media-sources");
      await this.core.setupScript(null, "media-players");
      await this.setupBrowserMessaging();
      this.setupVisibilityHandler();
      this.setupStatusDisplay();
      this.isResumingFromPassthrough = false;
      this.initialSyncComplete = false;
      this.currentTime = 0;
      this.syncTimeout = null;
      this.driftHistory = [];
      this.latencyHistory = [];
      this.maxHistoryPoints = 100;
      this.syncIntervalMs = SYNC_INTERVAL_SLOW;

      await this.core.setupWebsocket("player", () => this.parseMessage(event.data), () => {
        // The 'start' parameter is reliably available here after core.init() has run.
        // We pass it to setupYoutubeScript to ensure it's used when the player is created.
        const start = this.core.params.start || 0;
        this.setupYoutubeScript(start);
        // The room's old code as well: this page can join before the space page does.
        this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user,
          legacy: this.core.params['legacy-instance'] || undefined});
        this.core.sendMessage({path: "user-video-player", data: window.user});
      }, ()=>{
          this.core.showToast("Reconnecting...");
      });
      this.playPlaylist();
      window.seek = this.seek.bind(this);
    }
    /**
     * Sets up event listeners for messages dispatched from the host Banter world
     * (`bsmessage` or `bantermessage`), deduplicating recent IDs.
     */
    setupBrowserMessaging() {
      const seen = [];
      // Messages from the world wait until the YouTube player is ready (its onReady), as most of
      // them act on it, and MediaSwitch passes volume and mute to it whatever is playing;
      // drainBrowserMessages runs them then, in order.
      this.browserQueue = [];
      const onMessage = (e) => {
        const message = e && e.detail && e.detail.message;
        try {
          const id = JSON.parse(message).id;
          if (id) {
            if (seen.includes(id)) return;
            seen.push(id);
            if (seen.length > 50) seen.shift();
          }
        } catch (err) {}
        if (!this.player || !this.ytReady) {
          if (this.browserQueue.length < 100) this.browserQueue.push(message);
          return;
        }
        this.parseMessage(message);
      };
      window.addEventListener("bsmessage", onMessage);
      window.addEventListener("bantermessage", onMessage);
      if (spaceFrame) {
        spaceFrame.listener = message => onMessage({ detail: { message } });
        spaceFrame.buffer.splice(0).forEach(spaceFrame.listener);
      }
    }

    /**
     * Dispatches a message back out to the host Banter world environment.
     * @param {Object} msg - Message payload.
     */
    sendBrowserMessage(msg) {
      if (spaceFrame) {
        window.parent.postMessage(JSON.stringify(msg), spaceFrame.target);
      } else if (window.O && typeof window.O.sendMessage === 'function') {
        window.O.sendMessage("app", JSON.stringify(msg));
      } else if (window.bantermessage) {
        window.bantermessage(JSON.stringify(msg));
      } else {
        console.log("No way to message the world, is this in a world?");
      }
    }

    /**
     * Registers visibility change handler to resynchronize player after
     * browser visibility returns (e.g. returning from VR passthrough or tab focus).
     */
    setupVisibilityHandler() {
      document.addEventListener('visibilitychange', () => {
        // When the tab/window becomes visible again (e.g., exiting Quest passthrough)
        if (document.visibilityState === 'visible') {
          if (this.player && this.readyToPlay && !this.previewVideo) {
            // The visibility change triggers a one-time, authoritative resync.
            // We set a flag to tell the
            // SYNC_TIME handler to perform a hard seek, bypassing the normal auto-sync logic.
            this.isResumingFromPassthrough = true;
            this.resumeSyncPending = true; // a skip before the answer cancels it
            this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now() } });
          }
        }
      });
    }

    /**
     * Builds and attaches the in-browser real-time sync diagnostic HUD overlay
     * containing text stats and mini histogram graphs for drift and round-trip latency.
     */
    setupStatusDisplay() {
      // Main container for the entire status display
      const statusContainer = document.createElement('div');
      statusContainer.id = 'status';
      Object.assign(statusContainer.style, {
        position: 'fixed',
        left: '10px',
        background: 'rgba(0, 0, 0, 0.7)',
        color: 'white',
        padding: '5px 10px',
        borderRadius: '5px',
        fontFamily: 'monospace',
        fontSize: '14px',
        zIndex: '9999',
        display: 'none', // Initially hidden
        flexDirection: 'column',
        gap: '5px'
        // Removed the fixed height to prevent it from extending to the bottom.
      });

      // Text display for current values
      const textDisplay = document.createElement('div');
      textDisplay.id = 'status-text';
      statusContainer.appendChild(textDisplay);

      // Container for the graphs
      const graphsContainer = document.createElement('div');
      Object.assign(graphsContainer.style, {
          display: 'flex',
          gap: '10px',
          flexDirection: 'column', // Stack graphs vertically
      });
      statusContainer.appendChild(graphsContainer);


      // Drift Graph
      const driftGraphContainer = document.createElement('div');
      driftGraphContainer.id = 'drift-graph';
      Object.assign(driftGraphContainer.style, {
          display: 'flex',
          alignItems: 'flex-end',
          gap: '1px',
          borderLeft: '1px solid #888',
          borderBottom: '1px solid #888',
          padding: '2px',
          height: '50px', // Set a fixed height for the graph
      });
      graphsContainer.appendChild(driftGraphContainer);

      // Latency Graph
      const latencyGraphContainer = document.createElement('div');
      latencyGraphContainer.id = 'latency-graph';
      Object.assign(latencyGraphContainer.style, {
          display: 'flex',
          alignItems: 'flex-end',
          gap: '1px',
          borderLeft: '1px solid #888',
          borderBottom: '1px solid #888',
          padding: '2px',
          height: '50px', // Set a fixed height for the graph
      });
      graphsContainer.appendChild(latencyGraphContainer);

      document.body.appendChild(statusContainer);
      
      // Store references to the elements we'll need to update
      this.statusElement = statusContainer;
      this.statusTextElement = textDisplay;
      this.driftGraphElement = driftGraphContainer;
      this.latencyGraphElement = latencyGraphContainer;
    }

    /**
     * Resolves after a given number of seconds.
     * @param {number} seconds - Wait duration.
     * @returns {Promise<void>}
     */
    waitFor(seconds) {
      return new Promise(resolve => {
        setTimeout(() => resolve(), seconds * 1000);
      })
    }

    /**
     * Requests the current playlist from the server.
     * @param {boolean} [shouldClear] - Whether to clear existing server playlist before loading.
     */
    playPlaylist(shouldClear) {
      // In karaoke an empty room is the normal idle state (nobody singing), so the default
      // playlist isn't loaded: it would start its first song as if someone were singing it.
      if (this.core.isKaraoke) return;
      this.core.sendMessage({path: Commands.FROM_PLAYLIST, data: {id: this.core.params.playlist, shouldClear, fromPlayer: true}});
    }

    /**
     * Called when the YouTube IFrame API has loaded and is ready.
     * Instantiates the YT.Player and MediaSwitch wrapper.
     * @param {number|string} start - Start time offset in seconds.
     */
    onYouTubeIframeAPIReady(start) {
      this.yt = new YT.Player('player', {
        height: window.innerHeight,
        width: window.innerWidth,
        videoId: this.core.getId(decodeURIComponent(this.core.params.youtube)),
        playerVars: this.youTubePlayerVars(start),
        events: {
          onStateChange: event => this.onYouTubeState(event),
          onError: event => this.onYouTubeError(event),
          onApiChange: async event => {
          },
          onReady: event => {
            this.ytReady = true;
            this.setVolume();
            this.setMute();
            this.player.playVideo(); // Explicitly start playback.
            this.drainBrowserMessages();
            this.startStallWatch();
            // The track waits for the default video to play, but YouTube can block it for some
            // viewers ("Sign in to confirm you're not a bot") without an error, so not for long.
            setTimeout(() => {
              if (this.readyToPlay) return;
              console.log('[PLAYER] The default video never played, so starting the world\'s track.');
              this.startPlaying();
            }, DEFAULT_VIDEO_WAIT_MS);
            // setTimeout(() => this.startPlayerOrNot(), 500);
          }
        }
      });
      // this.player takes the same calls as the YouTube player, and plays non-YouTube links itself.
      this.player = window.MediaSwitch ? new MediaSwitch(this.yt, {
        getId: link => this.core.getId(link),
        onDuration: (link, seconds) => this.reportMediaDuration(link, seconds),
        onError: message => {
          this.core.showToast(message, 6000);
          if (this.previewVideo) {
            this.sendBrowserMessage({ path: Commands.ERROR, data: { message, preview: true } });
          }
        },
        // Untrusted links only play if this viewer's own world allows them.
        allowUntrusted: () => this.core.allowUntrusted === true,
        // Asks this viewer's world to click the middle of their screen, for players (Twitch) that
        // won't start on their own until someone does.
        requestClick: () => this.clickMiddle()
      }) : this.yt;
      if (this.player.setCaptions) this.player.setCaptions(this.core.captions !== false);
    }

    /** The YouTube player's settings, for the first player and any that replaces it. */
    youTubePlayerVars(start) {
      return {
        'playsinline': 1,
        'autoplay': 1,
        'disablekb': 1,
        'controls': 0,
        'modestbranding': true,
        'cc_load_policy': this.core.captions === false ? 0 : 1,
        'cc_lang_pref': 'en',
        'iv_load_policy': 3,
        'origin': window.location.origin,
        'start': Number(start) || 0,
        'vq': this.youTubeQuality()
      };
    }

    /**
     * The YouTube quality to ask for: the smallest that fills this page, whose height is the
     * screen's resolution (720 for 1280 x 720, up to 2160). Asking for more than the screen
     * shows only makes the device decode more, which a Quest in a busy world can't keep up with.
     * YouTube still drops lower by itself when the connection can't carry it.
     */
    youTubeQuality() {
      const height = Math.round((window.innerHeight || 720) * (window.devicePixelRatio || 1));
      const levels = [[360, 'medium'], [480, 'large'], [720, 'hd720'], [1080, 'hd1080'], [1440, 'hd1440'], [2160, 'hd2160']];
      // A little over a level still gets that level (900 high asks for 1080p, 740 for 720p).
      const level = levels.find(([h]) => height <= h * 1.05) || levels[levels.length - 1];
      return level[1];
    }

    onYouTubeState(event) {
      if (event.data === YT.PlayerState.PLAYING) {
        this.applyCaptions(); // each new video loads with the player's caption default
        this.startPlaying();
        const video = this.currentVideo;
        // A video added without its length (YouTube refused the server's lookup): YouTube's player
        // knows it, and the server takes it from the screen, so the track ends (see setMediaDuration).
        if (video && !video.duration && !this.isLiveTrack(video)) {
          // Only the track's own length: the player may still be on another video (the default one).
          let length = 0;
          try {
            const data = this.yt.getVideoData();
            if (data && data.video_id === this.core.getId(video.link)) length = this.yt.getDuration();
          } catch (e) {}
          if (length > 0) this.reportMediaDuration(video.link, length);
        }
        // A live video the server couldn't tell was live was loaded at the room's time, deep in
        // its past: once YouTube says it's live, it goes to the live point, once per load, and
        // reports where that is when it has got there.
        if (video && !video.live && !this.previewVideo && this.liveJumped !== video.link && this.isLiveTrack(video)) {
          this.liveJumped = video.link;
          console.log('[PLAYER] This is a live video; going to its live point.');
          this.seekLiveEdge();
          clearTimeout(this.liveReportTimer);
          this.liveReportTimer = setTimeout(() => this.reportLivePosition(), 3000);
        } else {
          this.reportLivePosition();
        }
        // Held for the room's start (holdStart): it has loaded, so it waits here at 0:00, paused at
        // once rather than at the hold's next check. A live video isn't held (holdStart ends it).
        if (this.holdTimer && this.holdLoaded && !this.isLiveTrack(video)) this.holdLoaded();
      } // The aggressive `playVideo()` call on non-playing states has been removed.
        // The auto-sync logic is the robust way to handle unexpected pauses or buffering
        // by correcting the resulting time drift.
    }

    onYouTubeError(event) {
      if (this.previewVideo) {
        const msg = "Can't play this video here (blocked on embedded players). Try another version.";
        this.core.showToast(msg, 6000);
        this.sendBrowserMessage({ path: Commands.ERROR, data: { message: msg, preview: true } });
        return;
      }
      // Until the world's track starts, an error is the default video's, not the track's.
      if (this.readyToPlay) {
        const currentVideo = this.currentVideo || (this.playerData && this.playerData.playlist && this.playerData.playlist[this.playerData.currentTrack]);
        // Error 150: The video owner has not made this video available in your country.
        // Error 101 is a variation of this.
        if ((event.data === 150 || event.data === 101) && (!this.player.isYouTube || this.player.isYouTube())) {
          if (currentVideo) {
            this.core.showToast(`Video unavailable in your region: ${currentVideo.title}`);
            this.core.sendMessage({ path: Commands.VIDEO_UNAVAILABLE, data: { link: currentVideo.link } });
          }
        }
        // A video that can't play here isn't reloaded by the stall watch.
        if (YT_PERMANENT_ERRORS.includes(event.data) && currentVideo) this.unplayableLink = currentVideo.link;
      }
      console.log("YT Player Error:", event.data);
      // The default video failed (YouTube may want this viewer to sign in): go on to the
      // world's track anyway, or the screen would stay on the error.
      this.startPlaying();
    }

    /** Checks every few seconds that a playing YouTube track is moving (see STALL_RELOAD_MS). */
    startStallWatch() {
      if (this.stall) return;
      this.stall = { lastTime: null, lastProgress: Date.now(), stage: 0 };
      setInterval(() => this.checkStall(), STALL_CHECK_MS);
    }

    checkStall() {
      const s = this.stall;
      const now = Date.now();
      const p = this.player;
      const d = this.playerData;
      const video = this.currentVideo;
      const watching = p && this.ytReady && this.readyToPlay && !this.pendingYt && !this.previewVideo && video && d && !d.paused
        && !document.hidden && (!p.isYouTube || p.isYouTube()) && video.link !== this.unplayableLink;
      let t, state;
      try { t = p.getCurrentTime(); state = p.getPlayerState(); } catch (e) { t = null; }
      // YouTube can answer undefined while it loads. Kept as the last time, nothing after it would
      // count as moving, and a video playing fine would be reloaded again and again.
      if (!Number.isFinite(t)) t = null;
      if (!watching || t === null || state === YT.PlayerState.ENDED) {
        s.lastTime = null; s.lastProgress = now; s.stage = 0;
        return;
      }
      // Only playing counts as moving: a sync seeking a stuck player changes its time too.
      if (state === YT.PlayerState.PLAYING && s.lastTime !== null && t > s.lastTime) {
        if (s.stage) console.log('[PLAYER] YouTube is playing again.');
        s.lastTime = t; s.lastProgress = now; s.stage = 0;
        return;
      }
      // A seek back while playing starts the count from the new point, without being progress
      // itself, or the track would look stuck until it passed where it was.
      if (state === YT.PlayerState.PLAYING && s.lastTime !== null && t < s.lastTime) s.lastTime = t;
      if (s.lastTime === null) s.lastTime = t;
      const stalled = now - s.lastProgress;
      const id = this.core.getId(video.link);
      if (s.stage === 0 && stalled > STALL_RELOAD_MS) {
        s.stage = 1; s.lastProgress = now;
        const at = this.worldTime();
        console.log(`[PLAYER] YouTube hasn't moved for ${Math.round(stalled / 1000)}s (at ${t.toFixed(1)}s, state ${state}), loading it again at ${at.toFixed(1)}s.`);
        this.core.showToast("YouTube stopped, reloading the video...");
        p.loadVideoById(id, this.startAt(video, at));
        p.playVideo();
      } else if (s.stage === 1 && stalled > STALL_REBUILD_MS) {
        s.stage = 2; s.lastProgress = now;
        console.log(`[PLAYER] YouTube still isn't playing (state ${state}), starting a new YouTube player.`);
        this.core.showToast("YouTube still stopped, restarting the player...");
        this.rebuildYouTube();
      } else if (s.stage === 2 && stalled > STALL_RETRY_MS) {
        s.stage = 0; s.lastProgress = now - STALL_RELOAD_MS; // the next check loads it again
      }
    }

    /**
     * Whether a track is streaming live: the server found it so, or YouTube's player says so of
     * the video it has loaded (a link added while the server couldn't tell). Until the server
     * knows where its live point is (liveStart, see reportLivePosition), a live video plays from
     * its live point and isn't synced; after, the room's time is the stream's own, and it's synced
     * like any video.
     * @param {Object} [video] - The track.
     * @returns {boolean}
     */
    isLiveTrack(video) {
      if (!video) return false;
      if (video.live) return true;
      try {
        const p = this.player;
        if (!p || (p.isYouTube && !p.isYouTube())) return false;
        const d = p.getVideoData && p.getVideoData();
        return !!(d && d.isLive && d.video_id && d.video_id === this.core.getId(video.link));
      } catch (e) {
        return false;
      }
    }

    /** A live video whose live point the server doesn't know yet: played live, not synced. */
    liveUnsynced(video) {
      return this.isLiveTrack(video) && !video.liveStart;
    }

    /**
     * Where a track starts: `t`, or nothing, which YouTube opens a live video at its live point:
     * a live video whose live point isn't known yet, or one just made current (t is near 0, the
     * stream's start; the server moves the room to its live point, see tickAllInstances).
     */
    startAt(video, t) {
      if (!this.isLiveTrack(video)) return t;
      if (video.liveStart && t >= 10) return t;
      this.livePending = video.link; // at the live point: reportLivePosition can say where that is
      return undefined;
    }

    /** Puts a live YouTube video at its live point (its length so far). */
    seekLiveEdge() {
      try {
        const end = this.yt && this.yt.getDuration();
        if (end > 0) this.yt.seekTo(end, true);
        if (this.currentVideo) this.livePending = this.currentVideo.link;
      } catch (e) {}
    }

    /**
     * Tells the server YouTube's position at a live video's live point, from a screen that is
     * there (it opened the video there, or went there), once per load, until the server knows it.
     */
    reportLivePosition() {
      const video = this.currentVideo;
      if (!video || this.previewVideo || video.liveStart || this.livePending !== video.link || !this.isLiveTrack(video)) return;
      // Only once YouTube has this video loaded: until then its time is the last video's. Still
      // pending, so its PLAYING reports it.
      let loaded = null;
      try { const d = this.yt.getVideoData(); loaded = d && d.video_id; } catch (e) {}
      if (loaded !== this.core.getId(video.link)) return;
      let position = 0;
      try { position = this.yt.getCurrentTime(); } catch (e) {}
      if (!(position > 0)) return;
      this.livePending = null;
      console.log(`[PLAYER] Live point of ${video.link}: ${Math.round(position)}s into the stream.`);
      this.core.sendMessage({ path: Commands.LIVE_POSITION, data: { link: video.link, position } });
      // The server checks with YouTube first, which can fail: with no live point back, this screen
      // reports again, LIVE_REPORT_TRIES times in all for this video, LIVE_REPORT_RETRY_MS apart.
      if (this.liveReports && this.liveReports.link === video.link) this.liveReports.count++;
      else this.liveReports = { link: video.link, count: 1 };
      clearTimeout(this.liveRetryTimer);
      if (this.liveReports.count < LIVE_REPORT_TRIES) {
        this.liveRetryTimer = setTimeout(() => {
          const v = this.currentVideo;
          if (!v || v.link !== video.link || v.liveStart) return;
          this.livePending = v.link;
          this.reportLivePosition();
        }, LIVE_REPORT_RETRY_MS);
      }
    }

    worldTime() {
      const d = this.playerData;
      const live = (Date.now() / 1000) - (this.clockSkew || 0) - Number(d.lastStartTime);
      if (Number.isFinite(live) && live >= 0) return live;
      return (this.stall.lastTime || 0) + (Date.now() - this.stall.lastProgress) / 1000;
    }

    /**
     * Replaces the YouTube player with a new one, as a page reload would. The old one takes
     * every call until the new one is ready, then the new one takes its place and plays the
     * world's track from where the world is.
     */
    rebuildYouTube() {
      const old = this.yt;
      const oldFrame = old.getIframe && old.getIframe();
      const parent = (oldFrame && oldFrame.parentNode) || document.getElementById('stage') || document.body;
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', border: '0', visibility: 'hidden' });
      // destroy() puts back the element a player replaced, so each is removed after it.
      const destroy = player => {
        let frame = null;
        try { frame = player.getIframe(); } catch (e) {}
        const next = frame && frame.nextSibling, parentNode = frame && frame.parentNode;
        try { player.destroy(); } catch (e) {}
        const back = parentNode && (next ? next.previousSibling : parentNode.lastChild);
        if (back && back !== frame && back.tagName === 'DIV' && !back.childNodes.length) back.remove();
      };
      parent.insertBefore(el, oldFrame ? oldFrame.nextSibling : parent.firstChild);
      const yt = this.pendingYt = new YT.Player(el, {
        height: window.innerHeight,
        width: window.innerWidth,
        playerVars: this.youTubePlayerVars(0),
        events: {
          onStateChange: event => { if (this.yt === yt) this.onYouTubeState(event); },
          onError: event => { if (this.yt === yt) this.onYouTubeError(event); },
          onReady: () => {
            if (this.pendingYt !== yt) return;
            this.pendingYt = null;
            destroy(old);
            const frame = yt.getIframe();
            const left = document.getElementById('player'); // anything the old player left behind
            if (left && left !== frame) left.remove();
            frame.id = 'player';
            this.yt = yt;
            if (this.player === old) this.player = yt; else this.player.yt = yt;
            // The new player has none of the old one's captions, even for the same video.
            clearTimeout(this.captionsTimer);
            this.captionsApplied = null;
            yt.setVolume(Number(this.core.params.volume));
            if (this.core.params.mute === 'true' || this.core.params.mute === true || Number(this.core.params.volume) === 0) yt.mute(); else yt.unMute();
            // Another site's player may have taken over the screen meanwhile.
            if (this.player.isYouTube && !this.player.isYouTube()) return;
            frame.style.visibility = 'visible';
            if (this.previewVideo) {
              yt.loadVideoById(this.core.getId(this.previewVideo.link), 0);
              return;
            }
            const d = this.playerData;
            const video = this.currentVideo;
            if (!video || !d) return;
            if (d.paused) yt.cueVideoById(this.core.getId(video.link), this.startAt(video, Number(d.currentTime) || 0));
            else yt.loadVideoById(this.core.getId(video.link), this.startAt(video, this.worldTime()));
            console.log('[PLAYER] The new YouTube player is ready.');
          }
        }
      });
      // A new player that never gets ready is dropped, and the old one kept.
      setTimeout(() => {
        if (this.pendingYt !== yt) return;
        this.pendingYt = null;
        console.log('[PLAYER] The new YouTube player never got ready, keeping the old one.');
        destroy(yt);
      }, 20000);
    }

    /**
     * The first time the player can play: plays the world's track, which waited for this.
     * Runs once the default video plays, fails, or takes too long (see onYouTubeIframeAPIReady).
     */
    startPlaying() {
      if (this.readyToPlay) return;
      this.readyToPlay = true;
      if (this.previewVideo) {
        if (this.pendingTrackChange && this.playerData) this.applyTrackChange(this.pendingTrackChange);
        this.pendingTrackChange = null;
        this.initialSyncComplete = true;
        return;
      }
      if (this.pendingTrackChange && this.playerData) {
        // A track change was received before we were ready. Apply it now.
        const data = this.pendingTrackChange;
        this.pendingTrackChange = null;
        this.applyTrackChange(data);
      } else {
        this.playInitialSync();
      }
    }

    /** Plays where the world is (joining, or rejoining, an instance that has a playlist), once. */
    playInitialSync() {
      if (this.previewVideo) {
        this.initialSyncComplete = true;
        return;
      }
      if (!this.playerData || !this.playerData.playlist || !this.playerData.playlist.length || this.initialSyncComplete) return;
      // The sync may have waited (up to DEFAULT_VIDEO_WAIT_MS) for the player, so a playing track
      // starts where it is now; a paused one at its stored time.
      const d = this.playerData;
      const live = (Date.now() / 1000) - (this.clockSkew || 0) - d.lastStartTime;
      const start = !d.paused && Number.isFinite(live) ? Math.max(0, live) : d.currentTime;
      this.playVidya(d.currentTrack, start, true);
      this.initialSyncComplete = true;
      // Joining takes time to load too, so it catches up once it plays. During a karaoke
      // countdown it waits at 0:00 for what's left of it instead.
      if (!d.paused && live < 0 && live > -30) this.holdStart(-live);
      else if (!d.paused) this.syncAfterLoad();
      // This is the first sync, so we should start with a fast interval.
      if (this.autoSync) {
        this.syncIntervalMs = SYNC_INTERVAL_FAST;
        this.scheduleNextSync();
      }
    }

    /**
     * A length of time for a toast: "5s", "0.25s", "1:40", "1:02:03". `clock` always uses the
     * m:ss form, for a point in the video.
     * @param {number} seconds
     * @param {boolean} [clock]
     * @returns {string}
     */
    durationText(seconds, clock) {
      seconds = Math.max(0, Number(seconds) || 0);
      if (seconds < 60 && !clock) return `${Math.round(seconds * 100) / 100}s`;
      const t = Math.round(seconds);
      const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = String(t % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    }

    /** Runs the world's messages that came before the player was ready (see setupBrowserMessaging). */
    drainBrowserMessages() {
      const queued = (this.browserQueue || []).splice(0);
      queued.forEach(message => this.parseMessage(message));
    }

    /**
     * Requests the Banter world to simulate a click in the center of the web screen
     * to unlock autoplay on media types (e.g. Twitch) requiring user interaction.
     */
    clickMiddle() {
      this.core.sendMessage({ path: Commands.CLICK_BROWSER, data: { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2), fx: 0.5, fy: 0.5 } });
    }

    /**
     * Reports media duration discovered dynamically by client media players back to the server.
     * @param {string} link - Media URL.
     * @param {number} seconds - Discovered duration in seconds.
     */
    reportMediaDuration(link, seconds) {
      if (this.previewVideo) return;
      const video = this.currentVideo;
      if (!video || video.link !== link || video.duration) return;
      this.core.sendMessage({ path: Commands.MEDIA_DURATION, data: { link, duration: seconds } });
    }

    /**
     * Attempts to initiate player playback if not already started.
     */
    startPlayerOrNot() {
      if(this.player && !this.isPlayerStarted && this.core.connected() && !this.readyToPlay) {
        this.clickMiddle();
        this.isPlayerStarted = true;
      }
    }

    /**
     * Seeks playback relative to the current position.
     * @param {number} time - Seconds delta to seek.
     * @returns {string|undefined} Status message string.
     */
    seek(time) {
      if(this.player) {
        const timeForward = this.player.getCurrentTime() + time;
        this.player.seekTo(timeForward);
        return "Seeking to: " + timeForward;
      }
    }
    /**
     * Parses and dispatches incoming WebSocket and host messages to appropriate handlers.
     * @param {string} msg - Raw JSON message payload.
     */
    parseMessage(msg) {
      let json;
      try { json = JSON.parse(msg); } catch { return; }
      // Messages from the in-world script carry its current mode, which can change in world.
      if (json && typeof json.km === 'boolean') this.core.isKaraoke = json.km;
      // ...and this viewer's closed captions setting.
      if (json && typeof json.cc === 'boolean' && json.cc !== (this.core.captions !== false)) {
        this.core.captions = json.cc;
        this.applyCaptions(true);
      }
      switch(json.path) {
      case Commands.SET_VOLUME:
        if(json.data >= 0 && json.data <= 100) {
          this.core.params.volume = Number(json.data);
          this.setVolume(json.type);
          this.setMute();
          this.sendBrowserMessage(json);
        }
        break;
      case Commands.PREVIEW_VIDEO:
        this.applyPreview(json.data);
        break;
      case Commands.SKIP_BACK:
      case Commands.SKIP_FORWARD: {
        // While previewing a song, skip by the 5s playlist step so the viewer can check the lyrics,
        // without turning off AutoSync or pausing for the host.
        if (this.previewVideo) {
          const amount = SkipJumpTimePlaylist;
          const forward = json.path === Commands.SKIP_FORWARD;
          this.player.seekTo(Math.max(0, this.player.getCurrentTime() + (forward ? amount : -amount)));
          this.player.playVideo();
          this.core.showToast(`${forward ? '+' : '-'}${amount}s (preview)`);
          break;
        }
        // A viewer's own skip. While the host has paused it stays paused (playing on would put
        // them ahead of everyone); the host's resume brings everyone to the same point.
        this.disableAutoSync(true);
        // The skip wins over a resume sync still waiting or on its way (see pause-state-changed).
        clearTimeout(this.resumeSyncTimer);
        if (this.resumeSyncPending) {
          this.resumeSyncPending = false;
          this.isResumingFromPassthrough = false;
          this.startSyncPasses = 0;
        }
        const amount = this.core.isKaraoke ? SkipJumpTimeKaraoke : SkipJumpTimePlaylist;
        const forward = json.path === Commands.SKIP_FORWARD;
        this.player.seekTo(this.player.getCurrentTime() + (forward ? amount : -amount));
        const hostPaused = !!(this.playerData && this.playerData.paused);
        if (hostPaused) this.player.pauseVideo();
        else this.player.playVideo(); // seeking can stop playback
        this.core.showToast(`${forward ? '+' : '-'}${amount}s${hostPaused ? ' (the host has paused it)' : ''}`);
        break;
      }
      case Commands.AUTO_SYNC:
        if (json.data) {
          this.enableAutoSync();
        } else {
          this.disableAutoSync();
        }
        break;
      case Commands.PLAYBACK_UPDATE:
        // If this is the very first message a client gets, it should replace its state.
        // For all subsequent updates, it should merge, because some updates might be
        // partial (e.g., not including the full playlist).
        if (json.data.type === 'initial-sync') {
          this.playerData = json.data.video;
        } else {
          // Merge new data into the existing player state.
          // This prevents the playlist from being wiped out on updates that don't include it.
          this.playerData = Object.assign(this.playerData || {}, json.data.video);
        }
        // How far this device's clock is from the server's, for working out the live position later.
        if (json.data.video && Number.isFinite(Number(json.data.video.lastStartTime)) && Number.isFinite(Number(json.data.video.currentTime)) && !json.data.video.paused) {
          this.clockSkew = (Date.now() / 1000) - (Number(json.data.video.lastStartTime) + Number(json.data.video.currentTime));
        }

        // The specific 'set-track' logic is now handled by the TRACK_CHANGED command.
        if (json.data.type === "stop" && this.readyToPlay && !this.previewVideo) {
          this.player.loadVideoById(this.core.getId("https://www.youtube.com/watch?v=GiwStUzx8fg"), 0);
        }
        // The initial sync waits for the player (startPlaying), unless the player was first.
        if (json.data.type === 'initial-sync' && this.readyToPlay && !this.previewVideo) this.playInitialSync();
        break;
      case Commands.PLAYLIST_UPDATED:
        // This message is sent when the playlist order changes (e.g., move up/down).
        // We need to update the player's internal copy of the playlist and current track index
        // to stay in sync, even if the video itself doesn't change.
        if (this.playerData) {
          this.playerData.playlist = json.data.playlist;
          this.playerData.currentTrack = json.data.currentTrack;
        }
        break;
      // --- Add granular playlist management to keep the player's state in sync ---
      case Commands.ITEM_REMOVED:
        if (this.playerData && this.playerData.playlist) {
          this.playerData.playlist.splice(json.data.index, 1);
          this.playerData.currentTrack = json.data.newCurrentTrack;
        }
        break;
      case Commands.ITEM_APPENDED:
        if (this.playerData && this.playerData.playlist) {
          this.playerData.playlist.push(json.data.video);
        }
        break;
      case Commands.ITEM_INSERTED:
        if (this.playerData && this.playerData.playlist) {
          this.playerData.playlist.splice(json.data.index, 0, json.data.video);
          // Note: currentTrack is not affected when inserting after the current song.
        }
        break;
      case Commands.ITEM_MOVED:
        if (this.playerData && this.playerData.playlist) {
          const { oldIndex, newIndex, newCurrentTrack } = json.data;
          const [itemToMove] = this.playerData.playlist.splice(oldIndex, 1);
          this.playerData.playlist.splice(newIndex, 0, itemToMove);
          this.playerData.currentTrack = newCurrentTrack;
        }
        break;
      case Commands.ITEM_REPLACED:
        if (this.playerData && this.playerData.playlist) {
          const { index, newVideo } = json.data;
          if (this.playerData.playlist[index]) {
            this.playerData.playlist[index] = newVideo;
          }
        }
        break;
      case Commands.TRACK_CHANGED:
        // This is the new authoritative command for changing tracks.
        // A countdown (a time below zero) says what the server's clock reads now, so one applied
        // later (below, or after a preview) still ends when the server's does.
        if (json.data && Number(json.data.newCurrentTime) < 0 && json.data.paused !== true && Number.isFinite(Number(json.data.newLastStartTime))) {
          this.clockSkew = (Date.now() / 1000) - (Number(json.data.newLastStartTime) + Number(json.data.newCurrentTime));
        }
        if (this.playerData && this.readyToPlay) { // Player is ready, apply immediately.
          this.applyTrackChange(json.data);
        } else {
          // Player isn't ready. Cache the track change data to be applied when it is.
          this.pendingTrackChange = json.data;
        }
        break;
      case Commands.READY_START: {
        // Every screen has loaded the new track (see holdStart), so the wait ends sooner.
        const d = json.data;
        if (!d || !this.playerData) break;
        const track = this.playerData.playlist && this.playerData.playlist[this.playerData.currentTrack];
        if (!track || track.link !== d.link || this.playerData.paused) break;
        this.playerData.lastStartTime = d.newLastStartTime;
        this.playerData.currentTime = d.newCurrentTime;
        // Not applied yet (the player wasn't ready): it starts from these times when it is.
        if (this.pendingTrackChange) {
          this.pendingTrackChange.newLastStartTime = d.newLastStartTime;
          this.pendingTrackChange.newCurrentTime = d.newCurrentTime;
          break;
        }
        if (this.previewVideo) break;
        const left = Math.max(0, -Number(d.newCurrentTime) || 0);
        console.log(`[PLAYER] Every screen has loaded the track; starting in ${left.toFixed(1)}s.`);
        if (this.holdTimer) this.holdUntil = Date.now() + left * 1000;
        else if (left > 0) this.holdStart(left);
        break;
      }
      case Commands.LIVE_POSITION:
        // The live video's live point is known: the room's time is the stream's own from now on,
        // and this screen is synced to it (it's at the live point already, or goes there).
        if (this.holdTimer) this.endHold(); // not a start to wait for: the live point
        if (this.playerData && json.data) {
          if (!this.playerData.paused) {
            this.playerData.lastStartTime = json.data.newLastStartTime;
            this.playerData.currentTime = json.data.newCurrentTime;
          }
          [...(this.playerData.playlist || []), this.currentVideo].forEach(v => {
            if (v && v.link === json.data.link) { v.live = true; v.liveStart = json.data.liveStart; }
          });
          // A track change not applied yet (the player wasn't ready) starts at the live point too,
          // not at the times it came with.
          const pending = this.pendingTrackChange;
          if (pending) {
            const list = pending.playlist || this.playerData.playlist || [];
            const link = (pending.track && pending.track.link) || (list[pending.newTrackIndex] || {}).link;
            const paused = typeof pending.paused === 'boolean' ? pending.paused : this.playerData.paused;
            if (link === json.data.link) {
              // Its own copies of the track get the live details, as applyTrackChange plays from them.
              [pending.track, list[pending.newTrackIndex]].forEach(v => {
                if (v && v.link === json.data.link) { v.live = true; v.liveStart = json.data.liveStart; }
              });
              if (!paused) {
                pending.newLastStartTime = json.data.newLastStartTime;
                pending.newCurrentTime = json.data.newCurrentTime;
              }
            }
          }
          if (this.currentVideo && this.currentVideo.link === json.data.link && !this.previewVideo && !this.playerData.paused) this.syncAfterLoad();
        }
        break;
      case Commands.HOST_SEEK:
        // A seek during a countdown ends it, or its timer would pause and rewind the seek.
        if (this.holdTimer) {
          clearInterval(this.holdTimer);
          this.holdTimer = null;
          this.hideCountdown();
        }
        if (this.playerData && json.data) {
          this.playerData.lastStartTime = json.data.newLastStartTime;
          this.playerData.currentTime = json.data.newCurrentTime;
          if (typeof json.data.paused === 'boolean') this.playerData.paused = json.data.paused;
        }
        if (this.previewVideo) break;
        if (this.player && this.readyToPlay && this.playerData) {
          const oldTime = this.player.getCurrentTime();
          const newTime = json.data.newCurrentTime;
          const diff = newTime - oldTime;

          this.player.seekTo(newTime);
          // A seek while paused stays paused, as the buttons and panel show.
          if (this.playerData.paused) this.player.pauseVideo();
          else this.player.playVideo();

          // How far it really moved, from the server (older servers: from this screen's time).
          const moved = Number.isFinite(Number(json.data.skipped)) ? Number(json.data.skipped) : diff;
          const amount = `${moved < 0 ? '-' : '+'}${this.durationText(Math.abs(moved))}`;
          this.core.showToast(json.data.seek
            ? `Host seek to ${this.durationText(newTime, true)} (${amount})`
            : `Host skip: ${amount}`);
          this.disableAutoSync(true);
        }
        break;
      case 'pause-state-changed':
        console.log("[PLAYER] PAUSE_STATE_CHANGED received from world", json.data);
        if (this.playerData && json.data) {
          this.playerData.paused = json.data.paused;
          this.playerData.currentTime = json.data.currentTime;
          this.playerData.lastStartTime = json.data.lastStartTime;
        }
        if (this.previewVideo) break;
        if (this.player && this.readyToPlay) {
          const { paused, currentTime, lastStartTime } = json.data;
          if (paused) {
            console.log("[PLAYER] Pausing YouTube");
            this.player.pauseVideo();
            this.core.showToast("Host paused playback.");
            // We no longer call this.disableAutoSync() here to preserve the user's manual toggle state
            // and UI visibility. The SYNC_TIME handler already ignores syncs while paused.
          } else if (Number(currentTime) < 0) {
            // Resumed during a karaoke countdown: wait out what's left of it (holdStart syncs at the end).
            console.log("[PLAYER] Resuming during the countdown,", -currentTime, "s left");
            clearTimeout(this.resumeSyncTimer);
            // Back to the start first: a skip while paused may have moved it, and the hold only
            // rewinds a video that is playing.
            try { this.player.seekTo(0); } catch (e) {}
            this.holdStart(-Number(currentTime));
            this.core.showToast("Host resumed playback.");
          } else if (this.liveUnsynced(this.currentVideo)) {
            // A live video with no known live point resumes live, not where it was paused.
            console.log("[PLAYER] Resuming a live video at its live point");
            this.seekLiveEdge();
            this.player.playVideo();
            this.core.showToast("Host resumed playback.");
          } else {
            console.log("[PLAYER] Resuming YouTube at", currentTime);
            // Everyone goes to the point the host resumed at (whatever they skipped to while
            // paused), then one sync a moment later corrects for the time the message took.
            this.player.seekTo(currentTime);
            this.player.playVideo();
            this.core.showToast("Host resumed playback.");
            clearTimeout(this.resumeSyncTimer);
            this.resumeSyncTimer = setTimeout(() => {
              if (!this.player || (this.playerData && this.playerData.paused)) return;
              this.resumeSyncPending = true; // a skip before the answer cancels it
              this.isResumingFromPassthrough = true; // a one-time hard seek to the server's time
              this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now() } });
            }, 1500);
            // We no longer call this.enableAutoSync() here, which prevents the Auto Sync UI
            // from forcefully appearing on every resume.
          }
        } else {
          console.log("[PLAYER] Player not ready or missing", { player: !!this.player, ready: this.readyToPlay });
        }
        break;
      case Commands.CAPTIONS:
        this.core.captions = json.data !== false;
        this.applyCaptions(true);
        break;
      case Commands.MUTE:
        this.core.params.mute = json.data;
        this.core.showToast(this.core.params.mute === true || this.core.params.mute === 'true' ? "mute" : "unmute");
        this.setMute();
        break;
      case Commands.SYNC_TIME:
        this.currentTime = json.data.currentTime;
        if (this.previewVideo) break;
        // A live stream (Twitch channel, live .m3u8, live YouTube video) has no shared position
        // to keep in sync: each screen plays it live.
        if (this.player && ((this.player.isLive && this.player.isLive()) || this.liveUnsynced(this.currentVideo))) {
          this.isResumingFromPassthrough = false;
          this.resumeSyncPending = false;
          this.startSyncPasses = 0;
          break;
        }
        if(this.player && this.readyToPlay) {
          // Calculate latency on-the-fly from the echoed timestamp
          const roundTripTime = Date.now() - json.data.clientTimestamp;
          const latency = roundTripTime / 2 / 1000; // latency in seconds
          // A track counting down to its start has nothing to sync to yet, unless this screen
          // asked after loading (below).
          if (Number(json.data.currentTime) < 0 && !(this.isResumingFromPassthrough && this.startSyncPasses)) break;

          const serverTime = json.data.currentTime + latency;
          const localTime = this.player.getCurrentTime();
          // Positive timediff means client is BEHIND server. Negative means client is AHEAD.
          const timediff = serverTime - localTime;
          
          // Store history for the graph
          this.driftHistory.push(timediff * 1000);  // Store in ms
          this.latencyHistory.push(latency * 1000); // Store in ms
          if (this.driftHistory.length > this.maxHistoryPoints) this.driftHistory.shift();
          if (this.latencyHistory.length > this.maxHistoryPoints) this.latencyHistory.shift();

          // Update the status display graph if it exists.
          if (this.statusElement) {
            this.updateGraphDisplay(timediff, latency);
          }

          // If this sync was triggered by resuming from passthrough/focus, perform a
          // one-time hard seek to get back in sync, regardless of auto-sync state.
          if (this.isResumingFromPassthrough) {
            this.isResumingFromPassthrough = false; // Reset the flag
            this.resumeSyncPending = false;
            this.player.setPlaybackRate(1.0); // Ensure rate is normal
            if (this.playerData && this.playerData.paused) {
              // The host has it paused: go to the held point and stay paused.
              this.player.seekTo(json.data.currentTime);
              this.player.pauseVideo();
              break;
            }
            // A track that has just loaded (see syncAfterLoad) only moves if it's really out, and
            // is looked at again afterwards, as the seek itself takes time to load.
            const passes = this.startSyncPasses || 0;
            this.startSyncPasses = 0;
            if (passes) {
              if (!Number.isFinite(timediff)) { this.syncAfterLoad(passes); break; } // not the answer to our question
              // Still counting down to the start (see holdStart, which syncs when it ends).
              // A screen not holding yet (it joined during the countdown) waits at 0:00 for what's left.
              if (serverTime < 0) {
                if (!this.holdTimer) {
                  try { this.player.pauseVideo(); this.player.seekTo(0); } catch (e) {}
                  this.holdStart(-serverTime);
                }
                break;
              }
              if (Math.abs(timediff) > START_SYNC_THRESHOLD) {
                console.log(`[PLAYER] The new track is ${timediff.toFixed(2)}s behind the world after loading, catching up.`);
                this.core.showToast(`Catching up: ${timediff > 0 ? '+' : '-'}${this.durationText(Math.abs(timediff))}`);
                this.player.seekTo(serverTime);
                this.player.playVideo();
                if (passes > 1) this.syncAfterLoad(passes - 1);
              }
              if (this.autoSync) {
                this.syncIntervalMs = SYNC_INTERVAL_FAST;
                this.scheduleNextSync();
              }
              break;
            }
            this.core.showToast(`Resyncing after pause...`);
            this.player.seekTo(serverTime);
            // Explicitly call playVideo() after seeking, as seekTo() can sometimes
            // interrupt playback. This ensures the video resumes as expected.
            this.player.playVideo();
            // If auto-sync is on, we should also schedule the next sync to continue.
            // Otherwise, we're done.
            if (this.autoSync) {
              this.syncIntervalMs = SYNC_INTERVAL_FAST; // Start fast after a resync
              this.scheduleNextSync();
            }
            break; // Exit the SYNC_TIME handler for this message
          }

          if (this.autoSync && !this.playerData.paused) {
            // If the player is paused but should be auto-syncing, play it.
            // This handles accidental pauses from media keys, etc. A state of PAUSED (2)
            // is the primary one to correct. BUFFERING (3) should be allowed to continue.
            if (this.player.getPlayerState() === YT.PlayerState.PAUSED) {
              this.core.showToast("Playback resumed by AutoSync.");
              this.player.playVideo();
            }

            // A changed speed and a seek are both heard in music, so neither is done on a reading
            // that may be wrong: an answer that came back late (a busy device or a slow network
            // makes the drift look bigger than it is) is skipped, and a seek waits for a second
            // large reading in a row.
            const correcting = this.player.getPlaybackRate() !== 1.0;
            const late = roundTripTime > MAX_SYNC_ROUND_TRIP_MS;
            const large = !late && Math.abs(timediff) > LARGE_DRIFT_THRESHOLD;
            this.largeDriftReadings = large ? (this.largeDriftReadings || 0) + 1 : 0;
            if (late) {
              // A speed set on an earlier reading isn't left running on one that can't be trusted.
              if (correcting) this.player.setPlaybackRate(1.0);
              this.syncIntervalMs = SYNC_INTERVAL_NORMAL;
            } else if (large && this.largeDriftReadings < LARGE_DRIFT_READINGS) {
              // Checked again very soon, before anything is changed.
              this.syncIntervalMs = SYNC_INTERVAL_FAST;
            } else if (large) {
              this.largeDriftReadings = 0;
              // Large drift, a hard seek is necessary for a quick correction.
              const direction = timediff > 0 ? 'FORWARDS +' : 'BACKWARDS -';
              const amount = Math.abs(Math.round(timediff * 100) / 100);
              this.core.showToast(`Resyncing: ${direction}${amount}s`);
              this.player.seekTo(serverTime);
              this.player.setPlaybackRate(1.0); // Ensure rate is normal after a seek.
              // High drift, so we should check again very soon.
              this.syncIntervalMs = SYNC_INTERVAL_FAST;
            } else if (Math.abs(timediff) > (correcting ? SETTLED_DRIFT_THRESHOLD : SMALL_DRIFT_THRESHOLD)) {
              // Small drift, adjust playback speed for a smooth, unnoticeable correction.
              // The adjustment is proportional to the drift. A positive drift means we are
              // behind, so we need to speed up (newRate > 1.0).
              let adjustment = timediff * PROPORTIONAL_GAIN;
              // Clamp the adjustment to prevent extreme (and noticeable) speed changes.
              adjustment = Math.max(-MAX_SPEED_ADJUSTMENT, Math.min(MAX_SPEED_ADJUSTMENT, adjustment));
              const newRate = 1.0 + adjustment;
              this.player.setPlaybackRate(newRate);
              // Moderate drift, check again at a normal rate.
              this.syncIntervalMs = SYNC_INTERVAL_NORMAL;
            } else {
              // We are in sync, ensure playback rate is normal.
              if (correcting) {
                this.player.setPlaybackRate(1.0);
              }
              // Low drift, we can afford to check less frequently.
              this.syncIntervalMs = SYNC_INTERVAL_SLOW;
            }
            // Schedule the next sync with the newly determined interval.
            this.scheduleNextSync();
          }
        }
        break;
    }
  }
    /**
     * Updates the diagnostic HUD display with current drift and latency stats,
     * rendering historical bar charts for both.
     * @param {number} currentDrift - Time difference in seconds.
     * @param {number} currentLatency - One-way network latency estimate in seconds.
     */
    updateGraphDisplay(currentDrift, currentLatency) {
      // Update the text part of the display
      this.statusTextElement.innerHTML = `Drift: ${Math.round(currentDrift * 1000)}ms | Latency: ${Math.round(currentLatency * 1000)}ms`;

      // --- Render Drift Graph ---
      this.driftGraphElement.innerHTML = ''; // Clear previous bars
      this.driftHistory.forEach(driftMs => {
        const bar = document.createElement('div');
        // Scale the height: 1px per 5ms of drift, capped at 50px.
        const height = Math.min(50, Math.abs(driftMs) * 0.2); 
        let color = '#4caf50'; // Green for good sync (<40ms)
        
        if (Math.abs(driftMs) > SMALL_DRIFT_THRESHOLD * 1000) {
          // Yellow if we are behind, Blue if we are ahead.
          color = driftMs > 0 ? '#ffeb3b' : '#03a9f4'; 
        }
        if (Math.abs(driftMs) > LARGE_DRIFT_THRESHOLD * 1000) {
          color = '#f44336'; // Red for large drift that will cause a hard seek.
        }
        Object.assign(bar.style, {
          width: '2px',
          height: `${height}px`,
          backgroundColor: color
        });
        this.driftGraphElement.appendChild(bar);
      });

      // --- Render Latency Graph ---
      this.latencyGraphElement.innerHTML = ''; // Clear previous bars
      this.latencyHistory.forEach(latencyMs => {
        const bar = document.createElement('div');
        // Scale the height: 1px per 5ms of latency, capped at 50px.
        const height = Math.min(50, latencyMs * 0.2);
        let color = '#4caf50'; // Green for low latency (<100ms)
        if (latencyMs > 100) color = '#ffeb3b'; // Yellow
        if (latencyMs > 200) color = '#ff9800'; // Orange
        if (latencyMs > 300) color = '#f44336'; // Red
        Object.assign(bar.style, {
          width: '2px',
          height: `${height}px`,
          backgroundColor: color
        });
        this.latencyGraphElement.appendChild(bar);
      });
    }

    /**
     * Toggles or updates closed captions based on user preference and player state.
     * @param {boolean} [force=false] - Whether to force reapplication even if video ID hasn't changed.
     */
    applyCaptions(force) {
      const p = this.player;
      if (!p || typeof p.getVideoData !== 'function') return;
      const on = this.core.captions !== false;
      // Twitch, Vimeo, streams and files have their own captions (where they have any).
      if (typeof p.setCaptions === 'function') p.setCaptions(on);
      if (p.isYouTube && !p.isYouTube()) return;
      const key = `${(p.getVideoData() || {}).video_id || ''}:${on}`;
      if (!force && this.captionsApplied === key) return;
      this.captionsApplied = key;
      try {
        clearTimeout(this.captionsTimer);
        if (on) {
          p.loadModule('captions');
          this.pickCaptionTrack(0);
        } else {
          p.setOption('captions', 'track', {});
          p.unloadModule('captions');
        }
      } catch (e) {
        console.warn('[PLAYER] Could not change captions:', e);
      }
    }

    /**
     * Polls the YouTube captions module for a track and shows English: an English track when
     * there is one, else YouTube's English translation of the video's track. Auto-generated
     * captions aren't in the track list, only the current track, so that one counts too.
     * @param {number} tries - Retries counter.
     */
    pickCaptionTrack(tries) {
      clearTimeout(this.captionsTimer);
      const p = this.player;
      if (!p || this.core.captions === false) return;
      const isEnglish = t => /^en/i.test((t && t.languageCode) || '');
      let list = [], current = null, languages = [];
      try { list = p.getOption('captions', 'tracklist') || []; } catch (e) {}
      try { current = p.getOption('captions', 'track'); } catch (e) {}
      const base = list.find(isEnglish) || list[0] || (current && current.languageCode ? current : null);
      if (base) {
        try { languages = p.getOption('captions', 'translationLanguages') || []; } catch (e) {}
        const english = languages.find(isEnglish);
        try {
          if (!isEnglish(base) && english && base.is_translateable !== false) {
            p.setOption('captions', 'track', Object.assign({}, base, { translationLanguage: english }));
          } else if (base !== current) {
            p.setOption('captions', 'track', { languageCode: base.languageCode });
          }
        } catch (e) {}
        return;
      }
      if (tries < 20) this.captionsTimer = setTimeout(() => this.pickCaptionTrack(tries + 1), 500);
    }

    /**
     * Applies an authoritative track change received from the server.
     * @param {Object} data - Track changed message payload.
     * @param {Array<Object>} [data.playlist] - Updated playlist array.
     * @param {number} data.newTrackIndex - Index of newly active track.
     * @param {number} data.newLastStartTime - Timestamp when track started playing on server.
     * @param {boolean} [data.paused] - Whether track is paused.
     * @param {number} [data.newCurrentTime] - Start offset in seconds.
     * @param {Object} [data.track] - Active video descriptor.
     */
    applyTrackChange(data) {
      if (data.playlist) {
        this.playerData.playlist = data.playlist;
      }
      if (!Array.isArray(this.playerData.playlist)) this.playerData.playlist = [];
      this.playerData.currentTrack = data.newTrackIndex;
      this.playerData.lastStartTime = data.newLastStartTime;
      // The new track's own time, so a preview that ends while it's paused starts it there.
      this.playerData.currentTime = Number(data.newCurrentTime) || 0;
      if (typeof data.paused === 'boolean') this.playerData.paused = data.paused;

      const index = data.newTrackIndex;
      // Plays the server's track even if this copy of the playlist has drifted, and refreshes it.
      this.core.fixTrackMismatch(this.playerData, data);
      this.initialSyncComplete = true; // A track change is a definitive sync.
      if (this.previewVideo) return;

      // The server provides the definitive start time. A time below zero is a countdown (karaoke
      // songs): the track loads now and starts when it reaches zero, on every screen together.
      // A countdown is measured from when the server starts the track, not from the time in the
      // message, which is out of date when this runs later (the player wasn't ready, or a preview
      // was playing): what's left is waited, and a track that has started plays where it is.
      let at = Number(data.newCurrentTime) || 0;
      if (at < 0 && Number.isFinite(this.clockSkew) && Number.isFinite(Number(data.newLastStartTime))) {
        at = Math.max(at, (Date.now() / 1000) - this.clockSkew - Number(data.newLastStartTime));
      }
      this.playVidya(index, Math.max(0, at), true, undefined, data.track);
      clearInterval(this.holdTimer);
      this.holdTimer = null;
      this.hideCountdown();
      // Everyone gets the track at the same moment, but each device takes its own time to load
      // it, so without this a slow one stays that far behind for the whole song (heard most in
      // karaoke, where nobody uses Auto Sync).
      if (this.playerData.paused) return;
      if (at < 0) this.holdStart(-at);
      else this.syncAfterLoad();

      // When a track changes, sync fast so the new song starts off in sync.
      if (this.autoSync) {
        this.syncIntervalMs = SYNC_INTERVAL_FAST;
        this.scheduleNextSync();
      }
    }

    /**
     * Holds a track that has just been loaded at its start for `seconds`, then plays it. The
     * time is used to load it, so it starts at once when the wait ends. YouTube plays a track as
     * soon as it has loaded whatever it's told while loading, so it's paused again as often as
     * it starts.
     * @param {number} seconds
     */
    holdStart(seconds) {
      clearTimeout(this.resumeSyncTimer);
      this.holdUntil = Date.now() + seconds * 1000;
      console.log(`[PLAYER] Holding the new track for ${seconds.toFixed(1)}s so everyone starts together.`);
      let shown = 0;
      const video = this.currentVideo || {};
      // Karaoke counts down over the whole screen; a playlist track just waits at its first frame.
      const countdown = this.core.isKaraoke === true;
      if (countdown) this.showCountdown(null, video.user && video.user.name, video.title);
      // Told once, when this screen has loaded the track: the room starts it when every screen has
      // (see App.holdForReady). Karaoke's countdown doesn't wait for it, which does no harm.
      let readySent = false;
      const ready = () => {
        if (readySent || !video.link) return;
        readySent = true;
        this.core.sendMessage({ path: Commands.TRACK_READY, data: { link: video.link } });
      };
      // Held at its start once it plays (see onYouTubeState, and below). A video that hasn't
      // started loading is left to load: paused then, YouTube may never load it at all.
      this.holdLoaded = () => {
        try {
          this.player.pauseVideo();
          if (this.player.getCurrentTime() > 0.2) this.player.seekTo(0);
        } catch (e) {}
        ready();
      };
      try { if (this.player.getPlayerState() === YT.PlayerState.PLAYING) this.holdLoaded(); } catch (e) {}
      clearInterval(this.holdTimer);
      this.holdTimer = setInterval(() => {
        const paused = this.playerData && this.playerData.paused;
        // A live video the server didn't know was live goes to its live point instead (see
        // onYouTubeState), so it isn't held at its start.
        let live = false;
        try { live = this.isLiveTrack(video); } catch (e) {}
        if (Date.now() >= this.holdUntil || this.previewVideo || paused || live) {
          this.endHold();
          if (this.previewVideo || paused) return;
          if (live) { ready(); try { this.player.playVideo(); } catch (e) {} return; }
          let state;
          try { state = this.player.getPlayerState(); } catch (e) {}
          console.log(`[PLAYER] Countdown over, playing (the player's state was ${state}).`);
          try { this.player.playVideo(); } catch (e) {}
          this.syncAfterLoad();
          return;
        }
        // A new number each second, over the whole screen.
        const left = Math.ceil((this.holdUntil - Date.now()) / 1000);
        if (countdown && left !== shown) { shown = left; this.showCountdown(left); }
        try {
          const state = this.player.getPlayerState();
          if (state === YT.PlayerState.PLAYING) {
            // It has loaded enough to play: held here until the start.
            this.holdLoaded();
          } else if (state === YT.PlayerState.PAUSED && this.loadedSome()) {
            ready();
          }
        } catch (e) {}
      }, 150);
    }

    /** Ends a hold (holdStart) without playing. */
    endHold() {
      clearInterval(this.holdTimer);
      this.holdTimer = null;
      this.holdLoaded = null;
      this.hideCountdown();
    }

    /**
     * Whether the paused track has some of itself loaded, so it can start at once. A YouTube
     * video says how much; another source, paused by the hold, has loaded its start.
     * @returns {boolean}
     */
    loadedSome() {
      try {
        if (this.player.isYouTube && !this.player.isYouTube()) return true;
        const yt = this.yt || this.player;
        return typeof yt.getVideoLoadedFraction === 'function' && yt.getVideoLoadedFraction() > 0 && yt.getDuration() > 0;
      } catch (e) {
        return false;
      }
    }

    /**
     * The countdown over the whole screen: who is singing and what, and a number that pops in
     * each second inside a ring that drains. `number` null only builds it (before the first).
     * @param {number|null} number
     * @param {string} [singer]
     * @param {string} [title]
     */
    showCountdown(number, singer, title) {
      let el = this.countdownEl;
      if (!el) {
        if (!document.getElementById('fvp-countdown-style')) {
          const style = document.createElement('style');
          style.id = 'fvp-countdown-style';
          style.textContent = `
            #fvp-countdown { position: fixed; inset: 0; z-index: 99999; display: flex; flex-direction: column;
              align-items: center; justify-content: center; color: #fff; font-family: 'Roboto', sans-serif;
              background: radial-gradient(circle at center, rgba(74,20,140,0.92) 0%, rgba(10,10,25,0.97) 70%);
              opacity: 1; transition: opacity 0.25s ease-out; pointer-events: none; text-align: center; }
            #fvp-countdown.out { opacity: 0; }
            #fvp-countdown .who { font-size: 6vh; font-weight: 700; letter-spacing: 0.04em; color: #ffd54f; text-shadow: 0 0 2vh rgba(255,213,79,0.6); max-width: 90vw; }
            #fvp-countdown .what { font-size: 3.6vh; margin-top: 1vh; opacity: 0.85; max-width: 80vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #fvp-countdown .ring { position: relative; width: 44vh; height: 44vh; margin-top: 4vh; display: flex; align-items: center; justify-content: center; }
            #fvp-countdown svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
            #fvp-countdown circle { fill: none; stroke-width: 6; }
            #fvp-countdown .track { stroke: rgba(255,255,255,0.15); }
            #fvp-countdown .sweep { stroke: #00e5ff; stroke-linecap: round; stroke-dasharray: 283; }
            #fvp-countdown .sweep.run { animation: fvp-sweep 1s linear; }
            #fvp-countdown .num { font-size: 30vh; font-weight: 900; line-height: 1; text-shadow: 0 0 4vh rgba(0,229,255,0.9), 0 0 10vh rgba(213,0,249,0.7); }
            #fvp-countdown .num.pop { animation: fvp-pop 1s cubic-bezier(.2,1.6,.4,1); }
            #fvp-countdown .ready { font-size: 4vh; margin-top: 3vh; letter-spacing: 0.3em; text-transform: uppercase; opacity: 0.8; }
            @keyframes fvp-pop { 0% { transform: scale(2.4); opacity: 0; } 25% { transform: scale(1); opacity: 1; } 80% { transform: scale(1); opacity: 1; } 100% { transform: scale(0.7); opacity: 0.2; } }
            @keyframes fvp-sweep { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 283; } }`;
          document.head.appendChild(style);
        }
        el = this.countdownEl = document.createElement('div');
        el.id = 'fvp-countdown';
        el.innerHTML = '<div class="who"></div><div class="what"></div><div class="ring">'
          + '<svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="45"></circle><circle class="sweep" cx="50" cy="50" r="45"></circle></svg>'
          + '<div class="num"></div></div><div class="ready">Get ready</div>';
        document.body.appendChild(el);
      }
      clearTimeout(this.countdownHideTimer);
      el.classList.remove('out');
      if (singer !== undefined) el.querySelector('.who').textContent = singer ? `Now singing: ${singer}` : '';
      if (title !== undefined) el.querySelector('.what').textContent = title || '';
      if (number == null) return;
      const num = el.querySelector('.num'), sweep = el.querySelector('.sweep');
      num.textContent = String(number);
      // Removing and adding the class again restarts the animations for each number.
      num.classList.remove('pop'); sweep.classList.remove('run');
      void num.offsetWidth;
      num.classList.add('pop'); sweep.classList.add('run');
    }

    /** Fades the countdown out and removes it. */
    hideCountdown() {
      const el = this.countdownEl;
      if (!el) return;
      this.countdownEl = null;
      el.classList.add('out');
      this.countdownHideTimer = setTimeout(() => el.remove(), 300);
    }

    /**
     * Puts a track that has just been loaded where the world is, once it plays: it asks the
     * server for the time and seeks there if this screen is more than START_SYNC_THRESHOLD out
     * (see SYNC_TIME). It waits for the track to play first, as YouTube drops a seek made while
     * it's still loading, which would leave it at 0:00. Works with Auto Sync off.
     * @param {number} [passes] - Checks left, this one included.
     */
    syncAfterLoad(passes = START_SYNC_PASSES) {
      clearTimeout(this.resumeSyncTimer);
      let tries = 0;
      const resync = () => {
        if (this.previewVideo || !this.player || (this.playerData && this.playerData.paused)) return;
        let state;
        try { state = this.player.getPlayerState(); } catch (e) {}
        if (state !== YT.PlayerState.PLAYING && ++tries < 30) {
          this.resumeSyncTimer = setTimeout(resync, 500);
          return;
        }
        this.startSyncPasses = passes;
        this.resumeSyncPending = true; // a skip before the answer cancels it
        this.isResumingFromPassthrough = true;
        this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now() } });
      };
      this.resumeSyncTimer = setTimeout(resync, 500);
    }

    /**
     * Starts or stops a local song preview on this viewer's screen.
     * While previewing, room playback updates are recorded in `this.playerData` without
     * interrupting the preview; stopping restores the room's current track (or silence when idle).
     * @param {Object|null} video - Video object to preview, or null to return to the room's track.
     */
    applyPreview(video) {
      clearTimeout(this.resumeSyncTimer);
      this.resumeSyncPending = false;
      this.isResumingFromPassthrough = false;
      if (video && video.link) {
        this.previewVideo = video;
        // A track change that came before the player was ready only updates playerData now
        // (applyTrackChange stops there while previewing), so stopping goes back to the right track.
        if (this.pendingTrackChange && this.playerData) {
          const pending = this.pendingTrackChange;
          this.pendingTrackChange = null;
          this.applyTrackChange(pending);
        }
        this.readyToPlay = true;
        clearTimeout(this.syncTimeout);
        try { this.player.setPlaybackRate(1.0); } catch (e) {}
        if (this.player.loadMedia) this.player.loadMedia(video.link, 0);
        else this.player.loadVideoById(this.core.getId(video.link), 0);
        this.player.playVideo();
        this.setVolume("spatial");
        this.lastUrl = video.link;
        this.currentVideo = video;
        this.core.showToast("Previewing: " + (video.title || "song"));
        return;
      }
      if (!this.previewVideo) return;
      this.previewVideo = null;
      this.lastUrl = null;
      try { this.player.setPlaybackRate(1.0); } catch (e) {}
      const d = this.playerData;
      if (d && Array.isArray(d.playlist) && d.playlist.length > 0 && d.playlist[d.currentTrack]) {
        // During a karaoke countdown it waits at 0:00 for what's left of it, as when joining.
        const live = (Date.now() / 1000) - (this.clockSkew || 0) - Number(d.lastStartTime);
        const counting = !d.paused && live < 0 && live > -30;
        const start = d.paused ? Math.max(0, Number(d.currentTime) || 0) : counting ? 0 : Math.max(0, this.worldTime());
        this.playVidya(d.currentTrack, start, true);
        this.initialSyncComplete = true;
        if (counting) this.holdStart(-live);
        else if (!d.paused) this.syncAfterLoad();
        if (this.autoSync) {
          this.syncIntervalMs = SYNC_INTERVAL_FAST;
          this.scheduleNextSync();
        }
      } else {
        this.currentVideo = null;
        const silenceUrl = "https://www.youtube.com/watch?v=GiwStUzx8fg";
        if (this.player.loadMedia) this.player.loadMedia(silenceUrl, 0);
        else this.player.loadVideoById(this.core.getId(silenceUrl), 0);
        this.core.showToast("Preview stopped");
      }
    }

    /**
     * Loads and begins playing a video track at a specific time offset.
     * @param {number} currentTrack - Index of track in playlist.
     * @param {number} currentTime - Start time offset in seconds.
     * @param {boolean} [force=false] - Force reload even if URL matches current video.
     * @param {number} [volume] - Optional volume override.
     * @param {Object} [track] - Optional explicit track object if overriding playlist.
     */
    playVidya(currentTrack, currentTime, force, volume, track) {
      if(this.playerData) {
        const video = track || (this.playerData.playlist && this.playerData.playlist[currentTrack]);
        if (!video) {
          console.warn(`[PLAYER] No track at index ${currentTrack}.`);
          return;
        }
        if(this.lastUrl !== video.link || force) {
          const start = this.startAt(video, currentTime);
          this.liveJumped = null; // see onYouTubeState
          if (this.player.loadMedia) this.player.loadMedia(video.link, start);
          else this.player.loadVideoById(this.core.getId(video.link), start);
          if (this.playerData.paused) {
            this.player.pauseVideo();
          } else {
            this.player.playVideo();
          }
          this.core.showToast("Playing: " + video.title);
          this.setVolume("spatial");
        }
        this.lastUrl = video.link;
        this.currentVideo = video;
      }else{
        console.log("No player data!");
      }
    }

    /**
     * Schedules the next sync request via WebSocket based on current `syncIntervalMs`.
     */
    scheduleNextSync() {
      // Clear any pending timeout to avoid duplicates.
      clearTimeout(this.syncTimeout);

      // Only schedule if autoSync is enabled.
      if (!this.autoSync) return;

      this.syncTimeout = setTimeout(() => {
        this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now() } });
      }, this.syncIntervalMs);
    }

    /**
     * Enables automatic time synchronization against the server.
     */
    enableAutoSync() {
      if (!this.autoSync) {
        this.autoSync = true;
        if (this.statusElement) this.statusElement.style.display = 'flex';
        this.core.showToast("AutoSync has been enabled.");
        // Start with a fast interval to get in sync quickly.
        this.syncIntervalMs = SYNC_INTERVAL_FAST;
        this.scheduleNextSync();
      }
    }

    /**
     * Disables automatic time synchronization against the server.
     * @param {boolean} [fromManualSkip=false] - Whether triggered by a manual skip action.
     */
    disableAutoSync(fromManualSkip = false) {
      if (this.autoSync) {
        this.autoSync = false;
        clearTimeout(this.syncTimeout);
        this.syncTimeout = null;
        if (this.statusElement) this.statusElement.style.display = 'none';
        this.core.showToast(fromManualSkip ? "AutoSync disabled by manual skip." : "AutoSync has been disabled.");
        if (fromManualSkip) {
          this.core.sendMessage({ path: Commands.AUTO_SYNC_STATE_CHANGED, data: { enabled: false } });
        }
      }
    }

    /**
     * Updates mute status on the active player based on `core.params`.
     */
    setMute() {
      if(this.core.params.mute === 'true' || this.core.params.volume === 0) {
        this.player.mute();
      }else{
        this.player.unMute();
      }
    }

    /**
     * Sets playback volume on the active player.
     * @param {string} [type] - Volume update origin (e.g. "spatial" for positional falloff).
     */
    setVolume(type) {
      this.core.params.volume = Number(this.core.params.volume);
      if(this.player.getVolume() != this.core.params.volume) {
        this.player.setVolume(this.core.params.volume);
        const isSpatial = type === "spatial";
        const showToast = () => this.core.showToast((isSpatial ? "(spatial) " : "") + "vol: " + (this.core.params.volume) + "%");
        if(isSpatial) {
          clearTimeout(this.spatialUpdateTimeout);
          this.spatialUpdateTimeout = setTimeout(() => showToast(), 600);
        }else{
          showToast();
        }
      }
    }

    /**
     * Loads the YouTube IFrame API script tag dynamically and sets up the global callback.
     * @param {number|string} start - Initial video offset.
     * @returns {Promise<Event>} Resolves when script has loaded.
     */
    setupYoutubeScript(start) {
      // Redefine the global callback to ensure it passes the correct start time.
      // This is necessary because the YouTube API calls a global function, and we need
      // to bridge it to our instance method with the correct context.
      window.onYouTubeIframeAPIReady = () => {
        if (window.playerInstance) {
          window.playerInstance.onYouTubeIframeAPIReady(start);
        }
      };

      return new Promise(resolve => {
        let myScript = document.createElement("script");
        myScript.setAttribute("src", "https://www.youtube.com/iframe_api");
        myScript.addEventListener ("load", resolve, false);
        document.body.appendChild(myScript);  
      });
    }
  }
  window.playerInstance = new Player();
  }, false);

  document.body.appendChild(baseScript);
})();