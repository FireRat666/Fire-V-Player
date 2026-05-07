const SkipJumpTimePlaylist = 5;
const SkipJumpTimeKaraoke = 0.25; // 250ms for karaoke, to allow for more precise timing.

// --- Adaptive Sync Constants ---
const SYNC_INTERVAL_FAST = 800;    // Sync every 0.8s when drift is high or after a change.
const SYNC_INTERVAL_NORMAL = 2000;   // Sync every 2s for moderate drift.
const SYNC_INTERVAL_SLOW = 4000;   // Sync every 4s when well-synced.

const LARGE_DRIFT_THRESHOLD = 0.5; // Above 500ms, do a hard seek. This should be rare.
const SMALL_DRIFT_THRESHOLD = 0.04; // Below 40ms, we are considered perfectly in-sync.
const PROPORTIONAL_GAIN = 0.15;     // How aggressively to correct small drifts.
const MAX_SPEED_ADJUSTMENT = 0.05;  // Max speed change is now 5% (0.95x to 1.05x), making it less noticeable.
// --- End of Sync Constants ---

(() => {
  const playerScript = document.currentScript;

  const baseScript = document.createElement("script");
  const currentScriptUrl = new URL(playerScript.src);
  baseScript.setAttribute("src", `${currentScriptUrl.origin}/base-player.js`);

  baseScript.addEventListener("load", () => {
  var Player = class extends BasePlayer {
    constructor(){
      super(playerScript);
      this.pendingTrackChange = null;
      this.init();
    }
    async init() {
      await super.init(); // Run common setup from BasePlayer

      // Now run the player-specific setup
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
  setupBrowserMessaging() {
     window.addEventListener("bantermessage", (e) => this.parseMessage(e.detail.message));
  }
  sendBrowserMessage(msg) {
    if (!window.bantermessage) {
      console.log("No banter message, is this banter?");
    } else {
      window.bantermessage(JSON.stringify(msg));
    }
  }  
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
  waitFor(seconds) {
    return new Promise(resolve => {
      setTimeout(() => resolve(), seconds * 1000);
    })
  }
  playPlaylist(shouldClear) {
    this.core.sendMessage({path: Commands.FROM_PLAYLIST, data: {id: this.core.params.playlist, shouldClear, fromPlayer: true}});
  }
  onYouTubeIframeAPIReady(start) {
    this.player = new YT.Player('player', {
      height: window.innerHeight,
      width: window.innerWidth,
      videoId: this.core.getId(decodeURIComponent(this.core.params.youtube)),
      playerVars: {
        'playsinline': 1,
        'autoplay': 1,
        'disablekb': 1,
        'controls': 0,
        'modestbranding': true,
        'cc_load_policy': 1,
        'cc_lang_pref': 'en',
        'iv_load_policy': 3,
        'origin': window.location.origin,
        'start': Number(start),
         'vq': 'hd1080'
      },
      events: {
        onStateChange: event => {
          if (event.data === YT.PlayerState.PLAYING) {
            if (!this.readyToPlay) {
              this.readyToPlay = true;
              // First time player is playing. Check for pending changes or initial sync.
              if (this.pendingTrackChange) {
                // A track change was received before we were ready. Apply it now.
                const data = this.pendingTrackChange;
                if (data.playlist) {
                  this.playerData.playlist = data.playlist;
                }
                this.playerData.currentTrack = data.newTrackIndex;
                this.playerData.lastStartTime = data.newLastStartTime;
                const startTime = data.newCurrentTime || 0;
                this.playVidya(this.playerData.currentTrack, startTime, true);
                this.initialSyncComplete = true;
                this.pendingTrackChange = null; // Clear the cached message
                // A track change occurred, so we should start with a fast sync.
                if (this.autoSync) {
                  this.syncIntervalMs = SYNC_INTERVAL_FAST;
                  this.scheduleNextSync();
                }
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
          if (event.data === 150 || event.data === 101) {
            const currentVideo = this.playerData.playlist[this.playerData.currentTrack];
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
  }
  startPlayerOrNot() {
    if(this.player && !this.isPlayerStarted && this.core.connected() && !this.readyToPlay) {
      this.core.sendMessage({path: Commands.CLICK_BROWSER, data: {x: window.innerHeight / 2, y: window.innerWidth / 2}});
      this.isPlayerStarted = true;
    }
  }
  seek(time) {
    if(this.player) {
      const timeForward = this.player.getCurrentTime() + time;
      this.player.seekTo(timeForward);
      return "Seeking to: " + timeForward;
    }
  }
  parseMessage(msg) {
    const json = JSON.parse(msg);
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
          // If the message includes a new playlist (e.g., from add-and-play), update it.
          if (json.data.playlist) {
            this.playerData.playlist = json.data.playlist;
          }
          this.playerData.currentTrack = json.data.newTrackIndex;
          this.playerData.lastStartTime = json.data.newLastStartTime;
          // The server now provides the definitive start time.
          const startTime = json.data.newCurrentTime || 0;
          this.playVidya(this.playerData.currentTrack, startTime, true);

          // When a track changes, reset the sync interval to be fast to ensure
          // the new song starts off perfectly in sync.
          if (this.autoSync) {
            this.syncIntervalMs = SYNC_INTERVAL_FAST;
            this.scheduleNextSync();
          }
          this.initialSyncComplete = true; // A track change is a definitive sync.
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
            this.disableAutoSync(); // Disable auto-sync while paused
          } else {
            console.log("[PLAYER] Resuming YouTube at", currentTime);
            // Seek to the exact time the host resumed at.
            this.player.seekTo(currentTime);
            this.player.playVideo();
            this.core.showToast("Host resumed playback.");
            this.enableAutoSync(); // Re-enable auto-sync
          }
        } else {
          console.log("[PLAYER] Player not ready or missing", { player: !!this.player, ready: this.readyToPlay });
        }
        break;
      case Commands.MUTE:
        this.core.params.mute = json.data;
        this.core.showToast(this.core.params.mute === true || this.core.params.mute === 'true' ? "mute" : "unmute");
        this.setMute();
        break;
      case Commands.SYNC_TIME:
        this.currentTime = json.data.currentTime;
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
  playVidya(currentTrack, currentTime, force, volume) {
    if(this.playerData) {
      if(this.lastUrl !== this.playerData.playlist[currentTrack].link || force) {
        const url = this.playerData.playlist[currentTrack].link;
        this.player.loadVideoById(this.core.getId(url), currentTime);
        if (this.playerData.paused) {
          this.player.pauseVideo();
        } else {
          this.player.playVideo();
        }
        this.core.showToast("Playing: " + this.playerData.playlist[currentTrack].title);
        this.setVolume("spatial");
      }
      this.lastUrl = this.playerData.playlist[currentTrack].link;
    }else{
      console.log("No player data!");
    }
  }
  scheduleNextSync() {
    // Clear any pending timeout to avoid duplicates.
    clearTimeout(this.syncTimeout);

    // Only schedule if autoSync is enabled.
    if (!this.autoSync) return;

    this.syncTimeout = setTimeout(() => {
      this.core.sendMessage({ path: Commands.REQUEST_SYNC, data: { clientTimestamp: Date.now() } });
    }, this.syncIntervalMs);
  }
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
  setMute() {
    if(this.core.params.mute === 'true' || this.core.params.volume === 0) {
      this.player.mute();
    }else{
      this.player.unMute();
    }
  }
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