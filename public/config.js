/**
 * @fileoverview Frontend host domain configuration and automatic resolution logic.
 * Detects current environment domain against configured candidates (e.g. localhost, test, prod).
 * @module public/config
 */

/**
 * @typedef {Object} AppConfig
 * @property {string|string[]} HOST_URL - Active host domain, or array of supported domains.
 * @property {string|string[]} [_RAW_HOST_URL] - Unresolved raw host URL configuration.
 * @property {string[]} [HOST_URLS] - List of sanitized host domain candidates.
 * @property {function(string|string[]): string} [resolveHostUrl] - Resolves matched domain for current environment.
 * @property {function(string): string} [cleanHost] - Strips protocols and trailing slashes.
 */

window.APP_CONFIG = {
  HOST_URL: [
    'vidya.firer.at',
    'testya.firer.at',
    'localhost:3000'
  ]
};

// Automatic resolution for multiple domains / dev testing:
(() => {
  /**
   * Sanitizes a host string by stripping protocols ('https://', 'http://') and trailing slashes.
   * @param {string} url - Raw URL or host string.
   * @returns {string} Cleaned host domain.
   */
  function cleanHost(url) {
    if (!url || typeof url !== 'string') return '';
    return url.replace(/^[a-zA-Z]+:\/\//, '').replace(/\/+$/, '').trim();
  }

  /**
   * Scans script tags and window location to collect candidate host domains.
   * @returns {string[]} List of detected host domains.
   */
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
        if (src && /config\.js|base-player\.js|playlist\.js|playlist-player\.js|snippet\.js|karaoke\.js|player\.js|core\.js/.test(src)) {
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

  /**
   * Resolves the best matching host URL for the current environment from configured candidates.
   * Performs exact matching first, then falls back to hostname-only matching (ignoring port).
   *
   * @param {string|string[]} hostConfig - Configured host URL or array of candidate hosts.
   * @returns {string} The resolved active host domain.
   */
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

    // 1. Search for an exact match first across all candidates
    for (const candidate of candidates) {
      const cleanedCandidate = cleanHost(candidate);
      const exactMatch = cleanedHosts.find(h => h === cleanedCandidate);
      if (exactMatch) {
        return exactMatch;
      }
    }

    // 2. Fall back to hostname-only matching (e.g. matching localhost to localhost:3000)
    for (const candidate of candidates) {
      const cleanedCandidate = cleanHost(candidate);
      const candNoPort = cleanedCandidate.split(':')[0];
      const hostnameMatch = cleanedHosts.find(h => h.split(':')[0] === candNoPort);
      if (hostnameMatch) {
        return hostnameMatch;
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