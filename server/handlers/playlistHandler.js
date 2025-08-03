const Commands = require('../../public/commands.js');
const ytfps = require('ytfps');

// The original call in app.js was (v, skipUpdate, isYoutubeWebsite, ws).
// We'll pass `app` (this) and `ws` first for consistency.
async function addToPlaylist(app, ws, v, skipUpdate, isYoutubeWebsite) {
  const player = app.videoPlayers[ws.i];
  if(player) {
    app.onlyIfHost(ws, async () => {
      if (app._isDuplicateVideo(player, v.link)) {
        app.send(ws, Commands.ERROR, { message: "This video is already in the playlist." });
        return;
      }
      if(!player.playlist.length) {
        player.currentTrack = 0;
        player.currentTime = 0;
        player.lastStartTime = new Date().getTime() / 1000;
      }
      const newVideo = app._createVideoObject(v, ws.u, 'scraper', isYoutubeWebsite);
      player.playlist.push(newVideo);
      if(!skipUpdate) {
        player.sockets.forEach(socket => {
          app.send(socket, Commands.ITEM_APPENDED, { video: newVideo });
        });
      }
      await app.savePlayerState(ws.i);
    }, player.locked);
  }
}

async function movePlaylistItem(app, ws, { url, index }) {
	if(app.videoPlayers[ws.i]) {
	app.onlyIfHost(ws, async () => {
		const player = app.videoPlayers[ws.i];
		const playlist = player.playlist;
		const oldIndex = playlist.findIndex(d => d.link === url);

		if(oldIndex > -1) {
		const currentTrackLink = playlist[player.currentTrack].link;
		const [itemToMove] = playlist.splice(oldIndex, 1);
		playlist.splice(index, 0, itemToMove);
		player.currentTrack = playlist.findIndex(v => v.link === currentTrackLink);
		player.sockets.forEach(socket => {
			app.send(socket, Commands.ITEM_MOVED, { oldIndex, newIndex: index, newCurrentTrack: player.currentTrack });
		});
		await app.savePlayerState(ws.i);
		}else{
		app.send(ws, Commands.DOES_NOT_EXIST);
		}
	}, app.videoPlayers[ws.i].locked && !app.videoPlayers[ws.i].canVote);
	}
}

async function removePlaylistItem(app, ws, index) {
	if(app.videoPlayers[ws.i]) {
	app.onlyIfHost(ws, async () => {
		const player = app.videoPlayers[ws.i];
		if (index < 0 || index >= player.playlist.length) return;

		player.playlist.splice(index, 1);

		if (index < player.currentTrack) {
		player.currentTrack--;
		}
		player.sockets.forEach(socket => {
		app.send(socket, Commands.ITEM_REMOVED, { index: index, newCurrentTrack: player.currentTrack });
		});
		await app.savePlayerState(ws.i);
	}, app.videoPlayers[ws.i].locked && !app.videoPlayers[ws.i].canVote);
	}
}

async function fromPlaylist(app, ws, data) {
    const playlistId = app._getPlaylistId(data.id);
    if (!playlistId) {
        app.send(ws, Commands.ERROR, { message: "Invalid Playlist URL or ID provided." });
        return;
    }
    console.log(`fromPlaylist: user=${ws.u.name}, instance=${ws.i}, id=${playlistId}`);
    app.onlyIfHost(ws, async () => {
        if(app.videoPlayers[ws.i] && (app.videoPlayers[ws.i].playlist.length === 0 || data.shouldClear)) {
            const player = app.videoPlayers[ws.i];
            try {
                const playlist = await ytfps(playlistId, { limit: 100 });
                app.resetPlaylist(ws); // Resets playlist, currentTime, currentTrack
                
                // --- Duplicate Video Check for bulk add ---
                const existingVideoIds = new Set();
                let addedCount = 0;
                playlist.videos.forEach(v => {
                    const newVideoId = app.getYoutubeId(v.url);
                    if (newVideoId && !existingVideoIds.has(newVideoId)) {
                        player.playlist.push(app._createVideoObject(v, ws.u, 'ytfps'));
                        existingVideoIds.add(newVideoId); // Add to set to prevent duplicates within the same playlist import
                        addedCount++;
                    }
                });
                
                const duplicateCount = playlist.videos.length - addedCount;
                if (duplicateCount > 0) {
                    app.send(ws, Commands.ERROR, { message: `Added ${addedCount} videos. ${duplicateCount} duplicate(s) were skipped.` });
                }
                // --- End of Check ---

                if (player.playlist.length > 0) {
                    player.lastStartTime = new Date().getTime() / 1000;
                    player.sockets.forEach(socket => {
                        app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, newLastStartTime: player.lastStartTime, playlist: player.playlist });
                    });
                } else {
                    app.updateClients(ws.i); // This is fine, sends an empty playlist.
                }
                await app.savePlayerState(ws.i);
            } catch (error) {
                console.error(`Error fetching playlist ${playlistId}:`, error.message);
                app.send(ws, Commands.ERROR, { message: "Could not load playlist. It might be private or contain no videos." });
            }
        }
    });
}
async function clearPlaylist(app, ws, skipUpdate) {
    if(app.videoPlayers[ws.i]) {
        app.onlyIfHost(ws, async () => {
        console.log("clearPlaylist", ws.i, ws.u);
        app.resetPlaylist(ws);
        if(!skipUpdate) {
            app.videoPlayers[ws.i].sockets.forEach(socket => {
            app.send(socket, Commands.PLAYLIST_UPDATED, { playlist: [], currentTrack: 0 });
            });
        }
        await app.savePlayerState(ws.i);
        }, app.videoPlayers[ws.i].locked);
    }
}
async function addAndPlay(app, ws, v) {
    if (app.videoPlayers[ws.i]) {
        app.onlyIfHost(ws, async () => {
        const player = app.videoPlayers[ws.i];
        if (app._isDuplicateVideo(player, v.link)) {
            app.send(ws, Commands.ERROR, { message: "This video is already in the playlist." });
            return;
        }
        const newVideo = app._createVideoObject(v, ws.u, 'scraper');
        player.playlist.push(newVideo);

        // Set it as the current track
        const newIndex = player.playlist.length - 1;
        player.currentTrack = newIndex;
        player.currentTime = 0;
        player.lastStartTime = new Date().getTime() / 1000;
        app.resetBrowserIfNeedBe(player, newIndex);
        app.updateVotes(ws.i);
        player.sockets.forEach(socket => {
            app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, newLastStartTime: player.lastStartTime, playlist: player.playlist });
        });
        await app.savePlayerState(ws.i);
        }, app.videoPlayers[ws.i].locked);
    }
}
async function addAndPlayNext(app, ws, v) {
    if (app.videoPlayers[ws.i]) {
        app.onlyIfHost(ws, async () => {
        const player = app.videoPlayers[ws.i];
        if (app._isDuplicateVideo(player, v.link)) {
            app.send(ws, Commands.ERROR, { message: "This video is already in the playlist." });
            return;
        }
        const newVideo = app._createVideoObject(v, ws.u, 'scraper');
        const nextIndex = player.currentTrack + 1;
        player.playlist.splice(nextIndex, 0, newVideo);
        // Send a granular ITEM_INSERTED command for efficiency.
        player.sockets.forEach(socket => {
            app.send(socket, Commands.ITEM_INSERTED, { video: newVideo, index: nextIndex });
        });
        await app.savePlayerState(ws.i);
        }, app.videoPlayers[ws.i].locked);
    }
}

async function setVote(app, ws, link, isDown) {
    const player = app.videoPlayers[ws.i];
    const videoObject = player ? player.playlist.find(v => v.link === link) : null;

    if (player && videoObject && player.canVote) {
      // Prevent voting on the currently playing track
      if (player.playlist[player.currentTrack].link === link) {
        return;
      }
      // Remove any previous vote from this user for this video
      player.votes = player.votes.filter(d => !(d.u.id === ws.u.id && d.video.link === link));
      // Add the new vote
      player.votes.push({u: ws.u, isDown, video: videoObject});
      updateVotes(app, ws.i);
      player.sockets.forEach(socket => {
        app.send(socket, Commands.PLAYLIST_UPDATED, { playlist: player.playlist, currentTrack: player.currentTrack });
      });
    }
}

function updateVotes(app, instanceId) {
  const player = app.videoPlayers[instanceId];
  // Only sort if voting is on and there's something to sort.
  if (player && player.canVote && player.playlist.length > 1) {
    // Identify and temporarily remove the currently playing track.
    const currentTrackObject = player.playlist.splice(player.currentTrack, 1)[0];

    // Calculate votes for the rest of the playlist.
    player.playlist.forEach(d => {
      const downVotes = player.votes.filter(v => v.video === d && v.isDown).length;
      const upVotes = player.votes.filter(v => v.video === d && !v.isDown).length;
      d.votes = upVotes - downVotes;
    });

    // Sort the rest of the playlist based on votes.
    player.playlist.sort((a, b) => b.votes - a.votes);

    // Add the currently playing track back to the top.
    player.playlist.unshift(currentTrackObject);

    // The current track is now always at index 0.
    player.currentTrack = 0;
  }
}

module.exports = {
  addToPlaylist,
  movePlaylistItem,
  removePlaylistItem,
  fromPlaylist,
  clearPlaylist,
  addAndPlay,
  addAndPlayNext,
  setVote,
  updateVotes
};