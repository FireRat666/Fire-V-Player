// Translations for the in-world playlist panel.
//
// The panel is written in English, and its English text is the key: public/i18n/<code>.js sets
// FVP_STRINGS[code], which maps each English string to its translation. They are scripts, not
// JSON, as the world's page loads them with a script tag (the server sends no CORS headers for a
// fetch). They are made with machine translation
// (scripts/translate-i18n.js, through LibreTranslate) and can be corrected by hand. A string with
// no translation shows in English.
//
// Words in braces ({name}, {count}) are filled in after translating: tr('Added by {name}', { name }).
var FVP_LANGUAGES = [
  ['en', 'English'],
  // Japanese (i18n/ja.js) is translated but not offered yet: the panel's font (Inter, from the
  // SDK's theme) has no Japanese letters and a script can't give it another, so it showed boxes.
  // Put it back once the SDK has a fallback font for them.
  // ['ja', '日本語'],
  ['fr', 'Français'],
  ['de', 'Deutsch']
];

var FVP_STRINGS = typeof FVP_STRINGS === 'undefined' ? {} : FVP_STRINGS;

var FvpI18n = class {
  // loadScript(name) loads public/<name>.js and resolves when it has run (Core.setupScript).
  constructor(loadScript) {
    this.loadScript = loadScript;
    this.lang = 'en';
    this.dict = {};
    this.loaded = new Map(); // code -> dictionary, so switching back is instant
  }

  // The language saved on this device, or the browser's when it is one of ours.
  static savedLanguage() {
    try {
      const saved = localStorage.getItem('fvpLanguage');
      if (saved && FVP_LANGUAGES.some(l => l[0] === saved)) return saved;
    } catch (e) {}
    const nav = String((typeof navigator !== 'undefined' && navigator.language) || 'en').slice(0, 2).toLowerCase();
    return FVP_LANGUAGES.some(l => l[0] === nav) ? nav : 'en';
  }

  // Loads a language's strings and makes it the current one. English needs no file.
  async use(code) {
    if (!FVP_LANGUAGES.some(l => l[0] === code)) code = 'en';
    let dict = {};
    if (code !== 'en') {
      dict = this.loaded.get(code);
      if (!dict) {
        if (!FVP_STRINGS[code]) {
          try { await this.loadScript(`i18n/${code}`); } catch (e) { console.warn(`[i18n] Could not load ${code}:`, e); }
        }
        dict = FVP_STRINGS[code] || {};
        if (FVP_STRINGS[code]) this.loaded.set(code, dict);
      }
    }
    this.lang = code;
    this.dict = dict || {};
    try { localStorage.setItem('fvpLanguage', code); } catch (e) {}
    return code;
  }

  // The translation of an English string, with {words} filled in from vars.
  tr(text, vars) {
    let out = this.dict[text];
    if (typeof out !== 'string' || !out) out = text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    return out;
  }

  // An exact match only, or null: for text that may or may not be one of ours (setText).
  lookup(text) {
    const out = this.dict[text];
    return typeof out === 'string' && out ? out : null;
  }
};
