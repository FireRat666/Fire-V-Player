/**
 * @fileoverview YouTube scraper and search client built on Innertube (youtubei.js).
 * Parses search results and individual video metadata into application structures.
 * @module server/youtube/scraper
 */

const Util = require('./util.js');
const { getInnertube } = require('./youtubeiService.js');

/**
 * @typedef {Object} ScrapedVideo
 * @property {string} id - 11-character YouTube video ID.
 * @property {string} title - Video title.
 * @property {string} description - Video description snippet.
 * @property {number} duration - Video duration in milliseconds.
 * @property {string} duration_raw - Formatted duration text (e.g. "3:45").
 * @property {string} uploaded - Upload timestamp or relative string.
 * @property {number} views - Approximate view count.
 * @property {string} link - Full YouTube watch URL.
 * @property {string} shareLink - Shortened youtu.be URL.
 * @property {string} thumbnail - URL of best available thumbnail.
 * @property {Object} channel - Video author/channel details.
 * @property {string} channel.name - Channel name.
 * @property {string} [channel.link] - URL to channel page.
 * @property {string} [channel.id] - Channel identifier.
 * @property {boolean} [channel.verified] - Whether the channel has verified status.
 */

/**
 * @typedef {Object} ScrapedPlaylist
 * @property {string} id - YouTube playlist ID.
 * @property {string} link - Full YouTube playlist URL.
 * @property {string} thumbnail - Thumbnail image URL.
 * @property {string} title - Playlist title.
 * @property {number} videoCount - Number of videos in the playlist.
 */

/**
 * @typedef {Object} SearchResults
 * @property {Array} channels - List of matched channels.
 * @property {Array<ScrapedPlaylist>} playlists - List of matched playlists.
 * @property {Array} streams - List of live streams.
 * @property {Array<ScrapedVideo>} videos - List of matched videos.
 */

/**
 * Scraper class for interacting with YouTube search and video metadata extraction.
 */
class Scraper {
  /**
   * Initializes a new Scraper instance with optional language setting.
   * @param {string} [language = 'en'] - An IANA Language Subtag.
   */
  constructor(language = 'en') {
    this._lang = language;
  }

  /**
   * Searches YouTube for videos and playlists matching a query string.
   *
   * @param {string} query - The search terms.
   * @param {Object} [options = {}] - Optional search configuration.
   * @returns {Promise<SearchResults>} Parsed search results containing lists of videos and playlists.
   */
  async search(query, options = {}) {
    try {
      const yt = await getInnertube();
      const searchResults = await yt.search(query);

      const parsedResults = {
        channels: [],
        playlists: [],
        streams: [],
        videos: []
      };

      const items = (searchResults.results && Array.isArray(searchResults.results))
        ? searchResults.results
        : ((searchResults.contents && Array.isArray(searchResults.contents)) ? searchResults.contents : []);

      items.forEach(node => {
        if (node.type === 'Video' || node.type === 'CompactVideo') {
          const videoId = node.id || node.videoId || node.video_id;
          if (!videoId) return;

          // Extract title
          const title = (node.title && typeof node.title.text === 'string')
            ? node.title.text
            : (typeof node.title === 'string' ? node.title : 'Unknown Title');

          // Extract description
          const description = (node.description && typeof node.description.text === 'string')
            ? node.description.text
            : (node.description_snippet && typeof node.description_snippet.text === 'string'
                ? node.description_snippet.text
                : (node.description_snippet && typeof node.description_snippet === 'object' && typeof node.description_snippet.text === 'string'
                    ? node.description_snippet.text
                    : ''));

          // Extract duration
          let durationSec = 0;
          let duration_raw = '00:00';
          const lenText = node.length_text?.text || node.duration?.text || '';
          if (lenText) {
            duration_raw = lenText;
            const parts = duration_raw.split(':').map(Number);
            if (parts.length === 2) {
              durationSec = parts[0] * 60 + parts[1];
            } else if (parts.length === 3) {
              durationSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
          } else if (node.duration && typeof node.duration.seconds === 'number') {
            durationSec = node.duration.seconds;
            const hrs = Math.floor(durationSec / 3600);
            const mins = Math.floor((durationSec % 3600) / 60);
            const secs = durationSec % 60;
            duration_raw = hrs > 0 
              ? `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
              : `${mins}:${secs.toString().padStart(2, '0')}`;
          }

          // Extract thumbnail
          let thumbnail_url = '';
          if (Array.isArray(node.thumbnails) && node.thumbnails.length > 0) {
            thumbnail_url = node.thumbnails[node.thumbnails.length - 1].url;
          } else if (node.thumbnail && typeof node.thumbnail.url === 'string') {
            thumbnail_url = node.thumbnail.url;
          } else {
            thumbnail_url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
          }

          // Extract author info
          const channelName = node.author?.name || 'Unknown Channel';
          const channelId = node.author?.id || '';
          const channelLink = channelId ? `https://www.youtube.com/channel/${channelId}` : (node.author?.url || '');
          const verified = !!node.author?.is_verified || !!node.author?.is_verified_artist || !!node.author?.is_artist;

          const videoItem = {
            description,
            duration: durationSec * 1000,
            duration_raw,
            uploaded: node.published?.text || node.published || '',
            views: node.view_count?.text ? parseInt(node.view_count.text.replace(/[^0-9]/g, ''), 10) || 0 : 0,
            channel: {
              name: channelName,
              link: channelLink,
              verified
            },
            id: videoId,
            link: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnail: thumbnail_url,
            title: title,
            shareLink: `https://youtu.be/${videoId}`
          };

          parsedResults.videos.push(videoItem);
        } else if (node.type === 'Playlist') {
          const playlistId = node.id || node.playlistId || node.playlist_id;
          if (!playlistId) return;

          const title = (node.title && typeof node.title.text === 'string')
            ? node.title.text
            : (typeof node.title === 'string' ? node.title : 'Unknown Playlist');

          parsedResults.playlists.push({
            id: playlistId,
            link: `https://www.youtube.com/playlist?list=${playlistId}`,
            thumbnail: Array.isArray(node.thumbnails) && node.thumbnails.length > 0 ? node.thumbnails[node.thumbnails.length - 1].url : '',
            title,
            videoCount: node.video_count || 0
          });
        }
      });

      return parsedResults;
    } catch (error) {
      console.error(`YouTube search failed for "${query}":`, error.message);
      return {
        channels: [],
        playlists: [],
        streams: [],
        videos: []
      };
    }
  }

  /**
   * Fetches metadata for a single video by full URL or ID.
   *
   * @param {string} url - The full YouTube URL or watch link.
   * @returns {Promise<ScrapedVideo>} Resolved video metadata object.
   * @throws {Error} If URL is invalid or video cannot be found/accessed.
   */
  async getVideoByUrl(url) {
    try {
      const videoId = Util.getYoutubeId(url);
      if (!videoId) {
        throw new Error("Invalid YouTube URL");
      }

      const yt = await getInnertube();
      const videoInfo = await yt.getInfo(videoId);
      const details = videoInfo.basic_info || {};

      // Extract thumbnail
      let thumbnail_url = '';
      if (details.thumbnail) {
        if (Array.isArray(details.thumbnail) && details.thumbnail.length > 0) {
          thumbnail_url = details.thumbnail[details.thumbnail.length - 1].url;
        } else if (typeof details.thumbnail.url === 'string') {
          thumbnail_url = details.thumbnail.url;
        } else if (Array.isArray(details.thumbnail.thumbnails) && details.thumbnail.thumbnails.length > 0) {
          thumbnail_url = details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1].url;
        }
      }
      if (!thumbnail_url) {
        thumbnail_url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }

      let title = details.title || videoInfo.primary_info?.title?.toString();
      let duration = (details.duration || 0) * 1000;

      let channelName = details.channel?.name || videoInfo.secondary_info?.owner?.author?.name?.toString() || 'Unknown Channel';
      let channelId = details.channel?.id || details.channelId || videoInfo.secondary_info?.owner?.author?.id || '';

      if (!title || title === 'Unknown Title' || duration === 0) {
        try {
          const searchResults = await yt.search(videoId);
          const found = searchResults?.videos?.find(v => v.id === videoId || v.videoId === videoId) || searchResults?.videos?.[0];
          if (found && (found.id === videoId || found.videoId === videoId)) {
            if (!title || title === 'Unknown Title') {
              title = found.title?.toString();
            }
            if (duration === 0) {
              const seconds = found.duration?.seconds || found.duration;
              if (typeof seconds === 'number') {
                duration = seconds * 1000;
              }
            }
            if (thumbnail_url.includes('hqdefault.jpg') && found.thumbnail) {
              thumbnail_url = found.thumbnail;
            }
            if (channelName === 'Unknown Channel' && found.channel?.name) {
              channelName = found.channel.name;
            }
          }
        } catch (_) {}
      }

      if (!title) title = 'Unknown Title';

      return {
        title: title,
        link: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: thumbnail_url,
        duration: duration,
        id: videoId,
        channel: {
          name: channelName,
          id: channelId,
        }
      };
    } catch (error) {
      console.error(`--- YouTube.js Error Diagnostics ---`);
      console.error(`Failed to fetch video info for URL: ${url}`);
      console.error("Full error from YouTube.js:", error);
      console.error(`------------------------------------`);
      throw new Error("Video not found or is private/unavailable.");
    }
  }
}

module.exports = Scraper;