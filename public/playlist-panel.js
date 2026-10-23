// In-world playlist panel, built with the SDK's UI system (Unity UI Toolkit underneath).
//
// The new SideQuest/Altspace client may not open 2D "menu browser" pages, so this panel gives
// every user playback controls, the playlist and YouTube search inside the world. It shares the
// in-world script's websocket (core.ws); the server already sends that socket every playlist
// update, and replies to searches on the socket that asked.
//
// Each user gets their own local panel. It sits beside the screen and is shown/hidden by the
// playlist button. It hides by moving out of view, because deactivating a UI Toolkit document
// can drop the elements created at runtime.
var FirePlaylistPanel = class {
  constructor(core) {
    this.core = core;
    this.W = 1100;            // panel resolution in pixels
    this.H = 940;
    this.rowsPerPage = 6;
    this.tab = 'playlist';    // 'playlist' | 'search'
    this.page = 0;
    this.searchPage = 0;
    this.searchResults = [];
    this.searchQuery = '';
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
    core.addMessageListener(msg => this.onMessage(msg));
  }

  // ---------------------------------------------------------------- helpers

  vec3(str, def) {
    const p = String(str || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (p.length === 1 && !isNaN(p[0])) return [p[0], p[0], p[0]];
    return (p.length >= 3 && !p.slice(0, 3).some(isNaN)) ? p.slice(0, 3) : def;
  }
  // The legacy A-Frame bridge mirrors Z, so convert A-Frame values the same way it does.
  toUnityPos([x, y, z]) { return new BS.Vector3(x, y, -z); }
  toUnityEuler([x, y, z]) { return new BS.Vector3(-x, -y, z); }

  isHost() {
    const p = this.core.player;
    return !!(p && p.host && window.user && p.host.id === window.user.id);
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

  setStatus(text, ms = 4000) {
    if (!this.statusLabel) return;
    this.setText(this.statusLabel, text);
    clearTimeout(this.statusTimer);
    if (ms) this.statusTimer = setTimeout(() => this.setText(this.statusLabel, ''), ms);
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
      backgroundColor: '#00838f', color: '#ffffff', fontSize: '20px',
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
    field.SetStyles({ flexGrow: 1, fontSize: '22px', height: '48px', marginRight: '6px' });
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

  build() {
    if (!this.buildPromise) {
      this.buildPromise = this._build().catch(e => {
        console.error('[PlaylistPanel] Failed to build the in-world playlist panel, the Playlist button will try the menu page instead:', e);
        this.failed = true;
      });
    }
    return this.buildPromise;
  }

  async _build() {
    const p = this.core.params;
    const screenPos = this.vec3(p.position, [0, 0, 0]);
    const screenRot = this.vec3(p.rotation, [0, 0, 0]);
    const screenScale = this.vec3(p.scale, [1, 1, 1]);
    const panelScale = parseFloat(p['playlist-panel-scale']) || 1;
    const panelWidthM = 1.4 * panelScale;
    // The screen is 1 unit wide at scale 1, so put the panel just past its right edge.
    const offset = this.vec3(p['playlist-panel-offset'], [screenScale[0] * 0.5 + 0.1 + panelWidthM * 0.5, 0, 0.15]);
    const rot = this.vec3(p['playlist-panel-rotation'], [0, -20, 0]);

    console.log('[PlaylistPanel] Building...');
    this.root = await this.withTimeout(new BS.GameObject({
      name: 'FireVPlayer_PlaylistRoot',
      localPosition: this.toUnityPos(screenPos),
      localEulerAngles: this.toUnityEuler(screenRot)
    }).Async(), 15000, 'Creating the panel root object');

    this.shownPos = this.toUnityPos(offset);
    this.hiddenPos = new BS.Vector3(this.shownPos.x, this.shownPos.y - 1000, this.shownPos.z);
    const s = panelWidthM / (this.W / 100); // a panel is 100 pixels per metre
    this.panelObj = await this.withTimeout(new BS.GameObject({
      name: 'FireVPlayer_PlaylistPanel',
      parent: this.root,
      localPosition: this.hiddenPos,
      localEulerAngles: this.toUnityEuler(rot),
      localScale: new BS.Vector3(s, s, s)
    }).Async(), 15000, 'Creating the panel object');

    const UIClass = BS.UI || BS.BanterUI;
    const ui = new UIClass(new BS.Vector2(this.W, this.H), false);
    this.ui = (await this.withTimeout(this.panelObj.AddComponent(ui), 15000, 'Adding the UI panel component')) || ui;
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
    await this.label(header, 'Fire-V-Player', { fontSize: '30px', fontWeight: 'bold', flexGrow: 1 });
    this.hostLabel = await this.label(header, '', { fontSize: '20px', color: '#bbbbbb', marginRight: '12px' });
    this.moreBtn = await this.button(header, 'More...', () => this.setView(this.view === 'more' ? 'main' : 'more'), { backgroundColor: GREY });
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
    this.tabPlaylistBtn = await this.button(tabs, 'Playlist', () => this.setTab('playlist'));
    this.tabSearchBtn = await this.button(tabs, 'Search', () => this.setTab('search'));
    await this.div(tabs, { flexGrow: 1 });
    await this.button(tabs, '<', () => this.changePage(-1), { backgroundColor: GREY });
    this.pageLabel = await this.label(tabs, '1 / 1', { fontSize: '20px', width: '100px', textAlign: 'center' });
    await this.button(tabs, '>', () => this.changePage(1), { backgroundColor: GREY });

    this.searchRow = await row(this.mainView, { marginTop: '4px' });
    this.searchField = await this.textField(this.searchRow, 'Search YouTube, or paste a video / playlist link', v => { this.searchQuery = v; }, () => this.doSearch());
    if (this.searchField) {
      await this.button(this.searchRow, 'Search', () => this.doSearch(), { backgroundColor: '#1565c0' });
    } else {
      await this.label(this.searchRow, 'Search needs the full page: use More... > Open full page.', { color: '#bbbbbb', flexGrow: 1 });
    }

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
    this.votingBtn = await this.button(hostRow, 'Voting: Off', () => this.send(Commands.TOGGLE_VOTE));
    this.clearBtn = await this.button(hostRow, 'Clear Playlist', () => this.send(Commands.CLEAR_PLAYLIST), { backgroundColor: '#c62828' });
    this.loadDefaultBtn = await this.button(hostRow, 'Load Default Playlist', () => {
      this.send(Commands.FROM_PLAYLIST, { id: this.core.params.playlist, shouldClear: true, fromPlaylist: true });
      this.setStatus('Loading playlist...');
    }, { backgroundColor: '#2e7d32' });
    this.notHostLabel = await this.label(this.hostSection, '', { fontSize: '18px', color: '#999999', marginLeft: '4px', marginTop: '4px' });

    // Seek (host)
    this.seekSection = await section('Seek (moves everyone)');
    const seekRow = await row(this.seekSection);
    this.seekField = await this.textField(seekRow, 'Time, e.g. 95 or 1:35', v => { this.seekQuery = v; }, () => this.doSeek());
    if (this.seekField) {
      this.seekField.SetStyles({ flexGrow: 0, width: '300px' });
      await this.button(seekRow, 'Seek', () => this.doSeek(), { backgroundColor: '#1565c0' });
    }
    await this.button(seekRow, '-30s', () => this.seekBy(-30), { backgroundColor: GREY });
    await this.button(seekRow, '+30s', () => this.seekBy(30), { backgroundColor: GREY });

    // Your own player
    const mineSection = await section('Your player only');
    const mineRow = await row(mineSection);
    await this.button(mineRow, '<< Skip', () => this.send(Commands.LOCAL_SKIP_BACK));
    await this.button(mineRow, 'Skip >>', () => this.send(Commands.LOCAL_SKIP_FORWARD));
    this.autoSyncBtn = await this.button(mineRow, 'Auto Sync: Off', () => {
      this.autoSync = !this.autoSync;
      this.send(Commands.AUTO_SYNC, this.autoSync);
      this.render();
    });
    await this.label(mineRow, 'Nudges only your copy, e.g. if it drifts.', { fontSize: '16px', color: '#999999', marginLeft: '8px', flexShrink: 1 });

    // Add by link
    const linkSection = await section('Add by link');
    const linkRow = await row(linkSection);
    this.linkField = await this.textField(linkRow, 'YouTube video or playlist link', v => { this.linkQuery = v; }, () => this.addLink(false));
    if (this.linkField) {
      await this.button(linkRow, 'Add Video', () => this.addLink(false));
      this.loadPlaylistBtn = await this.button(linkRow, 'Load Playlist', () => this.addLink(true), { backgroundColor: '#2e7d32' });
    } else {
      await this.label(linkRow, 'Paste links on the full page.', { color: '#bbbbbb', flexGrow: 1 });
    }

    const pageRow = await row(this.moreView, { marginTop: '2px' });
    await this.div(pageRow, { flexGrow: 1 });
    await this.button(pageRow, 'Open full page', () => {
      if (!this.core.openPlaylistPage()) this.setStatus('The full page is not available in this client.');
    }, { backgroundColor: GREY, fontSize: '18px' });

    // Footer
    const footer = await row(rootEl, { marginTop: '4px' });
    this.statusLabel = await this.label(footer, '', { fontSize: '20px', color: '#ffcc66', flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });

    this.built = true;
    this.render();
    console.log('[PlaylistPanel] Ready.');
  }

  // ---------------------------------------------------------------- show / hide

  async toggle() {
    if (!this.built && !this.failed) console.log('[PlaylistPanel] Still building, will open when ready.');
    await this.build();
    if (this.failed) {
      this.core.openPlaylistPage();
      return;
    }
    if (this.visible) await this.close();
    else await this.open();
  }

  async moveTo(pos) {
    const o = this.panelObj;
    if (!o) return;
    if (typeof o.SetLocalPosition === 'function') await o.SetLocalPosition(pos);
    else if (o.transform) o.transform.localPosition = pos;
  }

  async open() {
    this.visible = true;
    // Start on the page holding the current track.
    const player = this.core.player;
    if (this.tab === 'playlist' && player && typeof player.currentTrack === 'number') {
      this.page = Math.floor(player.currentTrack / this.rowsPerPage);
    }
    this.render();
    await this.moveTo(this.shownPos);
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.updateTime(), 1000);
  }

  async close() {
    this.visible = false;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.moveTo(this.hiddenPos);
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
    if (!p || !p.duration) return;
    const t = Math.max(0, Math.min(p.duration, this.currentPlaybackTime() + delta));
    this.send(Commands.SET_TIME, t);
  }

  addLink(asPlaylist) {
    const q = (this.linkQuery || '').trim();
    if (!q) { this.setStatus('Paste a YouTube link first.'); return; }
    if (asPlaylist) {
      if (!this.isHost()) { this.setStatus('Only the host can load a playlist.'); return; }
      const id = this.core.getPlaylistId(q);
      if (!id) { this.setStatus('That is not a YouTube playlist link.'); return; }
      this.send(Commands.FROM_PLAYLIST, { id, shouldClear: true, fromPlaylist: true });
      this.setStatus('Loading playlist...');
      return;
    }
    if (!this.core.getId(q)) { this.setStatus('That is not a YouTube video link.'); return; }
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
    const total = this.tab === 'search' ? this.searchResults.length : ((this.core.player && this.core.player.playlist) || []).length;
    const pages = Math.max(1, Math.ceil(total / this.rowsPerPage));
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
    if (/[?&]list=/.test(q) || /^PL[A-Za-z0-9_-]{10,}$/.test(q)) {
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
    console.log(`[PlaylistPanel] Searching for "${q}"...`);
    this.setStatus('Searching...', 0);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      console.warn('[PlaylistPanel] No search results from the server after 25s.');
      this.setStatus('No reply from the server for that search. Try again.');
    }, 25000);
    this.tab = 'search';
    this.render();
  }

  // ---------------------------------------------------------------- messages

  onMessage(json) {
    const p = this.core.player;
    switch (json.path) {
      case Commands.SEARCH_RESULTS:
        clearTimeout(this.searchTimer);
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
    if (!p || !p.playlist || !p.playlist.length || !p.duration) {
      this.setText(this.timeLabel, '');
      this.setStyle(this.progInner, 'width', '0%');
      return;
    }
    const duration = p.duration;
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
    this.setText(this.nowTitle, current ? current.title : (player.host ? 'Nothing playing' : 'Connecting...'));
    this.updateTime();

    // Controls
    this.display(this.prevTrackBtn, host && playlist.length > 1);
    this.display(this.nextTrackBtn, host && playlist.length > 1);
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
    this.display(this.seekSection, host);
    if (this.loadPlaylistBtn) this.display(this.loadPlaylistBtn, host);
    this.setText(this.notHostLabel, host ? '' : (player.canTakeOver ? 'The host allows take over.' : 'Only the host can use these.'));
    this.display(this.notHostLabel, !host);

    // Host controls
    this.display(this.lockBtn, host);
    this.setText(this.lockBtn, player.locked ? 'Unlock' : 'Lock');
    this.setStyle(this.lockBtn, 'backgroundColor', player.locked ? '#00838f' : '#c62828');
    this.display(this.takeOverBtn, host || !!player.canTakeOver);
    this.setText(this.takeOverBtn, player.canTakeOver ? (host ? 'Take Over: On' : 'Take Over') : 'Take Over: Off');
    this.setStyle(this.takeOverBtn, 'backgroundColor', player.canTakeOver ? (host ? '#c62828' : '#2e7d32') : '#00838f');
    this.display(this.votingBtn, host);
    this.setText(this.votingBtn, player.canVote ? 'Voting: On' : 'Voting: Off');
    this.display(this.clearBtn, host && hasPlaylist);
    this.display(this.loadDefaultBtn, host && !hasPlaylist && !!this.core.params.playlist);

    // Tabs
    const onSearch = this.tab === 'search';
    this.setText(this.tabPlaylistBtn, `Playlist (${playlist.length})`);
    this.setStyle(this.tabPlaylistBtn, 'backgroundColor', onSearch ? '#455a64' : '#1565c0');
    this.setStyle(this.tabSearchBtn, 'backgroundColor', onSearch ? '#1565c0' : '#455a64');
    this.display(this.searchRow, onSearch);

    const items = onSearch ? this.searchResults : playlist;
    const pages = Math.max(1, Math.ceil(items.length / this.rowsPerPage));
    if (onSearch) this.searchPage = Math.min(this.searchPage, pages - 1);
    else this.page = Math.min(this.page, pages - 1);
    const page = onSearch ? this.searchPage : this.page;
    this.setText(this.pageLabel, `${page + 1} / ${pages}`);

    // Rows
    for (let k = 0; k < this.rows.length; k++) {
      const slot = this.rows[k];
      const i = page * this.rowsPerPage + k;
      const v = items[i];
      this.display(slot.row, !!v);
      if (!v) continue;
      if (onSearch) this.fillSearchRow(slot, v, host);
      else this.fillPlaylistRow(slot, v, i, player, host);
    }

    let empty = '';
    if (!items.length) empty = onSearch ? 'Search YouTube above, or paste a link.' : 'The playlist is empty. Use Search to add videos.';
    this.setText(this.emptyLabel, empty);
    this.display(this.emptyLabel, !!empty);
  }

  setThumb(slot, url) {
    const safe = url ? String(url).replace(/["\\\n\r]/g, '') : '';
    this.setStyle(slot.thumb, 'backgroundImage', safe ? `url("${safe}")` : 'none');
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
    this.setThumb(slot, v.thumbnail);

    const defs = [];
    if (!isCurrent) {
      if (host) defs.push({ text: 'Play', color: '#2e7d32', fn: () => this.send(Commands.SET_TRACK, i) });
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

  fillSearchRow(slot, v, host) {
    this.setStyle(slot.row, 'backgroundColor', '#2a2a33');
    this.setText(slot.title, v.title || 'Untitled');
    const channel = v.channel && v.channel.name ? v.channel.name : '';
    const dur = typeof v.duration === 'number' && v.duration > 0 ? this.timeCode(v.duration / 1000) : '';
    this.setText(slot.sub, [channel, dur].filter(Boolean).join('  -  '));
    this.setThumb(slot, v.thumbnail);

    const defs = [{ text: 'Add', fn: () => { this.send(Commands.ADD_TO_PLAYLIST, v); this.setStatus(`Added "${v.title}"`); } }];
    if (host) {
      defs.push({ text: 'Play Now', color: '#2e7d32', fn: () => { this.send(Commands.ADD_AND_PLAY, v); this.setTab('playlist'); } });
      defs.push({ text: 'Play Next', fn: () => { this.send(Commands.ADD_AND_PLAY_NEXT, v); this.setStatus(`"${v.title}" plays next`); } });
    }
    this.setButtons(slot, defs);
  }
};
window.FirePlaylistPanel = FirePlaylistPanel;
