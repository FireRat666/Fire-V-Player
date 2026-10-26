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
var FirePlaylistPanel = class {
  constructor(core) {
    this.core = core;
    this.karaoke = !!core.isKaraoke;
    this.W = 1100;            // panel resolution in pixels
    this.H = 940;
    this.rowsPerPage = 6;
    this.tab = 'playlist';    // 'playlist' (the singer queue in karaoke mode) | 'search'
    this.page = 0;
    this.searchPage = 0;
    this.searchResults = [];
    this.searchQuery = '';
    // Recent searches, kept on this device (like the full playlist page did).
    this.recentKey = `recent${this.karaoke ? 'Karaoke' : 'Playlist'}Searches`;
    this.recentSearches = this.loadRecent();
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

  // The search tab has one row fewer, for the row of search helpers above it.
  pageSize() {
    return this.tab === 'search' ? this.rowsPerPage - 1 : this.rowsPerPage;
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
    this.render();
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
      if (e && e.value != null) onValue(String(e.value));
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
    const nowCard = await this.div(rootEl, {
      display: 'flex', flexDirection: 'column', flexShrink: 0, backgroundColor: '#23232d',
      borderRadius: '14px', paddingLeft: '14px', paddingRight: '14px', paddingTop: '10px', paddingBottom: '12px', marginTop: '8px'
    });
    this.nowTitle = await this.label(nowCard, 'Connecting...', {
      fontSize: '26px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
    });
    const progRow = await this.div(nowCard, { display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '8px' });
    this.timeLabel = await this.label(progRow, '', { fontSize: '20px', color: '#cccccc', width: '190px' });
    const progOuter = await this.div(progRow, { flexGrow: 1, height: '10px', backgroundColor: '#444444', borderRadius: '5px' });
    this.progInner = await this.div(progOuter, { height: '100%', width: '0%', backgroundColor: '#e53935', borderRadius: '5px' });

    // Playback + volume controls
    const controls = await row(rootEl, { marginTop: '6px' });
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

    // ---- Main view: playlist / search
    this.mainView = await this.div(rootEl, { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' });

    const tabs = await row(this.mainView, { marginTop: '6px' });
    this.tabPlaylistBtn = await this.button(tabs, this.karaoke ? 'Singers' : 'Playlist', () => this.setTab('playlist'));
    this.tabSearchBtn = await this.button(tabs, 'Search', () => this.setTab('search'));
    await this.div(tabs, { flexGrow: 1 });
    // Page buttons: first, back 5, back 1, forward 1, forward 5, last.
    const pageBtn = { backgroundColor: GREY, paddingLeft: '12px', paddingRight: '12px' };
    this.firstPageBtn = await this.button(tabs, '|<', () => this.changePage(-Infinity), pageBtn);
    this.back5Btn = await this.button(tabs, '<<', () => this.changePage(-PAGE_JUMP), pageBtn);
    await this.button(tabs, '<', () => this.changePage(-1), pageBtn);
    this.pageLabel = await this.label(tabs, '1 / 1', { fontSize: '20px', width: '100px', textAlign: 'center' });
    await this.button(tabs, '>', () => this.changePage(1), pageBtn);
    this.fwd5Btn = await this.button(tabs, '>>', () => this.changePage(PAGE_JUMP), pageBtn);
    this.lastPageBtn = await this.button(tabs, '>|', () => this.changePage(Infinity), pageBtn);

    this.searchRow = await row(this.mainView, { marginTop: '4px' });
    const searchHint = this.karaoke ? 'Search for a song to sing, or paste a video link' : 'Search YouTube, or paste a YouTube / Twitch / Vimeo / video link';
    this.searchField = await this.textField(this.searchRow, searchHint, v => { this.searchQuery = v; }, () => this.doSearch());
    if (this.searchField) {
      await this.button(this.searchRow, 'Search', () => this.doSearch(), { backgroundColor: '#1565c0' });
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

    // List rows (a fixed pool, re-filled for each page)
    const list = await this.div(this.mainView, { display: 'flex', flexDirection: 'column', flexGrow: 1, marginTop: '6px', overflow: 'hidden' });
    this.rows = [];
    for (let k = 0; k < this.rowsPerPage; k++) {
      const r = await this.div(list, {
        display: 'flex', flexDirection: 'row', alignItems: 'center', height: '84px', flexShrink: 0,
        paddingLeft: '6px', paddingRight: '6px', marginBottom: '6px', borderRadius: '10px', backgroundColor: '#2a2a33'
      });
      const thumb = await this.div(r, { width: '128px', height: '72px', flexShrink: 0, borderRadius: '6px', backgroundColor: '#000000' });
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
      this.rows.push(slot);
    }
    this.emptyLabel = await this.label(list, '', { color: '#bbbbbb', fontSize: '22px', textAlign: 'center', marginTop: '20px' });

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
    await this.label(mineRow, 'These change only your own screen.', { fontSize: '16px', color: '#999999', marginLeft: '8px', flexShrink: 1 });

    // Add by link (in karaoke mode, pasting a link into Search does this)
    const linkSection = this.karaoke ? null : await section('Add by link');
    if (linkSection) {
      const linkRow = await row(linkSection);
      this.linkField = await this.textField(linkRow, 'Video link (YouTube, Twitch, Vimeo, .mp4, .m3u8) or YouTube playlist', v => { this.linkQuery = v; }, () => this.addLink(false));
      if (this.linkField) {
        await this.button(linkRow, 'Add Video', () => this.addLink(false));
        this.loadPlaylistBtn = await this.button(linkRow, 'Load Playlist', () => this.addLink(true), { backgroundColor: '#2e7d32' });
      } else {
        await this.label(linkRow, 'Adding links needs text input, which this client does not have.', { color: '#bbbbbb', flexGrow: 1 });
      }
    }

    // Mode: switches everyone (saved in the space state, see Core.switchMode). Shown to everyone,
    // because the client can't always tell who is a space admin; the server refuses anyone else.
    this.adminSection = await section('Mode (space admins only)');
    const adminRow = await row(this.adminSection, { flexWrap: 'wrap' });
    this.modeLabel = await this.label(adminRow, '', { fontSize: '20px', marginLeft: '4px', marginRight: '12px' });
    this.modeSwitchBtn = await this.button(adminRow, '', () => this.switchMode(), { backgroundColor: '#6a1b9a' });
    this.modeDefaultBtn = await this.button(adminRow, 'Use Snippet Default', () => this.useDefaultMode(), { backgroundColor: GREY });
    await this.label(this.adminSection, 'Only works for space admins (the world owner and community moderators). It switches everyone in the space.', { fontSize: '16px', color: '#999999', marginLeft: '4px', marginTop: '4px', whiteSpace: 'normal' });

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
    [this.tickTimer, this.renderTimer, this.statusTimer, this.searchTimer].forEach(t => { clearTimeout(t); clearInterval(t); });
    this.tickTimer = this.renderTimer = this.statusTimer = this.searchTimer = null;
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
    // Start on the page holding the current track.
    const player = this.core.player;
    if (this.tab === 'playlist' && !this.karaoke && player && typeof player.currentTrack === 'number') {
      this.page = Math.floor(player.currentTrack / this.rowsPerPage);
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
    this.tab = tab;
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

  addLink(asPlaylist) {
    const q = (this.linkQuery || '').trim();
    if (!q) { this.setStatus('Paste a link first.'); return; }
    if (asPlaylist) {
      if (!this.isHost()) { this.setStatus('Only the host can load a playlist.'); return; }
      const id = this.core.getPlaylistId(q);
      if (!id) { this.setStatus('That is not a YouTube playlist link.'); return; }
      this.send(Commands.FROM_PLAYLIST, { id, shouldClear: true, fromPlaylist: true });
      this.setStatus('Loading playlist...');
      return;
    }
    // YouTube, Twitch, Vimeo or a direct video link: the server checks it can be played.
    if (!this.core.getId(q) && !/^https?:\/\//i.test(q)) { this.setStatus('That is not a video link.'); return; }
    this.send(Commands.ADD_TO_PLAYLIST, q);
    this.setStatus('Adding video...');
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

  changePage(delta) {
    const total = this.tab === 'search' ? this.searchResults.length : this.listItems().length;
    const pages = Math.max(1, Math.ceil(total / this.pageSize()));
    if (this.tab === 'search') this.searchPage = Math.min(pages - 1, Math.max(0, this.searchPage + delta));
    else this.page = Math.min(pages - 1, Math.max(0, this.page + delta));
    this.render();
  }

  doSearch() {
    const q = (this.searchQuery || '').trim();
    if (q.length < 2) {
      this.setStatus('Type at least two characters to search.');
      return;
    }
    // A YouTube playlist link or ID replaces the playlist (host only), like the full page.
    if (!this.karaoke && (/[?&]list=/.test(q) || /^PL[A-Za-z0-9_-]{10,}$/.test(q))) {
      const id = this.core.getPlaylistId(q);
      if (id) {
        if (!this.isHost()) { this.setStatus('Only the host can load a playlist.'); return; }
        this.send(Commands.FROM_PLAYLIST, { id, shouldClear: true, fromPlaylist: true });
        this.setStatus('Loading playlist...');
        this.setTab('playlist');
        return;
      }
    }
    this.send(Commands.SEARCH, q);
    this.saveRecent(q);
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

  // ---------------------------------------------------------------- messages

  onMessage(json) {
    const p = this.core.player;
    switch (json.path) {
      case Commands.SEARCH_RESULTS:
        clearInterval(this.searchTimer);
        this.searchTimer = null;
        this.searchResults = Array.isArray(json.data) ? json.data : [];
        console.log(`[PlaylistPanel] Got ${this.searchResults.length} search results.`);
        this.view = 'main';
        this.searchPage = 0;
        this.tab = 'search';
        const n = this.searchResults.length;
        this.setStatus(n ? `${n} result${n === 1 ? '' : 's'}` : 'No results.');
        break;
      case Commands.ERROR: {
        const m = json.data && json.data.message ? json.data.message : (typeof json.data === 'string' ? json.data : "I can't let you do that...");
        // A failed link search sends only an error, so stop the "Searching..." counter so it
        // doesn't overwrite the error. Results that still arrive later are shown as usual.
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
      case Commands.PLAYBACK_UPDATE:
        if (json.data && json.data.type === 'initial-sync' && this.refreshing) {
          this.refreshing = false;
          this.setStatus(this.karaoke ? 'Singer list is up to date.' : 'Playlist is up to date.');
        }
        break;
    }
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
    if (!this.built) return;
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
    this.setText(this.resolutionBtn, `Resolution: ${resW} x ${resH}${this.core.viewerResolution ? '' : ' (default)'}`);
    this.display(this.seekSection, host);
    if (this.loadPlaylistBtn) this.display(this.loadPlaylistBtn, host);
    this.setText(this.notHostLabel, host ? '' : (player.canTakeOver ? 'The host allows take over.' : 'Only the host can use these.'));
    this.display(this.notHostLabel, !host);

    // Mode (space admins only, but shown to everyone)
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
    const onSearch = this.tab === 'search';
    const list = this.listItems();
    this.setText(this.tabPlaylistBtn, `${this.karaoke ? 'Singers' : 'Playlist'} (${list.length})`);
    this.setStyle(this.tabPlaylistBtn, 'backgroundColor', onSearch ? '#455a64' : '#1565c0');
    this.setStyle(this.tabSearchBtn, 'backgroundColor', onSearch ? '#1565c0' : '#455a64');
    this.display(this.searchRow, onSearch);
    this.display(this.searchToolsRow, onSearch && !!this.searchField);
    const recent = this.recentSearches;
    (this.recentBtns || []).forEach((btn, k) => {
      this.display(btn, k < recent.length);
      if (k < recent.length) this.setText(btn, recent[k]);
    });
    this.display(this.recentLabel, recent.length > 0);
    this.display(this.clearRecentBtn, recent.length > 0);

    const items = onSearch ? this.searchResults : list;
    const size = this.pageSize();
    const pages = Math.max(1, Math.ceil(items.length / size));
    if (onSearch) this.searchPage = Math.min(this.searchPage, pages - 1);
    else this.page = Math.min(this.page, pages - 1);
    const page = onSearch ? this.searchPage : this.page;
    this.setText(this.pageLabel, `${page + 1} / ${pages}`);
    // First and last are worth showing from 3 pages, the jumps of 5 only past that.
    this.display(this.firstPageBtn, pages > 2);
    this.display(this.lastPageBtn, pages > 2);
    this.display(this.back5Btn, pages > PAGE_JUMP);
    this.display(this.fwd5Btn, pages > PAGE_JUMP);

    // Rows
    for (let k = 0; k < this.rows.length; k++) {
      const slot = this.rows[k];
      const i = page * size + k;
      const v = k < size ? items[i] : null;
      this.display(slot.row, !!v);
      if (!v) continue;
      if (onSearch) this.fillSearchRow(slot, v, host);
      else if (this.karaoke) this.fillSingerRow(slot, v, i, items, host);
      else this.fillPlaylistRow(slot, v, i, player, host);
    }

    let empty = '';
    if (!items.length) {
      if (onSearch) empty = this.karaoke ? 'Search for a song above, or paste a link.' : 'Search YouTube above, or paste a YouTube, Twitch, Vimeo or video link.';
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
    return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : url;
  }

  setThumb(slot, url, link) {
    url = this.thumbUrl(url, link);
    const safe = url ? String(url).replace(/["\\\n\r]/g, '') : '';
    const value = safe ? `url("${safe}")` : 'none';
    if (!this._changed(slot.thumb, 'backgroundImage', value)) return;
    // Only ever the picture itself: 'none' and then the picture straight after can leave the row
    // blank.
    slot.thumb.SetStyles({ backgroundImage: value });
    if (value !== 'none') this.reapplyThumbsSoon();
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
          const c = this.cache.get(slot.thumb);
          const value = c && c.backgroundImage;
          if (!value || value === 'none') return;
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

  fillSearchRow(slot, v, host) {
    this.setStyle(slot.row, 'backgroundColor', '#2a2a33');
    this.setText(slot.title, v.title || 'Untitled');
    const channel = v.channel && v.channel.name ? v.channel.name : '';
    const dur = typeof v.duration === 'number' && v.duration > 0 ? this.timeCode(v.duration / 1000) : '';
    this.setText(slot.sub, [channel, dur].filter(Boolean).join('  -  '));
    this.setThumb(slot, v.thumbnail, v.link);

    if (this.karaoke) {
      this.setButtons(slot, this.isInQueue() ? [] : [{ text: 'Sing It', color: '#2e7d32', fn: () => this.singIt(v) }]);
      return;
    }
    const defs = [{ text: 'Add', fn: () => { this.send(Commands.ADD_TO_PLAYLIST, v); this.setStatus(`Added "${v.title}"`); } }];
    if (host) {
      defs.push({ text: 'Play Now', color: '#2e7d32', fn: () => { this.send(Commands.ADD_AND_PLAY, v); this.setTab('playlist'); } });
      defs.push({ text: 'Play Next', fn: () => { this.send(Commands.ADD_AND_PLAY_NEXT, v); this.setStatus(`"${v.title}" plays next`); } });
    }
    this.setButtons(slot, defs);
  }
};
window.FirePlaylistPanel = FirePlaylistPanel;
