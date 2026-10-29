/**
 * @fileoverview WebSocket command handlers for host permissions, playback controls,
 * and instance state management. Handles host takeover, locks, seeking, skipping,
 * track changes, pausing, and voting toggles.
 * @module server/handlers/hostHandler
 */

const Commands = require('../../public/commands.js');

/** Jump increment in seconds when skipping in playlist mode. */
const SkipJumpTimePlaylist = 5;

/** Jump increment in seconds when skipping in karaoke mode (250ms for finer sync). */
const SkipJumpTimeKaraoke = 0.25;

/**
 * Toggles the locked status of the player instance, restricting non-host controls.
 * Broadcasts the lock state change to all clients in the instance.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting the action.
 * @param {boolean} locked - The new locked state.
 * @returns {Promise<void>}
 */
async function toggleLock(app, ws, locked) {
  app.onlyIfHost(ws, async () => {
    const player = app.videoPlayers[ws.i];
    player.locked = locked;
    // Instead of sending the whole state, broadcast a small, specific message.
    player.sockets.forEach(socket => {
      app.send(socket, Commands.LOCK_STATE_CHANGED, { locked: player.locked });
    });
    await app.savePlayerState(ws.i);
  });
}

/**
 * Enables or disables the ability for other users to take over host privileges.
 * Host must be connected to the 3D space to disable takeover.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting the action.
 * @param {boolean} canTakeOver - Whether non-hosts are permitted to assume host role.
 * @returns {Promise<void>}
 */
async function toggleCanTakeOver(app, ws, canTakeOver) {
  app.onlyIfHost(ws, async () => {
    const player = app.videoPlayers[ws.i];

    // To prevent a stuck state, only a host who is "present" in the 3D space
    // can disable the takeover functionality. A host can always enable it.
    if (canTakeOver === false && !player.hostConnected) {
      app.send(ws, Commands.ERROR, { message: "You must be in the 3D space to disable takeover." });
      return;
    }

    player.canTakeOver = canTakeOver;
    player.sockets.forEach(socket => {
      app.send(socket, Commands.CAN_TAKE_OVER_STATE_CHANGED, { canTakeOver: player.canTakeOver });
    });
    await app.savePlayerState(ws.i);
  });
}

/**
 * Transfers host permissions to the requesting user if takeover is permitted.
 * Updates host state, resets any active takeover grace timeout, and alerts clients.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting to take over host role.
 * @returns {Promise<void>}
 */
async function takeOver(app, ws) {
  const player = app.videoPlayers[ws.i];
  // Anyone can take over from a blacklisted host.
  const hostBlocked = !!(player && player.host && app.blacklist && app.blacklist.has(player.host.id));
  if(player && (player.canTakeOver || hostBlocked)) {
    const oldHostName = player.host ? player.host.name : 'nobody';
    player.host = ws.u;

    if (player.takeoverTimeout) {
      clearTimeout(player.takeoverTimeout);
      player.takeoverTimeout = null;
    }

    const newHostHasSpaceConnection = player.sockets.some(
      s => s.u && s.u.id === player.host.id && s.type === "space"
    );

    player.canTakeOver = true;
    player.hostConnected = newHostHasSpaceConnection;

    console.log(`User ${ws.u.name} took over from ${oldHostName}. New host has space connection: ${player.hostConnected}. Can Take Over is now: ${player.canTakeOver}`);

    app.updateClients(ws.i, 'host-changed');
    await app.savePlayerState(ws.i);
  } else {
    app.send(ws, Commands.ERROR);
  }
}

/**
 * A space admin takes control, even when the player is locked or take over is off.
 *
 * Only a space admin can write the protected space state key the in-world player watches
 * (fire-v-player-admin, see Core.adminTakeOver), and only the player of the person it names sends
 * this. The server can't check who is a space admin, so like every other identity here it trusts
 * the player that sends it.
 *
 * While they're in the space nobody else can take over (Take Over is turned off). When they leave,
 * the usual rule applies: 42 seconds later anyone can take over again (see App.handleClose).
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - The admin's in-world socket.
 * @returns {Promise<void>}
 */
async function adminTakeOver(app, ws) {
  const player = app.videoPlayers[ws.i];
  // Only from the in-world player, which is the one that saw the space admin's write.
  if (!player || !ws.u || !ws.u.id || ws.type !== 'space') return;
  const oldHostName = player.host ? player.host.name : 'nobody';
  player.host = ws.u;
  if (player.takeoverTimeout) {
    clearTimeout(player.takeoverTimeout);
    player.takeoverTimeout = null;
  }
  player.hostConnected = player.sockets.some(s => s.u && s.u.id === ws.u.id && s.type === 'space');
  // Only a host who is in the space can keep others out (as for toggleCanTakeOver).
  player.canTakeOver = !player.hostConnected;
  console.log(`[ADMIN] Space admin ${ws.u.name} (${ws.u.id}) took control from ${oldHostName} in ${ws.i}. Locked: ${player.locked}, Can Take Over: ${player.canTakeOver}`);
  app.updateClients(ws.i, 'host-changed');
  await app.savePlayerState(ws.i);
}

/**
 * Skips forward or backward in the currently playing video by a fixed duration increment.
 * Adjusts `lastStartTime` and broadcasts `HOST_SEEK` to all connected clients.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting the skip.
 * @param {boolean} isForward - True to skip forward, false to skip backward.
 * @returns {Promise<void>}
 */
async function hostSkip(app, ws, isForward) {
  app.onlyIfHost(ws, async () => {
    const player = app.videoPlayers[ws.i];
    if (!player || !player.playlist.length) return;

    // Use the explicit isKaraoke flag for a more reliable check.
    const skipAmount = player.isKaraoke ? SkipJumpTimeKaraoke : SkipJumpTimePlaylist;

    const now = new Date().getTime() / 1000;
    const delta = isForward ? skipAmount : -skipAmount;
    let newCurrentTime;
    if (player.paused) {
      // Paused stays paused, at the new point (the time is held in currentTime while paused).
      newCurrentTime = Math.max(0, (player.currentTime || 0) + delta);
      player.lastStartTime = now - newCurrentTime;
    } else {
      // To skip forward in time, we subtract from the start timestamp.
      player.lastStartTime -= delta;
      newCurrentTime = now - player.lastStartTime;
    }
    player.currentTime = newCurrentTime; // Keep server state consistent.

    // Broadcast a seek command to all clients.
    player.sockets.forEach(socket => {
      app.send(socket, Commands.HOST_SEEK, {
        newCurrentTime: newCurrentTime,
        newLastStartTime: player.lastStartTime,
        paused: !!player.paused
      });
    });
    await app.savePlayerState(ws.i);
  });
}

/**
 * Resets playback state and clears the playlist for a specific room instance.
 *
 * @param {Object} app - Express application and state controller.
 * @param {string} instanceId - Room/instance identifier.
 * @returns {Promise<void>}
 */
async function internalStop(app, instanceId) {
  const player = app.videoPlayers[instanceId];
  if (!player) return;
  // When stopping, we clear the main playlist. This is especially important for karaoke
  // to return the UI to the singer list view.
  player.playlist = [];
  player.currentTrack = 0;
  player.currentTime = 0;
  player.paused = false; // nothing is playing, so the next song shouldn't start paused
  app.updateClients(instanceId, "stop");
  await app.savePlayerState(instanceId);
}

/**
 * Host-guarded stop command that clears playback and empties the queue.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting stop.
 * @returns {Promise<void>}
 */
async function stop(app, ws) {
  app.onlyIfHost(ws, async () => internalStop(app, ws.i), app.videoPlayers[ws.i].locked);
}

/**
 * Changes the current playback track index.
 * Supports passing either an index number or an object `{ index, link }` to guard against stale UI state.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting track change.
 * @param {number|{index: number, link?: string}} data - Track index or object with track index and fallback link.
 * @returns {Promise<void>}
 */
async function setVideoTrack(app, ws, data) {
  const player = app.videoPlayers[ws.i];
  if (!player) return;
  let index = data;
  if (data && typeof data === 'object') {
    index = Number(data.index);
    const byLink = data.link ? player.playlist.findIndex(v => v.link === data.link) : -1;
    if (byLink > -1) index = byLink;
  }

  app.onlyIfHost(ws, async () => {
    if(index < player.playlist.length && index > -1) {
      if(player.canVote) {
        const track = player.playlist[player.currentTrack];
        player.votes = player.votes.filter(v => v.video !== track);
      }
      player.currentTrack = index;
      player.currentTime = 0;
      player.lastStartTime = new Date().getTime() / 1000;
      player.paused = false; // Ensure playback resumes on track change
      app.resetBrowserIfNeedBe(player, index);
      app.updateVotes(ws.i);
      player.sockets.forEach(socket => {
        app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, track: player.playlist[player.currentTrack], paused: player.paused, newLastStartTime: player.lastStartTime });
      });
      await app.savePlayerState(ws.i);
    } else {
      app.send(ws, Commands.OUT_OF_BOUNDS);
    }
  }, player.locked && !player.canVote);
}

/**
 * Seeks the current video to an absolute playback position in seconds.
 * Clamps timestamp between 0 and track duration, and notifies all connected clients.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting seek.
 * @param {number} time - Playback target timestamp in seconds.
 * @returns {Promise<void>}
 */
async function setVideoTime(app, ws, time) {
  const player = app.videoPlayers[ws.i];
  if (!player) return;

  app.onlyIfHost(ws, async () => {
    if (!player.playlist.length) return;

    const trackDuration = (player.playlist[player.currentTrack].duration || 0) / 1000;
    // Clamp the time to be within the video's duration (when it's known: a file may not have one)
    const t = Number(time);
    if (!Number.isFinite(t)) return;
    const newTime = Math.max(0, trackDuration > 0 ? Math.min(t, trackDuration) : t);

    player.lastStartTime = (new Date().getTime() / 1000) - newTime;
    player.currentTime = newTime;

    // Broadcast a seek command to all clients. This is the same command used by host skip.
    player.sockets.forEach(socket => {
      app.send(socket, Commands.HOST_SEEK, {
        newCurrentTime: newTime,
        newLastStartTime: player.lastStartTime,
        paused: !!player.paused
      });
    });
    await app.savePlayerState(ws.i);
  }, player.locked);
}

/**
 * Toggles whether voting mode is active for the current room instance.
 * When enabled, resets existing votes and notifies clients.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting vote toggle.
 * @returns {Promise<void>}
 */
async function toggleVote(app, ws) {
  if (app.videoPlayers[ws.i]) {
    app.onlyIfHost(ws, async () => {
      const player = app.videoPlayers[ws.i];
      player.canVote = !player.canVote;
      // When turning voting on, clear all existing votes to start fresh.
      // Also, broadcast a playlist update to ensure clients' UIs reflect the cleared votes.
      if (player.canVote) {
        player.votes = [];
        app.updateVotes(ws.i); // This resets the vote counts on the video objects to 0.
        player.sockets.forEach(socket => {
          app.send(socket, Commands.PLAYLIST_UPDATED, { playlist: player.playlist, currentTrack: player.currentTrack });
        });
      }
      player.sockets.forEach(socket => {
        app.send(socket, Commands.VOTING_STATE_CHANGED, { canVote: player.canVote });
      });
      await app.savePlayerState(ws.i);
    });
  }
}

/**
 * Toggles playback between pause and playing.
 * Synchronizes elapsed `currentTime` and `lastStartTime`, broadcasting state change to all clients.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting toggle pause.
 * @returns {Promise<void>}
 */
async function togglePause(app, ws) {
  console.log(`[PAUSE] Toggle request from ${ws.u ? ws.u.name : 'unknown'} (${ws.u ? ws.u.id : 'N/A'}) for instance ${ws.i}`);
  app.onlyIfHost(ws, async () => {
    const player = app.videoPlayers[ws.i];
    console.log(`[PAUSE] Host ID: ${player.host.id}, Requester ID: ${ws.u.id}`);
    if (!player || !player.playlist.length) {
      console.log(`[PAUSE] Rejected: No player or empty playlist`);
      return;
    }

    const now = new Date().getTime() / 1000;
    player.paused = !player.paused;
    console.log(`[PAUSE] Instance ${ws.i} is now ${player.paused ? 'PAUSED' : 'RESUMED'}`);

    if (player.paused) {
      player.currentTime = now - player.lastStartTime;
    } else {
      player.lastStartTime = now - player.currentTime;
    }

    player.sockets.forEach(socket => {
      app.send(socket, Commands.PAUSE_STATE_CHANGED, { 
        paused: player.paused,
        currentTime: player.currentTime,
        lastStartTime: player.lastStartTime
      });
    });
    
    await app.savePlayerState(ws.i);
  });
}

module.exports = {
    toggleLock,
    toggleCanTakeOver,
    takeOver,
    adminTakeOver,
    hostSkip,
    stop,
    setVideoTrack,
    setVideoTime,
    toggleVote,
    internalStop,
    togglePause
};