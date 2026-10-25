// Protected space state key holding a space admin's mode choice (see switchMode).
var MODE_STATE_KEY = 'fire-v-player-mode';
var MODE_WRITE_TIMEOUT_MS = 6000;
var CAPTIONS_PREF_KEY = 'fire-v-player-captions';
// SDK layers: clicks only reach colliders on UI (5). UserLayer9 (13) is ignored by teleport, the
// grapple and the ground, but players still touch it, which is what a trigger zone needs.
var LAYER_UI = 5;
var LAYER_TRIGGER = 13;
// The browser screen's page size. The SDK draws pages at 1300 pixels per metre, so this is
// 0.98 x 0.55 m before the screen's scale.
var SCREEN_PAGE_WIDTH = 1280;
var SCREEN_PAGE_HEIGHT = 720;

var Core = class {
    constructor() {
        this.urlParams = new URLSearchParams(window.location.search);
        this.isKaraoke = false;
        this.createdElements = [];
        // GameObjects made in the world, destroyed again by destroy().
        this.worldObjects = [];
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
      // Populate window.user from the scene's localUser identity.
      // This is the reliable source after unity-loaded, whereas window.user
      // may not be populated yet by the SDK on all platforms (e.g. Quest 3).
      try {
        const banterScene = this.banterScene();
        if (banterScene && banterScene.localUser) {
          window.user = {
            id: banterScene.localUser.uid,
            name: banterScene.localUser.name || "User"
          };
        }
      } catch (e) {
        console.warn('[Core] Could not get user from the scene:', e);
      }

      this.setupSpatial();
      // By the time this runs, window.user is already set by the entry-point script
      // (playlist.js / karaoke.js) which waited for bs-loaded + unity-loaded before
      // loading anything. No further waiting is needed here.
      if(this.params["hand-controls"] === 'true') {
        this.setupHandControls().catch(e => console.error('[Core] Could not set up the hand controls:', e));
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
  async setupBrowserElement(url) {
    this.initialUrl = url;
    if (!this.inWorld()) {
      console.log("Not in a world with the BS SDK. Creating a fallback 2D player.");
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
    try {
      await this.setupBrowserUi();
    } catch (e) {
      console.error('[Core] Could not create the in-world buttons:', e);
    }
    // The screen itself: the browser, or the world's video player when a file is playing.
    this.screenReady = true;
    this.updateScreen();
  }

  // ---------------------------------------------------------------- world objects (BS SDK)
  //
  // Everything in the world is a BS SDK GameObject. Script-tag positions and rotations use
  // A-Frame's axes, where Z is mirrored from Unity's (the player once ran on the A-Frame bridge,
  // and existing worlds still use those values), so they're converted here.

  inWorld() {
    return !!(window.isBanter && window.BS && BS.GameObject && this.banterScene());
  }
  vec3(str, def) {
    const p = String(str || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (p.length === 1 && !isNaN(p[0])) return [p[0], p[0], p[0]];
    return (p.length >= 3 && !p.slice(0, 3).some(isNaN)) ? p.slice(0, 3) : def;
  }
  toUnityPos([x, y, z]) { return new BS.Vector3(x, y, -z); }
  toUnityEuler([x, y, z]) { return new BS.Vector3(-x, -y, z); }
  toVector3([x, y, z]) { return new BS.Vector3(x, y, z); }
  // The screen's world position, rotation and scale, in Unity values.
  screenTransform() {
    return {
      position: this.toUnityPos(this.vec3(this.params.position, [0, 0, 0])),
      rotation: this.toUnityEuler(this.vec3(this.params.rotation, [0, 0, 0])),
      scale: this.toVector3(this.vec3(this.params.scale, [1, 1, 1]))
    };
  }

  // The SDK's components take a settings object (BS.Browser, BS.Plane, ...). Clients from before
  // it only have the Banter* versions, which take the same settings in order.
  modernSdk() {
    return !!BS.Scene && typeof BS.Browser === 'function';
  }
  bsComponent(name, settings, oldName, oldArgs) {
    if (this.modernSdk() && typeof BS[name] === 'function') return new BS[name](settings);
    if (typeof BS[oldName] === 'function') return new BS[oldName](...(oldArgs || []));
    throw new Error(`This client has neither BS.${name} nor BS.${oldName}.`);
  }
  async addComponent(go, component) {
    return (await go.AddComponent(component)) || component;
  }

  async makeObject(name, opts = {}) {
    const config = { name };
    if (opts.parent) config.parent = opts.parent;
    if (opts.position) config.localPosition = opts.position;
    if (opts.rotation) config.localEulerAngles = opts.rotation;
    if (opts.quaternion) config.localRotation = opts.quaternion;
    if (opts.scale) config.localScale = opts.scale;
    if (opts.layer !== undefined) config.layer = opts.layer;
    const go = await new BS.GameObject(config).Async();
    this.worldObjects.push(go);
    return go;
  }
  // Destroying an object destroys everything under it too.
  destroyObject(go) {
    if (!go) return;
    this.worldObjects = this.worldObjects.filter(o => o !== go);
    if (go.destroyed) return;
    try { go.Destroy(); } catch (e) { console.warn(`[Core] Could not destroy ${go.name}:`, e); }
  }

  white() { return new BS.Vector4(1, 1, 1, 1); }
  // A picture you click: a plane with the icon on it, and a thin collider on the UI layer.
  async makeIconButton(name, parent, position, size, iconUrl, callback, rotation) {
    const go = await this.makeObject(name, { parent, position, rotation, layer: LAYER_UI });
    const shader = 'Unlit/DiffuseTransparent';
    await this.addComponent(go, this.bsComponent('Plane', { width: size, height: size }, 'BanterPlane', [size, size]));
    await this.addComponent(go, this.bsComponent('Material', { shaderName: shader, texture: iconUrl, color: this.white() },
      'BanterMaterial', [shader, iconUrl, this.white(), 0, true]));
    await this.addColliderBox(go, new BS.Vector3(size, size, 0.01), true);
    go.On('click', () => callback());
    return go;
  }
  addColliderBox(go, size, isTrigger) {
    const center = new BS.Vector3(0, 0, 0);
    return this.addComponent(go, this.bsComponent('BoxCollider', { isTrigger, center, size }, 'BoxCollider', [isTrigger, center, size]));
  }
  // Text, centred on its object. It reads from the object's -Z side, like the buttons.
  async makeLabel(name, parent, position, text, fontSize) {
    const go = await this.makeObject(name, { parent, position });
    const center = 1; // BS.HorizontalAlignment.Center, BS.VerticalAlignment.Center
    const box = new BS.Vector2(2, 0.5);
    return this.addComponent(go, this.bsComponent('Text', {
      text, color: this.white(), fontSize, horizontalAlignment: center, verticalAlignment: center,
      richText: false, enableWordWrapping: false, rectTransformSizeDelta: box
    }, 'BanterText', [text, this.white(), center, center, fontSize, false, false, box]));
  }
  // --------------------------------------------------------------- screen (browser or native)
  // Video and audio files play on the world's own video player (native-video.js), which plays
  // links from hosts that won't let a web page load them. Only one of it and the browser exists at
  // a time: the other is destroyed, so it isn't running in the background.
  wantsNativeScreen(link) {
    if (!link || !window.isBanter || typeof FireNativeScreen === 'undefined' || !window.MediaSources) return false;
    if (!this.inWorld() || !(BS.VideoPlayer || BS.BanterVideoPlayer)) return false;
    // Files come from anywhere, so only where the world's owner allows them (as in the browser).
    const media = MediaSources.detect(link);
    return !!media && media.type === 'file' && this.allowUntrusted === true;
  }
  currentLink() {
    const p = this.player;
    const track = p && Array.isArray(p.playlist) && p.playlist.length ? p.playlist[p.currentTrack] : null;
    return track && track.link ? track.link : '';
  }
  // The browser page's address, with the mode and captions as they are now.
  browserUrl() {
    return String(this.initialUrl || '').replace(/([?&]mode=)[^&]*/, `$1${this.getMode()}`).replace(/([?&]captions=)[^&]*/, `$1${this.captions !== false}`);
  }
  // Puts up whichever screen the current track needs. `json` is the message that changed things.
  updateScreen(json) {
    if (!this.screenReady) return;
    const link = this.currentLink();
    const path = json && json.path;
    if (this.wantsNativeScreen(link)) {
      if (this.nativeScreen && this.nativeScreen.link === link) {
        // The same file again (a restart, a one-song playlist), or the host moved it.
        if (path === Commands.TRACK_CHANGED || path === Commands.HOST_SEEK) this.nativeScreen.resync();
        return;
      }
      this.removeBrowser();
      if (this.nativeScreen) this.nativeScreen.destroy();
      console.log('[Core] A file is playing, so the world\'s video player takes the browser\'s place.');
      this.nativeScreen = new FireNativeScreen(this, link);
      return;
    }
    if (this.nativeScreen) {
      console.log('[Core] Back to the browser screen.');
      this.nativeScreen.destroy();
      this.nativeScreen = null;
    }
    if (!this.browser) this.createBrowser(this.browserUrl());
  }
  removeBrowser() {
    const browser = this.browser;
    if (!browser) return;
    // A screen still being built destroys itself when it sees this.
    browser.removed = true;
    this.destroyObject(browser.go);
    this.browser = null;
    // Messages still waiting for the old page will never be answered.
    this.browserAcks = {};
  }
  // The screen: a BS Browser showing the player page. It's built in the background; actions sent
  // before it's ready wait in `queue`.
  createBrowser(url) {
    const browser = this.browser = { url, go: null, component: null, queue: [], removed: false };
    browser.ready = this.buildBrowser(browser).catch(e => {
      console.error('[Core] Could not create the browser screen:', e);
      this.showToast("Couldn't create the screen.", 6000);
    });
  }
  async buildBrowser(browser) {
    const p = this.params;
    const t = this.screenTransform();
    const go = browser.go = await this.makeObject('FireVPlayer_Screen', { position: t.position, rotation: t.rotation, scale: t.scale, layer: LAYER_UI });
    if (browser.removed) { this.destroyObject(go); return; }
    go.On('browser-message', e => this.onBrowserMessage(e));
    const url = browser.url;
    const ppu = Number(p.resolution);
    const component = await this.addComponent(go, this.bsComponent('Browser',
      { url, pageWidth: SCREEN_PAGE_WIDTH, pageHeight: SCREEN_PAGE_HEIGHT, mipMaps: p['mip-maps'], pixelsPerUnit: ppu },
      'BanterBrowser', [url, p['mip-maps'], ppu, SCREEN_PAGE_WIDTH, SCREEN_PAGE_HEIGHT, null]));
    if (browser.removed) { this.destroyObject(go); return; }
    browser.component = component;
    if (typeof component.ToggleInteraction === 'function') component.ToggleInteraction(true);
    // The address may have changed while the screen was being made.
    if (browser.url !== url) component.url = browser.url;
    browser.queue.splice(0).forEach(json => component.RunActions(json));
    if (p.geometry && p.geometry !== "false") await this.addScreenShape(go);
  }
  // The optional `geometry` setting: a white shape at the screen, in A-Frame's geometry syntax
  // ("primitive: box; width: 1.1; height: 0.6; depth: 0.05").
  async addScreenShape(parent) {
    const g = {};
    String(this.params.geometry).split(';').forEach(part => {
      const i = part.indexOf(':');
      if (i > 0) g[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    });
    const n = (key, def) => Number.isFinite(parseFloat(g[key])) ? parseFloat(g[key]) : def;
    const shapes = {
      box: ['Box', { width: n('width', 1), height: n('height', 1), depth: n('depth', 1) }],
      plane: ['Plane', { width: n('width', 1), height: n('height', 1) }],
      sphere: ['Sphere', { radius: n('radius', 1) }],
      cylinder: ['Cylinder', { radiusTop: n('radius', 1), radiusBottom: n('radius', 1), height: n('height', 1) }]
    };
    const shape = shapes[String(g.primitive || 'box').toLowerCase()];
    if (!shape || !this.modernSdk() || typeof BS[shape[0]] !== 'function') {
      console.warn(`[Core] Can't make the geometry "${this.params.geometry}" in this client.`);
      return;
    }
    const go = await this.makeObject('FireVPlayer_ScreenShape', { parent });
    await this.addComponent(go, new BS[shape[0]](shape[1]));
    await this.addComponent(go, new BS.Material({ shaderName: 'Unlit/Diffuse', color: this.white() }));
  }
  // Runs BS Browser actions on the screen. False when there is no browser screen.
  runBrowserActions(actions) {
    const browser = this.browser;
    if (!browser) return false;
    const json = JSON.stringify({ actions });
    if (browser.component) browser.component.RunActions(json);
    else browser.queue.push(json);
    return true;
  }
  // Loads an address on the screen. Setting the same address again reloads the page.
  setBrowserUrl(url) {
    const browser = this.browser;
    if (!browser) return;
    browser.url = url;
    if (browser.component) browser.component.url = url;
  }
  // Messages from the screen's page (window.O.sendMessage), such as the answer to a volume change.
  onBrowserMessage(e) {
    let msg = e && e.detail;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch { return; }
    }
    if (msg && typeof msg === 'object') this.recieveBrowserMessage(msg);
  }
  clickBrowser(x,y) {
    // No browser while the world's video player is up instead.
    this.runBrowserActions([{actionType: "click2d", numParam1: x, numParam2: y}]);
  }
  // The row of buttons under the screen: Playlist (Singers), skip back/forward, mute, volume.
  async setupBrowserUi() {
    const p = this.params;
    const screenPos = this.vec3(p.position, [0, 0, 0]);
    const yScale = this.vec3(p.scale, [1, 1, 1])[1];
    const under = [screenPos[0], screenPos[1] - yScale * 0.335, screenPos[2]];
    const position = p["button-position"] === "0 0 0" ? under : this.vec3(p["button-position"], under);
    const rotation = this.vec3(p["button-rotation"] === "0 0 0" ? p.rotation : p["button-rotation"], [0, 0, 0]);
    this.playlistContainer = await this.makeObject('FireVPlayer_Buttons', {
      position: this.toUnityPos(position),
      rotation: this.toUnityEuler(rotation),
      scale: this.toVector3(this.vec3(p["button-scale"], [1, 1, 1]))
    });
    await this.setupPlaylistButton(this.playlistContainer);
    await this.setupVolButton(true, this.playlistContainer);
    await this.setupVolButton(false, this.playlistContainer);
    await this.setupMuteButton(this.playlistContainer);
    await this.setupSkipButton(true, this.playlistContainer);
    await this.setupSkipButton(false, this.playlistContainer);
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
  async setupJoinLeaveButton() {
    if (!this.playlistContainer || !this.inWorld()) return;
    this.removeJoinLeaveButton();
    // removeJoinLeaveButton() during the build replaces the token, and the build then cleans up.
    const token = this.singerToken = {};
    const made = this.singerButtonElements = [];
    const alive = () => {
      if (token === this.singerToken) return true;
      made.forEach(go => this.destroyObject(go));
      return false;
    };
    const p = this.params;
    const button = await this.makeObject('FireVPlayer_SingerButton', {
      parent: p["singer-button-space"] === 'world' ? null : this.playlistContainer,
      position: this.toUnityPos(this.vec3(p["singer-button-position"], [0, 0, 0])),
      rotation: this.toUnityEuler(this.vec3(p["singer-button-rotation"], [0, 0, 0])),
      layer: LAYER_UI
    });
    made.push(button);
    if (!alive()) return;
    const glb = `${this.getProtocol()}://${this.hostUrl}/assets/ButtonL.glb`;
    // legacyRotate: the model was made for the A-Frame bridge, which faced models the other way.
    await this.addComponent(button, this.bsComponent('GLTF', { url: glb, legacyRotate: true },
      'BanterGLTF', [glb, false, false, false, false, false, true]));
    await this.addColliderBox(button, new BS.Vector3(1, 0.3, 0.05), true);
    button.On('click', () => this.openPlaylist());
    if (!alive()) return;
    await this.makeLabel('FireVPlayer_SingerButtonText', button, new BS.Vector3(0, 0.01, -0.03), 'singers', 1);
    if (!alive()) return;

    const triggerEnter = p["box-trigger-enter-enabled"] === "true";
    const triggerExit = p["box-trigger-exit-enabled"] === "true";
    if (triggerEnter || triggerExit) {
      const boxTrigger = await this.makeObject('FireVPlayer_BoxTrigger', {
        parent: this.playlistContainer,
        position: this.toUnityPos(this.vec3(p["box-trigger-position"], [0, 0, 0])),
        rotation: this.toUnityEuler(this.vec3(p["box-trigger-rotation"], [0, 0, 0])),
        scale: this.toVector3(this.vec3(p["box-trigger-scale"], [1, 1, 1])),
        layer: LAYER_TRIGGER
      });
      made.push(boxTrigger);
      if (!alive()) return;
      await this.addColliderBox(boxTrigger, new BS.Vector3(1, 1, 1), true);
      // ColliderEvents sends the trigger's contacts to the page.
      if (this.modernSdk() && typeof BS.ColliderEvents === 'function') await this.addComponent(boxTrigger, new BS.ColliderEvents());
      else if (typeof BS.BanterColliderEvents === 'function') await this.addComponent(boxTrigger, new BS.BanterColliderEvents());
      if (!alive()) return;
      this.watchBoxTrigger(boxTrigger, triggerEnter, triggerExit);
    }
  }
  // The local player's body, head, hands and feet each enter and leave the trigger, so they count
  // as inside until the last part has left.
  watchBoxTrigger(boxTrigger, triggerEnter, triggerExit) {
    const inside = new Set();
    const isLocal = d => {
      const user = d && d.user;
      if (!user) return false;
      const scene = this.banterScene();
      return user.isLocal === true || !!(scene && scene.localUser && user.uid === scene.localUser.uid);
    };
    const part = d => {
      const c = d.collider;
      return String(c && typeof c === 'object' ? (c.id || c.name) : (c != null ? c : d.name));
    };
    let hasStarted = false;
    let hasStartedTimeout;
    boxTrigger.On('trigger-enter', e => {
      const d = e && e.detail;
      if (!isLocal(d)) return;
      const wasOutside = inside.size === 0;
      inside.add(part(d));
      if (!wasOutside) return;
      clearTimeout(hasStartedTimeout);
      if(triggerEnter && this.player && this.player.players && this.player.players.length && this.player.players[0].id === window.user.id && !hasStarted) {
        if(this.player.locked) {
          this.showToast("Player is locked! The host needs to unlock it first!");
        }else{
          this.sendMessage({path: Commands.ADD_TO_PLAYLIST, data: this.player.players[0].v, isYoutubeWebsite: false, skipUpdate: true });
          this.sendMessage({path: Commands.SET_TRACK, data: 0});
          hasStarted = true;
        }
      }
    });
    boxTrigger.On('trigger-exit', e => {
      const d = e && e.detail;
      if (!isLocal(d)) return;
      inside.delete(part(d));
      if (inside.size > 0) return;
      clearTimeout(hasStartedTimeout);
      hasStartedTimeout = setTimeout(() => {
        if(triggerExit && this.player && this.player.players && this.player.players.length && hasStarted) {
          const player = this.player.players[0];
          if(player.id === window.user.id) {
              this.sendMessage({path: Commands.REMOVE_FROM_PLAYERS, data: player.id });
              this.sendMessage({path: Commands.STOP});
              hasStarted = false;
          }
        }
      }, 5000);
    });
  }
  removeJoinLeaveButton() {
    this.singerToken = null;
    (this.singerButtonElements || []).forEach(go => this.destroyObject(go));
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
  async setupPlaylistButton(playlistContainer) {
    const playlistIconUrl = this.params["data-playlist-icon-url"];
    // Use the isKaraoke flag to provide a context-specific text label
    const buttonText = this.isKaraoke ? 'Singers' : 'Playlist';
    const button = await this.setupButton(playlistContainer, 'Playlist', -0.633, playlistIconUrl, () => this.openPlaylist(), buttonText);
    // Kept so the label can follow a mode change.
    this.playlistButtonText = button.label;
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

  // Old Banter exposed a global window.openPage. Some clients have window.banter.openPage or the
  // scene's OpenPage() instead.
  openPage(url) {
    try {
      if (typeof window.openPage === 'function') { console.log('[Core] Opening page with window.openPage:', url); window.openPage(url); return true; }
      if (window.banter && typeof window.banter.openPage === 'function') { console.log('[Core] Opening page with banter.openPage:', url); window.banter.openPage(url); return true; }
      const scene = this.banterScene();
      if (scene && typeof scene.OpenPage === 'function') { console.log('[Core] Opening page with the scene\'s OpenPage:', url); scene.OpenPage(url); return true; }
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
    // BS.Scene in the current SDK, BS.BanterScene in older clients.
    try {
      const Scene = window.BS && (BS.Scene || BS.BanterScene);
      return Scene ? Scene.GetInstance() : null;
    } catch (e) { return null; }
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
    if (this.playlistButtonText) this.playlistButtonText.text = karaoke ? 'Singers' : 'Playlist';
    if (karaoke) this.setupJoinLeaveButton().catch(e => console.error('[Core] Could not create the Singers button:', e));
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
  setupVolButton(isUp, playlistContainer) {
    const volIconUrl = isUp ? this.params["data-vol-up-icon-url"] : this.params["data-vol-down-icon-url"];
    return this.setupButton(playlistContainer, isUp ? 'VolumeUp' : 'VolumeDown', isUp ? 0.693 : 0.471, volIconUrl, () => this.volume(isUp));
  }
  setupSkipButton(isBack, playlistContainer) {
    const skipIconUrl = isBack ? this.params["data-skip-backward-icon-url"] : this.params["data-skip-forward-icon-url"];
    return this.setupButton(playlistContainer, isBack ? 'SkipBack' : 'SkipForward', isBack ? -0.332 : -0.081, skipIconUrl, () => (isBack ? this.back() : this.forward()));
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
  setupMuteButton(playlistContainer) {
    const muteIconUrl = this.params["data-mute-icon-url"]; // URL for the mute button icon
    return this.setupButton(playlistContainer, 'Mute', 0.23, muteIconUrl, () => this.mute());
  }

  // ---------------------------------------------------------------- spatial volume
  // With `spatial` on, the volume fades with the local player's distance from the screen. The
  // SDK sends the head's world position as pose-update, only while the player moves.
  setupSpatial() {
    const scene = this.banterScene();
    if (!scene || this.params.spatial !== 'true' || this.onPoseUpdate) return;
    const p = this.vec3(this.params.position, [0, 0, 0]);
    const screen = { x: p[0], y: p[1], z: -p[2] }; // in Unity's axes, like the head
    let lastSendTime = Date.now();
    this.onPoseUpdate = e => {
      const head = e && e.detail && e.detail.head;
      if (!head || !head.position) return;
      const now = Date.now();
      if (now - lastSendTime <= 500) return;
      lastSendTime = now;
      const minDistance = Number(this.params["spatial-min-distance"]);
      const maxDistance = Number(this.params["spatial-max-distance"]);
      const a = head.position.x - screen.x;
      const b = head.position.y - screen.y;
      const c = head.position.z - screen.z;
      const distance = Math.sqrt(a * a + b * b + c * c);
      const volume = Math.max(0, Math.min(1, (maxDistance - (distance - minDistance)) / maxDistance));
      const roundedVolume = Math.round(this.params.volume * volume);
      if(this.tempVolume != roundedVolume) {
        // Rejected while there's no screen yet, which is fine: the next pose tries again.
        Promise.resolve(this.sendBrowserMessage({path: Commands.SET_VOLUME, data: roundedVolume, type: 'spatial'}))
          .catch(() => {});
      }
      this.tempVolume = roundedVolume;
    };
    scene.On('pose-update', this.onPoseUpdate);
  }

  // ---------------------------------------------------------------- hand controls
  // A small panel of buttons on the local player's left hand, laid out as in FireScreen v2.
  // This was a great innovation by HBR, who wanted Skizot to also get credit for the original idea.
  // The SDK drops attachments when the player leaves, so they're made again when they come back.
  async setupHandControls() {
    const scene = this.banterScene();
    if (!scene || !this.inWorld()) {
      console.warn('[Core] Not in a world with the BS SDK, so no hand controls.');
      return;
    }
    if (!this.watchingHandUser) {
      this.watchingHandUser = true;
      this.onHandUserLeft = e => { if (e && e.detail && e.detail.isLocal) this.removeHandControls(); };
      // user-joined also fires for the local player on arrival, when the controls already exist.
      this.onHandUserJoined = e => {
        if (!(e && e.detail && e.detail.isLocal) || this.handControls || this.handControlsBuilding) return;
        // Wait a moment after joining before attaching, which avoids a race on Quest.
        setTimeout(() => this.setupHandControls().catch(err => console.error('[Core] Could not set up the hand controls:', err)), 5000);
      };
      scene.On('user-left', this.onHandUserLeft);
      scene.On('user-joined', this.onHandUserJoined);
    }
    if (this.handControls || this.handControlsBuilding) return;
    const uid = (scene.localUser && scene.localUser.uid) || (window.user && window.user.id);
    if (!uid || typeof scene.LegacyAttachObject !== 'function') {
      console.warn('[Core] The local player or LegacyAttachObject is missing, so no hand controls.');
      return;
    }
    this.handControlsBuilding = true;
    try {
      const root = await this.makeObject('FireVPlayer_HandControls');
      this.handControls = root;
      const Quaternion = BS.Quaternion || BS.Vector4;
      const wrapper = await this.makeObject('FireVPlayer_HandWrapper', {
        parent: root,
        position: new BS.Vector3(0, 0.046, 0.030),
        quaternion: new Quaternion(0.25, 0, 0.8, 1),
        scale: new BS.Vector3(0.1, 0.1, 0.1)
      });
      const flip = new BS.Vector3(180, 0, 0);
      const buttons = [
        ['Mute', -0.4, 0.4, "data-mute-icon-url", () => this.mute()],
        ['VolumeDown', 0, 0.4, "data-vol-down-icon-url", () => this.volume(false)],
        ['VolumeUp', 0.4, 0.4, "data-vol-up-icon-url", () => this.volume(true)],
        ['SkipBack', -0.4, -0.1, "data-skip-backward-icon-url", () => this.sendBrowserMessage({path: Commands.SKIP_BACK})],
        ['SkipForward', 0, -0.1, "data-skip-forward-icon-url", () => this.sendBrowserMessage({path: Commands.SKIP_FORWARD})],
        ['Playlist', 0.4, -0.1, "data-playlist-icon-url", () => this.openPlaylist()]
      ];
      for (const [name, x, y, icon, callback] of buttons) {
        if (root !== this.handControls) return; // removed meanwhile
        await this.makeIconButton(`FireVPlayer_Hand${name}`, wrapper, new BS.Vector3(x, y, 0.3), 0.4, this.params[icon], () => {
          Promise.resolve(callback()).catch(() => {});
        }, flip);
      }
      if (root !== this.handControls) return; // removed meanwhile
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (root !== this.handControls) return;
      const leftHand = BS.LegacyAttachmentPosition ? BS.LegacyAttachmentPosition.LEFT_HAND : 1;
      await scene.LegacyAttachObject(root, uid, leftHand);
      console.log('[Core] Hand controls attached to the left hand.');
    } finally {
      this.handControlsBuilding = false;
    }
  }
  removeHandControls() {
    if (!this.handControls) return;
    console.log('[Core] Removing the hand controls.');
    this.destroyObject(this.handControls);
    this.handControls = null;
  }

  // One of the buttons under the screen, with an optional label below it.
  async setupButton(playlistContainer, name, xOffset, iconUrl, callback, text) {
    const holder = await this.makeObject(`FireVPlayer_Button${name}`, { parent: playlistContainer, position: new BS.Vector3(xOffset, 0, 0) });
    await this.makeIconButton(`FireVPlayer_Button${name}Icon`, holder, new BS.Vector3(0, 0, 0), 0.2, iconUrl, callback);
    // Just in front of the icon (toward -Z, the side it's seen from), below it.
    const label = text ? await this.makeLabel(`FireVPlayer_Button${name}Text`, holder, new BS.Vector3(0, -0.15, -0.005), text, 0.35) : null;
    return { holder, label };
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
    // "world": the singer button's position and rotation are world values (set by snippet.js),
    // not offsets from the buttons.
    this.setOrDefault("singer-button-space", "");
    this.setOrDefault("button-position", `0 0 0`);
    this.setOrDefault("button-rotation", `0 0 0`);
    this.setOrDefault("button-scale", `1 1 1`);
    this.setOrDefault("box-trigger-enter-enabled", 'false');
    this.setOrDefault("box-trigger-exit-enabled", 'false');
    this.setOrDefault("box-trigger-position", '0 0 0');
    this.setOrDefault("box-trigger-rotation", '0 0 0');
    this.setOrDefault("box-trigger-scale", '1 1 1');
    this.setOrDefault("resolution", '1600');
    // The world video player's size for files (native-video.js); empty matches the browser.
    this.setOrDefault("native-screen-size", '');
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
    if(msg.id && this.browserAcks && this.browserAcks[msg.id]) {
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
    // While a file plays on the world's video player there is no browser page: it takes these.
    if (this.nativeScreen) {
      this.nativeScreen.handle(msg);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if(this.browser) {
        this.browserAcks[msg.id] = resolve;
        this.runBrowserActions([{actionType: "postmessage", strParam1: JSON.stringify(msg)}]);
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
          this.setBrowserUrl(this.browserUrl());
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
          this.setBrowserUrl(json.data.link);
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
    // A file track needs the world's video player in place of the browser, and back again after.
    try { this.updateScreen(json); } catch (e) { console.error('[Core] Could not switch screens:', e); }
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
    this.removeJoinLeaveButton();

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

    if (this.nativeScreen) {
      this.nativeScreen.destroy();
      this.nativeScreen = null;
    }
    this.screenReady = false;

    // The world's objects: the screen, buttons, hand controls and anything else made here.
    this.removeBrowser();
    this.removeHandControls();
    this.worldObjects.slice().forEach(go => this.destroyObject(go));
    this.worldObjects = [];
    const scene = this.banterScene();
    if (scene && typeof scene.Off === 'function') {
      if (this.onPoseUpdate) scene.Off('pose-update', this.onPoseUpdate);
      if (this.onHandUserLeft) scene.Off('user-left', this.onHandUserLeft);
      if (this.onHandUserJoined) scene.Off('user-joined', this.onHandUserJoined);
    }
    this.onPoseUpdate = this.onHandUserLeft = this.onHandUserJoined = null;
    this.watchingHandUser = false;
    console.log("Removed the world's objects.");

    // Remove any global references to this instance
    this.browser = null;
    this.playlistContainer = null;
    this.playlistButtonText = null;
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