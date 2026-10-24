// Works out what kind of link a playlist item is, so the server can describe it and the player
// page knows which player to play it with. Shared by the server (require) and the player page.
var MediaSources = (() => {
  // Direct links to a video or audio file, played by the page's own <video> element.
  const FILE_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v|mp3|m4a|wav|flac|aac|opus)$/i;
  // twitch.tv/<these> are site pages, not channels.
  const TWITCH_PAGES = new Set(['videos', 'directory', 'p', 'downloads', 'jobs', 'settings', 'subscriptions',
    'inventory', 'wallet', 'search', 'friends', 'messages', 'drops', 'turbo', 'prime', 'store', 'login', 'signup']);

  function parseUrl(link) {
    try {
      const u = new URL(String(link || '').trim());
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (e) {
      return null;
    }
  }

  // Returns { type, ... } for a link the player can play, or null.
  //   youtube                    - played by the YouTube player, as before
  //   file                       - a video/audio file (.mp4, .webm, .mp3, ...)
  //   hls                        - an HLS stream (.m3u8), live or recorded
  //   twitch  { channel | video } - a live Twitch channel, or a recorded Twitch video (VOD)
  //   vimeo   { id, hash }        - a Vimeo video (hash is the key for unlisted videos)
  function detect(link) {
    const u = parseUrl(link);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    const parts = u.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      return { type: 'youtube' };
    }

    if (host === 'twitch.tv' || host === 'player.twitch.tv') {
      if (host === 'player.twitch.tv') {
        const video = (u.searchParams.get('video') || '').replace(/^v/, '');
        if (/^\d+$/.test(video)) return { type: 'twitch', video };
        const channel = u.searchParams.get('channel') || '';
        return /^[a-zA-Z0-9_]{2,25}$/.test(channel) ? { type: 'twitch', channel: channel.toLowerCase() } : null;
      }
      if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return { type: 'twitch', video: parts[1] };
      // twitch.tv/<channel>, but not a clip (twitch.tv/<channel>/clip/...) or a site page.
      if (parts.length === 1 && /^[a-zA-Z0-9_]{2,25}$/.test(parts[0]) && !TWITCH_PAGES.has(parts[0].toLowerCase())) {
        return { type: 'twitch', channel: parts[0].toLowerCase() };
      }
      return null;
    }

    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, player.vimeo.com/video/123?h=abcdef
      const i = parts.findIndex(p => /^\d+$/.test(p));
      if (i === -1) return null;
      const next = parts[i + 1] || '';
      const hash = u.searchParams.get('h') || (/^[0-9a-f]{6,}$/i.test(next) ? next : '');
      return { type: 'vimeo', id: parts[i], hash };
    }

    if (/\.m3u8$/i.test(u.pathname)) return { type: 'hls' };
    if (FILE_EXT.test(u.pathname)) return { type: 'file' };
    return null;
  }

  // A readable name for a link that has no title of its own (a file, a stream).
  function nameFromLink(link) {
    const u = parseUrl(link);
    if (!u) return 'Video';
    const file = u.pathname.split('/').filter(Boolean).pop() || '';
    let name = file;
    try { name = decodeURIComponent(file); } catch (e) {}
    name = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]+/g, ' ').trim();
    // Streams are often called index.m3u8 or playlist.m3u8, so say where they're from instead.
    if (!name || /^(index|playlist|master|live|stream|chunklist)$/i.test(name)) name = `Stream from ${u.hostname}`;
    return name.slice(0, 120);
  }

  return { detect, nameFromLink, parseUrl };
})();

if ((typeof process !== 'undefined') && process.release && process.release.name.search(/node|io.js/) !== -1) {
  module.exports = MediaSources;
}
