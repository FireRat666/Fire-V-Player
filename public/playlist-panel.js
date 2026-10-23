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

  async ready(el) {
    if (el && typeof el.Async === 'function') {
      try { await el.Async(); } catch (_) {}
    }
    return el;
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

  // ---------------------------------------------------------------- build

  build() {
    if (!this.buildPromise) {
      this.buildPromise = this._build().catch(e => {
        console.error('[PlaylistPanel] Failed to build the in-world playlist panel:', e);
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

    this.root = await new BS.GameObject({
      name: 'FireVPlayer_PlaylistRoot',
      localPosition: this.toUnityPos(screenPos),
      localEulerAngles: this.toUnityEuler(screenRot)
    }).Async();

    this.shownPos = this.toUnityPos(offset);
    this.hiddenPos = new BS.Vector3(this.shownPos.x, this.shownPos.y - 1000, this.shownPos.z);
    const s = panelWidthM / (this.W / 100); // a panel is 100 pixels per metre
    this.panelObj = await new BS.GameObject({
      name: 'FireVPlayer_PlaylistPanel',
      parent: this.root,
      localPosition: this.hiddenPos,
      localEulerAngles: this.toUnityEuler(rot),
      localScale: new BS.Vector3(s, s, s)
    }).Async();

    const UIClass = BS.UI || BS.BanterUI;
    const ui = new UIClass(new BS.Vector2(this.W, this.H), false);
    this.ui = (await this.panelObj.AddComponent(ui)) || ui;
    if (typeof this.ui.SetBackgroundColor === 'function') {
      this.ui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
    }

    const rootEl = await this.div(undefined, {
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      backgroundColor: 'rgba(18, 18, 24, 0.96)', borderRadius: '24px',
      borderWidth: '3px', borderColor: '#555555',
      paddingLeft: '18px', paddingRight: '18px', paddingTop: '14px', paddingBottom: '14px'
    });
    const row = (styles) => this.div(rootEl, Object.assign({ display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0 }, styles || {}));

    // Header
    const header = await row();
    await this.label(header, 'Fire-V-Player', { fontSize: '30px', fontWeight: 'bold', flexGrow: 1 });
    this.hostLabel = await this.label(header, '', { fontSize: '20px', color: '#bbbbbb', marginRight: '12px' });
    await this.button(header, 'Close', () => this.close(), { backgroundColor: '#455a64' });

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
    const controls = await row({ marginTop: '6px' });
    this.prevTrackBtn = await this.button(controls, 'Prev', () => this.changeTrack(-1));
    this.rewBtn = await this.button(controls, '<< Skip', () => this.core.back());
    this.pauseBtn = await this.button(controls, 'Pause', () => this.send(Commands.TOGGLE_PAUSE));
    this.ffBtn = await this.button(controls, 'Skip >>', () => this.core.forward());
    this.nextTrackBtn = await this.button(controls, 'Next', () => this.changeTrack(1));
    await this.div(controls, { flexGrow: 1 });
    await this.button(controls, 'Vol -', () => { this.core.volume(false); this.renderSoon(); }, { backgroundColor: '#455a64' });
    this.volLabel = await this.label(controls, '', { fontSize: '20px', width: '110px', textAlign: 'center' });
    await this.button(controls, 'Vol +', () => { this.core.volume(true); this.renderSoon(); }, { backgroundColor: '#455a64' });
    this.muteBtn = await this.button(controls, 'Mute', () => { this.core.mute(); this.renderSoon(); }, { backgroundColor: '#455a64' });

    // Host controls
    this.hostRow = await row({ marginTop: '2px' });
    this.lockBtn = await this.button(this.hostRow, 'Lock', () => {
      if (this.core.player) this.send(Commands.TOGGLE_LOCK, !this.core.player.locked);
    });
    this.takeOverBtn = await this.button(this.hostRow, 'Take Over', () => {
      const player = this.core.player;
      if (!player) return;
      if (this.isHost()) this.send(Commands.TOGGLE_CAN_TAKE_OVER, !player.canTakeOver);
      else this.send(Commands.TAKE_OVER);
    });
    this.votingBtn = await this.button(this.hostRow, 'Voting: Off', () => this.send(Commands.TOGGLE_VOTE));
    this.clearBtn = await this.button(this.hostRow, 'Clear', () => this.send(Commands.CLEAR_PLAYLIST), { backgroundColor: '#c62828' });
    this.loadDefaultBtn = await this.button(this.hostRow, 'Load Default Playlist', () => {
      this.send(Commands.FROM_PLAYLIST, { id: this.core.params.playlist, shouldClear: true, fromPlaylist: true });
      this.setStatus('Loading playlist...');
    }, { backgroundColor: '#2e7d32' });

    // Tabs + paging
    const tabs = await row({ marginTop: '6px' });
    this.tabPlaylistBtn = await this.button(tabs, 'Playlist', () => this.setTab('playlist'));
    this.tabSearchBtn = await this.button(tabs, 'Search', () => this.setTab('search'));
    await this.div(tabs, { flexGrow: 1 });
    await this.button(tabs, '<', () => this.changePage(-1), { backgroundColor: '#455a64' });
    this.pageLabel = await this.label(tabs, '1 / 1', { fontSize: '20px', width: '100px', textAlign: 'center' });
    await this.button(tabs, '>', () => this.changePage(1), { backgroundColor: '#455a64' });

    // Search bar
    this.searchRow = await row({ marginTop: '4px' });
    if (BS.UITextField) {
      this.searchField = await this.ready(new BS.UITextField(this.ui, this.searchRow));
      try { this.searchField.placeholder = 'Search YouTube, or paste a video / playlist link'; } catch (_) {}
      this.searchField.SetStyles({ flexGrow: 1, fontSize: '22px', height: '48px', marginRight: '6px' });
      this.searchField.OnChange(e => {
        if (e && e.value != null) this.searchQuery = String(e.value);
      });
      if (typeof this.searchField.OnKeyDown === 'function') {
        this.searchField.OnKeyDown(e => {
          if (e && (e.key === 'Enter' || e.key === '\n' || e.key === '\r' || e.keyCode === 13)) this.doSearch();
        });
      }
      await this.button(this.searchRow, 'Search', () => this.doSearch(), { backgroundColor: '#1565c0' });
    } else {
      await this.label(this.searchRow, 'Search needs the full page: use "Open full page" below.', { color: '#bbbbbb', flexGrow: 1 });
    }

    // List rows (a fixed pool, re-filled for each page)
    const list = await this.div(rootEl, { display: 'flex', flexDirection: 'column', flexGrow: 1, marginTop: '6px', overflow: 'hidden' });
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

    // Footer
    const footer = await row({ marginTop: '4px' });
    this.statusLabel = await this.label(footer, '', { fontSize: '20px', color: '#ffcc66', flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    await this.button(footer, 'Open full page', () => {
      if (!this.core.openPlaylistPage()) this.setStatus('The full page is not available in this client.');
    }, { backgroundColor: '#455a64', fontSize: '18px' });

    this.built = true;
    this.render();
    console.log('[PlaylistPanel] Ready.');
  }

  // ---------------------------------------------------------------- show / hide

  async toggle() {
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
    this.setStatus('Searching...', 0);
    this.tab = 'search';
    this.render();
  }

  // ---------------------------------------------------------------- messages

  onMessage(json) {
    const p = this.core.player;
    switch (json.path) {
      case Commands.SEARCH_RESULTS:
        this.searchResults = Array.isArray(json.data) ? json.data : [];
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
        if (json.data && json.data.original) {
          this.setStatus(`A user can't watch "${json.data.original.title}". Use the full page to replace it.`, 10000);
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
    this.display(this.hostRow, host || !!player.canTakeOver);

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
