const Commands = require('../../public/commands.js');
const SkipJumpTimePlaylist = 5;
const SkipJumpTimeKaraoke = 0.25; // 250ms for karaoke, to allow for more precise timing.

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

async function takeOver(app, ws) {
  const player = app.videoPlayers[ws.i];
  if(player && player.canTakeOver) {
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

async function hostSkip(app, ws, isForward) {
  app.onlyIfHost(ws, async () => {
    const player = app.videoPlayers[ws.i];
    if (!player || !player.playlist.length) return;

    // Use the explicit isKaraoke flag for a more reliable check.
    const skipAmount = player.isKaraoke ? SkipJumpTimeKaraoke : SkipJumpTimePlaylist;

    // To skip forward in time, we subtract from the start timestamp.
    // To skip backward, we add to it.
    player.lastStartTime += isForward ? -skipAmount : skipAmount;
    player.paused = false; // Resume playback on skip

    // Calculate the new current time to send to clients for an immediate seek.
    const newCurrentTime = (new Date().getTime() / 1000) - player.lastStartTime;
    player.currentTime = newCurrentTime; // Keep server state consistent.

    // Broadcast a seek command to all clients.
    player.sockets.forEach(socket => {
      app.send(socket, Commands.HOST_SEEK, {
        newCurrentTime: newCurrentTime,
        newLastStartTime: player.lastStartTime
      });
    });
    await app.savePlayerState(ws.i);
  });
}

async function internalStop(app, instanceId) {
  const player = app.videoPlayers[instanceId];
  if (!player) return;
  // When stopping, we clear the main playlist. This is especially important for karaoke
  // to return the UI to the singer list view.
  player.playlist = [];
  player.currentTrack = 0;
  player.currentTime = 0;
  app.updateClients(instanceId, "stop");
  await app.savePlayerState(instanceId);
}

async function stop(app, ws) {
  app.onlyIfHost(ws, async () => internalStop(app, ws.i), app.videoPlayers[ws.i].locked);
}

async function setVideoTrack(app, ws, index) {
  const player = app.videoPlayers[ws.i];
  if (!player) return;

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
        app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, newLastStartTime: player.lastStartTime });
      });
      await app.savePlayerState(ws.i);
    } else {
      app.send(ws, Commands.OUT_OF_BOUNDS);
    }
  }, player.locked && !player.canVote);
}

async function setVideoTime(app, ws, time) {
  const player = app.videoPlayers[ws.i];
  if (!player) return;

  app.onlyIfHost(ws, async () => {
    if (!player.playlist.length) return;

    const trackDuration = (player.playlist[player.currentTrack].duration || 0) / 1000;
    // Clamp the time to be within the video's duration
    const newTime = Math.max(0, Math.min(time, trackDuration));

    player.lastStartTime = (new Date().getTime() / 1000) - newTime;
    player.currentTime = newTime;

    // Broadcast a seek command to all clients. This is the same command used by host skip.
    player.sockets.forEach(socket => {
      app.send(socket, Commands.HOST_SEEK, {
        newCurrentTime: newTime,
        newLastStartTime: player.lastStartTime
      });
    });
    await app.savePlayerState(ws.i);
  }, player.locked);
}

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
    hostSkip,
    stop,
    setVideoTrack,
    setVideoTime,
    toggleVote,
    internalStop,
    togglePause
};