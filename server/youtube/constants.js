/**
 * @fileoverview Constants and enum values used for YouTube search queries and URL parameters.
 * @module server/youtube/constants
 */

/**
 * YouTube search type parameter filters (sp query parameter tokens).
 * @readonly
 * @enum {string}
 */
exports.SearchTypes = {
    ANY: "CAA%3D",
    CHANNEL: "EgIQAg%3D%3D",
    LIVE: "EgJAAQ%3D%3D",
    MOVIE: "EgIQBA%3D%3D",
    PLAYLIST: "EgIQAw%3D%3D",
    VIDEO: "EgIQAQ%3D%3D"
};

/**
 * Base search results URL for YouTube.
 * @type {URL}
 */
exports.YouTubeURL = new URL('https://www.youtube.com/results');