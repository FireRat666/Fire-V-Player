const { WebSocket } = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const Youtube = require('./youtube/scraper.js');
const youtube = new Youtube();
const ytfps = require('ytfps');
const fetch = require('node-fetch');
const Commands = require('../public/commands.js');
const { Pool } = require('pg');
const test =1;

class App{
  constructor() {
    this.videoPlayers = {};
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's Hobby plan requires SSL, but does not verify the certificate
      ssl: process.env.DATABASE_URL ? {
        rejectUnauthorized: false
      } : false
    });
    this.setupDatabase();
    this.setupWebserver();
    setInterval(() => this.syncTime(), 1000);
    this.syncTime();
    // Periodically save all player states as a fallback
    setInterval(() => this.saveAllPlayerStates(), 30000);
  }
  async setupDatabase() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS player_state (
          instance_id TEXT PRIMARY KEY,
          player_data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      console.log('Database table "player_state" is ready.');
    } catch (err) {
      console.error('Error creating database table:', err);
    } finally {
      client.release();
    }
  }
  async savePlayerState(instanceId) {
    const player = this.videoPlayers[instanceId];
    if (!player) return;

    // Create a clean, serializable object for storage.
    // We don't want to save sockets, intervals, timeouts, or the host object.
    const stateToSave = {
      playlist: player.playlist,
      currentTrack: player.currentTrack,
      lastStartTime: player.lastStartTime,
      locked: player.locked,
      canTakeOver: player.canTakeOver,
      canVote: player.canVote,
      // We don't save votes directly as they are tied to connected sockets.
      // We also don't save the host, as the first person to connect becomes the new host.
    };

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO player_state (instance_id, player_data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (instance_id) DO UPDATE
         SET player_data = EXCLUDED.player_data, updated_at = NOW();`,
        [instanceId, stateToSave]
      );
    } catch (err) {
      console.error(`Error saving state for instance ${instanceId}:`, err);
    } finally {
      client.release();
    }
  }
  async saveAllPlayerStates() {
    const instances = Object.keys(this.videoPlayers);
    for (const instanceId of instances) {
      await this.savePlayerState(instanceId);
    }
  }
  setupWebserver() { 
    this.app = express();
    this.server = http.createServer( this.app ); 
    this.wss = new WebSocket.Server({ noServer: true }); 
    this.server.on('upgrade', (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      }); 
    });

    const interval = setInterval(() => {
      this.wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('connection', async (ws, req) => {
      ws.t = new Date().getTime();
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('message', async msg => { 
        try{
          if(msg !== "keepalive") {
            await this.parseMessage(JSON.parse(msg), ws);
          }else{
            console.log(msg)
          }
        }catch(e) {
          console.log("parse error: ", e, msg);
        }
      });
      ws.on('close', (code, reason) => {
        this.handleClose(ws);
      });
    });

    this.server.on('close', () => {
      clearInterval(interval);
    });
    this.app.use(express.static(path.join(__dirname, '..', 'public')));
    const port = process.env.PORT || 3000;
    this.server.listen( port, function listening(){
        console.log("Video Player started."); 
    });
  }
  handleClose(ws) {
    console.log(ws.u ? ws.u.name : 'Unknown', 'disconnected.', ws.type);
    Object.keys(this.videoPlayers).forEach(key => {
      const videoPlayer = this.videoPlayers[key];
      if(ws.u && videoPlayer.host.id === ws.u.id && ws.type === "space") {
        console.log(ws.u.name ? ws.u.name : 'Unknown', 'user was host, enabling takeOver in 42 secs');
        videoPlayer.hostConnected = false;
        videoPlayer.takeoverTimeout = setTimeout(async ()=>{
          if(!videoPlayer.hostConnected) {
            console.log(ws.u.name ? ws.u.name : 'Unknown', 'takeover enabled after 42 secs');
            videoPlayer.canTakeOver = true;
            this.updateClients(key);
            await this.savePlayerState(key);
          }
        }, 1000 * 42);
      }
      videoPlayer.sockets = videoPlayer.sockets.filter(_ws => _ws !== ws);
      videoPlayer.votes = videoPlayer.votes.filter(v => v !== ws);
      this.updateVotes(ws);
      this.updateClients(ws.i);
    });
  } 
  send(socket, path, data) {
     const payload = JSON.stringify({path, data});
     console.log(`[SEND] user: ${socket.u ? socket.u.name : 'N/A'}, instance: ${socket.i || 'N/A'}, type: ${socket.type || 'N/A'}, path: ${path}, payload_size: ${payload.length}`);
     socket.send(payload);
  }
  async parseMessage(msg, ws){
    console.log(`[RECV] user: ${ws.u ? ws.u.name : 'N/A'}, instance: ${ws.i || 'N/A'}, type: ${ws.type || 'N/A'}, path: ${msg.path}`);
    switch(msg.path) {
      case Commands.INSTANCE:
        if(msg.u) { 
          ws.u = msg.u;
          ws.i = msg.data;
          await this.createVideoPlayer(msg.data, msg.u, ws);
          console.log(msg.u.name, 'connected', msg.data, "host: ", this.videoPlayers[msg.data].host.name);
          this.getUserVideoPlayer(ws);
          if(this.videoPlayers[msg.data].host && this.videoPlayers[msg.data].host.id === msg.u.id) {
            clearTimeout(this.videoPlayers[msg.data].takeoverTimeout);
            this.videoPlayers[msg.data].hostConnected = true;
            console.log(ws.u.name ? ws.u.name : 'Unknown', 'user returned, takeover not enabled');
          }
        }else{
          this.send(ws, 'error');
        }
        break;
      case Commands.MEASURE_LATENCY:
        this.measureLatency(ws);
        break;
      case Commands.SET_WS_TYPE:
        ws.type = msg.data;
        break;
      case Commands.SET_TIME:
        await this.setVideoTime(msg.data, ws);
        break;
      case Commands.SET_TRACK:
        await this.setVideoTrack(msg.data, ws);
        break;
      case Commands.TOGGLE_LOCK:
        await this.toggleLock(msg.data, ws);
        break;
      case Commands.TOGGLE_CAN_TAKE_OVER:
        await this.toggleCanTakeOver(msg.data, ws);
        break;
      case Commands.TAKE_OVER:
        await this.takeOver(ws);
        break;
      case Commands.ADD_TO_PLAYLIST:
        await this.addToPlaylist(msg.data, msg.skipUpdate, msg.isYoutubeWebsite, ws);
        break;
      case Commands.MOVE_PLAYLIST_ITEM:
        await this.movePlaylistItem(msg.data, ws);
        break;
      case Commands.REMOVE_PLAYLIST_ITEM:
        await this.removePlaylistItem(msg.data, ws);
        break;
      case Commands.SEARCH:
        this.search(msg.data, ws);
        break;
      case Commands.FROM_PLAYLIST:
        await this.fromPlaylist(msg.data, ws);
        break;
      case Commands.CLEAR_PLAYLIST:
        await this.clearPlaylist(msg.skipUpdate, ws);
        break;
      case Commands.USER_VIDEO_PLAYER:
        ws.is_video_player = true;
        this.setUserVideoPlayer(msg.data, ws);
        break;
      case Commands.STOP:
        this.stop(ws);
        break;
      case Commands.AUTO_SYNC:
        this.setAutoSync(msg.data, ws);
        break;
      case Commands.CLICK_BROWSER:
        this.sendBrowserClick(msg.data, ws)
        break;
      case Commands.TOGGLE_VOTE:
        await this.toggleVote(ws)
        break; 
      case Commands.DOWN_VOTE:
        this.setVote(msg.data, true, ws);
        break;
      case Commands.UP_VOTE:
        this.setVote(msg.data, false, ws);
        break;
      case Commands.ADD_TO_PLAYERS:
        this.addToPlayers(msg.data, ws);
        break;
      case Commands.REMOVE_FROM_PLAYERS:
        this.removeFromPlayers(msg.data, ws);
        break; 
    }
  } 
  measureLatency(ws) {
    this.send(ws, Commands.MEASURE_LATENCY);
  }
  removeFromPlayers(uid, ws) {
    this.onlyIfHost(ws, () => {
      this.videoPlayers[ws.i].sockets.forEach(s => {
        if(s.u.id === uid) {
          s.p = false;
        }
      })
    }, uid !== ws.u.id);
    this.updateClients(ws.i, "remove-from-players");
  }
  stop(ws) {
    this.onlyIfHost(ws, () => {
      this.updateClients(ws.i, "stop");
    }, this.videoPlayers[ws.i].locked);
  }
  setAutoSync(autoSync, ws) {
    if(ws.user_video) {
      this.send(ws.user_video, Commands.AUTO_SYNC, autoSync);
    }
  }
  addToPlayers(video, ws){
    this.videoPlayers[ws.i].sockets.forEach(s => {
      if(s.u.id === ws.u.id) {
        s.p = new Date().getTime();
        s.p_v = video;
      }
    });
    this.updateClients(ws.i, "add-to-players");
  }
  async toggleVote(ws) {
    if(this.videoPlayers[ws.i]) {
      this.onlyIfHost(ws, async () => {
        this.videoPlayers[ws.i].canVote = !this.videoPlayers[ws.i].canVote;
        if(this.videoPlayers[ws.i].canVote && this.videoPlayers[ws.i].playlist.length) {
          this.videoPlayers[ws.i].playlist[this.videoPlayers[ws.i].currentTrack].votes = 9999999;
          this.updateVotes(ws);
        }
        this.updateClients(ws.i);
        await this.savePlayerState(ws.i);
      });
    }
  } 
  sendBrowserClick(click, video_ws) {
    if(this.videoPlayers[video_ws.i]) {
      this.videoPlayers[video_ws.i].sockets.forEach(ws => {
        if(video_ws.u.id === ws.u.id && !ws.is_video_player){
          this.send(ws, Commands.CLICK_BROWSER, click);
        }
      });
    }
  }
  getUserVideoPlayer(new_ws) {
    if(this.videoPlayers[new_ws.i]) {
      this.videoPlayers[new_ws.i].sockets.forEach(ws => {
        if(ws.is_video_player) {
          this.setUserVideoPlayer(new_ws.u, ws);
        }
      });
    }
  }
  setUserVideoPlayer(data, user_video) {
    if(this.videoPlayers[user_video.i]) {
      this.videoPlayers[user_video.i].sockets.forEach(ws => {
        if(ws.u && ws.u.id === user_video.u.id) {
          ws.user_video = user_video;
        }
      });
    }
  }
  updateVotes(ws) {
    if(this.videoPlayers[ws.i] && this.videoPlayers[ws.i].canVote) {
      this.videoPlayers[ws.i].playlist.forEach(d => {
          const downVotes = this.videoPlayers[ws.i].votes.filter(v => v.video === d && v.isDown).length;
          const upVotes = this.videoPlayers[ws.i].votes.filter(v => v.video === d && !v.isDown).length;
          d.votes = upVotes - downVotes; 
      });
      
      const current = this.videoPlayers[ws.i].playlist[this.videoPlayers[ws.i].currentTrack];
      current.votes = 9999999;
      
      this.videoPlayers[ws.i].playlist.sort((a, b) => {
        return b.votes - a.votes;
      });
      this.videoPlayers[ws.i].currentTrack = 0;
    }
  }
  setVote(track, isDown, ws) {
    const player = this.videoPlayers[ws.i];
    if(player && this.videoPlayers[ws.i].playlist.length > track && this.videoPlayers[ws.i].canVote) {
      player.votes = player.votes.filter(d => !(d.u === ws.u && player.playlist[track] === d.video));
      player.votes.push({u: ws.u, isDown, video: player.playlist[track]});
      this.updateVotes(ws);
      this.updateClients(ws.i, "set-vote");
    }
  }
  async fromPlaylist(data, ws) {
    if(!data.id || !data.id.startsWith("PL")) {
      return;
    }
        console.log("fromPlaylist", ws.i, ws.u, data);
    this.onlyIfHost(ws, async () => {
      if(this.videoPlayers[ws.i] && (this.videoPlayers[ws.i].playlist.length === 0 || data.shouldClear)) {
        let playlist = await ytfps(data.id, { limit: 100 });
        this.resetPlaylist(ws);
        playlist.videos.forEach(v => {
          this.videoPlayers[ws.i].playlist.push({
            title: v.title,
            thumbnail: v.thumbnail_url,
            duration: v.milis_length ,
            link: v.url,
            votes: 0,
            user: ws.u.name,
            is_youtube_website: false
          })  
        });
        this.updateClients(ws.i);
        await this.savePlayerState(ws.i);
      }
    });
  }
  resetPlaylist(ws) {
    this.videoPlayers[ws.i].playlist.length = 0;
    this.videoPlayers[ws.i].currentTrack = 0;
    this.videoPlayers[ws.i].currentTime = 0;
  }
  async clearPlaylist(skipUpdate, ws) {
    if(this.videoPlayers[ws.i]) {
      this.onlyIfHost(ws, async () => {
        console.log("clearPlaylist", ws.i, ws.u);
        this.resetPlaylist(ws);
        if(!skipUpdate) {
          this.updateClients(ws.i);
        }
        await this.savePlayerState(ws.i);
      }, this.videoPlayers[ws.i].locked);
    }
  }
  async search(term, ws) {
    const results = await youtube.search(term, {
        language: 'en-US',
        searchType: 'video'
    });
    this.send(ws, Commands.SEARCH_RESULTS, results.videos || []);
  }
  onlyIfHost(ws, callback, locked) {
    if(ws.u && ws.u.id && ws.i) {
      if(this.videoPlayers[ws.i] 
         && (this.videoPlayers[ws.i].host.id === ws.u.id || locked === false)) {
        callback();
      }else{
        this.send(ws, Commands.ERROR);
      }
    }
  }
  async addToPlaylist(v, skipUpdate, isYoutubeWebsite, ws) {
    if(this.videoPlayers[ws.i]) {
      this.onlyIfHost(ws, async () => {
        if(!this.videoPlayers[ws.i].playlist.length) {
          this.videoPlayers[ws.i].currentTrack = 0;
          this.videoPlayers[ws.i].currentTime = 0;
          this.videoPlayers[ws.i].lastStartTime = new Date().getTime() / 1000;
        }
        v.user = ws.u.name;
        v.votes = 0;
        v.is_youtube_website = isYoutubeWebsite;
        
        this.videoPlayers[ws.i].playlist.push(v);
        if(!skipUpdate) {
          this.updateClients(ws.i);
        }
        await this.savePlayerState(ws.i);
      }, this.videoPlayers[ws.i].locked);
    }
  }
  async removePlaylistItem(index, ws) {
    if(this.videoPlayers[ws.i]) {
      this.onlyIfHost(ws, async () => {
        this.videoPlayers[ws.i].playlist.splice(index, 1);
        if(index <= this.videoPlayers[ws.i].currentTrack) {
          this.videoPlayers[ws.i].currentTrack--;
        }
        this.updateClients(ws.i);
        await this.savePlayerState(ws.i);
      }, this.videoPlayers[ws.i].locked && !this.videoPlayers[ws.i].canVote);
    }
  }
  async movePlaylistItem({url, index}, ws) {
    if(this.videoPlayers[ws.i]) {
      this.onlyIfHost(ws, async () => {
        const playlist = this.videoPlayers[ws.i].playlist;
        const oldIndex = playlist.map(d => d.link).indexOf(url);
        if(oldIndex > -1) {
          playlist.splice(index, 0, playlist.splice(oldIndex, 1)[0]);
          if(index === this.videoPlayers[ws.i].currentTrack) {
            if(oldIndex > index) {
              this.videoPlayers[ws.i].currentTrack++;
            }else{
              this.videoPlayers[ws.i].currentTrack--;
            }
          }
          this.updateClients(ws.i);
          await this.savePlayerState(ws.i);
        }else{
          this.send(ws, Commands.DOES_NOT_EXIST);
        }
      }, this.videoPlayers[ws.i].locked && !this.videoPlayers[ws.i].canVote);
    }
  }
  async toggleCanTakeOver(canTakeOver, ws) {
    this.onlyIfHost(ws, async () => {
      this.videoPlayers[ws.i].canTakeOver = canTakeOver;
      this.updateClients(ws.i);
      await this.savePlayerState(ws.i);
    });
  }
  async takeOver(ws) {
    if(this.videoPlayers[ws.i] && this.videoPlayers[ws.i].canTakeOver) {
      this.videoPlayers[ws.i].host = ws.u;
      this.updateClients(ws.i);
      await this.savePlayerState(ws.i);
    }else{
      this.send(ws, Commands.ERROR);
    }
  }
  async toggleLock(locked, ws) {
    this.onlyIfHost(ws, async () => {
      this.videoPlayers[ws.i].locked = locked;
      this.updateClients(ws.i);
      await this.savePlayerState(ws.i);
    });
  }
  async setVideoTrack(index, ws) {
    this.onlyIfHost(ws, async () => {
      if(index < this.videoPlayers[ws.i].playlist.length && index > -1) {
        const track = this.videoPlayers[ws.i].playlist[this.videoPlayers[ws.i].currentTrack];
        if(this.videoPlayers[ws.i].canVote) {
          this.videoPlayers[ws.i].votes = this.videoPlayers[ws.i].votes.filter(v => v.video !== track);
          this.videoPlayers[ws.i].playlist[index].votes = 9999999;
        }
        this.videoPlayers[ws.i].currentTrack = index;
        this.videoPlayers[ws.i].currentTime = 0;
        this.videoPlayers[ws.i].lastStartTime = new Date().getTime() / 1000;
        this.resetBrowserIfNeedBe(this.videoPlayers[ws.i], index);
        this.updateVotes(ws);
        this.updateClients(ws.i, Commands.SET_TRACK);
        await this.savePlayerState(ws.i);
      }else{
        this.send(ws, Commands.OUT_OF_BOUNDS);
      }
    }, this.videoPlayers[ws.i].locked && !this.videoPlayers[ws.i].canVote);
  }
  resetBrowserIfNeedBe(player, index) {
    const users = [...new Set(player.sockets.map(ws => ws.u.id))];
    users.forEach(uid => {
      const userSockets = player.sockets.filter(ws => ws.u.id === uid);
        userSockets.forEach(socket => {
          if(socket.type === "space") {
            if(player.playlist[index].is_youtube_website) {
              this.send(socket, Commands.SET_BROWSER_URL, player.playlist[index]);
            }else{
              const videoPlayer = userSockets.filter(ws => ws.type === "player");
              if(!videoPlayer.length) {
                  this.send(socket, Commands.RESET_BROWSER, {});
              }
            }
          }
      });
    });
  }
  async setVideoTime(time, ws) {
    this.onlyIfHost(ws, async () => {
      this.videoPlayers[ws.i].currentTime = time;
      this.videoPlayers[ws.i].lastStartTime = new Date().getTime() / 1000;
      await this.savePlayerState(ws.i);
    }, this.videoPlayers[ws.i].locked);
  }
  async createVideoPlayer(instanceId, user, ws) {
    if(!this.videoPlayers[instanceId]) {
      const client = await this.pool.connect();
      let existingState = null;
      try {
        const res = await client.query('SELECT player_data FROM player_state WHERE instance_id = $1', [instanceId]);
        if (res.rows.length > 0) {
          existingState = res.rows[0].player_data;
          // The connecting user is the new host, so we don't restore the old one.
          delete existingState.host;
          console.log(`Loaded state for instance: ${instanceId}`);
        }
      } catch (err) {
        console.error('Error loading player state:', err);
      } finally {
        client.release();
      }

      this.videoPlayers[instanceId] = {
        playlist:[],
        votes: [],
        currentTrack: 0,
        currentTime: 0,
        locked: false,
        host: user,
        hostConnected: true,
        sockets: [ws],
        canTakeOver: true,
        canVote: false,
        currentPlayerUrl: "",
        lastStartTime: new Date().getTime() / 1000,
        tick: setInterval(() => {
          if(this.videoPlayers[instanceId].playlist.length) {
            const track = this.videoPlayers[instanceId].playlist[this.videoPlayers[instanceId].currentTrack];
            const now = new Date().getTime() / 1000;
            this.videoPlayers[instanceId].currentTime = now - this.videoPlayers[instanceId].lastStartTime;
            if(this.videoPlayers[instanceId].currentTime > (track ? track.duration : 0) / 1000) {
              this.videoPlayers[ws.i].votes = this.videoPlayers[ws.i].votes.filter(v => v.video !== track);
              this.videoPlayers[instanceId].currentTrack ++;
              if(this.videoPlayers[instanceId].currentTrack >= this.videoPlayers[instanceId].playlist.length) {
                this.videoPlayers[instanceId].currentTrack = 0;
              }
              this.videoPlayers[instanceId].currentTime = 0;
              this.updateVotes(ws);
              this.videoPlayers[instanceId].lastStartTime = now;
              this.resetBrowserIfNeedBe(this.videoPlayers[instanceId], this.videoPlayers[instanceId].currentTrack);
              this.updateClients(instanceId, Commands.SET_TRACK);
              this.savePlayerState(instanceId);
            }
          }else{
             this.videoPlayers[instanceId].currentTime = this.videoPlayers[instanceId].currentTrack = 0;
          }
        }, 1000)
      };

      if (existingState) {
        Object.assign(this.videoPlayers[instanceId], existingState);
      }

      console.log(user.name, 'is host');
    }else{
      clearTimeout(this.videoPlayers[instanceId].deleteTimeout);
      if(!this.videoPlayers[instanceId].sockets.includes(ws)) {
         this.videoPlayers[instanceId].sockets.push(ws);
      }
    } 
    this.syncWsTime(ws, instanceId);
    this.send(ws, Commands.PLAYBACK_UPDATE, {video: this.getVideoObject(instanceId), type: 'initial-sync'});
  }
  getVideoObject(instanceId) {
    if(this.videoPlayers[instanceId]) {
      const map = new Map(this.videoPlayers[instanceId].sockets.filter(s => s.p).map(s => [s.u.id, s]));
      return {
        playlist: this.videoPlayers[instanceId].playlist,
        currentTime: this.videoPlayers[instanceId].currentTime,
        currentTrack: this.videoPlayers[instanceId].currentTrack,
        locked: this.videoPlayers[instanceId].locked,
        players: [...map.values()].map(s => ({name: s.u.name, p: s.p, id: s.u.id, v: s.p_v})),
        canTakeOver: this.videoPlayers[instanceId].canTakeOver,
        canVote: this.videoPlayers[instanceId].canVote,
        host: this.videoPlayers[instanceId].host,
        duration: this.videoPlayers[instanceId].playlist.length && this.videoPlayers[instanceId].playlist[this.videoPlayers[instanceId].currentTrack] ? this.videoPlayers[instanceId].playlist[this.videoPlayers[instanceId].currentTrack].duration / 1000 : 0
      };
    }
  }
  syncWsTime(socket, key) {
    if(this.videoPlayers[key].playlist.length && socket.type !== "player") {
      this.send(socket, Commands.SYNC_TIME, {
        currentTrack: this.videoPlayers[key].currentTrack,
        currentTime: this.videoPlayers[key].currentTime,
        duration: this.videoPlayers[key].playlist.length && this.videoPlayers[key].playlist[this.videoPlayers[key].currentTrack] ? this.videoPlayers[key].playlist[this.videoPlayers[key].currentTrack].duration / 1000 : 0
      });
    }
  }
  syncTime() {
    Object.keys(this.videoPlayers).forEach(key => {
      this.videoPlayers[key].sockets.forEach(socket => {
        this.syncWsTime(socket, key);
      });
    });
  }
  updateClients(instanceId, type) {
    if(this.videoPlayers[instanceId]) {
      const video = this.getVideoObject(instanceId);
      this.videoPlayers[instanceId].sockets.forEach(socket => {
        this.send(socket, Commands.PLAYBACK_UPDATE, {video, type});
      });
    }
  }
}
module.exports = new App();