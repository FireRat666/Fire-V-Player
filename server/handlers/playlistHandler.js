/**
 * @fileoverview WebSocket command handlers for Playlist management.
 * Handles adding, moving, removing items, bulk importing from YouTube playlists,
 * queuing tracks immediately, and crowd voting with dynamic reordering.
 * @module server/handlers/playlistHandler
 */

const Commands = require('../../public/commands.js');
const { getInnertube, getLibrary } = require('../youtube/youtubeiService.js');
const Scraper = require('../youtube/scraper.js');
const scraper = new Scraper();
const media = require('../media.js');
// The most videos a YouTube playlist import adds. The whole playlist goes to everyone on each
// change, so this keeps that message a sensible size.
const MAX_PLAYLIST_IMPORT = 500;

/**
 * Resolves a raw URL/ID or partial video metadata object into a standardized, fully populated video object.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting resolution.
 * @param {string|Object} v - URL string, YouTube ID, or partially populated video object.
 * @returns {Promise<Object>} The resolved video object with title, duration, link, and thumbnail.
 * @throws {Error} If video resolution fails or link is untrusted/invalid.
 */
async function resolveVideoData(app, ws, v) {
  if (typeof v === 'string') {
    const videoId = app.getYoutubeId(v);
    if (!videoId) {
      if (media.detect(v) && !media.allowedFor(ws, v)) throw new Error(media.UNTRUSTED_MESSAGE);
      const other = await media.resolveMediaLink(v); // Twitch, Vimeo, a file or stream
      if (other) return other;
      throw new Error("Invalid YouTube URL or ID");
    }
    const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const resolved = await scraper.getVideoByUrl(fullUrl);
    return resolved;
  }
  
  if (v && typeof v === 'object') {
    const link = v.link || v.url;
    // A Twitch, Vimeo or direct link, as its search result described it. Only links the player
    // can play are accepted, and titles are kept to a sensible length.
    if (link && !app.getYoutubeId(link)) {
      if (!media.detect(link)) throw new Error("That link can't be played here.");
      if (!media.allowedFor(ws, link)) throw new Error(media.UNTRUSTED_MESSAGE);
      if (!v.title) return { ...v, ...(await media.resolveMediaLink(link)) };
      return { ...v, link, title: String(v.title).slice(0, 200), duration: Number(v.duration) > 0 ? Number(v.duration) : 0 };
    }
    if (link && (!v.title || v.title === 'Unknown Title' || !v.duration)) {
      const videoId = app.getYoutubeId(link);
      if (videoId) {
        const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const resolved = await scraper.getVideoByUrl(fullUrl);
        return { ...v, ...resolved };
      }
    }
  }
  return v;
}

/**
 * Adds a video to the end of the playlist for the client's room.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting the addition.
 * @param {string|Object} v - Video URL or partial object to add.
 * @param {boolean} [skipUpdate] - If true, skips broadcasting ITEM_APPENDED to clients.
 * @param {boolean} [isYoutubeWebsite] - Whether the request originated from the web search.
 * @returns {Promise<void>}
 */
async function addToPlaylist(app, ws, v, skipUpdate, isYoutubeWebsite) {
  const player = app.videoPlayers[ws.i];
  if (player) {
    app.onlyIfHost(ws, async () => {
      let resolvedV;
      try {
        resolvedV = await resolveVideoData(app, ws, v);
      } catch (err) {
        app.send(ws, Commands.ERROR, { message: `Failed to resolve video: ${err.message}` });
        return;
      }

      if (app._isDuplicateVideo(player, resolvedV.link)) {
        app.send(ws, Commands.ERROR, { message: "This video is already in the playlist." });
        return;
      }
      if (!player.playlist.length) {
        player.currentTrack = 0;
        player.currentTime = 0;
        player.lastStartTime = new Date().getTime() / 1000;
      }
      const newVideo = app._createVideoObject(resolvedV, ws.u, 'scraper', isYoutubeWebsite);
      player.playlist.push(newVideo);
      if (!skipUpdate) {
        player.sockets.forEach(socket => {
          app.send(socket, Commands.ITEM_APPENDED, { video: newVideo });
        });
      }
      await app.savePlayerState(ws.i);
    }, player.locked);
  }
}

/**
 * Reorders a playlist item to a new position.
 * Preserves the currently playing track's identity across the move.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting the move.
 * @param {Object} params - Movement parameters.
 * @param {string} params.url - URL link of the item to move.
 * @param {number} params.index - Destination index in the playlist.
 * @returns {Promise<void>}
 */
async function movePlaylistItem(app, ws, { url, index }) {
  if (app.videoPlayers[ws.i]) {
    app.onlyIfHost(ws, async () => {
      const player = app.videoPlayers[ws.i];
      const playlist = player.playlist;
      const oldIndex = playlist.findIndex(d => d.link === url);

      if (oldIndex > -1) {
        const currentTrackLink = playlist[player.currentTrack].link;
        const [itemToMove] = playlist.splice(oldIndex, 1);
        playlist.splice(index, 0, itemToMove);
        player.currentTrack = playlist.findIndex(v => v.link === currentTrackLink);
        player.sockets.forEach(socket => {
          app.send(socket, Commands.ITEM_MOVED, { oldIndex, newIndex: index, newCurrentTrack: player.currentTrack });
        });
        await app.savePlayerState(ws.i);
      } else {
        app.send(ws, Commands.DOES_NOT_EXIST);
      }
    }, app.videoPlayers[ws.i].locked && !app.videoPlayers[ws.i].canVote);
  }
}

/**
 * Removes an item from the playlist at the specified index.
 * Adjusts `currentTrack` if the removed track came before it.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting removal.
 * @param {number} index - Index of the item to remove.
 * @returns {Promise<void>}
 */
async function removePlaylistItem(app, ws, index) {
  if (app.videoPlayers[ws.i]) {
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

/**
 * Loads and appends up to MAX_PLAYLIST_IMPORT tracks from an external YouTube playlist.
 * Filters out duplicate items and updates client player state.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting playlist import.
 * @param {Object} data - Playlist import configuration.
 * @param {string} data.id - YouTube playlist URL or ID.
 * @param {boolean} [data.shouldClear] - Whether to clear the existing playlist before import.
 * @returns {Promise<void>}
 */
async function fromPlaylist(app, ws, data) {
  const playlistId = app._getPlaylistId(data.id);
  if (!playlistId) {
    app.send(ws, Commands.ERROR, { message: "Invalid Playlist URL or ID provided." });
    return;
  }
  console.log(`fromPlaylist: user=${ws.u.name}, instance=${ws.i}, id=${playlistId}`);
  app.onlyIfHost(ws, async () => {
    if (app.videoPlayers[ws.i] && (app.videoPlayers[ws.i].playlist.length === 0 || data.shouldClear)) {
      const player = app.videoPlayers[ws.i];
      try {
        const yt = await getInnertube();
        const playlist = await yt.getPlaylist(playlistId);

        let videos = [...playlist.items];
        let currentPlaylist = playlist;

        while (videos.length < MAX_PLAYLIST_IMPORT && currentPlaylist.has_continuation) {
          currentPlaylist = await currentPlaylist.getContinuation();
          const nextItems = currentPlaylist.items;
          if (!nextItems || nextItems.length === 0) break;
          videos = videos.concat(nextItems);
        }

        if (videos.length > MAX_PLAYLIST_IMPORT) {
          videos = videos.slice(0, MAX_PLAYLIST_IMPORT);
        }

        app.resetPlaylist(ws); // Resets playlist, currentTime, currentTrack

        // --- Duplicate Video Check for bulk add ---
        const existingVideoIds = new Set();
        let addedCount = 0;
        videos.forEach(v => {
          const videoId = v.id || v.videoId || v.content_id;
          if (videoId && !existingVideoIds.has(videoId)) {
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            
            // Extract title
            let title = '';
            if (v.title) {
              title = typeof v.title.text === 'string' ? v.title.text : (typeof v.title === 'string' ? v.title : '');
            } else if (v.metadata && v.metadata.title) {
              title = typeof v.metadata.title.text === 'string' ? v.metadata.title.text : '';
            }
            if (!title) title = 'Unknown Title';

            // Extract duration
            let durationMs = 0;
            let durationText = '';
            if (v.duration) {
              durationText = typeof v.duration.text === 'string' ? v.duration.text : (typeof v.duration === 'string' ? v.duration : '');
            } else if (v.content_image && Array.isArray(v.content_image.overlays)) {
              const bottomOverlay = v.content_image.overlays.find(o => o.type === 'ThumbnailBottomOverlayView');
              if (bottomOverlay && Array.isArray(bottomOverlay.badges) && bottomOverlay.badges.length > 0) {
                durationText = bottomOverlay.badges[0].text || '';
              }
            }

            if (durationText) {
              const parts = durationText.split(':').map(Number);
              if (parts.length === 2) {
                durationMs = (parts[0] * 60 + parts[1]) * 1000;
              } else if (parts.length === 3) {
                durationMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
              }
            } else if (v.duration && typeof v.duration.seconds === 'number') {
              durationMs = v.duration.seconds * 1000;
            }

            // Extract thumbnail
            let thumbnail_url = '';
            if (Array.isArray(v.thumbnails) && v.thumbnails.length > 0) {
              thumbnail_url = v.thumbnails[v.thumbnails.length - 1].url;
            } else if (v.thumbnail && typeof v.thumbnail.url === 'string') {
              thumbnail_url = v.thumbnail.url;
            } else if (v.thumbnail && Array.isArray(v.thumbnail.thumbnails) && v.thumbnail.thumbnails.length > 0) {
              thumbnail_url = v.thumbnail.thumbnails[v.thumbnail.thumbnails.length - 1].url;
            } else if (v.content_image && Array.isArray(v.content_image.image) && v.content_image.image.length > 0) {
              thumbnail_url = v.content_image.image[v.content_image.image.length - 1].url;
            } else {
              thumbnail_url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            }

            const itemToCreate = {
              title,
              thumbnail_url,
              milis_length: durationMs,
              url: videoUrl
            };

            player.playlist.push(app._createVideoObject(itemToCreate, ws.u, 'ytfps'));
            existingVideoIds.add(videoId);
            addedCount++;
          }
        });

        const duplicateCount = videos.length - addedCount;
        if (duplicateCount > 0) {
          app.send(ws, Commands.ERROR, { message: `Added ${addedCount} videos. ${duplicateCount} duplicate(s) were skipped.` });
        }
        // --- End of Check ---

        if (player.playlist.length > 0) {
          player.lastStartTime = new Date().getTime() / 1000;
          player.sockets.forEach(socket => {
            app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, track: player.playlist[player.currentTrack], paused: player.paused, newLastStartTime: player.lastStartTime, playlist: player.playlist });
          });
        } else {
          app.updateClients(ws.i); // This is fine, sends an empty playlist.
        }
        await app.savePlayerState(ws.i);
      } catch (error) {
        console.error(`Error fetching playlist ${playlistId}:`, error);
        app.send(ws, Commands.ERROR, { message: "Could not load playlist. It might be private or contain no videos." });
      }
    }
  });
}

/**
 * Clears all items from the current instance's playlist.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting the clear.
 * @param {boolean} [skipUpdate] - If true, skips broadcasting the PLAYLIST_UPDATED command.
 * @returns {Promise<void>}
 */
async function clearPlaylist(app, ws, skipUpdate) {
  if (app.videoPlayers[ws.i]) {
    app.onlyIfHost(ws, async () => {
      console.log("clearPlaylist", ws.i, ws.u);
      app.resetPlaylist(ws);
      if (!skipUpdate) {
        app.videoPlayers[ws.i].sockets.forEach(socket => {
          app.send(socket, Commands.PLAYLIST_UPDATED, { playlist: [], currentTrack: 0 });
        });
      }
      await app.savePlayerState(ws.i);
    }, app.videoPlayers[ws.i].locked);
  }
}

/**
 * Appends a video to the playlist and immediately switches playback to it.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting immediate playback.
 * @param {string|Object} v - Video link or object.
 * @returns {Promise<void>}
 */
async function addAndPlay(app, ws, v) {
  if (app.videoPlayers[ws.i]) {
    app.onlyIfHost(ws, async () => {
      const player = app.videoPlayers[ws.i];
      let resolvedV;
      try {
        resolvedV = await resolveVideoData(app, ws, v);
      } catch (err) {
        app.send(ws, Commands.ERROR, { message: `Failed to resolve video: ${err.message}` });
        return;
      }

      if (app._isDuplicateVideo(player, resolvedV.link)) {
        app.send(ws, Commands.ERROR, { message: "This video is already in the playlist." });
        return;
      }
      const newVideo = app._createVideoObject(resolvedV, ws.u, 'scraper');
      player.playlist.push(newVideo);

      // Set it as the current track
      const newIndex = player.playlist.length - 1;
      player.currentTrack = newIndex;
      player.currentTime = 0;
      player.lastStartTime = new Date().getTime() / 1000;
      app.resetBrowserIfNeedBe(player, newIndex);
      app.updateVotes(ws.i);
      player.sockets.forEach(socket => {
        app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, track: player.playlist[player.currentTrack], paused: player.paused, newLastStartTime: player.lastStartTime, playlist: player.playlist });
      });
      await app.savePlayerState(ws.i);
    }, app.videoPlayers[ws.i].locked);
  }
}

/**
 * Inserts a video immediately following the current track (up next).
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting play next.
 * @param {string|Object} v - Video link or object.
 * @returns {Promise<void>}
 */
async function addAndPlayNext(app, ws, v) {
  if (app.videoPlayers[ws.i]) {
    app.onlyIfHost(ws, async () => {
      const player = app.videoPlayers[ws.i];
      let resolvedV;
      try {
        resolvedV = await resolveVideoData(app, ws, v);
      } catch (err) {
        app.send(ws, Commands.ERROR, { message: `Failed to resolve video: ${err.message}` });
        return;
      }

      if (app._isDuplicateVideo(player, resolvedV.link)) {
        app.send(ws, Commands.ERROR, { message: "This video is already in the playlist." });
        return;
      }
      const newVideo = app._createVideoObject(resolvedV, ws.u, 'scraper');
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

/**
 * Records an upvote or downvote on a playlist item by a connected user.
 * Cannot vote on the currently playing track. Triggers re-sorting if voting mode is active.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket casting the vote.
 * @param {string} link - URL link of the target video.
 * @param {boolean} isDown - True for downvote, false for upvote.
 * @returns {Promise<void>}
 */
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
    player.votes.push({ u: ws.u, isDown, video: videoObject });
    updateVotes(app, ws.i);
    player.sockets.forEach(socket => {
      app.send(socket, Commands.PLAYLIST_UPDATED, { playlist: player.playlist, currentTrack: player.currentTrack });
    });
  }
}

/**
 * Recalculates vote tallies for all upcoming tracks and sorts the playlist in descending order of votes.
 * Preserves the current active track at index 0.
 *
 * @param {Object} app - Express application and state controller.
 * @param {string} instanceId - Room/instance identifier.
 * @returns {void}
 */
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