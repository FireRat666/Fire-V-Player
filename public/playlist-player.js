// Shared start-up for both modes (playlist and karaoke).
// Used by playlist.js / karaoke.js (a <script> tag in the world page) and snippet.js (a <bs-snippet>
// element). `source` is anything with `src` and `getAttribute(name)`: the original <script>
// element, or a small adapter around a <bs-snippet> element.
(() => {
  const FVP = window.FireVPlayer = window.FireVPlayer || {};
  if (FVP.startPlaylistPlayer) return;

  // Wait for the BS SDK to initialise and Unity to load. Only then is the local user's identity
  // reliable. If BS never loads within 30 seconds this is a non-Banter browser, so carry on.
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
        const banterScene = BS.BanterScene.GetInstance();
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

  FVP.loadScript = (src) => new Promise(resolve => {
    const s = document.createElement("script");
    s.setAttribute("src", src);
    s.addEventListener("load", () => resolve(true), false);
    s.addEventListener("error", () => { console.error(`Vidya: failed to load ${src}`); resolve(false); }, false);
    document.body.appendChild(s);
  });

  // Only one player (of either mode) runs on a page.
  const running = () => window.playlistPlayerInstance || window.karaokePlayerInstance;

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
  FVP.startPlaylistPlayer = (source) => FVP.startPlayer(source, 'playlist');
  FVP.startKaraokePlayer = (source) => FVP.startPlayer(source, 'karaoke');

  const startPlayer = async (source, mode) => {
    const origin = new URL(source.src).origin;
    const karaoke = mode === 'karaoke';
    await FVP.waitForBanter(mode);

    if (typeof BasePlayer === 'undefined') {
      const loaded = await FVP.loadScript(`${origin}/base-player.js`);
      if (!loaded || typeof BasePlayer === 'undefined') {
        console.error(`Vidya: could not load ${origin}/base-player.js, so the ${mode} player can't start.`);
        return;
      }
    }

    const Player = class extends BasePlayer {
      constructor() {
        super(source);
        this.ready = this.init().catch(e => console.error(`Vidya: ${mode} player failed to start.`, e));
      }

      async init() {
        // Run the common initialization sequence from BasePlayer.
        await super.init();
        this.core.isKaraoke = karaoke;

        await this.core.setupWebsocket("space", d => this.core.parseMessage(d), () => {
          this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user});
          this.core.sendMessage({path: Commands.SET_INSTANCE_MODE, data: mode});
        });
        // Pass the mode to the player iframe so it knows which skip time to use.
        const proto = this.core.hostProtocol || (this.core.hostUrl.startsWith('localhost') || this.core.hostUrl.startsWith('127.0.0.1') ? 'http' : 'https');
        const url = `${proto}://${this.core.hostUrl}/?youtube=${encodeURIComponent(this.core.params.youtube)}&start=${this.core.params.start}&playlist=${this.core.params.playlist}&mute=${this.core.params.mute}&volume=${this.core.tempVolume}&instance=${encodeURIComponent(this.core.params.instance)}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}&mode=${mode}`;
        this.core.setupBrowserElement(url);
        if (karaoke) this.core.setupJoinLeaveButton();

        // In the new SDK the 2D menu page may not be available, so the Playlist / Singers button
        // opens an in-world UI Toolkit panel instead.
        if (this.core.shouldUsePlaylistPanel()) {
          await this.core.setupPlaylistPanel();
        }
      }
    };
    const instance = new Player();
    if (karaoke) window.karaokePlayerInstance = instance;
    else window.playlistPlayerInstance = instance;
    return instance;
  };
})();
