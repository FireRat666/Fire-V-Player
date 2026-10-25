/**
 * @fileoverview Karaoke mode script tag entry point for in-world HTML pages.
 * Captures script attributes and delegates startup to `FireVPlayer.startKaraokePlayer`.
 * @module public/karaoke
 */

(() => {
  // Capture the current script element immediately, before any async work.
  const karaokePlayerScript = document.currentScript;
  const currentScriptUrl = new URL(karaokePlayerScript.src);

  const start = () => window.FireVPlayer.startKaraokePlayer(karaokePlayerScript);

  if (window.FireVPlayer && window.FireVPlayer.startKaraokePlayer) {
    start();
    return;
  }
  const s = document.createElement("script");
  s.setAttribute("src", `${currentScriptUrl.origin}/playlist-player.js`);
  s.addEventListener("load", start, false);
  s.addEventListener("error", () => console.error("Vidya: failed to load playlist-player.js"), false);
  document.body.appendChild(s);
})();
