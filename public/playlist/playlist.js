var Playlist = class {
  constructor() {
    this.currentScript = document.currentScript;
    this.uiUpdateInterval = null;
    this.pendingReplacement = null;
    this.clockSkew = 0; // The estimated difference between client and server clocks.
    this.init();
  }

  getHostUrl() {
    let host = window.APP_CONFIG ? window.APP_CONFIG.HOST_URL : '';
    if (window.APP_CONFIG && typeof window.APP_CONFIG.resolveHostUrl === 'function') {
      host = window.APP_CONFIG.resolveHostUrl(host);
    } else if (Array.isArray(host)) {
      let currentScriptHost = '';
      if (this.currentScript && this.currentScript.src) {
        try {
          currentScriptHost = new URL(this.currentScript.src).host;
        } catch (_) {}
      }
      const clean = h => String(h).replace(/^[a-zA-Z]+:\/\//, '').replace(/\/+$/, '').trim();
      host = host.find(h => clean(h) === currentScriptHost) || host[0];
    }
    if (typeof host === 'string') {
      host = host.replace(/^[a-zA-Z]+:\/\//, '').replace(/\/+$/, '').trim();
    }
    return host;
  }

  getProtocol(host) {
    const targetHost = host || this.getHostUrl();
    if (this.currentScript && this.currentScript.src) {
      try {
        const scriptProto = new URL(this.currentScript.src).protocol;
        if (scriptProto === 'http:' || scriptProto === 'https:') {
          return scriptProto.replace(':', '');
        }
      } catch (_) {}
    }
    if (targetHost && (targetHost.startsWith('localhost') || targetHost.startsWith('127.0.0.1'))) {
      return 'http';
    }
    if (typeof location !== 'undefined' && location.protocol === 'http:') {
      return 'http';
    }
    return 'https';
  }

  async init() {
    await this.setupConfigScript();
    const hostUrl = this.getHostUrl();
    if (window.APP_CONFIG) {
      window.APP_CONFIG.HOST_URL = hostUrl;
    }
    await this.setupCoreScript();
    this.core = window.videoPlayerCore;
    this.core.hostUrl = hostUrl;
    this.core.hostProtocol = this.getProtocol(hostUrl);
    this.core.parseParams(this.currentScript);
    await this.core.setupCommandsScript(); // Load Commands before UI setup and core.init
    this.setupPlaylistUI();
    this.setupSearchOverlay();
    await this.core.init();
    await this.core.setupWebsocket("playlist", d => this.parseMessage(d), () => {
      // The in-world player sets the room's mode (it can change in world), so this page doesn't.
      // The room's old code as well, as the player page sends: this page can join first.
      this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user,
        legacy: this.core.params['legacy-instance'] || undefined});
    }, ()=>{
        this.core.showToast("Reconnecting...");
    });
  }
  refresh(showToast) {
    if (this.core.requestState()) {
      this.refreshToast = showToast;
      if (showToast) this.core.showToast("Refreshing playlist...", 2000);
    } else if (showToast) {
      this.core.showToast("Not connected. Reconnecting...", 3000);
    }
  }
  playPlaylist(shouldClear) {
    this.core.sendMessage({path: Commands.FROM_PLAYLIST, data: {id: this.playlistId || this.core.params.playlist, shouldClear, fromPlaylist: true}});
    this.playlistId = null;
  }
  clearPlaylist() {
    this.core.sendMessage({path: Commands.CLEAR_PLAYLIST});
  }
  parseMessage(msg) {
    const json = JSON.parse(msg);
    switch(json.path) {
      case Commands.PLAYBACK_UPDATE:
        // Merge new data into the existing player state.
        // This prevents the playlist from being wiped out on updates that don't include it.
        this.core.player = Object.assign(this.core.player || {}, json.data.video);
        // Estimate the clock skew whenever we get a full update with a playing track.
        // This ensures the UI's timer is aligned with the server's time.
        // Not while paused: the time is held then, so this would count the pause as clock difference.
        if (this.core.player.lastStartTime && Number.isFinite(Number(this.core.player.currentTime)) && !this.core.player.paused) {
            const serverNow = this.core.player.lastStartTime + this.core.player.currentTime;
            const clientNow = Date.now() / 1000;
            this.clockSkew = clientNow - serverNow;
        }
        this.updatePlaylist(this.core.player);
        this.startUiUpdater();
        // Sent on every (re)connection: list requests that were waiting can go now.
        if (json.data.type === 'initial-sync' && this.listQueue) this.pumpLists();
        if (json.data.type === 'initial-sync' && this.refreshToast) {
          this.refreshToast = false;
          this.core.showToast("Playlist is up to date.", 2000);
        }
        break;
      case Commands.SEARCH_RESULTS:
        // Only the latest search's reply is shown; an earlier one answered late is dropped.
        if (json.searchId !== undefined && json.searchId !== this.searchId) break;
        this.loadVideos(json.data);
        break;
      case Commands.ERROR:
        if (json.searchId !== undefined && json.searchId !== this.searchId) break; // an earlier search's
        const errorMessage = json.data && json.data.message ? json.data.message : "I can't let you do that...";
        this.core.showToast(errorMessage, 4000);
        break;
      case Commands.LOCK_STATE_CHANGED:
        if (this.core.player) {
          this.core.player.locked = json.data.locked;
          // Re-render the UI with the new lock state
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.CAN_TAKE_OVER_STATE_CHANGED:
        if (this.core.player) {
          this.core.player.canTakeOver = json.data.canTakeOver;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.HOST_CHANGED:
        if (this.core.player) {
          this.core.player.host = json.data.host;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.VOTING_STATE_CHANGED:
        if (this.core.player) {
          this.core.player.canVote = json.data.canVote;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.AUTO_SYNC_STATE_CHANGED:
        this.autoSyncEnabled = json.data.enabled;
        this.autoSync.innerText = this.autoSyncEnabled ? "Auto Sync: On" : "Auto Sync: Off";
        break;
      case Commands.LIST_PREVIEW_RESULT:
        this.onListPreview(json.data);
        break;
      case Commands.LISTS_UPDATED:
        if (this.core.player && json.data && Array.isArray(json.data.lists)) this.core.player.lists = json.data.lists;
        this.savedListsButton.style.display = this.getLists().length ? 'block' : 'none';
        if (this.listsOverlay.style.display !== 'none') this.showLists();
        break;
      // Playlist mode: videos added while the player is locked, waiting for the host.
      case Commands.WAITING_VIDEOS:
        if (this.core.player && json.data && Array.isArray(json.data.waiting)) {
          this.core.player.waiting = json.data.waiting;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.PLAYLIST_UPDATED:
        if (this.core.player) {
          this.core.player.playlist = json.data.playlist;
          this.core.player.currentTrack = json.data.currentTrack;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.ITEM_REMOVED:
        if (this.core.player && this.core.player.playlist) {
          // Update local state based on the granular message
          this.core.player.playlist.splice(json.data.index, 1);
          this.core.player.currentTrack = json.data.newCurrentTrack;
          // Re-render the UI with the new state
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.ITEM_APPENDED:
        if (this.core.player && this.core.player.playlist) {
          this.core.player.playlist.push(json.data.video);
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.ITEM_INSERTED:
        if (this.core.player && this.core.player.playlist) {
          // Insert the new video at the specified index.
          this.core.player.playlist.splice(json.data.index, 0, json.data.video);
          // The currentTrack index does not change when inserting an item after it.
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.ITEM_MOVED:
        if (this.core.player && this.core.player.playlist) {
          const { oldIndex, newIndex, newCurrentTrack } = json.data;
          // Move the item in the local array to match the server
          const [itemToMove] = this.core.player.playlist.splice(oldIndex, 1);
          this.core.player.playlist.splice(newIndex, 0, itemToMove);
          this.core.player.currentTrack = newCurrentTrack;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.ITEM_REPLACED:
        if (this.core.player && this.core.player.playlist) {
          const { index, newVideo } = json.data;
          if (this.core.player.playlist[index]) {
            this.core.player.playlist[index] = newVideo;
            this.updatePlaylist(this.core.player);
          }
        }
        break;
      case Commands.TRACK_CHANGED:
        if (this.core.player) {
          // If the message includes a new playlist (e.g., from add-and-play), update it.
          if (json.data.playlist) {
            this.core.player.playlist = json.data.playlist;
          }
          this.core.player.currentTrack = json.data.newTrackIndex;
          this.core.player.lastStartTime = json.data.newLastStartTime;
          if (typeof json.data.paused === 'boolean') this.core.player.paused = json.data.paused;
          this.core.fixTrackMismatch(this.core.player, json.data);
          // The UI also needs the duration and current time of the new track.
          this.core.player.currentTime = json.data.newCurrentTime || 0;
          if (this.core.player.playlist[this.core.player.currentTrack]) {
              this.core.player.duration = this.core.player.playlist[this.core.player.currentTrack].duration / 1000;
          }
          this.updatePlaylist(this.core.player);
          this.startUiUpdater(); // Restart the progress bar timer
        }
        break;
      case Commands.HOST_SEEK:
        if (this.core.player) {
          this.core.player.lastStartTime = json.data.newLastStartTime;
          this.core.player.currentTime = json.data.newCurrentTime;
          if (typeof json.data.paused === 'boolean') this.core.player.paused = json.data.paused;
          this.togglePause.innerText = this.core.player.paused ? 'Play' : 'Pause';
          this.togglePause.className = this.core.player.paused ? 'button green' : 'button red';
          // The UI updater will pick up the new lastStartTime on its next interval.
          // To make the change immediate, we can manually update the relevant elements.
          this.renderTime();
        }
        break;
      case Commands.READY_START:
        // Every screen has loaded the new track, so it starts sooner than its wait said.
        if (this.core.player && json.data && !this.core.player.paused) {
          const track = this.core.player.playlist && this.core.player.playlist[this.core.player.currentTrack];
          if (track && track.link === json.data.link) {
            this.core.player.lastStartTime = json.data.newLastStartTime;
            this.core.player.currentTime = json.data.newCurrentTime;
          }
        }
        break;
      case Commands.LIVE_POSITION:
        // A live video's live point is known: the room's time is now the stream's own (see core.liveEnd).
        if (this.core.player && json.data) {
          this.core.player.lastStartTime = json.data.newLastStartTime;
          this.core.player.currentTime = json.data.newCurrentTime;
          (this.core.player.playlist || []).forEach(v => {
            if (v.link === json.data.link) { v.live = true; v.liveStart = json.data.liveStart; }
          });
          this.startUiUpdater();
        }
        break;
      case Commands.SHOW_REPLACE_PROMPT:
        // By cloning the alternative video object, we prevent it from being accidentally
        // mutated if the same video appears in a later search result. This is a defensive
        // measure to ensure the object we send back to the server is pristine.
        this.pendingReplacement = {
          original: json.data.original,
          alternative: JSON.parse(JSON.stringify(json.data.alternative))
        };
        const { original, alternative } = this.pendingReplacement;

        this.notificationArea.textContent = `A user can't watch: "${original.title}". Suggested replacement: "${alternative.title}".`;
        this.notificationArea.style.display = 'block';

        this.replaceConfirmButton.style.display = 'inline-block';
        this.replaceDismissButton.style.display = 'inline-block';

        this.replaceConfirmButton.onclick = () => {
          this.core.sendMessage({
            path: Commands.REPLACE_VIDEO,
            data: { originalLink: this.pendingReplacement.original.link, alternativeVideo: this.pendingReplacement.alternative }
          });
          this.hideReplacePrompt();
        };
        break;
      case Commands.ERROR:
        this.core.showToast(json.data || "Error performing action", 4000);
        break;
      case 'pause-state-changed':
        if (this.core.player) {
          this.core.player.paused = json.data.paused;
          this.core.player.currentTime = json.data.currentTime;
          this.core.player.lastStartTime = json.data.lastStartTime;
          this.updatePlaylist(this.core.player);
          this.core.showToast(`Playback ${json.data.paused ? 'Paused' : 'Resumed'}`, 3000);
          // A paused live video's live point still moves on, so its display keeps updating.
          if (this.core.player.paused && !(this.core.liveEnd((Date.now() / 1000) - this.clockSkew) > 0)) {
            if (this.uiUpdateInterval) {
              clearInterval(this.uiUpdateInterval);
              this.uiUpdateInterval = null;
            }
          } else {
            this.startUiUpdater();
          }
        }
        break;
    }
  }
  startUiUpdater() {
    // Clear any existing interval to prevent multiple loops running
    if (this.uiUpdateInterval) {
      clearInterval(this.uiUpdateInterval);
    }

    // Only start a new interval if we have a valid player state with a playlist
    if (!this.core.player || !this.core.player.playlist || this.core.player.playlist.length === 0 || !this.core.player.lastStartTime) {
      return;
    }

    this.uiUpdateInterval = setInterval(() => this.renderTime(), 1000); // Update every second
  }

  // The playing video's time and progress bar. A live video's bar is the part a seek can reach
  // (its last 12 hours, see core.liveRange), up to its live point, and its time is how far behind that.
  renderTime() {
    if (!this.core.player) return;
    {
      const { lastStartTime } = this.core.player;
      const duration = this.trackLength();
      const range = this.liveRange();
      if (this.goLiveBtn) {
        this.goLiveBtn.style.display = range && this.isHostHere ? 'inline-block' : 'none';
      }
      if (!(duration > 0)) {
        // No known length (some files): just how far in it is.
        const t = this.core.player.paused ? (this.core.player.currentTime || 0) : ((Date.now() / 1000) - this.clockSkew) - lastStartTime;
        const text = document.querySelector('.currentTimeText');
        if (text) text.innerText = `${this.timeCode(Math.max(0, t))} / ${this.durationCode(0)}`;
        const bar = document.querySelector('.currentTime');
        if (bar) bar.style.width = '0%';
        return;
      }

      // By subtracting the estimated clock skew, we align the client's 'now' with the server's 'now'.
      // Paused, the time is held in currentTime (a live video's live point still moves on).
      let calculatedTime = this.core.player.paused ? (Number(this.core.player.currentTime) || 0)
        : ((Date.now() / 1000) - this.clockSkew) - lastStartTime;

      // Clamp the calculated time to ensure it's within the valid range.
      calculatedTime = Math.max(range ? range.start : 0, Math.min(calculatedTime, duration));

      // Update the progress bar width.
      const currentTimeBar = document.querySelector('.currentTime');
      if (currentTimeBar) {
        currentTimeBar.style.width = `${this.barPercent(calculatedTime, range, duration)}%`;
      }
      if (this.goLiveBtn && range) {
        const live = this.core.atLivePoint(calculatedTime, range);
        this.goLiveBtn.innerText = live ? 'LIVE' : 'Go Live';
        this.goLiveBtn.className = live ? 'button grey' : 'button red';
      }
      const currentTimeText = document.querySelector('.currentTimeText');
      if (currentTimeText) {
        currentTimeText.innerText = range ? this.core.liveTimeText(calculatedTime, range, t => this.timeCode(t))
          : `${this.timeCode(calculatedTime)} / ${this.timeCode(duration)}`;
      }
    }
  }
  // The current live video's seekable part (see core.liveRange), or null.
  liveRange() { return this.core.liveRange((Date.now() / 1000) - this.clockSkew); }
  // How far along the bar a time is: a live video's from its range's start (see liveRange).
  barPercent(t, range, duration) {
    if (range) {
      const span = range.end - range.start;
      return span > 0 ? ((Math.min(range.end, Math.max(range.start, t)) - range.start) / span) * 100 : 100;
    }
    return duration > 0 ? (t / duration) * 100 : 0;
  }

  // How long the current track is, or for a live video how far its live point is (see core.liveEnd).
  trackLength() {
    const p = this.core.player;
    return this.core.liveEnd((Date.now() / 1000) - this.clockSkew) || (p && p.duration) || 0;
  }

  setupCoreScript() {
    const host = this.getHostUrl();
    const proto = this.getProtocol(host);
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", `${proto}://${host}/core.js`);
      myScript.addEventListener ("load", resolve, false);
      document.body.appendChild(myScript);
    });
  }
  setupConfigScript() {
    // Use the script's own src attribute to reliably find the config file.
    const currentScriptUrl = new URL(this.currentScript.src);
    const configUrl = `${currentScriptUrl.origin}/config.js`;
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", configUrl);
      myScript.addEventListener ("load", resolve, false);
      document.body.appendChild(myScript);
    });
  }
  search(term) {
    // Internet Archive movies and TV say which source. The ID comes back on the reply.
    const source = document.querySelector('#search-source');
    this.searchId = (this.searchId || 0) + 1;
    const data = { term, searchId: this.searchId };
    if (source && ['archive', 'tubi', 'nasa', 'eso', 'esodome'].includes(source.value)) data.source = source.value;
    this.core.sendMessage({path: Commands.SEARCH, data });
  }
  updatePlaylist(player) {
    const isMe = player.host.id === window.user.id;
    this.lockPlayer.innerText = player.locked ? 'Unlock' : 'Lock';
    this.lockPlayer.className = player.locked ? 'button teal' : 'button red';
    this.lockPlayer.style.display = !isMe ? 'none' : 'inline-block';
    this.clearPlaylistButton.style.display = !isMe ? 'none' :  'inline-block';
    this.loadDefaultPlaylistButton.style.display = (isMe && player.playlist.length === 0 && this.core.params.playlist) ? 'inline-block' : 'none';
    this.addPlaylist.style.display = !isMe ? 'none' :  'inline-block';
    this.addVideo.style.display = !isMe ? 'none' : 'inline-block';
    this.savedListsButton.style.display = this.getLists().length ? 'block' : 'none';
    if (this.listsOverlay.style.display !== 'none') this.renderLists(); // permissions, "in the playlist"
    this.takeOver.style.display = (player.canTakeOver || isMe) ? 'inline-block' : 'none';
    this.skipBackwards.style.display = isMe ? 'inline-block' : 'none';
    this.skipForward.style.display = isMe ? 'inline-block' : 'none';
    this.takeOver.innerText = player.canTakeOver ? (isMe ? 'Take Over: On' : 'Take Over') : 'Take Over: Off';
    this.seekVideoBtn.style.display = (isMe && player.playlist.length > 0) ? 'block' : 'none';
    this.isHostHere = !!isMe; // for Go Live (see renderTime)
    this.renderTime();
    this.takeOver.className = player.canTakeOver ? (isMe ? 'button red' : 'button teal') : 'button teal';
    this.voting.style.display = !isMe ? 'none' : 'inline-block';
    this.voting.innerText = player.canVote ? 'Voting: On' : 'Voting: Off';
    this.autoSync.style.display = 'inline-block';
    if (!this.pendingReplacement) {
      this.replaceDismissButton.style.display = 'none';
    }
    this.togglePause.style.display = isMe ? 'inline-block' : 'none';
    this.togglePause.innerText = player.paused ? 'Play' : 'Pause';
    this.togglePause.className = player.paused ? 'button green' : 'button red';

    // --- Securely build the host title ---
    this.hostTitle.innerHTML = ''; // Clear previous content

    const welcomeSpan = document.createElement('span');
    welcomeSpan.textContent = `Welcome ${window.user.name}. ${isMe ? 'You are' : `${player.host.name} is`} the host`;
    this.hostTitle.appendChild(welcomeSpan);

    // Programmatically create elements instead of using innerHTML for better security.
    if (player.canTakeOver) {
      const takeoverSpan = document.createElement('span');
      takeoverSpan.append(' but it can be taken over ( click '); // .append() can mix text and elements

      if (isMe) {
        takeoverSpan.append('again to disable');
      } else {
        const takeoverActionSpan = document.createElement('span');
        takeoverActionSpan.style.color = 'red';
        takeoverActionSpan.textContent = 'to take over ASAP!!!';
        takeoverSpan.appendChild(takeoverActionSpan);
      }
      takeoverSpan.append(' )!');
      this.hostTitle.appendChild(takeoverSpan);
    } else {
      const statusSpan = document.createElement('span');
      statusSpan.textContent = player.locked ? " and it's locked!" : ".";
      this.hostTitle.appendChild(statusSpan);
    }
    // --- End of secure host title build ---

    this.videoPlaylistContainer.innerHTML = ''; // Clear the existing list before re-rendering
    player.playlist.forEach((v, i) => {
      const videoItemContainer = this.core.makeAndAddElement('div', {background: player.currentTrack === i ? '#4f4f4f' : i % 2 === 0 ? '#8f8f8f' : '#9f9f9f'}, this.videoPlaylistContainer);
      
      // --- FIX for thumbnail alignment ---
      // Create a content wrapper and use flexbox to vertically center the thumbnail and the info panel.
      const contentWrapper = this.core.makeAndAddElement('div', {
        display: 'flex',
        // By stretching the items, we allow the inner flex container to distribute space.
        alignItems: 'stretch'
      }, videoItemContainer);
      
      const videoThumbnail = this.core.makeAndAddElement('img',{height: '80px', width: '142px', flexShrink: '0'}, contentWrapper);
      // This container will hold the title at the top and buttons at the bottom.
      const videoTitleAndAction = this.core.makeAndAddElement('div',{
        flexGrow: '1',
        paddingLeft: '10px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        // This is a flexbox fix to prevent the container from overflowing when its
        // content (like a long title) resists shrinking. It allows the
        // text-overflow:ellipsis style on the title element to work correctly.
        minWidth: '0'
      }, contentWrapper);
      
      const titleContainer = this.core.makeAndAddElement('div', null, videoTitleAndAction);
      const videoTitle = this.core.makeAndAddElement('div',{
        padding: '4px 0px 0px 0px',
        textOverflow: 'ellipsis', 
        overflow: 'hidden', 
        whiteSpace: 'nowrap'
      }, titleContainer);
      
      videoThumbnail.src = v.thumbnail;
      
      // Build the title safely to prevent HTML injection
      videoTitle.innerHTML = ''; // Clear it first
      if (player.canVote && player.currentTrack !== i) {
        const voteBold = document.createElement('b');
        voteBold.textContent = `(${player.playlist[i].votes})`;
        videoTitle.appendChild(voteBold);
        videoTitle.append(' ');
      }
      videoTitle.append(v.title);

      const videoAuthor = this.core.makeAndAddElement('div',{
        padding: '0px 0px 0px 10px',
        textOverflow: 'ellipsis', 
        overflow: 'hidden', 
        fontSize: '0.8rem',
        color: '#cfcfcf',
        whiteSpace: 'nowrap'
      }, titleContainer);

      videoAuthor.className = "currentTimeAuthor";
      videoAuthor.innerText = "Added By: " + (v.user ? v.user.name : 'Unknown');
      
      // A dedicated container for all buttons and the time display.
      const buttonContainer = this.core.makeAndAddElement('div', { padding: '0 5px 0px 1px' }, videoTitleAndAction);

      if(player.currentTrack !== i) {
        if(isMe) {
          if(isMe || (!player.locked && !player.canVote)) {
            const playTrack = this.core.makeAndAddElement('div',null, buttonContainer);

            playTrack.className = 'button slim green';
            playTrack.innerText = "Play Now.";

            playTrack.addEventListener('click', () => {
              this.core.sendMessage({path: Commands.SET_TRACK, data: { index: i, link: v.link } });
            });          
          };    
        };
        if(player.canVote) {
          const voteDown = this.core.makeAndAddElement('div',null, buttonContainer);

          voteDown.className = 'button slim teal';
          voteDown.innerText = "Down Vote";

          voteDown.addEventListener('click', () => {
            this.core.sendMessage({path: Commands.DOWN_VOTE, data: v.link });
          });

          const voteUp = this.core.makeAndAddElement('div',null, buttonContainer);
          voteUp.className = 'button slim teal';
          voteUp.innerText = "Up Vote";

          voteUp.addEventListener('click', () => {
            this.core.sendMessage({path: Commands.UP_VOTE, data: v.link });
          });
        }else{
          if(this.core.player.host.id === window.user.id) {
            // Only show "Move Down" if it's not the last item in the playlist.
            if (i < player.playlist.length - 1) {
              const moveDown = this.core.makeAndAddElement('div',null, buttonContainer);
              moveDown.className = 'button slim teal';
              moveDown.innerText = "Move Down";
              moveDown.addEventListener('click', () => {
                this.core.sendMessage({path: Commands.MOVE_PLAYLIST_ITEM, data: {url: v.link , index: i + 1}  });
              });
            }

            // Only show "Move Up" if it's not the first item in the playlist.
            if (i > 0) {
              const moveUp = this.core.makeAndAddElement('div',null, buttonContainer);
              moveUp.className = 'button slim teal';
              moveUp.innerText = "Move Up";
              moveUp.addEventListener('click', () => {
                this.core.sendMessage({path: Commands.MOVE_PLAYLIST_ITEM, data: {url: v.link , index: i - 1} });
              });
            }
            if(isMe || (!player.locked && !player.canVote)) {
              const remove = this.core.makeAndAddElement('div',null, buttonContainer);

              remove.className = 'button slim red';
              remove.innerText = "Remove";

              remove.addEventListener('click', () => {
                this.core.sendMessage({path: Commands.REMOVE_PLAYLIST_ITEM, data: i });
              });         
            };    
          };
        };
      }else{
        
        const currentTimeText = this.core.makeAndAddElement('div',{
          padding: '7px 10px 0px 7px',
          textOverflow: 'ellipsis', 
          overflow: 'hidden', 
          whiteSpace: 'nowrap'
        }, buttonContainer);
        
        currentTimeText.className = "currentTimeText";
        currentTimeText.innerText = this.timeCode(player.currentTime) + " / " + this.durationCode(player.duration);
      }
        
      // The 'clear: both' div is no longer needed with the flexbox layout.
      // this.core.makeAndAddElement('div',{clear: 'both'}, videoItemContainer);
      
      if(player.currentTrack === i) {
        const currentTime = this.core.makeAndAddElement('div', {
          height: '4px', 
          width: '100%',
        }, videoItemContainer);
        const currentTimeInner = this.core.makeAndAddElement('div', {
          height: '4px', 
          background: 'red',
          transition: 'width 1s',
          transitionTimingFunction: 'linear',
          width: (player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0) + "%",
        }, currentTime);
        
        currentTimeInner.className = "currentTime";
      }
    })
    this.renderWaiting(player, isMe);
  }
  // The videos waiting for the host (added while the player is locked), after the playlist: the
  // host approves each with its own button, and the host or whoever added it can drop it.
  renderWaiting(player, isMe) {
    const waiting = Array.isArray(player.waiting) ? player.waiting : [];
    waiting.forEach(w => {
      const v = w && w.v;
      if (!v || !v.link) return;
      const mine = !!w.id && w.id === window.user.id;
      const row = this.core.makeAndAddElement('div', { background: '#6b5a2a', display: 'flex', alignItems: 'stretch' }, this.videoPlaylistContainer);
      const thumbnail = this.core.makeAndAddElement('img', { height: '80px', width: '142px', flexShrink: '0' }, row);
      if (v.thumbnail) thumbnail.src = v.thumbnail;
      const info = this.core.makeAndAddElement('div', { flexGrow: '1', paddingLeft: '10px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minWidth: '0' }, row);
      const text = this.core.makeAndAddElement('div', null, info);
      const title = this.core.makeAndAddElement('div', { padding: '4px 0px 0px 0px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }, text);
      title.textContent = String(v.title || 'A video');
      const by = this.core.makeAndAddElement('div', { padding: '0px 0px 0px 10px', fontSize: '0.8rem', color: '#cfcfcf', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }, text);
      by.textContent = `Waiting for the host to approve it. Added by: ${w.name || 'Unknown'}`;
      const buttons = this.core.makeAndAddElement('div', { padding: '0 5px 0px 1px' }, info);
      if (isMe) {
        const approve = this.core.makeAndAddElement('div', null, buttons);
        approve.className = 'button slim green';
        approve.innerText = 'Approve';
        approve.addEventListener('click', () => this.core.sendMessage({ path: Commands.APPROVE_VIDEO, data: v.link }));
      }
      if (isMe || mine) {
        const reject = this.core.makeAndAddElement('div', null, buttons);
        reject.className = 'button slim red';
        reject.innerText = isMe ? 'Reject' : 'Withdraw';
        reject.addEventListener('click', () => this.core.sendMessage({ path: Commands.REJECT_VIDEO, data: v.link }));
      }
    });
  }
  // ---- Saved lists: the snippet's playlist and playlists settings, and lists opened with Browse.
  // Each opens to show its videos, which can be added one at a time or all at once.

  setupListsUI() {
    this.listData = new Map();
    // The server works on 3 list previews at a time per connection and refuses more, so the rest
    // wait (see pumpLists). A preview is loaded again when shown after 5 minutes, as the server
    // re-reads lists then too.
    this.listQueue = [];
    this.listsOut = new Map(); // list id -> when it was asked for
    this.listsSocket = null;
    this.extraLists = [];
    this.openListId = null;
    this.listsOverlay = document.querySelector('.lists-overlay');
    this.listsContainer = document.querySelector('.lists-container');
    this.savedListsButton = document.querySelector('#savedLists');
    this.savedListsButton.addEventListener('click', () => this.showLists());
    document.querySelector('#close-lists-btn').addEventListener('click', () => { this.listsOverlay.style.display = 'none'; });
    this.listsOverlay.addEventListener('click', (event) => {
      if (event.target === this.listsOverlay) this.listsOverlay.style.display = 'none';
    });
  }
  // The snippet's fixed lists, the room's shared ones (saved on the server), then any opened with Browse.
  getLists() {
    if (!this.savedLists) this.savedLists = this.core.getSavedLists();
    const raw = (this.core.player && Array.isArray(this.core.player.lists)) ? this.core.player.lists : [];
    const shared = raw.filter(l => l && typeof l.link === 'string' && typeof l.id === 'string')
      .map(l => ({ id: l.link, label: String(l.title || 'Playlist'), shared: l.id, by: l.by && l.by.name ? String(l.by.name) : '' }));
    // A link in both the snippet's lists and the shared ones keeps its first entry, with the shared
    // details added (on a copy) so it still gets its Remove button.
    const byId = new Map();
    const out = [];
    this.savedLists.concat(shared, this.extraLists || []).forEach(l => {
      const had = byId.get(l.id);
      if (!had) { const copy = Object.assign({}, l); byId.set(l.id, copy); out.push(copy); }
      else if (l.shared && !had.shared) { had.shared = l.shared; had.by = l.by; }
    });
    return out;
  }
  // Saves a list to the room's shared lists (the host, or anyone while unlocked). The server checks it works.
  shareList(id) {
    if (!this.canAdd()) { this.core.showToast("The player is locked: only the host can save lists.", 4000); return; }
    this.core.sendMessage({ path: Commands.SAVE_LIST, data: { link: id } });
    this.core.showToast("Saving the list for everyone...", 3000);
  }
  unshareList(list) {
    if (!this.canAdd()) { this.core.showToast("The player is locked: only the host can remove lists.", 4000); return; }
    this.core.sendMessage({ path: Commands.REMOVE_LIST, data: { id: list.shared } });
    if (this.openListId === list.id) this.openListId = null;
  }
  isHost() {
    return !!(this.core.player && this.core.player.host && this.core.player.host.id === window.user.id);
  }
  // The host, or anyone while the player is unlocked (as the server checks).
  canAdd() {
    return this.isHost() || !(this.core.player && this.core.player.locked);
  }
  showLists() {
    this.listsOverlay.style.display = 'flex';
    this.getLists().forEach(list => this.requestList(list.id, false));
    this.renderLists();
  }
  // Asks the server what's in a list, unless it's already being asked for or a recent answer is
  // kept (`force` asks again anyway). A list shown before keeps its videos while it reloads.
  requestList(id, force) {
    this.checkListRequests();
    if (this.listsOut.has(id) || this.listQueue.includes(id)) return;
    const had = this.listData.get(id);
    if (had && had.state === 'ready' && !force && Date.now() - had.at < 5 * 60 * 1000) return;
    if (!(had && had.state === 'ready')) this.listData.set(id, { state: 'loading', at: Date.now() });
    this.listQueue.push(id);
    this.pumpLists();
  }
  // Sends waiting list requests, 3 at most at a time, while connected.
  pumpLists() {
    this.checkListRequests();
    while (this.core.connected() && this.listsOut.size < 3 && this.listQueue.length) {
      const id = this.listQueue.shift();
      this.listsOut.set(id, Date.now());
      this.core.sendMessage({ path: Commands.LIST_PREVIEW, data: { id } });
    }
    this.scheduleListExpiry();
  }
  // While requests are out, checks again when the oldest would time out (2 minutes), so a stalled
  // one shows its error and frees its place for the next waiting list without anyone clicking.
  scheduleListExpiry() {
    clearTimeout(this.listExpiryTimer);
    this.listExpiryTimer = null;
    if (!this.listsOut.size) return;
    const oldest = Math.min(...this.listsOut.values());
    this.listExpiryTimer = setTimeout(() => {
      this.listExpiryTimer = null;
      this.pumpLists(); // expires timed-out requests, sends waiting ones and schedules the next check
      if (this.listsOverlay.style.display !== 'none') this.renderLists();
    }, Math.max(0, oldest + 120000 - Date.now()) + 50);
  }
  // Requests whose reply can't come any more: sent on a connection since replaced (asked again on
  // the new one), or with no reply for 2 minutes.
  checkListRequests() {
    if (this.core.ws !== this.listsSocket) {
      this.listsSocket = this.core.ws;
      const lost = [...this.listsOut.keys()].filter(id => !this.listQueue.includes(id));
      this.listsOut.clear();
      this.listQueue.unshift(...lost);
    }
    const now = Date.now();
    for (const [id, at] of this.listsOut) {
      if (now - at < 120000) continue;
      this.listsOut.delete(id);
      const d = this.listData.get(id);
      if (d && d.state === 'loading') this.listData.set(id, { state: 'error', error: 'No reply from the server. Try again.' });
    }
  }
  onListPreview(data) {
    if (!data || typeof data.id !== 'string') return;
    this.listsOut.delete(data.id);
    this.pumpLists();
    if (data.error) this.listData.set(data.id, { state: 'error', error: String(data.error) });
    else this.listData.set(data.id, { state: 'ready', at: Date.now(), title: data.title || '', items: Array.isArray(data.items) ? data.items : [], skipped: data.skipped || 0, truncated: !!data.truncated });
    if (this.listsOverlay.style.display !== 'none') this.renderLists();
  }
  appendList(id) {
    if (!this.canAdd()) { this.core.showToast("The player is locked: only the host can add videos.", 4000); return; }
    this.core.sendMessage({ path: Commands.FROM_PLAYLIST, data: { id, append: true, fromPlaylist: true } });
    this.core.showToast("Adding the list to the playlist...", 3000);
  }
  replaceWithList(id) {
    this.core.sendMessage({ path: Commands.FROM_PLAYLIST, data: { id, shouldClear: true, fromPlaylist: true } });
    this.core.showToast("Loading playlist...", 3000);
  }
  browseList(id) {
    if (!this.getLists().some(l => l.id === id)) this.extraLists.push({ id, label: this.core.listLabel(id), isDefault: false, extra: true });
    this.openListId = id;
    this.requestList(id, true);
    this.savedListsButton.style.display = 'block';
    this.showLists();
  }
  renderLists() {
    const container = this.listsContainer;
    const scroll = container.scrollTop;
    container.innerHTML = '';
    const host = this.isHost();
    const canAdd = this.canAdd();
    const inPlaylist = new Set(((this.core.player && this.core.player.playlist) || []).map(v => v.link));
    const button = (parent, text, cls, onClick) => {
      const b = this.core.makeAndAddElement('div', null, parent);
      b.className = `button slim ${cls}`;
      b.textContent = text;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    const lists = this.getLists();
    if (!lists.length) {
      const empty = this.core.makeAndAddElement('div', { padding: '10px', color: '#bbb' }, container);
      empty.textContent = "No saved lists. Use Add Playlist > Save to Lists to keep one here for everyone in this room.";
    }
    lists.forEach(list => {
      const data = this.listData.get(list.id) || { state: 'none' };
      const open = this.openListId === list.id;
      const card = this.core.makeAndAddElement('div', null, container);
      card.className = 'list-card';
      const head = this.core.makeAndAddElement('div', null, card);
      head.className = 'list-card-head';
      const text = this.core.makeAndAddElement('div', null, head);
      text.className = 'list-card-name';
      const name = this.core.makeAndAddElement('div', null, text);
      name.textContent = ((data.state === 'ready' && data.title) || list.label) + (list.isDefault ? ' (default)' : list.shared ? ' (shared)' : '');
      const sub = this.core.makeAndAddElement('div', null, text);
      sub.className = 'list-card-sub';
      if (data.state === 'loading') sub.textContent = 'Loading...';
      else if (data.state === 'error') sub.textContent = data.error;
      else if (data.state === 'ready') {
        const n = data.items.length;
        sub.textContent = `${n} video${n === 1 ? '' : 's'}${data.truncated ? ' (the first ones)' : ''}${data.skipped ? `, ${data.skipped} skipped` : ''}`;
      }
      if (list.shared && list.by) sub.textContent += `${sub.textContent ? '  -  ' : ''}saved by ${list.by}`;
      button(head, open ? 'Close' : 'Open', 'grey', () => {
        this.openListId = open ? null : list.id;
        if (!open) this.requestList(list.id, data.state === 'error'); // or loaded a while ago
        this.renderLists();
      });
      if (data.state === 'error') button(head, 'Retry', 'teal', () => { this.requestList(list.id, true); this.renderLists(); });
      if (canAdd && data.state !== 'error') button(head, 'Add All', 'teal', () => this.appendList(list.id));
      if (host && data.state !== 'error') button(head, 'Replace', 'green', () => this.replaceWithList(list.id));
      if (list.shared && canAdd) button(head, 'Remove', 'red', () => this.unshareList(list));
      else if (list.extra && canAdd && data.state !== 'error') button(head, 'Save', 'purple', () => this.shareList(list.id));
      if (!open || data.state !== 'ready') return;
      data.items.forEach((v, i) => {
        const row = this.core.makeAndAddElement('div', null, card);
        row.className = 'list-item';
        const img = this.core.makeAndAddElement('img', null, row);
        if (v.thumbnail) img.src = v.thumbnail;
        const title = this.core.makeAndAddElement('div', null, row);
        title.className = 'list-item-title';
        const added = inPlaylist.has(v.link);
        const dur = v.duration ? this.durationCode(v.duration / 1000) : '';
        title.textContent = `${i + 1}. ${v.title || 'Untitled'}${dur ? '  (' + dur + ')' : ''}${added ? '  - in the playlist' : ''}`;
        title.title = v.link;
        if (canAdd && !added) button(row, 'Add', 'teal', () => {
          this.core.sendMessage({ path: Commands.ADD_TO_PLAYLIST, data: v });
          this.core.showToast(`"${v.title}" was added to the playlist!`);
        });
        if (host && !added) {
          button(row, 'Play Now', 'teal', () => this.core.sendMessage({ path: Commands.ADD_AND_PLAY, data: v }));
          button(row, 'Play Next', 'teal', () => this.core.sendMessage({ path: Commands.ADD_AND_PLAY_NEXT, data: v }));
        }
      });
    });
    container.scrollTop = scroll;
  }

  // The seek box's time in the video's own time. For a live video it says how far back from the
  // live point (a "-" in front or not).
  seekInputTime() {
    const range = this.liveRange();
    const t = this.parseTimeToSeconds(range ? String(this.seekTimeInput.value || '').trim().replace(/^-/, '') : this.seekTimeInput.value);
    if (t === null || !range) return t;
    return range.end - t;
  }
  parseTimeToSeconds(timeString) {
    if (!timeString) return null;
    timeString = timeString.trim();

    const parts = timeString.split(':').map(p => parseInt(p, 10));

    // If any part of the split is not a number, it's invalid.
    if (parts.some(isNaN)) return null;

    let totalSeconds = 0;
    if (parts.length === 3) { // HH:MM:SS format
      totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) { // MM:SS format
      totalSeconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1 && !timeString.includes(':')) { // Seconds-only format
      totalSeconds = parts[0];
    } else {
      return null; // Invalid format (e.g., "1:2:3:4" or "1:a")
    }

    return totalSeconds;
  }
  // h:mm:ss, with as many hours as it has: a live stream can be months in.
  timeCode(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  // A track's length, or --:-- when it isn't known (some files).
  durationCode(seconds) {
    return seconds > 0 ? this.timeCode(seconds) : '--:--';
  }
  loadVideos(videos) {
    this.videoSearchContainer.innerHTML = '';
    this.loadingSpinner.style.display = 'none';
    videos.forEach((v, i) => {
      const videoItemContainer = this.core.makeAndAddElement('div', {background: i % 2 === 0 ? '#8f8f8f' : '#9f9f9f'}, this.videoSearchContainer);
      
      const videoThumbnail = this.core.makeAndAddElement('img',{height: '80px', width: '142px', float: 'left'}, videoItemContainer);
      
      const videoTitleAndAction = this.core.makeAndAddElement('div',{float: 'left', width: 'calc(100% - 180px)'}, videoItemContainer);
      
      const videoTitle = this.core.makeAndAddElement('div',{
        padding: '5px 5px', 
        textOverflow: 'ellipsis', 
        overflow: 'hidden', 
        whiteSpace: 'nowrap'
      }, videoTitleAndAction);
      
      const addToPlaylist = this.core.makeAndAddElement('div',null, videoTitleAndAction);
      
      addToPlaylist.className = 'button slim teal';
      addToPlaylist.innerText = "Add To Playlist";
      
      addToPlaylist.addEventListener('click', async () => {
        this.core.sendMessage({ path: Commands.ADD_TO_PLAYLIST, data: v });
        this.core.showToast(`"${v.title}" was added to the playlist!`);
      }); 
      
      if(this.core.player && this.core.player.host.id === window.user.id) {
        const playNow = this.core.makeAndAddElement('div',null, videoTitleAndAction);

        playNow.className = 'button slim teal';
        playNow.innerText = "Play Now";

        playNow.addEventListener('click', () => {
          this.hideSearch();
          this.core.sendMessage({path: Commands.ADD_AND_PLAY, data: v });
        }); 

        const playNext = this.core.makeAndAddElement('div',null, videoTitleAndAction);

        playNext.className = 'button slim teal';
        playNext.innerText = "Play Next";

        playNext.addEventListener('click', () => {
          this.hideSearch();
          this.core.sendMessage({path: Commands.ADD_AND_PLAY_NEXT, data: v });
        }); 
      }
      
      this.core.makeAndAddElement('div',{clear: 'both'}, videoItemContainer);
      
      videoThumbnail.src = v.thumbnail;
        
      videoTitle.innerText = v.title;
    })
  }
  debounceSearch(searchVal) {
    if(searchVal.length > 1) {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => this.search(searchVal), 500);
      this.videoSearchContainer.style.display = 'block';
      this.searchBackDrop.style.display = 'block';
      this.loadingSpinner.style.display = 'block';
    }else{
      this.hideSearch();
    }
  }
  hideSearch() {
    this.videoSearchContainer.style.display = 'none';
    this.videoSearchContainer.innerHTML = '';
    this.searchBackDrop.style.display = 'none';
  }
  setupSearchOverlay() {
    // Use the new core function for all the standard search overlay logic.
    this.core.setupSearchOverlay(query => this.debounceSearch(query), 'Playlist');
  }
  hideReplacePrompt() {
    this.pendingReplacement = null;
    this.notificationArea.style.display = 'none';
    this.notificationArea.textContent = '';
    this.replaceConfirmButton.style.display = 'none';
    this.replaceDismissButton.style.display = 'none';
    this.replaceConfirmButton.onclick = null; // Clean up listener
  }
  setupNotificationArea() {
    this.notificationArea = document.querySelector('#playlist-notifications');
  }
  setupPlaylistUI() {
    
    this.searchInput = document.querySelector('.searchInput');
    this.searchInput.addEventListener('keyup', () => this.debounceSearch(this.searchInput.value))
    
    this.voting = document.querySelector('#voting');
    
    this.voting.addEventListener('click', () => this.core.sendMessage({path: Commands.TOGGLE_VOTE }));
    
    this.videoPlaylistContainer = document.querySelector('.videoPlaylistContainer');
    
    this.searchBackDrop = document.querySelector('.searchBackDrop');
      
    this.searchBackDrop.addEventListener('click', () => this.hideSearch());
    
    this.videoSearchContainer = document.querySelector('.videoSearchContainer');
    
    this.loadingSpinner = document.querySelector('.loadingSpinner');
    
    const host = this.getHostUrl();
    const proto = this.getProtocol(host);

    // Set the spinner's src from the config
    this.loadingSpinner.src = `https://firer.at/files/fvp/3-dots-move.svg`;
    
    this.lockPlayer = document.querySelector('#lockPlayer');
    
    this.lockPlayer.addEventListener('click', () => {
      if (this.core.player) {
        this.core.sendMessage({ path: Commands.TOGGLE_LOCK, data: !this.core.player.locked });
      }
    }); 
    
    this.takeOver = document.querySelector('#takeOver');
    
    this.takeOver.addEventListener('click', () => {
        if(this.core.player && this.core.player.host.id === window.user.id) {
          this.core.sendMessage({ path: Commands.TOGGLE_CAN_TAKE_OVER, data: !this.core.player.canTakeOver });
        }else{
          this.core.sendMessage({ path: Commands.TAKE_OVER });
        }
    });

    this.togglePause = document.querySelector('#togglePause');
    this.togglePause.addEventListener('click', () => {
      console.log("Toggle Pause v4 clicked!");
      this.core.showToast("Sending toggle pause v4 request...", 2000);
      this.core.sendMessage({ path: 'toggle-pause' });
    });
    
    this.clearPlaylistButton = document.querySelector('#clearPlaylist');
    
    this.clearPlaylistButton.addEventListener('click', () => this.clearPlaylist());
    
    // Refresh: fetch the whole state from the server, in case this list is out of date.
    this.refreshState = document.querySelector('#refreshState');
    this.refreshState.addEventListener('click', () => this.refresh(true));
    // Coming back to the page (e.g. after a headset sleep) is also a good time to catch up.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refresh(false);
    });

    this.autoSync = document.querySelector('#autoSync');
    
    this.autoSyncEnabled = false;
    
    this.autoSync.addEventListener('click', () => {
      this.autoSyncEnabled = !this.autoSyncEnabled;
      this.autoSync.innerText = this.autoSyncEnabled ? "Auto Sync: On" : "Auto Sync: Off";
      this.core.sendMessage({ path: Commands.AUTO_SYNC, data: this.autoSyncEnabled});
    });
    
    this.localSkipBack = document.querySelector('#localSkipBack');
    
    this.localSkipBack.addEventListener('click', () => {
        this.core.sendMessage({ path: Commands.LOCAL_SKIP_BACK });
    });
    
    this.localSkipForward = document.querySelector('#localSkipForward');
    
    this.localSkipForward.addEventListener('click', () => {
        this.core.sendMessage({ path: Commands.LOCAL_SKIP_FORWARD });
    });
    
    this.skipBackwards = document.querySelector('#skipBackwards');
    
    this.skipBackwards.addEventListener('click', () => {
        this.core.sendMessage({ path: Commands.HOST_SKIP_BACK });
    });
    
    this.skipForward = document.querySelector('#skipForward');
    
    this.skipForward.addEventListener('click', () => {
        this.core.sendMessage({ path: Commands.HOST_SKIP_FORWARD });
    });

    // A live video: everyone to its live point. A time past it, which the server brings back to
    // the live point as it is when it gets there.
    this.goLiveBtn = document.querySelector('#go-live-btn');
    this.goLiveBtn.addEventListener('click', () => {
      if (this.liveRange()) this.core.sendMessage({ path: Commands.SET_TIME, data: 1e9 });
    });
    
    this.addPlaylistOverlay = document.querySelector('.add-playlist-overlay');
    this.addItemInput = document.querySelector('#addItemInput');
    this.addItemSubmit = document.querySelector('#load-playlist-url-btn');
    this.clearPlaylistUrlButton = document.querySelector('#clear-playlist-url-btn');
    this.closePlaylistUrlButton = document.querySelector('#close-playlist-url-btn');
    this.addPlaylist = document.querySelector('#addPlaylist');
    
    this.addPlaylist.addEventListener('click', () => {
      this.addPlaylistOverlay.style.display = 'flex';
      this.addItemInput.value = '';
      this.addItemInput.focus();
    });

    this.closePlaylistUrlButton.addEventListener('click', () => {
      this.addPlaylistOverlay.style.display = 'none';
    });

    this.clearPlaylistUrlButton.addEventListener('click', () => {
      this.addItemInput.value = '';
      this.addItemInput.focus();
    });

    // A YouTube playlist, or a link to a list of links (which the server reads and checks).
    const playlistInput = () => {
      const input = this.addItemInput.value.trim();
      const id = this.core.getPlaylistId(input) || this.core.getListLink(input);
      if (!id) this.core.showToast("That is not a YouTube playlist or a link to a list of links.", 4000);
      return id;
    };
    this.addItemSubmit.addEventListener('click', () => {
      const playlistId = playlistInput();
      if (playlistId) {
        this.playlistId = playlistId;
        this.playPlaylist(true);
        this.addPlaylistOverlay.style.display = 'none';
        this.core.showToast("Loading playlist...", 3000);
      }
    });
    document.querySelector('#append-playlist-url-btn').addEventListener('click', () => {
      const id = playlistInput();
      if (id) {
        this.appendList(id);
        this.addPlaylistOverlay.style.display = 'none';
      }
    });
    document.querySelector('#save-playlist-url-btn').addEventListener('click', () => {
      const id = playlistInput();
      if (id) {
        this.shareList(id);
        this.addPlaylistOverlay.style.display = 'none';
      }
    });
    document.querySelector('#browse-playlist-url-btn').addEventListener('click', () => {
      const id = playlistInput();
      if (id) {
        this.addPlaylistOverlay.style.display = 'none';
        this.browseList(id);
      }
    });
    this.setupListsUI();

    this.addItemInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addItemSubmit.click();
      }
    });

    this.addVideoOverlay = document.querySelector('.add-video-overlay');
    this.addVideoInput = document.querySelector('#addVideoInput');
    this.addVideoSubmit = document.querySelector('#load-video-url-btn');
    this.clearVideoUrlButton = document.querySelector('#clear-video-url-btn');
    this.closeVideoUrlButton = document.querySelector('#close-video-url-btn');
    this.addVideo = document.querySelector('#addVideo');
    
    this.addVideo.addEventListener('click', () => {
      this.addVideoOverlay.style.display = 'flex';
      this.addVideoInput.value = '';
      this.addVideoInput.focus();
    });

    this.closeVideoUrlButton.addEventListener('click', () => {
      this.addVideoOverlay.style.display = 'none';
    });

    this.clearVideoUrlButton.addEventListener('click', () => {
      this.addVideoInput.value = '';
      this.addVideoInput.focus();
    });

    this.addVideoSubmit.addEventListener('click', () => {
      const input = this.addVideoInput.value;
      const videoId = this.core.getId(input);
      // YouTube, or a Twitch, Vimeo or direct video link, which the server checks.
      if (videoId || /^(https?|rtspt?):\/\//i.test(input.trim())) {
        this.core.sendMessage({ path: Commands.ADD_TO_PLAYLIST, data: input });
        this.addVideoOverlay.style.display = 'none';
      } else {
        this.core.showToast("Invalid Video URL or ID.", 4000);
      }
    });

    this.addVideoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addVideoSubmit.click();
      }
    });

    this.loadDefaultPlaylistButton = document.querySelector('#loadDefaultPlaylist');
    
    this.loadDefaultPlaylistButton.addEventListener('click', () => {
      // Set the playlistId from the core parameters, which are read from the URL.
      this.playlistId = this.core.params.playlist;
      this.playPlaylist(true); // `true` to clear the existing playlist
    });
    
    this.hostTitle = document.querySelector('.hostTitle');

    // --- Replace Video Prompt ---
    this.notificationArea = document.querySelector('#playlist-notifications');
    this.replaceConfirmButton = document.querySelector('#replaceConfirm');
    this.replaceDismissButton = document.querySelector('#replaceDismiss');
    this.replaceDismissButton.addEventListener('click', () => this.hideReplacePrompt());

    // --- FIX for dynamically created buttons ---
    // Instead of applying styles to existing elements, we inject a style rule
    // into the document head. This ensures that any element with the '.teal' class,
    // including ones created later like the move up/down buttons, will get the style.
    const style = document.createElement('style');
    style.innerHTML = `.teal { background: url(https://firer.at/files/fvp/Button_bg.png); background-size: 100% 100%; }`;
    document.head.appendChild(style);
    // --- End of FIX ---

    // --- Dynamic Height Adjustment for Playlist ---
    const headerContainer = document.querySelector('.playlistContainer');
    const adjustPlaylistHeight = () => {
      // Get the live heights of all elements above the playlist.
      const headerHeight = headerContainer.offsetHeight;
      const hostTitleHeight = this.hostTitle.offsetHeight;
      // Get notification height only if it's visible.
      const notificationHeight = this.notificationArea.style.display !== 'none' ? this.notificationArea.offsetHeight : 0;
      const totalHeaderHeight = headerHeight + hostTitleHeight + notificationHeight;
      
      // Use 100vh to calculate height against the full viewport, minus the headers.
      this.videoPlaylistContainer.style.height = `calc(100vh - ${totalHeaderHeight}px)`;
    };
    // A ResizeObserver is the most robust way to detect size changes. It automatically
    // handles elements appearing/disappearing or wrapping.
    const resizeObserver = new ResizeObserver(adjustPlaylistHeight);
    resizeObserver.observe(headerContainer);
    resizeObserver.observe(this.hostTitle);
    resizeObserver.observe(this.notificationArea);
    // Initial calculation on load.
    adjustPlaylistHeight();
    // --- End of Dynamic Height ---

    // --- Dropdown Menu Logic for Header Actions ---
    const moreActionsBtn = document.querySelector('#more-actions-btn');
    const moreActionsContent = document.querySelector('#more-actions-content');

    if (moreActionsBtn && moreActionsContent) {
      moreActionsBtn.addEventListener('click', (event) => {
        event.stopPropagation(); // Prevent the document click listener from firing immediately
        // Toggle visibility and button text
        const isVisible = moreActionsContent.style.display === 'block';
        moreActionsContent.style.display = isVisible ? 'none' : 'block';
        moreActionsBtn.innerText = isVisible ? 'More...' : 'Less';
      });

      // Prevent clicks inside the dropdown from closing it
      moreActionsContent.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      // Close the dropdown if the user clicks outside of it
      document.addEventListener('click', () => {
        if (moreActionsContent.style.display === 'block') {
          moreActionsContent.style.display = 'none';
          moreActionsBtn.innerText = 'More...';
        }
      });
    }

    // --- Seek Video Overlay Logic ---
    this.seekVideoBtn = document.querySelector('#seek-video-btn');
    this.seekOverlay = document.querySelector('#seek-overlay');
    this.seekTimeInput = document.querySelector('#seek-time-input');
    this.submitSeekBtn = document.querySelector('#submit-seek-btn');
    this.closeSeekBtn = document.querySelector('#close-seek-btn');
    this.seekSliderContainer = document.querySelector('#seek-slider-container');
    this.seekSliderProgress = document.querySelector('#seek-slider-progress');
    this.seekSliderThumb = document.querySelector('#seek-slider-thumb');
    this.seekHint = document.querySelector('#seek-hint');

    this.seekVideoBtn.addEventListener('click', () => {
      this.seekOverlay.style.display = 'flex';
      this.seekTimeInput.focus();

      // Update the slider and input to reflect the current video time. A live video's is how far
      // back from its live point (see seekInputTime).
      const range = this.liveRange();
      this.seekHint.innerText = range ? 'A live video: how far back from live, in seconds (e.g., 95) or hours:minutes:seconds (e.g., 1:30:00). It goes back 12 hours at most.'
        : 'Enter time in seconds (e.g., 95) or minutes:seconds (e.g., 1:35).';
      if (this.core.player && this.trackLength() > 0) {
        const p = this.core.player;
        const currentTime = p.paused ? (Number(p.currentTime) || 0) : ((Date.now() / 1000) - this.clockSkew) - p.lastStartTime;
        const progressPercent = this.barPercent(currentTime, range, this.trackLength());
        this.seekSliderProgress.style.width = `${progressPercent}%`;
        this.seekSliderThumb.style.left = `${progressPercent}%`;
        this.seekTimeInput.value = this.timeCode(range ? Math.max(0, range.end - currentTime) : currentTime);
      } else {
        // Reset slider and input if no video is playing
        this.seekSliderProgress.style.width = '0%';
        this.seekSliderThumb.style.left = '0%';
        this.seekTimeInput.value = '';
      }
    });

    // Clicking the slider updates the time input without seeking.
    this.seekSliderContainer.addEventListener('click', (event) => {
      if (this.core.player && this.trackLength() > 0) {
        const sliderWidth = this.seekSliderContainer.clientWidth;
        const clickPosition = event.offsetX;
        const seekRatio = Math.min(1, Math.max(0, clickPosition / sliderWidth));
        const range = this.liveRange();
        const newTime = range ? (1 - seekRatio) * (range.end - range.start) : seekRatio * this.trackLength();
        // Update the input field with the new time (a live video's: how far back from live).
        this.seekTimeInput.value = this.timeCode(newTime);
        // Trigger the input event to update the slider's visual state.
        this.seekTimeInput.dispatchEvent(new Event('input'));
      }
    });
    const closeSeekOverlay = () => this.seekOverlay.style.display = 'none';

    this.closeSeekBtn.addEventListener('click', closeSeekOverlay);
    this.seekOverlay.addEventListener('click', (event) => {
      if (event.target === this.seekOverlay) closeSeekOverlay();
    });

    this.submitSeekBtn.addEventListener('click', () => {
      const timeInSeconds = this.seekInputTime();
      if (timeInSeconds !== null) {
        this.core.sendMessage({ path: Commands.SET_TIME, data: timeInSeconds });
        closeSeekOverlay();
      } else {
        this.core.showToast("Invalid time format. Use seconds (e.g., 95) or mm:ss (e.g., 1:35).", 4000);
      }
    });

    this.seekTimeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitSeekBtn.click();
      }
    });

    // Update the slider position as the user types in the input box.
    this.seekTimeInput.addEventListener('input', () => {
      if (this.core.player && this.trackLength() > 0) {
        const timeInSeconds = this.seekInputTime();
        if (timeInSeconds !== null) {
          const progressPercent = this.barPercent(timeInSeconds, this.liveRange(), this.trackLength());
          const clampedPercent = Math.max(0, Math.min(100, progressPercent));
          this.seekSliderProgress.style.width = `${clampedPercent}%`;
          this.seekSliderThumb.style.left = `${clampedPercent}%`;
        }
      }
    });
  }
}
window.playlistUiInstance = new Playlist();