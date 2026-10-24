// Turns a non-YouTube link (Twitch, Vimeo, a video file or stream) into a playlist item:
// { title, thumbnail, duration (ms, 0 if not known yet or live), link }.
// When the length isn't known here, the first player to load the video reports it (MEDIA_DURATION).
const MediaSources = require('../public/media-sources.js');

const FETCH_TIMEOUT_MS = 5000;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Twitch has no public API without a key, but its pages carry the title in og:title.
async function fetchPageTitle(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200000);
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (!m) return null;
    return m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  } catch (e) {
    return null;
  }
}

async function resolveMediaLink(link) {
  const media = MediaSources.detect(link);
  if (!media || media.type === 'youtube') return null;
  link = String(link).trim();

  if (media.type === 'twitch') {
    if (media.channel) {
      const page = `https://www.twitch.tv/${media.channel}`;
      const title = await fetchPageTitle(page);
      return {
        title: `${title && !/^twitch$/i.test(title) ? title.replace(/ - (Live on )?Twitch$/i, '') : media.channel} (live on Twitch)`,
        thumbnail: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${media.channel}-320x180.jpg`,
        duration: 0, // live: plays until someone skips
        link: page
      };
    }
    const page = `https://www.twitch.tv/videos/${media.video}`;
    const title = await fetchPageTitle(page);
    return {
      title: title && !/^twitch$/i.test(title) ? title.replace(/ - (Live on )?Twitch$/i, '') : `Twitch video ${media.video}`,
      thumbnail: '',
      duration: 0,
      link: page
    };
  }

  if (media.type === 'vimeo') {
    try {
      const info = await fetchJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(link)}`);
      return {
        title: String(info.title || `Vimeo video ${media.id}`).slice(0, 200),
        thumbnail: info.thumbnail_url || '',
        duration: Number(info.duration) > 0 ? Number(info.duration) * 1000 : 0,
        link
      };
    } catch (e) {
      // Vimeo only answers for videos that can be embedded on other sites.
      throw new Error("That Vimeo video can't be played here. Its owner may not allow it on other sites.");
    }
  }

  // A file or stream: the player page learns its length when it loads.
  return { title: MediaSources.nameFromLink(link), thumbnail: '', duration: 0, link };
}

module.exports = { resolveMediaLink, detect: MediaSources.detect };
