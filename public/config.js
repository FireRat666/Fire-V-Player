// This is the central configuration file for the Fire-V-Player.
// You can specify a single domain or an array of domains in 'HOST_URL'.
// When multiple domains are configured, the player automatically detects and uses
// the domain matching the current environment, making it easy to test on dev servers
// or point multiple domains to the same app without changing this file.
// Do not include "https://", "wss://", or a trailing slash.
// Examples:
//   HOST_URL: ['vidya.firer.at', 'localhost:3000']
//   HOST_URL: 'vidya.firer.at'

window.APP_CONFIG = {
  HOST_URL: [
    'vidya.firer.at',
    'localhost:3000'
  ]
};

// Automatic resolution for multiple domains / dev testing:
(() => {
  function cleanHost(url) {
    if (!url || typeof url !== 'string') return '';
    return url.replace(/^[a-zA-Z]+:\/\//, '').replace(/\/+$/, '').trim();
  }

  function getCandidateHosts() {
    const candidates = [];

    // 1. Script tag that loaded this config (or other player scripts)
    if (typeof document !== 'undefined') {
      if (document.currentScript && document.currentScript.src) {
        try {
          candidates.push(new URL(document.currentScript.src).host);
        } catch (_) {}
      }

      // Check existing script tags for player scripts
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src;
        if (src && /config\.js|base-player\.js|playlist\.js|karaoke\.js|player\.js|core\.js/.test(src)) {
          try {
            candidates.push(new URL(src).host);
          } catch (_) {}
        }
      }
    }

    // 2. Current window location
    if (typeof window !== 'undefined' && window.location && window.location.host) {
      candidates.push(window.location.host);
    }

    return candidates.filter(Boolean);
  }

  function resolveHostUrl(hostConfig) {
    let hosts = [];
    if (Array.isArray(hostConfig)) {
      hosts = hostConfig;
    } else if (typeof hostConfig === 'string') {
      hosts = hostConfig.split(',').map(h => h.trim());
    }

    const cleanedHosts = hosts.map(cleanHost).filter(Boolean);
    if (cleanedHosts.length === 0) {
      return '';
    }
    if (cleanedHosts.length === 1) {
      return cleanedHosts[0];
    }

    const candidates = getCandidateHosts();

    // Try to find a matching configured host among candidates
    for (const candidate of candidates) {
      const cleanedCandidate = cleanHost(candidate);
      const matched = cleanedHosts.find(h => {
        if (h === cleanedCandidate) return true;
        // Match hostname ignoring port (e.g. localhost matching localhost:3000)
        const hNoPort = h.split(':')[0];
        const candNoPort = cleanedCandidate.split(':')[0];
        return hNoPort === candNoPort;
      });
      if (matched) {
        return matched;
      }
    }

    // Default to the first configured host if no specific match is found
    return cleanedHosts[0];
  }

  if (window.APP_CONFIG) {
    const rawHost = window.APP_CONFIG.HOST_URL;
    window.APP_CONFIG._RAW_HOST_URL = rawHost;
    window.APP_CONFIG.HOST_URLS = Array.isArray(rawHost)
      ? rawHost.map(cleanHost)
      : (typeof rawHost === 'string' ? rawHost.split(',').map(cleanHost).filter(Boolean) : []);
    window.APP_CONFIG.resolveHostUrl = resolveHostUrl;
    window.APP_CONFIG.cleanHost = cleanHost;
    window.APP_CONFIG.HOST_URL = resolveHostUrl(rawHost);
  }
})();