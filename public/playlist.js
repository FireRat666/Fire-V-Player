// Playlist mode entry point, added to a world page as a <script> tag.
// See USAGE.md. For the SideQuest/Altspace Creator SDK, snippet.js (<bs-snippet>) also works.
(() => {
  // Capture the current script element immediately, before any async work.
  const playlistPlayerScript = document.currentScript;
  const currentScriptUrl = new URL(playlistPlayerScript.src);

  const start = () => window.FireVPlayer.startPlaylistPlayer(playlistPlayerScript);

  if (window.FireVPlayer && window.FireVPlayer.startPlaylistPlayer) {
    start();
    return;
  }
  const s = document.createElement("script");
  s.setAttribute("src", `${currentScriptUrl.origin}/playlist-player.js`);
  s.addEventListener("load", start, false);
  s.addEventListener("error", () => console.error("Vidya: failed to load playlist-player.js"), false);
  document.body.appendChild(s);
})();
