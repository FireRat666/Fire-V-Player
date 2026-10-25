/**
 * @fileoverview Creator SDK / Banter snippet entry point for Fire-V-Player (`<bs-snippet>`).
 * Adapts Unity Inspector coordinate systems, transforms Euler rotations, handles
 * control-follow-screen offsets, and launches the player instance.
 * @module public/snippet
 */

(() => {
  const SNIPPET_NAME = 'fire-v-player';
  const thisScript = document.currentScript;

  /** Parses whitespace/comma delimited numbers into an array. @param {string} str @returns {number[]} */
  const parse = (str) => String(str || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  /** Formats an array of numbers into a space-separated string. @param {number[]} arr @returns {string} */
  const fmt = (arr) => arr.map(n => (Object.is(n, -0) ? 0 : n)).join(' ');

  /**
   * Converts Unity coordinates to script-tag / A-Frame convention (mirrors Z axis).
   * @param {string} value - Space separated numeric string.
   * @param {'pos'|'rot'|'scale'} kind - Transform attribute kind.
   * @returns {string} Converted coordinate string.
   */
  const convert = (value, kind) => {
    const p = parse(value);
    if (kind === 'scale') {
      if (p.length === 1 && !isNaN(p[0])) return fmt([p[0], p[0], p[0]]);
      return value;
    }
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return value;
    const [x, y, z] = p;
    return kind === 'pos' ? fmt([x, y, -z]) : fmt([-x, -y, z]);
  };

  const KIND = {
    'position': 'pos', 'button-position': 'pos', 'box-trigger-position': 'pos', 'singer-button-position': 'pos',
    'playlist-panel-position': 'pos', 'playlist-panel-offset': 'pos',
    'rotation': 'rot', 'button-rotation': 'rot', 'box-trigger-rotation': 'rot', 'singer-button-rotation': 'rot',
    'playlist-panel-rotation': 'rot',
    'scale': 'scale', 'button-scale': 'scale', 'box-trigger-scale': 'scale'
  };

  // Rotations in Unity's convention (Euler degrees applied Z, then X, then Y), for placing the
  // buttons relative to the screen.
  const D = Math.PI / 180;
  /** Multiplies two quaternions [x, y, z, w]. */
  const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
  /** Creates axis-angle quaternion. */
  const qAxis = (axis, deg) => { const q = [0, 0, 0, Math.cos(deg * D / 2)]; q[axis] = Math.sin(deg * D / 2); return q; };
  /** Converts Euler angles [x, y, z] to quaternion. */
  const qEuler = ([x, y, z]) => qMul(qMul(qAxis(1, y), qAxis(0, x)), qAxis(2, z));
  /** Converts quaternion to Euler angles [x, y, z]. */
  const qToEuler = ([x, y, z, w]) => {
    const r = (v) => Math.round(((v / D) % 360 + 360) % 360 * 1000) / 1000;
    return [
      r(Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z))))),
      r(Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y))),
      r(Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)))
    ];
  };
  /** Rotates a 3D vector by a quaternion. */
  const qRotate = (q, v) => {
    const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
    return [p[0], p[1], p[2]];
  };
  /** Parses a 3-element numeric vector from string or falls back to default. */
  const vec = (str, def) => { const p = parse(str); return p.length >= 3 && !p.slice(0, 3).some(isNaN) ? p.slice(0, 3) : def; };
  const round = (v) => v.map(n => Math.round(n * 1000) / 1000);

  /**
   * Adapts a `<bs-snippet>` DOM element to provide the interface expected by `BasePlayer` / `playlist-player.js`.
   *
   * @param {HTMLElement} el - The `<bs-snippet>` DOM element.
   * @returns {Object} Adapted source descriptor.
   */
  const adapter = (el) => {
    const scriptUrl = new URL(el.getAttribute('script') || (thisScript && thisScript.src) || 'https://vidya.firer.at/snippet.js', location.href);
    const attr = (name) => (el.getAttribute(name) || '').trim();

    // controls-follow-screen: button-position / playlist-panel-position (and their rotations) are
    // offsets from the screen instead of world values, so they move with it. Their gizmos then
    // don't line up, as a gizmo can only show a setting's own value.
    const follow = attr('controls-follow-screen') === 'true';
    const screenPos = vec(attr('position'), [0, 0, 0]);
    const screenQ = qEuler(vec(attr('rotation'), [0, 0, 0]));

    // A vector that isn't "0 0 0", or null.
    const setVec = (name) => { const v = vec(attr(name), null); return v && v.some(n => n !== 0) ? v : null; };

    const relative = (name) => {
      if (name === 'playlist-panel-position') return null; // the panel's own offset mode handles it
      if (name === 'playlist-panel-offset') {
        const v = attr('playlist-panel-position') || attr('playlist-panel-offset');
        return v ? convert(v, 'pos') : null;
      }
      if (name === 'button-position') {
        // "0 0 0" counts as empty (see below), so the buttons go under the screen.
        const off = setVec(name);
        if (!off) return null;
        const r = qRotate(screenQ, off);
        return convert(fmt(round([screenPos[0] + r[0], screenPos[1] + r[1], screenPos[2] + r[2]])), 'pos');
      }
      if (name === 'button-rotation') {
        const rot = vec(attr(name), null);
        return rot ? convert(fmt(qToEuler(qMul(screenQ, qEuler(rot)))), 'rot') : null;
      }
      return undefined;
    };

    // The singer button (karaoke). With a position it's placed in the world (or from the screen,
    // with controls-follow-screen) instead of from the buttons. Its rotation then defaults to
    // the script tag's tilt (-30 180 0 in A-Frame, 30 -180 0 in Unity) turned with the screen.
    // "0 0 0" counts as empty, like button-position: snippets default these to 0 0 0 so Unity
    // shows X, Y and Z fields (an empty value shows as a single text box).
    const SINGER_TILT = [30, -180, 0];
    const singer = (name) => {
      const pos = setVec('singer-button-position');
      if (!pos) return name === 'singer-button-space' ? null : setVec(name) ? undefined : null; // the default, from the buttons
      if (name === 'singer-button-space') return 'world';
      if (name === 'singer-button-position') {
        if (!follow) return convert(fmt(pos), 'pos');
        const r = qRotate(screenQ, pos);
        return convert(fmt(round([screenPos[0] + r[0], screenPos[1] + r[1], screenPos[2] + r[2]])), 'pos');
      }
      const rot = setVec('singer-button-rotation');
      if (rot && !follow) return convert(fmt(rot), 'rot');
      return convert(fmt(qToEuler(qMul(screenQ, qEuler(rot || SINGER_TILT)))), 'rot');
    };

    const karaoke = attr('karaoke').toLowerCase() === 'true' || attr('mode').toLowerCase() === 'karaoke';
    return {
      mode: karaoke ? 'karaoke' : 'playlist',
      src: `${scriptUrl.origin}/${karaoke ? 'karaoke' : 'playlist'}.js`,
      snippet: el,
      getAttribute(name) {
        // Not the element's own "instance" (BSSnippet's per-placement id): without a room the
        // player falls back to the space URL.
        if (name === 'instance') return el.getAttribute('room') || null;
        if (name === 'singer-button-space' || name === 'singer-button-position' || name === 'singer-button-rotation') {
          const v = singer(name);
          if (v !== undefined) return v;
        }
        if (follow) {
          const v = relative(name);
          if (v !== undefined) return v;
        }
        const v = el.getAttribute(name);
        if (v == null || v === '' || !KIND[name]) return v;
        return convert(v, KIND[name]);
      }
    };
  };

  /** Dynamically loads external script. @param {string} src @returns {Promise<boolean>} */
  const loadScript = (src) => new Promise(resolve => {
    const s = document.createElement('script');
    s.setAttribute('src', src);
    s.addEventListener('load', () => resolve(true), false);
    s.addEventListener('error', () => { console.error(`Vidya (snippet): failed to load ${src}`); resolve(false); }, false);
    document.body.appendChild(s);
  });

  /** Finds snippet elements, constructs adapted source, and launches player. */
  const run = async () => {
    const els = document.querySelectorAll(`bs-snippet[name="${SNIPPET_NAME}"]`);
    if (!els.length) {
      console.warn(`Vidya (snippet): no <bs-snippet name="${SNIPPET_NAME}"> found.`);
      return;
    }
    if (els.length > 1) {
      console.warn('Vidya (snippet): only one Fire-V-Player per world is supported; using the first.');
    }
    const source = adapter(els[0]);
    if (!(window.FireVPlayer && window.FireVPlayer.startPlayer)) {
      const ok = await loadScript(`${new URL(source.src).origin}/playlist-player.js`);
      if (!ok) return;
    }
    console.log(`Vidya (snippet): starting in ${source.mode} mode.`);
    window.FireVPlayer.startPlayer(source, source.mode);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
