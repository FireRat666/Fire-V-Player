var Core = class {
    constructor() {
        this.urlParams = new URLSearchParams(window.location.search);
        this.isKaraoke = false;
        this.createdElements = [];
    }
  async init() {
    await this.setupToastify();
    // Check the URL for the 'mode' parameter to determine behavior (e.g., skip times).
    this.isKaraoke = this.urlParams.get('mode') === 'karaoke';
    this.imIn = false;
    // Set defaults for parameters that depend on the host URL.
    // This runs after parseParams, so this.hostUrl is available.
    this.setOrDefault("data-playlist-icon-url", `https://${this.hostUrl}/assets/Playlist.png`);
    this.setOrDefault("data-vol-up-icon-url", `https://${this.hostUrl}/assets/VolUp.png`);
    this.setOrDefault("data-vol-down-icon-url", `https://${this.hostUrl}/assets/VolDown.png`);
    this.setOrDefault("data-mute-icon-url", `https://${this.hostUrl}/assets/Mute.png`);
    this.setOrDefault("data-skip-forward-icon-url", `https://${this.hostUrl}/assets/Forward.png`);
    this.setOrDefault("data-skip-backward-icon-url", `https://${this.hostUrl}/assets/Backwards.png`);

    if(this.params.announce === 'true') { 
      // this.setupSayNamesScript();
    }
    if(window.isBanter) {
      let lastSendTime = Date.now();
      const positionOfBrowser = this.params.position.split(" ");
      window.userPoseCallback = async pose => {
        if(this.params.spatial === 'true') {
          const minDistance = Number(this.params["spatial-min-distance"]);
          const maxDistance = Number(this.params["spatial-max-distance"]);
          const a = userinputs.head.position.x - positionOfBrowser[0];
          const b = userinputs.head.position.y - positionOfBrowser[1];
          const c = userinputs.head.position.z - positionOfBrowser[2];
          const distance = Math.sqrt(a * a + b * b + c * c);
          let volume = ((maxDistance - (distance - minDistance)) / maxDistance);
          if(volume > 1) {
            volume = 1;
          }else if(volume < 0) {
            volume = 0;
          }
          const now = Date.now();
          if(now - lastSendTime > 500) {
            lastSendTime = now;
            const roundedVolume = Math.round(this.params.volume * volume);
            if(this.tempVolume != roundedVolume) {
              // Add a .catch() to handle cases where the browser isn't ready yet.
              // This prevents an "Uncaught (in promise)" error when the pose callback
              // fires before the browser element has been initialized. The rejection is
              // expected in this scenario, so we can safely ignore it.
              this.sendBrowserMessage({path: Commands.SET_VOLUME, data: roundedVolume, type: 'spatial'})
                .catch(() => { /* Browser not ready, ignore rejection */ });
            }
            this.tempVolume = roundedVolume; 
          }
        }
      }
      // By the time this runs, window.user is already set by the entry-point script
      // (playlist.js / karaoke.js) which waited for bs-loaded + unity-loaded before
      // loading anything. No further waiting is needed here.
      if(this.params["hand-controls"] === 'true') { 
        this.setupHandControls();
      }
    }else{
      try{
        if(!window.user) {
          if(this.urlParams.has("user")) {
            var userStr = this.urlParams.get("user").split("-_-");
            window.user = {
              id: userStr[0],
              name: decodeURIComponent(userStr[1])
            }
          }else{
            this.generateGuestUser();
          }
        }
      }catch{
        this.generateGuestUser();
      }
    }
  }
  setupBrowserElement(url) {
    this.initialUrl = url;
    const scene = document.querySelector("a-scene");
    if (!scene) {
      console.log("No <a-scene> tag found. Creating a fallback 2D player.");
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.style.width = "80vw";
      iframe.style.height = "80vh";
      iframe.style.border = "none";
      iframe.style.position = "fixed";
      iframe.style.top = "10vh";
      iframe.style.left = "10vw";
      iframe.style.zIndex = "1000";
      document.body.appendChild(iframe);

      const playlistUrl = `https://${this.hostUrl}/playlist/?instance=${this.params.instance}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}`;
      this.showToast(`Player is in 2D mode. See console for playlist URL.`, 5000);
      console.log(`Player is in 2D mode. Open the playlist controls here: ${playlistUrl}`);
      return;
    }
    const browser = document.createElement('a-entity');
    browser.setAttribute("position", this.params.position);
    browser.setAttribute("rotation", this.params.rotation);
    browser.setAttribute("scale", this.params.scale);
    console.log({"mipMaps": this.params['mip-maps'], "pixelsPerUnit": Number(this.params.resolution), "mode": "local"});
    // console.log("setupBrowserElement", url);
    browser.setAttribute("sq-browser", {"mipMaps": this.params['mip-maps'], "pixelsPerUnit": Number(this.params.resolution), "mode": "local", "url": url});
    if(this.params.geometry && this.params.geometry !== "false") {
      const shape = document.createElement('a-entity');
      // if(this.params.is3d === true || this.params.is3d === 'true') {
        // shape.setAttribute("sq-custommaterial", "shaderName: Banter/StereoscopicUnlit;");
      // }
      shape.setAttribute("geometry", this.params.geometry);
      shape.setAttribute("material", "color: white");
      browser.appendChild(shape);
    }else if(this.params.is3d === true || this.params.is3d === 'true') {
      // browser.setAttribute("sq-custommaterial", "shaderName: Banter/StereoscopicUnlit;");
    }
    scene.appendChild(browser);
    this.browser = browser;
    this.createdElements.push(browser);
    this.browser.addEventListener('browsermessage', (e) => {
      // console.log("got a browser message");
      // console.log(e);
    });
    this.setupBrowserUi();
  }
  clickBrowser(x,y) {
    this.browser.components['sq-browser'].runActions([{actionType: "click2d", numParam1: x, numParam2: y}])
  }
  setupBrowserUi() {
    const scene = document.querySelector("a-scene");
    if(!scene) {
      console.log("No a-scene tag found, is this an AFRAME scene ?");
      return;
    }
    
     //this.readCustomIconUrls();
    
    const yScale = Number(this.params.scale.split(" ")[1]);
    const position = Number(this.params.position.split(" ")[0]) + " " + (Number(this.params.position.split(" ")[1]) - (yScale*0.335)) + " " + Number(this.params.position.split(" ")[2]);
    this.playlistContainer = document.createElement('a-entity');
    this.playlistContainer.setAttribute('position', this.params["button-position"] === "0 0 0" ? position : this.params["button-position"]);
    this.playlistContainer.setAttribute('rotation', this.params["button-rotation"] === "0 0 0" ? this.params.rotation : this.params["button-rotation"]);
    this.playlistContainer.setAttribute('scale', this.params["button-scale"]);
    this.setupPlaylistButton(scene, this.playlistContainer);
    this.setupVolButton(scene, true, this.playlistContainer);
    this.setupVolButton(scene, false, this.playlistContainer);
    this.setupMuteButton(scene, this.playlistContainer);
    this.setupSkipButton(scene, true, this.playlistContainer);
    this.setupSkipButton(scene, false, this.playlistContainer);
    this.createdElements.push(this.playlistContainer);
    scene.appendChild(this.playlistContainer);
  }
  setVolume(isUp, amount) {
    if(isUp) {
      this.params.volume += amount || 1;
      if(this.params.volume > 100) {
        this.params.volume = 100;
      }
    }else{
      this.params.volume -= amount || 3;
      if(this.params.volume < 0) {
        this.params.volume = 0;
      }
    }
  }
  setAbsoluteVolume(amount) {
    this.params.volume = amount;
    if(this.params.volume > 100) {
      this.params.volume = 100;
    } else if (this.params.volume < 0) {
      this.params.volume = 0;
    }
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: this.params.volume});
  }
  setVolumeIncrement(amount) {
    this.params.volume += amount;
    if(this.params.volume > 100) {
      this.params.volume = 100;
    } else if (this.params.volume < 0) {
      this.params.volume = 0;
    }
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: this.params.volume});
  }
  setupJoinLeaveButton() {
    const scene = document.querySelector("a-scene");
    if(!scene) {
      console.log("No a-scene tag found, is this an AFRAME scene ?");
      return;
    }
    const playlistButton = document.createElement('a-entity');
    playlistButton.setAttribute('sq-boxcollider', 'size: 1 0.3 0.05');
    playlistButton.setAttribute('sq-interactable', '');
    const buttonGlb = document.createElement('a-entity');
    buttonGlb.setAttribute('gltf-model',`https://${this.hostUrl}/assets/ButtonL.glb`);
    playlistButton.appendChild(buttonGlb);
    playlistButton.setAttribute('position', this.params["singer-button-position"]);
    playlistButton.setAttribute('rotation', this.params["singer-button-rotation"]);
    playlistButton.setAttribute('opacity', '0.3');
    playlistButton.setAttribute('transparent', 'true');
    this.playlistContainer.appendChild(playlistButton);
    const playlistButtonText = document.createElement('a-text');
    playlistButtonText.setAttribute('value', "singers");
    playlistButtonText.setAttribute('position', '0 0.01 0.03');
    playlistButtonText.setAttribute('align', 'center');
    playlistButtonText.setAttribute('scale', '0.8 0.8 0.8');
    playlistButton.appendChild(playlistButtonText);
    playlistButton.addEventListener('click', () => this.openPlaylist());
    const triggerEnter = this.params["box-trigger-enter-enabled"] === "true";
    const triggerExit = this.params["box-trigger-exit-enabled"] === "true"
    if(triggerEnter || triggerExit) {
      const boxTrigger = document.createElement('a-entity');
      boxTrigger.setAttribute('sq-boxcollider', '');
      boxTrigger.setAttribute('sq-triggercollider', '');
      boxTrigger.setAttribute('position', this.params["box-trigger-position"]);
      boxTrigger.setAttribute('rotation', this.params["box-trigger-rotation"]);
      boxTrigger.setAttribute('scale', this.params["box-trigger-scale"]);
      let hasStarted = false;
      let hasStartedTimeout;
      boxTrigger.addEventListener('trigger-enter', e => {
        if(e.detail.isLocalPlayer) {
          clearTimeout(hasStartedTimeout);
          if(triggerEnter && this.player && this.player.players.length && this.player.players[0].id === window.user.id && !hasStarted) {
            if(this.player.locked) {
              this.showToast("Player is locked! The host needs to unlock it first!");
            }else{
              // this.sendMessage({path: Commands.CLEAR_PLAYLIST, skipUpdate: true});
              this.sendMessage({path: Commands.ADD_TO_PLAYLIST, data: this.player.players[0].v, isYoutubeWebsite: false, skipUpdate: true });
              this.sendMessage({path: Commands.SET_TRACK, data: 0});
              hasStarted = true;
            }
          }
        }
      });
      boxTrigger.addEventListener('trigger-exit', e => {
        if(e.detail.isLocalPlayer) {
          clearTimeout(hasStartedTimeout);
          hasStartedTimeout = setTimeout(() => {
            if(triggerExit && this.player && this.player.players.length && hasStarted) {
              const player = this.player.players[0];
              console.log(player.id, window.user.id, this.player);
              if(player.id === window.user.id) {
                  this.sendMessage({path: Commands.REMOVE_FROM_PLAYERS, data: player.id });
                  // this.sendMessage({path: Commands.CLEAR_PLAYLIST, skipUpdate: true});
                  this.sendMessage({path: Commands.STOP});
                  hasStarted = false;
              }
            }
          }, 5000);
        }
      });
      this.playlistContainer.appendChild(boxTrigger);
    }
  }
  showToast(text, duration = 3000) {
    if(typeof Toastify !== 'undefined') {
      Toastify({
        text: text,
        duration: duration,
        // close: true,
        gravity: "bottom", // `top` or `bottom`
        position: "right", // `left`, `center` or `right`
        offset: {
          y: '3em' // Moves the toast up from the bottom edge
        },
        // stopOnFocus: true, // Prevents dismissing of toast on hover
        style: {
          background: `url(https://${this.hostUrl}/assets/Button_bg.png) center center no-repeat`,
          backgroundSize: "cover",
          opacity: 0.7,
          fontSize: "2em",
          fontFamily: "'Roboto', sans-serif"
        },
        // onClick: function(){} // Callback after click
      }).showToast();
    }
  }
  setupPlaylistButton(scene, playlistContainer) {
    const playlistIconUrl = this.params["data-playlist-icon-url"];
    // Use the isKaraoke flag to provide a context-specific text label
    const buttonText = this.isKaraoke ? 'Singers' : 'Playlist';
    this.setupButton(scene, playlistContainer, '-0.633', playlistIconUrl, () => this.openPlaylist(), buttonText);
  }

  openPlaylist() {
    // Determine the mode ('karaoke' or 'playlist') based on the in-world script's setting.
    const mode = this.isKaraoke ? 'karaoke' : 'playlist';
    const playlistParam = this.params.playlist ? `&playlist=${this.params.playlist}` : "";
    // Pass the mode as a URL parameter so the UI page knows its context.
    window.openPage(`https://${this.hostUrl}/${mode}/?instance=${this.params.instance}${playlistParam}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}&mode=${mode}`);
  }
  setupVolButton(scene, isUp, playlistContainer) {
  const volIconUrl = isUp ? this.params["data-vol-up-icon-url"] : this.params["data-vol-down-icon-url"];
  this.setupButton(scene, playlistContainer, isUp ? 0.693 : 0.471, volIconUrl, () => this.volume(isUp));
}
setupSkipButton(scene, isBack, playlistContainer) {
  const skipIconUrl = isBack ? this.params["data-skip-backward-icon-url"] : this.params["data-skip-forward-icon-url"];
  this.setupButton(scene, playlistContainer, isBack ? -0.332 : -0.081, skipIconUrl, () => (isBack ? this.back() : this.forward()));
}
  volume(isUp) {
    this.setVolume(isUp);
    if(isUp && this.params.mute == 'true') {
      this.params.mute = 'false';
      this.sendBrowserMessage({path: Commands.MUTE, data: this.params.mute});
    }
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: this.params.volume});
  }
  
  mute() {
     this.params.mute = this.params.mute == 'true' ? 'false' : 'true';
    this.sendBrowserMessage({path: Commands.MUTE, data: this.params.mute});
  }
  setupMuteButton(scene, playlistContainer) {
  const muteIconUrl = this.params["data-mute-icon-url"]; // URL for the mute button icon
  this.setupButton(scene, playlistContainer, '0.23', muteIconUrl, () => this.mute());
}

  setupHandControls() {
    // This was a great innovation by HBR, who wanted Skizot to also get credit for the original idea. 
    const handControlsContainer = document.createElement("a-entity");
    handControlsContainer.setAttribute("scale", "0.08 0.08 0.08");
    handControlsContainer.setAttribute("position", "0.05 0.006 -0.010");
    handControlsContainer.setAttribute("sq-lefthand", "whoToShow: " + window.user.id);
    [
      {
        image: this.params["data-playlist-icon-url"],
        position: "-1 -0.2 0.4", 
        callback: () => this.openPlaylist()
      },
      {
        image: this.params["data-skip-backward-icon-url"],
        position: "-1 -0.2 0", 
        callback: () => this.sendBrowserMessage({path: Commands.SKIP_BACK})
      },
      {
        image: this.params["data-skip-forward-icon-url"],
        position: "-1 -0.2 -0.4", 
        callback: () => this.sendBrowserMessage({path: Commands.SKIP_FORWARD})
      },
      {
        image: this.params["data-mute-icon-url"],
        position: "-1 0.2 0.4", 
        callback: () => this.mute()
      },
      {
        image:this.params["data-vol-down-icon-url"],
        position: "-1 0.2 0", 
        callback: () => this.volume(false)
      },
      {
        image: this.params["data-vol-up-icon-url"],
        position: "-1 0.2 -0.4", 
        callback: () => this.volume(true)
      }
    ].forEach(item => {
      const button = document.createElement("a-plane");
      button.setAttribute("sq-interactable", "");
      button.setAttribute("sq-collider", "");
      button.setAttribute("scale", "0.4 0.4 0.4");
      button.setAttribute("rotation", "0 -90 180");
      button.setAttribute("src", item.image);
      button.setAttribute("transparent", true);
      button.setAttribute("position", item.position);
      button.addEventListener("click", () => item.callback());
      handControlsContainer.appendChild(button);
    })
    this.handControlsContainer = handControlsContainer;
    this.createdElements.push(handControlsContainer);
    document.querySelector("a-scene").appendChild(handControlsContainer);
  }

setupButton(scene, playlistContainer, xOffset, iconUrl, callback, text) {
  const buttonContainer = document.createElement('a-entity');
  buttonContainer.setAttribute('position', `${xOffset} 0 0`);

  const buttonIcon = document.createElement('a-plane');
  buttonIcon.setAttribute('sq-boxcollider', 'size: 1 1 0.05');
  buttonIcon.setAttribute('sq-interactable', '');
  buttonIcon.setAttribute('src', iconUrl);
  buttonIcon.setAttribute('transparent', 'true');
  buttonIcon.setAttribute('scale', '0.2 0.2 0.2');
  buttonContainer.appendChild(buttonIcon);

  if (text) {
    const buttonText = document.createElement('a-text');
    buttonText.setAttribute('value', text);
    buttonText.setAttribute('align', 'center');
    buttonText.setAttribute('position', '0 -0.15 0'); // Position text below the icon
    buttonText.setAttribute('scale', '0.2 0.2 0.2');
    buttonContainer.appendChild(buttonText);
  }

  playlistContainer.appendChild(buttonContainer);
  buttonIcon.addEventListener('click', callback);

  return buttonIcon;
}

  generateGuestUser() {
    const id = this.getUniquId();
    window.user = {id, name: "Guest " + id};
    localStorage.setItem('user', JSON.stringify(window.user));
  }
  getUniquId() {
    return (Math.random() + 1).toString(36).substring(7);
  }
  parseParams(currentScript) {
    this.currentScript = currentScript;
    this.params = {};
    if (this.currentScript) {
      this.createdElements.push(this.currentScript);
    }
    this.setOrDefault("position", "0 0 0");
    this.setOrDefault("rotation", "0 0 0");
    this.setOrDefault("scale", "1 1 1");
    const yScale = Number(this.params.scale.split(" ")[1]);
    this.setOrDefault("singer-button-position", `0 ${-yScale*0.335} 3`);
    this.setOrDefault("singer-button-rotation", "-30 180 0");
    this.setOrDefault("button-position", `0 0 0`);
    this.setOrDefault("button-rotation", `0 0 0`);
    this.setOrDefault("button-scale", `1 1 1`);
    this.setOrDefault("box-trigger-enter-enabled", 'false');
    this.setOrDefault("box-trigger-exit-enabled", 'false');
    this.setOrDefault("box-trigger-position", '0 0 0');
    this.setOrDefault("box-trigger-rotation", '0 0 0');
    this.setOrDefault("box-trigger-scale", '1 1 1');
    this.setOrDefault("resolution", '1600');
    this.setOrDefault("one-for-each-instance", "false");
    this.setOrDefault("instance", location.href);
    this.setOrDefault("playlist", "");
    this.setOrDefault("volume", '40');
    this.setOrDefault("mute", 'false');
    this.setOrDefault("is3d", 'false');
    this.setOrDefault("announce", 'true');
    this.setOrDefault("announce-four-twenty", 'false');
    this.setOrDefault("hand-controls", 'false');
    this.setOrDefault("mip-maps", '1');
    this.setOrDefault("spatial", 'true');
    this.setOrDefault("geometry", "false");
    this.setOrDefault("spatial-min-distance", '5');
    this.setOrDefault("spatial-max-distance", '40');
    this.setOrDefault("youtube", "https://www.youtube.com/watch?v=GiwStUzx8fg");
    this.setOrDefault("start", '0');
    
    if (this.params.playlist) {
      const extractedId = this.getPlaylistId(this.params.playlist);
      if (!extractedId) {
        console.warn(`Could not extract a valid playlist ID from provided playlist parameter: "${this.params.playlist}". It will be ignored.`);
      }
      this.params.playlist = extractedId || "";
    }
    
    this.params.volume = Number(this.params.volume);
    this.params['mip-maps'] = Number(this.params['mip-maps']);
    this.tempVolume = this.params.volume;
    this.params.mute = this.params.mute === 'true' ? 'true' : 'false';
    if(this.params["one-for-each-instance"] === "true" && window.user && window.user.instance) {
        this.params.instance += window.user.instance;
    }
  }
  setOrDefault(attr, defaultValue) {
    const value = this.currentScript.getAttribute(attr);
    this.params[attr] = value || (this.urlParams.has(attr) ? this.urlParams.get(attr) : defaultValue);
  }
  setupWebsocket(type, messageCallback, connectedCallback, closeCallback){
    return new Promise(resolve => {
      this.ws = new WebSocket('wss://' + this.hostUrl + '/');
      this.ws.onopen = (event) => {
        console.log("Websocket connected!");
        resolve();
        connectedCallback();
        this.sendMessage({path: Commands.SET_WS_TYPE, data: type})
      };
      this.ws.onmessage = (event) => {
        if(typeof event.data === 'string'){
          messageCallback ? messageCallback(event.data) : this.parseMessage(event.data);
        }
      }
      this.ws.onclose =  (event) => {
        console.log("Websocket closed...");
        setTimeout(() => {
          if(closeCallback) {
            closeCallback();
          }
          this.setupWebsocket(type, messageCallback, connectedCallback, closeCallback);
        }, 1000);
      };
    });
  }
  connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
  sendMessage(msg){
    msg.u = window.user;
    if(this.connected()) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  recieveBrowserMessage(msg) {
    if(msg.id && this.browserAcks[msg.id]) {
      this.browserAcks[msg.id]();
      this.browserAcks[msg.id] = null;
    }else{
      switch(msg.path) {
          // handle other direct messages from the browser
      }
    }
  }
  sendBrowserMessage(msg){
    if(!window.isBanter) {
      return;
    }
    this.browserAcks = this.browserAcks || {};
    msg.u = window.user;
    msg.i = this.params.instance;
    msg.id = this.getUniquId();
    return new Promise((resolve, reject) => {
      if(this.browser) {
        this.browserAcks[msg.id] = resolve;
        this.browser.components['sq-browser'].runActions([{actionType: "postmessage", strParam1: JSON.stringify(msg)}]);
      }else{
        reject(new Error("Browser element not initialized. Cannot send message."));
      }
    });
  }
  makeAndAddElement(type, style, parent) {
    const element = document.createElement(type);
    Object.assign(element.style, style || {});
    (parent ? parent : document.body).appendChild(element);
    return element;
  }
  parseMessage(msg) {
    const json = JSON.parse(msg);
    switch(json.path) {
      case Commands.ERROR:
        console.error("I cant let you do that...");
        break;
      case Commands.RESET_BROWSER:
        if(window.isBanter && this.browser) {
          // console.log("RESET_BROWSER", {"url": this.initialUrl});
          this.browser.setAttribute("sq-browser", {"url": this.initialUrl});
        }
        break;
      case Commands.ITEM_REMOVED:
        // Apply the removal directly to the in-world player's playlist state.
        if (this.player && this.player.playlist) {
          this.player.playlist.splice(json.data.index, 1);
          this.player.currentTrack = json.data.newCurrentTrack;
          console.log(`In-world player updated: Removed item at index ${json.data.index}, new current track ${json.data.newCurrentTrack}`);
        }
        break;
      case Commands.ITEM_APPENDED:
        if (this.player && this.player.playlist) {
          this.player.playlist.push(json.data.video);
          console.log(`In-world player updated: Appended item "${json.data.video.title}"`);
        }
        break;
      case Commands.ITEM_INSERTED:
        if (this.player && this.player.playlist) {
          // Insert the new video at the specified index.
          this.player.playlist.splice(json.data.index, 0, json.data.video);
          // The currentTrack index is not affected when inserting after the current song.
          console.log(`In-world player updated: Inserted item at index ${json.data.index}`);
        }
        break;
      case Commands.ITEM_MOVED:
        if (this.player && this.player.playlist) {
          const { oldIndex, newIndex, newCurrentTrack } = json.data;
          const [itemToMove] = this.player.playlist.splice(oldIndex, 1);
          this.player.playlist.splice(newIndex, 0, itemToMove);
          this.player.currentTrack = newCurrentTrack;
          console.log(`In-world player updated: Moved item from ${oldIndex} to ${newIndex}, new current track ${newCurrentTrack}`);
        }
        break;
      case Commands.ITEM_REPLACED:
        if (this.player && this.player.playlist) {
          const { index, newVideo } = json.data;
          if (this.player.playlist[index]) {
            this.player.playlist[index] = newVideo;
            console.log(`In-world player updated: Replaced item at index ${index}`);
          }
        }
        break;

      case Commands.STOP:
      case Commands.PLAYBACK_UPDATE:
        // Merge new data into the existing player state.
        // This is crucial because the in-world script shares this state object with the UI.
        this.player = Object.assign(this.player || {}, json.data.video);
        break;
      case Commands.SINGER_LIST_UPDATED:
        if (this.player) {
          this.player.players = json.data.players;
          // The server now sends the list pre-sorted. The client should not re-sort it.
        }
        break;
      case Commands.SYNC_TIME:
        json.volume = this.tempVolume;
        this.sendBrowserMessage(json);
        break;
      case Commands.SET_BROWSER_URL:
        if(window.isBanter && this.browser) {
          // console.log("SET_BROWSER_URL", {"url": json.data.link});
          this.browser.setAttribute("sq-browser", {"url": json.data.link});
        }
        break;
      case Commands.CLICK_BROWSER:
        if(window.isBanter) {
          this.clickBrowser(json.data.x,json.data.y);
        }
        break;
      case Commands.SHOW_REPLACE_PROMPT:
        // This is a notification for the host in the 3D space to check their playlist UI.
        this.showToast("Video unavailable for a user. Check playlist to replace.", 5000);
        break;
      case Commands.SET_ABSOLUTE_VOLUME:
        this.setAbsoluteVolume(json.data);
        break;
      case Commands.SET_VOLUME_INCREMENT:
        this.setVolumeIncrement(json.data);
        break;
      case 'pause-state-changed':
        console.log("[CORE] PAUSE_STATE_CHANGED received", json.data);
        if (this.player) {
          this.player.paused = json.data.paused;
          this.player.currentTime = json.data.currentTime;
          this.player.lastStartTime = json.data.lastStartTime;
          console.log("[CORE] Forwarding to browser player");
          this.sendBrowserMessage(json);
        } else {
          console.log("[CORE] Player state missing, cannot handle pause change.");
        }
        break;
    }
  }
  getId(url){
    var regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    var match = url.match(regExp);
    return (match&&match[7].length==11)? match[7] : false;
  }
  getPlaylistId(urlOrId) {
    // First, check if the input is just a valid playlist ID.
    // A simple check is to see if it starts with PL and contains no URL characters.
    if (urlOrId.startsWith('PL') && !urlOrId.includes('/') && !urlOrId.includes('?')) {
        return urlOrId;
    }

    // If it's a URL, try to extract the 'list' parameter.
    const regex = /[?&]list=([^#&?]+)/;
    const match = urlOrId.match(regex);

    if (match && match[1] && match[1].startsWith('PL')) {
        return match[1];
    }

    // Return null if no valid ID could be extracted.
    return null;
  }
  async setupToastify() {
    if (typeof Toastify === 'undefined') {
      // Load CSS
      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.type = 'text/css';
      cssLink.href = 'https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.css';
      document.head.appendChild(cssLink);
      this.createdElements.push(cssLink);

      // Load JS
      await this._loadExternalScript('https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.js');
    }
  }
  _loadExternalScript(url) {
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", url);
      myScript.addEventListener ("load", resolve, false);
      document.body.appendChild(myScript);
      this.createdElements.push(myScript);
    });
  }
  setupSayNamesScript(callback) {
    return this.setupScript(callback, "say-names", {"four-twenty": this.params["announce-four-twenty"]});
  }
  setupCommandsScript(callback) {
    return this.setupScript(callback, "commands");
  }
  setupScript(callback, name, attrs) {
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", `https://${this.hostUrl}/${name}.js`);
      if(attrs) {
        Object.keys(attrs).forEach(k => {
          myScript.setAttribute(k, attrs[k]);
        })
      }
      myScript.addEventListener ("load", resolve, false);
      this.createdElements.push(myScript);
      document.body.appendChild(myScript);  
    });
  }
  back() {
    const isHost = this.player && this.player.host && this.player.host.id === window.user.id;
    // The host can only perform a global skip in playlist mode.
    // In karaoke mode, their skip is local, just like any other user.
    if (isHost && !this.isKaraoke) {
      // If the host skips, send a command to the server to sync everyone.
      this.sendMessage({ path: Commands.HOST_SKIP_BACK });
    } else {
      // If a regular user skips, or if the host is in karaoke mode, it's a local-only adjustment.
      this.sendBrowserMessage({ path: Commands.SKIP_BACK });
    }
  }
  forward() {
    const isHost = this.player && this.player.host && this.player.host.id === window.user.id;
    // The host can only perform a global skip in playlist mode.
    // In karaoke mode, their skip is local, just like any other user.
    if (isHost && !this.isKaraoke) {
      this.sendMessage({ path: Commands.HOST_SKIP_FORWARD });
    } else {
      this.sendBrowserMessage({ path: Commands.SKIP_FORWARD });
    }
  }
  vol(num) {
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: num});
  }
  destroy() { // To Use : window.cleanupVideoPlayer();
    console.log("Cleaning up Fire-V-Player instance...");

    if (this.ws) {
      this.ws.onclose = null; // prevent reconnection logic
      this.ws.close();
      console.log("WebSocket disconnected.");
    }

    this.createdElements.forEach(element => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    });
    this.createdElements = [];
    console.log("Removed created DOM elements.");

    // Remove any global references to this instance
    this.browser = null;
    this.playlistContainer = null;
    this.handControlsContainer = null;
    this.ws = null;
    if (window.playlistPlayerInstance) {
      window.playlistPlayerInstance = null;
    }
    if (window.karaokePlayerInstance) {
      window.karaokePlayerInstance = null;
    }
    // Nullify the other global instances to allow for complete garbage collection.
    if (window.playerInstance) {
      window.playerInstance = null;
    }
    if (window.playlistUiInstance) {
      window.playlistUiInstance = null;
    }
    if (window.karaokeUiInstance) {
      window.karaokeUiInstance = null;
    }
    window.videoPlayerCore = null;

    // Remove event listeners from the window, if any were added directly.
    // This is a general cleanup step.
    window.onYouTubeIframeAPIReady = null;
    // You might have other global event listeners. Add them here as needed.

    console.log("Clean up complete.");
  }
  
  // This new method centralizes all the logic for the search overlay UI.
  setupSearchOverlay(searchCallback, storageKey) {
    this.searchOverlay = document.querySelector('.search-overlay');
    if (!this.searchOverlay) return; // Don't run if the overlay isn't on the page

    this.openSearchButton = document.querySelector('#open-search-overlay-btn');
    this.searchInputOverlay = document.querySelector('.search-overlay-box .searchInput');
    this.clearSearchButton = document.querySelector('#clear-search-btn');
    this.closeSearchButton = document.querySelector('#close-search-btn');
    this.submitSearchButton = document.querySelector('#submit-search-btn');

    const populateRecentSearches = () => {
        const recentSearches = JSON.parse(localStorage.getItem(`recent${storageKey}Searches`) || '[]');
        const recentSearchesContainer = document.querySelector('.recent-searches');
        if (!recentSearchesContainer) return;

        recentSearchesContainer.innerHTML = '';
        if (recentSearches.length > 0) {
            recentSearches.forEach(search => {
                const item = document.createElement('div');
                item.textContent = search;
                item.classList.add('recent-search-item');
                item.addEventListener('click', () => setSearchAndSubmit(search));
                recentSearchesContainer.appendChild(item);
            });
        }
    };

    const showSearchOverlay = () => {
        this.searchOverlay.style.display = 'flex';
        this.searchInputOverlay.focus();
        const lastSearch = localStorage.getItem(`last${storageKey}Search`);
        if (lastSearch) {
            this.searchInputOverlay.value = lastSearch;
        }
        populateRecentSearches();
    };

    const hideSearchOverlay = () => {
        this.searchOverlay.style.display = 'none';
        localStorage.setItem(`last${storageKey}Search`, this.searchInputOverlay.value);
    };

    const submitSearch = () => {
        const query = this.searchInputOverlay.value;
        if (query.trim() !== "") {
            hideSearchOverlay();
            localStorage.setItem(`last${storageKey}Search`, query);
            let recentSearches = JSON.parse(localStorage.getItem(`recent${storageKey}Searches`) || '[]');
            recentSearches = [query, ...recentSearches.filter(s => s !== query)].slice(0, 5);
            localStorage.setItem(`recent${storageKey}Searches`, JSON.stringify(recentSearches));
            searchCallback(query);
        }
    };

    const setSearchAndSubmit = (searchTerm) => {
        this.searchInputOverlay.value = searchTerm;
        submitSearch();
    };

    this.openSearchButton.addEventListener('click', showSearchOverlay);
    this.closeSearchButton.addEventListener('click', hideSearchOverlay);
    this.submitSearchButton.addEventListener('click', submitSearch);
    this.clearSearchButton.addEventListener('click', () => {
        this.searchInputOverlay.value = '';
        this.searchInputOverlay.focus();
    });

    // Add a listener to close the overlay when clicking on the dark background.
    this.searchOverlay.addEventListener('click', (event) => {
      if (event.target === this.searchOverlay) {
        hideSearchOverlay();
      }
    });

    // Add a listener for the Enter key on the input field.
    this.searchInputOverlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault(); // Prevent any default form submission behavior
        submitSearch();
      }
    });
  }
}
window.videoPlayerCore = new Core();
window.cleanupVideoPlayer = () => {
  if (window.videoPlayerCore) {
    window.videoPlayerCore.destroy();
  }
};