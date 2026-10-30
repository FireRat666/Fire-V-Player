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
var PAGE_JUMP = 5; // pages the << and >> buttons move
// The list scrolls (a UI Toolkit ScrollView) through this many rows at a time; the page buttons
// move this window through longer lists. Each row is about ten UI elements, and Unity is slow to
// make hundreds of them, so the rows are a fixed pool, built a few at a time after the panel
// opens, and refilled as the window moves. Without a scroll view, it's pages of rowsPerPage.
var LIST_WINDOW = 20;
var FIRST_ROWS = 8; // rows built with the panel; the rest follow in chunks of ROW_CHUNK
var ROW_CHUNK = 4;
// Successful searches kept on this device: how many, and for how long.
var SEARCH_CACHE_SIZE = 10;
var SEARCH_CACHE_MS = 6 * 60 * 60 * 1000;
var SEARCH_COLOR = '#00897b';
// The server works on 3 list previews at a time per connection and refuses more, so the rest wait.
// What Search & Add can search: the source button goes through them in this order.
var SEARCH_SOURCES = {
  youtube: { label: 'YouTube', color: '#c62828', status: 'Searching YouTube.' },
  archive: { label: 'Archive Films', color: '#6d4c41', status: 'Searching Internet Archive films and TV.' },
  tubi: { label: 'Tubi', color: '#5e35b1', status: 'Searching Tubi. The first search takes a few seconds.' },
  nasa: { label: 'NASA+', color: '#0b3d91', status: 'Searching NASA+.' }
};
var LIST_PREVIEWS_AT_ONCE = 3;
// A list preview older than this is loaded again when it's next shown (the server re-reads lists
// after 5 minutes too), and a request with no reply after LIST_REPLY_MS is given up on.
var LIST_FRESH_MS = 5 * 60 * 1000;
var LIST_REPLY_MS = 120000;
// The progress bar's width in pixels: the panel (W, 1100) minus its padding and borders (42), the
// now-playing card's padding (28), the time label (190) and the gap before the bar (10).
var PROGRESS_WIDTH = 820;
// Added to thumbnail links, new each time the space loads. Unity keeps the pictures it has
// downloaded for as long as the client runs (UIElementBridge's texture cache) and never checks one
// is still there, so after a rejoin a cached link can show nothing and never download again.
var THUMB_VISIT = Date.now().toString(36);
var FirePlaylistPanel = class {
  constructor(core) {
    this.core = core;
    this.karaoke = !!core.isKaraoke;
    this.W = 1100;            // panel resolution in pixels
    this.H = 940;
    this.rowsPerPage = 7;
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
    this.userLists = this.loadUserLists();
    // A pasted playlist waiting for its Replace / Add All / Save choice.
    this.pendingList = null;
    this.visible = false;
    this.built = false;
    this.failed = false;
    this.clockSkew = 0;
    this.cache = new Map();
    this.renderTimer = null;
    this.tickTimer = null;
    this.statusTimer = null;
    this.view = 'main';       // 'main' | 'more'
    this.autoSync = false;
    this.seekQuery = '';
    this.linkQuery = '';
    this.pendingReplacement = null;
    this.searchTimer = null;
    this.onMessageFn = msg => this.onMessage(msg);
    core.addMessageListener(this.onMessageFn);
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

  // The list on the first tab: the playlist, or in karaoke mode the singer queue.
  listItems() {
    const p = this.core.player || {};
    return (this.karaoke ? p.players : p.playlist) || [];
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
  setText(el, text) {
    text = text == null ? '' : String(text);
    if (this._changed(el, 'text', text)) el.text = text;
  }
  display(el, on) {
    const v = on ? 'flex' : 'none';
    if (this._changed(el, 'display', v)) el.SetStyles({ display: v });
  }
  setStyle(el, key, value) {
    if (this._changed(el, key, value)) el.SetStyles({ [key]: value });
  }

  send(path, data) {
    const msg = { path };
    if (data !== undefined) msg.data = data;
    this.core.sendMessage(msg);
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

  // Rows shown at once. Without a scroll view, the search tab has one row fewer, for the row of
  // search helpers above it.
  pageSize() {
    if (this.scrolling) return LIST_WINDOW;
    return this.tab === 'search' ? this.rowsPerPage - 1 : this.rowsPerPage;
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
    if (SEARCH_SOURCES[source]) this.searchSource = source;
  }

  // ---- lists saved from a link (Lists tab), kept on this device for this world

  loadUserLists() {
    try {
      const list = JSON.parse(localStorage.getItem(this.userListsKey) || '[]');
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
    el.SetStyles(Object.assign({ backgroundColor: 'rgba(0,0,0,0)' }, styles || {}));
    return el;
  }

  async label(parent, text, styles) {
    const el = await this.ready(this.ui.CreateLabel(undefined, parent));
    el.SetStyles(Object.assign({ color: '#ffffff', fontSize: '20px', backgroundColor: 'rgba(0,0,0,0)' }, styles || {}));
    this.setText(el, text);
    return el;
  }

  async button(parent, text, onClick, styles) {
    const el = await this.ready(this.ui.CreateButton(parent));
    el.SetStyles(Object.assign({
      backgroundColor: '#00838f', color: '#ffffff', fontSize: '20px', flexShrink: 0,
      paddingLeft: '16px', paddingRight: '16px', paddingTop: '8px', paddingBottom: '8px',
      marginLeft: '4px', marginRight: '4px', marginTop: '4px', marginBottom: '4px',
      borderRadius: '10px', borderWidth: '0px', backgroundImage: 'none'
    }, styles || {}));
    this.setText(el, text);
    // Guard against a click arriving twice from one press.
    let last = 0;
    el.OnClick(() => {
      const now = Date.now();
      if (now - last < 350) return;
      last = now;
      if (this.core.blocked) return; // blacklisted: nothing works (see Core.setBlocked)
      try { onClick(); } catch (e) { console.error('[PlaylistPanel] click handler failed:', e); }
    });
    return el;
  }

  // A text input. Returns null when this SDK has no UITextField.
  async textField(parent, placeholder, onValue, onEnter) {
    if (!BS.UITextField) return null;
    const field = await this.ready(new BS.UITextField(this.ui, parent));
    try { field.placeholder = placeholder; } catch (_) {}
    // The SDK theme makes the inner input transparent and the text colour can't be reached from JS,
    // so give the field itself a light box: the dark text stays readable on it.
    // flexBasis 0 and minWidth 0 let the field shrink to the space left beside its buttons, so a long
    // link scrolls inside it instead of widening it and pushing the buttons off the panel.
    field.SetStyles({
      flexGrow: 1, flexShrink: 1, flexBasis: '0px', minWidth: '0px', overflow: 'hidden',
      fontSize: '22px', height: '48px', marginRight: '6px',
      backgroundColor: '#e8e8ef', color: '#111111',
      borderWidth: '2px', borderColor: '#9a9aa8', borderRadius: '8px',
      paddingLeft: '10px', paddingRight: '10px'
    });
    field.OnChange(e => {
      if (!e || e.value == null) return;
      // The SDK only sends a new value when it differs from the last one set from here, and typing
      // doesn't update that copy. Without this, putting back text that was set before (+ lyrics,
      // delete it, + lyrics again) sent nothing, and the box stayed empty.
      try { if ('_value' in field) field._value = String(e.value); } catch (_) {}
      onValue(String(e.value));
    });
    if (typeof field.OnKeyDown === 'function') {
      field.OnKeyDown(e => {
        if (e && (e.key === 'Enter' || e.key === '\n' || e.key === '\r' || e.keyCode === 13)) onEnter();
      });
    }
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

    const UIClass = BS.UI || BS.BanterUI;
    const ui = new UIClass(new BS.Vector2(this.W, this.H), false);
    this.ui = (await this.withTimeout(this.panelObj.AddComponent(ui), 15000, 'Adding the UI panel component')) || ui;
    this.checkAlive();
    console.log('[PlaylistPanel] UI panel added, creating elements...');
    if (typeof this.ui.SetBackgroundColor === 'function') {
      this.ui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
    }

    const rootEl = await this.div(undefined, {
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      backgroundColor: 'rgba(18, 18, 24, 0.96)', borderRadius: '24px',
      borderWidth: '3px', borderColor: '#555555',
      paddingLeft: '18px', paddingRight: '18px', paddingTop: '14px', paddingBottom: '14px'
    });
    const row = (parent, styles) => this.div(parent, Object.assign({ display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0 }, styles || {}));
    const GREY = '#455a64';

    // Header
    const header = await row(rootEl);
    await this.label(header, this.karaoke ? 'Fire-V-Player Karaoke' : 'Fire-V-Player', { fontSize: '30px', fontWeight: 'bold', flexGrow: 1 });
    this.hostLabel = await this.label(header, '', { fontSize: '20px', color: '#bbbbbb', marginRight: '12px' });
    await this.button(header, 'Refresh', () => this.refresh(true), { backgroundColor: GREY });
    this.moreBtn = await this.button(header, 'More...', () => this.setView(this.view === 'more' ? 'main' : 'more'), { backgroundColor: '#2e7d32' });
    await this.button(header, 'Close', () => this.close(), { backgroundColor: GREY });

    // Now playing
    const nowCard = this.nowCard = await this.div(rootEl, {
      display: 'flex', flexDirection: 'column', flexShrink: 0, backgroundColor: '#23232d',
      borderRadius: '14px', paddingLeft: '14px', paddingRight: '14px', paddingTop: '10px', paddingBottom: '12px', marginTop: '8px'
    });
    this.nowTitle = await this.label(nowCard, 'Connecting...', {
      fontSize: '26px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
    });
    const progRow = await this.div(nowCard, { display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '4px' });
    this.timeLabel = await this.label(progRow, '', { fontSize: '20px', color: '#cccccc', width: '190px', flexShrink: 0 });
    // The bar has a fixed width, as a mouse event only says where it is inside the element
    // (the panel is always W pixels wide). The taller clear box around it is easier to hit.
    const progHit = await this.div(progRow, {
      width: `${PROGRESS_WIDTH}px`, height: '36px', flexShrink: 0, marginLeft: '10px',
      display: 'flex', flexDirection: 'column', justifyContent: 'center'
    });
    const progOuter = await this.div(progHit, { height: '10px', backgroundColor: '#444444', borderRadius: '5px' });
    this.progInner = await this.div(progOuter, { height: '100%', width: '0%', backgroundColor: '#e53935', borderRadius: '5px' });
    this.addProgressSeek(progHit);

    // Playback + volume controls
    const controls = this.controlsRow = await row(rootEl, { marginTop: '6px' });
    this.prevTrackBtn = await this.button(controls, 'Prev', () => this.changeTrack(-1));
    this.rewBtn = await this.button(controls, '<< Skip', () => this.core.back());
    this.pauseBtn = await this.button(controls, 'Pause', () => this.send(Commands.TOGGLE_PAUSE));
    this.ffBtn = await this.button(controls, 'Skip >>', () => this.core.forward());
    this.nextTrackBtn = await this.button(controls, 'Next', () => this.changeTrack(1));
    if (this.karaoke) {
      // The host or the person singing can restart or stop the song.
      this.restartBtn = await this.button(controls, 'Restart Song', () => this.send(Commands.RESTART_SONG));
      this.stopBtn = await this.button(controls, 'Stop Song', () => this.send(Commands.STOP), { backgroundColor: '#c62828' });
    }
    // Rebuilds only this viewer's screen, for a video that froze or didn't load for them. Karaoke's
    // row is full, so there it's only in More.
    if (!this.karaoke) await this.button(controls, 'Reload', () => this.core.reloadScreen(), { backgroundColor: '#5d4037' });
    await this.div(controls, { flexGrow: 1 });
    await this.button(controls, 'Vol -', () => { this.core.volume(false); this.renderSoon(); }, { backgroundColor: GREY });
    this.volLabel = await this.label(controls, '', { fontSize: '20px', width: '110px', textAlign: 'center' });
    await this.button(controls, 'Vol +', () => { this.core.volume(true); this.renderSoon(); }, { backgroundColor: GREY });
    this.muteBtn = await this.button(controls, 'Mute', () => { this.core.mute(); this.renderSoon(); }, { backgroundColor: GREY });

    // Replacement suggestion (when a user can't play a video)
    this.noticeRow = await row(rootEl, { marginTop: '6px', backgroundColor: '#4e342e', borderRadius: '10px', paddingLeft: '10px', paddingRight: '6px' });
    this.noticeLabel = await this.label(this.noticeRow, '', { fontSize: '18px', flexGrow: 1, flexShrink: 1, whiteSpace: 'normal' });
    this.replaceConfirmBtn = await this.button(this.noticeRow, 'Replace', () => this.confirmReplace(), { backgroundColor: '#2e7d32' });
    await this.button(this.noticeRow, 'Dismiss', () => this.dismissReplace(), { backgroundColor: '#c62828' });

    // A pasted playlist: what to do with it.
    this.listPromptRow = await this.div(rootEl, {
      display: 'none', flexDirection: 'column', flexShrink: 0, marginTop: '6px', backgroundColor: '#1a237e',
      borderRadius: '10px', paddingLeft: '12px', paddingRight: '8px', paddingTop: '6px', paddingBottom: '6px'
    });
    this.listPromptLabel = await this.label(this.listPromptRow, '', { fontSize: '20px', whiteSpace: 'normal' });
    const promptBtns = await row(this.listPromptRow, { marginTop: '4px', flexWrap: 'wrap' });
    this.promptReplaceBtn = await this.button(promptBtns, 'Replace Playlist', () => this.answerListPrompt('replace'), { backgroundColor: '#2e7d32' });
    this.promptAppendBtn = await this.button(promptBtns, 'Add All to End', () => this.answerListPrompt('append'));
    this.promptShareBtn = await this.button(promptBtns, 'Save for Everyone', () => this.answerListPrompt('share'), { backgroundColor: '#6a1b9a' });
    this.promptSaveBtn = await this.button(promptBtns, 'Save for Me', () => this.answerListPrompt('save'), { backgroundColor: '#4a148c' });
    this.promptVideoBtn = await this.button(promptBtns, 'Just This Video', () => this.answerListPrompt('video'));
    await this.button(promptBtns, 'Cancel', () => this.answerListPrompt(null), { backgroundColor: GREY });

    // ---- Main view: playlist / search
    this.mainView = await this.div(rootEl, { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' });

    const tabs = await row(this.mainView, { marginTop: '6px' });
    this.tabPlaylistBtn = await this.button(tabs, this.karaoke ? 'Singers' : 'Playlist', () => this.setTab('playlist'));
    // Saved lists (not in karaoke mode, where the first tab is the singer queue).
    this.tabListsBtn = this.karaoke ? null : await this.button(tabs, 'Lists', () => this.setTab('lists'));
    // Search opens over the whole panel (see render), so it stands out from the tabs.
    this.tabSearchBtn = await this.button(tabs, this.karaoke ? 'Search Songs' : 'Search & Add', () => this.openSearch(), {
      backgroundColor: SEARCH_COLOR, paddingLeft: '22px', paddingRight: '22px', fontWeight: 'bold'
    });
    // While searching: a title and the way back, instead of the tabs.
    this.searchTitle = await this.label(tabs, this.karaoke ? 'Search for a song' : 'Search', { fontSize: '26px', fontWeight: 'bold', marginLeft: '6px', marginRight: '12px' });
    this.closeSearchBtn = await this.button(tabs, this.karaoke ? 'Back to Singers' : 'Back to Playlist', () => this.closeSearch(), { backgroundColor: '#c62828' });
    await this.div(tabs, { flexGrow: 1 });
    // Page buttons: first, back 5, back 1, forward 1, forward 5, last. With a scroll view they
    // move the window of rows (see LIST_WINDOW), and Now goes back to the playing video.
    const pageBtn = { backgroundColor: GREY, paddingLeft: '12px', paddingRight: '12px' };
    this.nowBtn = this.karaoke ? null : await this.button(tabs, 'Now', () => this.showCurrent(), pageBtn);
    this.firstPageBtn = await this.button(tabs, '|<', () => this.changePage(-Infinity), pageBtn);
    this.back5Btn = await this.button(tabs, '<<', () => this.changePage(-PAGE_JUMP), pageBtn);
    this.prevPageBtn = await this.button(tabs, '<', () => this.changePage(-1), pageBtn);
    this.pageLabel = await this.label(tabs, '1 / 1', { fontSize: '18px', width: '130px', textAlign: 'center' });
    this.nextPageBtn = await this.button(tabs, '>', () => this.changePage(1), pageBtn);
    this.fwd5Btn = await this.button(tabs, '>>', () => this.changePage(PAGE_JUMP), pageBtn);
    this.lastPageBtn = await this.button(tabs, '>|', () => this.changePage(Infinity), pageBtn);

    this.searchRow = await row(this.mainView, { marginTop: '4px' });
    const searchHint = this.karaoke ? 'Search for a song to sing, or paste a video link' : 'Search YouTube, or paste a YouTube / Twitch / Vimeo / video link';
    this.searchField = await this.textField(this.searchRow, searchHint, v => { this.searchQuery = v; }, () => this.doSearch());
    if (this.searchField) {
      // What to search: YouTube, Internet Archive films and TV, Tubi or NASA+ (not for karaoke).
      if (!this.karaoke) this.sourceBtn = await this.button(this.searchRow, 'YouTube', () => this.toggleSearchSource(), { backgroundColor: '#c62828', width: '170px' });
      await this.button(this.searchRow, 'Search', () => this.doSearch(), { backgroundColor: '#1565c0' });
      // The last search, when its results were kept on this device.
      if (this.searchQuery) this.setSearchText(this.searchQuery);
    } else {
      await this.label(this.searchRow, 'Search needs text input, which this client does not have.', { color: '#bbbbbb', flexGrow: 1 });
    }

    // Search helpers: karaoke's words to add to the search, then recent searches.
    this.searchToolsRow = await row(this.mainView, { overflow: 'hidden' });
    const small = { fontSize: '18px', paddingLeft: '12px', paddingRight: '12px', paddingTop: '6px', paddingBottom: '6px' };
    if (this.karaoke && this.searchField) {
      for (const word of ['karaoke', 'lyrics', 'zoom karaoke']) {
        await this.button(this.searchToolsRow, `+ ${word}`, () => this.addSearchWord(word), Object.assign({ backgroundColor: '#6a1b9a' }, small));
      }
    }
    this.recentLabel = await this.label(this.searchToolsRow, 'Recent:', { fontSize: '18px', color: '#bbbbbb', marginLeft: '8px', marginRight: '2px', flexShrink: 0 });
    this.recentBtns = [];
    for (let k = 0; k < 5; k++) {
      const idx = k;
      const btn = await this.button(this.searchToolsRow, '', () => {
        const q = this.recentSearches[idx];
        if (!q) return;
        this.setSearchText(q);
        this.doSearch();
      }, Object.assign({
        backgroundColor: GREY, flexShrink: 1, minWidth: '60px', maxWidth: '240px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }, small));
      this.recentBtns.push(btn);
    }
    this.clearRecentBtn = await this.button(this.searchToolsRow, 'Clear', () => this.clearRecent(), Object.assign({ backgroundColor: '#c62828' }, small));

    // List rows: a fixed pool, re-filled as the list or its window changes. In a scroll view when
    // this SDK has one (as in the user's other worlds: CreateScrollView, overflow scroll, and a
    // column inside), else pages of rowsPerPage.
    let list = null;
    if (typeof this.ui.CreateScrollView === 'function') {
      try {
        const scroller = await this.ready(this.ui.CreateScrollView(this.mainView));
        scroller.SetStyles({
          flexGrow: 1, flexShrink: 1, flexBasis: '0px', minHeight: '0px', marginTop: '6px',
          overflow: 'scroll', backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none'
        });
        list = await this.div(scroller, { display: 'flex', flexDirection: 'column', flexShrink: 0, paddingRight: '6px' });
        this.scroller = scroller;
        this.scrolling = true;
      } catch (e) {
        console.warn('[PlaylistPanel] Could not make a scroll view, so the list shows in pages:', e);
        list = null;
      }
    }
    if (!list) {
      this.scrolling = false;
      list = await this.div(this.mainView, { display: 'flex', flexDirection: 'column', flexGrow: 1, marginTop: '6px', overflow: 'hidden' });
    }
    this.listCol = list;
    // First, so rows added later go after it (it only shows when there are no rows).
    this.emptyLabel = await this.label(list, '', { color: '#bbbbbb', fontSize: '22px', textAlign: 'center', marginTop: '20px', whiteSpace: 'normal' });
    this.rows = [];
    const firstRows = this.scrolling ? FIRST_ROWS : this.rowsPerPage;
    for (let k = 0; k < firstRows; k++) this.rows.push(await this.makeRow(list));

    // ---- More view: host controls, seek, your own player, add by link
    this.moreView = await this.div(rootEl, { display: 'none', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', marginTop: '6px' });
    const section = async (title) => {
      const box = await this.div(this.moreView, {
        display: 'flex', flexDirection: 'column', flexShrink: 0, backgroundColor: '#23232d',
        borderRadius: '14px', paddingLeft: '12px', paddingRight: '12px', paddingTop: '8px', paddingBottom: '8px', marginBottom: '8px'
      });
      await this.label(box, title, { fontSize: '20px', color: '#bbbbbb', marginLeft: '4px' });
      return box;
    };

    // Host controls
    this.hostSection = await section('Host controls');
    const hostRow = await row(this.hostSection, { flexWrap: 'wrap' });
    this.lockBtn = await this.button(hostRow, 'Lock', () => {
      if (this.core.player) this.send(Commands.TOGGLE_LOCK, !this.core.player.locked);
    });
    this.takeOverBtn = await this.button(hostRow, 'Take Over', () => {
      const player = this.core.player;
      if (!player) return;
      if (this.isHost()) this.send(Commands.TOGGLE_CAN_TAKE_OVER, !player.canTakeOver);
      else this.send(Commands.TAKE_OVER);
    });
    if (this.karaoke) {
      // Auto Advance: when a song ends, the next singer starts by themselves.
      this.autoAdvanceBtn = await this.button(hostRow, 'Auto Advance: Off', () => this.send(Commands.TOGGLE_AUTO_ADVANCE));
    } else {
      this.votingBtn = await this.button(hostRow, 'Voting: Off', () => this.send(Commands.TOGGLE_VOTE));
      this.clearBtn = await this.button(hostRow, 'Clear Playlist', () => this.send(Commands.CLEAR_PLAYLIST), { backgroundColor: '#c62828' });
      this.loadDefaultBtn = await this.button(hostRow, 'Load Default Playlist', () => {
        this.send(Commands.FROM_PLAYLIST, { id: this.core.params.playlist, shouldClear: true, fromPlaylist: true });
        this.setStatus('Loading playlist...');
      }, { backgroundColor: '#2e7d32' });
    }
    this.notHostLabel = await this.label(this.hostSection, '', { fontSize: '18px', color: '#999999', marginLeft: '4px', marginTop: '4px' });

    // Seek (host)
    this.seekSection = await section('Seek (moves everyone)');
    const seekRow = await row(this.seekSection);
    this.seekField = await this.textField(seekRow, 'Time, e.g. 95 or 1:35', v => { this.seekQuery = v; }, () => this.doSeek());
    if (this.seekField) {
      this.seekField.SetStyles({ flexGrow: 0, flexBasis: '300px', width: '300px' });
      await this.button(seekRow, 'Seek', () => this.doSeek(), { backgroundColor: '#1565c0' });
    }
    await this.button(seekRow, '-30s', () => this.seekBy(-30), { backgroundColor: GREY });
    await this.button(seekRow, '+30s', () => this.seekBy(30), { backgroundColor: GREY });

    // Your own player
    const mineSection = await section('Your player only');
    const mineRow = await row(mineSection, { flexWrap: 'wrap' });
    await this.button(mineRow, 'Reload Video', () => this.core.reloadScreen(), { backgroundColor: '#5d4037' });
    await this.button(mineRow, '<< Skip', () => this.sendMine(Commands.LOCAL_SKIP_BACK, Commands.SKIP_BACK));
    await this.button(mineRow, 'Skip >>', () => this.sendMine(Commands.LOCAL_SKIP_FORWARD, Commands.SKIP_FORWARD));
    this.autoSyncBtn = await this.button(mineRow, 'Auto Sync: Off', () => {
      this.autoSync = !this.autoSync;
      this.sendMine(Commands.AUTO_SYNC, Commands.AUTO_SYNC, this.autoSync);
      this.render();
    });
    this.captionsBtn = await this.button(mineRow, 'Captions: On', () => {
      this.core.setCaptions(this.core.captions === false);
      this.render();
    });
    // Steps through the screen resolutions (page widths), then back to the snippet's.
    this.resolutionBtn = await this.button(mineRow, 'Resolution', () => {
      const choices = SCREEN_RESOLUTIONS.filter(w => w !== this.core.defaultResolution());
      const now = this.core.viewerResolution;
      const next = now ? choices[choices.indexOf(now) + 1] : choices[0];
      this.core.setScreenResolution(next || null);
      this.render();
    }, { backgroundColor: '#00838f' });
    // Steps the hand controls through their places (Core's HAND_PLACES), when the snippet has them.
    if (this.core.params['hand-controls'] === 'true') {
      this.handBtn = await this.button(mineRow, 'Hand Controls', () => {
        Promise.resolve(this.core.nextHandPlace()).then(() => this.render()).catch(() => {});
      }, { backgroundColor: '#5d4037' });
    }
    await this.label(mineRow, 'These change only your own player.', { fontSize: '16px', color: '#999999', marginLeft: '8px', flexShrink: 1 });

    // Add by link (in karaoke mode, pasting a link into Search does this)
    const linkSection = this.karaoke ? null : await section('Add by link');
    if (linkSection) {
      const linkRow = await row(linkSection);
      this.linkField = await this.textField(linkRow, 'Video link, YouTube playlist, or list of links (.txt, .m3u, Google Doc, Drive folder)', v => { this.linkQuery = v; }, () => this.addLink());
      if (this.linkField) {
        // A video is added; a playlist or list of links asks what to do with it.
        await this.button(linkRow, 'Add', () => this.addLink(), { backgroundColor: '#2e7d32' });
      } else {
        await this.label(linkRow, 'Adding links needs text input, which this client does not have.', { color: '#bbbbbb', flexGrow: 1 });
      }
    }

    // Mode: switches everyone (saved in the space state, see Core.switchMode). Shown to everyone,
    // because the client can't always tell who is a space admin; the server refuses anyone else.
    this.adminSection = await section('Space admins only');
    const adminRow = await row(this.adminSection, { flexWrap: 'wrap' });
    this.modeLabel = await this.label(adminRow, '', { fontSize: '20px', marginLeft: '4px', marginRight: '12px' });
    this.modeSwitchBtn = await this.button(adminRow, '', () => this.switchMode(), { backgroundColor: '#6a1b9a' });
    this.modeDefaultBtn = await this.button(adminRow, 'Use Snippet Default', () => this.useDefaultMode(), { backgroundColor: GREY });
    // Take control even when the player is locked (see Core.adminTakeOver).
    this.adminTakeOverBtn = await this.button(adminRow, 'Admin Take Over', () => this.adminTakeOver(), { backgroundColor: '#ad1457' });
    await this.label(this.adminSection, 'These only work for space admins (the world owner and community moderators). Admin Take Over makes you the host even when the player is locked. The mode switches everyone in the space.', { fontSize: '16px', color: '#999999', marginLeft: '4px', marginTop: '4px', whiteSpace: 'normal' });

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
    console.log(`[PlaylistPanel] Ready${this.scrolling ? ' (scrolling list)' : ''}.`);
    if (this.scrolling) this.growRows();
  }

  // One list row: picture, title and a line under it, and up to four buttons.
  async makeRow(parent) {
    const r = await this.div(parent, {
      display: 'flex', flexDirection: 'row', alignItems: 'center', height: '76px', flexShrink: 0,
      paddingLeft: '6px', paddingRight: '6px', marginBottom: '5px', borderRadius: '10px', backgroundColor: '#2a2a33'
    });
    const thumb = await this.div(r, { width: '112px', height: '63px', flexShrink: 0, borderRadius: '6px', backgroundColor: '#000000' });
    const info = await this.div(r, { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: '0px', marginLeft: '12px', overflow: 'hidden' });
    const title = await this.label(info, '', { fontSize: '22px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    const sub = await this.label(info, '', { fontSize: '16px', color: '#aaaaaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '4px' });
    const btns = await this.div(r, { display: 'flex', flexDirection: 'row', flexShrink: 0 });
    const slot = { row: r, thumb, title, sub, buttons: [], actions: [] };
    for (let b = 0; b < 4; b++) {
      const idx = b;
      const btn = await this.button(btns, '', () => { const fn = slot.actions[idx]; if (fn) fn(); }, { fontSize: '18px', paddingLeft: '12px', paddingRight: '12px' });
      slot.buttons.push(btn);
    }
    // Hidden until it has something to show, so a row built ahead of time stays out of the way.
    this.display(r, false);
    return slot;
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
    if (!this.scrolling || !this.listCol) return;
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
    this.built = false;
    this.visible = false;
    [this.tickTimer, this.renderTimer, this.statusTimer, this.searchTimer, this.scrollTimer, this.listExpiryTimer].forEach(t => { clearTimeout(t); clearInterval(t); });
    this.tickTimer = this.renderTimer = this.statusTimer = this.searchTimer = this.scrollTimer = this.listExpiryTimer = null;
    (this.thumbTimers || []).forEach(clearTimeout);
    this.thumbTimers = [];
    if (typeof this.core.removeMessageListener === 'function') this.core.removeMessageListener(this.onMessageFn);
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
    const hand = this.core.handPose;
    if (fromHand && hand && hand.position) {
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
      const pose = this.frontPose(fromHand);
      if (!pose) return;
      this.frontYaw = pose.yaw;
      const f = n => Number(n).toFixed(2);
      const head = this.core.headPose();
      console.log(`[PlaylistPanel] In front: head (${head.source}) ${f(head.position.x)} ${f(head.position.y)} ${f(head.position.z)}, facing ${Math.round(pose.yaw)} degrees${fromHand ? ' (toward the left hand)' : ''}.`);
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
    this.send(Commands.SET_TRACK, (player.currentTrack + delta + len) % len);
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
  }

  // "95", "1:35" or "1:02:03" -> seconds, or null.
  parseTime(str) {
    const t = String(str || '').trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    if (!/^\d+(:\d{1,2}){1,2}$/.test(t)) return null;
    return t.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }

  currentPlaybackTime() {
    const p = this.core.player;
    if (!p) return 0;
    return p.paused ? (p.currentTime || 0) : ((Date.now() / 1000 - this.clockSkew) - (p.lastStartTime || 0));
  }

  doSeek() {
    if (!this.isHost()) { this.setStatus('Only the host can seek.'); return; }
    const t = this.parseTime(this.seekQuery);
    if (t === null) { this.setStatus('Enter a time in seconds (95) or mm:ss (1:35).'); return; }
    this.send(Commands.SET_TIME, t);
    this.setStatus(`Seeking to ${this.timeCode(t)}`);
  }

  seekBy(delta) {
    if (!this.isHost()) { this.setStatus('Only the host can seek.'); return; }
    const p = this.core.player;
    if (!p || !p.playlist || !p.playlist.length) return;
    // A file may have no known length; then only the start limits it.
    const t = Math.max(0, p.duration > 0 ? Math.min(p.duration, this.currentPlaybackTime() + delta) : this.currentPlaybackTime() + delta);
    this.send(Commands.SET_TIME, t);
  }

  // The host can click the progress bar, or press on it and drag, to move everyone to that point.
  // While dragging, the bar and time show where it will go; letting go (or leaving the bar) seeks.
  addProgressSeek(el) {
    if (typeof el.OnMouseDown !== 'function') return; // an SDK without mouse events
    const canSeek = () => {
      const p = this.core.player;
      return !this.core.blocked && this.isHost() && !!p && !!p.playlist && p.playlist.length > 0 && p.duration > 0;
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
    const at = (e) => {
      const x = e && Number.isFinite(e.clientX) ? e.clientX : 0;
      const d = this.core.player.duration;
      return Math.min(Math.max(0, x / PROGRESS_WIDTH) * d, Math.max(0, d - 1)); // the very end would end the song
    };
    const show = (t) => {
      const d = this.core.player.duration;
      this.setText(this.timeLabel, `${this.timeCode(t)} / ${this.timeCode(d)}`);
      this.setStyle(this.progInner, 'width', `${Math.round((t / d) * 200) / 2}%`);
    };
    const finish = () => {
      if (this.dragSeek == null) return;
      const t = this.dragSeek;
      if (!stillOn()) { cancel(); return; }
      this.dragSeek = null;
      this.send(Commands.SET_TIME, t);
      this.setStatus(`Seeking to ${this.timeCode(t)}`);
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
      if (!this.canAdd()) this.setStatus('The player is locked: only the host can add videos.');
      else { this.send(Commands.ADD_TO_PLAYLIST, found.link); this.setStatus('Adding video...'); }
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

  // The furthest a tab's rows can start: the last full window (scrolling), or the last page.
  maxStart(total) {
    const size = this.pageSize();
    if (this.scrolling) return Math.max(0, total - size);
    return Math.max(0, Math.ceil(total / size) - 1) * size;
  }

  // Moves the rows by `delta` windows (pages), or to either end with -Infinity / Infinity.
  changePage(delta) {
    const size = this.pageSize();
    const from = this.tabStart();
    let start = Math.min(this.maxStart(this.tabItems().length), Math.max(0, from + delta * size));
    if (!this.scrolling) start = Math.floor(start / size) * size;
    this.showFrom(start);
  }

  // Shows the current tab's rows from item `start`, at the top of the scroll view.
  showFrom(start) {
    const changed = start !== this.tabStart();
    this.setTabStart(start);
    if (changed) this.resetScroll();
    this.render();
  }

  // Switches the search to the next source (YouTube, Archive films, Tubi, NASA+). It only searches
  // when Search is pressed, so clicking through the sources doesn't start one each time.
  toggleSearchSource() {
    const order = Object.keys(SEARCH_SOURCES);
    this.searchSource = order[(order.indexOf(this.searchSource) + 1) % order.length];
    this.showSearchSource();
    this.setStatus(SEARCH_SOURCES[this.searchSource].status.replace(/^Searching/, 'Search will look on'), 4000);
  }
  showSearchSource() {
    if (!this.sourceBtn) return;
    const source = SEARCH_SOURCES[this.searchSource] || SEARCH_SOURCES.youtube;
    this.setText(this.sourceBtn, source.label);
    this.setStyle(this.sourceBtn, 'backgroundColor', source.color);
  }

  // Where the playing video is: its row near the top (one before it shows above), or its page.
  currentStart() {
    const player = this.core.player;
    const current = player && typeof player.currentTrack === 'number' ? player.currentTrack : 0;
    const size = this.pageSize();
    const total = this.listItems().length;
    if (!this.scrolling) return Math.floor(current / size) * size;
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
    const isLink = /^(https?|rtspt?):\/\//i.test(q) || !!this.core.getId(q);
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
      this.setStatus(`${n} result${n === 1 ? '' : 's'} (from your recent searches)`);
      this.render();
      return;
    }
    // Each search has an ID that comes back on its reply, so an earlier search answered late is
    // neither shown nor kept under this one's words.
    const searchId = ++this.searchId;
    this.pendingSearchKey = isLink ? null : { key, query: q };
    const data = { term: q, searchId };
    if (this.searchSource !== 'youtube') data.source = this.searchSource;
    this.send(Commands.SEARCH, data);
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
      } else {
        this.setStatus(`Searching... ${secs}s`, 0);
      }
    }, 1000);
    this.tab = 'search';
    this.render();
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

  singIt(v) {
    if (this.isInQueue()) { this.setStatus('You are already in the singer queue.'); return; }
    this.send(Commands.ADD_TO_PLAYERS, v);
    this.setStatus(`You're in the queue to sing "${v.title}"`);
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
    if (this.listsOut.has(id) || this.listQueue.includes(id)) return;
    const had = this.listData.get(id);
    if (had && had.state === 'ready' && !force && Date.now() - had.at < LIST_FRESH_MS) return;
    if (!(had && had.state === 'ready')) this.listData.set(id, { state: 'loading', at: Date.now() });
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
    this.send(Commands.FROM_PLAYLIST, { id, append: true, fromPlaylist: true });
    this.setStatus('Adding the list to the playlist...', 0);
  }

  // Replaces the playlist with a list (the host only).
  replaceWithList(id) {
    if (!this.isHost()) { this.setStatus('Only the host can load a playlist.'); return; }
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
        this.setStatus(n ? `${n} result${n === 1 ? '' : 's'}` : 'No results.');
        break;
      case Commands.ERROR: {
        if (json.searchId !== undefined && json.searchId !== this.searchId) break; // an earlier search's
        const m = json.data && json.data.message ? json.data.message : (typeof json.data === 'string' ? json.data : "I can't let you do that...");
        // A failed search sends empty results and then an error; stop the "Searching..." counter
        // anyway so it doesn't overwrite the error. Results that still arrive later are shown as usual.
        clearInterval(this.searchTimer);
        this.searchTimer = null;
        this.setStatus(m, 5000);
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

  renderSoon() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 100);
  }

  // ---------------------------------------------------------------- render

  updateTime() {
    if (!this.built || this.dragSeek != null) return; // a drag on the bar shows its own time
    const p = this.core.player;
    if (!p || !p.playlist || !p.playlist.length) {
      this.setText(this.timeLabel, '');
      this.setStyle(this.progInner, 'width', '0%');
      return;
    }
    const duration = p.duration;
    if (!(duration > 0)) {
      // No known length (some files): just how far in it is.
      const t = Math.max(0, p.paused ? (p.currentTime || 0) : ((Date.now() / 1000 - this.clockSkew) - (p.lastStartTime || 0)));
      this.setText(this.timeLabel, `${this.timeCode(t)} / --:--`);
      this.setStyle(this.progInner, 'width', '0%');
      return;
    }
    let t = p.paused ? (p.currentTime || 0) : ((Date.now() / 1000 - this.clockSkew) - (p.lastStartTime || 0));
    t = Math.max(0, Math.min(t, duration));
    this.setText(this.timeLabel, `${this.timeCode(t)} / ${this.timeCode(duration)}`);
    const pct = Math.round((t / duration) * 200) / 2; // half-percent steps
    this.setStyle(this.progInner, 'width', `${pct}%`);
  }

  render() {
    if (!this.built || !this.visible) return;
    const player = this.core.player || {};
    const playlist = player.playlist || [];
    const host = this.isHost();
    const hasPlaylist = playlist.length > 0;

    // Header
    const lockText = player.locked ? ' (locked)' : '';
    if (!player.host) this.setText(this.hostLabel, 'Connecting...');
    else this.setText(this.hostLabel, host ? `You are the host${lockText}` : `Host: ${player.host.name}${lockText}`);

    // Now playing
    const current = playlist[player.currentTrack];
    const idle = player.host ? (this.karaoke ? 'Nobody is singing' : 'Nothing playing') : 'Connecting...';
    let nowText = current ? current.title : idle;
    if (current && this.karaoke) nowText = `Now singing: ${current.user && current.user.name ? current.user.name + ' - ' : ''}${current.title}`;
    this.setText(this.nowTitle, nowText);
    this.updateTime();

    // Controls
    this.display(this.prevTrackBtn, !this.karaoke && host && playlist.length > 1);
    this.display(this.nextTrackBtn, !this.karaoke && host && playlist.length > 1);
    if (this.karaoke) {
      const singer = this.currentSinger();
      const canControlSong = hasPlaylist && (host || !!(singer && window.user && singer.id === window.user.id));
      this.display(this.restartBtn, canControlSong);
      this.display(this.stopBtn, canControlSong);
    }
    this.display(this.pauseBtn, host && hasPlaylist);
    this.setText(this.pauseBtn, player.paused ? 'Play' : 'Pause');
    this.setStyle(this.pauseBtn, 'backgroundColor', player.paused ? '#2e7d32' : '#c62828');
    this.display(this.rewBtn, hasPlaylist);
    this.display(this.ffBtn, hasPlaylist);
    const muted = this.core.params.mute === 'true';
    this.setText(this.volLabel, `Vol ${this.core.params.volume}`);
    this.setText(this.muteBtn, muted ? 'Unmute' : 'Mute');
    this.setStyle(this.muteBtn, 'backgroundColor', muted ? '#c62828' : '#455a64');

    // Views
    const more = this.view === 'more';
    this.display(this.mainView, !more);
    this.display(this.moreView, more);
    this.setText(this.moreBtn, more ? 'Back' : 'More...');

    // Replacement suggestion
    const r = this.pendingReplacement;
    this.display(this.noticeRow, !!r);
    if (r) this.setText(this.noticeLabel, `Someone can't play "${r.original.title}". Replace it with "${r.alternative.title}"?`);
    this.display(this.replaceConfirmBtn, host);

    // More view
    this.setText(this.autoSyncBtn, this.autoSync ? 'Auto Sync: On' : 'Auto Sync: Off');
    this.setStyle(this.autoSyncBtn, 'backgroundColor', this.autoSync ? '#2e7d32' : '#00838f');
    const captions = this.core.captions !== false;
    this.setText(this.captionsBtn, captions ? 'Captions: On' : 'Captions: Off');
    this.setStyle(this.captionsBtn, 'backgroundColor', captions ? '#2e7d32' : '#00838f');
    const [resW, resH] = this.core.screenPageSize();
    if (this.handBtn) this.setText(this.handBtn, `Hand Controls: ${this.core.handPlaceLabel()}`);
    this.setText(this.resolutionBtn, `Resolution: ${resW} x ${resH}${this.core.viewerResolution ? '' : ' (default)'}`);
    this.display(this.seekSection, host);
    if (this.loadPlaylistBtn) this.display(this.loadPlaylistBtn, host);
    this.setText(this.notHostLabel, host ? '' : (player.canTakeOver ? 'The host allows take over.' : 'Only the host can use these.'));
    this.display(this.notHostLabel, !host);

    // Space admins only, but shown to everyone
    this.display(this.adminTakeOverBtn, !host);
    {
      const def = this.core.defaultMode || (this.karaoke ? 'karaoke' : 'playlist');
      const override = this.core.modeOverride;
      const from = override ? 'set by a space admin' : 'the snippet default';
      this.setText(this.modeLabel, `Mode: ${this.modeName(this.karaoke ? 'karaoke' : 'playlist')} (${from})`);
      this.setText(this.modeSwitchBtn, `Switch to ${this.karaoke ? 'Playlist' : 'Karaoke'}`);
      this.display(this.modeDefaultBtn, !!override);
      this.setText(this.modeDefaultBtn, `Use Snippet Default (${this.modeName(def)})`);
    }

    // Host controls
    this.display(this.lockBtn, host);
    this.setText(this.lockBtn, player.locked ? 'Unlock' : 'Lock');
    this.setStyle(this.lockBtn, 'backgroundColor', player.locked ? '#00838f' : '#c62828');
    this.display(this.takeOverBtn, host || !!player.canTakeOver);
    this.setText(this.takeOverBtn, player.canTakeOver ? (host ? 'Take Over: On' : 'Take Over') : 'Take Over: Off');
    this.setStyle(this.takeOverBtn, 'backgroundColor', player.canTakeOver ? (host ? '#c62828' : '#2e7d32') : '#00838f');
    if (this.karaoke) {
      this.display(this.autoAdvanceBtn, host);
      this.setText(this.autoAdvanceBtn, player.autoAdvance ? 'Auto Advance: On' : 'Auto Advance: Off');
      this.setStyle(this.autoAdvanceBtn, 'backgroundColor', player.autoAdvance ? '#2e7d32' : '#00838f');
    } else {
      this.display(this.votingBtn, host);
      this.setText(this.votingBtn, player.canVote ? 'Voting: On' : 'Voting: Off');
      this.display(this.clearBtn, host && hasPlaylist);
      this.display(this.loadDefaultBtn, host && !hasPlaylist && !!this.core.params.playlist);
    }

    // Tabs
    if (this.karaoke && this.tab === 'lists') this.tab = 'playlist';
    const onSearch = this.tab === 'search';
    const onLists = this.tab === 'lists';
    // Search covers the panel: no now playing or transport, and a title and Back instead of tabs.
    const searching = onSearch && !more;
    this.display(this.nowCard, !searching);
    this.display(this.controlsRow, !searching);
    this.display(this.tabPlaylistBtn, !onSearch);
    if (this.tabListsBtn) this.display(this.tabListsBtn, !onSearch);
    this.display(this.tabSearchBtn, !onSearch);
    this.display(this.searchTitle, onSearch);
    this.display(this.closeSearchBtn, onSearch);
    this.showSearchSource();

    // A pasted playlist's question.
    const pl = this.pendingList;
    this.display(this.listPromptRow, !!pl);
    if (pl) {
      const data = this.listData.get(pl.id);
      const name = (data && data.state === 'ready' && data.title) || (typeof this.core.listLabel === 'function' ? this.core.listLabel(pl.id) : 'playlist');
      const size = data && data.state === 'ready' ? ` (${data.items.length} videos)` : data && data.state === 'loading' ? ' (loading...)' : '';
      const can = host ? '' : this.canAdd() ? ' Only the host can replace the playlist.' : ' The player is locked: you can save it for yourself.';
      const failed = data && data.state === 'error';
      this.setText(this.listPromptLabel, failed
        ? `That link isn't a playlist or video this player can use: ${data.error}`
        : `That's a playlist: ${name}${size}. Replace the playlist, add it all to the end, or save it to Lists (for everyone here, or just for you)?${can}`);
      this.display(this.promptReplaceBtn, host && !failed);
      this.display(this.promptAppendBtn, this.canAdd() && !failed);
      this.display(this.promptShareBtn, this.canAdd() && !failed);
      this.display(this.promptSaveBtn, !failed);
      this.display(this.promptVideoBtn, pl.video && this.canAdd());
    }
    const list = this.listItems();
    this.setText(this.tabPlaylistBtn, `${this.karaoke ? 'Singers' : 'Playlist'} (${list.length})`);
    this.setStyle(this.tabPlaylistBtn, 'backgroundColor', this.tab === 'playlist' ? '#1565c0' : '#455a64');
    if (this.tabListsBtn) {
      const lists = this.getLists();
      this.setText(this.tabListsBtn, lists.length ? `Lists (${lists.length})` : 'Lists');
      this.setStyle(this.tabListsBtn, 'backgroundColor', onLists ? '#1565c0' : '#455a64');
    }
    if (this.nowBtn) this.display(this.nowBtn, !!(!onSearch && hasPlaylist && (this.tab !== 'playlist' || list.length > this.pageSize())));
    this.display(this.searchRow, onSearch);
    this.display(this.searchToolsRow, onSearch && !!this.searchField);
    const recent = this.recentSearches;
    (this.recentBtns || []).forEach((btn, k) => {
      this.display(btn, k < recent.length);
      if (k < recent.length) this.setText(btn, recent[k]);
    });
    this.display(this.recentLabel, recent.length > 0);
    this.display(this.clearRecentBtn, recent.length > 0);

    const items = onLists ? this.listEntries() : onSearch ? this.searchResults : list;
    const size = this.pageSize();
    const pages = Math.max(1, Math.ceil(items.length / size));
    const start = Math.min(this.tabStart(), this.maxStart(items.length));
    this.setTabStart(start);
    if (this.scrolling) {
      // The window of rows in the scroll view: "21-40 / 300".
      this.setText(this.pageLabel, items.length ? `${start + 1}-${Math.min(items.length, start + size)} / ${items.length}` : '0 / 0');
    } else {
      this.setText(this.pageLabel, `${Math.floor(start / size) + 1} / ${pages}`);
    }
    // Back and forward only when there's more than fits, first and last from 3 windows, the
    // jumps of 5 only past that.
    this.display(this.prevPageBtn, pages > 1);
    this.display(this.nextPageBtn, pages > 1);
    this.display(this.firstPageBtn, pages > 2);
    this.display(this.lastPageBtn, pages > 2);
    this.display(this.back5Btn, pages > PAGE_JUMP);
    this.display(this.fwd5Btn, pages > PAGE_JUMP);

    // Rows
    const canAdd = this.canAdd();
    const inPlaylist = (onLists || onSearch) ? new Set(playlist.map(v => v.link)) : null;
    for (let k = 0; k < this.rows.length; k++) {
      const slot = this.rows[k];
      const i = start + k;
      const v = k < size ? items[i] : null;
      this.display(slot.row, !!v);
      if (!v) continue;
      if (onLists) {
        if (v.kind === 'list') this.fillListRow(slot, v.list, host, canAdd);
        else this.fillListItemRow(slot, v, host, canAdd, inPlaylist);
      }
      else if (onSearch) this.fillSearchRow(slot, v, host, inPlaylist);
      else if (this.karaoke) this.fillSingerRow(slot, v, i, items, host);
      else this.fillPlaylistRow(slot, v, i, player, host);
    }

    let empty = '';
    if (!items.length) {
      if (onLists) empty = "No saved lists. Paste a YouTube playlist or a list of links into Search & Add (or More... > Add by link) and choose Save for Everyone or Save for Me.";
      else if (onSearch) empty = this.karaoke ? 'Search for a song above, or paste a link.' : 'Search YouTube above, or paste a YouTube, Twitch, Vimeo or video link.';
      else if (this.karaoke) empty = host ? 'No singers yet. Use Search to pick a song and join the queue.' : 'No singers yet. Use Search to pick a song and join the queue. Whoever runs the karaoke should take over the player first (More...).';
      else empty = 'The playlist is empty. Use Search to add videos.';
    }
    this.setText(this.emptyLabel, empty);
    this.display(this.emptyLabel, !!empty);
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
        this.setStyle(btn, 'backgroundColor', d.color || '#00838f');
      }
    }
  }

  fillPlaylistRow(slot, v, i, player, host) {
    const isCurrent = player.currentTrack === i;
    const by = v.user && v.user.name ? v.user.name : 'Unknown';
    const votes = player.canVote && !isCurrent ? `(${v.votes || 0}) ` : '';
    this.setStyle(slot.row, 'backgroundColor', isCurrent ? '#3949ab' : (i % 2 === 0 ? '#2a2a33' : '#31313c'));
    this.setText(slot.title, `${i + 1}. ${votes}${v.title || 'Untitled'}`);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setText(slot.sub, `${isCurrent ? 'Now playing - ' : ''}Added by ${by}${dur ? '  -  ' + dur : ''}`);
    this.setThumb(slot, v.thumbnail, v.link);

    const defs = [];
    if (!isCurrent) {
      if (host) defs.push({ text: 'Play', color: '#2e7d32', fn: () => this.send(Commands.SET_TRACK, { index: i, link: v.link }) });
      if (player.canVote) {
        defs.push({ text: 'Vote +', fn: () => this.send(Commands.UP_VOTE, v.link) });
        defs.push({ text: 'Vote -', fn: () => this.send(Commands.DOWN_VOTE, v.link) });
      } else if (host) {
        const len = (player.playlist || []).length;
        if (i > 0) defs.push({ text: 'Up', fn: () => this.send(Commands.MOVE_PLAYLIST_ITEM, { url: v.link, index: i - 1 }) });
        if (i < len - 1) defs.push({ text: 'Down', fn: () => this.send(Commands.MOVE_PLAYLIST_ITEM, { url: v.link, index: i + 1 }) });
        defs.push({ text: 'Remove', color: '#c62828', fn: () => this.send(Commands.REMOVE_PLAYLIST_ITEM, i) });
      }
    }
    this.setButtons(slot, defs.slice(0, 4));
  }

  // Karaoke: one singer in the queue. `s` is { id, name, v: video }.
  fillSingerRow(slot, s, i, singers, host) {
    const me = !!(window.user && s.id === window.user.id);
    const v = s.v || {};
    this.setStyle(slot.row, 'backgroundColor', me ? '#2e4a3a' : (i % 2 === 0 ? '#2a2a33' : '#31313c'));
    this.setText(slot.title, `${i + 1}. ${s.name || 'Someone'}${me ? ' (you)' : ''}`);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setText(slot.sub, `will sing ${v.title || 'a song'}${dur ? '  -  ' + dur : ''}`);
    this.setThumb(slot, v.thumbnail, v.link);

    const defs = [];
    // The host can start any singer; a singer can start themselves when they're up next.
    if (host || (i === 0 && me)) {
      defs.push({ text: 'Play & Sing', color: '#2e7d32', fn: () => this.send(Commands.PLAY_KARAOKE_TRACK, (host && i > 0) ? { userId: s.id } : null) });
    }
    if (host || me) {
      defs.push({ text: me ? 'Remove Me' : 'Remove', color: '#c62828', fn: () => this.send(Commands.REMOVE_FROM_PLAYERS, s.id) });
    }
    if (host) {
      if (i > 0) defs.push({ text: 'Up', fn: () => this.send(Commands.MOVE_SINGER, { userId: s.id, direction: 'up' }) });
      if (i < singers.length - 1) defs.push({ text: 'Down', fn: () => this.send(Commands.MOVE_SINGER, { userId: s.id, direction: 'down' }) });
    }
    this.setButtons(slot, defs.slice(0, 4));
  }

  fillSearchRow(slot, v, host, inPlaylist) {
    const added = !this.karaoke && inPlaylist && inPlaylist.has(v.link);
    this.setStyle(slot.row, 'backgroundColor', added ? '#1b3a2a' : '#2a2a33');
    this.setText(slot.title, v.title || 'Untitled');
    const channel = v.channel && v.channel.name ? v.channel.name : '';
    const dur = typeof v.duration === 'number' && v.duration > 0 ? this.timeCode(v.duration / 1000) : '';
    this.setText(slot.sub, [added ? 'In the playlist' : '', channel, dur].filter(Boolean).join('  -  '));
    this.setThumb(slot, v.thumbnail, v.link);

    if (this.karaoke) {
      this.setButtons(slot, this.isInQueue() ? [] : [{ text: 'Sing It', color: '#2e7d32', fn: () => this.singIt(v) }]);
      return;
    }
    // Adding stays on the results, so several can be added from one search.
    const defs = added || !this.canAdd() ? [] : [{ text: 'Add', fn: () => { this.send(Commands.ADD_TO_PLAYLIST, v); this.setStatus(`Added "${v.title}"`); } }];
    if (host) {
      defs.push({ text: 'Play Now', color: '#2e7d32', fn: () => { this.send(Commands.ADD_AND_PLAY, v); this.setTab('playlist'); } });
      defs.push({ text: 'Play Next', fn: () => { this.send(Commands.ADD_AND_PLAY_NEXT, v); this.setStatus(`"${v.title}" plays next`); } });
    }
    this.setButtons(slot, defs);
  }

  // Lists tab: a saved list. Open shows its videos under it; Add All puts them all at the end of
  // the playlist; Replace (host) makes it the playlist.
  fillListRow(slot, list, host, canAdd) {
    const data = this.listData.get(list.id) || { state: 'none' };
    const open = this.openListId === list.id;
    this.setStyle(slot.row, 'backgroundColor', open ? '#283593' : '#37474f');
    const name = (data.state === 'ready' && data.title) || list.label;
    const tag = list.isDefault ? '  (default)' : list.shared ? '  (shared)' : list.user ? '  (mine)' : '';
    this.setText(slot.title, `${open ? 'v ' : '> '}${name}${tag}`);
    let sub;
    if (data.state === 'loading') sub = 'Loading...';
    else if (data.state === 'error') sub = data.error;
    else if (data.state === 'ready') {
      const n = data.items.length;
      sub = `${n} video${n === 1 ? '' : 's'}${data.truncated ? ' (the first ones)' : ''}${data.skipped ? `, ${data.skipped} skipped` : ''}`;
    } else sub = 'Press Open to see what is in it';
    if (list.shared && list.by) sub += `  -  saved by ${list.by}`;
    this.setText(slot.sub, sub);
    const first = data.state === 'ready' && data.items[0];
    this.setThumb(slot, first ? first.thumbnail : '', first ? first.link : '');

    const defs = [{ text: open ? 'Close' : 'Open', color: '#455a64', fn: () => this.toggleList(list.id) }];
    if (data.state === 'error') defs.push({ text: 'Retry', fn: () => this.requestList(list.id, true) });
    else {
      if (canAdd) defs.push({ text: 'Add All', fn: () => this.appendList(list.id) });
      // A row has 4 buttons: a viewer's own list uses the last two for Share and Remove.
      if (host && !list.user) defs.push({ text: 'Replace', color: '#2e7d32', fn: () => this.replaceWithList(list.id) });
    }
    // Shared lists can be taken out by whoever may add (the host, or anyone while unlocked); a
    // viewer's own list can be shared, or taken out again.
    if (list.shared) {
      if (canAdd) defs.push({ text: 'Remove', color: '#c62828', fn: () => this.unshareList(list) });
    } else if (list.user) {
      if (canAdd && data.state !== 'error') defs.push({ text: 'Share', color: '#6a1b9a', fn: () => this.shareList(list.id) });
      defs.push({ text: 'Remove', color: '#c62828', fn: () => this.removeList(list.id) });
    }
    this.setButtons(slot, defs);
  }

  // Lists tab: one video of the open list.
  fillListItemRow(slot, entry, host, canAdd, inPlaylist) {
    const v = entry.item;
    const added = inPlaylist && inPlaylist.has(v.link);
    this.setStyle(slot.row, 'backgroundColor', entry.index % 2 === 0 ? '#2a2a33' : '#31313c');
    this.setText(slot.title, `    ${entry.index + 1}. ${v.title || 'Untitled'}`);
    const dur = v.duration ? this.timeCode(v.duration / 1000) : '';
    this.setText(slot.sub, [added ? 'In the playlist' : '', this.sourceName(v.link), dur].filter(Boolean).join('  -  '));
    this.setThumb(slot, v.thumbnail, v.link);

    const defs = [];
    if (canAdd && !added) defs.push({ text: 'Add', fn: () => { this.send(Commands.ADD_TO_PLAYLIST, v); this.setStatus(`Added "${v.title}"`); } });
    if (host && added) {
      // Already queued: play it where it is.
      defs.push({ text: 'Play', color: '#2e7d32', fn: () => {
        const p = this.core.player;
        const i = p && p.playlist ? p.playlist.findIndex(x => x.link === v.link) : -1;
        if (i >= 0) this.send(Commands.SET_TRACK, { index: i, link: v.link });
      } });
    } else if (host) {
      defs.push({ text: 'Play Now', color: '#2e7d32', fn: () => { this.send(Commands.ADD_AND_PLAY, v); this.setStatus(`Playing "${v.title}"`); } });
      defs.push({ text: 'Play Next', fn: () => { this.send(Commands.ADD_AND_PLAY_NEXT, v); this.setStatus(`"${v.title}" plays next`); } });
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
    return ({ youtube: 'YouTube', twitch: 'Twitch', twitchclip: 'Twitch clip', vimeo: 'Vimeo', vdoninja: 'VDO.Ninja', hls: 'Stream', mpegts: 'Stream', file: 'File' })[m.type] || '';
  }
};
window.FirePlaylistPanel = FirePlaylistPanel;
