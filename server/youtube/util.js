/**
 * @fileoverview Utility functions for parsing YouTube HTML/JSON renderers,
 * extracting video IDs, computing durations, and formatting URLs.
 * @module server/youtube/util
 */

/**
 * Merges source objects into a target object.
 * @param {...Object} args - Objects to merge.
 * @returns {Object} Target merged object.
 */
function assign(...args) {
    return Object.assign(...args);
}

/**
 * Concatenates text segments from YouTube's `runs` array into a single plain text string.
 * @param {Object} key - Object containing a `runs` array.
 * @returns {string} Concatenated text.
 */
const compress = (key) => {
    return (key && key['runs'] ? key['runs'].map((v) => v.text) : []).join('');
}

/**
 * Checks if a channel or video renderer indicates a verified badge.
 * @param {Object} vRender - YouTube renderer object.
 * @returns {boolean} True if verified or verified artist badge is present.
 */
const isChannelVerified = (vRender) => {
    const badges = (vRender['ownerBadges'] ?
        vRender['ownerBadges'].map((badge) => badge['metadataBadgeRenderer']['style']) : []
    );
    return badges.includes('BADGE_STYLE_TYPE_VERIFIED') || badges.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST');
}

/**
 * Extracts channel name, link, and verified status from a renderer's owner field.
 * @param {Object} vRender - Video or playlist renderer.
 * @returns {{name: string, link: string|null, verified: boolean}} Channel metadata.
 */
const getChannelData = (vRender) => {
    const channel = vRender.ownerText?.runs[0];
    if (!channel) return {
        name: 'Unknown Channel',
        link: null,
        verified: false
    };

    // Safely access the URL. YouTube's data structure for this can be inconsistent.
    const channelUrlPath = channel.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
    const channelLink = channelUrlPath ? 'https://www.youtube.com' + channelUrlPath : null;

    return {
        name: channel.text,
        link: channelLink,
        verified: isChannelVerified(vRender)
    };
}

/**
 * Constructs a full channel URL from a channel browse renderer.
 * @param {Object} cRender - Channel renderer.
 * @returns {string} Full channel URL.
 */
const getChannelLink = (cRender) => {
    return 'https://www.youtube.com' + cRender.navigationEndpoint.browseEndpoint.canonicalBaseUrl;
}

/**
 * Extracts numeric video count from a channel renderer.
 * @param {Object} cRender - Channel renderer.
 * @returns {number} Video count.
 */
const getChannelVideoCount = (cRender) => {
    if (!cRender.videoCountText?.runs) return 0;
    return +cRender.videoCountText.runs[0].text;
}

/**
 * Extracts common video metadata (channel, id, links, title, thumbnail) from a renderer.
 * @param {Object} renderer - YouTube video renderer.
 * @returns {Object} Generalized video data.
 */
const getGeneralData = (renderer) => {
    return {
        channel: getChannelData(renderer),
        id: renderer.videoId,
        link: shareLink(renderer.videoId, false),
        thumbnail: idToThumbnail(renderer.videoId),
        title: compress(renderer.title),
        shareLink: shareLink(renderer.videoId)
    };
}

/**
 * Extracts common playlist metadata from a playlist renderer.
 * @param {Object} pRender - YouTube playlist renderer.
 * @returns {Object} Playlist general data.
 */
const getPlaylistGeneralData = (pRender) => {
    const id = pRender.playlistId;

    return {
        channel: getChannelData(pRender),
        id,
        link: 'https://www.youtube.com/playlist?list=' + id,
        thumbnail: getPlaylistThumbnail(pRender),
        title: pRender.title.simpleText
    };
}

/**
 * Extracts the thumbnail image URL for a playlist.
 * @param {Object} pRender - YouTube playlist renderer.
 * @returns {string} Thumbnail image URL.
 */
const getPlaylistThumbnail = (pRender) => {
    return idToThumbnail(pRender.navigationEndpoint.watchEndpoint.videoId);
}

/**
 * Extracts video item data formatted for playlist item previews.
 * @param {Object} renderer - Child video renderer within playlist.
 * @returns {Object} Playlist child video item.
 */
const getPlaylistVideoData = (renderer) => {
    return {
        duration: parseDuration(renderer),
        duration_raw: renderer.lengthText ? renderer.lengthText.simpleText : '00:00:00',
        id: renderer.videoId,
        link: shareLink(renderer.videoId, false),
        thumbnail: idToThumbnail(renderer.videoId),
        title: compress(renderer),
        shareLink: shareLink(renderer.videoId)
    };
}

/**
 * Extracts publication date text from a video renderer.
 * @param {Object} vRender - Video renderer.
 * @returns {string} Upload date text.
 */
const getUploadDate = (vRender) => {
    return vRender['publishedTimeText'] ? vRender['publishedTimeText']['simpleText'] : '';
}

/**
 * Parses total view count from video renderer view count text.
 * @param {Object} vRender - Video renderer.
 * @returns {number} View count.
 */
const getViews = (vRender) => {
    if (!vRender.viewCountText?.simpleText) return 0;
    return +vRender.viewCountText.simpleText.replace(/[^0-9]/g, '');
}

/**
 * Parses current concurrent viewer count for live streams.
 * @param {Object} vRender - Stream video renderer.
 * @returns {number} Current viewer count.
 */
const getWatching = (vRender) => {
    if (!vRender.viewCountText?.runs) return 0;
    return +vRender.viewCountText.runs[0].text.replace(/[^0-9]/g, '');
}

/**
 * Generates the canonical YouTube high quality thumbnail URL for a video ID.
 * @param {string} id - YouTube video ID.
 * @returns {string} Direct URL to `hqdefault.jpg`.
 */
const idToThumbnail = function(id) {
    // Use hqdefault.jpg as it is more reliable and guaranteed to exist for public videos.
    // maxresdefault.jpg is not always available, which can lead to broken thumbnail images.
    // This also makes it consistent with the database re-hydration logic in app.js.
    return 'https://i.ytimg.com/vi/'+ id +'/hqdefault.jpg';
}

/**
 * Parses HH:MM:SS lengthText into duration in milliseconds.
 * @param {Object} vRender - Video renderer containing lengthText.
 * @returns {number} Duration in milliseconds.
 */
const parseDuration = (vRender) => {
    if (!vRender.lengthText?.simpleText) return 0;

    const nums = vRender.lengthText.simpleText.split(':');
    let time = nums.reduce((a, t) => (60 * a) + +t) * 1e3;

    return time;
}

/**
 * Generates a YouTube share link (shortened youtu.be or full watch URL).
 * @param {string} id - YouTube video ID.
 * @param {boolean} [short=true] - True for youtu.be link, false for full watch URL.
 * @returns {string} Formatted URL.
 */
const shareLink = (id, short = true) => {
    return short ? 'https://youtu.be/'+ id : 'https://www.youtube.com/watch?v='+ id;
}

/**
 * Extracts the 11-character YouTube video ID from a URL or raw string.
 * Supports standard watch, short (youtu.be), embed, shorts, and legacy formats.
 * @param {string} url - The YouTube URL or string.
 * @returns {string|false} The 11-character video ID, or false if not matched.
 */
exports.getYoutubeId = (url) => {
    if (!url) return false;
    url = url.trim();
    if (url.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(url)) {
        return url;
    }
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : false;
};

/**
 * Parses complete channel data from a search channel renderer.
 * @param {Object} item - Channel search result item.
 * @returns {Object} Channel metadata.
 */
exports.getChannelData = (item) => {
    const cRender = item.channelRenderer;
    const id = cRender.channelId;

    return {
        channelId: id,
        description: compress(cRender.descriptionSnippet),
        link: getChannelLink(cRender),
        thumbnails: cRender.thumbnail.thumbnails,
        subscribed: cRender.subscriptionButton.subscribed,
        uploadedVideos: getChannelVideoCount(cRender),
        verified: isChannelVerified(cRender)
    };
};

/**
 * Parses playlist data and video previews from a search playlist renderer.
 * @param {Object} item - Playlist search result item.
 * @returns {Object} Playlist data with previews.
 */
exports.getPlaylistData = (item) => {
    const pRender = item.playlistRenderer;
    const preview = [];

    pRender.videos.forEach(video => preview.push(
        getPlaylistVideoData(video.childVideoRenderer)
    ));

    return assign({
        preview,
        videoCount: +pRender['videoCount']
    }, getPlaylistGeneralData(pRender));
}

/**
 * Parses live stream details from a live stream video renderer.
 * @param {Object} item - Stream search result item.
 * @returns {Object} Live stream data.
 */
exports.getStreamData = (item) => {
    const vRender = item.videoRenderer;

    return assign({
        watching: getWatching(vRender)
    }, getGeneralData(vRender))
}

/**
 * Parses standard video item data from a video renderer.
 * @param {Object} item - Video search result item.
 * @returns {Object} Full video item data.
 */
exports.getVideoData = (item) => {
    const vRender = item.videoRenderer;

    return assign({
        description: compress(vRender.descriptionSnippet),
        duration: parseDuration(vRender),
        duration_raw: vRender.lengthText ? vRender.lengthText.simpleText : '00:00:00',
        uploaded: getUploadDate(vRender),
        views: getViews(vRender)
    }, getGeneralData(vRender));
};

/** Checks if an item represents a channel renderer. @param {Object} item @returns {boolean} */
exports.isChannel = (item) => typeof item.channelRenderer !== 'undefined';
/** Checks if an item represents a playlist renderer. @param {Object} item @returns {boolean} */
exports.isPlaylist = (item) => typeof item.playlistRenderer !== 'undefined';
/** Checks if an item represents a live stream renderer. @param {Object} item @returns {boolean} */
exports.isStream = (item) => item.videoRenderer && !item.videoRenderer.lengthText;
/** Checks if an item represents a standard video renderer. @param {Object} item @returns {boolean} */
exports.isVideo = (item) => item.videoRenderer && item.videoRenderer.lengthText;