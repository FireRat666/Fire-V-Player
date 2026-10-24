// Protected space state key holding a space admin's mode choice (see switchMode).
var MODE_STATE_KEY = 'fire-v-player-mode';
var MODE_WRITE_TIMEOUT_MS = 6000;
var CAPTIONS_PREF_KEY = 'fire-v-player-captions';

var Core = class {
    constructor() {
        this.urlParams = new URLSearchParams(window.location.search);
        this.isKaraoke = false;
        this.createdElements = [];
    }

    getProtocol() {
        if (this.hostProtocol) return this.hostProtocol;
        if (this.hostUrl && (this.hostUrl.startsWith('localhost') || this.hostUrl.startsWith('127.0.0.1'))) {
            return 'http';
        }
        if (typeof location !== 'undefined' && location.protocol === 'http:') {
            return 'http';
        }
        return 'https';
    }

    getWsProtocol() {
        return this.getProtocol() === 'http' ? 'ws' : 'wss';
    }

  async init() {
    await this.setupToastify();
    // Check the URL for the 'mode' parameter to determine behavior (e.g., skip times).
    this.isKaraoke = this.urlParams.get('mode') === 'karaoke';
    this.imIn = false;
    // Set defaults for parameters that depend on the host URL.
    // This runs after parseParams, so this.hostUrl is available.
    const proto = this.getProtocol();
    this.setOrDefault("data-playlist-icon-url", `${proto}://${this.hostUrl}/assets/Playlist.png`);
    this.setOrDefault("data-vol-up-icon-url", `${proto}://${this.hostUrl}/assets/VolUp.png`);
    this.setOrDefault("data-vol-down-icon-url", `${proto}://${this.hostUrl}/assets/VolDown.png`);
    this.setOrDefault("data-mute-icon-url", `${proto}://${this.hostUrl}/assets/Mute.png`);
    this.setOrDefault("data-skip-forward-icon-url", `${proto}://${this.hostUrl}/assets/Forward.png`);
    this.setOrDefault("data-skip-backward-icon-url", `${proto}://${this.hostUrl}/assets/Backwards.png`);

    if(this.params.announce === 'true') { 
      // this.setupSayNamesScript();
    }
    if(window.isBanter) {
      // Populate window.user from the BanterScene's localUser identity.
      // This is the reliable source after unity-loaded, whereas window.user
      // may not be populated yet by the SDK on all platforms (e.g. Quest 3).
      try {
        const banterScene = BS.BanterScene.GetInstance();
        if (banterScene && banterScene.localUser) {
          window.user = {
            id: banterScene.localUser.uid,
            name: banterScene.localUser.name || "User"
          };
        }
      } catch (e) {
        console.warn('[Core] Could not get user from BanterScene:', e);
      }

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

      const proto = this.getProtocol();
      const playlistUrl = `${proto}://${this.hostUrl}/playlist/?instance=${this.params.instance}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}`;
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
  // Karaoke's Singers button and optional box trigger. Removed again by removeJoinLeaveButton()
  // when the player switches to playlist mode.
  setupJoinLeaveButton() {
    const scene = document.querySelector("a-scene");
    if(!scene) {
      console.log("No a-scene tag found, is this an AFRAME scene ?");
      return;
    }
    if (!this.playlistContainer) return;
    this.removeJoinLeaveButton();
    this.singerButtonElements = [];
    const playlistButton = document.createElement('a-entity');
    playlistButton.setAttribute('sq-boxcollider', 'size: 1 0.3 0.05');
    playlistButton.setAttribute('sq-interactable', '');
    const buttonGlb = document.createElement('a-entity');
    buttonGlb.setAttribute('gltf-model',`${this.getProtocol()}://${this.hostUrl}/assets/ButtonL.glb`);
    playlistButton.appendChild(buttonGlb);
    playlistButton.setAttribute('position', this.params["singer-button-position"]);
    playlistButton.setAttribute('rotation', this.params["singer-button-rotation"]);
    playlistButton.setAttribute('opacity', '0.3');
    playlistButton.setAttribute('transparent', 'true');
    this.playlistContainer.appendChild(playlistButton);
    this.singerButtonElements.push(playlistButton);
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
      this.singerButtonElements.push(boxTrigger);
    }
  }
  removeJoinLeaveButton() {
    (this.singerButtonElements || []).forEach(el => { if (el.parentNode) el.parentNode.removeChild(el); });
    this.singerButtonElements = [];
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
          background: `url(${this.getProtocol()}://${this.hostUrl}/assets/Button_bg.png) center center no-repeat`,
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
    const icon = this.setupButton(scene, playlistContainer, '-0.633', playlistIconUrl, () => this.openPlaylist(), buttonText);
    // Kept so the label can follow a mode change.
    this.playlistButtonText = icon && icon.parentNode ? icon.parentNode.querySelector('a-text') : null;
  }

  openPlaylist() {
    // Clicks can arrive twice in quick succession (pointer + trigger), so debounce.
    const now = Date.now();
    if (this._lastPlaylistToggle && now - this._lastPlaylistToggle < 600) return;
    this._lastPlaylistToggle = now;
    console.log(`[Core] Playlist button pressed (${this.playlistPanel ? 'toggling the in-world panel' : 'opening the menu page'}).`);

    // In-world UI Toolkit panel (new SDK), when one was set up for this player.
    if (this.playlistPanel) {
      this.playlistPanel.toggle();
      return;
    }
    this.openPlaylistPage();
  }

  getPlaylistPageUrl() {
    // Determine the mode ('karaoke' or 'playlist') based on the in-world script's setting.
    const mode = this.isKaraoke ? 'karaoke' : 'playlist';
    const playlistParam = this.params.playlist ? `&playlist=${this.params.playlist}` : "";
    // Pass the mode as a URL parameter so the UI page knows its context.
    const proto = this.getProtocol();
    return `${proto}://${this.hostUrl}/${mode}/?instance=${encodeURIComponent(this.params.instance)}${playlistParam}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}&mode=${mode}`;
  }

  // Opens the 2D playlist page in the client's menu browser.
  openPlaylistPage() {
    if (!window.user || !window.user.id) {
      console.warn('[Core] openPlaylist called but window.user is not set. Skipping.');
      return false;
    }
    return this.openPage(this.getPlaylistPageUrl());
  }

  // Old Banter exposed a global window.openPage. The new SideQuest/Altspace SDK only has
  // window.banter.openPage (legacy A-Frame bridge) and BanterScene.OpenPage().
  openPage(url) {
    try {
      if (typeof window.openPage === 'function') { console.log('[Core] Opening page with window.openPage:', url); window.openPage(url); return true; }
      if (window.banter && typeof window.banter.openPage === 'function') { console.log('[Core] Opening page with banter.openPage:', url); window.banter.openPage(url); return true; }
      if (window.BS && BS.BanterScene) {
        const scene = BS.BanterScene.GetInstance();
        if (scene && typeof scene.OpenPage === 'function') { console.log('[Core] Opening page with BanterScene.OpenPage:', url); scene.OpenPage(url); return true; }
      }
    } catch (e) {
      console.error('[Core] Failed to open page:', e);
      return false;
    }
    console.warn(`[Core] No openPage API available. Playlist URL: ${url}`);
    return false;
  }

  // "panel" = in-world UI Toolkit panel, "page" = 2D menu browser page,
  // "auto" = panel whenever the SDK has the UI system. (The SideQuest/Altspace client can define a
  // window.openPage that doesn't open anything, so its presence doesn't mean the page works.)
  shouldUsePlaylistPanel() {
    if (!window.isBanter) return false;
    const hasUi = !!(window.BS && (BS.UI || BS.BanterUI));
    const mode = String(this.params["playlist-ui"] || 'auto').toLowerCase();
    const use = mode === 'page' ? false : hasUi;
    console.log(`[Core] playlist-ui=${mode}, UI system ${hasUi ? 'found' : 'missing'}, window.openPage ${typeof window.openPage}: using the ${use ? 'in-world panel' : 'menu page'}.`);
    return use;
  }

  async setupPlaylistPanel() {
    try {
      if (typeof FirePlaylistPanel === 'undefined') {
        await this.setupScript(null, "playlist-panel");
      }
      console.log('[Core] Creating the in-world playlist panel.');
      this.playlistPanel = new FirePlaylistPanel(this);
      // Build in the background so the first click is quick. toggle() waits for it if needed.
      this.playlistPanel.build();
    } catch (e) {
      console.error('[Core] Could not create the in-world playlist panel, falling back to the page.', e);
      this.playlistPanel = null;
    }
  }

  // ---------------------------------------------------------------- mode (playlist / karaoke)
  //
  // The snippet (or script tag) picks the default mode. A space admin can switch it in world from
  // the panel; that choice is saved as protected space state, which only the world's owner, the
  // community's Owners and Moderators, and SideQuest admins can write (the server enforces it).
  // Everyone in the space follows it, and players who join later start in it. "default" means no
  // override. Space state lasts 24 hours after its last change, so after a quiet day the player
  // goes back to the snippet's mode.

  getMode() { return this.isKaraoke ? 'karaoke' : 'playlist'; }

  banterScene() {
    try { return (window.BS && BS.BanterScene) ? BS.BanterScene.GetInstance() : null; } catch (e) { return null; }
  }

  // Informational only (it can read false for a real admin); the server decides who may write.
  isSpaceAdmin() {
    const scene = this.banterScene();
    return !!(scene && scene.localUser && scene.localUser.isSpaceAdmin);
  }

  parseModeValue(value) {
    if (value && typeof value === 'object' && 'value' in value) value = value.value;
    const v = String(value == null ? '' : value).trim().replace(/^"|"$/g, '').toLowerCase();
    return v === 'karaoke' || v === 'playlist' ? v : null;
  }

  // The saved override from the local copy of the space state (protected values only).
  readModeOverride() {
    const scene = this.banterScene();
    if (!scene) return null;
    const json = scene.spaceStateJson && scene.spaceStateJson.protected;
    if (json && json[MODE_STATE_KEY] !== undefined) return this.parseModeValue(json[MODE_STATE_KEY]);
    const str = scene.spaceState && scene.spaceState.protected;
    return str ? this.parseModeValue(str[MODE_STATE_KEY]) : null;
  }

  // The override, asked of the server when the SDK can, so a player who has just arrived starts in
  // the right mode instead of switching a moment later.
  async loadModeOverride(timeoutMs = 4000) {
    const scene = this.banterScene();
    if (!scene) return null;
    if (typeof scene.SpaceStateGetAll === 'function') {
      try {
        const all = await Promise.race([
          scene.SpaceStateGetAll(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs))
        ]);
        if (all && all.protected) {
          const v = all.protected[MODE_STATE_KEY];
          return v === undefined ? this.readModeOverride() : this.parseModeValue(v);
        }
      } catch (e) {
        console.log(`[Core] Could not read the space state (${e && (e.code || e.message)}), using the local copy.`);
      }
    }
    return this.readModeOverride();
  }

  // Follows changes to the saved mode. Public writes to the same key are ignored, so only an
  // admin's choice counts.
  watchModeOverride() {
    const scene = this.banterScene();
    if (!scene || this.watchingMode) return;
    this.watchingMode = true;
    scene.On('space-state-changed', e => {
      const d = e && e.detail;
      const changes = Array.isArray(d) ? d : (d && Array.isArray(d.changes) ? d.changes : []);
      const c = changes.find(c => c && c.property === MODE_STATE_KEY);
      if (!c) return;
      const isPublic = c.isPublic === true || c.type === 'public';
      if (!isPublic) { clearTimeout(this.modeWriteTimer); this.modeWriteTimer = null; }
      const isProtected = c.isPublic === false || c.type === 'protected';
      if (isPublic) return;
      const override = isProtected ? this.parseModeValue(c.newValue) : this.readModeOverride();
      this.modeOverride = override;
      this.switchMode(override || this.defaultMode);
    });
    scene.On('space-state-error', e => {
      const d = (e && e.detail) || {};
      if (d.key !== MODE_STATE_KEY && d.path !== MODE_STATE_KEY) return;
      console.warn('[Core] Could not save the mode:', d.code, d.message);
      this.modeWriteRefused(d.code);
    });
  }

  // Saves the mode for everyone in the space ('karaoke', 'playlist', or null for the snippet's).
  // The change comes back through space-state-changed, which does the switch.
  // Anyone can press the button, since the client can't always tell who is a space admin
  // (isSpaceAdmin can read false for a real one). The server refuses other players' writes: that
  // may arrive as a space-state-error, or as nothing at all, so a switch that hasn't come back
  // after a few seconds is reported as refused too.
  setModeOverride(mode) {
    const scene = this.banterScene();
    if (!scene || typeof scene.SetProtectedSpaceProps !== 'function') return false;
    clearTimeout(this.modeWriteTimer);
    this.modeWriteTimer = setTimeout(() => this.modeWriteRefused(), MODE_WRITE_TIMEOUT_MS);
    scene.SetProtectedSpaceProps({ [MODE_STATE_KEY]: mode || 'default' });
    return true;
  }

  modeWriteRefused(code) {
    clearTimeout(this.modeWriteTimer);
    this.modeWriteTimer = null;
    const msg = code && code !== 'not_authorized'
      ? 'Could not change the mode.'
      : "The mode didn't change. Only space admins can switch it.";
    this.showToast(msg);
    if (this.playlistPanel) this.playlistPanel.setStatus(msg);
  }

  // Switches this player in place: the server room, the buttons, the panel and the video page.
  // Switches run one at a time, so quick changes can't interleave the panel rebuild.
  switchMode(mode) {
    const run = () => this._switchMode(mode).catch(e => console.error('[Core] Mode switch failed:', e));
    this.modeSwitch = (this.modeSwitch || Promise.resolve()).then(run, run);
    return this.modeSwitch;
  }

  async _switchMode(mode) {
    mode = mode === 'karaoke' ? 'karaoke' : 'playlist';
    if (mode === this.getMode()) {
      if (this.playlistPanel) this.playlistPanel.renderSoon();
      return;
    }
    const karaoke = mode === 'karaoke';
    console.log(`[Core] Switching to ${mode} mode.`);
    this.isKaraoke = karaoke;
    this.sendMessage({ path: Commands.SET_INSTANCE_MODE, data: mode });
    // The video page only uses the mode for its skip times, and every message to it carries the
    // mode (see sendBrowserMessage), so it needs no message of its own.
    if (this.playlistButtonText) this.playlistButtonText.setAttribute('value', karaoke ? 'Singers' : 'Playlist');
    if (karaoke) this.setupJoinLeaveButton();
    else this.removeJoinLeaveButton();
    if (this.playlistPanel) {
      // The panel's layout depends on the mode, so build a new one, open on the same view.
      const wasOpen = this.playlistPanel.visible;
      const view = this.playlistPanel.view;
      this.playlistPanel.destroy();
      this.playlistPanel = null;
      await this.setupPlaylistPanel();
      if (this.playlistPanel) this.playlistPanel.view = view;
      if (wasOpen && this.playlistPanel && this.getMode() === mode) {
        await this.playlistPanel.build();
        if (this.playlistPanel && !this.playlistPanel.failed) await this.playlistPanel.open();
      }
    }
    this.showToast(karaoke ? 'Switched to Karaoke mode' : 'Switched to Playlist mode');
  }

  // Lets other modules (e.g. the in-world playlist panel) observe server messages.
  addMessageListener(fn) {
    this.messageListeners = this.messageListeners || [];
    this.messageListeners.push(fn);
  }
  removeMessageListener(fn) {
    if (this.messageListeners) this.messageListeners = this.messageListeners.filter(f => f !== fn);
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
    if (!window.user || !window.user.id) {
      console.warn('[Core] setupHandControls called but window.user is not set. Skipping.');
      return;
    }
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
    const scene = document.querySelector("a-scene");
    if (!scene) {
      console.warn('[Core] No <a-scene> found, skipping hand controls. Add <a-scene></a-scene> to the world page.');
      return;
    }
    scene.appendChild(handControlsContainer);
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
    this.setOrDefault("captions", 'true');
    this.setOrDefault("untrusted-links", 'false');
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
    // In-world playlist panel (new SDK), in the same A-Frame units as "position"/"rotation".
    // playlist-panel-position places it in the world, and playlist-panel-rotation is then a world
    // rotation (empty = the screen's). Otherwise offset/rotation are relative to the screen, and an
    // empty offset puts it just right of the screen.
    this.setOrDefault("playlist-ui", 'auto');
    this.setOrDefault("playlist-panel-position", '');
    this.setOrDefault("playlist-panel-offset", '');
    this.setOrDefault("playlist-panel-rotation", '');
    this.setOrDefault("playlist-panel-scale", '1');

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
    // Closed captions, for this viewer only. The setting is the default; loadCaptionsPref() and
    // setCaptions() change it.
    this.captions = String(this.params.captions).toLowerCase() !== 'false';
    // Links from any site (video files, streams) besides YouTube, Twitch and Vimeo. Off unless the
    // world's owner turns it on, as those links aren't moderated.
    this.allowUntrusted = String(this.params["untrusted-links"]).toLowerCase() === 'true';
    if(this.params["one-for-each-instance"] === "true" && window.user && window.user.instance) {
        this.params.instance += window.user.instance;
    }
  }
  setOrDefault(attr, defaultValue) {
    const value = this.currentScript.getAttribute(attr);
    // A true/false setting from a snippet checkbox may come as "True"/"False", or empty when it's
    // unticked. Empty must mean false here, not the default, or unticking a box that's on by
    // default (spatial) would do nothing.
    if (defaultValue === 'true' || defaultValue === 'false') {
      const v = String(value == null ? '' : value).trim().toLowerCase();
      if (v === 'true' || v === 'false') { this.params[attr] = v; return; }
      if (value != null && v === '') { this.params[attr] = 'false'; return; }
    }
    this.params[attr] = value || (this.urlParams.has(attr) ? this.urlParams.get(attr) : defaultValue);
  }
  setupWebsocket(type, messageCallback, connectedCallback, closeCallback){
    return new Promise(resolve => {
      this.ws = new WebSocket(`${this.getWsProtocol()}://${this.hostUrl}/`);
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
  // Closed captions are per viewer: each person's screen is their own browser. The choice is
  // remembered on this device, over the snippet's captions setting.
  loadCaptionsPref() {
    try {
      const saved = localStorage.getItem(CAPTIONS_PREF_KEY);
      if (saved === 'true' || saved === 'false') this.captions = saved === 'true';
    } catch (e) {}
    return this.captions;
  }
  setCaptions(on) {
    this.captions = !!on;
    try { localStorage.setItem(CAPTIONS_PREF_KEY, String(this.captions)); } catch (e) {}
    Promise.resolve(this.sendBrowserMessage({ path: Commands.CAPTIONS, data: this.captions })).catch(() => {});
    this.showToast(this.captions ? 'Captions on' : 'Captions off');
  }
  sendBrowserMessage(msg){
    if(!window.isBanter) {
      return;
    }
    this.browserAcks = this.browserAcks || {};
    msg.u = window.user;
    msg.i = this.params.instance;
    msg.id = this.getUniquId();
    msg.km = !!this.isKaraoke; // the current mode, which can change in world
    msg.cc = this.captions !== false; // this viewer's closed captions setting
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
    let json;
    try { json = JSON.parse(msg); } catch { return; }
    switch(json.path) {
      case Commands.ERROR:
        // Show the server's reason (e.g. a link this world doesn't allow), not just that it refused.
        console.error((json.data && json.data.message) || (typeof json.data === 'string' && json.data) || "I can't let you do that...");
        break;
      case Commands.RESET_BROWSER:
        if(window.isBanter && this.browser) {
          // console.log("RESET_BROWSER", {"url": this.initialUrl});
          // The mode may have changed in world since the page first loaded.
          const url = String(this.initialUrl || '').replace(/([?&]mode=)[^&]*/, `$1${this.getMode()}`).replace(/([?&]captions=)[^&]*/, `$1${this.captions !== false}`);
          this.browser.setAttribute("sq-browser", {"url": url});
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
      // Karaoke: keep the singer queue in step, for the Singers panel and the box trigger.
      case Commands.SINGER_ADDED:
        if (this.player && json.data && json.data.player) {
          if (!Array.isArray(this.player.players)) this.player.players = [];
          if (!this.player.players.some(p => p.id === json.data.player.id)) this.player.players.push(json.data.player);
        }
        break;
      case Commands.SINGER_REMOVED:
        if (this.player && Array.isArray(this.player.players) && json.data) {
          this.player.players = this.player.players.filter(p => p.id !== json.data.userId);
        }
        break;
      case Commands.SINGER_MOVED:
        if (this.player && Array.isArray(this.player.players) && json.data) {
          const { oldIndex, newIndex } = json.data;
          const list = this.player.players;
          if (oldIndex >= 0 && oldIndex < list.length && newIndex >= 0 && newIndex < list.length) {
            const [moved] = list.splice(oldIndex, 1);
            list.splice(newIndex, 0, moved);
          } else {
            this.requestState();
          }
        }
        break;
      case Commands.AUTO_ADVANCE_STATE_CHANGED:
        if (this.player && json.data) this.player.autoAdvance = json.data.autoAdvance;
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
      // The following keep this.player complete so in-world UI (and host checks) stay accurate.
      case Commands.TRACK_CHANGED:
        if (this.player) {
          if (json.data.playlist) this.player.playlist = json.data.playlist;
          this.player.currentTrack = json.data.newTrackIndex;
          this.player.lastStartTime = json.data.newLastStartTime;
          this.player.currentTime = json.data.newCurrentTime || 0;
          // The server resumes playback when the track changes (skip, set track, auto-advance).
          this.player.paused = typeof json.data.paused === 'boolean' ? json.data.paused : false;
          this.fixTrackMismatch(this.player, json.data);
          const track = this.player.playlist && this.player.playlist[this.player.currentTrack];
          if (track) this.player.duration = track.duration / 1000;
        }
        break;
      case Commands.PLAYLIST_UPDATED:
        if (this.player) {
          this.player.playlist = json.data.playlist;
          this.player.currentTrack = json.data.currentTrack;
          // A Twitch video, file or stream gets its length once a player has loaded it.
          const current = this.player.playlist && this.player.playlist[this.player.currentTrack];
          if (current) this.player.duration = (current.duration || 0) / 1000;
        }
        break;
      case Commands.LOCK_STATE_CHANGED:
        if (this.player) this.player.locked = json.data.locked;
        break;
      case Commands.CAN_TAKE_OVER_STATE_CHANGED:
        if (this.player) this.player.canTakeOver = json.data.canTakeOver;
        break;
      case Commands.HOST_CHANGED:
        if (this.player) this.player.host = json.data.host;
        break;
      case Commands.VOTING_STATE_CHANGED:
        if (this.player) this.player.canVote = json.data.canVote;
        break;
      case Commands.HOST_SEEK:
        if (this.player) {
          this.player.lastStartTime = json.data.newLastStartTime;
          this.player.currentTime = json.data.newCurrentTime;
        }
        break;
    }
    if (this.messageListeners) {
      this.messageListeners.forEach(fn => {
        try { fn(json); } catch (e) { console.error('[Core] Message listener error:', e); }
      });
    }
  }
  // Asks the server for the whole player state again (it replies as on joining).
  // Returns false when not connected, as the socket then reconnects and refreshes by itself.
  requestState() {
    if (!this.connected()) return false;
    this.sendMessage({ path: Commands.REQUEST_STATE });
    return true;
  }
  // For a TRACK_CHANGED message: when the server's track isn't at that index in this copy
  // of the playlist, puts it there and asks for the full state, so the copy lines up again.
  // Returns true when the copy was out of date.
  fixTrackMismatch(state, data) {
    if (!state || !data || !data.track) return false;
    if (!Array.isArray(state.playlist)) state.playlist = [];
    const copy = state.playlist[data.newTrackIndex];
    if (copy && copy.link === data.track.link) return false;
    console.warn(`Playlist copy is out of date at track ${data.newTrackIndex}; refreshing from the server.`);
    state.playlist[data.newTrackIndex] = data.track;
    this.requestState();
    return true;
  }
  getId(url){
    if (!url) return false;
    url = url.trim();
    if (url.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(url)) {
      return url;
    }
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : false;
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
    // Optional third-party scripts (e.g. Toastify) must never block start-up,
    // so resolve on error or after a timeout as well as on load.
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", url);
      const timeout = setTimeout(() => {
        console.warn(`[Core] Timed out loading ${url}, continuing without it.`);
        resolve();
      }, 10000);
      myScript.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, false);
      myScript.addEventListener("error", () => {
        clearTimeout(timeout);
        console.warn(`[Core] Failed to load ${url}, continuing without it.`);
        resolve();
      }, false);
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
      myScript.setAttribute("src", `${this.getProtocol()}://${this.hostUrl}/${name}.js`);
      if(attrs) {
        Object.keys(attrs).forEach(k => {
          myScript.setAttribute(k, attrs[k]);
        })
      }
      myScript.addEventListener ("load", resolve, false);
      myScript.addEventListener ("error", () => {
        console.error(`[Core] Failed to load ${name}.js`);
        resolve();
      }, false);
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

    if (this.playlistPanel) {
      this.playlistPanel.destroy();
      this.playlistPanel = null;
    }

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