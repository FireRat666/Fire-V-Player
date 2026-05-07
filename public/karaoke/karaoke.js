var Karaoke = class {
  constructor() {
    this.currentScript = document.currentScript;
    this.uiUpdateInterval = null;
    this.clockSkew = 0; // The estimated difference between client and server clocks.
    this.init();
  }
  async init() {
    await this.setupConfigScript();
    await this.setupCoreScript();
    this.core = window.videoPlayerCore;
    this.core.hostUrl = window.APP_CONFIG.HOST_URL;
    this.core.parseParams(this.currentScript);
    await this.core.setupCommandsScript(); // Load Commands before UI setup and core.init
    this.setupKaraokeUI();
    this.setupSearchOverlay();
    await this.core.init();
    await this.core.setupWebsocket("playlist", d => this.parseMessage(d), () => {
      this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user});
    }, () => {
        this.core.showToast("Reconnecting...");
    });
    this.addYoutubeScript();
  }
  addYoutubeScript() {
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
  }
  setupKaraokeUI() {
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
    
    this.autoAdvance = document.querySelector('#autoAdvance');
    this.autoAdvance.addEventListener('click', () => {
      if (this.core.player && this.core.player.host.id === window.user.id) {
        // The new state will be sent back by the server via AUTO_ADVANCE_STATE_CHANGED
        this.core.sendMessage({ path: Commands.TOGGLE_AUTO_ADVANCE });
      }
    });
    
    this.closePreview = document.querySelector('.closePreview');
    
    this.closePreview.addEventListener('click', () => {
      this.videoPreviewContainer.style.display = "none";
      this.YtPlayer.pauseVideo();
    });
    
    this.singIt = document.querySelector('#singIt');
    
    this.singIt.addEventListener('click', () => {
      // Hide the preview immediately on click to prevent double-adds.
      this.videoPreviewContainer.style.display = "none";
      this.core.sendMessage({ path: Commands.ADD_TO_PLAYERS, data: this.selectedVideo }); // : Commands.REMOVE_FROM_PLAYERS 
      this.YtPlayer.pauseVideo();
      this.hideSearch();
    });
    
    this.videoPlayer = document.querySelector('#videoPlayer');
    
    this.videoPreviewContainer = document.querySelector('.videoPreviewContainer');

    this.alreadyInQueueMessage = document.querySelector('#alreadyInQueueMessage');
    
    this.videoPlaylistContainer = document.querySelector('.videoPlaylistContainer');

    this.searchBackDrop = document.querySelector('.searchBackDrop');
      
    this.searchBackDrop.addEventListener('click', () => this.hideSearch());
    
    this.videoSearchContainer = document.querySelector('.videoSearchContainer');
    
    this.loadingSpinner = document.querySelector('.loadingSpinner');
    
    this.lockPlayer = document.querySelector('#lockPlayer');

    // Set the spinner's src from the config, making it consistent with other UIs.
    this.loadingSpinner.src = `https://${window.APP_CONFIG.HOST_URL}/assets/3-dots-move.svg`;
    
    this.lockPlayer.addEventListener('click', () => {
      if (this.core.player) {
        this.core.sendMessage({ path: Commands.TOGGLE_LOCK, data: !this.core.player.locked });
      }
    }); 
    
    this.takeOver = document.querySelector('#takeOver');

    // --- FIX for dynamically created buttons ---
    // Instead of applying styles to existing elements, we inject a style rule
    // into the document head. This ensures that any element with the '.teal' class,
    // including ones created later, will get the correct background style.
    const style = document.createElement('style');
    style.innerHTML = `.teal { background: url(https://${window.APP_CONFIG.HOST_URL}/assets/Button_bg.png); background-size: 100% 100%; }`;
    document.head.appendChild(style);
    // --- End of FIX ---
    
    this.takeOver.addEventListener('click', () => {
        if(this.core.player && this.core.player.host.id === window.user.id) {
          this.core.sendMessage({ path: Commands.TOGGLE_CAN_TAKE_OVER, data: !this.core.player.canTakeOver });
        }else{
          this.core.sendMessage({ path: Commands.TAKE_OVER });
        }
    });

    this.togglePause = document.querySelector('#togglePause');
    this.togglePause.addEventListener('click', () => {
      this.core.sendMessage({ path: Commands.TOGGLE_PAUSE });
    });
    this.hostTitle = document.querySelector('.hostTitle');

    // --- Dynamic Height Adjustment for Singer List ---
    const headerContainer = document.querySelector('.playlistContainer');
    const adjustSingerListHeight = () => {
      // Get the live heights of all elements above the singer list.
      const headerHeight = headerContainer.offsetHeight;
      const hostTitleHeight = this.hostTitle.offsetHeight;
      const totalHeaderHeight = headerHeight + hostTitleHeight;
      // Use 100vh to calculate height against the full viewport, minus the headers.
      this.videoPlaylistContainer.style.height = `calc(100vh - ${totalHeaderHeight}px)`;
    };
    // A ResizeObserver is the most robust way to detect size changes.
    const resizeObserver = new ResizeObserver(adjustSingerListHeight);
    resizeObserver.observe(headerContainer);
    resizeObserver.observe(this.hostTitle);
    // Initial calculation on load.
    adjustSingerListHeight();
    // --- End of Dynamic Height ---
  }

  // --- Initialize Overlay ---
  setupSearchOverlay() {
    // Use the new core function for all the standard search overlay logic.
    this.core.setupSearchOverlay(query => this.debounceSearch(query), 'Karaoke');

    // The core function already selected this, but we need it for the specific buttons.
    this.searchInputOverlay = document.querySelector('.search-overlay-box .searchInput');

    // Add event listeners for the karaoke-specific search buttons
    const lyricsButton = document.querySelector('.lyrics-search-btn');
    const karaokeButton = document.querySelector('.karaoke-search-btn');
    const zoomKaraokeButton = document.querySelector('.zoom-search-btn');

    if (lyricsButton) {
      lyricsButton.addEventListener('click', () => {
          this.searchInputOverlay.value += ' lyrics ';
          this.searchInputOverlay.focus();
      });
    }
    if (karaokeButton) {
      karaokeButton.addEventListener('click', () => {
          this.searchInputOverlay.value += ' karaoke ';
          this.searchInputOverlay.focus();
      });
    }
    if (zoomKaraokeButton) {
      zoomKaraokeButton.addEventListener('click', () => {
          this.searchInputOverlay.value += ' zoom karaoke ';
          this.searchInputOverlay.focus();
      });
    }
  }
  setupCoreScript() {
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", `https://${window.APP_CONFIG.HOST_URL}/core.js`);
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
  parseMessage(msg) {
    const json = JSON.parse(msg);
    switch(json.path) {
      case Commands.PLAYBACK_UPDATE:
        // Merge new data into the existing player state.
        // This prevents the singer list from being wiped out on updates that don't include it.
        this.core.player = Object.assign(this.core.player || {}, json.data.video);
        this.updatePlaylist(this.core.player);
        this.startUiUpdater();
        break;
      case Commands.SEARCH_RESULTS:
        this.loadVideos(json.data);
        break;
      case Commands.ERROR:
        const errorMessage = json.data && json.data.message ? json.data.message : "I can't let you do that...";
        this.core.showToast(errorMessage, 4000);
        break;
      // --- Add more granular message handlers to keep the UI responsive ---
      case Commands.LOCK_STATE_CHANGED:
        if (this.core.player) {
          this.core.player.locked = json.data.locked;
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
      case Commands.AUTO_ADVANCE_STATE_CHANGED:
        if (this.core.player) {
          this.core.player.autoAdvance = json.data.autoAdvance;
          // Re-render the UI with the new auto-advance state
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.AUTO_SYNC_STATE_CHANGED:
        this.autoSyncEnabled = json.data.enabled;
        this.autoSync.innerText = this.autoSyncEnabled ? "Auto Sync: On" : "Auto Sync: Off";
        break;
      case Commands.TRACK_CHANGED:
        if (this.core.player) {
          // This is the authoritative message that a new song is playing.
          // It contains the new one-song playlist for the karaoke player.
          // A restart command won't include a new playlist, so we must check for it.
          if (json.data.playlist) {
            this.core.player.playlist = json.data.playlist;
          }
          this.core.player.currentTrack = json.data.newTrackIndex;
          this.core.player.lastStartTime = json.data.newLastStartTime;
          if (this.core.player.playlist[this.core.player.currentTrack]) {
              this.core.player.duration = this.core.player.playlist[this.core.player.currentTrack].duration / 1000;
          }
          // If the message also contains an updated singer list, apply it.
          if (json.data.singers) {
            this.core.player.players = json.data.singers;
          }
          this.updatePlaylist(this.core.player);
          this.startUiUpdater();
        }
        break;
      case Commands.HOST_SEEK:
        if (this.core.player) {
          this.core.player.lastStartTime = json.data.newLastStartTime;
          this.core.player.currentTime = json.data.newCurrentTime;
          // The UI updater will pick up the new lastStartTime on its next interval.
          // To make the change immediate, we can manually update the relevant elements.
          const currentTimeBar = document.querySelector('.currentTime');
          if (currentTimeBar && this.core.player.duration > 0) {
            currentTimeBar.style.width = `${(this.core.player.currentTime / this.core.player.duration) * 100}%`;
          }
          const currentTimeText = document.querySelector('.currentTimeText');
          if (currentTimeText) {
            currentTimeText.innerText = `${this.timeCode(this.core.player.currentTime)} / ${this.timeCode(this.core.player.duration)}`;
          }
        }
        break;
      case Commands.SINGER_LIST_UPDATED:
        if (this.core.player) {
          // This is the new authoritative source for the singer list.
          this.core.player.players = json.data.players;
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.SINGER_ADDED:
        if (this.core.player && this.core.player.players) {
          // Add the new singer to the local list and re-render.
          this.core.player.players.push(json.data.player);
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.SINGER_REMOVED:
        if (this.core.player && this.core.player.players) {
          // Find and remove the singer by their ID and re-render.
          const index = this.core.player.players.findIndex(p => p.id === json.data.userId);
          if (index > -1) {
            this.core.player.players.splice(index, 1);
          }
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.SINGER_MOVED:
        if (this.core.player && this.core.player.players) {
          const { oldIndex, newIndex } = json.data;
          // Move the item in the local array to match the server
          const [itemToMove] = this.core.player.players.splice(oldIndex, 1);
          this.core.player.players.splice(newIndex, 0, itemToMove);
          this.updatePlaylist(this.core.player);
        }
        break;
      case Commands.PAUSE_STATE_CHANGED:
        if (this.core.player) {
          this.core.player.paused = json.data.paused;
          this.core.player.currentTime = json.data.currentTime;
          this.core.player.lastStartTime = json.data.lastStartTime;
          this.updatePlaylist(this.core.player);
          if (this.core.player.paused) {
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
  search(data) {
    this.core.sendMessage({path: Commands.SEARCH, data });
  }
  updatePlaylist(player) {
    const isMe = player.host.id === window.user.id;
    this.lockPlayer.innerText = player.locked ? 'Unlock' : 'Lock';
    this.lockPlayer.className = player.locked ? 'button teal' : 'button red';
    this.lockPlayer.style.display = !isMe ? 'none' : 'inline-block';
    this.takeOver.style.display = (player.canTakeOver || isMe) ? 'inline-block' : 'none';
    this.skipBackwards.style.display = isMe ? 'inline-block' : 'none';
    this.skipForward.style.display = isMe ? 'inline-block' : 'none';
    this.autoAdvance.style.display = !isMe ? 'none' : 'inline-block';
    this.takeOver.innerText = player.canTakeOver ? (isMe ? 'Take Over: On' : 'Take Over') : 'Take Over: Off';
    this.takeOver.className = player.canTakeOver ? (isMe ? 'button red' : 'button teal') : 'button teal';

    // Update the Auto Advance button state regardless of the singer queue.
    this.autoAdvance.innerText = player.autoAdvance ? 'Auto Advance: On' : 'Auto Advance: Off';
    this.autoAdvance.className = player.autoAdvance ? 'button teal red' : 'button teal';

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

    this.videoPlaylistContainer.innerHTML = '';
    let contentRendered = false;

    // --- Render Currently Playing Song ---
    if (player.playlist && player.playlist.length > 0) {
      contentRendered = true;
      const video = player.playlist[player.currentTrack];
      // This is a defensive check to prevent errors if the player state is ever inconsistent.
      if (!video) {
        this.videoPlaylistContainer.innerHTML = '<h2 style="color: grey; margin-top: 100px; text-align: center;">Error: Could not display current song.</h2>';
        return;
      }
      const videoItemContainer = this.core.makeAndAddElement('div', { background: '#4f4f4f', marginBottom: '10px' }, this.videoPlaylistContainer);
      
      // --- FIX for thumbnail alignment ---
      // Create a content wrapper and use flexbox to vertically center the thumbnail and the info panel.
      const contentWrapper = this.core.makeAndAddElement('div', {
        display: 'flex',
        alignItems: 'center',
        padding: '1px'
      }, videoItemContainer);
      const videoThumbnail = this.core.makeAndAddElement('img', { height: '80px', width: '142px', flexShrink: '0' }, contentWrapper);
      videoThumbnail.src = video.thumbnail;
      const videoTitleAndAction = this.core.makeAndAddElement('div', { flexGrow: '1', paddingLeft: '3px' }, contentWrapper);
      const videoTitle = this.core.makeAndAddElement('div', { padding: '5px 1px 1px 5px', fontSize: '1.4em' }, videoTitleAndAction);
      // Securely build the title to prevent XSS from user names or video titles.
      videoTitle.innerHTML = ''; // Clear existing content
      const nowSingingBold = document.createElement('b');
      nowSingingBold.textContent = 'Now Singing:';
      videoTitle.appendChild(nowSingingBold);
      videoTitle.append(` ${video.user.name} - ${video.title}`);
      
      const currentTimeText = this.core.makeAndAddElement('div',{
        padding: '7px 10px 0px 7px',
        textOverflow: 'ellipsis',
        overflow: 'hidden',
        whiteSpace: 'nowrap'
      }, videoTitleAndAction);
      currentTimeText.className = "currentTimeText";
      currentTimeText.innerText = `${this.timeCode(player.currentTime)} / ${this.timeCode(player.duration)}`;

      const isCurrentSinger = video.user.id === window.user.id;
      // Add a stop button for the host or the current singer.
      if (isMe || isCurrentSinger) {
        const buttons = this.core.makeAndAddElement('div', null, videoTitleAndAction);
        
        const restartButton = this.core.makeAndAddElement('div', null, buttons);
        restartButton.className = 'button slim teal';
        restartButton.innerText = "Restart Song";
        restartButton.addEventListener('click', () => {
          this.core.sendMessage({ path: Commands.RESTART_SONG });
        });
        const stopButton = this.core.makeAndAddElement('div', null, buttons);
        stopButton.className = 'button slim red';
        stopButton.innerText = "Stop Song";
        stopButton.addEventListener('click', () => {
          this.core.sendMessage({ path: Commands.STOP });
        });
      }

      // Add the progress bar at the bottom of the item container
      const currentTime = this.core.makeAndAddElement('div', {
        height: '4px',
        width: '100%',
      }, videoItemContainer);
      const currentTimeInner = this.core.makeAndAddElement('div', {
        height: '4px',
        background: 'red',
        transition: 'width 1s',
        transitionTimingFunction: 'linear',
        width: `${(player.currentTime / player.duration) * 100}%`,
      }, currentTime);
      currentTimeInner.className = "currentTime";
    }

    // --- Render Singer Queue ---
    if (player.players && player.players.length > 0) {
      contentRendered = true;
      if (player.players && Array.isArray(player.players)) {
        player.players.forEach((p, i) => {
          const videoItemContainer = this.core.makeAndAddElement('div', { background: i % 2 === 0 ? '#8f8f8f' : '#9f9f9f' }, this.videoPlaylistContainer);
          
          // --- FIX for DOM Exception and layout consistency ---
          // Use a modern flexbox layout, consistent with the playlist UI, to prevent rendering errors.
          const contentWrapper = this.core.makeAndAddElement('div', { display: 'flex', alignItems: 'center', padding: '1px' }, videoItemContainer);

          const videoThumbnail = this.core.makeAndAddElement('img', { height: '80px', width: '142px', flexShrink: '0' }, contentWrapper);
          videoThumbnail.src = p.v.thumbnail;

          const videoTitleAndAction = this.core.makeAndAddElement('div', { flexGrow: '1', paddingLeft: '10px' }, contentWrapper);
          
          const videoTitle = this.core.makeAndAddElement('div', {
              padding: '10px 7px 5px 15px',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              fontSize: '1.4em'
          }, videoTitleAndAction);

          // Build the title safely to prevent HTML injection
          videoTitle.textContent = `${i + 1}. `;
          const nameBold = document.createElement('b');
          nameBold.textContent = p.name;
          const titleBold = document.createElement('b');
          titleBold.textContent = p.v.title;
          videoTitle.append(nameBold, ' will sing ', titleBold);

          // Create a container for the buttons
          const buttons = this.core.makeAndAddElement('div', { marginTop: "5px" }, videoTitleAndAction);
          const isTheSinger = p.id === window.user.id;

          // The host can play any singer. A singer can play themselves if they are up next.
          if (isMe || (i === 0 && isTheSinger)) {
            const playButton = this.core.makeAndAddElement('div', null, buttons);
            playButton.className = 'button slim teal';
            playButton.innerText = "Play & Sing";
            playButton.addEventListener('click', () => {
              // If the host clicks on a singer who is not first, send their ID.
              // Otherwise, send no data, and the server will play the person at the top.
              const payload = (i > 0 && isMe) ? { userId: p.id } : null;
              this.core.sendMessage({ path: Commands.PLAY_KARAOKE_TRACK, data: payload });
            });
          }

          if (isMe || isTheSinger) {
            const removeButton = this.core.makeAndAddElement('div', null, buttons);
            removeButton.className = 'button slim red extra-margin-left';
            // The host sees "Remove Song" for others, "Remove Me" for themselves.
            // A user sees "Remove Me" only for themselves.
            removeButton.innerText = (isMe && !isTheSinger) ? "Remove Song" : "Remove Me";
            removeButton.addEventListener('click', () => this.core.sendMessage({ path: Commands.REMOVE_FROM_PLAYERS, data: p.id }));
          }

          if (isMe) {
            if (i > 0) {
              const moveUp = this.core.makeAndAddElement('div', null, buttons);
              moveUp.className = 'button slim teal extra-margin-left';
              moveUp.innerText = "Move Up";
              moveUp.addEventListener('click', () => this.core.sendMessage({ path: Commands.MOVE_SINGER, data: { userId: p.id, direction: 'up' } }));
            }
            if (i < player.players.length - 1) {
              const moveDown = this.core.makeAndAddElement('div', null, buttons);
              moveDown.className = 'button slim teal extra-margin-left';
              moveDown.innerText = "Move Down";
              moveDown.addEventListener('click', () => this.core.sendMessage({ path: Commands.MOVE_SINGER, data: { userId: p.id, direction: 'down' } }));
            }
          }
        });
      }
    }

    // --- Render Empty State ---
    if (!contentRendered) {
      this.videoPlaylistContainer.innerHTML = '<h2 style="color: grey; margin-top: 100px; text-align: center;">No singers added yet!<br><br><div style="color: red;">DON\'T FORGET TO TAKE OVER THE KARAOKE PLAYER BEFORE YOU START!!</div></h2>';
    }
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
      
      const preview = this.core.makeAndAddElement('div',null, videoTitleAndAction);
      
      preview.className = 'button slim teal';
      preview.innerText = "Preview & Sing It";
      
      preview.addEventListener('click', () => {
        this.selectedVideo = v;
        this.videoPreviewContainer.style.display = "block";

        // Check if the user is already in the singer list.
        const isAlreadyInQueue = this.core.player && this.core.player.players && this.core.player.players.some(p => p.id === window.user.id);

        if (isAlreadyInQueue) {
          this.singIt.style.display = 'none';
          this.alreadyInQueueMessage.style.display = 'inline-block';
        } else {
          this.singIt.style.display = 'inline-block';
          this.alreadyInQueueMessage.style.display = 'none';
        }
        this.YtPlayer.loadVideoById(this.core.getId(v.link), 0);
      });
      
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
  startUiUpdater() {
    // Clear any existing interval to prevent multiple loops running
    if (this.uiUpdateInterval) {
      clearInterval(this.uiUpdateInterval);
    }

    // Only start a new interval if we have a valid player state with a playlist
    if (!this.core.player || !this.core.player.playlist || this.core.player.playlist.length === 0 || !this.core.player.lastStartTime) {
      return;
    }
    let updateCount = 0;
    this.uiUpdateInterval = setInterval(() => {
      let { lastStartTime, duration } = this.core.player;
      if (duration <= 0) return;

      // By subtracting the estimated clock skew, we align the client's 'now' with the server's 'now'.
      let calculatedTime = ((Date.now() / 1000) - this.clockSkew) - lastStartTime;
      updateCount++;
      if (updateCount <= 5) { // Log the first 5 updates
        console.log(`UI Update #${updateCount}: lastStartTime=${lastStartTime}, duration=${duration}, calculatedTime=${calculatedTime}`);
        console.log(`UI Update #${updateCount}: clockSkew=${this.clockSkew.toFixed(3)}s, calculatedTime=${calculatedTime.toFixed(3)}s`);
      }

      // Clamp the calculated time to ensure it's within the valid range.
      calculatedTime = Math.max(0, Math.min(calculatedTime, duration)); // Clamp to valid range.

      // Update the progress bar width.
      const currentTimeBar = document.querySelector('.currentTime');
      if (currentTimeBar) {
        currentTimeBar.style.width = `${(calculatedTime / duration) * 100}%`;
      }
      const currentTimeText = document.querySelector('.currentTimeText');
      if (currentTimeText) {
        currentTimeText.innerText = `${this.timeCode(calculatedTime)} / ${this.timeCode(duration)}`;
      }
    }, 1000); // Update every second
  }
  timeCode(seconds) {
    return new Date(seconds * 1000).toISOString().substring(11, 19);
  }
  setupYoutubePlayer() {
    const youtubeUrl = 'https://www.youtube.com/watch?v=GiwStUzx8fg'; // Default video (Silence)
    new YT.Player('player', {
      height: '100%',
      width: '100%',
      videoId: this.core.getId(decodeURIComponent(youtubeUrl)),
      playerVars: {
        'playsinline': 1,
        'mute': 1,
        'autoplay': 1,
        'disablekb': 1,
        'controls': 0,
        'modestbranding': true,
        'cc_load_policy': 1,
        'cc_lang_pref': 'en',
        'iv_load_policy': 3,
        'origin': window.location.origin,
        'start': 0 // The preview player always starts at 0.
      },
      events: {
        'onReady': (event) => {
          this.YtPlayer = event.target;
          this.YtPlayer.setVolume(0);
        }
      }
    });
  }
   /**
     * Estimates the difference between the client's clock and the server's clock.
     * This value is used to align the UI time with the server's time.
     */
    estimateClockSkew() {
      if (this.core.player.lastStartTime && this.core.player.duration > 0) {
        const serverNow = this.core.player.lastStartTime + this.core.player.currentTime;
        const clientNow = Date.now() / 1000;
        this.clockSkew = clientNow - serverNow;
      }
  }
}
window.karaokeUiInstance = new Karaoke();

function onYouTubeIframeAPIReady() {
  if (window.karaokeUiInstance) {
    window.karaokeUiInstance.setupYoutubePlayer();
  }
}