const { SearchTypes, YouTubeURL } = require('./constants.js');
const Util = require('./util.js');
const ytdl = require('@distube/ytdl-core');

class Scraper {
  /**
   * @param {string} [language = 'en'] An IANA Language Subtag, see => http://www.iana.org/assignments/language-subtag-registry/language-subtag-registry
   */
  constructor(language = 'en') {
    this._lang = language;
    // Prioritize using a full, authenticated cookie string from an environment variable.
    // This is the most reliable way to bypass advanced bot-detection and CAPTCHAs.
    // If the environment variable is not set, it falls back to the basic consent cookie.
    const cookieString = process.env.YOUTUBE_COOKIE_STRING || this._getRequestHeaders().Cookie;

    if (process.env.YOUTUBE_COOKIE_STRING) {
      console.log("Found YOUTUBE_COOKIE_STRING. Creating ytdl-core agent with full authentication cookies.");
    } else {
      console.log("No YOUTUBE_COOKIE_STRING found. Creating ytdl-core agent with default consent cookie.");
    }

    const cookies = cookieString.split(';').map(c => {
      const [name, ...valueParts] = c.split('=');
      const cookieName = name.trim();
      return {
        name: cookieName,
        value: valueParts.join('=').trim(),
        secure: cookieName.startsWith('__Secure-') || cookieName.startsWith('__Host-')
      };
    });
    this._ytdlAgent = ytdl.createAgent(cookies);
  }

  /**
   * @param {Object} json
   */
  _extractData(json) {
    json = json
      .contents
      .twoColumnSearchResultsRenderer
      .primaryContents;

    let contents = [];

    if (json.sectionListRenderer) {
      contents = json.sectionListRenderer.contents.filter((item) =>
        item?.itemSectionRenderer?.contents.filter(x => x.videoRenderer || x.playlistRenderer || x.channelRenderer)
      ).shift().itemSectionRenderer.contents;
    }

    if (json.richGridRenderer) {
      contents = json.richGridRenderer.contents.filter((item) =>
        item.richItemRenderer && item.richItemRenderer.content
      ).map(item => item.richItemRenderer.content);
    }

    return contents;
  }

  /**
   * @private
   * @param {string} [requestedLang=this._lang]
   * @returns {object} The headers for a standard request to YouTube.
   */
  _getRequestHeaders(requestedLang = this._lang) {
    return {
      'Accept-Language': requestedLang,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Cookie': 'CONSENT=YES+yt.4000000000.en+FX+789' // Bypass YouTube's consent screen
    };
  }
  /**
   * @private
   * @param {string} search_query
   * @param {string} [requestedLang=null]
   * @returns {Promise<string>} The entire YouTube webpage as a string
   */
  async _fetch(search_query, searchType = 'VIDEO', requestedLang = this._lang) {
    if (requestedLang && typeof requestedLang !== 'string') {
      throw new TypeError('The request language property was not a string while a valid IANA language subtag is expected.');
    }

    const sp = SearchTypes[searchType.toUpperCase()] || SearchTypes['VIDEO'];

    const url = new URL(YouTubeURL);
    url.search = new URLSearchParams({ search_query, sp });

    const response = await fetch(url, {
      headers: this._getRequestHeaders(requestedLang),
      dispatcher: this._ytdlAgent.dispatcher,
      redirect: 'manual'
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error('YouTube redirected the request (likely bot detection). Try setting a fresh YOUTUBE_COOKIE_STRING environment variable.');
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch search results: ${response.statusText}`);
    }
    return response.text();
  }

  /**
   * @private
   * @param {string} webPage The YouTube webpage with search results
   * @returns The search data
   */
  _getSearchData(webPage) {
    const startString = 'var ytInitialData = ';
    const start = webPage.indexOf(startString);
    const end = webPage.indexOf(';</script>', start);

    const data = webPage.substring(start + startString.length, end);

    try {
      return JSON.parse(data);
    } catch (e) {
      throw new Error('Failed to parse YouTube search data. YouTube might have updated their site or no results returned.');
    }
  }

  _parseData(data) {
    const results = {
      channels: [],
      playlists: [],
      streams: [],
      videos: []
    };

    for (const item of data) {
      // Ordered in which they would occur the most frequently to decrease cost of these if else statements
      if (Util.isVideo(item))
        results.videos.push(Util.getVideoData(item));
      else if (Util.isPlaylist(item))
        results.playlists.push(Util.getPlaylistData(item));
      else if (Util.isStream(item))
        results.streams.push(Util.getStreamData(item));
      else if (Util.isChannel(item))
        results.channels.push(Util.getChannelData(item));
    }

    return results;
  }

  /**
   * @param {string} query The string to search for on youtube
   */
  async search(query, options = {}) {
    try {
      const webPage = await this._fetch(query, options.searchType, options.language);

      const parsedJson = this._getSearchData(webPage);

      const extracted = this._extractData(parsedJson);
      const parsed = this._parseData(extracted);

      return parsed;
    } catch (error) {
      console.error(`YouTube search failed for "${query}":`, error.message);
      throw error;
    }
  }

  async getVideoByUrl(url) {
    try {
      // Use ytdl-core, a more specialized library for fetching video info,
      // which is generally more robust against YouTube's bot detection.
      // Use getBasicInfo as we only need metadata, not download formats. This is often
      // less likely to be challenged by YouTube's bot detection.
      const videoInfo = await ytdl.getBasicInfo(url, { agent: this._ytdlAgent });
      const details = videoInfo.videoDetails;

      if (!details) {
        throw new Error("Could not retrieve video details from ytdl-core.");
      }

      return {
        title: details.title,
        link: details.video_url,
        thumbnail: details.thumbnails[details.thumbnails.length - 1].url,
        duration: parseInt(details.lengthSeconds, 10) * 1000,
        id: details.videoId,
        channel: {
          name: details.author.name,
          id: details.author.id,
        }
      };
    } catch (error) {
      // Keep detailed logging for any potential errors.
      console.error(`--- ytdl-core Error Diagnostics ---`);
      console.error(`Failed to fetch video info for URL: ${url}`);
      console.error("Full error from ytdl-core:", error);
      console.error(`-----------------------------------`);
      // Re-throw a user-friendly error. play-dl errors can be verbose.
      throw new Error("Video not found or is private/unavailable.");
    }
  }
}
module.exports = Scraper;