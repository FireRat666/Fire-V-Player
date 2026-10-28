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
/** @constant {number} Normal sync interval in ms for moderate drift */
const SYNC_INTERVAL_NORMAL = 2000;   // Sync every 2s for moderate drift.
/** @constant {number} Slow sync interval in ms when player is well-synchronized */
const SYNC_INTERVAL_SLOW = 4000;   // Sync every 4s when well-synced.

/** @constant {number} Drift threshold in seconds above which a hard seek is executed */
const LARGE_DRIFT_THRESHOLD = 0.5; // Above 500ms, do a hard seek. This should be rare.
/** @constant {number} Drift threshold in seconds below which playback is considered in sync */
const SMALL_DRIFT_THRESHOLD = 0.04; // Below 40ms, we are considered perfectly in-sync.
/** @constant {number} Proportional gain multiplier for subtle playback rate adjustments */
const PROPORTIONAL_GAIN = 0.15;     // How aggressively to correct small drifts.
/** @constant {number} Maximum allowed playback rate deviation (+/- 5%) */
const MAX_SPEED_ADJUSTMENT = 0.05;  // Max speed change is now 5% (0.95x to 1.05x), making it less noticeable.
// --- End of Sync Constants ---

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
        this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user});
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
          if (this.player && this.readyToPlay) {
            // The visibility change triggers a one-time, authoritative resync.
            // We set a flag to tell the
            // SYNC_TIME handler to perform a hard seek, bypassing the normal auto-sync logic.
            this.isResumingFromPassthrough = true;
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
        playerVars: {
          'playsinline': 1,
          'autoplay': 1,
          'disablekb': 1,
          'controls': 0,
          'modestbranding': true,
          'cc_load_policy': this.core.captions === false ? 0 : 1,
          'cc_lang_pref': 'en',
          'iv_load_policy': 3,
          'origin': window.location.origin,
          'start': Number(start),
           'vq': 'hd1080'
        },
        events: {
          onStateChange: event => {
            if (event.data === YT.PlayerState.PLAYING) {
              this.applyCaptions(); // each new video loads with the player's caption default
              if (!this.readyToPlay) {
                this.readyToPlay = true;
                // First time player is playing. Check for pending changes or initial sync.
                if (this.pendingTrackChange && this.playerData) {
                  // A track change was received before we were ready. Apply it now.
                  const data = this.pendingTrackChange;
                  this.pendingTrackChange = null; // Clear the cached message
                  this.applyTrackChange(data);
                } else if (this.playerData && this.playerData.playlist && this.playerData.playlist.length > 0 && !this.initialSyncComplete) {
                  // This handles rejoining an instance that already has a playlist.
                  this.playVidya(this.playerData.currentTrack, this.playerData.currentTime, true);
                  this.initialSyncComplete = true;
                  // This is the first sync, so we should start with a fast interval.
                  if (this.autoSync) {
                    this.syncIntervalMs = SYNC_INTERVAL_FAST;
                    this.scheduleNextSync();
                  }
                }
              }
            } // The aggressive `playVideo()` call on non-playing states has been removed.
              // The auto-sync logic is the robust way to handle unexpected pauses or buffering
              // by correcting the resulting time drift.
          },
          onError: event => {
            // Error 150: The video owner has not made this video available in your country.
            // Error 101 is a variation of this.
            if ((event.data === 150 || event.data === 101) && (!this.player.isYouTube || this.player.isYouTube())) {
              const currentVideo = this.currentVideo || (this.playerData && this.playerData.playlist && this.playerData.playlist[this.playerData.currentTrack]);
              if (currentVideo) {
                this.core.showToast(`Video unavailable in your region: ${currentVideo.title}`);
                this.core.sendMessage({ path: Commands.VIDEO_UNAVAILABLE, data: { link: currentVideo.link } });
              }
            }
            console.log("YT Player Error:", event.data);
          },
          onApiChange: async event => {
          },
          onReady: event => {
            this.setVolume();
            this.setMute();
            this.player.playVideo(); // Explicitly start playback.
            // setTimeout(() => this.startPlayerOrNot(), 500);
          }
        }
      });
      // this.player takes the same calls as the YouTube player, and plays non-YouTube links itself.
      this.player = window.MediaSwitch ? new MediaSwitch(this.yt, {
        getId: link => this.core.getId(link),
        onDuration: (link, seconds) => this.reportMediaDuration(link, seconds),
        onError: message => this.core.showToast(message, 6000),
        // Untrusted links only play if this viewer's own world allows them.
        allowUntrusted: () => this.core.allowUntrusted === true,
        // Asks this viewer's world to click the middle of their screen, for players (Twitch) that
        // won't start on their own until someone does.
        requestClick: () => this.clickMiddle()
      }) : this.yt;
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
      case Commands.SKIP_BACK:
        this.disableAutoSync(true); // Disable auto-sync on manual skip
        const skipAmountBack = this.core.isKaraoke ? SkipJumpTimeKaraoke : SkipJumpTimePlaylist;
        const time = this.player.getCurrentTime() - skipAmountBack;
        this.player.seekTo(time);
        this.player.playVideo(); // Ensure playback continues after skip
        this.core.showToast(`-${skipAmountBack}s`);
        break;
      case Commands.SKIP_FORWARD:
        this.disableAutoSync(true); // Disable auto-sync on manual skip
        const skipAmountForward = this.core.isKaraoke ? SkipJumpTimeKaraoke : SkipJumpTimePlaylist;
        const timeForward = this.player.getCurrentTime() + skipAmountForward;
        this.player.seekTo(timeForward);
        this.player.playVideo(); // Ensure playback continues after skip
        this.core.showToast(`+${skipAmountForward}s`);
        break;
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

        // The specific 'set-track' logic is now handled by the TRACK_CHANGED command.
        if (json.data.type === "stop" && this.readyToPlay) {
          this.player.loadVideoById(this.core.getId("https://www.youtube.com/watch?v=GiwStUzx8fg"), 0);
        }
        // The initial sync is now handled by the onStateChange event when the player is ready.
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
        if (this.playerData && this.readyToPlay) { // Player is ready, apply immediately.
          this.applyTrackChange(json.data);
        } else {
          // Player isn't ready. Cache the track change data to be applied when it is.
          this.pendingTrackChange = json.data;
        }
        break;
      case Commands.HOST_SEEK:
        if (this.player && this.readyToPlay && this.playerData) {
          const oldTime = this.player.getCurrentTime();
          const newTime = json.data.newCurrentTime;
          const diff = newTime - oldTime;

          this.player.seekTo(newTime);
          this.player.playVideo(); // Ensure playback continues after host seek
          this.playerData.lastStartTime = json.data.newLastStartTime;

          // Show a toast indicating the skip direction and amount.
          const skipAmount = this.core.isKaraoke ? SkipJumpTimeKaraoke : SkipJumpTimePlaylist;
          const direction = diff > 0 ? 'FORWARDS +' : 'BACKWARDS -';
          this.core.showToast(`Host skip: ${direction}${skipAmount}s`);
          this.disableAutoSync(true);
        }
        break;
      case 'pause-state-changed':
        console.log("[PLAYER] PAUSE_STATE_CHANGED received from world", json.data);
        if (this.player && this.readyToPlay) {
          const { paused, currentTime, lastStartTime } = json.data;
          if (this.playerData) {
            this.playerData.paused = paused;
            this.playerData.currentTime = currentTime;
            this.playerData.lastStartTime = lastStartTime;
          }
          if (paused) {
            console.log("[PLAYER] Pausing YouTube");
            this.player.pauseVideo();
            this.core.showToast("Host paused playback.");
            // We no longer call this.disableAutoSync() here to preserve the user's manual toggle state
            // and UI visibility. The SYNC_TIME handler already ignores syncs while paused.
          } else {
            console.log("[PLAYER] Resuming YouTube at", currentTime);
            // Seek to the exact time the host resumed at.
            this.player.seekTo(currentTime);
            this.player.playVideo();
            this.core.showToast("Host resumed playback.");
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
        // A live stream (Twitch channel, live .m3u8) has no shared position to keep in sync.
        if (this.player && this.player.isLive && this.player.isLive()) break;
        if(this.player && this.readyToPlay) {
          // Calculate latency on-the-fly from the echoed timestamp
          const roundTripTime = Date.now() - json.data.clientTimestamp;
          const latency = roundTripTime / 2 / 1000; // latency in seconds

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
            this.core.showToast(`Resyncing after pause...`);
            this.player.seekTo(serverTime);
            this.player.setPlaybackRate(1.0); // Ensure rate is normal
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

            if (Math.abs(timediff) > LARGE_DRIFT_THRESHOLD) {
              // Large drift, a hard seek is necessary for a quick correction.
              const direction = timediff > 0 ? 'FORWARDS +' : 'BACKWARDS -';
              const amount = Math.abs(Math.round(timediff * 100) / 100);
              this.core.showToast(`Resyncing: ${direction}${amount}s`);
              this.player.seekTo(serverTime);
              this.player.setPlaybackRate(1.0); // Ensure rate is normal after a seek.
              // High drift, so we should check again very soon.
              this.syncIntervalMs = SYNC_INTERVAL_FAST;
            } else if (Math.abs(timediff) > SMALL_DRIFT_THRESHOLD) {
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
              if (this.player.getPlaybackRate() !== 1.0) {
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
     * Polls the YouTube captions module for available tracks and selects English
     * or the first available caption track.
     * @param {number} tries - Retries counter.
     */
    pickCaptionTrack(tries) {
      clearTimeout(this.captionsTimer);
      const p = this.player;
      if (!p || this.core.captions === false) return;
      let list = [];
      try { list = p.getOption('captions', 'tracklist') || []; } catch (e) {}
      if (list.length) {
        const track = list.find(t => /^en/i.test(t.languageCode || '')) || list[0];
        try { p.setOption('captions', 'track', { languageCode: track.languageCode }); } catch (e) {}
        return;
      }
      if (tries < 10) this.captionsTimer = setTimeout(() => this.pickCaptionTrack(tries + 1), 500);
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
      if (typeof data.paused === 'boolean') this.playerData.paused = data.paused;

      const index = data.newTrackIndex;
      // Plays the server's track even if this copy of the playlist has drifted, and refreshes it.
      this.core.fixTrackMismatch(this.playerData, data);

      // The server provides the definitive start time.
      this.playVidya(index, data.newCurrentTime || 0, true, undefined, data.track);

      // When a track changes, sync fast so the new song starts off in sync.
      if (this.autoSync) {
        this.syncIntervalMs = SYNC_INTERVAL_FAST;
        this.scheduleNextSync();
      }
      this.initialSyncComplete = true; // A track change is a definitive sync.
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
          if (this.player.loadMedia) this.player.loadMedia(video.link, currentTime);
          else this.player.loadVideoById(this.core.getId(video.link), currentTime);
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