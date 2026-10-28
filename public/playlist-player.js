/**
 * @fileoverview Unified launcher and coordinator for playlist and karaoke modes.
 * Waits for Banter/Unity environment readiness, dynamically loads BasePlayer,
 * resolves space admin mode overrides, binds WebSockets, and configures in-world screens.
 * @module public/playlist-player
 */

(() => {
  const FVP = window.FireVPlayer = window.FireVPlayer || {};
  if (FVP.startPlaylistPlayer) return;

  /**
   * Waits for the Banter SDK and Unity scene to finish initialization.
   * Resolves immediately if already loaded or after a 30s timeout fallback for non-Banter browsers.
   *
   * @param {string} label - Context label for debugging logs.
   * @returns {Promise<void>}
   */
  FVP.waitForBanter = (label) => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const fallbackTimeout = setTimeout(() => {
      console.warn(`Vidya (${label}): bs-loaded/unity-loaded timed out after 30s. Assuming non-Banter context.`);
      finish();
    }, 30000);

    const init = () => {
      console.log("VIDYA: INIT");
      try {
        const banterScene = (BS.Scene || BS.BanterScene).GetInstance();
        clearTimeout(fallbackTimeout);
        if (banterScene.unityLoaded) {
          console.log("VIDYA: UNITY LOADED");
          finish();
        } else {
          banterScene.On('unity-loaded', finish);
        }
      } catch (e) {
        console.error('Vidya: Banter detection failed, continuing without it.', e);
        clearTimeout(fallbackTimeout);
        finish();
      }
    };

    if (window.BS) init();
    else window.addEventListener('bs-loaded', init);
  });

  /**
   * Loads an external script file into the document head/body.
   * @param {string} src - Script source URL.
   * @returns {Promise<boolean>} True if loaded successfully, false on error.
   */
  FVP.loadScript = (src) => new Promise(resolve => {
    const s = document.createElement("script");
    s.setAttribute("src", src);
    s.addEventListener("load", () => resolve(true), false);
    s.addEventListener("error", () => { console.error(`Vidya: failed to load ${src}`); resolve(false); }, false);
    document.body.appendChild(s);
  });

  // Only one player (of either mode) runs on a page.
  const running = () => window.playlistPlayerInstance || window.karaokePlayerInstance;

  /**
   * Starts a video player in the specified mode ('playlist' or 'karaoke').
   * Prevents concurrent player instances on the same page.
   *
   * @param {HTMLScriptElement|Object} source - The launcher script or snippet element.
   * @param {'playlist'|'karaoke'} mode - Desired startup mode.
   * @returns {Promise<Object|undefined>} The player instance, or undefined if a player is already
   *   running or base-player.js couldn't load. The instance may still be starting up: await
   *   `instance.ready` before using it.
   */
  FVP.startPlayer = async (source, mode) => {
    mode = mode === 'karaoke' ? 'karaoke' : 'playlist';
    if (running() || FVP.playerStarting) {
      console.warn("Vidya: a player is already running on this page. Only one is supported.");
      return;
    }
    FVP.playerStarting = true;
    try {
      return await startPlayer(source, mode);
    } finally {
      // A failed start can be retried; a successful one is guarded by running().
      FVP.playerStarting = false;
    }
  };

  /** Launches a player in Playlist mode (see startPlayer). @param {Object} source @returns {Promise<Object|undefined>} Await `instance.ready` before using it. */
  FVP.startPlaylistPlayer = (source) => FVP.startPlayer(source, 'playlist');
  /** Launches a player in Karaoke mode (see startPlayer). @param {Object} source @returns {Promise<Object|undefined>} Await `instance.ready` before using it. */
  FVP.startKaraokePlayer = (source) => FVP.startPlayer(source, 'karaoke');

  /**
   * Internal routine setting up the specialized Player class extending BasePlayer.
   *
   * @param {Object} source - Script element or adapter.
   * @param {'playlist'|'karaoke'} defaultMode - Default operating mode.
   * @returns {Promise<Object|undefined>} The player, still starting up (await its `ready`), or
   *   undefined if base-player.js couldn't load.
   */
  const startPlayer = async (source, defaultMode) => {
    const origin = new URL(source.src).origin;
    await FVP.waitForBanter(defaultMode);

    if (typeof BasePlayer === 'undefined') {
      const loaded = await FVP.loadScript(`${origin}/base-player.js`);
      if (!loaded || typeof BasePlayer === 'undefined') {
        console.error(`Vidya: could not load ${origin}/base-player.js, so the ${defaultMode} player can't start.`);
        return;
      }
    }

    const Player = class extends BasePlayer {
      constructor() {
        super(source);
        this.ready = this.init().catch(e => console.error(`Vidya: ${defaultMode} player failed to start.`, e));
      }

      async init() {
        // Run the common initialization sequence from BasePlayer.
        await super.init();
        const core = this.core;
        core.defaultMode = defaultMode;
        core.modeOverride = await core.loadModeOverride();
        const mode = core.modeOverride || defaultMode;
        const karaoke = mode === 'karaoke';
        core.isKaraoke = karaoke;
        if (core.modeOverride && core.modeOverride !== defaultMode) {
          console.log(`Vidya: a space admin set ${mode} mode, so starting in that instead of ${defaultMode}.`);
        }

        await core.setupWebsocket("space", d => core.parseMessage(d), () => {
          core.sendMessage({path: "instance", data: core.params.instance, u: window.user, untrusted: core.allowUntrusted === true});
          // The current mode, which may have changed since the player started.
          core.sendMessage({path: Commands.SET_INSTANCE_MODE, data: core.getMode()});
        });
        // Pass the mode to the player iframe so it knows which skip time to use.
        const proto = this.core.hostProtocol || (this.core.hostUrl.startsWith('localhost') || this.core.hostUrl.startsWith('127.0.0.1') ? 'http' : 'https');
        const url = `${proto}://${this.core.hostUrl}/?youtube=${encodeURIComponent(this.core.params.youtube)}&start=${this.core.params.start}&playlist=${encodeURIComponent(this.core.params.playlist)}&mute=${this.core.params.mute}&volume=${this.core.tempVolume}&instance=${encodeURIComponent(this.core.params.instance)}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}&mode=${mode}&captions=${core.loadCaptionsPref()}&untrusted-links=${core.allowUntrusted === true}&screen-debug=${core.params['screen-debug'] === 'true'}`;
        // This viewer's own screen resolution, if they picked one in the panel.
        core.loadResolutionPref();
        // Files play on the world's own video player instead of the browser (native-video.js).
        await core.setupScript(null, "media-sources");
        await core.setupScript(null, "native-video");
        await this.core.setupBrowserElement(url);
        if (karaoke) {
          try { await this.core.setupJoinLeaveButton(); }
          catch (e) { console.error('Vidya: could not create the Singers button.', e); }
        }

        // In the new SDK the 2D menu page may not be available, so the Playlist / Singers button
        // opens an in-world UI Toolkit panel instead.
        if (this.core.shouldUsePlaylistPanel()) {
          await this.core.setupPlaylistPanel();
        }
        // An admin may have changed the mode while this was starting, so check once more.
        core.watchModeOverride();
        // (The local copy can still be empty here, so an empty one changes nothing.)
        const latest = core.readModeOverride();
        if (latest && latest !== core.modeOverride) {
          core.modeOverride = latest;
          await core.switchMode(latest || defaultMode);
        }
      }
    };
    const instance = new Player();
    if (defaultMode === 'karaoke') window.karaokePlayerInstance = instance;
    else window.playlistPlayerInstance = instance;
    return instance;
  };
})();
