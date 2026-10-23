// Fire-V-Player as a SideQuest/Altspace Creator SDK snippet.
//
//   <bs-snippet name="fire-v-player" title="Fire-V-Player" single="true"
//     script="https://vidya.firer.at/snippet.js"
//     room="my-room" position="0 1.5 2" rotation="0 0 0" scale="2" ...></bs-snippet>
//
// Settings are the same as playlist.js's script attributes (see USAGE.md), except:
// - position / rotation are Unity world values, like every snippet, so the Scene-view gizmo
//   shows where the screen will be. They are converted to the player's A-Frame units here.
// - scale may be a single number.
// - the room id is "room", because Unity's BSSnippet component writes its own "instance"
//   attribute. Without "room", that per-placement id is used.
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
    'rotation': 'rot', 'button-rotation': 'rot', 'box-trigger-rotation': 'rot', 'singer-button-rotation': 'rot',
    'scale': 'scale', 'button-scale': 'scale', 'box-trigger-scale': 'scale'
  };

  // Makes a <bs-snippet> element look like the <script> tag the player expects.
  const adapter = (el) => {
    const scriptUrl = new URL(el.getAttribute('script') || (thisScript && thisScript.src) || 'https://vidya.firer.at/snippet.js', location.href);
    return {
      src: `${scriptUrl.origin}/playlist.js`,
      snippet: el,
      getAttribute(name) {
        if (name === 'instance') return el.getAttribute('room') || el.getAttribute('instance');
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
    if (!(window.FireVPlayer && window.FireVPlayer.startPlaylistPlayer)) {
      const ok = await loadScript(`${new URL(source.src).origin}/playlist-player.js`);
      if (!ok) return;
    }
    window.FireVPlayer.startPlaylistPlayer(source);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
