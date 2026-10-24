// Fire-V-Player as a SideQuest/Altspace Creator SDK snippet.
//
//   <bs-snippet name="fire-v-player" title="Fire-V-Player" single="true"
//     script="https://vidya.firer.at/snippet.js"
//     room="my-room" position="0 1.5 2" rotation="0 0 0" scale="2" ...></bs-snippet>
//
// karaoke="false" (the default) runs a shared playlist, karaoke="true" a singer queue, as with
// playlist.js / karaoke.js. It's true/false so Unity's Inspector shows it as a checkbox.
// mode="karaoke" works too. Both open an in-world panel from the Playlist / Singers button.
//
// Settings are the same as playlist.js's and karaoke.js's script attributes (see USAGE.md), except:
// - position / rotation are Unity world values, like every snippet, so the Scene-view gizmo
//   shows where the screen will be. They are converted to the player's A-Frame units here.
// - scale may be a single number.
// - playlist-panel-position / -rotation and button-position / -rotation are world values too, so
//   they get their own gizmos. With controls-follow-screen="true" they are offsets from the
//   screen instead, and move with it.
// - the room id is "room", because Unity's BSSnippet component writes its own "instance"
//   attribute. Without "room" the player uses the space URL, so each space has its own room.
//
// The player still uses the SDK's legacy A-Frame bridge, so this adds an <a-scene> if the page
// has none.
(() => {
  const SNIPPET_NAME = 'fire-v-player';
  const thisScript = document.currentScript;

  const parse = (str) => String(str || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const fmt = (arr) => arr.map(n => (Object.is(n, -0) ? 0 : n)).join(' ');

  // Unity <-> A-Frame: the legacy bridge mirrors Z, i.e. position (x, y, -z), rotation (-x, -y, z).
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
  const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
  const qAxis = (axis, deg) => { const q = [0, 0, 0, Math.cos(deg * D / 2)]; q[axis] = Math.sin(deg * D / 2); return q; };
  const qEuler = ([x, y, z]) => qMul(qMul(qAxis(1, y), qAxis(0, x)), qAxis(2, z));
  const qToEuler = ([x, y, z, w]) => {
    const r = (v) => Math.round(((v / D) % 360 + 360) % 360 * 1000) / 1000;
    return [
      r(Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z))))),
      r(Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y))),
      r(Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)))
    ];
  };
  const qRotate = (q, v) => {
    const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
    return [p[0], p[1], p[2]];
  };
  const vec = (str, def) => { const p = parse(str); return p.length >= 3 && !p.slice(0, 3).some(isNaN) ? p.slice(0, 3) : def; };
  const round = (v) => v.map(n => Math.round(n * 1000) / 1000);

  // Makes a <bs-snippet> element look like the <script> tag the player expects.
  const adapter = (el) => {
    const scriptUrl = new URL(el.getAttribute('script') || (thisScript && thisScript.src) || 'https://vidya.firer.at/snippet.js', location.href);
    const attr = (name) => (el.getAttribute(name) || '').trim();

    // controls-follow-screen: button-position / playlist-panel-position (and their rotations) are
    // offsets from the screen instead of world values, so they move with it. Their gizmos then
    // don't line up, as a gizmo can only show a setting's own value.
    const follow = attr('controls-follow-screen') === 'true';
    const screenPos = vec(attr('position'), [0, 0, 0]);
    const screenQ = qEuler(vec(attr('rotation'), [0, 0, 0]));

    const relative = (name) => {
      if (name === 'playlist-panel-position') return null; // the panel's own offset mode handles it
      if (name === 'playlist-panel-offset') {
        const v = attr('playlist-panel-position') || attr('playlist-panel-offset');
        return v ? convert(v, 'pos') : null;
      }
      if (name === 'button-position') {
        const off = vec(attr(name), null);
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

    const karaoke = attr('karaoke').toLowerCase() === 'true' || attr('mode').toLowerCase() === 'karaoke';
    return {
      mode: karaoke ? 'karaoke' : 'playlist',
      src: `${scriptUrl.origin}/${karaoke ? 'karaoke' : 'playlist'}.js`,
      snippet: el,
      getAttribute(name) {
        // Not the element's own "instance" (BSSnippet's per-placement id): without a room the
        // player falls back to the space URL.
        if (name === 'instance') return el.getAttribute('room') || null;
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

  const ensureScene = () => {
    if (document.querySelector('a-scene')) return;
    const scene = document.createElement('a-scene');
    document.body.insertBefore(scene, document.body.firstChild);
    console.log('Vidya (snippet): added an <a-scene> for the legacy A-Frame bridge.');
  };

  const loadScript = (src) => new Promise(resolve => {
    const s = document.createElement('script');
    s.setAttribute('src', src);
    s.addEventListener('load', () => resolve(true), false);
    s.addEventListener('error', () => { console.error(`Vidya (snippet): failed to load ${src}`); resolve(false); }, false);
    document.body.appendChild(s);
  });

  const run = async () => {
    const els = document.querySelectorAll(`bs-snippet[name="${SNIPPET_NAME}"]`);
    if (!els.length) {
      console.warn(`Vidya (snippet): no <bs-snippet name="${SNIPPET_NAME}"> found.`);
      return;
    }
    if (els.length > 1) {
      console.warn('Vidya (snippet): only one Fire-V-Player per world is supported; using the first.');
    }
    ensureScene();
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
