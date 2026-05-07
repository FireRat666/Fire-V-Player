(() => {
  // Capture the current script element immediately, before any async work.
  const karaokePlayerScript = document.currentScript;
  const currentScriptUrl = new URL(karaokePlayerScript.src);

  // --- Banter Readiness Gate ---
  // Wait for the Banter BS SDK to fully initialise and fire "unity-loaded".
  // Only at that point is window.user guaranteed to contain the real Banter identity.
  // If BS never loads within 30 seconds we assume this is a non-Banter browser context
  // and proceed immediately so the player still works outside of Banter.
  const waitForBanter = () => new Promise(resolve => {
    const fallbackTimeout = setTimeout(() => {
      console.warn('Vidya (karaoke): bs-loaded/unity-loaded timed out after 30s. Assuming non-Banter context.');
      resolve();
    }, 30000);

    const init = () => {
      clearTimeout(fallbackTimeout);
      const banterScene = BS.BanterScene.GetInstance();
      banterScene.On('unity-loaded', () => {
        resolve();
      });
    };

    if (window.BS) {
      init();
    } else {
      window.addEventListener('bs-loaded', init);
    }
  });

  waitForBanter().then(() => {
    // Dynamically load the base player script only once Banter is ready.
    const baseScript = document.createElement("script");
    baseScript.setAttribute("src", `${currentScriptUrl.origin}/base-player.js`);

    // Once the base player script is loaded, define and instantiate our specific player.
    baseScript.addEventListener("load", () => {
      var KaraokePlayer = class extends BasePlayer {
        constructor() {
          // Pass the original script element to the base class.
          super(karaokePlayerScript);
          this.init();
        }

        async init() {
          // Run the common initialization sequence from BasePlayer.
          await super.init();

          // Now run the karaoke-specific setup.
          this.core.isKaraoke = true; // Set mode after core init
          await this.core.setupWebsocket("space", d => this.core.parseMessage(d), () => {
            this.core.sendMessage({path: "instance", data: this.core.params.instance, u: window.user});
            this.core.sendMessage({path: Commands.SET_INSTANCE_MODE, data: 'karaoke'});
          });
          const url = `https://${window.APP_CONFIG.HOST_URL}/?youtube=${encodeURIComponent(this.core.params.youtube)}&start=${this.core.params.start}&playlist=${this.core.params.playlist}&mute=${this.core.params.mute}&volume=${this.core.tempVolume}&instance=${this.core.params.instance}&user=${window.user.id}-_-${encodeURIComponent(window.user.name)}&mode=karaoke`;
          this.core.setupBrowserElement(url);
          this.core.setupJoinLeaveButton();
        }
      }
      window.karaokePlayerInstance = new KaraokePlayer();
    }, false);

    document.body.appendChild(baseScript);
  });
})();