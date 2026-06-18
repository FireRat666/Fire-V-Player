const Util = require('./util.js');
const { getInnertube } = require('./youtubeiService.js');

class Scraper {
  /**
   * @param {string} [language = 'en'] An IANA Language Subtag
   */
  constructor(language = 'en') {
    this._lang = language;
  }

  /**
   * Searches YouTube for videos and playlists.
   * @param {string} query The string to search for on YouTube.
   * @param {Object} [options = {}] Options for search.
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
   * Fetches metadata for a single video.
   * @param {string} url The full YouTube URL of the video.
   */
  async getVideoByUrl(url) {
    try {
      const videoId = Util.getYoutubeId(url);
      if (!videoId) {
        throw new Error("Invalid YouTube URL");
      }

      const yt = await getInnertube();
      const videoInfo = await yt.getBasicInfo(videoId);
      const details = videoInfo.basic_info;

      if (!details) {
        throw new Error("Could not retrieve video details from YouTube.js.");
      }

      // Extract thumbnail
      let thumbnail_url = '';
      if (Array.isArray(details.thumbnail) && details.thumbnail.length > 0) {
        thumbnail_url = details.thumbnail[details.thumbnail.length - 1].url;
      } else if (details.thumbnail && typeof details.thumbnail.url === 'string') {
        thumbnail_url = details.thumbnail.url;
      } else if (details.thumbnail && Array.isArray(details.thumbnail.thumbnails) && details.thumbnail.thumbnails.length > 0) {
        thumbnail_url = details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1].url;
      } else {
        thumbnail_url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }

      return {
        title: details.title || 'Unknown Title',
        link: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: thumbnail_url,
        duration: (details.duration || 0) * 1000,
        id: videoId,
        channel: {
          name: details.channel?.name || 'Unknown Channel',
          id: details.channel?.id || details.channelId || '',
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