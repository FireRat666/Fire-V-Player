let innertubePromise = null;
let libraryPromise = null;

async function getLibrary() {
  if (!libraryPromise) {
    libraryPromise = import('youtubei.js').catch(err => {
      console.error("Failed to import youtubei.js:", err);
      libraryPromise = null; // Reset so next caller can retry
      throw err;
    });
  }
  return libraryPromise;
}

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      console.log("Loading youtubei.js dynamically...");
      const library = await getLibrary();
      const { Innertube, Parser, Helpers, YTNodes, YT, InnertubeError, Log, Misc } = library;
      const { YTNode } = Helpers;
      const { NavigationEndpoint } = YTNodes;

      // Suppress JIT parser warnings by setting log level to ERROR
      if (Log && Log.setLevel && Log.Level) {
        Log.setLevel(Log.Level.ERROR);
        console.log("Configured YouTube.js log level to ERROR.");
      }

      if (!Parser.hasParser('ContinuationItemView')) {
        class ContinuationItemView extends YTNode {
          static type = 'ContinuationItemView';
          trigger;
          endpoint;
          constructor(data) {
            super();
            this.trigger = data.trigger;
            this.endpoint = new NavigationEndpoint(data.continuationCommand);
          }
        }
        Parser.addRuntimeParser('ContinuationItemView', ContinuationItemView);
        console.log("Registered custom parser for ContinuationItemView.");
      }

      if (!Parser.hasParser('VerticalProductCard')) {
        const { Thumbnail } = Misc;
        class VerticalProductCard extends YTNode {
          static type = 'VerticalProductCard';
          title;
          thumbnail;
          endpoint;
          price;
          accessibility_title;
          merchant_name;
          from_merchant_text;
          show_open_in_new_icon;
          use_new_style;
          deals_data;
          price_replacement_text;

          constructor(data) {
            super();
            this.title = data.title;
            this.thumbnail = Thumbnail.fromResponse(data.thumbnail);
            this.endpoint = new NavigationEndpoint(data.navigationEndpoint);
            this.price = data.price;
            this.accessibility_title = data.accessibilityTitle;
            this.merchant_name = data.merchantName;
            this.from_merchant_text = data.fromMerchantText;
            this.show_open_in_new_icon = data.showOpenInNewIcon;
            this.use_new_style = data.useNewStyle;
            this.deals_data = {
              current_price: data.dealsData ? data.dealsData.currentPrice : undefined
            };
            this.price_replacement_text = Reflect.has(data, 'priceReplacementText') ? data.priceReplacementText : undefined;
          }
        }
        Parser.addRuntimeParser('VerticalProductCard', VerticalProductCard);
        console.log("Registered custom parser for VerticalProductCard.");
      }

      // Runtime prototype patches to support LockupView and ContinuationItemView in playlists
      if (YT && YT.Playlist && !YT.Playlist.prototype._isPatched) {
        const { observe } = Helpers;

        Object.defineProperty(YT.Playlist.prototype, 'videos', {
          get() {
            return observe(
              this.memo.getType(
                YTNodes.Video,
                YTNodes.GridVideo,
                YTNodes.ReelItem,
                YTNodes.ShortsLockupView,
                YTNodes.CompactVideo,
                YTNodes.LockupView,
                YTNodes.PlaylistVideo,
                YTNodes.PlaylistPanelVideo,
                YTNodes.WatchCardCompactVideo
              ).filter((item) => {
                return item.constructor.name !== 'LockupView' || 
                       ['VIDEO', 'MOVIE', 'SHORT'].includes(item.content_type);
              })
            );
          },
          configurable: true
        });

        Object.defineProperty(YT.Playlist.prototype, 'items', {
          get() {
            const playlistVideo = YTNodes.PlaylistVideo;
            const reelItem = YTNodes.ReelItem;
            const shortsLockupView = YTNodes.ShortsLockupView;
            const lockupView = YTNodes.LockupView;
            
            return observe(
              this.videos.as(playlistVideo, reelItem, shortsLockupView, lockupView)
                .filter((video) => video.style !== 'PLAYLIST_VIDEO_RENDERER_STYLE_RECOMMENDED_VIDEO')
            );
          },
          configurable: true
        });

        Object.defineProperty(YT.Playlist.prototype, 'has_continuation', {
          get() {
            const section_list = this.memo.getType(YTNodes.SectionList)[0];
            if (!section_list) {
              const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(YT.Playlist.prototype), 'has_continuation');
              return descriptor.get.call(this);
            }
            const continuation_items = [
              ...this.memo.getType(YTNodes.ContinuationItem),
              ...(this.memo.get('ContinuationItemView') || [])
            ];
            return !!continuation_items.find((node) => !section_list.contents.includes(node));
          },
          configurable: true
        });

        YT.Playlist.prototype.getContinuationData = async function() {
          const section_list = this.memo.getType(YTNodes.SectionList)[0];
          if (!section_list) {
            const superGetContinuationData = Object.getPrototypeOf(YT.Playlist.prototype).getContinuationData;
            return await superGetContinuationData.call(this);
          }
          
          const continuation_items = [
            ...this.memo.getType(YTNodes.ContinuationItem),
            ...(this.memo.get('ContinuationItemView') || [])
          ];
          const playlist_contents_continuation = continuation_items.find((node) => !section_list.contents.includes(node));
          
          if (!playlist_contents_continuation) {
            throw new InnertubeError('There are no continuations.');
          }
          
          if (playlist_contents_continuation.endpoint) {
            return await playlist_contents_continuation.endpoint.call(this.actions, { parse: true });
          }
          
          throw new InnertubeError('Continuation endpoint is missing.');
        };

        YT.Playlist.prototype._isPatched = true;
        console.log("Applied runtime prototype patches to YT.Playlist.");
      }

      const cookieString = process.env.YOUTUBE_COOKIE_STRING;
      const config = {};
      
      if (cookieString) {
        config.cookie = cookieString;
        console.log("Found YOUTUBE_COOKIE_STRING. Initializing Innertube with cookies.");
      } else {
        console.log("No YOUTUBE_COOKIE_STRING found. Initializing Innertube with default settings.");
      }
      
      return Innertube.create(config);
    })().catch(err => {
      console.error("Failed to initialize Innertube:", err);
      innertubePromise = null; // Reset promise so next caller can retry
      throw err;
    });
  }
  return innertubePromise;
}

module.exports = {
  getInnertube,
  getLibrary
};
