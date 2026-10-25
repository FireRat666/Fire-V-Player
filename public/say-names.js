/**
 * @fileoverview Loader script for in-world TTS user name and event announcements.
 * Parses configuration from script attributes or URL parameters and injects the announcer SDK.
 * @module public/say-names
 */

const currentScript = document.currentScript;
const urlParams = new URLSearchParams(window.location.search);
const params = {};

/**
 * Reads a parameter value from the script's own DOM attributes, falling back to URL search params,
 * and finally to a default value.
 *
 * @param {string} attr - The attribute or search query key.
 * @param {string} defaultValue - Default fallback value if not specified.
 * @returns {void}
 */
function setOrDefault(attr, defaultValue) {
  const value = currentScript.getAttribute(attr);
  params[attr] = value || (urlParams.has(attr) ? urlParams.get(attr) : defaultValue);
}

// Parse all the relevant parameters.
// Note: 'announce' and 'announce-events' are typically passed via URL params or on the core script tag.
// 'four-twenty' is passed as a direct attribute to this script.
setOrDefault("announce", 'true');
setOrDefault("announce-events", 'true');
setOrDefault("four-twenty", 'false');

// Create the new script element for the main announcer logic.
const announcerScript = document.createElement("script");
announcerScript.id = "announcer";
announcerScript.setAttribute("src", "https://firer.at/scripts/announcer.js");

// Map the parsed parameters to the attributes required by the new script.
announcerScript.setAttribute("announce", params["announce"]);
announcerScript.setAttribute("announce-events", params["announce-events"]);
announcerScript.setAttribute("announce-420", params["four-twenty"]);

// Append the configured script to the body to load and execute it.
document.body.appendChild(announcerScript);
