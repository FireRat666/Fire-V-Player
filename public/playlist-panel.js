// In-world playlist panel, built with the SDK's UI system (Unity UI Toolkit underneath).
//
// The new SideQuest/Altspace client may not open 2D "menu browser" pages, so this panel gives
// every user playback controls, the playlist and YouTube search inside the world. It shares the
// in-world script's websocket (core.ws); the server already sends that socket every playlist
// update, and replies to searches on the socket that asked.
//
// In karaoke mode (core.isKaraoke) the same panel is the Singers panel: the list is the singer
// queue, search results have "Sing It" to join the queue, and the host controls include Auto
// Advance instead of the playlist ones.
//
// Each user gets their own local panel. It sits beside the screen and is shown/hidden by the
// playlist button. It hides by moving out of view, because deactivating a UI Toolkit document
// can drop the elements created at runtime. The hand's Playlist button puts it in
// front of the player, and the pill under it can be grabbed to carry it.
// The list scrolls (the kit's scroll view) through this many rows at a time; the page buttons
// move this window through longer lists. Each row is about ten UI elements, and Unity is slow to
// make hundreds of them, so the rows are a fixed pool, built a few at a time after the panel
// opens, and refilled as the window moves.
var LIST_WINDOW = 20;
var FIRST_ROWS = 8; // rows built with the panel; the rest follow in chunks of ROW_CHUNK
var ROW_CHUNK = 4;
// Successful searches kept on this device: how many, and for how long.
var SEARCH_CACHE_SIZE = 10;
var SEARCH_CACHE_MS = 6 * 60 * 60 * 1000;
// The Speak button (speech to text). Off until Altspace supports it.
var SPEAK_ENABLED = false;
// The Info view's QR code: pixels per square, and the white border in squares.
var QR_MODULE_PX = 9;
var QR_MARGIN = 3;
// Where the Info view sends people who want the player in their own world.
var SETUP_GUIDE_URL = 'https://firer.at/fvp'; // redirects to firer.at/pages/FireVPlayer/
// SETUP_GUIDE_URL's QR code (1 = dark), drawn from boxes on the Info view, as a picture there
// didn't reliably show. Made with: qrencode -t ASCII -m 0 -l Q 'https://firer.at/fvp'
var SETUP_GUIDE_QR = [
  '1111111011000011001111111',
  '1000001000111111001000001',
  '1011101010110001001011101',
  '1011101011110010001011101',
  '1011101000000101001011101',
  '1000001011001001001000001',
  '1111111010101010101111111',
  '0000000011010001000000000',
  '0101011111110110011101101',
  '0010000010111110111000001',
  '0100001011011110100100011',
  '1000100001000111010010000',
  '1110111110011010111001011',
  '0101000110101000001101101',
  '1000001100001010111110101',
  '0110010111111100111010010',
  '1111011001000011111111100',
  '0000000011100101100011001',
  '1111111010100001101011011',
  '1000001011101101100011110',
  '1011101000101010111111001',
  '1011101010000001100111100',
  '1011101001011110000110101',
  '1000001011100010110001000',
  '1111111001110111111100011'
];
// Sources whose site can be opened in a browser window beside the panel (Browse, site-browser.js).
var BROWSE_SITES = ['shoutcast', 'tubi'];
// What Search can search, in the order its dropdown lists them.
var SEARCH_SOURCES = {
  youtube: { label: 'YouTube', status: 'Searching YouTube.' },
  archive: { label: 'Archive Films', status: 'Searching Internet Archive films and TV.' },
  tubi: { label: 'Tubi', status: 'Searching Tubi. The first search takes a few seconds.' },
  nasa: { label: 'NASA+', status: 'Searching NASA+.' },
  eso: { label: 'ESO', status: "Searching ESO's videos." },
  esodome: { label: 'ESO Fulldome', status: "Searching ESO's fulldome videos, for domes." },
  shoutcast: { label: 'Shoutcast', status: "Searching Shoutcast's radio stations." },
  radiobrowser: { label: 'Radio Browser', status: "Searching Radio Browser's radio stations." },
  somafm: { label: 'SomaFM', status: "Searching SomaFM's radio channels. Search somafm to see them all." },
  // A room on screen.sdq.st, by its code or a link to it. Only with untrusted-links, as screen
  // shares can't play without it (see searchSources).
  screen: { label: 'Screen Share', status: 'Searching screen.sdq.st: type a room code, or paste its link.' }
};
// The server works on 3 list previews at a time per connection and refuses more, so the rest wait.
/** Where Browse's window can go round the panel, in the order Move Browser takes them. */
var BROWSE_PLACES = ['right', 'left', 'front'];
// How long Browse waits for the server to say whether a station can play before asking again.
var RADIO_CHECK_RETRY_MS = 15000;
var LIST_PREVIEWS_AT_ONCE = 3;
// A list preview older than this is loaded again when it's next shown (the server re-reads lists
// after 5 minutes too), and a request with no reply after LIST_REPLY_MS is given up on.
var LIST_FRESH_MS = 5 * 60 * 1000;
var LIST_REPLY_MS = 120000;
// The progress bar's width in pixels is the panel's (W) less PROGRESS_SPARE: its padding and
// borders (42), the now-playing card's padding (28), the time label (190) and the gap before the
// bar (10). A long time (a live stream months in) widens the label and narrows the bar (see
// setTimeText).
var PROGRESS_SPARE = 270;
var TIME_WIDTH = 190;
// Added to thumbnail links, new each time the space loads. Unity keeps the pictures it has
// downloaded for as long as the client runs (UIElementBridge's texture cache) and never checks one
// is still there, so after a rejoin a cached link can show nothing and never download again.
var THUMB_VISIT = Date.now().toString(36);
// Symbols drawn as pictures (public/assets/icons, served from the assets host) when a button's or label's text starts with
// one (see setIconText): pause, cross, crown (the host), menu, fade, hand.
var ICON_FILES = { '\u275A\u275A': 'pause', '\u2715': 'close', '\u265B': 'host', '\u2630': 'menu', '\u25D4': 'fade', '\u261A': 'hand' };
var ICON_TINTS = { '#80deea': '-80deea', '#ffd54f': '-ffd54f' };
var ICON_START = /^(\u275A\u275A|[\u2715\u265B\u2630\u25D4\u261A])\s?([\s\S]*)$/;
// What the panel shows for those symbols in the middle of a sentence, where a picture can't go:
// pause bars, cross, crown (the host), menu, fade, pointing hand.
var PLAIN_SYMBOLS = { '\u275A': '|', '\u2715': '\u00D7', '\u265B': '\u25C9', '\u2630': '=', '\u25D4': '~', '\u261A': '\u25C0' };

// ---- The Altspace UI Kit (SDK 4.0.29 and an app that has it; see docs/components/ui-kit.md in the
// creator SDK). Buttons are the kit's pill and round buttons, and the symbols that start a button's
// text become the kit's icons. An app without the kit gets the menu page instead (see
// Core.shouldUsePlaylistPanel).
//
// The symbol at the start of a button's text, and the icon it becomes: a name from the kit's icon
// set, or 'fvp:name' for one of ours (public/assets/kit-icons, white Material icons like the kit's,
// tinted by the kit). Longest first, so '\u25B6|' isn't read as '\u25B6'.
var KIT_SYMBOLS = [
  ['\u275A\u275A \u25B6', 'pause'], ['\u25C0\u25C0 \u25B6\u25B6', 'fvp:fast-forward'],
  ['\u25C0\u25C0', 'fvp:fast-rewind'], ['\u25B6\u25B6', 'fvp:fast-forward'],
  ['|\u25C0', 'fvp:skip-previous'], ['\u25B6|', 'fvp:skip-next'], ['\u275A\u275A', 'pause'],
  ['\u25B2 \u25BC', 'chevron-up'], ['\u2B06 \u2B07', 'chevron-up'],
  ['\u25B6', 'play'], ['\u25A0', 'stop'], ['\u2715', 'close'], ['\u2713', 'check'], ['+', 'add'], ['\u2212', 'remove'],
  ['\u2B06', 'chevron-up'], ['\u2B07', 'chevron-down'], ['\u25B2', 'chevron-up'], ['\u25BC', 'chevron-down'],
  ['\u21BB', 'refresh'], ['\u21C4', 'fvp:swap'], ['\u2605', 'bookmark-add'], ['\u2606', 'bookmark'],
  ['\u266A', 'mic'], ['\u266B', 'volume-up'], ['\u260E', 'smartphone'], ['\u265B', 'crown'],
  ['\u2630', 'menu'], ['\u24D8', 'info'], ['\u21A9', 'arrow-back'], ['\u25C9', 'location'],
  ['\u21E4', 'fvp:first-page'], ['\u21E5', 'fvp:last-page'],
  ['\u2039', 'chevron-left'], ['\u203A', 'chevron-right'], ['\u25A3', 'fullscreen'], ['\u25D4', 'tune'], ['\u261A', 'back-hand']
];
// The colours the panel's code gives buttons, and the kit button look each becomes.
var KIT_VARIANTS = {
  '#2e7d32': 'primary', '#1565c0': 'primary', '#00897b': 'primary',
  '#c62828': 'danger',
  '#6a1b9a': 'outline', '#4a148c': 'outline', '#ad1457': 'outline', '#5d2a2a': 'outline'
};
// Styles a kit button keeps from the ones it is given: where it sits and how big it is. Its colours,
// font, padding and corners are the kit's.
var KIT_LAYOUT_KEYS = ['display', 'width', 'minWidth', 'maxWidth', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
  'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'position', 'left', 'right', 'top', 'bottom'];
// The panel's own surfaces and text in each theme, from the kit's tokens (dark is the kit's own).
// A script can't change the kit's tokens, so these are set on the panel's plain elements; kit
// controls keep their own look in both.
var THEMES = {
  dark: {
    page: 'rgba(28, 28, 28, 0.97)', line: 'rgb(60, 60, 66)', card: 'rgb(36, 36, 40)',
    row: 'rgb(50, 50, 50)', rowAlt: 'rgb(44, 44, 50)', rowWaiting: 'rgba(200, 150, 40, 0.22)', rowMine: 'rgba(46, 160, 92, 0.22)',
    rowPreview: 'rgba(66, 120, 200, 0.25)', rowAdded: 'rgba(46, 160, 92, 0.16)', track: 'rgb(70, 70, 78)', thumb: 'rgb(30, 32, 40)',
    text: 'rgb(245, 245, 250)', text2: 'rgb(210, 214, 224)', muted: 'rgb(150, 154, 170)', gold: 'rgb(245, 214, 138)'
  },
  light: {
    page: 'rgba(244, 245, 249, 0.98)', line: 'rgb(208, 211, 220)', card: 'rgb(255, 255, 255)',
    row: 'rgb(232, 235, 241)', rowAlt: 'rgb(224, 228, 236)', rowWaiting: 'rgba(200, 150, 40, 0.28)', rowMine: 'rgba(46, 160, 92, 0.24)',
    rowPreview: 'rgba(66, 120, 200, 0.22)', rowAdded: 'rgba(46, 160, 92, 0.18)', track: 'rgb(200, 204, 214)', thumb: 'rgb(30, 32, 40)',
    text: 'rgb(24, 24, 30)', text2: 'rgb(56, 60, 72)', muted: 'rgb(100, 106, 122)', gold: 'rgb(150, 105, 10)'
  }
};
// The colours the panel's code gives its plain elements, and the theme colour each becomes, by style.
var THEME_COLOURS = {
  backgroundColor: {
    'rgba(18, 18, 24, 0.96)': 'page', '#23232d': 'card', '#311b4f': 'card', '#2a2a33': 'row', '#31313c': 'rowAlt', '#37474f': 'row',
    '#37404a': 'rowAlt', '#3949ab': 'rowCurrent', '#283593': 'rowCurrent', '#4a3f1e': 'rowWaiting', '#4e342e': 'rowWaiting',
    '#2e4a3a': 'rowMine', '#1e3a5f': 'rowPreview', '#1a237e': 'rowPreview', '#1b3a2a': 'rowAdded', '#444444': 'track',
    '#000000': 'thumb', '#e53935': 'accent'
  },
  borderColor: { '#555555': 'line', '#ab47bc': 'accent' },
  color: {
    '#ffffff': 'text', '#cccccc': 'text2', '#eeeeee': 'text2', '#e1bee7': 'text2',
    '#bbbbbb': 'muted', '#aaaaaa': 'muted', '#999999': 'muted', '#888888': 'muted',
    '#80deea': 'accentText', '#ffd54f': 'gold', '#ffcc66': 'gold'
  }
};
// Accent colours. The first four are the kit's own (its accent classes, so its tabs, dropdowns and
// switches follow); the rest are set on the panel's primary buttons, which then lose the kit's
// hover colour, and use the nearest kit class for the rest.
var ACCENTS = {
  teal: { name: 'Teal', kit: '', colour: 'rgb(45, 140, 143)', bright: 'rgb(120, 220, 222)' },
  violet: { name: 'Violet', kit: 'alt-theme--violet', colour: 'rgb(139, 92, 246)', bright: 'rgb(196, 181, 253)' },
  amber: { name: 'Amber', kit: 'alt-theme--amber', colour: 'rgb(200, 150, 40)', bright: 'rgb(240, 196, 92)' },
  rose: { name: 'Rose', kit: 'alt-theme--rose', colour: 'rgb(214, 74, 122)', bright: 'rgb(248, 168, 198)' },
  red: { name: 'Red', kit: 'alt-theme--rose', colour: 'rgb(198, 48, 48)', bright: 'rgb(240, 130, 130)', own: true },
  green: { name: 'Green', kit: '', colour: 'rgb(46, 150, 82)', bright: 'rgb(110, 214, 140)', own: true },
  blue: { name: 'Blue', kit: 'alt-theme--violet', colour: 'rgb(40, 110, 214)', bright: 'rgb(130, 180, 250)', own: true }
};
// The kit's button colours, to put back on a primary button when an accent of our own is changed
// for one of the kit's (see kitVariant).
// On the light theme list rows stay dark (as the kit's buttons on them are): these
// are the tinted rows' colours there.
var LIGHT_ROW_TINTS = { rowWaiting: 'rgb(98, 76, 30)', rowMine: 'rgb(30, 82, 54)', rowPreview: 'rgb(34, 62, 106)', rowAdded: 'rgb(30, 72, 50)' };
var KIT_BUTTON_COLOURS = { primary: '', secondary: 'rgb(50, 50, 56)', danger: 'rgb(190, 64, 64)', warning: 'rgb(200, 150, 40)', outline: 'rgba(0, 0, 0, 0)', ghost: 'rgba(0, 0, 0, 0)' };
var FirePlaylistPanel = class {
  constructor(core) {
    this.core = core;
    this.karaoke = !!core.isKaraoke;
    // The panel's resolution in pixels. It is laid out on fewer pixels than its size in the world
    // would suggest, so everything on it comes out bigger: the kit's controls are sized for a panel
    // seen closer up, and its text sizes are its own (a script can't change them), so this is what
    // makes them easy to read in VR.
    this.W = 1000;
    this.H = 855;
    this.tab = 'playlist';    // 'playlist' (the singer queue in karaoke mode) | 'lists' | 'search'
    // Where each tab's rows start, as an item index (see LIST_WINDOW).
    this.page = 0;
    this.searchPage = 0;
    this.listsPage = 0;
    // Saved lists (the Lists tab): the snippet's playlist and playlists settings, plus links
    // opened from Add by link this visit. listData holds what the server sent for each.
    this.savedLists = null;
    this.extraLists = [];
    this.listData = new Map();
    this.listQueue = []; // list ids waiting to be asked for (see pumpLists)
    this.listsOut = new Map(); // list id -> when it was asked for, still waiting for a reply
    this.listsSocket = null;
    this.searchId = 0; // the latest search's ID: only its reply is shown (see doSearch)
    this.openListId = null;
    this.searchResults = [];
    this.searchQuery = '';
    this.searchSource = 'youtube'; // a key of SEARCH_SOURCES
    // Recent searches, kept on this device (like the full playlist page did).
    this.recentKey = `recent${this.karaoke ? 'Karaoke' : 'Playlist'}Searches`;
    this.recentSearches = this.loadRecent();
    // Results of recent successful searches, kept on this device so going back to one shows it
    // straight away instead of searching again.
    this.searchCacheKey = `fvpSearchCache${this.karaoke ? 'Karaoke' : ''}`;
    this.pendingSearchKey = null;
    this.restoreLastSearch();
    // Lists this viewer saved from a link, kept on this device for this world.
    this.userListsKey = `fvpSavedLists:${(core.params && core.params.instance) || ''}`;
    // Where they were kept before the room took in the space's address (core.js setRoom).
    this.legacyListsKey = core.params && core.params['legacy-instance'] ? `fvpSavedLists:${core.params['legacy-instance']}` : null;
    this.userLists = this.loadUserLists();
    // A pasted playlist waiting for its Replace / Add All / Save choice.
    this.pendingList = null;
    this.visible = false;
    this.built = false;
    this.failed = false;
    this.clockSkew = 0;
    this.cache = new Map();
    this.iconParts = new Map(); // elements whose text starts with a picture icon (see setIconText)
    this.renderTimer = null;
    this.tickTimer = null;
    this.statusTimer = null;
    this.view = 'main';       // 'main' | 'more' | 'info'
    this.autoSync = false;
    this.seekQuery = '';
    this.linkQuery = '';
    this.pendingReplacement = null;
    this.searchTimer = null;
    // The theme and accent picked on this device, and the panel's language.
    this.theme = this.loadSetting('fvpPanelTheme', Object.keys(THEMES), 'dark');
    this.accent = this.loadSetting('fvpPanelAccent', Object.keys(ACCENTS), 'teal');
    this.themedEls = new Set(); // elements with a colour that follows the theme (see themed)
    this.textEls = new Set();   // elements with text, put in the new language when it changes
    this.kitButtons = new Set();
    this.i18n = typeof FvpI18n !== 'undefined' ? new FvpI18n(name => core.setupScript(null, name)) : null;
    this.onMessageFn = msg => this.onMessage(msg);
    core.addMessageListener(this.onMessageFn);
  }

  loadSetting(key, choices, def) {
    try {
      const v = localStorage.getItem(key);
      return choices.includes(v) ? v : def;
    } catch (e) {
      return def;
    }
  }
  saveSetting(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  // ---------------------------------------------------------------- language

  // The translation of an English string, {words} filled in (see i18n.js).
  tr(text, vars) {
    if (this.i18n) return this.i18n.tr(text, vars);
    return vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : text;
  }
  // Text for setText: one of the panel's strings in the current language, a symbol in front kept
  // ("+ Add" is "+" and "Add"). Anything else (a title, a name) stays as it is.
  trText(text) {
    if (!this.i18n || this.i18n.lang === 'en' || !text) return text;
    const whole = this.i18n.lookup(text);
    if (whole) return whole;
    const m = /^([^\p{L}\p{N}]+?\s)([\s\S]+)$/u.exec(text);
    const rest = m && this.i18n.lookup(m[2]);
    if (rest) return m[1] + rest;
    // Sentences put together (controlText's), each one of the panel's strings.
    const parts = text.split(/(?<=[.!?])\s+/);
    // A string can be more than one sentence, so the longest run that is one is taken each time.
    const done = [];
    for (let i = 0; parts.length > 1 && i < parts.length;) {
      let j = parts.length;
      while (j > i && !this.i18n.lookup(parts.slice(i, j).join(' '))) j--;
      if (j === i) return text;
      done.push(this.i18n.lookup(parts.slice(i, j).join(' ')));
      i = j;
    }
    return done.length ? done.join(' ') : text;
  }
  // Switches the panel's language: loads its strings, then sets every text again.
  async setLanguage(code) {
    if (!this.i18n) return;
    let applied;
    const request = this.i18n.request + 1; // the one use() is about to start
    try {
      applied = await this.withTimeout(this.i18n.use(code), 8000, 'Loading the panel language');
    } catch (e) {
      if (this.i18n.request !== request) return; // a later choice is loading
      // The language it had stays, and the dropdown shows it again; picking it once more retries.
      this.i18n.cancel();
      console.warn(`[PlaylistPanel] Could not load the language ${code}:`, e);
      if (this.languageDropdown) {
        const c = this.cache.get(this.languageDropdown);
        if (c) delete c.value;
        this.setDropdownValue(this.languageDropdown, this.i18n.lang);
      }
      return;
    }
    if (!applied) return; // a later choice replaced this one
    for (const el of this.textEls) {
      if (el.fvpRawText != null) {
        const raw = el.fvpRawText;
        el.fvpRawText = null;
        this.setText(el, raw, el.fvpLiteral);
      }
    }
    if (this.kitTabs) this.kitTabsChoices = null;
    for (const f of this.kitFields || []) {
      try { f.placeholder = this.tr(f.fvpPlaceholder); } catch (e) {}
    }
    this.fillLookChoices();
    this.render();
  }

  // ---------------------------------------------------------------- theme

  // A theme colour by name: the theme's, or the accent's.
  themeColour(token) {
    const a = ACCENTS[this.accent] || ACCENTS.teal;
    if (token === 'accent') return a.colour;
    if (token === 'accentText') return this.theme === 'light' ? a.colour : a.bright;
    if (token === 'rowCurrent') return a.colour.replace(/^rgb\((.*)\)$/, 'rgba($1, 0.38)');
    return (THEMES[this.theme] || THEMES.dark)[token];
  }
  // A style value for a plain element: one of THEME_COLOURS becomes the theme's. It is kept, so a
  // new theme can be applied.
  themed(el, key, value) {
    const map = THEME_COLOURS[key];
    if (!map || typeof value !== 'string') return value;
    if (!el.fvpRaw) el.fvpRaw = {};
    el.fvpRaw[key] = value;
    this.themedEls.add(el);
    const token = map[value.toLowerCase()];
    // On a kit surface (always dark): the accent still follows the choice, the rest stays as it is.
    if (el.fvpNoTheme) return token === 'accentText' ? (ACCENTS[this.accent] || ACCENTS.teal).bright : token === 'accent' ? this.themeColour('accent') : value;
    return token ? this.themeColour(token) : value;
  }
  // Styles for a new plain element. One inside a plain button or on a kit surface keeps its colours.
  applyStyles(el, styles, parent) {
    if (parent && (parent.fvpButton || parent.fvpNoTheme)) el.fvpNoTheme = true;
    const out = {};
    for (const [k, v] of Object.entries(styles || {})) out[k] = this.themed(el, k, v);
    el.SetStyles(out);
  }
  // Puts the current theme and accent on everything already made.
  applyTheme() {
    for (const el of this.themedEls) {
      for (const [k, v] of Object.entries(el.fvpRaw || {})) this.setStyle(el, k, v);
    }
    for (const el of this.kitButtons) this.kitVariant(el, el.fvpVariant || 'outline');
    this.applyTabsLook();
    if (this.themeRoot) {
      for (const a of Object.values(ACCENTS)) if (a.kit) this.themeRoot.RemoveClass(a.kit);
      const kitClass = (ACCENTS[this.accent] || ACCENTS.teal).kit;
      if (kitClass) this.themeRoot.AddClass(kitClass);
    }
    this.render();
  }
  // The kit's tabs draw light text: on the light theme they sit on a dark strip.
  applyTabsLook() {
    if (!this.kitTabs) return;
    const light = this.theme === 'light';
    this.kitTabs.SetStyles({ backgroundColor: light ? 'rgb(42, 42, 48)' : 'rgba(0, 0, 0, 0)', borderRadius: light ? '12px' : '0px', paddingLeft: light ? '6px' : '0px', paddingRight: light ? '6px' : '0px' });
  }
  setTheme(theme) {
    if (!THEMES[theme] || theme === this.theme) return;
    this.theme = theme;
    this.saveSetting('fvpPanelTheme', theme);
    this.applyTheme();
  }
  setAccent(accent) {
    if (!ACCENTS[accent] || accent === this.accent) return;
    this.accent = accent;
    this.saveSetting('fvpPanelAccent', accent);
    this.applyTheme();
  }

  // ---------------------------------------------------------------- UI Kit controls

  // Our own kit icons, from the assets host like the other pictures (a copy of
  // public/assets/kit-icons is there). The address changes each visit, as applyIconText's does.
  kitIconUrl(name) {
    return `${this.core.assetUrl(`kit-icons/${name}.png`)}?fvp=${THUMB_VISIT}`;
  }
  // A kit button's look (see KIT_VARIANTS). With an accent of our own, a primary button is given
  // its colour; one that had it gets the kit's colour for its look back.
  kitVariant(el, variant) {
    el.fvpVariant = variant;
    // The kit's ghost and outline buttons are white on nothing, which can't be seen on the light
    // theme's pale panel (and a script can't reach their icon's colour), so there they are the
    // dark secondary pills the other buttons are.
    // Not on a kit row or card, which stay dark.
    if (this.theme === 'light' && !el.fvpOnDark && (variant === 'ghost' || variant === 'outline')) variant = 'secondary';
    if (this._changed(el, 'variant', variant)) el.variant = variant;
    const a = ACCENTS[this.accent] || ACCENTS.teal;
    let bg = null;
    if (variant === 'primary' && a.own) bg = a.colour;
    else if (el.fvpOwnBg) bg = variant === 'primary' ? a.colour : (KIT_BUTTON_COLOURS[variant] || KIT_BUTTON_COLOURS.secondary);
    if (bg && bg !== el.fvpOwnBg) {
      el.fvpOwnBg = bg;
      el.SetStyles({ backgroundColor: bg });
    }
  }
  // A kit button's text: a symbol at its start (KIT_SYMBOLS), or '@name', becomes its icon; one
  // at its end ("30s ▶▶") becomes an icon after the label.
  kitText(el, text) {
    text = text == null ? '' : String(text);
    el.fvpRawText = text;
    this.textEls.add(el);
    let icon = '';
    let rest = text;
    let trailing = false;
    const named = /^@([a-z:-]+)(?:\s([\s\S]*))?$/.exec(text);
    if (named) {
      icon = named[1];
      rest = named[2] || '';
    } else {
      for (const [sym, name] of KIT_SYMBOLS) {
        if (text.startsWith(sym) && (text.length === sym.length || text[sym.length] === ' ')) {
          icon = name;
          rest = text.slice(sym.length).trim();
          break;
        }
        if (text.length > sym.length + 1 && text.endsWith(` ${sym}`)) {
          icon = name;
          rest = text.slice(0, -sym.length).trim();
          trailing = true;
          break;
        }
      }
    }
    if (!el.fvpLiteral) rest = this.trText(rest);
    if (!el.fvpRound && this._changed(el, 'text', rest)) el.text = rest;
    const own = icon.startsWith('fvp:');
    // Our own icon element: for our pictures, or any icon on a button with a bigger icon size.
    const mine = own || !!(icon && el.fvpIconSize);
    const kitIcon = mine ? '' : icon;
    if (this._changed(el, 'icon', kitIcon)) el.icon = kitIcon;
    if (!el.fvpRound && kitIcon && this._changed(el, 'iconPosition', trailing ? 'trailing' : 'leading')) el.iconPosition = trailing ? 'trailing' : 'leading';
    if (mine && !el.fvpImg) {
      // Our own icons are a kit icon with a picture in the button's slot, which comes after the
      // label: the button's row is turned round to put one in front (see below). The pictures are
      // Material icons like the kit's, which are drawn at 20 px in a pill and half the size round;
      // ours have more space around them, so they are a step bigger.
      el.fvpImg = this.ui.CreateKitIcon(el);
      el.fvpImg.size = el.fvpIconSize || 'md';
      el.fvpImg.SetStyles({ flexShrink: 0 });
    }
    if (el.fvpImg) {
      const url = own ? this.kitIconUrl(icon.slice(4)) : '';
      if (this._changed(el.fvpImg, 'image', url) && (url || el.fvpImgHad)) {
        el.fvpImg.image = url;
        el.fvpImgHad = !!url;
      }
      const glyph = mine && !own ? icon : '';
      if (this._changed(el.fvpImg, 'icon', glyph)) el.fvpImg.icon = glyph;
      this.display(el.fvpImg, mine);
      const before = mine && rest && !trailing;
      // Straight to the button: kitStyle keeps only where a button sits.
      const dir = before ? 'row-reverse' : 'row';
      if (!el.fvpRound && this._changed(el, 'flexDirection', dir)) el.SetStyles({ flexDirection: dir });
      this.setStyle(el.fvpImg, 'marginLeft', mine && rest && trailing ? '6px' : '0px');
      this.setStyle(el.fvpImg, 'marginRight', before ? '6px' : '0px');
    }
  }
  // A kit button: a pill (KitButton), or round with one icon (KitIconButton, `round`).
  kitButton(parent, text, onClick, styles, round) {
    const s = styles || {};
    const el = round ? this.ui.CreateKitIconButton(parent) : this.ui.CreateKitButton(parent);
    el.fvpKit = true;
    el.fvpRound = !!round;
    // On a kit row or card (always dark), whatever the theme.
    el.fvpOnDark = !!(parent && (parent.fvpNoTheme || parent.fvpKitRow));
    // Large unless asked otherwise: in VR a button has to be easy to read and to hit.
    el.size = s.kitSize || 'lg';
    // A bigger icon than the kit's own for the button's size (its glyph is then drawn by our icon).
    el.fvpIconSize = s.kitIconSize || null;
    // The kit's buttons have no margin; the old ones had 4 px all round, which kept a row of them
    // apart (and the lines of a wrapping row).
    const layout = { flexShrink: 0, marginLeft: '4px', marginRight: '4px', marginTop: '3px', marginBottom: '3px' };
    for (const k of KIT_LAYOUT_KEYS) if (k in s) layout[k] = s[k];
    el.SetStyles(layout);
    this.kitButtons.add(el);
    // A button with no colour of its own is outlined: the kit's quiet look that still shows its
    // edge, so it reads as a button on any surface.
    this.kitVariant(el, s.kitVariant || KIT_VARIANTS[String(s.backgroundColor || '').toLowerCase()] || 'outline');
    this.kitText(el, text);
    this.bindClick(el, onClick);
    return el;
  }
  // A style on a kit button: a colour picks its look; where it sits and its size are kept; the
  // rest is the kit's.
  kitStyle(el, key, value) {
    if (key === 'backgroundColor') return this.kitVariant(el, KIT_VARIANTS[String(value).toLowerCase()] || 'outline');
    if (!KIT_LAYOUT_KEYS.includes(key)) return;
    if (this._changed(el, key, value)) el.SetStyles({ [key]: value });
  }
  // The icons the buttons show for some symbols (KIT_SYMBOLS, or '@name'), side by side, for the
  // Info view's legend. A symbol with no icon (CC, Go Live) stays as text.
  async kitIcons(parent, text) {
    for (const part of String(text).split(' ')) {
      let name = part.startsWith('@') ? part.slice(1) : null;
      if (!name) {
        const hit = KIT_SYMBOLS.find(([sym]) => sym === part);
        name = hit ? hit[1] : null;
      }
      if (!name) {
        await this.label(parent, part, { fontSize: '22px', marginLeft: '3px', marginRight: '3px' });
        continue;
      }
      const ic = this.ui.CreateKitIcon(parent);
      ic.size = 'md';
      if (name.startsWith('fvp:')) ic.image = this.kitIconUrl(name.slice(4));
      else ic.icon = name;
      ic.SetStyles({ marginLeft: '3px', marginRight: '3px', flexShrink: 0 });
    }
  }

  // A kit scroll view filling `parent`, with a column inside for the content.
  async kitScrollColumn(parent, styles) {
    const scroller = this.ui.CreateKitScrollView(parent);
    scroller.SetStyles(Object.assign({ flexGrow: 1, flexShrink: 1, flexBasis: '0px', minHeight: '0px' }, styles || {}));
    const col = await this.div(scroller, { display: 'flex', flexDirection: 'column', flexShrink: 0, paddingRight: '8px' });
    return { scroller, col };
  }
  // A kit dropdown. `choices` are [key, English text]; onPick gets the key.
  kitDropdown(parent, choices, onPick, styles) {
    const dd = this.ui.CreateKitDropdown(parent);
    dd.size = 'lg';
    dd.SetStyles(Object.assign({ flexShrink: 0 }, styles || {}));
    dd.fvpChoices = choices;
    this.setDropdownChoices(dd, choices);
    dd.OnChange(e => {
      if (!e || e.value == null || this.core.blocked) return;
      const pick = (dd.fvpShown || []).find(c => c[1] === String(e.value));
      if (pick) onPick(pick[0]);
    });
    return dd;
  }
  // A dropdown's entries in the current language (each entry is its text, so `;` is escaped).
  setDropdownChoices(dd, choices) {
    dd.fvpChoices = choices;
    dd.fvpShown = choices.map(([key, text, keep]) => [key, keep ? text : this.tr(text)]);
    const list = dd.fvpShown.map(c => c[1].replace(/;/g, '\\;')).join(';');
    if (this._changed(dd, 'choices', list)) dd.choices = list;
  }
  setDropdownValue(dd, key) {
    if (!dd) return;
    const c = (dd.fvpShown || []).find(x => x[0] === key);
    const v = c ? c[1] : '';
    if (this._changed(dd, 'value', v)) dd.value = v;
  }
  // The Look & language dropdowns, in the current language.
  fillLookChoices() {
    if (this.themeDropdown) this.setDropdownChoices(this.themeDropdown, [['dark', 'Dark'], ['light', 'Light']]);
    if (this.accentDropdown) this.setDropdownChoices(this.accentDropdown, Object.entries(ACCENTS).map(([k, a]) => [k, a.name]));
    if (this.sourceDropdown) this.setDropdownChoices(this.sourceDropdown, this.searchSources().map(k => [k, SEARCH_SOURCES[k].label, true]));
  }
  // Presses: one press can arrive twice, and a blacklisted user can't use anything.
  bindClick(el, onClick) {
    let last = 0;
    el.OnClick(() => {
      const now = Date.now();
      if (now - last < 350) return;
      last = now;
      if (this.core.blocked) return; // blacklisted: nothing works (see Core.setBlocked)
      try { onClick(); } catch (e) { console.error('[PlaylistPanel] click handler failed:', e); }
    });
  }

  // A kit surface (a card) for a section of Info or More. Kit controls draw light on dark whatever
  // the theme, so a surface and everything in it keep the dark look (fvpNoTheme).
  kitSurface(parent, styles) {
    const box = this.ui.CreateKitSurface(parent);
    box.variant = 'card';
    box.padding = 's4';
    box.fvpNoTheme = true;
    box.SetStyles(Object.assign({ flexShrink: 0, marginBottom: '10px' }, styles || {}));
    return box;
  }
  // The kit's section heading: an optional small eyebrow above a title.
  kitHeading(parent, text, eyebrow) {
    const h = this.ui.CreateKitSectionHeader(parent);
    h.fvpTextProp = 'title';
    h.SetStyles({ flexShrink: 0, marginBottom: '4px' });
    if (eyebrow) h.eyebrow = this.tr(eyebrow).toLocaleUpperCase();
    this.setText(h, text);
    return h;
  }
  // One settings row (the kit's option row): a label and a quieter line on the left, the control
  // on the right. Returns the row; its control goes in it.
  kitOption(parent, label, description) {
    const r = this.ui.CreateKitOptionRow(parent);
    r.fvpTextProp = 'label';
    r.fvpNoTheme = true; // on a kit card
    r.SetStyles({ flexShrink: 0 });
    this.setText(r, label);
    if (description) {
      // A second text property: kept like a text element of its own, for a new language.
      const d = { fvpTextProp: 'description', fvpProxy: r };
      r.fvpDesc = d;
      this.setText(d, description);
    }
    return r;
  }
  // A kit switch in an option row. onChange gets true or false.
  kitToggle(parent, onChange) {
    const t = this.ui.CreateKitToggle(parent);
    t.fvpToggle = true;
    t.OnChange(e => {
      if (!e || e.value == null || this.core.blocked) return;
      const v = e.value === true || String(e.value).toLowerCase() === 'true';
      this.cache.get(t) && (this.cache.get(t).checked = v);
      onChange(v);
    });
    return t;
  }

  // A kit chip (recent searches, words to add to a search). variant: filter, add or danger.
  kitChip(parent, text, onClick, variant, icon) {
    const chip = this.ui.CreateKitChip(parent);
    chip.variant = variant || 'filter';
    if (icon) chip.icon = icon;
    chip.fvpTextProp = 'text';
    chip.SetStyles({ flexShrink: 0, marginRight: '6px' });
    this.setText(chip, text);
    this.bindClick(chip, onClick);
    return chip;
  }

  // ---------------------------------------------------------------- helpers

  vec3(str, def) {
    const p = String(str || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (p.length === 1 && !isNaN(p[0])) return [p[0], p[0], p[0]];
    return (p.length >= 3 && !p.slice(0, 3).some(isNaN)) ? p.slice(0, 3) : def;
  }
  // Script-tag values use A-Frame's axes, where Z is mirrored from Unity's (see Core.toUnityPos).
  toUnityPos([x, y, z]) { return new BS.Vector3(x, y, -z); }
  toUnityEuler([x, y, z]) { return new BS.Vector3(-x, -y, z); }

  isHost() {
    const p = this.core.player;
    return !!(p && p.host && window.user && p.host.id === window.user.id);
  }

  // The list on the first tab: the playlist, then the videos waiting for the host to approve them
  // (added while locked; after the playlist, so its indexes stay the same), or in karaoke mode the
  // singer queue.
  listItems() {
    const p = this.core.player || {};
    if (this.karaoke) return p.players || [];
    const waiting = Array.isArray(p.waiting) ? p.waiting.map(w => Object.assign({ waiting: true }, w)) : [];
    return (p.playlist || []).concat(waiting);
  }

  // Whether this user's + Add asks the host instead (playlist mode, locked, not the host).
  addWaits() {
    const p = this.core.player;
    return !this.karaoke && !!p && !!p.locked && !this.isHost();
  }

  isInQueue() {
    return !!(window.user && this.listItems().some(s => s.id === window.user.id));
  }

  // The person singing now (karaoke mode).
  currentSinger() {
    const p = this.core.player;
    const track = p && p.playlist && p.playlist[p.currentTrack];
    return track && track.user ? track.user : null;
  }

  timeCode(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Elements don't need to wait for Unity: the SDK sends anything set before the panel is ready
  // once it is. (Waiting per element could stall the whole build if Unity never answered.)
  async ready(el) {
    return el;
  }

  // Waits for a Unity call, but gives up after `ms` so a missing reply can't hang the build.
  withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })
    ]).finally(() => clearTimeout(timer));
  }

  // Only send a change to Unity when the value actually changed.
  _changed(el, key, value) {
    let c = this.cache.get(el);
    if (!c) { c = {}; this.cache.set(el, c); }
    if (c[key] === value) return false;
    c[key] = value;
    return true;
  }
  // The UI font on a Quest has fewer symbols than on PC, and draws an empty box for one it
  // lacks. These are the ones seen missing there, with a symbol or letter it has. PC shows the
  // same, so the panel looks alike everywhere and what's tested on one holds on the other.
  plainSymbols(text) {
    return text.replace(/[\u275A\u2715\u265B\u2630\u25D4\u261A]/g, ch => PLAIN_SYMBOLS[ch]);
  }
  // literal: text that isn't ours (a title, a name), shown as it is in every language; the
  // caller translates any of our words in it first.
  setText(el, text, literal) {
    if (!el) return;
    el.fvpLiteral = !!literal;
    if (el.fvpKit) return this.kitText(el, text);
    if (el.fvpTextProp) {
      // A kit control whose text is one property (a chip's text, an empty state's message).
      text = text == null ? '' : String(text);
      el.fvpRawText = text;
      this.textEls.add(el);
      const t = el.fvpLiteral ? text : this.trText(text);
      const target = el.fvpProxy || el;
      if (this._changed(target, el.fvpTextProp, t)) target[el.fvpTextProp] = t;
      return;
    }
    text = text == null ? '' : String(text);
    // Kept as given, so a new language can be put on it (setLanguage).
    el.fvpRawText = text;
    this.textEls.add(el);
    if (!el.fvpLiteral) text = this.trText(text);
    // Text that starts with one of the picture icons (see ICON_FILES), or an element that has
    // shown one before, is drawn as a picture and a label inside the element.
    const m = ICON_START.exec(text);
    if (m || this.iconParts.has(el)) return this.setIconText(el, m ? ICON_FILES[m[1]] : null, m ? m[2] : text);
    text = this.plainSymbols(text);
    if (this._changed(el, 'text', text)) el.text = text;
  }
  // The picture icons: the UI font on a Quest lacks these symbols, and pictures look the same
  // on every device. The element's own text is emptied, and it gets a picture and a label as
  // children, made once and then only changed. `file` null shows text only.
  setIconText(el, file, rest) {
    let part = this.iconParts.get(el);
    if (!part) {
      part = { el };
      this.iconParts.set(el, part);
      if (this._changed(el, 'text', '')) el.text = '';
      el.SetStyles(Object.assign({ display: 'flex', flexDirection: 'row', alignItems: 'center' }, el.fvpButton ? { justifyContent: 'center' } : {}));
      const size = `${Math.round((parseFloat(el.fvpFontSize) || 20) * 1.3)}px`;
      part.building = (async () => {
        part.img = await this.div(el, { width: size, height: size, flexShrink: 0 });
        part.txt = await this.label(el, '', { fontSize: el.fvpFontSize || '20px', color: el.fvpColor || '#ffffff', whiteSpace: 'nowrap', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis' });
        // Its text comes from el's (applyIconText), already in the panel's language: setLanguage
        // setting it again on its own would empty it.
        this.textEls.delete(part.txt);
        part.building = null;
        this.applyIconText(part);
      })().catch(e => console.warn('[PlaylistPanel] Could not make an icon:', e));
    }
    part.file = file;
    part.rest = this.plainSymbols(rest || '');
    if (!part.building) this.applyIconText(part);
  }
  applyIconText(part) {
    // The pictures are white; the two other text colours that carry one have their own copies.
    // The address changes each visit, as the thumbnails' do: the app keeps pictures by address,
    // and one kept from an earlier visit to the space shows as an empty box.
    const tint = ICON_TINTS[String(part.el.fvpColor || '').toLowerCase()] || '';
    const url = part.file ? `url("${this.core.assetUrl(`icons/${part.file}${tint}.png`)}?fvp=${THUMB_VISIT}")` : 'none';
    if (this._changed(part.img, 'backgroundImage', url)) part.img.SetStyles({ backgroundImage: url });
    this.display(part.img, !!part.file);
    this.display(part.txt, !!part.rest);
    this.setStyle(part.txt, 'marginLeft', part.file && part.rest ? '8px' : '0px');
    if (this._changed(part.txt, 'text', part.rest)) part.txt.text = part.rest;
  }
  display(el, on) {
    if (!el) return;
    const v = on ? 'flex' : 'none';
    if (this._changed(el, 'display', v)) el.SetStyles({ display: v });
  }
  setStyle(el, key, value) {
    if (!el) return;
    if (el.fvpKit) return this.kitStyle(el, key, value);
    if (el.fvpProgress) {
      if (key !== 'width') return;
      const v = Math.max(0, Math.min(1, (parseFloat(value) || 0) / 100));
      if (this._changed(el, 'value', v)) el.fvpProgress.value = v;
      return;
    }
    if (el.fvpKitRow && key === 'backgroundColor') return this.kitRowLook(el, value);
    value = this.themed(el, key, value);
    if (this._changed(el, key, value)) el.SetStyles({ [key]: value });
  }

  send(path, data) {
    const msg = { path };
    if (data !== undefined) msg.data = data;
    return this.core.sendMessage(msg);
  }

  // A control for this viewer's player only. The server passes these on to their browser page,
  // which isn't there while a file plays on the world's video player, so then they go to it here.
  sendMine(serverPath, playerPath, data) {
    if (!this.core.nativeScreen) return this.send(serverPath, data);
    const msg = { path: playerPath };
    if (data !== undefined) msg.data = data;
    this.core.sendBrowserMessage(msg);
  }

  setStatus(text, ms = 4000) {
    if (!this.statusLabel) return;
    this.setText(this.statusLabel, text);
    clearTimeout(this.statusTimer);
    if (ms) this.statusTimer = setTimeout(() => this.setText(this.statusLabel, ''), ms);
  }

  // Rows in the scroll view at once.
  pageSize() {
    return LIST_WINDOW;
  }

  // Where the current tab's rows start (an item index), and setting it.
  tabStart() {
    return this.tab === 'search' ? this.searchPage : this.tab === 'lists' ? this.listsPage : this.page;
  }
  setTabStart(start) {
    if (this.tab === 'search') this.searchPage = start;
    else if (this.tab === 'lists') this.listsPage = start;
    else this.page = start;
  }

  // What the current tab lists.
  tabItems() {
    if (this.tab === 'search') return this.searchResults;
    if (this.tab === 'lists') return this.listEntries();
    return this.listItems();
  }

  // Whether this user may add to the playlist: the host, or anyone while it's unlocked (as the
  // server checks in addToPlaylist).
  canAdd() {
    const p = this.core.player;
    return this.isHost() || !(p && p.locked);
  }

  loadRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(this.recentKey) || '[]');
      return Array.isArray(list) ? list.filter(q => typeof q === 'string' && q.trim()).slice(0, 5) : [];
    } catch (e) {
      return [];
    }
  }

  saveRecent(query) {
    this.recentSearches = [query, ...this.recentSearches.filter(q => q.toLowerCase() !== query.toLowerCase())].slice(0, 5);
    try { localStorage.setItem(this.recentKey, JSON.stringify(this.recentSearches)); } catch (e) {}
  }

  clearRecent() {
    this.recentSearches = [];
    try { localStorage.removeItem(this.recentKey); } catch (e) {}
    try { localStorage.removeItem(this.searchCacheKey); } catch (e) {}
    this.render();
  }

  // ---- search results kept on this device

  searchKey(query, source) {
    return `${source || 'youtube'}:${String(query || '').trim().toLowerCase()}`;
  }
  readSearchCache() {
    try {
      const all = JSON.parse(localStorage.getItem(this.searchCacheKey) || '{}');
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch (e) {
      return {};
    }
  }
  // The saved results for a search, if it was made in the last SEARCH_CACHE_MS.
  cachedSearch(key) {
    const hit = this.readSearchCache()[key];
    if (!hit || !Array.isArray(hit.results) || !hit.results.length) return null;
    if (Date.now() - (hit.at || 0) > SEARCH_CACHE_MS) return null;
    return hit;
  }
  // Keeps a successful search's results, the newest SEARCH_CACHE_SIZE searches only.
  saveSearch(key, query, results) {
    const all = this.readSearchCache();
    all[key] = { query, at: Date.now(), results };
    const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
    keys.slice(SEARCH_CACHE_SIZE).forEach(k => delete all[k]);
    try {
      localStorage.setItem(this.searchCacheKey, JSON.stringify(all));
    } catch (e) {
      // Storage full: keep just this one.
      try { localStorage.setItem(this.searchCacheKey, JSON.stringify({ [key]: all[key] })); } catch (e2) {}
    }
  }
  // Opening the panel again shows the last search's results, if they were kept.
  restoreLastSearch() {
    const all = this.readSearchCache();
    const newest = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0))[0];
    const hit = newest && this.cachedSearch(newest);
    if (!hit) return;
    this.searchResults = hit.results;
    this.searchQuery = hit.query || '';
    const source = newest.split(':')[0];
    if (SEARCH_SOURCES[source] && this.searchSources().includes(source)) this.searchSource = source;
  }

  // ---- lists saved from a link (Lists tab), kept on this device for this world

  loadUserLists() {
    try {
      let saved = localStorage.getItem(this.userListsKey);
      if (saved == null && this.legacyListsKey) saved = localStorage.getItem(this.legacyListsKey);
      const list = JSON.parse(saved || '[]');
      return Array.isArray(list) ? list.filter(l => l && typeof l.id === 'string').map(l => ({ id: l.id, label: String(l.label || 'Playlist'), user: true })) : [];
    } catch (e) {
      return [];
    }
  }
  saveUserLists() {
    try { localStorage.setItem(this.userListsKey, JSON.stringify(this.userLists.map(l => ({ id: l.id, label: l.label })))); } catch (e) {}
  }

  // Puts text in the search box (and searchQuery, which normally follows the box's OnChange).
  setSearchText(text) {
    this.searchQuery = text;
    if (this.searchField) {
      try { this.searchField.value = text; } catch (e) {}
    }
  }

  // Karaoke's helper words: adds one to the end of the search, once.
  addSearchWord(word) {
    const q = (this.searchQuery || '').trim();
    if (new RegExp(`(^|\\s)${word}(\\s|$)`, 'i').test(q)) return;
    this.setSearchText(q ? `${q} ${word}` : word);
    if (this.searchField && typeof this.searchField.Focus === 'function') {
      try { this.searchField.Focus(); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------- element factories

  async div(parent, styles) {
    const el = await this.ready(this.ui.CreateVisualElement(parent));
    this.applyStyles(el, Object.assign({ backgroundColor: 'rgba(0,0,0,0)' }, styles || {}), parent);
    return el;
  }

  async label(parent, text, styles) {
    const el = await this.ready(this.ui.CreateLabel(undefined, parent));
    this.applyStyles(el, Object.assign({ color: '#ffffff', fontSize: '20px', backgroundColor: 'rgba(0,0,0,0)' }, styles || {}), parent);
    el.fvpFontSize = (styles && styles.fontSize) || '20px'; // for a picture icon (see setIconText)
    el.fvpColor = (styles && styles.color) || '#ffffff';
    this.setText(el, text);
    return el;
  }

  // A button: the kit's (kitButton), or with styles.plain a button laid out as a card, with parts
  // inside (the Who controls cards, a link).
  async button(parent, text, onClick, styles) {
    if (!(styles && styles.plain)) return this.kitButton(parent, text, onClick, styles, styles && styles.round);
    styles = Object.assign({}, styles);
    for (const k of ['plain', 'round', 'kitSize', 'kitIconSize', 'kitVariant']) delete styles[k];
    const el = await this.ready(this.ui.CreateButton(parent));
    el.SetStyles(Object.assign({
      backgroundColor: '#00838f', color: '#ffffff', fontSize: '20px', flexShrink: 0,
      paddingLeft: '16px', paddingRight: '16px', paddingTop: '8px', paddingBottom: '8px',
      marginLeft: '4px', marginRight: '4px', marginTop: '4px', marginBottom: '4px',
      borderRadius: '10px', borderWidth: '0px', backgroundImage: 'none'
    }, styles || {}));
    el.fvpButton = true; // for a picture icon (see setIconText)
    el.fvpFontSize = (styles && styles.fontSize) || '20px';
    el.fvpColor = (styles && styles.color) || '#ffffff';
    this.setText(el, text);
    this.bindClick(el, onClick);
    return el;
  }

  // A web address shown as text that opens in the viewer's browser when pressed (the client asks
  // them first). `url` is the address, or a function giving it, for one that changes.
  async link(parent, text, url, styles) {
    const el = await this.button(parent, text, () => this.openLink(typeof url === 'function' ? url() : url), Object.assign({
      backgroundColor: 'rgba(0,0,0,0)', paddingLeft: '6px', paddingRight: '6px', paddingTop: '2px', paddingBottom: '2px',
      marginLeft: '0px', marginRight: '0px', marginTop: '0px', marginBottom: '0px', plain: true
    }, styles || {}));
    // Its text colour follows the theme (the accent's, for a link).
    if (styles && styles.color) this.setStyle(el, 'color', styles.color);
    return el;
  }

  openLink(url) {
    if (!url) return;
    if (!this.core.openPage(url)) this.core.showToast(`Couldn't open it here. Go to ${url.replace(/^https?:\/\//, '')} in your browser.`, 6000);
  }

  // A scrolling column (the kit's scroll view) filling `parent`.
  async scrollColumn(parent) {
    return (await this.kitScrollColumn(parent)).col;
  }

  // Who may control the player, from the server's two settings (lock and Take Over): 'host'
  // (locked, no Take Over), 'everyone' (unlocked, no Take Over: the host stays the host) or
  // 'takeover' (anyone can press Take Over and become the host). Take Over on while locked is
  // 'takeover' too, as anyone can still become the host and change everything.
  controlLevel(player) {
    if (!player || player.canTakeOver) return 'takeover';
    return player.locked ? 'host' : 'everyone';
  }

  // The three choices, closed to open: [level, padlock open, colour, name]. The colours are the
  // host chip's (see render): the accent, amber, and red for Take Over, so anyone can see at a
  // glance that the player can be taken.
  controlLevels() {
    return [
      ['host', false, this.themeColour('accent'), 'Only the host'],
      ['everyone', true, 'rgb(200, 150, 40)', 'Everyone'],
      ['takeover', true, 'rgb(190, 64, 64)', 'Everyone + Take Over']
    ];
  }
  // A padlock, shut or open: the kit's own icons.
  async lockIcon(parent, open, size) {
    const ic = this.ui.CreateKitIcon(parent);
    ic.size = size || 'md';
    ic.icon = open ? 'lock-open' : 'lock';
    ic.SetStyles({ flexShrink: 0 });
    return ic;
  }

  controlText(level) {
    const k = this.karaoke;
    if (level === 'host') {
      return (k ? 'Only the host starts songs, and new songs wait for the host to approve them.' : 'Only the host changes videos, and new ones wait for the host to approve them.')
        + ' Nobody can take over while the host is here.';
    }
    if (level === 'everyone') {
      return (k ? 'Anyone can join the queue, and the next singer can start their own song.' : 'Anyone can add videos. Only the host can play, skip, move or remove them.')
        + ' Nobody can take over while the host is here.';
    }
    return 'Anyone can press Take Over and become the host, and then change anything.';
  }

  // The host picks who may control the player (see controlLevel): sets lock and Take Over together,
  // so a locked player can't be left open to Take Over by mistake.
  setControl(level) {
    const p = this.core.player;
    if (!p) return;
    if (!this.isHost()) {
      this.setStatus(p.canTakeOver ? 'Only the host can change this. Press Take Over to become the host.' : 'Only the host can change this. A space admin can press Admin Take Over to become the host.');
      return;
    }
    const locked = level === 'host';
    const takeOver = level === 'takeover';
    // One message for both, so the server changes them together or (refused) not at all; it
    // answers everyone with what they are now.
    if (!!p.locked !== locked || !!p.canTakeOver !== takeOver) this.send(Commands.SET_CONTROL, { locked, canTakeOver: takeOver });
    this.setStatus(this.controlText(level), 6000);
  }

  // A text input: the kit's text field, or with `search` its search bar (a glyph, and a clear
  // button while there is text).
  async textField(parent, placeholder, onValue, onEnter, search) {
    const field = search ? this.ui.CreateKitSearchBar(parent) : this.ui.CreateKitTextField(parent);
    field.size = 'md';
    field.placeholder = this.tr(placeholder);
    field.fvpPlaceholder = placeholder;
    field.SetStyles({ flexGrow: 1, flexShrink: 1, flexBasis: '0px', minWidth: '0px', marginRight: '6px' });
    field.OnChange(e => {
      if (!e || e.value == null) return;
      const v = String(e.value);
      // The search bar's own submit and clear; a plain field passes every value on.
      if (search && v === 'search:submit') return onEnter();
      if (search && v === 'search:clear') {
        try { if ('_value' in field) field._value = ''; } catch (_) {}
        return onValue('');
      }
      // The SDK only sends a new value when it differs from the last one set from here, and
      // typing doesn't update that copy. Without this, putting back text that was set before
      // (+ lyrics, delete it, + lyrics again) sent nothing, and the box stayed empty.
      try { if ('_value' in field) field._value = v; } catch (_) {}
      onValue(v);
    });
    if (typeof field.OnKeyDown === 'function') {
      field.OnKeyDown(e => {
        if (e && (e.key === 'Enter' || e.key === '\n' || e.key === '\r' || e.keyCode === 13)) onEnter();
      });
    }
    this.kitFields = this.kitFields || [];
    this.kitFields.push(field);
    return field;
  }

  // ---------------------------------------------------------------- build

  /**
   * Triggers asynchronous construction of the in-world UI Toolkit panel if not already built.
   * @returns {Promise<void>}
   */
  build() {
    if (!this.buildPromise) {
      this.buildPromise = this._build().catch(e => {
        if (this.destroyed) return;
        console.error('[PlaylistPanel] Failed to build the in-world playlist panel, the Playlist button will try the menu page instead:', e);
        this.failed = true;
      });
    }
    return this.buildPromise;
  }

  /**
   * Internal implementation that instantiates GameObjects, mover handles, and UI hierarchies.
   * @private
   * @returns {Promise<void>}
   */
  async _build() {
    const p = this.core.params;
    const screenPos = this.vec3(p.position, [0, 0, 0]);
    const screenRot = this.vec3(p.rotation, [0, 0, 0]);
    const screenScale = this.vec3(p.scale, [1, 1, 1]);
    const panelScale = parseFloat(p['playlist-panel-scale']) || 1;
    const panelWidthM = this.panelWidthM = 1.4 * panelScale;
    // Either a world position (and world rotation, default the screen's), or an offset from the
    // screen. The screen is 1 unit wide at scale 1, so the default offset is just past its right edge.
    const worldPos = this.vec3(p['playlist-panel-position'], null);
    const offset = worldPos || this.vec3(p['playlist-panel-offset'], [screenScale[0] * 0.5 + 0.1 + panelWidthM * 0.5, 0, 0.15]);
    const rot = this.vec3(p['playlist-panel-rotation'], worldPos ? screenRot : [0, -20, 0]);

    console.log('[PlaylistPanel] Building...');
    this.root = await this.withTimeout(new BS.GameObject({
      name: 'FireVPlayer_PlaylistRoot',
      localPosition: worldPos ? new BS.Vector3(0, 0, 0) : this.toUnityPos(screenPos),
      localEulerAngles: worldPos ? new BS.Vector3(0, 0, 0) : this.toUnityEuler(screenRot)
    }).Async(), 15000, 'Creating the panel root object');
    this.checkAlive();

    const UIClass = BS.UI || BS.BanterUI;
    // root (the screen, or the world) > mover (the grab handle: a pill just under the
    // panel's bottom edge, which players pick up to carry it) > panel (the UI, above the pill).
    // Closing sends the mover and the panel out of sight; opening puts them back.
    const panelHeightM = panelWidthM * this.H / this.W;
    this.handleDrop = panelHeightM / 2 + 0.08; // from the panel's middle down to the handle
    // Where it sits by the screen, to go back to after being opened in front of a player.
    const moverRot = this.toUnityEuler(rot);
    const centre = this.toUnityPos(offset);
    const down = this.qRotate(this.qEuler(moverRot), [0, -this.handleDrop, 0]);
    this.home = {
      rootLocalPos: worldPos ? new BS.Vector3(0, 0, 0) : this.toUnityPos(screenPos),
      rootLocalRot: worldPos ? new BS.Vector3(0, 0, 0) : this.toUnityEuler(screenRot),
      moverPos: new BS.Vector3(centre.x + down[0], centre.y + down[1], centre.z + down[2]),
      moverRot
    };
    this.moverHidden = true;
    // 'home' (by the screen) | 'front' (in front of the player) | 'singer' (above karaoke's Singers
    // button) | 'moved' (carried)
    this.placement = 'home';
    this.shownPos = new BS.Vector3(0, this.handleDrop, 0);
    this.hiddenPos = new BS.Vector3(0, -1000, 0);
    this.mover = await this.withTimeout(new BS.GameObject({
      name: 'FireVPlayer_PlaylistMover',
      parent: this.root,
      localPosition: new BS.Vector3(0, -1000, 0), // out of sight until opened (moverHidden)
      localEulerAngles: this.home.moverRot
    }).Async(), 15000, 'Creating the panel mover object');
    this.checkAlive();
    const s = panelWidthM / (this.W / 100); // a panel is 100 pixels per metre
    this.panelObj = await this.withTimeout(new BS.GameObject({
      name: 'FireVPlayer_PlaylistPanel',
      parent: this.mover,
      localPosition: this.hiddenPos,
      localScale: new BS.Vector3(s, s, s)
    }).Async(), 15000, 'Creating the panel object');
    this.checkAlive();

    const ui = new UIClass(new BS.Vector2(this.W, this.H), false);
    this.ui = (await this.withTimeout(this.panelObj.AddComponent(ui), 15000, 'Adding the UI panel component')) || ui;
    this.checkAlive();
    console.log('[PlaylistPanel] UI panel added, creating elements...');
    if (typeof this.ui.SetBackgroundColor === 'function') {
      this.ui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
    }
    // Core.shouldUsePlaylistPanel only makes the panel in an app with the UI Kit.
    if (typeof this.ui.CreateKitButton !== 'function') throw new Error('This app has no UI Kit');
    // The language saved on this device. A missing file leaves it in English.
    if (this.i18n) {
      try {
        console.log(`[PlaylistPanel] Device language: ${navigator.language} (${(navigator.languages || []).join(', ')}), saved: ${localStorage.getItem('fvpLanguage') || 'none'}, using ${FvpI18n.savedLanguage()}.`);
      } catch (e) {}
      try {
        await this.withTimeout(this.i18n.use(FvpI18n.savedLanguage()), 8000, 'Loading the panel language');
      } catch (e) {
        // A reply after this would change the language of a panel half built in English.
        this.i18n.cancel();
        console.warn('[PlaylistPanel] Staying in English:', e);
      }
    }

    const rootEl = await this.div(undefined, {
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      backgroundColor: 'rgba(18, 18, 24, 0.96)', borderRadius: '24px',
      borderWidth: '3px', borderColor: '#555555',
      paddingLeft: '18px', paddingRight: '18px', paddingTop: '14px', paddingBottom: '14px'
    });
    // The kit's classes, and its accent class, for everything inside (see applyTheme).
    rootEl.AddClass('alt');
    this.themeRoot = rootEl;
    const kitClass = (ACCENTS[this.accent] || ACCENTS.teal).kit;
    if (kitClass) rootEl.AddClass(kitClass);
    const row = (parent, styles) => this.div(parent, Object.assign({ display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0 }, styles || {}));
    const GREY = '#455a64';

    // Header
    const header = await row(rootEl);
    await this.label(header, this.karaoke ? 'Fire-V-Player Karaoke' : 'Fire-V-Player', { fontSize: '30px', fontWeight: 'bold' });
    // The server's build (see server/version.js), so people can tell an old version from a new one.
    this.versionLabel = await this.label(header, '', { fontSize: '18px', color: '#888888', marginLeft: '12px', flexGrow: 1 });
    // Who runs the player: a padlock and the host's name, in the look for who may control it (see
    // controlLevel and render). Pressing it opens More, where that's set, and Take Over and Admin
    // Take Over.
    this.hostChip = await this.button(header, '', () => this.setView(this.view === 'more' ? 'main' : 'more'), {
      backgroundColor: '#2e7d32', maxWidth: '380px', kitSize: 'lg'
    });
    // The kit's round buttons: info, settings (More) and close.
    const headIcon = { backgroundColor: GREY, round: true, kitSize: 'lg', marginLeft: '6px' };
    this.infoBtn = await this.button(header, 'ⓘ', () => this.setView(this.view === 'info' ? 'main' : 'info'), Object.assign({}, headIcon, { kitVariant: 'secondary' }));
    this.moreBtn = await this.button(header, '☰', () => this.setView(this.view === 'more' ? 'main' : 'more'), Object.assign({}, headIcon, { backgroundColor: '#2e7d32', kitVariant: 'secondary' }));
    await this.button(header, '✕', () => this.close(), Object.assign({}, headIcon, { marginLeft: '14px', kitVariant: 'ghost' }));

    // Now playing
    const nowCard = this.nowCard = await this.div(rootEl, {
      display: 'flex', flexDirection: 'column', flexShrink: 0, backgroundColor: '#23232d',
      borderRadius: '14px', paddingLeft: '14px', paddingRight: '14px', paddingTop: '10px', paddingBottom: '12px', marginTop: '8px'
    });
    this.nowTitle = await this.label(nowCard, 'Connecting...', {
      fontSize: '26px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
    });
    const progRow = await this.div(nowCard, { display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '4px' });
    this.timeLabel = await this.label(progRow, '', { fontSize: '20px', color: '#cccccc', width: `${TIME_WIDTH}px`, flexShrink: 0, whiteSpace: 'nowrap' });
    // The bar has a fixed width, as a mouse event only says where it is inside the element
    // (the panel is always W pixels wide). The taller clear box around it is easier to hit.
    const progHit = this.progHit = await this.div(progRow, {
      width: `${this.W - PROGRESS_SPARE}px`, height: '36px', flexShrink: 0, marginLeft: '10px',
      display: 'flex', flexDirection: 'column', justifyContent: 'center'
    });
    // The kit's progress bar. Its fill is set through setStyle's 'width' (see setStyle).
    const bar = this.ui.CreateKitProgressBar(progHit);
    bar.size = 'md';
    bar.tone = 'accent';
    bar.SetStyles({ flexShrink: 0 });
    this.progInner = { fvpProgress: bar };
    this.addProgressSeek(progHit);

    // Playback + volume controls
    // Symbols instead of words, so they read in any language (the Info view has a legend).
    const controls = this.controlsRow = await row(rootEl, { marginTop: '6px' });
    const sym = { minWidth: '64px', kitSize: 'lg', kitIconSize: 'lg', marginRight: '6px' };
    const symBtn = (text, fn, styles) => this.button(controls, text, fn, Object.assign({}, sym, styles || {}));
    this.prevTrackBtn = await symBtn('|◀', () => this.changeTrack(-1));
    if (this.karaoke) {
      // The host or the person singing can start the song again or stop it.
      this.restartBtn = await symBtn('|◀', () => { this.stopPreview(true); this.send(Commands.RESTART_SONG); });
    }
    this.rewBtn = await symBtn('◀◀', () => this.core.back());
    this.pauseBtn = await symBtn('❚❚', () => this.send(Commands.TOGGLE_PAUSE));
    this.ffBtn = await symBtn('▶▶', () => this.core.forward());
    this.nextTrackBtn = await symBtn('▶|', () => this.changeTrack(1));
    if (this.karaoke) this.stopBtn = await symBtn('■', () => { this.stopPreview(true); this.send(Commands.STOP); }, { backgroundColor: '#c62828' });
    // Rebuilds only this viewer's screen, for a video that froze or didn't load for them.
    await symBtn('↻', () => this.core.reloadScreen(), { backgroundColor: '#5d4037' });
    // A live video only: everyone to its live point (see goLive).
    this.goLiveBtn = await symBtn('Go Live', () => this.goLive(), { backgroundColor: '#c62828', display: 'none' });
    await this.div(controls, { flexGrow: 1 });
    // This viewer's volume.
    const vol = { backgroundColor: GREY, kitSize: 'lg', kitIconSize: 'lg' };
    await this.button(controls, '@fvp:volume-down', () => { this.core.volume(false); this.renderSoon(); }, vol);
    this.volLabel = await this.label(controls, '', { fontSize: '24px', width: '56px', textAlign: 'center' });
    await this.button(controls, '@volume-up', () => { this.core.volume(true); this.renderSoon(); }, vol);
    this.muteBtn = await this.button(controls, '@volume-off', () => { this.core.mute(); this.renderSoon(); }, vol);

    // Replacement suggestion (when a user can't play a video)
    this.noticeRow = await row(rootEl, { marginTop: '6px', backgroundColor: '#4e342e', borderRadius: '10px', paddingLeft: '10px', paddingRight: '6px' });
    this.noticeLabel = await this.label(this.noticeRow, '', { fontSize: '18px', flexGrow: 1, flexShrink: 1, whiteSpace: 'normal' });
    this.replaceConfirmBtn = await this.button(this.noticeRow, '⇄ Replace', () => this.confirmReplace(), { backgroundColor: '#2e7d32' });
    await this.button(this.noticeRow, '✕', () => this.dismissReplace(), { backgroundColor: '#c62828' });

    // Karaoke preview: plays a searched song on this viewer's screen only, so they can check it has
    // lyrics before adding it. Shown across Search and the other tabs while a preview is running.
    if (this.karaoke) {
      this.previewRow = await row(rootEl, {
        display: 'none', marginTop: '6px', backgroundColor: '#1e3a5f', borderRadius: '10px',
        paddingLeft: '10px', paddingRight: '6px', paddingTop: '4px', paddingBottom: '4px'
      });
      this.previewLabel = await this.label(this.previewRow, '', {
        fontSize: '18px', flexGrow: 1, flexShrink: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      });
      await this.button(this.previewRow, '◀◀', () => this.core.back());
      await this.button(this.previewRow, '▶▶', () => this.core.forward());
      this.previewSingBtn = await this.button(this.previewRow, '♪ Sing It', () => {
        if (this.core.previewVideo) this.singIt(this.core.previewVideo);
      }, { backgroundColor: '#2e7d32' });
      await this.button(this.previewRow, '■ Stop', () => this.stopPreview(), { backgroundColor: '#c62828' });
    }

    // A pasted playlist: what to do with it.
    this.listPromptRow = await this.div(rootEl, {
      display: 'none', flexDirection: 'column', flexShrink: 0, marginTop: '6px', backgroundColor: '#1a237e',
      borderRadius: '10px', paddingLeft: '12px', paddingRight: '8px', paddingTop: '6px', paddingBottom: '6px'
    });
    this.listPromptLabel = await this.label(this.listPromptRow, '', { fontSize: '20px', whiteSpace: 'normal' });
    const promptBtns = await row(this.listPromptRow, { marginTop: '4px', flexWrap: 'wrap' });
    this.promptReplaceBtn = await this.button(promptBtns, '⇄ Replace Playlist', () => this.answerListPrompt('replace'), { backgroundColor: '#2e7d32' });
    this.promptAppendBtn = await this.button(promptBtns, '+ Add All to End', () => this.answerListPrompt('append'));
    this.promptShareBtn = await this.button(promptBtns, '★ Save for Everyone', () => this.answerListPrompt('share'), { backgroundColor: '#6a1b9a' });
    this.promptSaveBtn = await this.button(promptBtns, '☆ Save for Me', () => this.answerListPrompt('save'), { backgroundColor: '#4a148c' });
    this.promptVideoBtn = await this.button(promptBtns, '+ Just This Video', () => this.answerListPrompt('video'));
    await this.button(promptBtns, '✕ Cancel', () => this.answerListPrompt(null), { backgroundColor: GREY });

    // Browse: what the browser window has open that can be added (see onBrowseMessage).
    this.browseOfferRow = await this.div(rootEl, {
      display: 'none', flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginTop: '6px', backgroundColor: '#004d40',
      borderRadius: '10px', paddingLeft: '12px', paddingRight: '8px', paddingTop: '6px', paddingBottom: '6px'
    });
    this.browseOfferLabel = await this.label(this.browseOfferRow, '', { fontSize: '20px', flexGrow: 1, flexShrink: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    this.browseNowBtn = await this.button(this.browseOfferRow, '▶ Now', () => this.addBrowseOffer(true), { backgroundColor: '#2e7d32' });
    this.browseAddBtn = await this.button(this.browseOfferRow, '+ Add', () => this.addBrowseOffer(false));
    this.browseEpisodesBtn = await this.button(this.browseOfferRow, '▼ Episodes', () => this.showEpisodes(this.browseOffer && this.browseOffer.link), { backgroundColor: '#6a1b9a' });
    await this.button(this.browseOfferRow, '✕', () => this.setBrowseOffer(null), { backgroundColor: GREY });

    // ---- Main view: playlist / search
    this.mainView = await this.div(rootEl, { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' });

    const tabs = await row(this.mainView, { marginTop: '6px' });
    // The kit's tabs, as the menu's sub-navigation (underline): the playlist (or singers), saved
    // lists, and search. Their labels, with counts, are set in render. (The kit's pill tabs are
    // for picking one of a few settings, not for pages.)
    this.kitTabs = this.ui.CreateKitTabs(tabs);
    this.kitTabs.variant = 'underline';
    this.kitTabs.SetStyles({ flexShrink: 0, marginRight: '8px' });
    this.kitTabs.OnChange(e => {
      if (!e || this.core.blocked) return;
      const v = String(e.value);
      if (v === 'search') this.openSearch();
      else if (v === 'playlist' || v === 'lists') this.setTab(v);
    });
    this.applyTabsLook();
    await this.div(tabs, { flexGrow: 1 });
    await this.buildPageNav(tabs);

    this.searchRow = await row(this.mainView, { marginTop: '4px' });
    const searchHint = this.karaoke ? 'Search for a song to sing, or paste a video link' : 'Search YouTube, or paste a YouTube / Twitch / Vimeo / video link';
    this.searchField = await this.textField(this.searchRow, searchHint, v => { this.searchQuery = v; }, () => this.doSearch(), true);
    // What to search: YouTube, Internet Archive films and TV, Tubi, NASA+, ESO, Shoutcast radio or a
    // screen share (not for karaoke).
    if (!this.karaoke) {
      this.sourceDropdown = this.kitDropdown(this.searchRow, [], k => {
        this.searchSource = k;
        this.setStatus(this.tr('Search will look on {source}.', { source: SEARCH_SOURCES[k].label }), 4000);
        // Browse shows for Shoutcast and Tubi (and while a window is open, so it can be closed).
        this.render();
      }, { width: '200px', marginRight: '6px' });
      this.fillLookChoices();
    }
    // Shoutcast's or Tubi's own site in a browser window beside the panel (see toggleBrowse).
    if (!this.karaoke) this.browseBtn = await this.button(this.searchRow, '@fvp:web Browse', () => this.toggleBrowse(), { backgroundColor: '#00838f' });
    // Turns while a search is waiting for its results (see render).
    this.searchSpinner = this.ui.CreateKitSpinner(this.searchRow);
    this.searchSpinner.size = 'lg';
    this.searchSpinner.tone = 'accent';
    this.searchSpinner.SetStyles({ display: 'none', flexShrink: 0, marginLeft: '4px', marginRight: '10px' });
    this.searchGoBtn = await this.button(this.searchRow, '@search Search', () => this.doSearch(), { backgroundColor: '#1565c0' });
    // While Browse's window is open it takes Search's place: it moves the window round the panel.
    if (!this.karaoke) {
      this.moveBrowseBtn = await this.button(this.searchRow, '⇄ Move Browser', () => this.moveBrowse(), { backgroundColor: '#00838f' });
      this.display(this.moveBrowseBtn, false);
    }
    // Typing a link on a headset is hard: get a code, and send the link from a phone instead.
    await this.button(this.searchRow, '☎ Phone', () => this.askPasteCode(), { backgroundColor: '#6a1b9a' });
    // Speak (speech to text, toggleSpeech) stays hidden until Altspace answers StartTTS/StopTTS:
    // there it never does, which only confuses people. Set SPEAK_ENABLED to bring it back.
    const scene = this.core.banterScene();
    if (SPEAK_ENABLED && scene && typeof scene.StartTTS === 'function' && typeof scene.StopTTS === 'function') {
      this.speakBtn = await this.button(this.searchRow, 'Speak', () => this.toggleSpeech(), { backgroundColor: '#ad1457' });
    }
    // The last search, when its results were kept on this device.
    if (this.searchQuery) this.setSearchText(this.searchQuery);

    // Paste from your phone: a QR code that opens the page with the code filled in, and the
    // address and code, big, while a code is in use (see showPasteCode).
    this.phoneCard = await this.div(this.mainView, {
      display: 'none', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '10px',
      backgroundColor: '#311b4f', borderRadius: '16px', borderWidth: '3px', borderColor: '#ab47bc',
      paddingTop: '14px', paddingBottom: '14px', paddingLeft: '18px', paddingRight: '18px'
    });
    this.phoneQrEl = await this.div(this.phoneCard, { flexShrink: 0, backgroundColor: '#ffffff', marginRight: '28px' });
    this.phoneQrBoxes = [];
    const phoneText = await this.div(this.phoneCard, { display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 1 });
    this.phoneScanLabel = await this.label(phoneText, 'Scan this with your phone, or go to', { fontSize: '28px', color: '#e1bee7' });
    // Opens the page with the code already in, for someone at a computer rather than a phone.
    this.phoneUrlLabel = await this.link(phoneText, '', () => this.pasteCode && `${this.core.getProtocol()}://${this.core.hostUrl}/p/${this.pasteCode}`,
      { fontSize: '46px', fontWeight: 'bold', color: '#80deea', marginTop: '4px' });
    await this.label(phoneText, 'and enter this code:', { fontSize: '28px', color: '#e1bee7', marginTop: '8px' });
    // White on black in either theme.
    this.phoneCodeLabel = await this.label(phoneText, '', {
      fontSize: '96px', fontWeight: 'bold', color: 'rgb(255, 255, 255)', marginTop: '4px',
      backgroundColor: 'rgb(0, 0, 0)', borderRadius: '14px', paddingLeft: '28px', paddingRight: '28px'
    });
    const phoneFoot = await row(phoneText, { marginTop: '10px' });
    this.phoneExpiryLabel = await this.label(phoneFoot, '', { fontSize: '22px', color: '#bbbbbb', marginRight: '16px' });
    await this.button(phoneFoot, '✓ Done', () => this.hidePasteCode(), { backgroundColor: '#455a64' });

    // Search helpers: karaoke's words to add to the search, then recent searches, as the kit's
    // chips (as its filter rows have).
    this.searchToolsRow = await row(this.mainView, { overflow: 'hidden' });
    if (this.karaoke) {
      for (const word of ['karaoke', 'lyrics', 'zoom karaoke']) this.kitChip(this.searchToolsRow, word, () => this.addSearchWord(word), 'add', 'add');
    }
    this.recentLabel = await this.label(this.searchToolsRow, 'Recent:', { fontSize: '18px', color: '#bbbbbb', marginLeft: '8px', marginRight: '2px', flexShrink: 0 });
    this.recentBtns = [];
    for (let k = 0; k < 5; k++) {
      const idx = k;
      const chip = this.kitChip(this.searchToolsRow, '', () => {
        const q = this.recentSearches[idx];
        if (!q) return;
        this.setSearchText(q);
        this.doSearch();
      }, 'filter', 'schedule');
      chip.SetStyles({ flexShrink: 1, maxWidth: '240px' });
      this.recentBtns.push(chip);
    }
    this.clearRecentBtn = this.kitChip(this.searchToolsRow, 'Clear', () => this.clearRecent(), 'danger', 'close');

    // List rows: a fixed pool in the kit's scroll view (with its thin scrollbar), re-filled as the
    // list or its window changes.
    const made = await this.kitScrollColumn(this.mainView, { marginTop: '6px' });
    const list = this.listCol = made.col;
    this.scroller = made.scroller;
    // First, so rows added later go after it (it only shows when there are no rows): the kit's
    // empty state, a quiet glyph and a line or two (its icon is set in render).
    this.emptyLabel = this.ui.CreateKitEmptyState(list);
    this.emptyLabel.fvpTextProp = 'message';
    this.emptyLabel.SetStyles({ flexShrink: 0, marginTop: '12px' });
    // Under it while Search has no results.
    this.madeWithRow = await this.div(list, { display: 'none', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', flexShrink: 0, marginTop: '28px' });
    const madeWith = { color: '#888888', fontSize: '20px' };
    await this.label(this.madeWithRow, 'Made with', madeWith);
    await this.label(this.madeWithRow, '\u2665', { color: '#e53935', fontSize: '24px', marginLeft: '6px', marginRight: '6px' });
    await this.label(this.madeWithRow, 'by FireRat', madeWith);
    this.rows = [];
    for (let k = 0; k < FIRST_ROWS; k++) this.rows.push(await this.makeRow(list));

    // ---- Info view: how to use it, what the symbols mean, who controls the player, and where to
    // get it for a world. It scrolls.
    this.infoView = await this.div(rootEl, { display: 'none', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', marginTop: '6px' });
    const infoCol = await this.scrollColumn(this.infoView);
    const infoBox = async () => this.kitSurface(infoCol);
    const colText = (parent, text, styles) => this.label(parent, text, Object.assign({ fontSize: '21px', whiteSpace: 'normal', marginTop: '6px' }, styles || {}));
    const heading = (parent, text) => this.kitHeading(parent, text);
    // Tips on the left, each a button and what it's for; the setup guide's QR code on the right.
    this.infoIntroBox = await infoBox();
    const infoCols = await row(this.infoIntroBox, { alignItems: 'flex-start' });
    const howCol = await this.div(infoCols, { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, marginRight: '24px' });
    await heading(howCol, 'How to use it');
    const hand = 'Your hand controls: move them in More (the gear at the top). The ✕ button folds them away to one button.';
    const tips = this.karaoke ? [
      ['+ Search Songs', 'Find a song, or paste a video link. + karaoke and + lyrics help find versions with words on screen.'],
      ['▶ Preview', 'Plays the song on the screen just for you, so you can check it has lyrics before adding it.'],
      ['♪ Sing It', 'Puts you in the singer queue with that song. You can be in the queue once.'],
      ['▶ Sing', 'When it is your turn and no song is playing, press it on your name to start.'],
      ['☎ Phone', 'Shows a code. Send a link from your phone into your search, no typing in VR.'],
      ['♛ Host', 'Runs the karaoke. Press the host name at the top to see who can start songs, or to take over.'],
      ['☚ Hand', hand]
    ] : [
      // Whole sentences, each its own key, so each is translated as one.
      ['+ Search & Add', this.core.allowUntrusted === true
        ? 'Search YouTube, Internet Archive, Tubi, NASA+, ESO or a screen share by its room code: pick the source from the drop-down beside the box. Or paste a link.'
        : 'Search YouTube, Internet Archive, Tubi, NASA+ or ESO: pick the source from the drop-down beside the box. Or paste a link.'],
      ['Browse', "With Shoutcast or Tubi picked, opens its site beside the panel. Play a station, or open a movie or series, and it offers to add it."],
      ['☎ Phone', 'Shows a code. Send a link from your phone into your search, no typing in VR.'],
      ['☰ Lists', 'Saved playlists for this room. + All puts a whole list on the end.'],
      ['♛ Host', 'Runs the player for everyone. Press the host name at the top to see who else can control it, or to take over.'],
      ['☚ Hand', hand]
    ];
    // Each name has the icon its button shows, as the button shows it. Search and Lists are tabs,
    // which have no icon, so they are just their tab's name.
    const TABS = { '+ Search Songs': 'Search Songs', '+ Search & Add': 'Search', '☰ Lists': 'Lists' };
    // The host is the padlock at the top (the crown is Take Over, in More).
    const TIP_ICONS = { '♪ Sing It': '@mic', '♛ Host': '@lock', Browse: '@fvp:web' };
    for (const [name, text] of tips) {
      const tip = await row(howCol, { alignItems: 'flex-start', marginTop: '8px' });
      const nameBox = await row(tip, { width: '190px', flexShrink: 0, alignItems: 'center' });
      const tab = TABS[name];
      if (!tab) await this.kitIcons(nameBox, TIP_ICONS[name] || name.split(' ')[0]);
      const word = tab || name.replace(/^[^\p{L}\p{N}]+\s/u, '');
      await this.label(nameBox, word, { fontSize: '21px', fontWeight: 'bold', color: '#80deea', marginLeft: tab ? '0px' : '6px', flexShrink: 1, whiteSpace: 'normal' });
      await this.label(tip, text, { fontSize: '21px', whiteSpace: 'normal', flexGrow: 1, flexShrink: 1 });
    }
    const guideCol = await this.div(infoCols, { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '320px', flexShrink: 0 });
    await colText(guideCol, 'Want this player in your own world?', { fontSize: '24px', fontWeight: 'bold', textAlign: 'center', marginTop: '0px' });
    // A white square; its dark boxes are added the first time Info opens (see showQr).
    const qrSize = (SETUP_GUIDE_QR.length + 2 * QR_MARGIN) * QR_MODULE_PX;
    this.qrEl = await this.div(guideCol, { width: `${qrSize}px`, height: `${qrSize}px`, flexShrink: 0, backgroundColor: '#ffffff', marginTop: '10px' });
    await colText(guideCol, 'Scan with your phone for the setup guide, or go to', { fontSize: '19px', textAlign: 'center', color: '#bbbbbb', marginTop: '8px' });
    await this.link(guideCol, SETUP_GUIDE_URL.replace(/^https:\/\//, ''), SETUP_GUIDE_URL, { fontSize: '30px', fontWeight: 'bold', color: '#80deea', marginTop: '2px' });
    await colText(guideCol, 'Move this panel by grabbing the bar under it. Scroll down for more.', { fontSize: '19px', color: '#999999', marginTop: '16px', textAlign: 'center' });
    await colText(guideCol, 'Made by FireRat', { fontSize: '19px', color: '#999999', marginTop: '8px', textAlign: 'center' });
    this.infoVersionLabel = await colText(guideCol, '', { fontSize: '17px', color: '#888888', marginTop: '4px', textAlign: 'center' });

    // What each symbol means, two to a line.
    const legendBox = this.infoLegendBox = await infoBox();
    await heading(legendBox, 'What the buttons mean');
    const legend = [
      ['|◀', this.karaoke ? 'Start the song again (host or singer)' : 'Previous video (host)'],
      this.karaoke ? ['■', 'Stop the song (host or singer)'] : ['▶|', 'Next video (host)'],
      ['❚❚ ▶', 'Pause and play, for everyone (host)'],
      ['◀◀ ▶▶', this.karaoke ? 'Nudge your screen a little, to match the singer' : 'Skip back or forward, for you (the host: everyone)'],
      ['↻', 'Reload the video, for you only, if it froze'],
      ['Go Live', 'A live video: everyone to where it is live now (host)'],
      this.karaoke ? ['♪', 'Sing: join the queue, or start your song'] : ['▲ ▼', 'Vote a video up or down, when voting is on. Then the most votes play first, and a video leaves the playlist once it has played.'],
      ['@fvp:volume-down @volume-up', 'Your volume (only what you hear)'],
      ['@volume-off', 'Mute or unmute, for you'],
      ['⬆ ⬇', 'Move up or down the list'],
      ['✕', 'Remove, close, or turn off'],
      ['+', 'Add'],
      ['✓', 'On, or approve'],
      ['@lock', 'The host, who runs the player'],
      ['@settings', 'More: settings and host controls']
    ];
    let legendRow = null;
    for (let k = 0; k < legend.length; k++) {
      if (k % 2 === 0) legendRow = await row(legendBox, { marginTop: '6px', alignItems: 'center' });
      const [icon, text] = legend[k];
      const chip = await this.div(legendRow, {
        display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: '96px', height: '44px', backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '22px',
        // Outlined, as the buttons are.
        borderWidth: '2px', borderColor: 'rgb(120, 124, 138)'
      });
      chip.fvpNoTheme = true; // on the dark card in either theme
      await this.kitIcons(chip, icon);
      await this.label(legendRow, text, { fontSize: '20px', whiteSpace: 'normal', width: '390px', flexShrink: 1, marginLeft: '12px', marginRight: '12px' });
    }

    // Who controls the player: the three choices in ☰ (see controlLevel).
    const controlBox = await infoBox();
    await heading(controlBox, 'Who controls the player');
    await colText(controlBox, 'The host picks one of these in More (the gear at the top). The padlock at the top shows which is on.', { color: '#bbbbbb' });
    this.infoLevelChips = {};
    for (const [level, open, color, name] of this.controlLevels()) {
      const line = await row(controlBox, { marginTop: '8px', alignItems: 'center' });
      const chip = await this.div(line, {
        display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0, width: '300px', height: '48px',
        backgroundColor: color, borderRadius: '24px', paddingLeft: '14px'
      });
      chip.fvpNoTheme = true; // white on its colour in either theme
      this.infoLevelChips[level] = chip;
      await this.lockIcon(chip, open);
      await this.label(chip, name, { fontSize: '21px', marginLeft: '10px' });
      await this.label(line, this.controlText(level), { fontSize: '20px', whiteSpace: 'normal', flexGrow: 1, flexShrink: 1, marginLeft: '12px' });
    }
    await colText(controlBox, 'When the host leaves the space, Take Over turns on after 42 seconds, so the player is never stuck. A space admin can become the host at any time: press the host button at the top, then Admin Take Over.', { color: '#bbbbbb', fontSize: '19px' });

    await this.buildKitMore(rootEl, row);

    // Footer
    const footer = await row(rootEl, { marginTop: '4px' });
    this.statusLabel = await this.label(footer, '', { fontSize: '20px', color: '#ffcc66', flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });

    this.checkAlive();
    try {
      await this.addGrabHandle();
    } catch (e) {
      if (this.destroyed) throw e;
      console.warn('[PlaylistPanel] Could not make the panel grabbable, so it stays where it opens:', e);
      this.body = null;
    }
    this.checkAlive();
    this.built = true;
    this.render();
    console.log('[PlaylistPanel] Ready.');
    this.growRows();
  }

  // Page buttons beside the tabs: first, back, forward, last. They move the window of rows (see
  // LIST_WINDOW), and Now goes back to the playing video.
  async buildPageNav(parent) {
    const pageBtn = { marginLeft: '2px', marginRight: '2px', round: true, kitSize: 'md', kitVariant: 'outline' };
    this.nowBtn = this.karaoke ? null : await this.button(parent, '◉ Now', () => this.showCurrent(), Object.assign({}, pageBtn, { round: false, kitVariant: 'secondary', kitIconSize: 'md', marginRight: '6px' }));
    this.firstPageBtn = await this.button(parent, '⇤', () => this.changePage(-Infinity), pageBtn);
    this.prevPageBtn = await this.button(parent, '‹', () => this.changePage(-1), pageBtn);
    this.pageLabel = await this.label(parent, '1 / 1', { fontSize: '19px', width: '104px', textAlign: 'center', flexShrink: 0 });
    this.nextPageBtn = await this.button(parent, '›', () => this.changePage(1), pageBtn);
    this.lastPageBtn = await this.button(parent, '⇥', () => this.changePage(Infinity), pageBtn);
  }

  // The More view, as the kit's Settings page: cards with a section heading, and option
  // rows with a switch or a dropdown, or buttons where there's something to do rather than set.
  async buildKitMore(rootEl, row) {
    this.moreView = await this.div(rootEl, { display: 'none', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', marginTop: '6px' });
    const col = await this.scrollColumn(this.moreView);
    const buttons = parent => row(parent, { flexWrap: 'wrap', marginTop: '6px' });
    const note = (parent, text) => this.label(parent, text, { fontSize: '16px', color: '#999999', marginTop: '6px', whiteSpace: 'normal' });
    const optionRow = (option, styles) => row(option, Object.assign({ justifyContent: 'flex-end', flexGrow: 1 }, styles || {}));

    // Who controls the player: one choice of three (see controlLevel).
    const control = this.controlSection = this.kitSurface(col);
    this.kitHeading(control, 'Who controls the player');
    const hostLine = await row(control, { marginTop: '2px' });
    this.controlHostLabel = await this.label(hostLine, '', { fontSize: '20px', color: '#ffd54f', marginRight: '12px', flexShrink: 1 });
    this.takeOverBtn = await this.button(hostLine, '♛ Take Over', () => {
      if (this.core.player && !this.isHost()) this.send(Commands.TAKE_OVER);
    }, { backgroundColor: '#2e7d32' });
    this.adminTakeOverBtn = await this.button(hostLine, '♛ Admin Take Over', () => this.adminTakeOver());
    const choices = await row(control, { marginTop: '8px', alignItems: 'stretch' });
    this.controlCards = {};
    for (const [level, open, color, name] of this.controlLevels()) {
      const card = await this.button(choices, '', () => this.setControl(level), {
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start',
        flexGrow: 1, flexShrink: 1, flexBasis: '0px', minWidth: '0px', paddingTop: '10px', paddingBottom: '10px', paddingLeft: '12px', paddingRight: '12px',
        marginLeft: '3px', marginRight: '3px', borderWidth: '3px', borderColor: 'rgba(0,0,0,0)', borderRadius: '16px', plain: true
      });
      const top = await row(card, { alignSelf: 'stretch' });
      await this.lockIcon(top, open, 'md');
      // One line: a longer name in another language is cut rather than wrapped.
      await this.label(top, name, { fontSize: '18px', fontWeight: 'bold', marginLeft: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, minWidth: '0px' });
      await this.label(card, this.controlText(level), { fontSize: '17px', whiteSpace: 'normal', marginTop: '6px', color: '#eeeeee', textAlign: 'left' });
      this.controlCards[level] = { card, color };
    }
    this.controlNote = await note(control, '');

    // Host controls (the host only).
    this.hostSection = this.kitSurface(col);
    this.kitHeading(this.hostSection, 'Host controls');
    if (this.karaoke) {
      const o = this.kitOption(this.hostSection, 'Auto Advance', 'When a song ends, the next singer starts by themselves.');
      this.autoAdvanceBtn = this.kitToggle(o, () => this.sendToggle(this.autoAdvanceBtn, Commands.TOGGLE_AUTO_ADVANCE, 'autoAdvance'));
    } else {
      const o = this.kitOption(this.hostSection, 'Voting', 'Everyone votes videos up or down, the most votes play first, and a video leaves the playlist once it has played');
      this.votingBtn = this.kitToggle(o, () => this.sendToggle(this.votingBtn, Commands.TOGGLE_VOTE, 'canVote'));
    }
    // Seek: moves everyone. A live video's time is how far back from the live point (see doSeek).
    this.seekLabel = this.kitOption(this.hostSection, 'Go to (everyone):');
    const seekRow = await optionRow(this.seekLabel);
    this.seekField = await this.textField(seekRow, 'e.g. 95 or 1:35', v => { this.seekQuery = v; }, () => this.doSeek());
    this.seekField.SetStyles({ flexGrow: 1, flexBasis: '120px', width: '120px' });
    await this.button(seekRow, '▶ Go', () => this.doSeek(), { backgroundColor: '#1565c0' });
    await this.button(seekRow, '◀◀ 30s', () => this.seekBy(-30));
    await this.button(seekRow, '30s ▶▶', () => this.seekBy(30));
    if (!this.karaoke) {
      const hostRow = await buttons(this.hostSection);
      this.clearBtn = await this.button(hostRow, '✕ Clear Playlist', () => this.send(Commands.CLEAR_PLAYLIST), { backgroundColor: '#c62828' });
      this.loadDefaultBtn = await this.button(hostRow, '↻ Load Default Playlist', () => {
        this.send(Commands.FROM_PLAYLIST, { id: this.core.params.playlist, shouldClear: true, fromPlaylist: true });
        this.setStatus('Loading playlist...');
      }, { backgroundColor: '#2e7d32' });
    }

    // Just for you
    const mine = this.kitSurface(col);
    this.kitHeading(mine, 'Just for you (nobody else\'s player changes)');
    const mineRow = await buttons(mine);
    await this.button(mineRow, '↻ Reload Video', () => this.core.reloadScreen());
    await this.button(mineRow, '◀◀', () => this.sendMine(Commands.LOCAL_SKIP_BACK, Commands.SKIP_BACK));
    await this.button(mineRow, '▶▶', () => this.sendMine(Commands.LOCAL_SKIP_FORWARD, Commands.SKIP_FORWARD));
    await this.button(mineRow, '↻ Refresh List', () => this.refresh(true));
    this.autoSyncBtn = this.kitToggle(this.kitOption(mine, 'Auto Sync', 'Keeps your screen at the room\'s time.'), v => {
      this.autoSync = v;
      this.core.autoSync = v; // kept for a video file, which plays without the screen page
      this.sendMine(Commands.AUTO_SYNC, Commands.AUTO_SYNC, v);
      this.render();
    });
    this.captionsBtn = this.kitToggle(this.kitOption(mine, 'CC', 'Captions on your screen'), v => {
      this.core.setCaptions(v);
      this.render();
    });
    const res = this.kitOption(mine, 'Resolution', 'Your screen\'s sharpness (resolution)');
    this.resolutionDropdown = this.kitDropdown(res, [], k => {
      this.core.setScreenResolution(k === 'default' ? null : Number(k));
      this.render();
    }, { width: '300px' });
    const sound = this.kitOption(mine, 'Sound', 'Your sound: all round you (2D) or from the screen (3D)');
    this.audioDropdown = this.kitDropdown(sound, [['3d', '3D'], ['2d', '2D']], k => {
      this.core.setAudioMode(k);
      this.render();
    }, { width: '300px' });
    this.fadeToggle = this.kitToggle(this.kitOption(mine, 'Fade', 'Your sound gets quieter as you walk away, or not'), v => {
      this.core.setFade(v ? 'on' : 'off');
      this.render();
    });
    if (this.core.params['hand-controls'] === 'true') {
      const hand = this.kitOption(mine, 'Hand', 'Your hand controls');
      this.handBtn = await this.button(await optionRow(hand), '☚', () => {
        Promise.resolve(this.core.nextHandPlace()).then(() => this.render()).catch(() => {});
      });
    }

    // Look & language: this viewer's panel only.
    const look = this.kitSurface(col);
    this.kitHeading(look, 'Look & language');
    if (this.i18n) {
      this.languageDropdown = this.kitDropdown(this.kitOption(look, 'Language'), FVP_LANGUAGES.map(([k, name]) => [k, name, true]), k => this.setLanguage(k), { width: '300px' });
    }
    this.themeDropdown = this.kitDropdown(this.kitOption(look, 'Theme'), [], k => this.setTheme(k), { width: '300px' });
    this.accentDropdown = this.kitDropdown(this.kitOption(look, 'Accent'), [], k => this.setAccent(k), { width: '300px' });
    this.fillLookChoices();

    // Add by link (in karaoke mode, pasting a link into Search does this)
    if (!this.karaoke) {
      const link = this.kitSurface(col);
      this.kitHeading(link, 'Add by link');
      const linkRow = await row(link, { marginTop: '4px' });
      this.linkField = await this.textField(linkRow, 'Video link, YouTube playlist, or list of links (.txt, .m3u, Google Doc, Drive folder)', v => { this.linkQuery = v; }, () => this.addLink());
      await this.button(linkRow, '+ Add', () => this.addLink(), { backgroundColor: '#2e7d32' });
    }

    // Mode: switches everyone (see Core.switchMode). Shown to everyone; the server refuses anyone
    // who isn't a space admin.
    this.adminSection = this.kitSurface(col);
    this.kitHeading(this.adminSection, 'Space admins only');
    const adminRow = await row(this.adminSection, { flexWrap: 'wrap' });
    this.modeLabel = await this.label(adminRow, '', { fontSize: '18px', marginRight: '12px' });
    this.modeSwitchBtn = await this.button(adminRow, '', () => this.switchMode());
    this.modeDefaultBtn = await this.button(adminRow, 'Use Snippet Default', () => this.useDefaultMode());
    await note(this.adminSection, 'These only work for space admins (the world owner and community moderators). The mode switches everyone in the space. Admin Take Over is under Who controls the player, beside the host.');
  }

  // One list row: the video's picture (16:9), its title with a line under it (who added it, and
  // its length at that line's right end), the votes as a count pill and up to four buttons. Our
  // own labels rather than the kit's list row, whose title and line under it have no room for the
  // length: beside the title it cut the title short. The rows are dark in either theme, as the
  // kit's buttons on them are.
  async makeRow(parent) {
    const w = await this.div(parent, {
      display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0,
      paddingLeft: '8px', paddingRight: '6px', paddingTop: '5px', paddingBottom: '5px', marginBottom: '4px', borderRadius: '12px'
    });
    w.fvpKitRow = true;
    w.fvpNoTheme = true;
    const thumb = await this.div(w, {
      width: '112px', height: '63px', flexShrink: 0, borderRadius: '8px',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    });
    thumb.SetStyles({ backgroundColor: 'rgb(0, 0, 0)' });
    // A glyph in place of a picture, for a row without one.
    const thumbIcon = this.ui.CreateKitIcon(thumb);
    thumbIcon.size = 'lg';
    thumbIcon.tone = 'muted';
    thumbIcon.SetStyles({ display: 'none' });
    const info = await this.div(w, {
      display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: '0px', marginLeft: '14px', marginRight: '6px', overflow: 'hidden'
    });
    const cut = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
    const title = await this.label(info, '', Object.assign({ fontSize: '20px' }, cut));
    const line = await this.div(info, { display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '3px' });
    const sub = await this.label(line, '', Object.assign({ fontSize: '17px', color: '#aaaaaa', flexGrow: 1, flexShrink: 1, minWidth: '0px' }, cut));
    const meta = await this.label(line, '', { fontSize: '19px', color: '#cccccc', flexShrink: 0, marginLeft: '12px', whiteSpace: 'nowrap' });
    const slot = { row: w, thumb, thumbIcon, title, sub, meta, buttons: [], actions: [] };
    // Read-out only: the vote buttons beside it do the voting.
    slot.votes = this.ui.CreateKitCountPill(w);
    slot.votes.icon = 'thumb-up';
    slot.votes.size = 'md';
    slot.votes.interactive = false;
    slot.votes.SetStyles({ flexShrink: 0, marginLeft: '6px', marginRight: '6px', display: 'none' });
    for (let b = 0; b < 4; b++) {
      const idx = b;
      const btn = await this.button(w, '', () => { const fn = slot.actions[idx]; if (fn) fn(); }, { kitSize: 'md', marginLeft: '3px', marginRight: '3px' });
      slot.buttons.push(btn);
    }
    // Hidden until it has something to show, so a row built ahead of time stays out of the way.
    this.display(w, false);
    return slot;
  }
  // A list row's look, from the colour the fill functions give it (see THEME_COLOURS): the playing
  // one in the accent; one waiting, yours or added keeps its tint. The rows are dark in either
  // theme, so on the light theme they are a dark grey.
  kitRowLook(el, value) {
    el.fvpRaw = el.fvpRaw || {};
    el.fvpRaw.backgroundColor = value;
    this.themedEls.add(el);
    const token = THEME_COLOURS.backgroundColor[String(value).toLowerCase()] || 'row';
    const light = this.theme === 'light';
    let bg;
    if (token === 'rowCurrent') bg = light ? this.themeColour('accent') : this.themeColour('rowCurrent');
    else if (token === 'row' || token === 'rowAlt') bg = light ? 'rgb(50, 50, 56)' : 'rgba(0, 0, 0, 0)';
    else bg = light ? (LIGHT_ROW_TINTS[token] || 'rgb(50, 50, 56)') : this.themeColour(token);
    if (this._changed(el, 'backgroundColor', bg)) el.SetStyles({ backgroundColor: bg });
  }
  // A row's line under the title, and its length at that line's right end.
  setRowLines(slot, parts, dur) {
    this.setText(slot.sub, parts.filter(Boolean).join('  -  '), true);
    this.setText(slot.meta, dur || '', true);
  }

  // Builds the rest of the scroll view's rows (up to LIST_WINDOW) a few at a time after the panel
  // is ready, so opening it isn't held up and Unity isn't sent hundreds of elements at once.
  async growRows() {
    if (this.growing) return;
    this.growing = true;
    try {
      while (!this.destroyed && this.rows.length < LIST_WINDOW) {
        await new Promise(resolve => setTimeout(resolve, 60));
        if (this.destroyed) return;
        for (let k = 0; k < ROW_CHUNK && this.rows.length < LIST_WINDOW; k++) this.rows.push(await this.makeRow(this.listCol));
        this.renderSoon();
      }
    } catch (e) {
      if (!this.destroyed) console.warn(`[PlaylistPanel] Stopped adding list rows at ${this.rows.length}:`, e);
    } finally {
      this.growing = false;
    }
  }

  // Puts the scroll view back at the top after the rows move to another part of the list. The SDK
  // has no call to scroll a ScrollView, so the rows are hidden for a moment: with nothing in it,
  // UI Toolkit clamps the scroll position to the top.
  resetScroll() {
    if (!this.listCol) return;
    this.display(this.listCol, false);
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (!this.destroyed && this.listCol) this.display(this.listCol, true);
    }, 150);
  }

  // Makes the mover the handle players pick up to carry the panel, as in the SDK docs: a shape,
  // a collider, a Rigidbody, then Grababble (which adds the grab handle, a WorldObject and
  // HeldEvents, and puts it on the Grabbable layer). The panel is the handle's child, so Unity
  // carries it along. Without the Rigidbody and WorldObject the grab held on to the world like a
  // climbing hold and pulled the player instead.
  async addGrabHandle() {
    if (!BS.Rigidbody || !(BS.Grababble || BS.GrabHandle) || !BS.BoxCollider) {
      console.log('[PlaylistPanel] This client has no Rigidbody / Grababble, so the panel is not grabbable.');
      return;
    }
    const T = 15000;
    const handle = this.mover;
    // Looks like a pill lying along the panel's bottom edge, like the one under the menu. A
    // capsule stands along its Y axis, so it's on a child turned on its side; the collider stays
    // on the handle itself, at scale 1, sized to the pill.
    const length = 0.3, thick = 0.05;
    const pill = await this.withTimeout(new BS.GameObject({
      name: 'FireVPlayer_PlaylistHandlePill',
      parent: handle,
      localPosition: new BS.Vector3(0, 0, 0),
      localEulerAngles: new BS.Vector3(0, 0, 90)
    }).Async(), T, 'Creating the handle pill');
    if (BS.Capsule) await this.withTimeout(pill.AddComponent(new BS.Capsule({ radius: thick, height: length, radialSegments: 24, heightSegments: 8 })), T, 'Adding the handle shape');
    else if (BS.Box) await this.withTimeout(pill.AddComponent(new BS.Box({ width: thick, height: length, depth: thick })), T, 'Adding the handle shape');
    if (BS.Material) await this.withTimeout(pill.AddComponent(new BS.Material({ shaderName: 'Unlit/Diffuse', color: new BS.Vector4(0.85, 0.87, 0.9, 1) })), T, 'Adding the handle material');
    await this.withTimeout(handle.AddComponent(new BS.BoxCollider({ isTrigger: false, size: new BS.Vector3(length, thick + 0.02, thick + 0.02) })), T, 'Adding the handle collider');
    this.checkAlive();
    // No gravity, and it only turns around the vertical, so the panel stays upright.
    this.body = await this.withTimeout(handle.AddComponent(new BS.Rigidbody({
      mass: 1, drag: 2, angularDrag: 10, useGravity: false, isKinematic: false,
      freezeRotationX: true, freezeRotationZ: true
    })), T, 'Adding the handle Rigidbody');
    this.checkAlive();
    // Each player's panel is their own, so its network id is too: no one else's handle matches it.
    const uid = (this.core.banterScene && this.core.banterScene() && this.core.banterScene().localUser && this.core.banterScene().localUser.uid) || (window.user && window.user.id) || Math.random().toString(36).slice(2);
    if (typeof handle.SetNetworkId === 'function') {
      try { await this.withTimeout(handle.SetNetworkId(`FireVPlayer_PlaylistHandle_${uid}`), T, 'Naming the handle'); } catch (e) {}
    }
    const soft = BS.BSGrabType && BS.BSGrabType.Soft !== undefined ? BS.BSGrabType.Soft : 3;
    if (BS.Grababble) {
      await this.withTimeout(handle.AddComponent(new BS.Grababble({ grabType: soft, grabRadius: 0.01 })), T, 'Making the handle grabbable');
    } else {
      if (typeof handle.SetLayer === 'function') await this.withTimeout(handle.SetLayer((BS.L && BS.L.Grabbable) || 20), T, 'Moving the handle to the Grabbable layer');
      await this.withTimeout(handle.AddComponent(new BS.GrabHandle({ grabType: soft, grabRadius: 0.01 })), T, 'Adding the grab handle');
    }
    this.checkAlive();
    // Once carried, the screen's Playlist button brings it back beside the screen.
    handle.On('grab', () => { this.held = true; this.placement = 'moved'; });
    handle.On('drop', () => { this.held = false; this.stopDrift(); });
    console.log('[PlaylistPanel] The pill under the panel can be grabbed to carry it.');
  }

  // Rotations in Unity's convention: Euler degrees applied Z, then X, then Y.
  qMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  qEuler(e) {
    const D = Math.PI / 360;
    const ax = (i, deg) => { const q = [0, 0, 0, Math.cos(deg * D)]; q[i] = Math.sin(deg * D); return q; };
    const v = Array.isArray(e) ? e : [e.x, e.y, e.z];
    return this.qMul(this.qMul(ax(1, v[1]), ax(0, v[0])), ax(2, v[2]));
  }
  qRotate(q, v) {
    const p = this.qMul(this.qMul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
    return [p[0], p[1], p[2]];
  }

  // Stops the panel sliding on after it's let go or moved by script.
  stopDrift() {
    const b = this.body;
    if (!b) return;
    try {
      b.velocity = new BS.Vector3(0, 0, 0);
      b.angularVelocity = new BS.Vector3(0, 0, 0);
    } catch (e) {}
  }

  // Stops a build that is still running when the panel is destroyed.
  checkAlive() {
    if (this.destroyed) throw new Error('Panel destroyed during build');
  }

  // Removes the panel from the world and stops its timers and message listener.
  // Safe to call while the panel is still building: the Unity objects are removed once it stops.
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.i18n) this.i18n.cancel(); // a language still loading doesn't change it after this
    this.built = false;
    this.visible = false;
    if (this.core && this.core.previewVideo && typeof this.core.stopPreview === 'function') this.core.stopPreview();
    [this.tickTimer, this.renderTimer, this.statusTimer, this.searchTimer, this.scrollTimer, this.listExpiryTimer, this.radioCheckTimer].forEach(t => { clearTimeout(t); clearInterval(t); });
    this.tickTimer = this.renderTimer = this.statusTimer = this.searchTimer = this.scrollTimer = this.listExpiryTimer = this.radioCheckTimer = null;
    (this.thumbTimers || []).forEach(clearTimeout);
    this.thumbTimers = [];
    if (typeof this.core.removeMessageListener === 'function') this.core.removeMessageListener(this.onMessageFn);
    clearTimeout(this.speechTimer);
    clearTimeout(this.pasteCodeTimer);
    if (this.siteBrowser) { this.siteBrowser.destroy(); this.siteBrowser = null; }
    if (this.onTranscription) {
      const scene = this.core.banterScene();
      try { if (scene && typeof scene.Off === 'function') scene.Off('transcription', this.onTranscription); } catch (e) {}
    }
    const removeObjects = () => {
      try {
        if (this.root && typeof this.root.Destroy === 'function') this.root.Destroy();
      } catch (e) {
        console.warn('[PlaylistPanel] Could not remove the panel objects:', e);
      }
      this.root = this.mover = this.panelObj = this.ui = this.body = null;
    };
    if (this.buildPromise) this.buildPromise.then(removeObjects, removeObjects);
    else removeObjects();
    console.log('[PlaylistPanel] Destroyed.');
  }

  // ---------------------------------------------------------------- show / hide

  /**
   * Toggles the visibility of the in-world playlist panel or positions it.
   * @param {'front'|'singer'|undefined} [where] - Where to place the panel ('front' in front of player, 'singer' above karaoke button, or undefined for beside screen).
   * @returns {Promise<void>}
   */
  async toggle(where) {
    if (!this.built && !this.failed) console.log('[PlaylistPanel] Still building, will open when ready.');
    await this.build();
    if (this.destroyed) return;
    if (this.failed) {
      this.core.openPlaylistPage();
      return;
    }
    let want = 'home';
    if (where === 'front' && this.frontPose(true)) want = 'front';
    else if (where === 'singer' && this.singerPose()) want = 'singer';
    if (this.visible && this.placement === want && want !== 'front') return this.close();
    // In front, a press while it's open in front closes it only when the player hasn't turned
    // away from it; otherwise it comes round to where they're looking.
    if (this.visible && want === 'front' && this.placement === 'front' && !this.lookedAway()) return this.close();
    await this.place(want, true);
    if (!this.visible) await this.open();
  }

  /**
   * Moves the panel root GameObject to show (shownPos) or hide (hiddenPos) it.
   * @param {Object} pos - Local position vector.
   * @returns {Promise<void>}
   */
  async moveTo(pos) {
    const o = this.panelObj;
    if (!o) return;
    await this.setLocal(o, pos, null);
  }

  // ---------------------------------------------------------------- placement

  /**
   * Calculates the target world position and yaw angle to place the panel directly in front of the local player.
   * @param {boolean} fromHand - Whether triggered by the wrist controls button.
   * @returns {{yaw: number, source: string, position: Object}|null}
   */
  frontPose(fromHand) {
    const head = this.core.headPose();
    if (!head || !head.position) return null;
    const p = head.position;
    let yaw = null;
    // Toward the hand only when the head comes from pose-update, whose facing can't be trusted.
    // The head marker's own facing is what the player sees, and it's in the same space as its
    // position; the hand's pose comes another way, and aiming at it put the panel to one side
    // (desktop players' hands don't follow their view) or off where the play space had moved.
    const hand = this.core.handPose;
    if (fromHand && head.source !== 'marker' && hand && hand.position) {
      const dx = hand.position.x - p.x, dz = hand.position.z - p.z;
      if (Math.hypot(dx, dz) > 0.05) yaw = Math.atan2(dx, dz);
    }
    const q = head.rotation;
    if (yaw === null && q) {
      // The head's forward (+Z) flattened onto the floor.
      const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      if (Math.abs(fx) + Math.abs(fz) > 1e-6) yaw = Math.atan2(fx, fz);
    }
    if (yaw === null) return null;
    const d = 0.9;
    // pose-update's height on Quest is about the floor under the player, not their eyes, so the
    // panel goes at standing chest height above it (playlist-panel-front-height).
    const frontHeight = parseFloat(this.core.params['playlist-panel-front-height']);
    const lift = head.source === 'pose-update' ? (Number.isFinite(frontHeight) ? frontHeight : 1.4) : -0.1;
    return {
      yaw: yaw * 180 / Math.PI,
      source: head.source,
      position: new BS.Vector3(p.x + Math.sin(yaw) * d, p.y + lift, p.z + Math.cos(yaw) * d)
    };
  }

  /**
   * Checks whether the player's head has rotated more than 45 degrees away from the panel.
   * @returns {boolean} True if player looked away.
   */
  lookedAway() {
    const now = this.frontPose(true);
    if (!now || this.frontYaw === undefined) return false;
    const diff = Math.abs(((now.yaw - this.frontYaw) % 360 + 540) % 360 - 180);
    return diff > 45;
  }

  /**
   * Calculates the position and yaw angle to place the panel just above karaoke's Singers button.
   * @returns {{yaw: number, position: Object}|null} Position descriptor or null.
   */
  singerPose() {
    const s = this.core.singerPose || this.singerPoseFromLayout();
    if (!s || !s.position) return null;
    const q = s.rotation;
    let yaw = 0;
    if (q) {
      // The button's forward (+Z) flattened onto the floor.
      const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      if (Math.abs(fx) + Math.abs(fz) > 1e-6) yaw = Math.atan2(fx, fz) * 180 / Math.PI;
      // The panel is seen from its -Z, like the button's front. The button reads from both
      // sides, so a player on its back (+Z) side gets the panel turned round to face them.
      const head = this.core.headPose();
      if (head && head.position && (head.position.x - s.position.x) * fx + (head.position.z - s.position.z) * fz > 0) yaw += 180;
    }
    return { yaw, position: new BS.Vector3(s.position.x, s.position.y, s.position.z) };
  }

  // The Singers button's world pose from its settings, for when Unity hasn't reported it (it
  // only does when the button moves): its own values, or offsets from the buttons under the screen.
  singerPoseFromLayout() {
    const l = this.core.singerLayout;
    if (!l || !l.position) return null;
    const v = o => [o.x, o.y, o.z];
    let pos = v(l.position), q = this.qEuler(l.rotation);
    if (!l.world && l.parent) {
      const P = l.parent, sc = v(P.scale), pq = this.qEuler(P.rotation);
      const r = this.qRotate(pq, [pos[0] * sc[0], pos[1] * sc[1], pos[2] * sc[2]]);
      pos = [P.position.x + r[0], P.position.y + r[1], P.position.z + r[2]];
      q = this.qMul(pq, q);
    }
    return { position: { x: pos[0], y: pos[1], z: pos[2] }, rotation: { x: q[0], y: q[1], z: q[2], w: q[3] } };
  }

  /**
   * Positions and orients the playlist panel root and mover GameObjects.
   * @param {'front'|'singer'|'home'} where - Destination anchor location.
   * @param {boolean} [fromHand] - Whether triggered from wrist controls.
   * @returns {Promise<void>}
   */
  async place(where, fromHand) {
    const root = this.root, mover = this.mover;
    if (!root || !mover) return;
    if (where === 'front') {
      await this.core.freshHeadPose(); // where the player looks now, not at the last report
      const pose = this.frontPose(fromHand);
      if (!pose) return;
      this.frontYaw = pose.yaw;
      const f = n => Number(n).toFixed(2);
      const head = this.core.headPose();
      console.log(`[PlaylistPanel] In front: head (${head.source}) ${f(head.position.x)} ${f(head.position.y)} ${f(head.position.z)}, facing ${Math.round(pose.yaw)} degrees${fromHand && head.source !== 'marker' ? ' (toward the hand)' : ''}.`);
      if (this.core.params['screen-debug'] === 'true') {
        this.setStatus(`Head (${head.source}) ${f(head.position.x)} ${f(head.position.y)} ${f(head.position.z)}, facing ${Math.round(pose.yaw)}°`, 15000);
      }
      // The panel is seen from -Z, so facing the same way as the player turns its front to them.
      await this.setLocal(root, pose.position, new BS.Vector3(0, pose.yaw, 0));
      await this.setLocal(mover, new BS.Vector3(0, -this.handleDrop, 0), new BS.Vector3(0, 0, 0));
    } else if (where === 'singer') {
      const pose = this.singerPose();
      if (!pose) return;
      // The grab handle sits just above the button, and the panel above the handle.
      await this.setLocal(root, pose.position, new BS.Vector3(0, pose.yaw, 0));
      await this.setLocal(mover, new BS.Vector3(0, 0.3, 0), new BS.Vector3(0, 0, 0));
    } else {
      const h = this.home;
      await this.setLocal(root, h.rootLocalPos, h.rootLocalRot);
      await this.setLocal(mover, h.moverPos, h.moverRot);
    }
    this.stopDrift();
    this.moverHidden = false;
    this.placement = where;
    await this.moveTo(this.visible ? this.shownPos : this.hiddenPos);
  }

  /**
   * Applies local position and Euler angles to a Banter GameObject.
   * @param {Object} o - Target GameObject.
   * @param {Object} [pos] - Local position.
   * @param {Object} [euler] - Local Euler angles.
   * @returns {Promise<void>}
   */
  async setLocal(o, pos, euler) {
    if (pos) {
      if (typeof o.SetLocalPosition === 'function') await o.SetLocalPosition(pos);
      else if (o.transform) o.transform.localPosition = pos;
    }
    if (euler) {
      if (typeof o.SetLocalEulerAngles === 'function') await o.SetLocalEulerAngles(euler);
      else if (o.transform) o.transform.localEulerAngles = euler;
    }
  }

  /**
   * Re-requests full playback state from server and updates UI status message.
   * @param {boolean} showStatus - Whether to show loading status in toast/footer.
   */
  refresh(showStatus) {
    if (this.core.requestState()) {
      this.refreshing = showStatus;
      if (showStatus) this.setStatus('Refreshing...', 0);
    } else if (showStatus) {
      this.setStatus('Not connected to the server. Reconnecting...');
    }
  }

  /**
   * Reveals the panel, triggers render, and starts the playback ticker timer.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.destroyed) return;
    this.visible = true;
    this.refresh(false);
    // Start at the current track.
    const player = this.core.player;
    if (this.tab === 'playlist' && !this.karaoke && player && typeof player.currentTrack === 'number') {
      this.page = this.currentStart();
      this.resetScroll(); // also back to the top if it was scrolled before closing
    }
    this.render();
    // Closed, or just built (as after a mode change): it needs a place first.
    if (this.moverHidden && this.placement === 'front') await this.place('front', false);
    if (this.moverHidden && this.placement === 'singer') await this.place('singer', false);
    if (this.moverHidden) await this.place('home', false); // also when the head isn't known
    await this.moveTo(this.shownPos);
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.updateTime(), 1000);
  }

  /**
   * Hides the panel, releases active grab holds, and stops the ticker timer.
   * @returns {Promise<void>}
   */
  async close() {
    this.stopPreview(true);
    // The Browse window closes with the panel: on Quest its sound isn't placed, so it would carry on.
    if (this.siteBrowser || this.browseOpening) this.closeBrowse();
    if (this.held && this.mover && typeof this.mover.ReleaseGrab === 'function') {
      try { await this.mover.ReleaseGrab(); } catch (e) {}
    }
    this.held = false;
    this.visible = false;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.moveTo(this.hiddenPos);
    // The handle goes too; opening always places it again first.
    if (this.mover) {
      await this.setLocal(this.mover, new BS.Vector3(0, -1000, 0), null);
      this.moverHidden = true;
      this.stopDrift();
    }
  }

  // ---------------------------------------------------------------- actions

  changeTrack(delta) {
    const player = this.core.player;
    if (!player || !player.playlist || !player.playlist.length) return;
    const len = player.playlist.length;
    const index = (player.currentTrack + delta + len) % len;
    // next: with voting on, the server ends the current song instead (see setVideoTrack), and
    // only if it is still the one named in current (not after a double press or a song's end).
    const playing = player.playlist[player.currentTrack];
    this.send(Commands.SET_TRACK, delta > 0 ? { index, next: true, current: playing && playing.link } : index);
  }

  setTab(tab) {
    if (tab !== this.tab) this.resetScroll();
    this.tab = tab;
    if (tab === 'lists') this.loadSavedLists();
    this.render();
  }

  setView(view) {
    this.view = view;
    this.render();
    if (view === 'info') this.showQr();
  }

  // Draws the setup guide's QR code the first time Info opens.
  async showQr() {
    if (!this.qrEl || this.qrBuilt) return;
    this.qrBuilt = true;
    await this.drawQr(this.qrEl, SETUP_GUIDE_QR, []);
  }

  // Draws a QR code (rows of '0'/'1') into a white square: one dark box per run of dark squares
  // in a row. Boxes from an earlier code are moved and reused, and the spare ones hidden. Draws
  // into the same boxes take turns, and one a newer draw has replaced stops, so two codes never mix.
  drawQr(el, rows, boxes) {
    const run = boxes.run = (boxes.run || 0) + 1;
    const draw = () => this.drawQrNow(el, rows, boxes, run);
    boxes.queue = (boxes.queue || Promise.resolve()).then(draw, draw);
    return boxes.queue;
  }

  async drawQrNow(el, rows, boxes, run) {
    if (this.destroyed || boxes.run !== run) return;
    const px = QR_MODULE_PX, edge = QR_MARGIN * px;
    const side = `${(rows.length + 2 * QR_MARGIN) * px}px`;
    el.SetStyles({ width: side, height: side });
    let used = 0;
    for (let y = 0; y < rows.length; y++) {
      const line = rows[y];
      for (let x = 0; x < line.length; x++) {
        if (line[x] !== '1') continue;
        let end = x;
        while (end + 1 < line.length && line[end + 1] === '1') end++;
        if (this.destroyed) return;
        const styles = {
          display: 'flex', position: 'absolute', left: `${edge + x * px}px`, top: `${edge + y * px}px`,
          width: `${(end - x + 1) * px}px`, height: `${px}px`, backgroundColor: '#000000'
        };
        if (used < boxes.length) boxes[used].SetStyles(styles);
        else boxes.push(await this.div(el, styles));
        used++;
        if (boxes.run !== run) return;
        x = end;
      }
    }
    for (let k = used; k < boxes.length; k++) boxes[k].SetStyles({ display: 'none' });
  }

  // "95", "1:35" or "1:02:03" -> seconds, or null.
  parseTime(str) {
    const t = String(str || '').trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    if (!/^\d+(:\d{1,2}){1,2}$/.test(t)) return null;
    return t.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }

  // How long the current track is, or for a live video how far its live point is (see core.liveEnd).
  trackLength() {
    const p = this.core.player;
    return this.core.liveEnd(Date.now() / 1000 - this.clockSkew) || (p && p.duration) || 0;
  }

  currentPlaybackTime() {
    const p = this.core.player;
    if (!p) return 0;
    return p.paused ? (p.currentTime || 0) : ((Date.now() / 1000 - this.clockSkew) - (p.lastStartTime || 0));
  }

  doSeek() {
    if (!this.isHost()) { this.setStatus('Only the host can seek.'); return; }
    // A live video: the time is how far back from the live point ("-" or not).
    const range = this.liveRange();
    const t = this.parseTime(range ? String(this.seekQuery || '').trim().replace(/^-/, '') : this.seekQuery);
    if (t === null) { this.setStatus('Enter a time in seconds (95) or mm:ss (1:35).'); return; }
    if (range) {
      this.send(Commands.SET_TIME, range.end - t);
      this.setStatus(t < 15 ? 'Going live' : `Going to ${this.timeCode(t)} before live`);
      return;
    }
    this.send(Commands.SET_TIME, t);
    this.setStatus(`Seeking to ${this.timeCode(t)}`);
  }

  // The current live video's seekable part (see core.liveRange), or null.
  liveRange() { return this.core.liveRange(Date.now() / 1000 - this.clockSkew); }

  // Everyone to the live point: a time past it, which the server brings back to the live point
  // as it is when it gets there.
  goLive() {
    if (!this.isHost()) { this.setStatus('Only the host can go to the live point.'); return; }
    if (!this.liveRange()) return;
    this.send(Commands.SET_TIME, 1e9);
    this.setStatus('Going live');
  }

  seekBy(delta) {
    if (!this.isHost()) { this.setStatus('Only the host can seek.'); return; }
    const p = this.core.player;
    if (!p || !p.playlist || !p.playlist.length) return;
    // A file may have no known length; then only the start limits it.
    const end = this.trackLength();
    const t = Math.max(0, end > 0 ? Math.min(end, this.currentPlaybackTime() + delta) : this.currentPlaybackTime() + delta);
    this.send(Commands.SET_TIME, t);
  }

  // The host can click the progress bar, or press on it and drag, to move everyone to that point.
  // While dragging, the bar and time show where it will go; letting go (or leaving the bar) seeks.
  addProgressSeek(el) {
    if (typeof el.OnMouseDown !== 'function') return; // an SDK without mouse events
    const canSeek = () => {
      const p = this.core.player;
      return !this.core.blocked && this.isHost() && !!p && !!p.playlist && p.playlist.length > 0 && this.trackLength() > 0;
    };
    // The song the drag began on: if another starts meanwhile, the drag is dropped, as its time
    // was for the old song. The play count catches the same song starting again (a restart, a
    // one-song playlist looping, the next singer picking the same song).
    const song = () => {
      const p = this.core.player;
      const v = p && p.playlist && p.playlist[p.currentTrack];
      return v ? `${this.trackPlays || 0}|${p.currentTrack}|${v.link}` : null;
    };
    const stillOn = () => canSeek() && song() === this.dragSong;
    const cancel = () => { this.dragSeek = null; this.updateTime(); };
    // A live video's bar is its last 12 hours (or less), up to the live point (see core.liveRange).
    const at = (e) => {
      const x = e && Number.isFinite(e.clientX) ? e.clientX : 0;
      const f = Math.min(1, Math.max(0, x / this.progressWidth()));
      const range = this.liveRange();
      if (range) return range.start + f * (range.end - range.start);
      const d = this.trackLength();
      return Math.min(f * d, Math.max(0, d - 1)); // the very end would end the song
    };
    const show = (t) => {
      const range = this.liveRange();
      if (range) {
        this.setTimeText(this.core.liveTimeText(t, range, s => this.timeCode(s)));
        this.setStyle(this.progInner, 'width', `${this.livePercent(t, range)}%`);
        return;
      }
      const d = this.trackLength();
      this.setTimeText(`${this.timeCode(t)} / ${this.timeCode(d)}`);
      this.setStyle(this.progInner, 'width', `${Math.round((t / d) * 200) / 2}%`);
    };
    const finish = () => {
      if (this.dragSeek == null) return;
      const t = this.dragSeek;
      if (!stillOn()) { cancel(); return; }
      this.dragSeek = null;
      const range = this.liveRange();
      if (range && this.core.atLivePoint(t, range)) { this.goLive(); return; } // its end: the live point as it is then
      this.send(Commands.SET_TIME, t);
      this.setStatus(range ? `Going to ${this.timeCode(range.end - t)} before live` : `Seeking to ${this.timeCode(t)}`);
    };
    el.OnMouseDown(e => {
      if (e && e.button) return; // the main button / trigger only
      if (!canSeek()) {
        if (!this.core.blocked && !this.isHost()) this.setStatus('Only the host can seek.');
        return;
      }
      this.dragSong = song();
      this.dragSeek = at(e);
      show(this.dragSeek);
    });
    el.OnMouseMove(e => {
      if (this.dragSeek == null) return;
      if (!stillOn()) { cancel(); return; }
      this.dragSeek = at(e);
      show(this.dragSeek);
    });
    el.OnMouseUp(e => {
      if (this.dragSeek != null && stillOn()) this.dragSeek = at(e);
      finish();
    });
    el.OnMouseLeave(() => finish());
  }

  // + Add on a search result or a list's video. While locked, someone else's video waits for the
  // host (the server says so).
  addVideo(v) {
    this.send(Commands.ADD_TO_PLAYLIST, v);
    this.setStatus(this.addWaits() ? `Asking the host to add "${v.title}"...` : `Added "${v.title}"`);
  }

  // mode: false (one video), 'replace' (load as the playlist), 'append' (add a whole list to the
  // end) or 'browse' (open it in the Lists tab).
  // Add by link: a video is added, a playlist or list of links asks what to do with it.
  addLink() {
    const q = (this.linkQuery || '').trim();
    if (!q) { this.setStatus('Paste a link first.'); return; }
    if (this.askAboutList(q)) return;
    // YouTube, Twitch, Vimeo or a direct video link: the server checks it can be played.
    if (!this.core.getId(q) && !/^(https?|rtspt?):\/\//i.test(q)) { this.setStatus('That is not a video link.'); return; }
    this.send(Commands.ADD_TO_PLAYLIST, q);
    this.setStatus('Adding video...');
  }

  // The playlist or list of links in a pasted link, or null. A link to a video in a YouTube
  // playlist (watch?v=...&list=PL...) counts, and the prompt offers just the video too.
  listIn(text) {
    const q = String(text || '').trim();
    if (!q || this.karaoke) return null;
    const id = this.core.getPlaylistId(q) || (typeof this.core.getListLink === 'function' ? this.core.getListLink(q) : null);
    if (!id) return null;
    return { id, link: q, video: !!this.core.getId(q) };
  }

  // Shows the Replace / Add All / Save to Lists question for a pasted playlist. True if it was one.
  askAboutList(text) {
    const found = this.listIn(text);
    if (!found) return false;
    this.pendingList = found;
    this.requestList(found.id, false); // its name and size, for the question
    this.view = 'main';
    this.render();
    return true;
  }

  answerListPrompt(choice) {
    const found = this.pendingList;
    this.pendingList = null;
    if (!found || !choice) { this.render(); return; }
    if (choice === 'replace') { this.replaceWithList(found.id); this.closeSearch(); }
    else if (choice === 'append') { this.appendList(found.id); this.closeSearch(); }
    else if (choice === 'share') this.shareList(found.id);
    else if (choice === 'save') this.saveList(found.id);
    else if (choice === 'video') {
      if (!this.canAdd() && !this.addWaits()) this.setStatus('The player is locked: only the host can add videos.');
      else { this.send(Commands.ADD_TO_PLAYLIST, found.link); this.setStatus(this.addWaits() ? 'Asking the host...' : 'Adding video...'); }
    }
    this.render();
  }

  // The room's shared lists, from the server (see playlistHandler.saveList), as Lists tab entries.
  sharedLists() {
    const p = this.core.player;
    const raw = p && Array.isArray(p.lists) ? p.lists : [];
    return raw.filter(l => l && typeof l.link === 'string' && typeof l.id === 'string').map(l => ({
      id: l.link,
      label: String(l.title || 'Playlist'),
      shared: l.id,
      by: l.by && l.by.name ? String(l.by.name) : ''
    }));
  }

  // Saves a list to the room's shared Lists, for everyone here (the host, or anyone while unlocked).
  // The server checks the list works first, and replies with LISTS_UPDATED and a message.
  shareList(id) {
    if (!this.canAdd()) { this.setStatus('The player is locked: only the host can save lists for everyone. Use Save for Me.'); return; }
    this.send(Commands.SAVE_LIST, { link: id });
    this.setStatus('Saving the list for everyone...', 0);
    this.view = 'main';
    this.tab = 'lists';
  }

  // Takes a list out of the room's shared Lists (same rule as saving).
  unshareList(list) {
    if (!this.canAdd()) { this.setStatus('The player is locked: only the host can remove shared lists.'); return; }
    this.send(Commands.REMOVE_LIST, { id: list.shared });
    if (this.openListId === list.id) this.openListId = null;
    this.setStatus('Removed from the shared Lists.');
  }

  // Keeps a list in the Lists tab on this device ("My lists"), and shows it there.
  saveList(id) {
    const snippetLists = this.savedLists || [];
    if (!this.userLists.some(l => l.id === id) && !snippetLists.some(l => l.id === id)) {
      const data = this.listData.get(id);
      const label = (data && data.state === 'ready' && data.title) || (typeof this.core.listLabel === 'function' ? this.core.listLabel(id) : 'Playlist');
      this.userLists.push({ id, label, user: true });
      this.saveUserLists();
    }
    this.extraLists = this.extraLists.filter(l => l.id !== id);
    this.setStatus('Saved to your own Lists, on this device.');
    this.view = 'main';
    this.openListId = null;
    this.toggleList(id);
  }

  // Takes a list this viewer saved out of the Lists tab.
  removeList(id) {
    this.userLists = this.userLists.filter(l => l.id !== id);
    this.saveUserLists();
    if (this.openListId === id) this.openListId = null;
    this.setStatus('Removed from your own Lists.');
    this.render();
  }

  // Takes a list opened for this visit out of the Lists tab.
  removeExtraList(id) {
    this.extraLists = this.extraLists.filter(l => l.id !== id);
    if (this.openListId === id) this.openListId = null;
    this.render();
  }

  // Search covers the whole panel; Back returns to where it was opened from.
  openSearch() {
    if (this.tab !== 'search') this.tabBeforeSearch = this.tab;
    this.view = 'main';
    this.setTab('search');
    if (this.searchField && typeof this.searchField.Focus === 'function' && !this.searchResults.length) {
      try { this.searchField.Focus(); } catch (e) {}
    }
  }
  closeSearch() {
    if (this.tab !== 'search') return;
    this.setTab(this.tabBeforeSearch && this.tabBeforeSearch !== 'search' ? this.tabBeforeSearch : 'playlist');
  }

  confirmReplace() {
    const r = this.pendingReplacement;
    if (!r) return;
    this.send(Commands.REPLACE_VIDEO, { originalLink: r.original.link, alternativeVideo: r.alternative });
    this.dismissReplace();
  }

  dismissReplace() {
    this.pendingReplacement = null;
    this.render();
  }

  // The furthest a tab's rows can start: the last full window.
  maxStart(total) {
    return Math.max(0, total - this.pageSize());
  }

  // Moves the rows by `delta` windows, or to either end with -Infinity / Infinity.
  changePage(delta) {
    const size = this.pageSize();
    const from = this.tabStart();
    this.showFrom(Math.min(this.maxStart(this.tabItems().length), Math.max(0, from + delta * size)));
  }

  // Shows the current tab's rows from item `start`, at the top of the scroll view.
  showFrom(start) {
    const changed = start !== this.tabStart();
    this.setTabStart(start);
    if (changed) this.resetScroll();
    this.render();
  }

  // ---------------------------------------------------------------- Browse (site-browser.js)

  // Whether this client can open a site in a browser window (a BS Browser).
  canBrowse() {
    return !this.karaoke && typeof BS !== 'undefined' && (typeof BS.Browser === 'function' || typeof BS.BanterBrowser === 'function');
  }

  // Opens the picked source's site (Shoutcast or Tubi) in a window beside the panel, or closes the
  // one that's open.
  async toggleBrowse() {
    if (this.siteBrowser || this.browseOpening) {
      this.closeBrowse();
      return;
    }
    const site = this.searchSource;
    if (!BROWSE_SITES.includes(site)) {
      this.setStatus('Pick Shoutcast or Tubi in the drop-down to browse its site.');
      return;
    }
    if (!this.canBrowse()) { this.setStatus("This app can't open a browser window here."); return; }
    if (typeof FireSiteBrowser === 'undefined') {
      this.setStatus('Opening the browser...', 0);
      // This opening's own token: a Close (or a newer opening) meanwhile takes it away.
      const token = this.browseOpening = {};
      await this.core.setupScript(null, 'site-browser');
      if (this.browseOpening !== token) return;
      this.browseOpening = false;
      if (this.destroyed) return;
      if (typeof FireSiteBrowser === 'undefined') { this.setStatus("Couldn't open the browser."); return; }
    }
    // Beside the panel (or in front of it: see moveBrowse), in the panel's mover so it moves with it.
    const browser = this.siteBrowser = new FireSiteBrowser(this.core, {
      parent: this.mover,
      position: this.browsePosition(this.browsePlace()),
      onMessage: msg => this.onBrowseMessage(msg),
      // The site's own sound plays at the volume this viewer hears the Fire Player at.
      getVolume: () => (typeof this.core.heardVolume === 'function' ? this.core.heardVolume() : 100)
    });
    try {
      await browser.open(site);
    } catch (e) {
      if (this.siteBrowser === browser) this.siteBrowser = null;
      // The failed attempt's window goes too.
      try { browser.destroy(); } catch (err) {}
      this.setStatus("Couldn't open the browser.");
      this.render();
      return;
    }
    this.setStatus(site === 'tubi'
      ? 'Tubi is open beside the panel. Open a movie or a series there to add it.'
      : 'Shoutcast is open beside the panel. Press Play on a station there to add it.', 8000);
    this.render();
  }

  // Where Browse's window goes, kept on this device for this world (its page's own storage): 'right'
  // of the panel, 'left' of it (when the panel sits left of the screen, the right is behind the
  // screen), or 'front', nearer the viewer and low enough that the panel's top (Close Browser,
  // Move Browser) shows above it.
  browsePlace() {
    return this.loadSetting('fvpBrowsePlace', BROWSE_PLACES, 'right');
  }
  browsePosition(place) {
    const beside = this.panelWidthM / 2 + 0.06 + FireSiteBrowser.width() / 2;
    if (place === 'left') return new BS.Vector3(-beside, this.handleDrop, 0);
    if (place === 'front') return new BS.Vector3(0, this.handleDrop - FireSiteBrowser.height() / 2 - 0.1, -0.45);
    return new BS.Vector3(beside, this.handleDrop, 0);
  }
  moveBrowse() {
    const browser = this.siteBrowser;
    if (!browser) return;
    const place = BROWSE_PLACES[(BROWSE_PLACES.indexOf(this.browsePlace()) + 1) % BROWSE_PLACES.length];
    this.saveSetting('fvpBrowsePlace', place);
    browser.moveTo(this.browsePosition(place));
    this.setStatus({ right: 'The browser is on the right of the panel.', left: 'The browser is on the left of the panel.', front: 'The browser is in front of the panel.' }[place], 4000);
  }

  // Closes the browser window. The panel forgets it first, so Close works even if removing the
  // window fails.
  closeBrowse() {
    this.browseOpening = false;
    const browser = this.siteBrowser;
    this.siteBrowser = null;
    this.browseOffer = null;
    if (browser) {
      try { browser.destroy(); } catch (e) { console.warn('[PlaylistPanel] Could not close the browser window:', e); }
      console.log('[PlaylistPanel] Closed the browser window.');
    }
    this.renderSoon();
  }

  // A message from the browser window's page: the page it moved to, or a station played there.
  onBrowseMessage(msg) {
    if (msg.type === 'add') { this.addBrowseOffer(false); return; }
    if (msg.type === 'now') { this.addBrowseOffer(true); return; }
    if (msg.type === 'extra') { this.showEpisodes(this.browseOffer && this.browseOffer.link); return; }
    if (msg.type === 'station' && /^\d{1,12}$/.test(String(msg.id || ''))) {
      const name = String(msg.name || '').trim().slice(0, 120) || this.tr('Radio station');
      const link = `https://directory.shoutcast.com/sbin/tunein-station.m3u?id=${msg.id}`;
      // The server says whether it can play here (an https stream, or the relay): RADIO_CHECK_RESULT.
      this.setBrowseOffer({ link, title: name, kind: 'station', check: 'checking' });
      this.askRadioCheck(link);
      return;
    }
    if (msg.type !== 'page') return;
    const media = window.MediaSources ? MediaSources.detect(String(msg.url || '')) : null;
    if (!media || media.type !== 'tubi') {
      // Moving to another page leaves a Shoutcast station's offer up, but not a Tubi title's.
      if (this.browseOffer && this.browseOffer.kind !== 'station') this.setBrowseOffer(null);
      return;
    }
    // The page's title: "Name (2020) - Stream Free | Tubi" (a movie) or "Watch Name Streaming
    // Online | Tubi Free TV" (a series).
    const title = String(msg.title || '').replace(/^Watch\s+/i, '').replace(/\s*\|\s*Tubi.*$/i, '')
      .replace(/\s+[-–]\s+Stream(ing)? Free.*$/i, '').replace(/\s+Streaming Online$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim().slice(0, 120)
      || this.tr(media.kind === 'series' ? 'Tubi series' : 'Tubi video');
    const path = media.kind === 'series' ? 'series' : media.kind === 'episode' ? 'tv-shows' : 'movies';
    this.setBrowseOffer({ link: `https://tubitv.com/${path}/${media.id}`, title, kind: media.kind === 'series' ? 'series' : 'video' });
  }

  // Asks the server whether a station can play here, and again every RADIO_CHECK_RETRY_MS while
  // its offer still waits: a reply lost with the connection would leave it checking for good.
  // The server keeps its answer a while, so asking again costs it little.
  askRadioCheck(link) {
    clearTimeout(this.radioCheckTimer);
    this.send(Commands.RADIO_CHECK, { link });
    this.radioCheckTimer = setTimeout(() => {
      const o = this.browseOffer;
      if (this.destroyed || !o || o.link !== link || o.check !== 'checking') return;
      this.askRadioCheck(link);
    }, RADIO_CHECK_RETRY_MS);
  }

  // Shows what Browse found, in the panel and as a bar on the page, or hides it (null).
  setBrowseOffer(offer) {
    this.browseOffer = offer;
    if (this.siteBrowser) {
      // A station the server found can't play here (only over http, with the relay off) has no buttons.
      const bad = !!offer && offer.check === 'bad';
      // A station still being checked shows no buttons yet either.
      const ready = !!offer && !bad && offer.check !== 'checking';
      const note = !offer || offer.kind !== 'station' ? ''
        : bad ? (offer.error || this.tr("That station can't play here."))
          : offer.check === 'ok' ? this.tr("The website can't play this station itself, but the Fire Player can: add it with the bar above.")
            : this.tr("The website can't play this station itself. Checking whether the Fire Player can...");
      this.siteBrowser.offer(offer ? {
        text: bad ? this.tr('"{title}" can\'t play here.', { title: offer.title })
          : this.tr(offer.kind === 'series' ? 'Add episodes of "{title}" to the playlist?' : 'Add "{title}" to the playlist?', { title: offer.title }),
        now: ready && offer.kind !== 'series' && this.isHost() ? this.tr('Play Now') : '',
        add: !ready || offer.kind === 'series' ? '' : this.tr('Add to Playlist'),
        extra: offer.kind === 'series' ? this.tr('Pick Episodes') : '',
        note,
        what: offer.kind
      } : null);
    }
    this.renderSoon();
  }

  // Adds what Browse found, or plays it now (the host). The server looks its title and length up,
  // except a Tubi title's, which this device looks up when it can (the server may be in a country
  // Tubi doesn't serve).
  async addBrowseOffer(now) {
    const o = this.browseOffer;
    if (!o) return;
    if (o.kind === 'series') { this.showEpisodes(o.link); return; }
    if (o.check === 'bad') { this.setStatus(o.error || "That station can't play here."); return; }
    if (o.check === 'checking') { this.setStatus("The website can't play this station itself. Checking whether the Fire Player can..."); return; }
    if (now && !this.isHost()) { this.setStatus('Only the host can play something now.'); return; }
    if (!now && !this.canAdd() && !this.addWaits()) { this.setStatus('The player is locked: only the host can add videos.'); return; }
    // Done with the site: it closes (Browse opens it again for more).
    this.closeBrowse();
    let what = o.link;
    if (o.kind === 'video' && window.isBanter && typeof this.core.tubiResolver === 'function') {
      this.setBrowseOffer(null);
      this.setStatus(this.tr('Looking up "{title}"...', { title: o.title }), 0);
      try {
        const tubi = await this.core.tubiResolver();
        const found = tubi ? await tubi.stream(o.link) : null;
        if (found && found.ok) what = { title: found.title || o.title, link: o.link, duration: found.duration, thumbnail: found.thumbnail };
      } catch (e) {}
      if (this.destroyed) return;
    }
    if (now) {
      this.send(Commands.ADD_AND_PLAY, what);
      this.setStatus(this.tr('Playing "{title}"', { title: o.title }));
    } else {
      this.send(Commands.ADD_TO_PLAYLIST, what);
      this.setStatus(this.addWaits() ? this.tr('Asking the host to add "{title}"...', { title: o.title }) : this.tr('Adding "{title}"...', { title: o.title }));
    }
    // A page opened during the lookup may have put up its own offer since: that one stays.
    if (this.browseOffer === o) this.setBrowseOffer(null);
  }

  // A Tubi series' episodes, in the Lists tab: each one to add, play or play next, or all of them.
  showEpisodes(link) {
    if (!link) return;
    // Browse's series: its episodes are picked in the panel, so the site closes (Browse opens it again).
    if (this.browseOffer && this.browseOffer.link === link) this.closeBrowse();
    else this.setBrowseOffer(null);
    this.browseList(link);
    this.setStatus('The episodes are in Lists: add the ones you want, or + All.', 6000);
  }

  // The sources this world can use: a screen share needs links from other sites (untrusted-links).
  searchSources() {
    return Object.keys(SEARCH_SOURCES).filter(k => k !== 'screen' || this.core.allowUntrusted === true);
  }
  showSearchSource() {
    this.setDropdownValue(this.sourceDropdown, this.searchSource);
  }

  // Where the playing video is: its row near the top (one before it shows above), or its page.
  currentStart() {
    const player = this.core.player;
    const current = player && typeof player.currentTrack === 'number' ? player.currentTrack : 0;
    const total = this.listItems().length;
    return Math.min(this.maxStart(total), Math.max(0, current - 1));
  }

  // The Now button: the playlist tab, at the playing video.
  showCurrent() {
    if (this.tab !== 'playlist') { this.tab = 'playlist'; this.resetScroll(); }
    this.showFrom(this.currentStart());
  }

  doSearch() {
    const q = (this.searchQuery || '').trim();
    if (q.length < 2) {
      this.setStatus('Type at least two characters to search.');
      return;
    }
    // A playlist link or ID asks whether to replace the playlist, add it all, or save it to Lists.
    if (this.askAboutList(q)) return;
    this.saveRecent(q);
    this.tab = 'search';
    // A search made recently on this device shows its kept results straight away. Links are
    // always looked up again (a stream may have gone live or offline).
    // A screen share room is looked up each time too, as it's a link made from the code.
    const isLink = /^(https?|rtspt?):\/\//i.test(q) || !!this.core.getId(q) || this.searchSource === 'screen';
    const key = this.searchKey(q, this.searchSource);
    const kept = !isLink && this.cachedSearch(key);
    if (kept) {
      clearInterval(this.searchTimer);
      this.searchTimer = null;
      this.searchId++; // a search still waiting doesn't replace these when it's answered
      this.pendingSearchKey = null;
      this.searchResults = kept.results;
      this.searchPage = 0;
      this.resetScroll();
      const n = kept.results.length;
      this.setStatus(this.tr(n === 1 ? '{count} result (from your recent searches)' : '{count} results (from your recent searches)', { count: n }));
      this.render();
      return;
    }
    // Each search has an ID that comes back on its reply, so an earlier search answered late is
    // neither shown nor kept under this one's words.
    const searchId = ++this.searchId;
    this.pendingSearchKey = isLink ? null : { key, query: q };
    const data = { term: q, searchId };
    if (this.searchSource !== 'youtube') data.source = this.searchSource;
    // Tubi is searched from this device first, as its own site does (the server may be in a
    // country Tubi doesn't serve), then by the server.
    if (this.searchSource === 'tubi' && !isLink && window.isBanter && typeof this.core.tubiResolver === 'function') this.searchTubiHere(q, data);
    else this.send(Commands.SEARCH, data);
    console.log(`[PlaylistPanel] Searching for "${q}"...`);
    this.setStatus('Searching...', 0);
    // The first search after the server starts can take a while, so count up instead of giving up early.
    clearInterval(this.searchTimer);
    const started = Date.now();
    this.searchTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      if (secs >= 120) {
        clearInterval(this.searchTimer);
        this.searchTimer = null;
        console.warn('[PlaylistPanel] No search results from the server after 120s.');
        this.setStatus('No reply from the server for that search. Try again.');
        this.renderSoon(); // the search spinner stops
      } else {
        this.setStatus(`${this.tr('Searching...')} ${secs}s`, 0);
      }
    }, 1000);
    this.tab = 'search';
    this.render();
  }

  // A Tubi search from this device (tubi-native.js); the server's search if it finds nothing or can't.
  async searchTubiHere(q, data) {
    let results = null;
    try {
      const tubi = await this.core.tubiResolver();
      if (tubi) results = await tubi.search(q);
    } catch (e) {
      console.warn('[PlaylistPanel] Tubi search on this device failed:', e);
    }
    if (this.destroyed || data.searchId !== this.searchId) return; // a newer search replaced it
    if (results && results.length) {
      this.onMessage({ path: Commands.SEARCH_RESULTS, data: results, searchId: data.searchId });
      return;
    }
    console.log('[PlaylistPanel] No Tubi results from this device, so the server searches.');
    this.send(Commands.SEARCH, data);
  }

  // Karaoke: join the singer queue with this song.
  modeName(mode) { return mode === 'karaoke' ? 'Karaoke' : 'Playlist'; }

  switchMode() {
    const next = this.karaoke ? 'playlist' : 'karaoke';
    if (this.core.setModeOverride(next)) this.setStatus(`Switching everyone to ${this.modeName(next)} mode...`, 0);
    else this.setStatus('The mode can only be changed in a Creator SDK world.');
  }

  adminTakeOver() {
    if (this.core.adminTakeOver()) this.setStatus('Taking control as a space admin...', 0);
    else this.setStatus('Admin Take Over only works in a Creator SDK world.');
  }

  useDefaultMode() {
    if (this.core.setModeOverride(null)) this.setStatus(`Going back to the snippet's ${this.modeName(this.core.defaultMode)} mode...`, 0);
    else this.setStatus('The mode can only be changed in a Creator SDK world.');
  }

  // Speech to text through the SDK: StartTTS starts listening, StopTTS(id) stops, and the client
  // answers with a "transcription" event carrying that id and its best guess at the words.
  toggleSpeech() {
    const scene = this.core.banterScene();
    if (!scene) return;
    if (!this.speechListening) {
      this.speechListening = true;
      this.setText(this.speakBtn, 'Stop');
      this.setStyle(this.speakBtn, 'backgroundColor', '#c62828');
      this.setStatus('Listening... press Stop when you have said it.', 0);
      Promise.resolve(scene.StartTTS(false)).catch(e => console.warn('[PlaylistPanel] StartTTS failed:', e));
      return;
    }
    this.speechListening = false;
    this.setText(this.speakBtn, 'Speak');
    this.setStyle(this.speakBtn, 'backgroundColor', '#ad1457');
    const id = `fvp-${Date.now()}`;
    this.speechId = id;
    if (!this.onTranscription) {
      this.onTranscription = e => {
        const d = (e && e.detail) || {};
        if (!this.speechId || (d.id && d.id !== this.speechId)) return; // someone else's request
        this.speechId = null;
        clearTimeout(this.speechTimer);
        const words = String(d.message || '').trim();
        if (!words) { this.setStatus("Didn't catch that. Try again."); return; }
        this.openSearch();
        this.setSearchText(words);
        this.doSearch();
      };
      try { scene.On('transcription', this.onTranscription); } catch (e) {}
    }
    this.setStatus('Turning your words into text...', 0);
    clearTimeout(this.speechTimer);
    this.speechTimer = setTimeout(() => {
      if (this.speechId !== id) return;
      this.speechId = null;
      this.setStatus("Speech to text didn't answer.", 8000);
    }, 15000);
    Promise.resolve(scene.StopTTS(id)).catch(e => console.warn('[PlaylistPanel] StopTTS failed:', e));
  }

  // Paste from your phone (see server/paste.js): the server gives this panel a code for the phone
  // page, and what the phone sends goes into this search box only.
  askPasteCode() {
    this.openSearch();
    this.send(Commands.PASTE_CODE_REQUEST);
    this.setStatus('Getting a code for your phone...', 0);
  }

  // Shows the code big in the search view until it runs out, Done is pressed, or a link arrives.
  showPasteCode(data) {
    const code = data && data.code;
    if (!code) return;
    const ms = data.expiresIn || 600000;
    this.pasteCode = code;
    this.setText(this.phoneUrlLabel, `${this.core.hostUrl}/paste`);
    this.showPasteQr(code);
    this.setText(this.phoneCodeLabel, `${code.slice(0, 3)} ${code.slice(3)}`); // two halves, easier to read
    this.setText(this.phoneExpiryLabel, `Works for ${Math.round(ms / 60000)} minutes, only for you.`);
    this.setStatus('');
    clearTimeout(this.pasteCodeTimer);
    this.pasteCodeTimer = setTimeout(() => this.hidePasteCode(), ms);
    this.openSearch();
    this.render();
  }

  // The QR opens /p/CODE, which fills the code in. All capitals, so the QR can use its
  // alphanumeric mode and stay small with big squares (the server's routes don't mind the case).
  async showPasteQr(code) {
    if (this.destroyed) return;
    // The old code's QR is hidden while the new one is drawn, so the two never show mixed.
    this.display(this.phoneQrEl, false);
    if (typeof FireQR === 'undefined') await this.core.setupScript(null, 'qr');
    if (this.destroyed || this.pasteCode !== code) return;
    const rows = typeof FireQR !== 'undefined' ? FireQR.make(`${this.core.getProtocol()}://${this.core.hostUrl}/p/${code}`.toUpperCase()) : null;
    this.setText(this.phoneScanLabel, rows ? 'Scan this with your phone, or go to' : 'On your phone, go to');
    if (!rows) return;
    await this.drawQr(this.phoneQrEl, rows, this.phoneQrBoxes);
    if (this.destroyed || this.pasteCode !== code) return;
    this.display(this.phoneQrEl, true);
  }

  hidePasteCode() {
    clearTimeout(this.pasteCodeTimer);
    this.pasteCode = null;
    this.render();
  }

  pasteFromPhone(data) {
    const text = String((data && data.text) || '').trim();
    if (!text) return;
    this.hidePasteCode();
    this.openSearch();
    this.setSearchText(text.slice(0, 500));
    this.doSearch();
    this.core.showToast('Got the link from your phone');
  }

  isPreviewing(v) {
    return !!(v && this.core.previewVideo && this.core.previewVideo.link === v.link);
  }

  previewSong(v) {
    if (!v || !v.link) return;
    if (this.isPreviewing(v)) {
      this.stopPreview();
      return;
    }
    if (typeof this.core.startPreview === 'function') this.core.startPreview(v);
    this.setStatus(`Previewing "${v.title || 'song'}" on your screen — only you see and hear this.`);
    this.render();
  }

  stopPreview(silent) {
    if (!this.core || !this.core.previewVideo) return;
    if (typeof this.core.stopPreview === 'function') this.core.stopPreview();
    if (!silent) this.setStatus('Stopped preview.');
    this.renderSoon();
  }

  singIt(v) {
    if (this.isInQueue()) { this.setStatus('You are already in the singer queue.'); return; }
    this.stopPreview(true);
    this.send(Commands.ADD_TO_PLAYERS, v);
    this.setStatus(this.canAdd() ? `You're in the queue to sing "${v.title}"` : `"${v.title}" will be added once the host approves it`);
    this.setTab('playlist');
  }

  // ---------------------------------------------------------------- saved lists (Lists tab)

  // The saved lists: the snippet's fixed ones (see Core.getSavedLists), the room's shared ones,
  // this viewer's own (My lists), then any opened for this visit.
  getLists() {
    if (!this.savedLists) this.savedLists = typeof this.core.getSavedLists === 'function' ? this.core.getSavedLists() : [];
    // A link in more than one keeps its first entry, with the shared details added (on a copy) so
    // it still gets its Remove button.
    const byId = new Map();
    const out = [];
    this.savedLists.concat(this.sharedLists(), this.userLists, this.extraLists).forEach(l => {
      const had = byId.get(l.id);
      if (!had) { const copy = Object.assign({}, l); byId.set(l.id, copy); out.push(copy); }
      else if (l.shared && !had.shared) { had.shared = l.shared; had.by = l.by; }
    });
    return out;
  }

  // The Lists tab's rows: each list, and the videos of the one that's open under it.
  listEntries() {
    const out = [];
    for (const list of this.getLists()) {
      out.push({ kind: 'list', list });
      const data = this.listData.get(list.id);
      if (this.openListId === list.id && data && data.items) {
        data.items.forEach((item, index) => out.push({ kind: 'item', list, item, index }));
      }
    }
    return out;
  }

  // Asks the server for each saved list it hasn't sent yet, for their names and sizes.
  loadSavedLists() {
    this.getLists().forEach(list => this.requestList(list.id, false));
  }

  // Asks the server what's in a list (it replies with LIST_PREVIEW_RESULT), unless it's already
  // being asked for or a recent answer is kept. `force` asks again even then (Retry). A list that
  // was shown before keeps its videos on screen while it's loaded again.
  requestList(id, force) {
    this.checkListRequests();
    if (this.listsOut.has(id) || this.listQueue.includes(id) || (this.deviceLists && this.deviceLists.has(id))) return;
    const had = this.listData.get(id);
    if (had && had.state === 'ready' && !force && Date.now() - had.at < LIST_FRESH_MS) return;
    if (!(had && had.state === 'ready')) this.listData.set(id, { state: 'loading', at: Date.now() });
    // A Tubi series is read from this device first (see loadSeriesHere).
    if (this.isTubiSeries(id) && window.isBanter && typeof this.core.tubiResolver === 'function') {
      this.loadSeriesHere(id);
      return;
    }
    this.listQueue.push(id);
    this.pumpLists();
    this.renderSoon();
  }

  isTubiSeries(link) {
    const m = window.MediaSources ? MediaSources.detect(String(link || '')) : null;
    return !!m && m.type === 'tubi' && m.kind === 'series';
  }

  // A Tubi series' episodes from this device (tubi-native.js), as the server may be in a country
  // Tubi doesn't serve; the server's list if this device can't.
  async loadSeriesHere(id) {
    (this.deviceLists = this.deviceLists || new Set()).add(id);
    let list = null;
    try {
      const tubi = await this.core.tubiResolver();
      if (tubi) list = await tubi.series(id);
    } catch (e) {
      console.warn('[PlaylistPanel] Tubi series on this device failed:', e);
    }
    this.deviceLists.delete(id);
    if (this.destroyed) return;
    if (list && list.items.length) {
      this.listData.set(id, { state: 'ready', at: Date.now(), title: list.title, items: list.items, skipped: 0, truncated: false, device: true });
      this.renderSoon();
      return;
    }
    this.listQueue.push(id);
    this.pumpLists();
    this.renderSoon();
  }

  // Sends waiting list requests, LIST_PREVIEWS_AT_ONCE at most at a time, while connected.
  pumpLists() {
    this.checkListRequests();
    const connected = typeof this.core.connected === 'function' ? this.core.connected() : true;
    while (connected && this.listsOut.size < LIST_PREVIEWS_AT_ONCE && this.listQueue.length) {
      const id = this.listQueue.shift();
      this.listsOut.set(id, Date.now());
      this.send(Commands.LIST_PREVIEW, { id });
    }
    this.scheduleListExpiry();
  }

  // While requests are out, checks again when the oldest would time out, so a stalled one shows
  // its error and frees its place for the next waiting list without anyone touching the panel.
  scheduleListExpiry() {
    clearTimeout(this.listExpiryTimer);
    this.listExpiryTimer = null;
    if (this.destroyed || !this.listsOut.size) return;
    const oldest = Math.min(...this.listsOut.values());
    this.listExpiryTimer = setTimeout(() => {
      this.listExpiryTimer = null;
      this.pumpLists(); // expires timed-out requests, sends waiting ones and schedules the next check
      this.renderSoon();
    }, Math.max(0, oldest + LIST_REPLY_MS - Date.now()) + 50);
  }

  // Requests whose reply can't come any more: sent on a connection that has since been replaced
  // (asked again on the new one), or with no reply for LIST_REPLY_MS.
  checkListRequests() {
    if (this.core.ws !== this.listsSocket) {
      this.listsSocket = this.core.ws;
      const lost = [...this.listsOut.keys()].filter(id => !this.listQueue.includes(id));
      this.listsOut.clear();
      this.listQueue.unshift(...lost);
    }
    const now = Date.now();
    for (const [id, at] of this.listsOut) {
      if (now - at < LIST_REPLY_MS) continue;
      this.listsOut.delete(id);
      const d = this.listData.get(id);
      if (d && d.state === 'loading') this.listData.set(id, { state: 'error', error: 'No reply from the server. Try again.' });
    }
  }

  onListPreview(data) {
    if (!data || typeof data.id !== 'string') return;
    this.listsOut.delete(data.id);
    this.pumpLists();
    if (data.error) {
      this.listData.set(data.id, { state: 'error', error: String(data.error) });
      if (this.openListId === data.id) this.setStatus(String(data.error), 6000);
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    this.listData.set(data.id, { state: 'ready', at: Date.now(), title: data.title || '', items, skipped: data.skipped || 0, truncated: !!data.truncated });
    // A saved list keeps its real name for next time.
    const mine = data.title && this.userLists.find(l => l.id === data.id);
    if (mine && mine.label !== data.title) { mine.label = data.title; this.saveUserLists(); }
  }

  // Opens a list under its row (closing any other), or closes it.
  toggleList(id) {
    if (this.openListId === id) {
      this.openListId = null;
      this.render();
      return;
    }
    this.openListId = id;
    const data = this.listData.get(id);
    // Loads it if it hasn't been, failed, or was loaded a while ago.
    this.requestList(id, !data || data.state === 'error');
    // The list's own row at the top, its videos under it.
    const at = this.listEntries().findIndex(e => e.kind === 'list' && e.list.id === id);
    this.tab = 'lists';
    this.showFrom(Math.max(0, Math.min(this.maxStart(this.listEntries().length), at)));
  }

  // Adds a whole list to the end of the playlist (the host, or anyone while unlocked).
  appendList(id) {
    if (!this.canAdd()) { this.setStatus('The player is locked: only the host can add videos.'); return; }
    // A list read on this device (a Tubi series) may be one the server can't read: its videos are
    // added one by one, as they are.
    const data = this.listData.get(id);
    if (data && data.device && data.state === 'ready') {
      const inPlaylist = new Set(((this.core.player && this.core.player.playlist) || []).map(v => v.link));
      const items = data.items.filter(v => !inPlaylist.has(v.link)).slice(0, 300);
      items.forEach(v => this.send(Commands.ADD_TO_PLAYLIST, v));
      this.setStatus(this.tr(items.length === 1 ? 'Adding {count} video...' : 'Adding {count} videos...', { count: items.length }), 0);
      return;
    }
    this.send(Commands.FROM_PLAYLIST, { id, append: true, fromPlaylist: true });
    this.setStatus('Adding the list to the playlist...', 0);
  }

  // Replaces the playlist with a list (the host only).
  replaceWithList(id) {
    if (!this.isHost()) { this.setStatus('Only the host can load a playlist.'); return; }
    const data = this.listData.get(id);
    if (data && data.device) { this.setStatus('Use + All to add these episodes.'); return; }
    this.send(Commands.FROM_PLAYLIST, { id, shouldClear: true, fromPlaylist: true });
    this.setStatus('Loading playlist...', 0);
  }

  // Opens a pasted list link in the Lists tab, for this visit.
  browseList(id) {
    if (!this.getLists().some(l => l.id === id)) {
      this.extraLists.push({ id, label: typeof this.core.listLabel === 'function' ? this.core.listLabel(id) : 'Playlist', isDefault: false });
    }
    this.view = 'main';
    this.openListId = null;
    this.toggleList(id);
  }

  // ---------------------------------------------------------------- messages

  onMessage(json) {
    const p = this.core.player;
    switch (json.path) {
      case Commands.PASTE_CODE:
        this.showPasteCode(json.data);
        break;
      case Commands.PASTE_RECEIVED:
        this.pasteFromPhone(json.data);
        break;
      case Commands.SEARCH_RESULTS:
        // An earlier search's reply: that search is done, but a newer one replaced it.
        if (json.searchId !== undefined && json.searchId !== this.searchId) break;
        clearInterval(this.searchTimer);
        this.searchTimer = null;
        this.searchResults = Array.isArray(json.data) ? json.data : [];
        console.log(`[PlaylistPanel] Got ${this.searchResults.length} search results.`);
        if (this.pendingSearchKey && this.searchResults.length) {
          this.saveSearch(this.pendingSearchKey.key, this.pendingSearchKey.query, this.searchResults);
        }
        this.pendingSearchKey = null;
        this.view = 'main';
        this.searchPage = 0;
        this.resetScroll(); // new results start at the top
        this.tab = 'search';
        const n = this.searchResults.length;
        this.setStatus(n ? this.tr(n === 1 ? '{count} result' : '{count} results', { count: n }) : 'No results.');
        this.renderSoon(); // the search spinner stops
        break;
      case Commands.ERROR: {
        if (json.searchId !== undefined && json.searchId !== this.searchId) break; // an earlier search's
        const m = json.data && json.data.message ? json.data.message : (typeof json.data === 'string' ? json.data : "I can't let you do that...");
        // A failed search sends empty results and then an error; stop the "Searching..." counter
        // anyway so it doesn't overwrite the error. Results that still arrive later are shown as usual.
        clearInterval(this.searchTimer);
        this.searchTimer = null;
        this.setStatus(m, 5000);
        this.renderSoon(); // the search spinner stops
        break;
      }
      case Commands.SHOW_REPLACE_PROMPT:
        if (json.data && json.data.original && json.data.alternative) {
          this.pendingReplacement = {
            original: json.data.original,
            alternative: JSON.parse(JSON.stringify(json.data.alternative))
          };
        }
        break;
      case Commands.AUTO_SYNC_STATE_CHANGED:
        if (json.data && typeof json.data.enabled === 'boolean') this.autoSync = json.data.enabled;
        break;
      case Commands.LIST_PREVIEW_RESULT:
        this.onListPreview(json.data);
        break;
      case Commands.RADIO_CHECK_RESULT: {
        // Whether the station Browse offers can play here (see onBrowseMessage).
        const o = this.browseOffer;
        const d = json.data || {};
        if (o && o.kind === 'station' && d.link === o.link) {
          o.check = d.ok ? 'ok' : 'bad';
          o.error = d.ok ? '' : String(d.error || '').slice(0, 200);
          this.setBrowseOffer(o);
        }
        break;
      }
      case Commands.LISTS_UPDATED:
        this.loadSavedLists(); // names and sizes of any new ones
        break;
      case Commands.PLAYBACK_UPDATE:
        // Sent on every (re)connection: list requests that were waiting can go now.
        if (json.data && json.data.type === 'initial-sync') this.pumpLists();
        if (json.data && json.data.type === 'initial-sync' && this.refreshing) {
          this.refreshing = false;
          this.setStatus(this.karaoke ? 'Singer list is up to date.' : 'Playlist is up to date.');
        }
        break;
    }
    // Every new play, even of the same song (see addProgressSeek).
    if (json.path === Commands.TRACK_CHANGED) this.trackPlays = (this.trackPlays || 0) + 1;
    // Estimate the client/server clock difference so the progress bar matches the server.
    if (p && !p.paused && p.lastStartTime && [Commands.PLAYBACK_UPDATE, Commands.TRACK_CHANGED, Commands.HOST_SEEK, Commands.PAUSE_STATE_CHANGED].includes(json.path)) {
      this.clockSkew = (Date.now() / 1000) - (p.lastStartTime + (p.currentTime || 0));
    }
    this.renderSoon();
  }

  // A room setting's switch: the server answers with the new state (render). When the message
  // can't be sent, the switch goes back to what the server last said.
  sendToggle(toggle, path, key) {
    if (this.send(path)) return;
    this.setOnOff(toggle, !!(this.core.player && this.core.player[key]));
    this.setStatus('Not connected to the server. Reconnecting...', 4000);
  }

  // An on/off setting's switch (see kitToggle).
  setOnOff(toggle, on) {
    if (toggle && this._changed(toggle, 'checked', !!on)) toggle.checked = !!on;
  }

  renderSoon() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      // One failed redraw is logged, and doesn't stop the next.
      try { this.render(); } catch (e) { console.warn('[PlaylistPanel] Redraw failed:', e && e.stack || e); }
    }, 100);
  }

  // ---------------------------------------------------------------- render

  // The time beside the progress bar. A long one ("2089:00:17 / 2089:00:17 LIVE") would run under
  // the bar, so the label is made wide enough for it and the bar that much narrower. Unity has no
  // way to measure text, so it goes by characters: about 11 px each at 20 px.
  setTimeText(text) {
    this.setText(this.timeLabel, text);
    const width = Math.min(380, Math.max(TIME_WIDTH, Math.ceil(text.length * 11)));
    if (width === (this.timeWidth || TIME_WIDTH)) return;
    this.timeWidth = width;
    this.setStyle(this.timeLabel, 'width', `${width}px`);
    if (this.progHit) this.setStyle(this.progHit, 'width', `${this.progressWidth()}px`);
  }
  progressWidth() { return this.W - PROGRESS_SPARE - ((this.timeWidth || TIME_WIDTH) - TIME_WIDTH); }

  updateTime() {
    if (!this.built || this.dragSeek != null) return; // a drag on the bar shows its own time
    const p = this.core.player;
    if (!p || !p.playlist || !p.playlist.length) {
      this.display(this.goLiveBtn, false);
      this.setTimeText('');
      this.setStyle(this.progInner, 'width', '0%');
      return;
    }
    const duration = this.trackLength();
    const range = this.liveRange();
    if (this.seekLabel) this.setText(this.seekLabel, range ? 'Go back from live (everyone):' : 'Go to (everyone):');
    if (!(duration > 0)) {
      // No known length (some files): just how far in it is.
      const t = Math.max(0, p.paused ? (p.currentTime || 0) : ((Date.now() / 1000 - this.clockSkew) - (p.lastStartTime || 0)));
      this.display(this.goLiveBtn, false);
      this.setTimeText(`${this.timeCode(t)} / --:--`);
      this.setStyle(this.progInner, 'width', '0%');
      return;
    }
    let t = p.paused ? (p.currentTime || 0) : ((Date.now() / 1000 - this.clockSkew) - (p.lastStartTime || 0));
    t = Math.max(0, Math.min(t, duration));
    // A live video's bar is the part a seek can reach, up to its live point, which moves on with
    // it; the time is how far behind that it is.
    this.display(this.goLiveBtn, !!range);
    if (range) {
      const live = this.core.atLivePoint(t, range);
      this.setText(this.goLiveBtn, live ? 'LIVE' : 'Go Live');
      this.setStyle(this.goLiveBtn, 'backgroundColor', live ? '#5d2a2a' : '#c62828');
      this.setTimeText(this.core.liveTimeText(t, range, s => this.timeCode(s)));
      this.setStyle(this.progInner, 'width', `${this.livePercent(t, range)}%`);
      return;
    }
    this.setTimeText(`${this.timeCode(t)} / ${this.timeCode(duration)}`);
    const pct = Math.round((t / duration) * 200) / 2; // half-percent steps
    this.setStyle(this.progInner, 'width', `${pct}%`);
  }
  // How far along a live video's bar a time is (see core.liveRange), in half-percent steps.
  livePercent(t, range) {
    const span = range.end - range.start;
    const f = span > 0 ? (Math.min(range.end, Math.max(range.start, t)) - range.start) / span : 1;
    return Math.round(f * 200) / 2;
  }

  render() {
    if (!this.built || !this.visible) return;
    const player = this.core.player || {};
    const playlist = player.playlist || [];
    const host = this.isHost();
    const hasPlaylist = playlist.length > 0;

    // Header: the host and who may control the player (the padlock and the chip's colour).
    const level = this.controlLevel(player);
    const hostName = player.host ? (host ? this.tr('You') : player.host.name || this.tr('Someone')) : '';
    // A padlock and the host's name, in the look for who may control the player.
    this.setText(this.hostChip, player.host ? `@${level === 'host' ? 'lock' : 'lock-open'} ${hostName}` : `@lock ${this.tr('Connecting...')}`, true);
    // Red while anyone can take over, so it's plain to see.
    this.kitVariant(this.hostChip, !player.host ? 'secondary' : level === 'host' ? 'primary' : level === 'everyone' ? 'warning' : 'danger');
    const version = this.core.serverVersion || '';
    this.setText(this.versionLabel, version ? `v${version.split(' ')[0]}` : '');
    this.setText(this.infoVersionLabel, version ? this.tr('Version {version}', { version }) : '');

    // Now playing
    const current = playlist[player.currentTrack];
    const idle = this.tr(player.host ? (this.karaoke ? 'Nobody is singing' : 'Nothing playing') : 'Connecting...');
    let nowText = current ? current.title : idle;
    if (current && this.karaoke) nowText = this.tr('Now singing: {song}', { song: `${current.user && current.user.name ? current.user.name + ' - ' : ''}${current.title}` });
    this.setText(this.nowTitle, nowText, true);
    this.updateTime();

    // Controls
    this.display(this.prevTrackBtn, !this.karaoke && host && playlist.length > 1);
    // With voting on, Next ends the current song (see changeTrack), so it works on the last one too.
    this.display(this.nextTrackBtn, !this.karaoke && host && playlist.length > (player.canVote ? 0 : 1));
    if (this.karaoke) {
      const singer = this.currentSinger();
      const canControlSong = hasPlaylist && (host || !!(singer && window.user && singer.id === window.user.id));
      this.display(this.restartBtn, canControlSong);
      this.display(this.stopBtn, canControlSong);
    }
    this.display(this.pauseBtn, host && hasPlaylist);
    this.setText(this.pauseBtn, player.paused ? '▶' : '❚❚');
    // Both are the main button's look: red reads as stop.
    this.setStyle(this.pauseBtn, 'backgroundColor', '#2e7d32');
    this.display(this.rewBtn, hasPlaylist);
    this.display(this.ffBtn, hasPlaylist);
    const muted = this.core.params.mute === 'true';
    this.setText(this.volLabel, `${this.core.params.volume}`);
    // The mute button keeps its crossed-out speaker (volume up is the button beside it), red while
    // muted.
    this.setStyle(this.muteBtn, 'backgroundColor', muted ? '#c62828' : '#455a64');

    // Views
    const more = this.view === 'more';
    const info = this.view === 'info';
    this.display(this.mainView, !more && !info);
    this.display(this.moreView, more);
    this.display(this.infoView, info);
    // While open, ☰ and ⓘ go back (↩).
    this.setText(this.moreBtn, more ? '↩' : '@settings');
    this.setText(this.infoBtn, info ? '↩' : 'ⓘ');

    // Replacement suggestion
    const r = this.pendingReplacement;
    this.display(this.noticeRow, !!r);
    if (r) this.setText(this.noticeLabel, this.tr('Someone can\'t play "{original}". Replace it with "{alternative}"?', { original: r.original.title, alternative: r.alternative.title }));
    this.display(this.replaceConfirmBtn, host);

    // Karaoke preview bar
    if (this.previewRow) {
      const pv = this.core.previewVideo;
      this.display(this.previewRow, !!pv);
      if (pv) {
        this.setText(this.previewLabel, this.tr('Previewing on your screen: {title}', { title: pv.title || pv.link }), true);
        this.display(this.previewSingBtn, !this.isInQueue());
      }
    }

    // More view: its switches and dropdowns.
    this.setOnOff(this.autoSyncBtn, this.autoSync);
    this.setOnOff(this.captionsBtn, this.core.captions !== false);
    if (this.handBtn) this.setText(this.handBtn, `☚ ${this.core.handPlaceLabel()}`);
    this.setOnOff(this.fadeToggle, this.core.fadeOn());
    if (this.audioDropdown) this.setDropdownValue(this.audioDropdown, this.core.audioMode());
    if (this.resolutionDropdown) {
      const [dw, dh] = [this.core.defaultResolution(), Math.round(this.core.defaultResolution() * 9 / 16)];
      const opts = [['default', `${this.tr('Default')} (${dw} × ${dh})`, true]]
        .concat(this.core.screenResolutionChoices().map(w => [String(w), `${w} × ${Math.round(w * 9 / 16)}`, true]));
      this.setDropdownChoices(this.resolutionDropdown, opts);
      // A saved width that is now the world's default is the Default choice (it isn't in the list).
      const w = this.core.viewerResolution;
      this.setDropdownValue(this.resolutionDropdown, w && w !== dw ? String(w) : 'default');
    }

    // Look & language
    if (this.languageDropdown && this.i18n) this.setDropdownValue(this.languageDropdown, this.i18n.lang);
    this.setDropdownValue(this.themeDropdown, this.theme);
    this.setDropdownValue(this.accentDropdown, this.accent);

    // Space admins only, but shown to everyone
    {
      const def = this.core.defaultMode || (this.karaoke ? 'karaoke' : 'playlist');
      const override = this.core.modeOverride;
      const from = this.tr(override ? 'set by a space admin' : 'the snippet default');
      this.setText(this.modeLabel, this.tr('Mode: {mode} ({from})', { mode: this.tr(this.modeName(this.karaoke ? 'karaoke' : 'playlist')), from }));
      this.setText(this.modeSwitchBtn, this.tr('Switch to {mode}', { mode: this.tr(this.karaoke ? 'Playlist' : 'Karaoke') }));
      this.display(this.modeDefaultBtn, !!override);
      this.setText(this.modeDefaultBtn, this.tr('Use Snippet Default ({mode})', { mode: this.tr(this.modeName(def)) }));
    }

    // Who controls the player: the chosen card is in its colour with a white edge, the others grey.
    this.setText(this.controlHostLabel, player.host ? `♛ ${host ? this.tr('You are the host') : this.tr('Host: {name}', { name: player.host.name || this.tr('Someone') })}` : this.tr('Connecting...'), true);
    const takeOverShown = !host && !!player.host && !!player.canTakeOver;
    this.display(this.takeOverBtn, takeOverShown);
    // With Take Over on, anyone (an admin too) can use that instead.
    this.display(this.adminTakeOverBtn, !host && !takeOverShown);
    // The colours again, as the accent may have changed.
    const levelColours = Object.fromEntries(this.controlLevels().map(l => [l[0], l[2]]));
    for (const [lvl, c] of Object.entries(this.controlCards || {})) {
      const on = lvl === level;
      this.setStyle(c.card, 'backgroundColor', on ? levelColours[lvl] : 'rgb(50, 50, 56)');
      this.setStyle(c.card, 'borderColor', on ? '#ffffff' : 'rgba(0,0,0,0)');
    }
    for (const [lvl, chip] of Object.entries(this.infoLevelChips || {})) this.setStyle(chip, 'backgroundColor', levelColours[lvl]);
    this.setText(this.controlNote, host
      ? 'Press one to change it. It shows on the padlock at the top for everyone.'
      : player.canTakeOver ? 'Only the host can change this. Press Take Over to become the host.' : 'Only the host can change this. A space admin can press Admin Take Over to become the host.');

    // Host controls
    this.display(this.hostSection, host);
    if (this.karaoke) {
      this.setOnOff(this.autoAdvanceBtn, !!player.autoAdvance);
    } else {
      this.setOnOff(this.votingBtn, !!player.canVote);
      this.display(this.clearBtn, host && hasPlaylist);
      this.display(this.loadDefaultBtn, host && !hasPlaylist && !!this.core.params.playlist);
    }

    // Tabs
    if (this.karaoke && this.tab === 'lists') this.tab = 'playlist';
    const onSearch = this.tab === 'search';
    const onLists = this.tab === 'lists';
    // Search covers the panel: no now playing or transport.
    const searching = onSearch && !more;
    this.display(this.nowCard, !searching);
    this.display(this.controlsRow, !searching);
    this.showSearchSource();
    this.display(this.searchSpinner, onSearch && !!this.searchTimer);

    // What the browser window has open that can be added, and the Browse button (Shoutcast and Tubi).
    const bo = this.browseOffer;
    this.display(this.browseOfferRow, !!bo);
    if (bo) {
      const bad = bo.check === 'bad';
      this.setText(this.browseOfferLabel, bad ? this.tr('"{title}" can\'t play here.', { title: bo.title })
        : this.tr(bo.kind === 'series' ? 'In the browser: "{title}" (series)' : 'In the browser: "{title}"', { title: bo.title }));
      const ready = !bad && bo.check !== 'checking';
      this.display(this.browseNowBtn, ready && bo.kind !== 'series' && host);
      this.display(this.browseAddBtn, ready && bo.kind !== 'series' && (this.canAdd() || this.addWaits()));
      this.display(this.browseEpisodesBtn, bo.kind === 'series');
    }
    if (this.browseBtn) {
      this.display(this.browseBtn, onSearch && this.canBrowse() && (BROWSE_SITES.includes(this.searchSource) || !!this.siteBrowser));
      this.setText(this.browseBtn, this.siteBrowser ? '✕ Close Browser' : '@fvp:web Browse');
    }
    if (this.moveBrowseBtn) {
      this.display(this.searchGoBtn, !this.siteBrowser);
      this.display(this.moveBrowseBtn, !!this.siteBrowser);
    }

    // A pasted playlist's question.
    const pl = this.pendingList;
    this.display(this.listPromptRow, !!pl);
    if (pl) {
      const data = this.listData.get(pl.id);
      const name = (data && data.state === 'ready' && data.title) || (typeof this.core.listLabel === 'function' ? this.core.listLabel(pl.id) : 'playlist');
      const size = data && data.state === 'ready' ? ` (${this.tr('{count} videos', { count: data.items.length })})` : data && data.state === 'loading' ? ` (${this.tr('loading...')})` : '';
      const can = host ? '' : this.canAdd() ? ' Only the host can replace the playlist.' : ' The player is locked: you can save it for yourself.';
      const failed = data && data.state === 'error';
      this.setText(this.listPromptLabel, failed
        ? this.tr('That link isn\'t a playlist or video this player can use: {error}', { error: data.error })
        : this.tr('That\'s a playlist: {name}{size}. Replace the playlist, add it all to the end, or save it to Lists (for everyone here, or just for you)?', { name, size }) + (can ? ' ' + this.tr(can.trim()) : ''));
      this.display(this.promptReplaceBtn, host && !failed);
      this.display(this.promptAppendBtn, this.canAdd() && !failed);
      this.display(this.promptShareBtn, this.canAdd() && !failed);
      this.display(this.promptSaveBtn, !failed);
      this.display(this.promptVideoBtn, pl.video && (this.canAdd() || this.addWaits()));
    }
    const list = this.listItems();
    const waitingCount = this.karaoke ? 0 : list.length - playlist.length;
    const firstCount = `(${this.karaoke ? list.length : playlist.length}${waitingCount ? `+${waitingCount}` : ''})`;
    {
      // The kit's tabs: key:label;key:label (a label can't hold ; or start a key with :).
      const lists = this.karaoke ? null : this.getLists();
      const clean = t => String(t).replace(/[;:]/g, ' ');
      // In capitals, as the menu's tabs are.
      const up = t => clean(t).toLocaleUpperCase();
      const choices = [`playlist:${up(`${this.tr(this.karaoke ? 'Singers' : 'Playlist')} ${firstCount}`)}`];
      if (lists) choices.push(`lists:${up(`${this.tr('Lists')}${lists.length ? ` (${lists.length})` : ''}`)}`);
      choices.push(`search:${up(this.tr(this.karaoke ? 'Search Songs' : 'Search'))}`);
      const joined = choices.join(';');
      if (this.kitTabsChoices !== joined) {
        this.kitTabsChoices = joined;
        this.kitTabs.choices = joined;
      }
      const v = onSearch ? 'search' : onLists ? 'lists' : 'playlist';
      if (this._changed(this.kitTabs, 'value', v)) this.kitTabs.value = v;
    }
    if (this.nowBtn) this.display(this.nowBtn, !!(!onSearch && hasPlaylist && (this.tab !== 'playlist' || list.length > this.pageSize())));
    this.display(this.searchRow, onSearch);
    this.display(this.phoneCard, onSearch && !!this.pasteCode);
    this.display(this.searchToolsRow, onSearch);
    const recent = this.recentSearches;
    (this.recentBtns || []).forEach((btn, k) => {
      this.display(btn, k < recent.length);
      if (k < recent.length) this.setText(btn, recent[k], true); // a search as typed, never translated
    });
    this.display(this.recentLabel, recent.length > 0);
    this.display(this.clearRecentBtn, recent.length > 0);

    const items = onLists ? this.listEntries() : onSearch ? this.searchResults : list;
    const size = this.pageSize();
    const pages = Math.max(1, Math.ceil(items.length / size));
    const start = Math.min(this.tabStart(), this.maxStart(items.length));
    this.setTabStart(start);
    // The window of rows in the scroll view: "21-40 / 300". Nothing to count (Search before a
    // search) shows nothing, rather than 0 / 0 on its own.
    this.setText(this.pageLabel, items.length ? `${start + 1}-${Math.min(items.length, start + size)} / ${items.length}` : '0 / 0');
    this.display(this.pageLabel, items.length > 0);
    // Back and forward only when there's more than fits, first and last from 3 windows.
    this.display(this.prevPageBtn, pages > 1);
    this.display(this.nextPageBtn, pages > 1);
    this.display(this.firstPageBtn, pages > 2);
    this.display(this.lastPageBtn, pages > 2);

    // Rows
    const canAdd = this.canAdd();
    const inPlaylist = (onLists || onSearch) ? new Set(playlist.map(v => v.link)) : null;
    this.waitingLinks = new Set(list.filter(v => v.waiting).map(v => v.v && v.v.link));
    for (let k = 0; k < this.rows.length; k++) {
      const slot = this.rows[k];
      const i = start + k;
      const v = k < size ? items[i] : null;
      this.display(slot.row, !!v);
      if (!v) continue;
      if (slot.votes && (onLists || onSearch || this.karaoke || v.waiting)) this.display(slot.votes, false);
      slot.isList = onLists && v.kind === 'list';
      if (onLists) {
        if (v.kind === 'list') this.fillListRow(slot, v.list, host, canAdd);
        else this.fillListItemRow(slot, v, host, canAdd, inPlaylist);
      }
      else if (onSearch) this.fillSearchRow(slot, v, host, inPlaylist);
      else if (this.karaoke) this.fillSingerRow(slot, v, i, items, host);
      else if (v.waiting) this.fillWaitingRow(slot, v, host);
      else this.fillPlaylistRow(slot, v, i, player, host);
    }

    let empty = '';
    if (!items.length) {
      if (onLists) empty = "No saved lists. Paste a YouTube playlist or a list of links into + Search & Add (or More > + Add by link) and choose ★ Save for Everyone or ☆ Save for Me.";
      else if (onSearch) empty = this.karaoke ? 'Search for a song above, or paste a link.' : 'Search YouTube above, or paste a YouTube, Twitch, Vimeo or video link.';
      else if (this.karaoke) empty = host ? 'No singers yet. Use Search to pick a song and join the queue.' : 'No singers yet. Use Search to pick a song and join the queue. Whoever runs the karaoke should take over the player first (press ♛ at the top).';
      else empty = 'The playlist is empty. Use Search to add videos.';
    }
    this.setText(this.emptyLabel, empty);
    this.display(this.emptyLabel, !!empty);
    if (empty) {
      const icon = onLists ? 'bookmark' : onSearch ? 'search' : this.karaoke ? 'mic' : 'videocam';
      if (this._changed(this.emptyLabel, 'icon', icon)) this.emptyLabel.icon = icon;
    }
    this.display(this.madeWithRow, onSearch && !items.length);
  }

  // YouTube's search thumbnails (e.g. .../hq720.jpg?sqp=...&rs=...) are often WebP despite the
  // .jpg name, and Unity can't decode WebP, so they fail to load. /vi/<id>/mqdefault.jpg is
  // always a JPEG (320x180, the same shape as the thumbnail box).
  thumbUrl(url, link) {
    const fromThumb = /^https?:\/\/i\d*\.ytimg\.com\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//.exec(String(url || ''));
    const id = (fromThumb && fromThumb[1]) || (link && this.core.getId ? this.core.getId(link) : null);
    const out = id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : String(url || '');
    if (!/^https?:\/\//.test(out)) return out;
    return `${out}${out.includes('?') ? '&' : '?'}fvp=${THUMB_VISIT}`;
  }

  setThumb(slot, url, link) {
    url = this.thumbUrl(url, link);
    if (slot.thumbIcon) {
      // A row with no picture shows a glyph in its place.
      const icon = url ? '' : slot.isList ? 'bookmark' : 'videocam';
      if (icon && this._changed(slot.thumbIcon, 'icon', icon)) slot.thumbIcon.icon = icon;
      this.display(slot.thumbIcon, !!icon);
    }
    const safe = url ? String(url).replace(/["\\\n\r]/g, '') : '';
    const value = safe ? `url("${safe}")` : 'none';
    if (!this._changed(slot.thumb, 'backgroundImage', value)) return;
    // Only ever the picture itself: 'none' and then the picture straight after can leave the row
    // blank.
    slot.thumb.SetStyles({ backgroundImage: value });
    this.reapplyThumbsSoon(); // also for 'none': a picture still loading from before can land later
  }

  // Unity downloads each picture and shows it when it arrives, even if the row has moved on to
  // another page by then (UIElementBridge.SetBackgroundImage), so a late one from a page already
  // left can replace the right one. Setting each row's picture again a little later puts the
  // right one back (by then it's in Unity's cache, so it shows at once) and retries a failed one,
  // a row at a time so they don't all load at once.
  reapplyThumbsSoon() {
    (this.thumbTimers || []).forEach(clearTimeout);
    this.thumbTimers = [];
    for (const delay of [1500, 5000]) {
      (this.rows || []).forEach((slot, k) => {
        this.thumbTimers.push(setTimeout(() => {
          if (this.destroyed) return;
          const r = this.cache.get(slot.row);
          if (r && r.display === 'none') return; // a row not in use
          const c = this.cache.get(slot.thumb);
          const value = c && c.backgroundImage;
          if (!value) return;
          try { slot.thumb.SetStyles({ backgroundImage: value }); } catch (e) {}
        }, delay + k * 150));
      });
    }
  }

  setButtons(slot, defs) {
    for (let b = 0; b < slot.buttons.length; b++) {
      const d = defs[b];
      const btn = slot.buttons[b];
      this.display(btn, !!d);
      slot.actions[b] = d ? d.fn : null;
      if (d) {
        this.setText(btn, d.text);
        // A button with no colour of its own is outlined (see kitButton).
        this.setStyle(btn, 'backgroundColor', d.color || '#455a64');
      }
    }
  }

  fillPlaylistRow(slot, v, i, player, host) {
    const isCurrent = player.currentTrack === i;
    const by = v.user && v.user.name ? v.user.name : this.tr('Unknown');
    const showVotes = player.canVote && !isCurrent;
    // The votes are a count pill.
    this.display(slot.votes, showVotes);
    const n = String(v.votes || 0);
    if (showVotes && this._changed(slot.votes, 'count', n)) slot.votes.count = n;
    this.setStyle(slot.row, 'backgroundColor', isCurrent ? '#3949ab' : (i % 2 === 0 ? '#2a2a33' : '#31313c'));
    this.setText(slot.title, `${i + 1}. ${v.title || this.tr('Untitled')}`, true);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setRowLines(slot, [isCurrent ? this.tr('Now playing') : '', this.tr('Added by {name}', { name: by })], dur);
    this.setThumb(slot, v.thumbnail, v.link);

    const defs = [];
    if (!isCurrent) {
      if (host) defs.push({ text: '▶', color: '#2e7d32', fn: () => this.send(Commands.SET_TRACK, { index: i, link: v.link }) });
      if (player.canVote) {
        defs.push({ text: '▲', fn: () => this.send(Commands.UP_VOTE, v.link) });
        defs.push({ text: '▼', fn: () => this.send(Commands.DOWN_VOTE, v.link) });
      } else if (host) {
        const len = (player.playlist || []).length;
        if (i > 0) defs.push({ text: '⬆', fn: () => this.send(Commands.MOVE_PLAYLIST_ITEM, { url: v.link, index: i - 1 }) });
        if (i < len - 1) defs.push({ text: '⬇', fn: () => this.send(Commands.MOVE_PLAYLIST_ITEM, { url: v.link, index: i + 1 }) });
        defs.push({ text: '✕', color: '#c62828', fn: () => this.send(Commands.REMOVE_PLAYLIST_ITEM, i) });
      }
    }
    this.setButtons(slot, defs.slice(0, 4));
  }

  // Playlist mode: a video added while the player was locked, waiting after the playlist until the
  // host approves (✓, it goes to the end) or rejects it (✕). Whoever added it can take it back.
  // `w` is { v: video, id, name, p }.
  fillWaitingRow(slot, w, host) {
    const v = w.v || {};
    const me = !!(window.user && w.id === window.user.id);
    this.setStyle(slot.row, 'backgroundColor', '#4a3f1e');
    this.setText(slot.title, v.title || this.tr('Untitled'), true);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setRowLines(slot, [this.tr('Waiting for the host to approve'), me ? this.tr('added by you') : this.tr('added by {name}', { name: w.name || this.tr('someone') })], dur);
    this.setThumb(slot, v.thumbnail, v.link);
    const defs = [];
    if (host) defs.push({ text: '✓', color: '#2e7d32', fn: () => this.send(Commands.APPROVE_VIDEO, v.link) });
    if (host || me) defs.push({ text: '✕', color: '#c62828', fn: () => this.send(Commands.REJECT_VIDEO, v.link) });
    this.setButtons(slot, defs);
  }

  // Karaoke: one singer in the queue. `s` is { id, name, v: video, a: approved }. A song added
  // while the player was locked waits (a === false) until the host approves or rejects it.
  fillSingerRow(slot, s, i, singers, host) {
    const me = !!(window.user && s.id === window.user.id);
    const v = s.v || {};
    const waiting = s.a === false;
    this.setStyle(slot.row, 'backgroundColor', waiting ? '#4a3f1e' : me ? '#2e4a3a' : (i % 2 === 0 ? '#2a2a33' : '#31313c'));
    this.setText(slot.title, `${i + 1}. ${s.name || this.tr('Someone')}${me ? ` (${this.tr('you')})` : ''}`, true);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setRowLines(slot, [`${waiting ? this.tr('Waiting for the host to approve') + ':  ' : this.tr('will sing') + ' '}${v.title || this.tr('a song')}`], dur);
    this.setThumb(slot, v.thumbnail, v.link);

    const defs = [];
    if (waiting) {
      if (host) {
        defs.push({ text: '✓', color: '#2e7d32', fn: () => this.send(Commands.APPROVE_SINGER, s.id) });
        defs.push({ text: '✕', color: '#c62828', fn: () => this.send(Commands.REMOVE_FROM_PLAYERS, s.id) });
      } else if (me) {
        defs.push({ text: '✕ Leave', color: '#c62828', fn: () => this.send(Commands.REMOVE_FROM_PLAYERS, s.id) });
      }
    } else {
      // The host can start any singer. Otherwise, while unlocked, only the next singer can start
      // their own song, and only once nothing is playing, so nobody cuts into someone's song.
      const p = this.core.player || {};
      const next = singers.find(x => x.a !== false);
      const playing = !!(p.playlist && p.playlist.length);
      if (host || (me && next === s && !p.locked && !playing)) {
        defs.push({ text: '▶ Sing', color: '#2e7d32', fn: () => { this.stopPreview(true); this.send(Commands.PLAY_KARAOKE_TRACK, (host && next !== s) ? { userId: s.id } : null); } });
      }
      if (host || me) {
        defs.push({ text: me ? '✕ Leave' : '✕', color: '#c62828', fn: () => this.send(Commands.REMOVE_FROM_PLAYERS, s.id) });
      }
    }
    if (host) {
      if (i > 0) defs.push({ text: '⬆', fn: () => this.send(Commands.MOVE_SINGER, { userId: s.id, direction: 'up' }) });
      if (i < singers.length - 1) defs.push({ text: '⬇', fn: () => this.send(Commands.MOVE_SINGER, { userId: s.id, direction: 'down' }) });
    }
    this.setButtons(slot, defs.slice(0, 4));
  }

  fillSearchRow(slot, v, host, inPlaylist) {
    const added = !this.karaoke && inPlaylist && inPlaylist.has(v.link);
    const waits = !this.karaoke && !added && !!this.waitingLinks && this.waitingLinks.has(v.link);
    const previewing = this.karaoke && this.isPreviewing(v);
    this.setStyle(slot.row, 'backgroundColor', previewing ? '#1e3a5f' : added ? '#1b3a2a' : '#2a2a33');
    this.setText(slot.title, v.title || this.tr('Untitled'), true);
    const channel = v.channel && v.channel.name ? v.channel.name : '';
    const dur = typeof v.duration === 'number' && v.duration > 0 ? this.timeCode(v.duration / 1000) : '';
    this.setRowLines(slot, [this.tr(previewing ? 'Previewing on your screen' : added ? 'In the playlist' : waits ? 'Waiting for the host' : ''), channel], dur);
    this.setThumb(slot, v.thumbnail, v.link);

    if (this.karaoke) {
      const defs = [{
        text: previewing ? '■ Stop' : '▶ Preview',
        color: previewing ? '#c62828' : '#00838f',
        fn: () => this.previewSong(v)
      }];
      if (!this.isInQueue()) defs.push({ text: '♪ Sing It', color: '#2e7d32', fn: () => this.singIt(v) });
      this.setButtons(slot, defs);
      return;
    }
    // A Tubi series is a list of episodes: they open in Lists, to pick from.
    const media = window.MediaSources ? MediaSources.detect(v.link) : null;
    if (media && media.type === 'tubi' && media.kind === 'series') {
      this.setButtons(slot, [{ text: '▼ Episodes', color: '#6a1b9a', fn: () => this.showEpisodes(v.link) }]);
      return;
    }
    // Adding stays on the results, so several can be added from one search.
    // Play comes first, on the left, as in the playlist.
    const defs = [];
    if (host) defs.push({ text: '▶ Now', color: '#2e7d32', fn: () => { this.send(Commands.ADD_AND_PLAY, v); this.setTab('playlist'); } });
    if (!added && !waits && (this.canAdd() || this.addWaits())) defs.push({ text: '+ Add', fn: () => this.addVideo(v) });
    if (host) defs.push({ text: '▶| Next', fn: () => { this.send(Commands.ADD_AND_PLAY_NEXT, v); this.setStatus(`"${v.title}" plays next`); } });
    this.setButtons(slot, defs);
  }

  // Lists tab: a saved list. Open shows its videos under it; Add All puts them all at the end of
  // the playlist; Replace (host) makes it the playlist.
  fillListRow(slot, list, host, canAdd) {
    const data = this.listData.get(list.id) || { state: 'none' };
    const open = this.openListId === list.id;
    this.setStyle(slot.row, 'backgroundColor', open ? '#283593' : '#37474f');
    const name = (data.state === 'ready' && data.title) || list.label;
    // Each in its own tr(), so scripts/translate-i18n.js finds them.
    const tagWord = list.isDefault ? this.tr('default') : list.shared ? this.tr('shared') : list.user ? this.tr('mine') : '';
    // Open / Close beside it says whether it's open, so the name needs no marker.
    const tag = tagWord ? ` (${tagWord})` : '';
    this.setText(slot.title, `${name}${tag}`, true);
    let sub;
    if (data.state === 'loading') sub = this.tr('Loading...');
    else if (data.state === 'error') sub = data.error;
    else if (data.state === 'ready') {
      const n = data.items.length;
      sub = `${this.tr(n === 1 ? '{count} video' : '{count} videos', { count: n })}${data.truncated ? ` (${this.tr('the first ones')})` : ''}${data.skipped ? `, ${this.tr('{count} skipped', { count: data.skipped })}` : ''}`;
    } else sub = this.tr('Press Open to see what is in it');
    if (list.shared && list.by) sub += `  -  ${this.tr('saved by {name}', { name: list.by })}`;
    this.setRowLines(slot, [sub], '');
    const first = data.state === 'ready' && data.items[0];
    this.setThumb(slot, first ? first.thumbnail : '', first ? first.link : '');

    const defs = [{ text: open ? '▲ Close' : '▼ Open', color: '#455a64', fn: () => this.toggleList(list.id) }];
    if (data.state === 'error') defs.push({ text: '↻ Retry', fn: () => this.requestList(list.id, true) });
    else {
      if (canAdd) defs.push({ text: '+ All', fn: () => this.appendList(list.id) });
      // A row has 4 buttons: a viewer's own list uses the last two for Share and Remove.
      // A list read on this device (a Tubi series) is one the server may not be able to load.
      if (host && !list.user && !data.device) defs.push({ text: '⇄ Replace', color: '#2e7d32', fn: () => this.replaceWithList(list.id) });
    }
    // Shared lists can be taken out by whoever may add (the host, or anyone while unlocked); a
    // viewer's own list can be shared, or taken out again.
    if (list.shared) {
      if (canAdd) defs.push({ text: '✕', color: '#c62828', fn: () => this.unshareList(list) });
    } else if (list.user) {
      if (canAdd && data.state !== 'error') defs.push({ text: '★ Share', color: '#6a1b9a', fn: () => this.shareList(list.id) });
      defs.push({ text: '✕', color: '#c62828', fn: () => this.removeList(list.id) });
    } else if (this.extraLists.some(l => l.id === list.id)) {
      // One opened for this visit (a pasted link, a Tubi series from Browse) can be closed too.
      defs.push({ text: '✕', color: '#c62828', fn: () => this.removeExtraList(list.id) });
    }
    this.setButtons(slot, defs);
  }

  // Lists tab: one video of the open list.
  fillListItemRow(slot, entry, host, canAdd, inPlaylist) {
    const v = entry.item;
    const added = inPlaylist && inPlaylist.has(v.link);
    const waits = !added && !!this.waitingLinks && this.waitingLinks.has(v.link);
    this.setStyle(slot.row, 'backgroundColor', entry.index % 2 === 0 ? '#2a2a33' : '#31313c');
    this.setText(slot.title, `    ${entry.index + 1}. ${v.title || this.tr('Untitled')}`, true);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setRowLines(slot, [this.tr(added ? 'In the playlist' : waits ? 'Waiting for the host' : ''), this.tr(this.sourceName(v.link))], dur);
    this.setThumb(slot, v.thumbnail, v.link);

    const defs = [];
    if ((canAdd || this.addWaits()) && !added && !waits) defs.push({ text: '+ Add', fn: () => this.addVideo(v) });
    if (host && added) {
      // Already queued: play it where it is.
      defs.push({ text: '▶', color: '#2e7d32', fn: () => {
        const p = this.core.player;
        const i = p && p.playlist ? p.playlist.findIndex(x => x.link === v.link) : -1;
        if (i >= 0) this.send(Commands.SET_TRACK, { index: i, link: v.link });
      } });
    } else if (host) {
      defs.push({ text: '▶ Now', color: '#2e7d32', fn: () => { this.send(Commands.ADD_AND_PLAY, v); this.setStatus(`Playing "${v.title}"`); } });
      defs.push({ text: '▶| Next', fn: () => { this.send(Commands.ADD_AND_PLAY_NEXT, v); this.setStatus(`"${v.title}" plays next`); } });
    }
    this.setButtons(slot, defs);
  }

  // Where a video is from, for the line under its title.
  sourceName(link) {
    const m = window.MediaSources ? MediaSources.detect(link) : null;
    if (!m) return '';
    if (m.drive) return 'Google Drive';
    if (/dropbox/i.test(String(link))) return 'Dropbox';
    if (/archive\.org/i.test(String(link))) return 'archive.org';
    return ({ youtube: 'YouTube', twitch: 'Twitch', twitchclip: 'Twitch clip', vimeo: 'Vimeo', vdoninja: 'VDO.Ninja', sdq: 'Screen share', hls: 'Stream', mpegts: 'Stream', file: 'File', radio: 'Radio', tubi: 'Tubi' })[m.type] || '';
  }
};
window.FirePlaylistPanel = FirePlaylistPanel;
