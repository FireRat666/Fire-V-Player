let innertubePromise = null;

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      console.log("Loading youtubei.js dynamically...");
      const { Innertube } = await import('youtubei.js');
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
  getInnertube
};
