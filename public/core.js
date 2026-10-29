// Protected space state key holding a space admin's mode choice (see switchMode).
var MODE_STATE_KEY = 'fire-v-player-mode';
var MODE_WRITE_TIMEOUT_MS = 6000;
// Protected space state key a space admin writes to take control of the player (see adminTakeOver).
var ADMIN_STATE_KEY = 'fire-v-player-admin';
// While blacklisted, how often the full volume is put back (in case the page reloaded).
var BLOCKED_VOLUME_MS = 5000;
var CAPTIONS_PREF_KEY = 'fire-v-player-captions';
// SDK layers: clicks only reach colliders on UI (5). UserLayer9 (13) is ignored by teleport, the
// grapple and the ground, but players still touch it, which is what a trigger zone needs.
var LAYER_UI = 5;
var LAYER_TRIGGER = 13;
// The browser screen. Its page is `resolution` pixels wide and 16:9. The SDK draws pages at 1300
// pixels per metre, so the screen object is scaled to keep it SCREEN_WIDTH_M wide (before the
// snippet's scale) whatever the resolution.
var SCREEN_PIXELS_PER_M = 1300;
var SCREEN_WIDTH_M = 1;
var SCREEN_MIN_RESOLUTION = 640;
var SCREEN_MAX_RESOLUTION = 3840;
// The choices in the panel's More view, as page widths.
var SCREEN_RESOLUTIONS = [1280, 1600, 1920];
var RESOLUTION_PREF_KEY = 'fire-v-player-resolution';
// Where each viewer keeps their hand controls (see HAND_PLACES), remembered on their device.
var HAND_PLACE_PREF_KEY = 'fire-v-player-hand-place';
// The places the hand controls can go, in the order the panel's button steps through them.
// attach is the SDK's LegacyAttachmentPosition (HEAD 0, LEFT_HAND 2, RIGHT_HAND 3); position and
// rotation are in that attachment's own Unity axes. On a hand, -X is the back of the left hand
// (+X the right's) and Z runs toward the fingers. "front" isn't attached: it's put in the world
// in front of the player when chosen.
var HAND_PLACES = {
  left: { label: 'Left Wrist', attach: 2, position: [0, 0.046, 0.07], rotation: [0, 90, 180], scale: 0.1 },
  right: { label: 'Right Wrist', attach: 3, position: [0, 0.046, 0.07], rotation: [0, 270, 180], scale: 0.1 },
  // The bottom right of what the player sees, for desktop players, whose hands don't turn.
  view: { label: 'In View', attach: 0, position: [0.2, -0.16, 0.5], rotation: [0, 0, 0], scale: 0.1 },
  front: { label: 'In Front', scale: 0.15 },
  off: { label: 'Off' }
};
// Altspace (Creator SDK) space-page screen, see claimSpaceSurface. The client keeps this asset
// reference pointed at the space page's own browser texture.
var SPACE_BROWSER_TEXTURE = 'asset_browser_world';
// The wire command for sizing the space page, for clients without scene.SetWorldBrowserSize.
var SET_WORLD_BROWSER_SIZE = '!swbs!';
// How long a size request may take to show up as the space page's own window size.
var SPACE_SIZE_CONFIRM_MS = 5000;
// Set to -1 to mirror the space-page screen, if a client draws the page's texture flipped.
var SURFACE_FLIP_X = 1;
var SURFACE_FLIP_Y = 1;
// A BS Material in the world's Unity scene whose Texture is "Fire-V-Player" (in any case) shows
// the screen as well. See syncSecondScreens.
var SECOND_SCREEN_TEXTURE = 'fire-v-player';

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
    this.setOrDefault("data-reload-icon-url", `${proto}://${this.hostUrl}/assets/Reload.png`);
    this.setOrDefault("data-unmute-icon-url", `${proto}://${this.hostUrl}/assets/Unmute.png`);
    this.setOrDefault("data-play-icon-url", `${proto}://${this.hostUrl}/assets/Play.png`);
    this.setOrDefault("data-pause-icon-url", `${proto}://${this.hostUrl}/assets/Pause.png`);

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
      this.trackHead();
      this.setupHeadMarker().catch(e => console.warn('[Core] Could not follow the head:', e));
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
    // In Altspace the screen can be the space page's own browser (see claimSpaceSurface). Finding
    // out can take a few seconds, so it runs while the buttons are made.
    const claim = this.spaceSurface ? Promise.resolve() : this.claimSpaceSurface().catch(e => {
      console.warn('[Core] Could not use the space page as the screen:', e);
      this.releaseSpaceSurface();
    });
    try {
      await this.setupBrowserUi();
    } catch (e) {
      console.error('[Core] Could not create the in-world buttons:', e);
    }
    await claim;
    if (this.destroyed) return; // cleaned up while the buttons were being made
    // The screen itself: the browser, or the world's video player when a file is playing.
    this.screenReady = true;
    this.updateScreen();
    // Second screens in the Unity scene may still be loading, or come later: keep looking.
    // A scan with nothing to change touches nothing.
    if (!this.secondScreenTimer) {
      this.secondScreenTimer = setInterval(() => { if (!this.destroyed) this.syncSecondScreens(); }, 5000);
    }
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
    // Cleaned up while this was being made: don't leave it in the world, and stop the build.
    if (this.destroyed) {
      try { go.Destroy(); } catch (e) {}
      throw new Error('The player was removed.');
    }
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
    const go = await this.makeImage(name, parent, position, size, size, iconUrl, { rotation, layer: LAYER_UI });
    await this.addColliderBox(go, new BS.Vector3(size, size, 0.01), true);
    go.On('click', () => { if (!this.blocked) callback(); });
    return go;
  }
  // A flat picture, seen from -Z. Words are pictures too (assets/*Label.png): the world's own
  // text shows as pink blocks on some clients.
  async makeImage(name, parent, position, width, height, url, opts = {}) {
    const go = await this.makeObject(name, { parent, position, rotation: opts.rotation, layer: opts.layer });
    if (opts.made) opts.made.push(go);
    const shader = 'Unlit/DiffuseTransparent';
    await this.addComponent(go, this.bsComponent('Plane', { width, height }, 'BanterPlane', [width, height]));
    await this.addComponent(go, this.bsComponent('Material', { shaderName: shader, texture: url, color: this.white() },
      'BanterMaterial', [shader, url, this.white(), 0, true]));
    return go;
  }
  assetUrl(file) { return `${this.getProtocol()}://${this.hostUrl}/assets/${file}`; }
  /**
   * Adds a box collider component to a GameObject.
   * @param {Object} go - Banter GameObject.
   * @param {Object} size - Box collider dimensions.
   * @param {boolean} isTrigger - Whether collider acts as a trigger.
   * @returns {Promise<Object>}
   */
  addColliderBox(go, size, isTrigger) {
    const center = new BS.Vector3(0, 0, 0);
    return this.addComponent(go, this.bsComponent('BoxCollider', { isTrigger, center, size }, 'BoxCollider', [isTrigger, center, size]));
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
  // Twitch won't start until someone clicks its player, and the space-page screen can't be clicked
  // (it's a picture of a page nobody can reach), so Twitch gets a BS Browser screen, as on clients
  // without the space page.
  needsClickableScreen(link) {
    const media = link && window.MediaSources ? MediaSources.detect(link) : null;
    return !!media && (media.type === 'twitch' || media.type === 'twitchclip');
  }
  currentLink() {
    const p = this.player;
    const track = p && Array.isArray(p.playlist) && p.playlist.length ? p.playlist[p.currentTrack] : null;
    return track && track.link ? track.link : '';
  }
  // The browser page's address, with the mode, captions, mute and volume as they are now.
  browserUrl() {
    const volume = this.params.spatial === 'true' ? this.tempVolume : this.params.volume;
    return String(this.initialUrl || '')
      .replace(/([?&]mode=)[^&]*/, `$1${this.getMode()}`)
      .replace(/([?&]captions=)[^&]*/, `$1${this.captions !== false}`)
      .replace(/([?&]mute=)[^&]*/, `$1${this.params.mute}`)
      .replace(/([?&]volume=)[^&]*/, `$1${volume}`);
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
      this.syncSecondScreens();
      return;
    }
    if (this.nativeScreen) {
      console.log('[Core] Back to the browser screen.');
      this.nativeScreen.destroy();
      this.nativeScreen = null;
    }
    // The space page when this player has it, unless the track needs clicking.
    const surface = this.spaceSurface && !this.needsClickableScreen(link) ? this.spaceSurface : null;
    if (this.browser && (this.browser.surface || null) !== surface) {
      console.log(surface ? '[Core] Back to the space-page screen.' : '[Core] This needs clicking, so the screen is a browser for now.');
      this.removeBrowser();
    }
    if (!this.browser) this.createBrowser(this.browserUrl(), surface);
  }
  // Builds this viewer's screen again from scratch, for when the video froze or didn't load for
  // them: only their own screen, so nobody else's playback is touched. The new page starts at the
  // host's current time, as for someone joining late.
  reloadScreen() {
    if (this.blocked || !this.screenReady) return;
    const now = Date.now();
    if (this.lastScreenReload && now - this.lastScreenReload < 3000) return; // a double click
    this.lastScreenReload = now;
    console.log('[Core] Reloading this viewer\'s screen.');
    if (this.nativeScreen) {
      this.nativeScreen.destroy();
      this.nativeScreen = null;
    }
    this.removeBrowser();
    this.updateScreen();
    this.showToast('Reloading the video for you');
  }
  removeBrowser() {
    const browser = this.browser;
    if (!browser) return;
    // A screen still being built destroys itself when it sees this.
    browser.removed = true;
    this.destroyObject(browser.go);
    // The space-page screen's page goes too, so it doesn't play on behind the world's video
    // player. The space page itself stays claimed and sized for the next screen.
    if (browser.iframe) {
      try { browser.iframe.src = 'about:blank'; } catch (e) {}
      browser.iframe.remove();
      browser.iframe = null;
    }
    this.browser = null;
    // Messages still waiting for the old page will never be answered.
    this.browserAcks = {};
  }
  // The screen: a BS Browser showing the player page. It's built in the background; actions sent
  // before it's ready wait in `queue`.
  // In Altspace, when this player has the space page (claimSpaceSurface), the page is an iframe
  // on it instead, and the screen draws the space page's texture.
  createBrowser(url, surface = this.spaceSurface) {
    const browser = this.browser = { url, go: null, component: null, queue: [], removed: false, surface: surface || null };
    const build = browser.surface ? this.buildSpaceScreen(browser) : this.buildBrowser(browser);
    browser.ready = build.catch(e => {
      console.error('[Core] Could not create the browser screen:', e);
      this.showToast("Couldn't create the screen.", 6000);
    });
  }
  async buildBrowser(browser) {
    const p = this.params;
    const t = this.screenTransform();
    const go = browser.go = await this.makeObject('FireVPlayer_Screen', { position: t.position, rotation: t.rotation, scale: this.browserScale(), layer: LAYER_UI });
    if (browser.removed) { this.destroyObject(go); return; }
    go.On('browser-message', e => this.onBrowserMessage(e));
    const url = browser.url;
    const [w, h] = browser.size = this.screenPageSize();
    // pixelsPerUnit only matters to clients from before the SDK, which honour it.
    const ppu = SCREEN_PIXELS_PER_M;
    const component = await this.addComponent(go, this.bsComponent('Browser',
      { url, pageWidth: w, pageHeight: h, mipMaps: p['mip-maps'], pixelsPerUnit: ppu },
      'BanterBrowser', [url, p['mip-maps'], ppu, w, h, null]));
    if (browser.removed) { this.destroyObject(go); return; }
    browser.component = component;
    // Clicks on the page, except for a blacklisted person (see setBlocked).
    this.setScreenInteraction(!this.blocked);
    // The sound plays from the screen at the same volume everywhere (the SDK's Flat fade); the
    // `spatial` setting does its own fade. A BS Browser has no 2D sound: on PC it's always heard
    // from the screen's direction, and on Quest the page plays its own sound, which isn't placed.
    if ('rolloffMode' in component || this.modernSdk()) component.rolloffMode = 0;
    // A size picked meanwhile in the panel.
    if (this.screenPageSize()[0] !== w) this.applyScreenResolution();
    // The address may have changed while the screen was being made.
    if (browser.url !== url) component.url = browser.url;
    browser.queue.splice(0).forEach(json => component.RunActions(json));
    this.syncSecondScreens();
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
    if (browser.surface) {
      // The iframe's page takes the same messages by postMessage. It can't be clicked.
      actions.forEach(a => {
        if (a.actionType === 'postmessage') this.postToSpaceScreen(browser, a.strParam1);
        else console.log(`[Core] The space-page screen can't do the browser action "${a.actionType}".`);
      });
      return true;
    }
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
    if (browser.iframe) {
      browser.loaded = false;
      browser.iframe.src = this.spaceScreenUrl(url);
    }
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
  // `fx`/`fy` place the click as a fraction of the page (0.5 = the middle), as the page doesn't know
  // its size in the browser's pixels; `x`/`y` are page pixels.
  clickBrowser(x, y, fx, fy) {
    const browser = this.browser;
    if (!browser) return; // the world's video player is up instead
    const [w, h] = browser.size || this.screenPageSize();
    if (Number.isFinite(fx) && Number.isFinite(fy)) { x = Math.round(w * fx); y = Math.round(h * fy); }
    this.runBrowserActions([{actionType: "click2d", numParam1: x, numParam2: y}]);
  }

  // ---------------------------------------------------------------- space-page screen (Altspace)
  //
  // The Altspace client renders the space page (the page this script runs in) in a browser of its
  // own that nobody sees, and lets a material draw it through the SPACE_BROWSER_TEXTURE asset. So
  // the player page can run in an iframe laid over the whole space page, and the screen is a plane
  // with that texture: no second browser is opened. There is one space page, so one player per
  // space can have it (window.__vpSurfaceOwner, shared with other players that do the same); any
  // other gets the BS Browser screen. Used only where the client can size the space page and the
  // size shows up as this window's size, unless the `space-screen` setting turns it off.

  spaceScreenSetting() {
    const v = String(this.params['space-screen'] || 'auto').trim().toLowerCase();
    if (v === 'false' || v === 'off' || v === 'no') return 'off';
    return 'auto';
  }
  spacePageIs(w, h) {
    return Math.abs(window.innerWidth - w) <= 2 && Math.abs(window.innerHeight - h) <= 2;
  }
  // Asks the client to make the space page w x h. False when it has no way to.
  requestSpacePageSize(w, h) {
    const scene = this.banterScene();
    if (!scene) return false;
    try {
      if (typeof scene.SetWorldBrowserSize === 'function') { scene.SetWorldBrowserSize(w, h); return true; }
      // Clients without the named call still carry the wire command: SetProp sends it as it is.
      if (typeof scene.SetProp === 'function') { scene.SetProp(SET_WORLD_BROWSER_SIZE, { w: String(w), h: String(h) }); return true; }
    } catch (e) {
      console.warn('[Core] Could not size the space page:', e);
    }
    return false;
  }
  // Sizes the space page, true once this window really is that size.
  setSpacePageSize(w, h) {
    const surface = this.spaceSurface;
    if (!this.requestSpacePageSize(w, h)) return Promise.resolve(false);
    if (surface) { surface.sized = true; surface.size = [w, h]; }
    return new Promise(resolve => {
      if (this.spacePageIs(w, h)) { resolve(true); return; }
      let timer = null;
      const done = ok => {
        window.removeEventListener('resize', onResize);
        clearTimeout(timer);
        if (!ok) console.warn(`[Core] The space page never became ${w} x ${h} (it's ${window.innerWidth} x ${window.innerHeight}).`);
        resolve(ok);
      };
      const onResize = () => { if (this.spacePageIs(w, h)) done(true); };
      timer = setTimeout(() => done(this.spacePageIs(w, h)), SPACE_SIZE_CONFIRM_MS);
      window.addEventListener('resize', onResize);
    });
  }
  // Takes the space page for the screen, or leaves this.spaceSurface null when it can't be used.
  async claimSpaceSurface() {
    if (this.spaceScreenSetting() === 'off') {
      console.log('[Core] space-screen is off: using a browser for the screen.');
      return null;
    }
    const scene = this.banterScene();
    const named = !!scene && typeof scene.SetWorldBrowserSize === 'function';
    if (!scene || !this.modernSdk() || typeof BS.Plane !== 'function' || typeof BS.Material !== 'function'
      || (!named && typeof scene.SetProp !== 'function')) {
      return null; // not a client that can share its space page (Banter)
    }
    if (window.__vpSurfaceOwner) {
      console.log(`[Core] Another player (${window.__vpSurfaceOwner}) has the space page, so this one uses a browser for its screen.`);
      return null;
    }
    const owner = window.__vpSurfaceOwner = `fire-v-player:${this.params.instance}`;
    const surface = this.spaceSurface = {
      owner, sized: false, size: null, named, layer: null, onMessage: null,
      original: [window.innerWidth, window.innerHeight]
    };
    const [w, h] = this.screenPageSize();
    let ok = true;
    // SetProp sends the command whether or not the client knows it, so a page that already has
    // the size proves nothing: move it off that size first and see it come back.
    if (!named && this.spacePageIs(w, h)) ok = await this.setSpacePageSize(w, h - 16);
    if (ok && this.spaceSurface === surface) ok = await this.setSpacePageSize(w, h);
    if (this.destroyed || this.spaceSurface !== surface) {
      if (this.spaceSurface === surface) this.releaseSpaceSurface();
      return null;
    }
    if (!ok) {
      console.log('[Core] This client did not size the space page, so the screen is a browser.');
      this.releaseSpaceSurface();
      return null;
    }
    // Over everything the space page shows: the whole page is the screen.
    const layer = surface.layer = document.createElement('div');
    layer.setAttribute('data-fire-v-player-screen', owner);
    Object.assign(layer.style, {
      position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', margin: '0', padding: '0',
      overflow: 'hidden', background: '#000', zIndex: '2147483647'
    });
    (document.body || document.documentElement).appendChild(layer);
    surface.onMessage = e => this.onSpaceScreenMessage(e);
    window.addEventListener('message', surface.onMessage);
    console.log(`[Core] The screen is the space page (${w} x ${h}).`);
    return surface;
  }
  // Gives the space page back: no layer, its own size, and no owner.
  releaseSpaceSurface() {
    const surface = this.spaceSurface;
    if (!surface) return;
    this.spaceSurface = null;
    if (surface.onMessage) window.removeEventListener('message', surface.onMessage);
    if (surface.layer) surface.layer.remove();
    if (surface.sized) {
      const scene = this.banterScene();
      try {
        // An empty request puts the space page back to the client's own size.
        if (scene && typeof scene.SetProp === 'function') scene.SetProp(SET_WORLD_BROWSER_SIZE, {});
        else if (scene && typeof scene.SetWorldBrowserSize === 'function') scene.SetWorldBrowserSize(surface.original[0], surface.original[1]);
      } catch (e) {
        console.warn('[Core] Could not put the space page back to its size:', e);
      }
    }
    if (window.__vpSurfaceOwner === surface.owner) delete window.__vpSurfaceOwner;
  }
  // Logs anything that could make the space screen's page count as hidden to an embed that checks
  // (Twitch won't autoplay then): what is drawn on top at the centre, and see-through or
  // transformed elements above the iframe.
  logSpaceScreenCover(iframe) {
    try {
      const describe = el => el === iframe ? 'the player' : `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}`;
      const top = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2).slice(0, 3).map(describe);
      const odd = [];
      for (let el = iframe; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (Number(s.opacity) < 1 || s.transform !== 'none' || s.filter !== 'none' || s.visibility !== 'visible') {
          odd.push(`${describe(el)} (opacity ${s.opacity}, transform ${s.transform}, filter ${s.filter}, visibility ${s.visibility})`);
        }
      }
      console.log(`[Core] Space screen: on top at the centre ${top.join(' > ')}; page ${document.visibilityState}; ${odd.length ? 'styled above it: ' + odd.join(', ') : 'nothing see-through or transformed above it'}.`);
    } catch (e) {
      console.log('[Core] Could not check the space screen:', e);
    }
  }
  // The player page's origin, the only one the iframe's messages are taken from or sent to.
  playerPageOrigin() {
    try { return new URL(this.initialUrl, location.href).origin; } catch (e) { return ''; }
  }
  // The player page's address in the iframe: it's told to talk to this page by postMessage.
  spaceScreenUrl(url) {
    let origin = '';
    try { origin = new URL(url, location.href).origin; } catch (e) {}
    if (!origin || origin !== this.playerPageOrigin()) return url; // some other page (SET_BROWSER_URL)
    return `${url}${url.includes('?') ? '&' : '?'}embed=space&po=${encodeURIComponent(location.origin)}`;
  }
  async buildSpaceScreen(browser) {
    const surface = browser.surface;
    const p = this.params;
    browser.origin = this.playerPageOrigin();
    const iframe = browser.iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    // The client passes the pointer to the space page wherever it is, so the player page would
    // always have a mouse over it, and YouTube would keep its title, share button and play
    // button up. The screen can't be clicked anyway, so the page gets no pointer at all.
    Object.assign(iframe.style, { width: '100%', height: '100%', border: '0', display: 'block', pointerEvents: 'none' });
    // Messages sent before the page has loaded wait for it.
    iframe.addEventListener('load', () => {
      if (browser.removed || browser.iframe !== iframe) return;
      browser.loaded = true;
      browser.queue.splice(0).forEach(data => this.postToSpaceScreen(browser, data));
      setTimeout(() => this.logSpaceScreenCover(iframe), 3000);
    });
    iframe.src = this.spaceScreenUrl(browser.url);
    surface.layer.appendChild(iframe);
    // A size picked while the world's video player had the screen.
    const [w, h] = this.screenPageSize();
    browser.size = surface.size || [w, h];
    if (browser.size[0] !== w || browser.size[1] !== h) this.applyScreenResolution();
    const t = this.screenTransform();
    const [sx, sy, sz] = this.vec3(p.scale, [1, 1, 1]);
    const go = browser.go = await this.makeObject('FireVPlayer_SpaceScreen', {
      position: t.position, rotation: t.rotation, scale: new BS.Vector3(SURFACE_FLIP_X * sx, SURFACE_FLIP_Y * sy, sz)
    });
    if (browser.removed) { this.destroyObject(go); return; }
    // The same size as the browser screen: SCREEN_WIDTH_M wide, 16:9, before the snippet's scale.
    await this.addComponent(go, new BS.Plane({ width: SCREEN_WIDTH_M, height: SCREEN_WIDTH_M * 9 / 16 }));
    await this.addComponent(go, new BS.Material({ shaderName: 'Unlit/Texture', texture: SPACE_BROWSER_TEXTURE, color: this.white() }));
    if (browser.removed) return;
    this.syncSecondScreens();
    if (p.geometry && p.geometry !== "false") await this.addScreenShape(go);
  }
  // Sends one message (a JSON string) to the iframe's page, pinned to the player page's origin.
  postToSpaceScreen(browser, data) {
    if (browser.removed) return;
    const target = browser.iframe && browser.iframe.contentWindow;
    if (!browser.loaded || !target) { browser.queue.push(data); return; }
    try { target.postMessage(data, browser.origin); } catch (e) { console.warn('[Core] Could not message the screen:', e); }
  }
  // Messages from the iframe's page, as the BS Browser's browser-message events.
  onSpaceScreenMessage(e) {
    const browser = this.browser;
    if (!browser || !browser.iframe || e.source !== browser.iframe.contentWindow) return;
    if (e.origin !== browser.origin || typeof e.data !== 'string') return;
    this.onBrowserMessage({ detail: e.data });
  }

  // ---------------------------------------------------------------- second screens
  //
  // A world can show the screen on more surfaces: any object in its Unity scene with a BS Material
  // whose Texture is "Fire-V-Player" (the Unity menu Fire-V-Player > Second Screen makes one).
  // Their material follows whichever texture the screen draws: the space
  // page's, or the BS Browser's, whose reference is only known once it exists. The world's video
  // player (files) has no texture to share, so they go black while it plays.

  // The texture reference the screen draws now, or null when there isn't one to share.
  secondScreenTexture() {
    const browser = this.browser;
    if (this.destroyed || !browser || browser.removed) return null;
    if (browser.surface) return browser.go ? SPACE_BROWSER_TEXTURE : null;
    const id = browser.component && browser.component.unityId;
    return id != null && id !== '' ? `asset_browser_${id}` : null;
  }
  // The BS Materials of the scene's second screens. The page knows every object with a BS
  // component, so these are among scene.objects.
  findSecondScreens() {
    const scene = this.banterScene();
    if (!scene || !scene.objects || !this.modernSdk() || !BS.CT || BS.CT.Material == null) return [];
    // Once the player has set a screen's texture it no longer reads "Fire-V-Player", so screens
    // already found are remembered.
    const known = this.secondScreens || (this.secondScreens = new Set());
    const unasked = [];
    Object.values(scene.objects).forEach(go => {
      let material = null;
      try { material = go && go.GetComponent(BS.CT.Material); } catch (e) {}
      if (!material) return;
      if (String(material.texture || '').trim().toLowerCase() === SECOND_SCREEN_TEXTURE) known.add(material);
      else if (!known.has(material) && !material.__fvpAsked && material.unityId) unasked.push(material);
    });
    this.askMaterialTextures(scene, unasked);
    return Array.from(known);
  }
  // A material from the Unity scene can reach the page without its values (it reads ""), so each
  // one's Texture is asked of Unity once; the answer updates the material, then the screens sync.
  askMaterialTextures(scene, materials) {
    if (!materials.length || typeof BS.ComponentQuery !== 'function' || !BS.PN || BS.PN.texture == null ||
        typeof scene.QueryComponents !== 'function') return;
    const query = new BS.ComponentQuery();
    materials.forEach(material => { material.__fvpAsked = true; query.Add(material, [BS.PN.texture]); });
    Promise.resolve(scene.QueryComponents(query))
      .then(() => {
        if (this.destroyed) return;
        this.syncSecondScreens();
        if (!this.secondScreenCount && !this.secondScreenAskLogged) {
          this.secondScreenAskLogged = true;
          console.log(`[Core] Still no second screen after asking Unity for ${materials.length} material(s). ${this.secondScreenSummary()}`);
        }
      })
      .catch(e => console.warn('[Core] Could not read the scene\'s material textures:', e));
  }
  // What the page can see of the scene's materials, for the log: says why no second screen was found.
  secondScreenSummary() {
    try {
      const scene = this.banterScene();
      if (!this.modernSdk() || !BS.CT || BS.CT.Material == null) return '(this client has no BS.CT.Material)';
      const objects = Object.values((scene && scene.objects) || {});
      let count = 0;
      const textured = [];
      objects.forEach(go => {
        const material = go && go.GetComponent && go.GetComponent(BS.CT.Material);
        if (!material) return;
        count++;
        // Only the ones with a texture or a name that looks like a screen: there can be hundreds.
        const texture = String(material.texture || '');
        if (texture || /screen|fire-v/i.test(go.name || '')) textured.push(`${go.name || '?'}: "${texture}"`);
      });
      return `(${objects.length} objects, ${count} BS Materials; with a texture or "screen" in the name: ${textured.slice(0, 20).join(', ') || 'none'})`;
    } catch (e) {
      return `(could not list materials: ${e && e.message})`;
    }
  }
  // Points every second screen at the screen's texture (or black). Safe to call often: a screen
  // already showing the right thing isn't touched.
  syncSecondScreens() {
    if (!this.inWorld()) return;
    const screens = this.findSecondScreens();
    if (screens.length !== this.secondScreenCount) {
      this.secondScreenCount = screens.length;
      console.log(`[Core] ${screens.length} second screen(s) in the scene. ${this.secondScreenSummary()}`);
    }
    const texture = this.secondScreenTexture();
    screens.forEach(material => {
      if (material.__fvpShowing === texture) return;
      material.__fvpShowing = texture;
      try {
        material.texture = texture || '';
        material.color = texture ? this.white() : new BS.Vector4(0, 0, 0, 1);
      } catch (e) {
        console.warn('[Core] Could not update a second screen:', e);
      }
    });
  }

  // Gives the second screens back their "Fire-V-Player" marker, black, so a player started later
  // on this page can find them again.
  releaseSecondScreens() {
    if (!this.secondScreens) return;
    this.secondScreens.forEach(material => {
      delete material.__fvpShowing;
      try {
        material.texture = SECOND_SCREEN_TEXTURE;
        material.color = new BS.Vector4(0, 0, 0, 1);
      } catch (e) {
        console.warn('[Core] Could not release a second screen:', e);
      }
    });
    this.secondScreens.clear();
  }

  // ---------------------------------------------------------------- screen resolution
  // `resolution` is the page's width in pixels (16:9). Each viewer can pick another in the panel,
  // remembered on their device, as their screen is their own browser.
  clampResolution(value) {
    const w = Math.round(Number(value));
    if (!Number.isFinite(w) || w <= 0) return null;
    return Math.max(SCREEN_MIN_RESOLUTION, Math.min(SCREEN_MAX_RESOLUTION, w));
  }
  defaultResolution() { return this.clampResolution(this.params.resolution) || 1600; }
  screenResolution() { return this.viewerResolution || this.defaultResolution(); }
  screenPageSize() {
    const w = this.screenResolution();
    return [w, Math.round(w * 9 / 16)];
  }
  // The screen object's scale: the snippet's, times what keeps the page SCREEN_WIDTH_M wide.
  browserScale() {
    const k = SCREEN_WIDTH_M * SCREEN_PIXELS_PER_M / this.screenPageSize()[0];
    const [x, y, z] = this.vec3(this.params.scale, [1, 1, 1]);
    return new BS.Vector3(x * k, y * k, z);
  }
  loadResolutionPref() {
    try {
      const saved = this.clampResolution(localStorage.getItem(RESOLUTION_PREF_KEY));
      if (saved) this.viewerResolution = saved;
    } catch (e) {}
    return this.screenResolution();
  }
  // null goes back to the snippet's resolution.
  setScreenResolution(width) {
    const w = this.clampResolution(width);
    this.viewerResolution = w && w !== this.defaultResolution() ? w : null;
    try {
      if (this.viewerResolution) localStorage.setItem(RESOLUTION_PREF_KEY, String(this.viewerResolution));
      else localStorage.removeItem(RESOLUTION_PREF_KEY);
    } catch (e) {}
    this.applyScreenResolution();
    const [pw, ph] = this.screenPageSize();
    this.showToast(`Screen resolution ${pw} x ${ph}`);
  }
  // Resizes the page and rescales the screen, so it stays the same size in the world.
  applyScreenResolution() {
    const browser = this.browser;
    if (browser && browser.surface) {
      // The space page is the page: it's resized, and the screen keeps its size in metres.
      const [w, h] = browser.size = this.screenPageSize();
      this.setSpacePageSize(w, h).then(ok => {
        if (ok) console.log(`[Core] Screen page is now ${w} x ${h}.`);
      });
      return;
    }
    if (!browser || !browser.component) return;
    const [w, h] = browser.size = this.screenPageSize();
    browser.component.pageWidth = w;
    browser.component.pageHeight = h;
    if (browser.go && typeof browser.go.SetLocalScale === 'function') browser.go.SetLocalScale(this.browserScale());
    console.log(`[Core] Screen page is now ${w} x ${h}.`);
  }
  // Where each button in the row under the screen goes (x, in the row's own metres). With the
  // optional Reload and Play/Pause buttons turned off it's the original row. Play/Pause comes first
  // in its group, so for everyone but the host (who alone sees it) it's just a wider gap.
  // unity/Editor/FireVPlayerSnippetPreview.cs draws the same layout.
  screenButtonLayout() {
    const playPause = this.params['play-pause-button'] !== 'false';
    const reload = this.params['reload-button'] !== 'false';
    if (!playPause && !reload) {
      return { Playlist: -0.633, SkipBack: -0.332, SkipForward: -0.081, Mute: 0.23, VolumeDown: 0.471, VolumeUp: 0.693 };
    }
    const groups = [['Playlist', reload && 'Reload'], [playPause && 'PlayPause', 'SkipBack', 'SkipForward'], ['Mute', 'VolumeDown', 'VolumeUp']]
      .map(g => g.filter(Boolean));
    const STEP = 0.24, GAP = 0.31, CENTRE = 0.03; // the original row's middle
    const layout = {};
    let x = 0;
    groups.forEach((group, i) => {
      if (i) x += GAP - STEP;
      group.forEach(name => { layout[name] = x; x += STEP; });
    });
    const shift = CENTRE - (x - STEP) / 2;
    Object.keys(layout).forEach(name => { layout[name] = Math.round((layout[name] + shift) * 1000) / 1000; });
    return layout;
  }
  // The row of buttons under the screen: Playlist (Singers), Reload, Play/Pause (host), skip
  // back/forward, mute, volume.
  async setupBrowserUi() {
    const p = this.params;
    const screenPos = this.vec3(p.position, [0, 0, 0]);
    const yScale = this.vec3(p.scale, [1, 1, 1])[1];
    const under = [screenPos[0], screenPos[1] - yScale * 0.335, screenPos[2]];
    const position = p["button-position"] === "0 0 0" ? under : this.vec3(p["button-position"], under);
    const rotation = this.vec3(p["button-rotation"] === "0 0 0" ? p.rotation : p["button-rotation"], [0, 0, 0]);
    // Kept (in Unity values) to work out where the Singers button is.
    this.buttonsTransform = { position: this.toUnityPos(position), rotation: this.toUnityEuler(rotation), scale: this.toVector3(this.vec3(p["button-scale"], [1, 1, 1])) };
    this.playlistContainer = await this.makeObject('FireVPlayer_Buttons', this.buttonsTransform);
    await this.setupPlaylistButton(this.playlistContainer);
    await this.setupVolButton(true, this.playlistContainer);
    await this.setupVolButton(false, this.playlistContainer);
    await this.setupMuteButton(this.playlistContainer);
    await this.setupSkipButton(true, this.playlistContainer);
    await this.setupSkipButton(false, this.playlistContainer);
    const layout = this.screenButtonLayout();
    if (layout.Reload !== undefined) {
      await this.setupButton(this.playlistContainer, 'Reload', layout.Reload, this.params["data-reload-icon-url"], () => this.reloadScreen());
    }
    if (layout.PlayPause !== undefined) {
      this.playPauseButton = await this.setupSwapButton(this.playlistContainer, 'ButtonPlayPause', new BS.Vector3(layout.PlayPause, 0, 0),
        { pause: this.params["data-pause-icon-url"], play: this.params["data-play-icon-url"] },
        () => this.sendMessage({ path: Commands.TOGGLE_PAUSE }));
    }
    this.updateScreenButtons();
  }
  // A button with a picture for each state (see showSwapButton). Each picture is its own icon
  // button, and only the one for the current state is active, so it's the one seen and clicked.
  async setupSwapButton(parent, name, position, icons, callback, size = 0.2) {
    const holder = await this.makeObject(`FireVPlayer_${name}`, { parent, position });
    const button = { holder, icons: {}, state: null, shown: true };
    for (const state of Object.keys(icons)) {
      const go = await this.makeIconButton(`FireVPlayer_${name}_${state}`, holder, new BS.Vector3(0, 0, 0), size, icons[state], callback);
      button.icons[state] = go;
      this.setActive(go, false);
    }
    return button;
  }
  // Shows the picture for `state`, or hides the whole button when `shown` is false.
  showSwapButton(button, state, shown = true) {
    if (!button) return;
    if (button.shown !== shown) {
      button.shown = shown;
      this.setActive(button.holder, shown);
    }
    if (button.state === state) return;
    button.state = state;
    Object.keys(button.icons).forEach(key => this.setActive(button.icons[key], key === state));
  }
  setActive(go, on) {
    if (!go) return;
    try {
      if (typeof go.SetActive === 'function') Promise.resolve(go.SetActive(!!on)).catch(() => {});
      // Clients without SetActive: shrunk to nothing, collider and all, so it can't be clicked.
      else if (typeof go.SetLocalScale === 'function') go.SetLocalScale(on ? new BS.Vector3(1, 1, 1) : new BS.Vector3(0.0001, 0.0001, 0.0001));
    } catch (e) {
      console.warn(`[Core] Could not ${on ? 'show' : 'hide'} ${go.name}:`, e);
    }
  }
  isHost() {
    const p = this.player;
    return !!(p && p.host && window.user && p.host.id === window.user.id);
  }
  // The Mute button shows Unmute while muted, and Play/Pause shows what pressing it does, only to the host.
  updateScreenButtons() {
    const mute = this.params.mute === 'true' ? 'unmute' : 'mute';
    this.showSwapButton(this.muteButton, mute);
    this.showSwapButton(this.handMuteButton, mute);
    const p = this.player;
    this.showSwapButton(this.playPauseButton, p && p.paused ? 'play' : 'pause', this.isHost());
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
    if (this.blocked) return;
    this.params.volume = amount;
    if(this.params.volume > 100) {
      this.params.volume = 100;
    } else if (this.params.volume < 0) {
      this.params.volume = 0;
    }
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: this.params.volume});
  }
  setVolumeIncrement(amount) {
    if (this.blocked) return;
    this.params.volume += amount;
    if(this.params.volume > 100) {
      this.params.volume = 100;
    } else if (this.params.volume < 0) {
      this.params.volume = 0;
    }
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: this.params.volume});
  }
  /**
   * Sets up karaoke's 3D in-world Singers button and optional trigger volume box.
   * Cleans up automatically on mode changes or teardown.
   * @returns {Promise<void>}
   */
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
    const world = p["singer-button-space"] === 'world';
    const position = this.toUnityPos(this.vec3(p["singer-button-position"], [0, 0, 0]));
    const rotation = this.toUnityEuler(this.vec3(p["singer-button-rotation"], [0, 0, 0]));
    const button = await this.makeObject('FireVPlayer_SingerButton', {
      parent: world ? null : this.playlistContainer, position, rotation, layer: LAYER_UI
    });
    made.push(button);
    if (!alive()) return;
    // A picture on each side, so it reads from either one. Each is tracked in `made` too: if the
    // button is removed while one is being made, it can end up with no parent, loose in the world.
    const url = this.assetUrl('SingersButton.png');
    await this.makeImage('FireVPlayer_SingerButtonFront', button, new BS.Vector3(0, 0, -0.005), 1, 0.3, url, { made, layer: LAYER_UI });
    if (!alive()) return;
    await this.makeImage('FireVPlayer_SingerButtonBack', button, new BS.Vector3(0, 0, 0.005), 1, 0.3, url,
      { made, layer: LAYER_UI, rotation: new BS.Vector3(0, 180, 0) });
    if (!alive()) return;
    await this.addColliderBox(button, new BS.Vector3(1, 0.3, 0.05), true);
    // Like the hand's Playlist button, it brings the panel to itself (just above it).
    button.On('click', () => { if (!this.blocked) this.openPlaylist('singer'); });
    // Where it is in the world, for the panel. Unity only reports a transform when it changes, so
    // a button that never moves is worked out from its settings (see PlaylistPanel.singerPose).
    this.singerLayout = { world, position, rotation, parent: this.buttonsTransform };
    this.watchSingerButton(button, token);

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
  /**
   * Monitors avatar body part contacts with the trigger volume to auto-start or stop karaoke.
   * @param {Object} boxTrigger - Trigger volume GameObject.
   * @param {boolean} triggerEnter - Auto-queue song on enter.
   * @param {boolean} triggerExit - Auto-remove and stop on exit.
   */
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
  /**
   * Tracks the world transform of the Singers button to position the playlist panel directly above it.
   * @param {Object} button - Singers button GameObject.
   * @param {Object} token - Cancellation token for current build lifecycle.
   * @returns {Promise<void>}
   */
  async watchSingerButton(button, token) {
    const PN = BS.PN || BS.PropertyName;
    if (typeof button.WatchTransform !== 'function' || !PN) return;
    try {
      await button.WatchTransform([PN.position, PN.rotation], t => {
        if (token === this.singerToken && t && t.position) this.singerPose = { position: t.position, rotation: t.rotation };
      });
    } catch (e) {
      console.warn('[Core] Could not watch the Singers button:', e);
    }
  }

  /**
   * Cleans up and destroys all GameObjects associated with the karaoke Singers button and trigger.
   */
  removeJoinLeaveButton() {
    this.singerToken = null;
    this.singerPose = null;
    this.singerLayout = null;
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
  /**
   * Sets up the in-world 3D Playlist/Singers button under the video screen.
   * @param {Object} playlistContainer - Parent container GameObject.
   * @returns {Promise<void>}
   */
  async setupPlaylistButton(playlistContainer) {
    const playlistIconUrl = this.params["data-playlist-icon-url"];
    // Use the isKaraoke flag to provide a context-specific text label
    const buttonText = this.isKaraoke ? 'Singers' : 'Playlist';
    const button = await this.setupButton(playlistContainer, 'Playlist', this.screenButtonLayout().Playlist, playlistIconUrl, () => this.openPlaylist(), buttonText);
    // Kept so the label can follow a mode change.
    this.playlistButtonHolder = button.holder;
    this.playlistButtonText = button.label;
  }
  // The label under a button, as a picture (assets/<text>Label.png).
  makeButtonLabel(name, holder, text) {
    return this.makeImage(`FireVPlayer_Button${name}Text`, holder, new BS.Vector3(0, -0.15, -0.005), 0.32, 0.08, this.assetUrl(`${text}Label.png`));
  }
  // Swaps the Playlist button's label for the mode's (Playlist or Singers).
  async setPlaylistLabel(karaoke) {
    if (!this.playlistButtonHolder) return;
    const old = this.playlistButtonText;
    const token = this.playlistLabelToken = {};
    const label = await this.makeButtonLabel('Playlist', this.playlistButtonHolder, karaoke ? 'Singers' : 'Playlist');
    if (token !== this.playlistLabelToken || !this.playlistButtonHolder) { this.destroyObject(label); return; }
    this.playlistButtonText = label;
    this.destroyObject(old);
  }

  /**
   * Toggles or opens the playlist panel or web interface.
   * @param {'front'|'singer'|undefined} [where] - Where to place the panel ('front' in front of player, 'singer' above karaoke button, or undefined for beside screen).
   */
  openPlaylist(where) {
    if (this.blocked) return;
    // Clicks can arrive twice in quick succession (pointer + trigger), so debounce.
    const now = Date.now();
    if (this._lastPlaylistToggle && now - this._lastPlaylistToggle < 600) return;
    this._lastPlaylistToggle = now;
    console.log(`[Core] Playlist button pressed (${this.playlistPanel ? 'toggling the in-world panel' : 'opening the menu page'}).`);

    // In-world UI Toolkit panel (new SDK), when one was set up for this player.
    if (this.playlistPanel) {
      this.playlistPanel.toggle(where);
      return;
    }
    this.openPlaylistPage();
  }

  getPlaylistPageUrl() {
    // Determine the mode ('karaoke' or 'playlist') based on the in-world script's setting.
    const mode = this.isKaraoke ? 'karaoke' : 'playlist';
    const playlistParam = (this.params.playlist ? `&playlist=${encodeURIComponent(this.params.playlist)}` : "")
      + (this.params.playlists ? `&playlists=${encodeURIComponent(this.params.playlists)}` : "");
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
      const admin = changes.find(c => c && c.property === ADMIN_STATE_KEY);
      if (admin) this.adminStateChanged(admin);
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
      if (d.key === ADMIN_STATE_KEY || d.path === ADMIN_STATE_KEY) {
        console.warn('[Core] Could not take control as a space admin:', d.code, d.message);
        this.adminWriteRefused(d.code);
        return;
      }
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

  // ---------------------------------------------------------------- space admin take over
  //
  // A space admin can take control of the player even when it's locked or Take Over is off. The
  // server can't tell who is a space admin, but only a space admin can write protected space state,
  // so the admin's press writes ADMIN_STATE_KEY there, naming themselves. When that change comes
  // back, the named person's player asks the server for control (Commands.ADMIN_TAKE_OVER). The
  // time in the value makes every press a change. A write from anyone else is refused, which may
  // arrive as a space-state-error or as nothing at all, as for the mode.
  adminTakeOver() {
    const scene = this.banterScene();
    const uid = window.user && window.user.id;
    if (!scene || typeof scene.SetProtectedSpaceProps !== 'function' || !uid) return false;
    this.watchModeOverride();
    clearTimeout(this.adminWriteTimer);
    this.adminWriteTimer = setTimeout(() => this.adminWriteRefused(), MODE_WRITE_TIMEOUT_MS);
    // "uid:time". Not "|", "§" or "¶": the SDK uses those to separate its own messages, and refuses
    // a value with one in it ("Invalid prop").
    scene.SetProtectedSpaceProps({ [ADMIN_STATE_KEY]: `${String(uid).replace(/[|§¶:]/g, '')}:${Date.now()}` });
    return true;
  }

  adminStateChanged(c) {
    // Anyone can write a public value with the same name, so only a protected one counts.
    if (c.isPublic === true || c.type === 'public') return;
    let value = c.newValue;
    if (value && typeof value === 'object' && 'value' in value) value = value.value;
    const uid = String(value == null ? '' : value).trim().replace(/^"|"$/g, '').split(':')[0];
    const me = window.user && String(window.user.id).replace(/[|§¶:]/g, '');
    if (!uid || uid !== me) return;
    // Without a type on the change, check it's in the local copy of the protected state.
    if (c.isPublic !== false && c.type !== 'protected' && !this.protectedValueHas(ADMIN_STATE_KEY, uid)) return;
    clearTimeout(this.adminWriteTimer);
    this.adminWriteTimer = null;
    console.log('[Core] Taking control of the player as a space admin.');
    this.sendMessage({ path: Commands.ADMIN_TAKE_OVER });
    const msg = 'You have control of the player (space admin).';
    this.showToast(msg);
    if (this.playlistPanel) this.playlistPanel.setStatus(msg);
  }

  protectedValueHas(key, text) {
    const scene = this.banterScene();
    if (!scene) return false;
    const json = scene.spaceStateJson && scene.spaceStateJson.protected;
    const str = scene.spaceState && scene.spaceState.protected;
    const v = json && json[key] !== undefined ? json[key] : (str ? str[key] : undefined);
    return v !== undefined && String(typeof v === 'object' && v && 'value' in v ? v.value : v).includes(text);
  }

  adminWriteRefused(code) {
    clearTimeout(this.adminWriteTimer);
    this.adminWriteTimer = null;
    const msg = code && code !== 'not_authorized'
      ? 'Could not take control.'
      : 'Only space admins can take control this way.';
    this.showToast(msg);
    if (this.playlistPanel) this.playlistPanel.setStatus(msg);
  }

  // ---------------------------------------------------------------- blacklist
  //
  // The server tells a blacklisted person's player (Commands.SET_BLOCKED). They can still watch,
  // but nothing they press does anything and their volume stays at 100%, so the player just looks
  // frozen. The server ignores their controls as well, so this is only how it looks to them.
  setBlocked(blocked) {
    blocked = !!blocked;
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    clearInterval(this.blockedTimer);
    this.blockedTimer = null;
    // No clicking on the screen either (to pause or skip their own copy). The player's own clicks
    // (Commands.CLICK_BROWSER, for Twitch) are browser actions, so they still work.
    this.setScreenInteraction(!blocked);
    if (!blocked) return;
    if (this.playlistPanel && this.playlistPanel.visible) {
      Promise.resolve(this.playlistPanel.close()).catch(() => {});
    }
    this.forceFullVolume(true);
    this.blockedTimer = setInterval(() => this.forceFullVolume(false), BLOCKED_VOLUME_MS);
  }

  // Turns clicks on the screen's page on or off (the SDK's input handler on the browser).
  setScreenInteraction(enabled) {
    const component = this.browser && this.browser.component;
    if (!component || typeof component.ToggleInteraction !== 'function') return;
    try { component.ToggleInteraction(!!enabled); } catch (e) { console.warn('[Core] Could not change screen interaction:', e); }
  }

  // The page only shows a toast when the volume changes, but on every mute message, so unmute once.
  forceFullVolume(unmute) {
    this.params.volume = 100;
    this.tempVolume = 100;
    this.params.mute = 'false';
    this.updateScreenButtons();
    // Rejected while there's no screen yet; the page then starts at the volume from browserUrl().
    if (unmute) Promise.resolve(this.sendBrowserMessage({ path: Commands.MUTE, data: 'false' })).catch(() => {});
    Promise.resolve(this.sendBrowserMessage({ path: Commands.SET_VOLUME, data: 100 })).catch(() => {});
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
    this.setPlaylistLabel(karaoke).catch(e => console.error('[Core] Could not change the Playlist button label:', e));
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
    const name = isUp ? 'VolumeUp' : 'VolumeDown';
    return this.setupButton(playlistContainer, name, this.screenButtonLayout()[name], volIconUrl, () => this.volume(isUp));
  }
  setupSkipButton(isBack, playlistContainer) {
    const skipIconUrl = isBack ? this.params["data-skip-backward-icon-url"] : this.params["data-skip-forward-icon-url"];
    const name = isBack ? 'SkipBack' : 'SkipForward';
    return this.setupButton(playlistContainer, name, this.screenButtonLayout()[name], skipIconUrl, () => (isBack ? this.back() : this.forward()));
  }
  volume(isUp) {
    if (this.blocked) return;
    this.setVolume(isUp);
    if(isUp && this.params.mute == 'true') {
      this.params.mute = 'false';
      this.sendBrowserMessage({path: Commands.MUTE, data: this.params.mute});
      this.updateScreenButtons();
    }
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: this.params.volume});
  }
  
  mute() {
    if (this.blocked) return;
    this.params.mute = this.params.mute == 'true' ? 'false' : 'true';
    this.sendBrowserMessage({path: Commands.MUTE, data: this.params.mute});
    this.updateScreenButtons();
  }
  async setupMuteButton(playlistContainer) {
    this.muteButton = await this.setupSwapButton(playlistContainer, 'ButtonMute', new BS.Vector3(this.screenButtonLayout().Mute, 0, 0),
      { mute: this.params["data-mute-icon-url"], unmute: this.params["data-unmute-icon-url"] }, () => this.mute());
  }

  // ---------------------------------------------------------------- spatial volume
  // With `spatial` on, the volume fades with the local player's distance from the screen. The
  // SDK sends the head's world position as pose-update, only while the player moves.
  // Keeps the local player's latest head pose (world space), for opening the panel in front of them.
  trackHead() {
    const scene = this.banterScene();
    if (!scene || this.onHeadPose) return;
    this.onHeadPose = e => {
      const head = e && e.detail && e.detail.head;
      if (head && head.position && head.rotation) this.lastHead = head;
    };
    scene.On('pose-update', this.onHeadPose);
  }
  // An empty object on the local player's head. Unity reports where it is in the world, which is
  // more dependable than pose-update (whose values didn't match the world on Quest: the panel
  // opened behind the player and low).
  // The SDK drops attachments when the player leaves, so the marker is removed then and made
  // again when they come back, as the hand controls are.
  async setupHeadMarker() {
    const scene = this.banterScene();
    if (this.headMarker || this.destroyed || !scene || !this.inWorld()) return;
    if (!this.onHeadUserLeft) {
      this.onHeadUserLeft = e => { if (e && e.detail && e.detail.isLocal) this.removeHeadMarker(); };
      this.onHeadUserJoined = e => {
        if (!(e && e.detail && e.detail.isLocal) || this.headMarker) return;
        // A moment after joining, as for the hand controls, so the SDK is ready.
        clearTimeout(this.headRejoinTimer);
        this.headRejoinTimer = setTimeout(() => this.setupHeadMarker().catch(err => console.warn('[Core] Could not follow the head:', err)), 5000);
      };
      scene.On('user-left', this.onHeadUserLeft);
      scene.On('user-joined', this.onHeadUserJoined);
    }
    const uid = (scene.localUser && scene.localUser.uid) || (window.user && window.user.id);
    if (!uid) return;
    const go = await this.makeObject('FireVPlayer_HeadMarker');
    if (this.headMarker || this.destroyed) { this.destroyObject(go); return; }
    this.headMarker = go;
    if (typeof BS.AttachedObject === 'function') {
      const head = BS.AvatarBoneName ? BS.AvatarBoneName.HEAD : 0;
      const attached = await this.addComponent(go, new BS.AttachedObject({ uid, avatarAttachmentPoint: head }));
      if (this.headMarker !== go) return; // removed meanwhile
      await attached.Attach(uid);
    } else if (typeof scene.LegacyAttachObject === 'function' && BS.LegacyAttachmentPosition && BS.LegacyAttachmentPosition.HEAD !== undefined) {
      await scene.LegacyAttachObject(go, uid, BS.LegacyAttachmentPosition.HEAD);
    } else {
      console.log('[Core] No way to attach to the head here, so the panel uses pose-update.');
      return;
    }
    if (this.headMarker !== go) return;
    const PN = BS.PN || BS.PropertyName;
    if (typeof go.WatchTransform !== 'function' || !PN) return;
    try {
      await go.WatchTransform([PN.position, PN.rotation], t => {
        if (this.headMarker === go && t && t.position) this.headMarkerPose = { position: t.position, rotation: t.rotation };
      });
    } catch (e) {
      console.warn('[Core] Could not watch the head marker:', e);
      return;
    }
    console.log('[Core] Following the head.');
  }
  removeHeadMarker() {
    clearTimeout(this.headRejoinTimer);
    if (this.headMarker) this.destroyObject(this.headMarker);
    this.headMarker = null;
    this.headMarkerPose = null; // so headPose() uses pose-update until the new marker reports
  }
  // Keeps this[key] = { position, rotation } in world space as Unity moves the object.
  async watchWorldPose(go, key) {
    const PN = BS.PN || BS.PropertyName;
    if (!go || typeof go.WatchTransform !== 'function' || !PN) return;
    try {
      await go.WatchTransform([PN.position, PN.rotation], t => {
        if (t && t.position) this[key] = { position: t.position, rotation: t.rotation };
      });
    } catch (e) {
      console.warn(`[Core] Could not watch ${go.name}:`, e);
    }
  }
  // The local player's head in world space: from the head marker when it reports, else pose-update.
  headPose() {
    const m = this.headMarkerPose;
    if (m && m.position) return Object.assign({ source: 'marker' }, m);
    return this.lastHead ? Object.assign({ source: 'pose-update' }, this.lastHead) : null;
  }
  setupSpatial() {
    const scene = this.banterScene();
    if (!scene || this.params.spatial !== 'true' || this.onPoseUpdate) return;
    const p = this.vec3(this.params.position, [0, 0, 0]);
    const screen = { x: p[0], y: p[1], z: -p[2] }; // in Unity's axes, like the head
    let lastSendTime = Date.now();
    this.onPoseUpdate = e => {
      const head = e && e.detail && e.detail.head;
      if (!head || !head.position || this.blocked) return;
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
  // Six buttons (mute, volume, skip, the panel) that go where each viewer chooses (HAND_PLACES).
  // The snippet's hand-controls-place is the default; "auto" is the left wrist in VR and in view
  // on desktop, where the hands can't be turned to see the buttons.
  async isVR() {
    if (this.vrCheck === undefined) {
      const scene = this.banterScene();
      this.vrCheck = (async () => {
        if (!scene || typeof scene.IsVR !== 'function') return true; // older clients: as before
        try {
          const answer = await Promise.race([scene.IsVR(), new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
          console.log(answer === null ? '[Core] The client did not say whether it is in VR.' : `[Core] This client is ${answer ? '' : 'not '}in VR.`);
          return answer !== false;
        } catch (e) {
          return true;
        }
      })();
    }
    return this.vrCheck;
  }
  // The viewer's own choice, else the snippet's (a place's name or "auto").
  handPlaceChoice() {
    if (this.chosenHandPlace) return this.chosenHandPlace;
    try {
      const saved = localStorage.getItem(HAND_PLACE_PREF_KEY);
      if (saved && HAND_PLACES[saved]) return saved;
    } catch (e) {}
    const p = String(this.params['hand-controls-place'] || 'auto').trim().toLowerCase();
    return HAND_PLACES[p] ? p : 'auto';
  }
  async handPlace() {
    const choice = this.handPlaceChoice();
    if (choice !== 'auto') return choice;
    return (await this.isVR()) ? 'left' : 'view';
  }
  // Steps to the next place, remembered on this device, and moves the buttons there.
  async nextHandPlace() {
    const order = Object.keys(HAND_PLACES);
    const now = this.currentHandPlace || await this.handPlace();
    this.setHandPlace(order[(order.indexOf(now) + 1) % order.length]);
  }
  setHandPlace(place) {
    if (!HAND_PLACES[place]) return;
    try { localStorage.setItem(HAND_PLACE_PREF_KEY, place); } catch (e) {}
    this.chosenHandPlace = this.currentHandPlace = place;
    // A build still running sees the choice changed and stops, then builds again for the latest
    // choice (see setupHandControls), Off included, which builds nothing.
    this.handPlaceVersion = (this.handPlaceVersion || 0) + 1;
    this.removeHandControls();
    this.showToast(`Hand controls: ${HAND_PLACES[place].label}`);
    if (this.handControlsBuilding) this.handControlsRebuild = true;
    else if (place !== 'off') this.setupHandControls().catch(e => console.error('[Core] Could not set up the hand controls:', e));
  }
  handPlaceLabel() {
    const place = HAND_PLACES[this.currentHandPlace];
    return place ? place.label : '...';
  }
  /**
   * Sets up the hand controls where the viewer wants them.
   * Reattaches automatically when users rejoin or scene resets.
   * @returns {Promise<void>}
   */
  async setupHandControls() {
    if (this.destroyed) return;
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
        clearTimeout(this.handRejoinTimer);
        this.handRejoinTimer = setTimeout(() => this.setupHandControls().catch(err => console.error('[Core] Could not set up the hand controls:', err)), 5000);
      };
      scene.On('user-left', this.onHandUserLeft);
      scene.On('user-joined', this.onHandUserJoined);
    }
    if (this.handControls || this.handControlsBuilding) return;
    this.handControlsBuilding = true;
    try {
      await this.buildHandControls(scene);
    } finally {
      this.handControlsBuilding = false;
      if (this.handControlsRebuild) {
        this.handControlsRebuild = false;
        if (!this.destroyed) this.setupHandControls().catch(e => console.error('[Core] Could not set up the hand controls:', e));
      }
    }
  }
  async buildHandControls(scene) {
    // False once the player chooses another place (or the player is removed) during a wait.
    const version = this.handPlaceVersion;
    const current = () => !this.destroyed && this.handPlaceVersion === version;
    const name = await this.handPlace();
    if (!current()) return;
    this.currentHandPlace = name;
    const place = HAND_PLACES[name];
    if (name === 'off') return;
    const uid = (scene.localUser && scene.localUser.uid) || (window.user && window.user.id);
    if (place.attach !== undefined && (!uid || typeof scene.LegacyAttachObject !== 'function')) {
      console.warn('[Core] The local player or LegacyAttachObject is missing, so no hand controls.');
      return;
    }
    const front = name === 'front' ? await this.handFrontPose() : null;
    if (!current()) return;
    if (name === 'front' && !front) {
      this.showToast("Couldn't tell where you are, so the hand controls aren't in front of you. Move a little and choose In Front again.", 6000);
      return;
    }
    const root = await this.makeObject('FireVPlayer_HandControls', front || {});
    if (!current()) { this.destroyObject(root); return; }
    this.handControls = root;
    // The buttons lie flat, facing out of the wrist (or toward the player). On the wrists the
    // hand-controls-position and hand-controls-rotation settings change where, mirrored for the right.
    let position = place.position || [0, 0, 0], rotation = place.rotation || [0, 0, 0];
    if (name === 'left' || name === 'right') {
      const mirror = name === 'right';
      const p = this.vec3(this.params['hand-controls-position'], null);
      const r = this.vec3(this.params['hand-controls-rotation'], null);
      if (p) position = mirror ? [-p[0], p[1], p[2]] : p;
      if (r) rotation = mirror ? [r[0], -r[1], -r[2]] : r;
    }
    const wrapper = await this.makeObject('FireVPlayer_HandWrapper', {
      parent: root,
      position: this.toVector3(position),
      rotation: this.toVector3(rotation),
      scale: new BS.Vector3(place.scale, place.scale, place.scale)
    });
    // Four on top, three staggered under them.
    const buttons = [
      ['Mute', -0.57, 0.4, "data-mute-icon-url", () => this.mute()],
      ['VolumeDown', -0.19, 0.4, "data-vol-down-icon-url", () => this.volume(false)],
      ['VolumeUp', 0.19, 0.4, "data-vol-up-icon-url", () => this.volume(true)],
      ['Reload', 0.57, 0.4, "data-reload-icon-url", () => this.reloadScreen()],
      ['SkipBack', -0.38, -0.05, "data-skip-backward-icon-url", () => this.sendBrowserMessage({path: Commands.SKIP_BACK})],
      ['SkipForward', 0, -0.05, "data-skip-forward-icon-url", () => this.sendBrowserMessage({path: Commands.SKIP_FORWARD})],
      ['Playlist', 0.38, -0.05, "data-playlist-icon-url", () => this.openPlaylist('front')]
    ];
    for (const [button, x, y, icon, callback] of buttons) {
      if (root !== this.handControls) return; // removed meanwhile
      // Just off the wrist, toward -Z: the side a button is seen from.
      const at = new BS.Vector3(x, y, -0.3);
      const click = () => { Promise.resolve(callback()).catch(() => {}); };
      if (button === 'Mute') {
        // Shows Unmute while muted, like the one under the screen.
        this.handMuteButton = await this.setupSwapButton(wrapper, 'HandMute', at,
          { mute: this.params[icon], unmute: this.params["data-unmute-icon-url"] }, click, 0.36);
        this.updateScreenButtons();
      } else {
        await this.makeIconButton(`FireVPlayer_Hand${button}`, wrapper, at, 0.36, this.params[icon], click);
      }
    }
    if (root !== this.handControls) return;
    if (place.attach === undefined) {
      console.log('[Core] Hand controls put in front of the player.');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (root !== this.handControls) return;
    await scene.LegacyAttachObject(root, uid, place.attach);
    console.log(`[Core] Hand controls attached: ${place.label}.`);
    // Where the hand is, for opening the panel the way the player is looking.
    if (name === 'left' || name === 'right') this.watchWorldPose(root, 'handPose');
  }
  // A world position and rotation just in front of the player, a little below their eyes, tilted
  // back to face them (Unity axes). Waits a few seconds for the head to report, as just after
  // joining it may not have yet.
  async handFrontPose() {
    let head = this.headPose();
    for (let k = 0; k < 10 && !(head && head.position && head.rotation); k++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      head = this.headPose();
    }
    if (!head || !head.position || !head.rotation) return null;
    const q = head.rotation;
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    if (Math.abs(fx) + Math.abs(fz) < 1e-6) return null;
    const yaw = Math.atan2(fx, fz);
    const d = 0.55;
    // pose-update's height is about the floor on Quest (see the panel's frontPose).
    const frontHeight = parseFloat(this.params['playlist-panel-front-height']);
    const y = head.source === 'pose-update' ? head.position.y + (Number.isFinite(frontHeight) ? frontHeight : 1.4) - 0.3 : head.position.y - 0.3;
    return {
      position: new BS.Vector3(head.position.x + Math.sin(yaw) * d, y, head.position.z + Math.cos(yaw) * d),
      rotation: new BS.Vector3(30, yaw * 180 / Math.PI, 0)
    };
  }
  removeHandControls() {
    this.handPose = null;
    this.handMuteButton = null;
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
    const label = text ? await this.makeButtonLabel(name, holder, text) : null;
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
    // Altspace: "auto" draws the screen from the space page's own browser where the client allows
    // it (see claimSpaceSurface), "false" always opens a browser for it.
    this.setOrDefault("space-screen", 'auto');
    // The world video player's size for files (native-video.js); empty matches the browser.
    this.setOrDefault("native-screen-size", '');
    this.setOrDefault("one-for-each-instance", "false");
    this.setOrDefault("instance", location.href);
    this.setOrDefault("playlist", "");
    this.setOrDefault("volume", '40');
    this.setOrDefault("mute", 'false');
    this.setOrDefault("captions", 'true');
    // Shows the screen page's size, zoom and pixel ratio on the screen, for checking its fit.
    this.setOrDefault("screen-debug", 'false');
    this.setOrDefault("untrusted-links", 'false');
    this.setOrDefault("is3d", 'false');
    this.setOrDefault("announce", 'true');
    this.setOrDefault("announce-four-twenty", 'false');
    // Optional buttons in the row under the screen: Reload (this viewer's screen) and Play/Pause
    // (only the host sees it). "false" leaves the row as it was before them.
    this.setOrDefault("reload-button", 'true');
    this.setOrDefault("play-pause-button", 'true');
    this.setOrDefault("hand-controls", 'false');
    // Where the hand buttons start: auto (left wrist in VR, in view on desktop), left, right,
    // view, front or off. Each viewer can choose another in the panel (HAND_PLACES).
    this.setOrDefault("hand-controls-place", 'auto');
    // Fine-tunes where the hand buttons sit on the wrist, in the left hand's own Unity axes
    // (mirrored for the right): "x y z" metres and "x y z" degrees. Empty uses the built-in layout.
    this.setOrDefault("hand-controls-position", '');
    this.setOrDefault("hand-controls-rotation", '');
    this.setOrDefault("playlist-panel-front-height", '1.4');
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

    // Saved playlists for the Lists view: comma separated YouTube playlists and list links.
    this.setOrDefault("playlists", "");

    if (this.params.playlist) {
      // A YouTube playlist, or a link to a list of links (a .txt or .m3u file, a Google Doc, a
      // Drive folder, an archive.org item), which the server reads.
      const extractedId = this.getPlaylistId(this.params.playlist) || this.getListLink(this.params.playlist);
      if (!extractedId) {
        console.warn(`Could not extract a valid playlist ID or list link from provided playlist parameter: "${this.params.playlist}". It will be ignored.`);
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
    if (this.blocked) return;
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
      case Commands.SET_BLOCKED:
        this.setBlocked(json.data && json.data.blocked === true);
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
          this.clickBrowser(json.data.x, json.data.y, json.data.fx, json.data.fy);
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
      case Commands.LISTS_UPDATED:
        if (this.player && json.data && Array.isArray(json.data.lists)) this.player.lists = json.data.lists;
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
    try { this.updateScreenButtons(); } catch (e) { console.error('[Core] Could not update the screen buttons:', e); }
    this.notifyListeners(json);
  }
  // Passes a message to the panel and the other listeners, as if it came from the server.
  notifyListeners(json) {
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
  // A YouTube video id from a bare id or a YouTube link, or false (see MediaSources.youtubeId).
  getId(url){
    if (!url) return false;
    url = url.trim();
    if (url.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(url)) {
      return url;
    }
    if (window.MediaSources && MediaSources.youtubeId) return MediaSources.youtubeId(url);
    // Before media-sources.js has loaded: the same rule, only YouTube's own hosts.
    if (!/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)(?:[\/?#:]|$)/i.test(url)) return false;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|live\/|watch\?v=|\&v=)([^#\&\?\/]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : false;
  }
  // A YouTube playlist id from a bare id or any link with list= in it (a playlist page, or a
  // video in a playlist), or null. The same kinds as the server takes (server/lists.js): playlists
  // (PL), albums (OLAK5uy_), a channel's uploads (UU) and favourites (FL); not mixes (RD).
  getPlaylistId(urlOrId) {
    const s = String(urlOrId || '').trim();
    const kind = /^(PL|OLAK5uy_|UU|FL)[A-Za-z0-9_-]{10,}$/;
    if (kind.test(s)) return s;
    // Only YouTube's own links, as on the server: a list file's link may have list= in it too.
    if (!/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)(?:[\/?#:]|$)/i.test(s)) return null;
    const match = /[?&]list=([^#&?]+)/.exec(s);
    return match && kind.test(match[1]) ? match[1] : null;
  }
  // A link that may be a list of links (a .txt or .m3u file, a Google Doc, a Drive folder, an
  // archive.org item), or null. Only the server can tell for sure, as it reads the file; this
  // only rules out what can't be one (YouTube links, single videos and streams, non-links).
  getListLink(input) {
    const s = String(input || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > 2000) return null;
    const media = window.MediaSources ? MediaSources.detect(s) : null;
    // Drive file links play as videos, but as a playlist setting they are text files of links. A
    // Tubi series is a list of its episodes (the server reads it as one).
    if (media && !media.drive && !(media.type === 'tubi' && media.kind === 'series')) return null;
    return s;
  }
  // A single video or stream link (YouTube, Twitch, a .m3u8 or VRCDN stream...), or null. In the
  // playlists setting one shows in Lists as a list of just that video.
  getSingleLink(input) {
    const s = String(input || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > 2000 || !window.MediaSources) return null;
    return MediaSources.detect(s) ? s : null;
  }
  // The saved playlists for the Lists view: the default playlist (the playlist setting), then the
  // playlists setting's comma separated YouTube playlists, list links and single video or stream
  // links, at most 10.
  getSavedLists() {
    const out = [];
    const seen = new Set();
    const add = (raw, isDefault) => {
      const s = String(raw || '').trim().replace(/[\s,]+$/, ''); // a stray comma at the end
      const id = s && (this.getPlaylistId(s) || this.getListLink(s) || (!isDefault && this.getSingleLink(s)));
      if (!id || seen.has(id) || out.length >= 10) return;
      seen.add(id);
      out.push({ id, label: this.listLabel(id), isDefault: !!isDefault });
    };
    add(this.params && this.params.playlist, true);
    String((this.params && this.params.playlists) || '').split(/\s*,\s*(?=https?:\/\/|PL|OLAK5uy_|UU|FL)|\s*\n\s*/).forEach(s => add(s, false));
    return out;
  }
  // A name for a saved list until the server says what it's called.
  listLabel(id) {
    if (this.getPlaylistId(id)) return 'YouTube playlist';
    const single = this.getSingleLink(id) && MediaSources.detect(id);
    if (single && single.type !== 'archive') {
      const names = { youtube: 'YouTube video', twitch: single.channel ? `Twitch: ${single.channel}` : 'Twitch video', twitchclip: 'Twitch clip',
        vimeo: 'Vimeo video', vdoninja: 'VDO.Ninja stream', hls: 'Stream', mpegts: single.live ? 'Live stream' : 'Video', file: 'Video file',
        tubi: single.kind === 'series' ? 'Tubi series' : 'Tubi video', nasa: 'NASA+ video' };
      return names[single.type] || 'Video';
    }
    try {
      const u = new URL(id);
      if (/docs\.google\.com$/i.test(u.hostname)) return 'Google Doc';
      if (/drive\.google\.com$/i.test(u.hostname)) return /folders|embeddedfolderview/.test(u.pathname) ? 'Google Drive folder' : 'Google Drive file';
      if (/archive\.org$/i.test(u.hostname)) return `archive.org: ${u.pathname.split('/').filter(Boolean)[1] || 'item'}`;
      if (/tubitv\.com$/i.test(u.hostname)) return `Tubi: ${(u.pathname.split('/').filter(Boolean)[1] || 'category').replace(/_/g, ' ')}`;
      if (/plus\.nasa\.gov$/i.test(u.hostname)) return 'NASA+ series';
      let name = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      try { name = decodeURIComponent(name); } catch (e) {}
      return name.replace(/\.(txt|m3u)$/i, '') || u.hostname;
    } catch (e) {
      return 'Playlist';
    }
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
    if (this.blocked) return;
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
    if (this.blocked) return;
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
    if (this.blocked) return;
    this.sendBrowserMessage({path: Commands.SET_VOLUME, data: num});
  }
  destroy() { // To Use : window.cleanupVideoPlayer();
    console.log("Cleaning up Fire-V-Player instance...");
    // Builds still running (buttons, screen, hand controls) stop when they see this.
    this.destroyed = true;
    clearTimeout(this.handRejoinTimer);
    clearTimeout(this.headRejoinTimer);
    clearInterval(this.blockedTimer);
    clearInterval(this.secondScreenTimer);
    this.blockedTimer = null;
    clearTimeout(this.adminWriteTimer);
    this.adminWriteTimer = null;
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
    this.releaseSecondScreens(); // black, and findable by the next player
    // The space page goes back to how it was (Altspace's space-page screen).
    this.releaseSpaceSurface();
    this.removeHandControls();
    this.worldObjects.slice().forEach(go => this.destroyObject(go));
    this.worldObjects = [];
    const scene = this.banterScene();
    if (scene && typeof scene.Off === 'function') {
      if (this.onPoseUpdate) scene.Off('pose-update', this.onPoseUpdate);
      if (this.onHeadPose) scene.Off('pose-update', this.onHeadPose);
      if (this.onHandUserLeft) scene.Off('user-left', this.onHandUserLeft);
      if (this.onHandUserJoined) scene.Off('user-joined', this.onHandUserJoined);
      if (this.onHeadUserLeft) scene.Off('user-left', this.onHeadUserLeft);
      if (this.onHeadUserJoined) scene.Off('user-joined', this.onHeadUserJoined);
    }
    this.onPoseUpdate = this.onHeadPose = this.onHandUserLeft = this.onHandUserJoined = this.onHeadUserLeft = this.onHeadUserJoined = null;
    this.watchingHandUser = false;
    console.log("Removed the world's objects.");

    // Remove any global references to this instance
    this.browser = null;
    this.playlistContainer = null;
    this.playlistButtonHolder = null;
    this.playlistButtonText = null;
    this.muteButton = this.playPauseButton = null;
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