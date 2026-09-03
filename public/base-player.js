var BasePlayer = class {
  constructor(currentScript) {
    // The 'currentScript' is passed in from the child class (e.g., PlaylistPlayer)
    // because document.currentScript would be null for this dynamically loaded script.
    this.currentScript = currentScript;
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
    // This is the common initialization sequence shared by all player types.
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
    await this.core.setupCommandsScript();
    await this.core.init();
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
    const currentScriptUrl = new URL(this.currentScript.src);
    const configUrl = `${currentScriptUrl.origin}/config.js`;
    return new Promise(resolve => {
      let myScript = document.createElement("script");
      myScript.setAttribute("src", configUrl);
      myScript.addEventListener ("load", resolve, false);
      document.body.appendChild(myScript);
    });
  }
}