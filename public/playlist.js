(() => {
  // Capture the current script element immediately, before any async work.
  const playlistPlayerScript = document.currentScript;
  const currentScriptUrl = new URL(playlistPlayerScript.src);

  // --- Banter Readiness Gate ---
  // Wait for the Banter BS SDK to fully initialise and fire "unity-loaded".
  // Only at that point is window.user guaranteed to contain the real Banter identity.
  // If BS never loads within 30 seconds we assume this is a non-Banter browser context
  // and proceed immediately so the player still works outside of Banter.
  const waitForBanter = () => new Promise(resolve => {
    const fallbackTimeout = setTimeout(() => {
      console.warn('Vidya (playlist): bs-loaded/unity-loaded timed out after 30s. Assuming non-Banter context.');
      resolve();
    }, 30000);

    const init = () => {
      console.log("VIDYA: INIT");
      clearTimeout(fallbackTimeout);
      const banterScene = BS.BanterScene.GetInstance();
      if (banterScene.unityLoaded) {
        console.log("VIDYA: UNITY LOADED");
        resolve();
      } else {
          banterScene.On('unity-loaded', () => {
            resolve();
          });
      }
    };

    if (window.BS) {
      console.log("VIDYA: window.BS");
      init();
    } else {
      window.addEventListener('bs-loaded', init);
    }
  });

  waitForBanter().then(() => {
      console.log("VIDYA: then");
      console.log(`VIDYA: ${playlistPlayerScript}`);
      console.log(`VIDYA: ${currentScriptUrl}`);
    // Dynamically load the base player script only once Banter is ready.
    const baseScript = document.createElement("script");
    baseScript.setAttribute("src", `${currentScriptUrl}/base-player.js`);

    // Once the base player script is loaded, define and instantiate our specific player.
    baseScript.addEventListener("load", () => {
      var PlaylistPlayer = class extends BasePlayer {
        constructor() {
          // Pass the original script element to the base class.
          super(playlistPlayerScript);
          this.init();
        }

        async init() {
          // Run the common initialization sequence from BasePlayer.
          await super.init();

          // Now run the playlist-specific setup.
          await this.core.setupWebsocket("space", d => this.core.parseMessage(d), () => {
            this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user});
            this.core.sendMessage({path: Commands.SET_INSTANCE_MODE, data: 'playlist'});
          });
          // Pass the mode to the player iframe so it knows which skip time to use.
          const url = `${currentScriptUrl}?youtube=${encodeURIComponent(this.core.params.youtube)}&start=${this.core.params.start}&playlist=${this.core.params.playlist}&mute=${this.core.params.mute}&volume=${this.core.tempVolume}&instance=${this.core.params.instance}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}&mode=playlist`;
          this.core.setupBrowserElement(url);
        }
      }
      window.playlistPlayerInstance = new PlaylistPlayer();
    }, false);

    document.body.appendChild(baseScript);
  });
})();
