/**
 * @fileoverview Screen viewport scaling and aspect-ratio adapter.
 * Ensures the video stage fills the browser viewport cleanly across VR headsets (e.g. Meta Quest
 * Android WebView device pixel ratio) and desktop displays, preventing letterboxing and zoom artifacts.
 * @module public/fit-screen
 */

(() => {
  const stage = document.getElementById('stage');
  if (!stage) return;
  const debug = new URLSearchParams(location.search).get('screen-debug') === 'true';
  let info = null;
  if (debug) {
    info = document.createElement('div');
    Object.assign(info.style, {
      position: 'fixed', left: '8px', bottom: '8px', right: '8px', zIndex: '100', padding: '6px 10px', whiteSpace: 'pre-wrap',
      font: '14px monospace', color: '#fff', background: 'rgba(0, 0, 0, 0.75)', pointerEvents: 'none'
    });
    document.body.appendChild(info);
  }

  let last = '';

  /**
   * Calculates current visual viewport dimensions, device pixel ratio, and zoom level.
   * Adjusts stage element CSS transform scaling to perfectly fit physical display pixels.
   * @returns {void}
   */
  const fit = () => {
    const vv = window.visualViewport;
    const width = vv ? vv.width : window.innerWidth;     // what's showing, in CSS pixels
    const height = vv ? vv.height : window.innerHeight;
    const left = vv ? vv.offsetLeft : 0;
    const top = vv ? vv.offsetTop : 0;
    const zoom = vv && vv.scale > 0 ? vv.scale : 1;
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    // Device pixels per CSS pixel of what's showing. 1 on a PC.
    const k = Math.max(1, dpr * zoom);
    const key = [width, height, left, top, k].map(n => Math.round(n * 100)).join(',');
    if (key !== last) {
      last = key;
      Object.assign(stage.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${width * k}px`, height: `${height * k}px`,
        transform: k === 1 ? 'none' : `scale(${1 / k})`
      });
    }
    // The page itself never needs to scroll.
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    if (info) {
      const doc = document.documentElement;
      info.textContent = [
        `window ${window.innerWidth} x ${window.innerHeight}, screen ${screen.width} x ${screen.height}`,
        `showing ${width.toFixed(1)} x ${height.toFixed(1)} at ${left.toFixed(1)}, ${top.toFixed(1)}`,
        `zoom ${zoom.toFixed(3)}, devicePixelRatio ${dpr.toFixed(3)}, stage ${Math.round(width * k)} x ${Math.round(height * k)}`,
        `page ${doc.scrollWidth} x ${doc.scrollHeight}, scrolled ${window.scrollX}, ${window.scrollY}`,
        navigator.userAgent
      ].join('\n');
    }
  };

  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('scroll', fit);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }
  // The WebView doesn't always say when it changes the zoom.
  setInterval(fit, 1000);
})();
