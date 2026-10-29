/**
 * @fileoverview WebSocket command handlers for Playlist management.
 * Handles adding, moving, removing items, bulk importing from YouTube playlists,
 * queuing tracks immediately, and crowd voting with dynamic reordering.
 * @module server/handlers/playlistHandler
 */

const Commands = require('../../public/commands.js');
const { videoById } = require('../youtube/search.js');
const media = require('../media.js');
const lists = require('../lists.js');
// The most videos a YouTube playlist import adds. The whole playlist goes to everyone on each
// change, so this keeps that message a sensible size.
const MAX_PLAYLIST_IMPORT = 500;
const MAX_SAVED_LISTS = 50; // shared Lists per room

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
    const resolved = await videoById(videoId);
    return resolved;
  }
  
  if (v && typeof v === 'object') {
    let link = v.link || v.url;
    // A Drive or Dropbox share link is kept as the address of the file itself (see media.detect).
    const detected = link ? media.detect(link) : null;
    if (detected && detected.type === 'file' && detected.url) link = detected.url;
    // A Twitch, Vimeo or direct link, as its search result described it. Only links the player
    // can play are accepted, and titles are kept to a sensible length.
    if (link && !app.getYoutubeId(link)) {
      if (!media.detect(link)) throw new Error("That link can't be played here.");
      if (!media.allowedFor(ws, link)) throw new Error(media.UNTRUSTED_MESSAGE);
      // An Internet Archive search result links to the item's page: play one of its files.
      if (media.detect(link).type === 'archive') {
        const file = await media.resolveMediaLink(link);
        return { ...v, ...file, duration: file.duration || (Number(v.duration) > 0 ? Number(v.duration) : 0) };
      }
      if (!v.title) return { ...v, ...(await media.resolveMediaLink(link)) };
      return { ...v, link, title: String(v.title).slice(0, 200), duration: Number(v.duration) > 0 ? Number(v.duration) : 0 };
    }
    if (link && (!v.title || v.title === 'Unknown Title' || !v.duration)) {
      const videoId = app.getYoutubeId(link);
      if (videoId) {
        const resolved = await videoById(videoId);
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
 * Loads a playlist source for a client: a YouTube playlist, or a list (a text file of links, a
 * Google Doc, a Drive folder or an archive.org item, see server/lists.js). Links this world
 * doesn't allow for the client (see media.allowedFor) are left out and counted.
 *
 * @param {Object} ws - Client WebSocket the list is for.
 * @param {string} id - The playlist link or id.
 * @returns {Promise<{title: string, items: Object[], skipped: number, truncated: boolean}>}
 * @throws {Error} With a message to show when the list can't be loaded.
 */
async function loadPlaylistSource(ws, id) {
  const list = await lists.loadAny(id, MAX_PLAYLIST_IMPORT);
  const items = list.items.filter(item => !media.detect(item.link) || media.allowedFor(ws, item.link));
  return { title: list.title, items, skipped: list.items.length - items.length + (list.dropped || 0), truncated: !!list.truncated };
}

/** A short note about the links of a list that were left out, or ''. */
function skippedNote(skipped) {
  return skipped > 0 ? ` ${skipped} link${skipped === 1 ? " wasn't" : "s weren't"} added (not playable, or not allowed in this world).` : '';
}

/**
 * Loads a playlist into the room: a YouTube playlist (up to MAX_PLAYLIST_IMPORT videos), or a list
 * of mixed links (see server/lists.js). Duplicates are skipped.
 *
 * Replacing the playlist (the default) is for the host, and only happens when the playlist is
 * empty or `shouldClear` is set. With `append`, the list's videos are added to the end instead,
 * which anyone may do whenever they may add a video (the host, or anyone while unlocked).
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket requesting playlist import.
 * @param {Object} data - Playlist import configuration.
 * @param {string} data.id - YouTube playlist URL or ID, or a list link.
 * @param {boolean} [data.shouldClear] - Whether to clear the existing playlist before import.
 * @param {boolean} [data.append] - Add the list to the end of the playlist instead.
 * @returns {Promise<void>}
 */
async function fromPlaylist(app, ws, data) {
  const id = data && typeof data.id === 'string' ? data.id.trim() : '';
  if (!id || !lists.isPlaylistSource(id)) {
    app.send(ws, Commands.ERROR, { message: "That is not a YouTube playlist or a list of links." });
    return;
  }
  const player = app.videoPlayers[ws.i];
  if (!player) return;
  console.log(`fromPlaylist: user=${ws.u && ws.u.name}, instance=${ws.i}, id=${id}${data.append ? ' (append)' : ''}`);

  if (data.append) {
    app.onlyIfHost(ws, async () => {
      let list;
      try {
        list = await loadPlaylistSource(ws, id);
      } catch (error) {
        console.error(`Error loading playlist ${id}:`, error.message);
        app.send(ws, Commands.ERROR, { message: lists.errorMessage(error) });
        return;
      }
      const wasEmpty = player.playlist.length === 0;
      let added = 0;
      let duplicates = 0;
      for (const item of list.items) {
        if (player.playlist.length >= MAX_PLAYLIST_IMPORT) break;
        if (app._isDuplicateVideo(player, item.link)) { duplicates++; continue; }
        player.playlist.push(app._createVideoObject(item, ws.u, 'scraper'));
        added++;
      }
      const full = player.playlist.length >= MAX_PLAYLIST_IMPORT && added + duplicates < list.items.length;
      app.send(ws, Commands.ERROR, {
        message: `Added ${added} video${added === 1 ? '' : 's'} from "${list.title}".`
          + (duplicates ? ` ${duplicates} already in the playlist.` : '')
          + (full ? ` The playlist is full (${MAX_PLAYLIST_IMPORT}).` : '')
          + skippedNote(list.skipped)
      });
      if (!added) return;
      if (wasEmpty) {
        player.currentTrack = 0;
        player.currentTime = 0;
        player.lastStartTime = new Date().getTime() / 1000;
        player.sockets.forEach(socket => {
          app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, track: player.playlist[player.currentTrack], paused: player.paused, newLastStartTime: player.lastStartTime, playlist: player.playlist });
        });
      } else {
        player.sockets.forEach(socket => {
          app.send(socket, Commands.PLAYLIST_UPDATED, { playlist: player.playlist, currentTrack: player.currentTrack });
        });
      }
      await app.savePlayerState(ws.i);
    }, player.locked);
    return;
  }

  app.onlyIfHost(ws, async () => {
    if (!(player.playlist.length === 0 || data.shouldClear)) return;
    let list;
    try {
      list = await loadPlaylistSource(ws, id);
    } catch (error) {
      console.error(`Error loading playlist ${id}:`, error.message);
      app.send(ws, Commands.ERROR, { message: lists.errorMessage(error) });
      return;
    }
    if (!list.items.length) {
      app.send(ws, Commands.ERROR, { message: `Nothing in "${list.title}" can be played here.${skippedNote(list.skipped)}` });
      return;
    }

    app.resetPlaylist(ws); // Resets playlist, currentTime, currentTrack
    for (const item of list.items) {
      if (player.playlist.length >= MAX_PLAYLIST_IMPORT) break;
      if (app._isDuplicateVideo(player, item.link)) continue;
      player.playlist.push(app._createVideoObject(item, ws.u, 'scraper'));
    }
    if (list.skipped > 0) {
      app.send(ws, Commands.ERROR, { message: `Loaded ${player.playlist.length} videos from "${list.title}".${skippedNote(list.skipped)}` });
    }

    if (player.playlist.length > 0) {
      player.lastStartTime = new Date().getTime() / 1000;
      player.sockets.forEach(socket => {
        app.send(socket, Commands.TRACK_CHANGED, { newTrackIndex: player.currentTrack, track: player.playlist[player.currentTrack], paused: player.paused, newLastStartTime: player.lastStartTime, playlist: player.playlist });
      });
    } else {
      app.updateClients(ws.i); // This is fine, sends an empty playlist.
    }
    await app.savePlayerState(ws.i);
  });
}

/**
 * Sends a client the contents of a playlist source without changing the room's playlist, for
 * browsing saved lists (the Lists view). Anyone may look; adding still goes through the usual
 * commands and their permissions.
 *
 * @param {Object} app - Express application and state controller.
 * @param {Object} ws - Client WebSocket asking.
 * @param {Object} data
 * @param {string} data.id - YouTube playlist URL or ID, or a list link.
 * @returns {Promise<void>}
 */
async function previewList(app, ws, data) {
  const id = data && typeof data.id === 'string' ? data.id.trim().slice(0, 2000) : '';
  const reply = (body) => app.send(ws, Commands.LIST_PREVIEW_RESULT, { id, ...body });
  if (!id || !lists.isPlaylistSource(id)) {
    reply({ error: "That is not a YouTube playlist or a list of links." });
    return;
  }
  // A few at a time per connection: each can mean many lookups the first time.
  ws.listPreviews = ws.listPreviews || 0;
  if (ws.listPreviews >= 3) {
    reply({ error: 'Still loading other lists. Try again in a moment.' });
    return;
  }
  ws.listPreviews++;
  try {
    const list = await loadPlaylistSource(ws, id);
    reply({ title: list.title, items: list.items, skipped: list.skipped, truncated: list.truncated });
  } catch (error) {
    console.error(`Error previewing playlist ${id}:`, error.message);
    reply({ error: lists.errorMessage(error) });
  } finally {
    ws.listPreviews--;
  }
}

/** Tells everyone in the room the shared Lists changed. */
function broadcastLists(app, player) {
  player.sockets.forEach(socket => app.send(socket, Commands.LISTS_UPDATED, { lists: player.lists }));
}

/**
 * Adds a list to the room's shared Lists, which everyone in the room sees and which is saved with
 * the playlist. The list is loaded first, so only lists that work are saved and they get their
 * real title and size. Saving the same link again moves it to the top with the new title.
 * Allowed for the host, or anyone while the room is unlocked (as for adding a video).
 *
 * @param {Object} app
 * @param {Object} ws
 * @param {{link: string}} data
 */
async function saveList(app, ws, data) {
  const link = data && typeof data.link === 'string' ? data.link.trim().slice(0, 2000) : '';
  const player = app.videoPlayers[ws.i];
  if (!player) return;
  if (!link || !lists.isPlaylistSource(link)) {
    app.send(ws, Commands.ERROR, { message: "That is not a YouTube playlist or a list of links." });
    return;
  }
  app.onlyIfHost(ws, async () => {
    let list;
    try {
      list = await loadPlaylistSource(ws, link);
    } catch (error) {
      app.send(ws, Commands.ERROR, { message: lists.errorMessage(error) });
      return;
    }
    if (!list.items.length) {
      app.send(ws, Commands.ERROR, { message: `Nothing in "${list.title}" can be played here.` });
      return;
    }
    player.lists = (player.lists || []).filter(l => l.link !== link);
    player.lists.unshift({
      id: Math.random().toString(36).slice(2, 10),
      link,
      title: String(list.title || 'Playlist').slice(0, 120),
      count: list.items.length,
      by: ws.u && ws.u.id ? { id: ws.u.id, name: String(ws.u.name || '').slice(0, 60) } : null,
      at: Date.now()
    });
    player.lists = player.lists.slice(0, MAX_SAVED_LISTS);
    broadcastLists(app, player);
    app.send(ws, Commands.ERROR, { message: `Saved "${player.lists[0].title}" to Lists for everyone here.` });
    await app.savePlayerState(ws.i);
  }, player.locked);
}

/**
 * Removes one of the room's shared Lists. Same rule as saving.
 *
 * @param {Object} app
 * @param {Object} ws
 * @param {{id: string}} data
 */
async function removeList(app, ws, data) {
  const id = data && typeof data.id === 'string' ? data.id : '';
  const player = app.videoPlayers[ws.i];
  if (!player || !id) return;
  app.onlyIfHost(ws, async () => {
    const before = (player.lists || []).length;
    player.lists = (player.lists || []).filter(l => l.id !== id);
    if (player.lists.length === before) return;
    broadcastLists(app, player);
    await app.savePlayerState(ws.i);
  }, player.locked);
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
  previewList,
  saveList,
  removeList,
  clearPlaylist,
  addAndPlay,
  addAndPlayNext,
  setVote,
  updateVotes
};