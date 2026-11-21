#!/usr/bin/env node
// Makes public/i18n/<code>.js, the playlist panel's translations, with LibreTranslate.
//
//   node scripts/translate-i18n.js                 # ja, fr and de, from http://127.0.0.1:5000
//   node scripts/translate-i18n.js --lang ja       # one language
//   node scripts/translate-i18n.js --force         # translate everything again
//   node scripts/translate-i18n.js --list          # just print the strings it found
//   LIBRETRANSLATE_URL=https://... LIBRETRANSLATE_KEY=... node scripts/translate-i18n.js
//   LIBRETRANSLATE_DOCKER=libretranslate node scripts/translate-i18n.js
//       # asks the server inside that Docker container (docker exec), for when its port isn't
//       # reachable from the host
//
// It reads the English text out of the panel's scripts (FILES): each quoted string that reads as
// words, with a symbol in front ("+ Add") left off, as setText looks it up without one. Strings
// already in a language's file are kept, so a translation corrected by hand stays; one the panel
// no longer has is dropped. {words} in a string are kept out of the translation and put back.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['public/playlist-panel.js'];
const OUT_DIR = path.join(ROOT, 'public', 'i18n');
const URL_BASE = (process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const API_KEY = process.env.LIBRETRANSLATE_KEY || '';
const LANGS = ['ja', 'fr', 'de'];
const BATCH = 40;

// Strings that are names, not words to translate.
const KEEP = new Set(['Fire-V-Player', 'Fire-V-Player Karaoke', 'YouTube', 'Archive Films', 'Tubi', 'NASA+', 'ESO', 'ESO Fulldome',
  'Screen Share', 'Go Live', 'LIVE', 'CC', 'FireRat', 'English', 'Français', 'Deutsch', '日本語',
  'Dropbox', 'Twitch', 'Vimeo', 'VDO.Ninja', 'Google Drive',
  // Not shown in the panel: log lines, timeout names, words added to a search, a key name.
  'Panel destroyed during build', 'Loading the panel language', 'Using the UI Kit', 'No UI Kit in this app, using the plain look',
  '(scrolling list)', 'zoom karaoke', 'Enter']);
// Not shown either: what a Unity call that timed out was doing, object and shader names.
const SKIP = /^(Adding|Creating|Making|Moving|Naming) the |_|\w\/\w/;

function args() {
  const a = process.argv.slice(2);
  const out = { force: a.includes('--force'), langs: LANGS };
  const i = a.indexOf('--lang');
  if (i >= 0 && a[i + 1]) out.langs = a[i + 1].split(',');
  return out;
}

// The panel's English strings.
function extract() {
  const found = new Set();
  for (const file of FILES) {
    for (let text of literals(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      text = text.replace(/^[^\p{L}\p{N}{]+?\s/u, '').trim();
      if (isWords(text)) found.add(text);
    }
  }
  return [...found].sort();
}

// The string literals in a script, and template literals without ${}, skipping comments and
// regular expressions; the strings inside a template's ${} are read too.
function literals(src) {
  const out = [];
  let i = 0;
  let prev = ''; // the last thing that wasn't space, to tell a regex from a division
  const unescape = raw => raw.replace(/\\(u\{?[0-9a-fA-F]+\}?|.)/g, (m, c) => {
    if (c[0] === 'u') return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16));
    return ({ n: '\n', t: '\t', r: '' })[c] ?? c;
  });
  // Reads from i to the closing `}` of a ${ (depth 0 at the end of the file).
  function code(stopAtBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) i = src.length; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        out.push(unescape(src.slice(i + 1, j)));
        i = j + 1; prev = 'x'; continue;
      }
      if (c === '`') { i++; template(); prev = 'x'; continue; }
      if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === '' || /\breturn$/.test(src.slice(Math.max(0, i - 8), i).trim()))) {
        // A regular expression: to its closing / (not one in a [class]).
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
          j++;
        }
        i = j + 1; prev = 'x'; continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (stopAtBrace && depth === 0) { i++; return; }
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  function template() {
    let text = '', plain = true;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { plain = false; i += 2; code(true); continue; }
      text += src[i++];
    }
    i++;
    if (plain) out.push(unescape(text));
  }
  code(false);
  return out;
}

function isWords(t) {
  if (!t || t.length < 2 || KEEP.has(t) || SKIP.test(t)) return false;
  if (!/\p{L}{2}/u.test(t)) return false;
  if (/^\[|^#|^\.|^\/|^@|^fvp|https?:|rgba?\(|\d+px|%$|\.(png|js|json|txt)\b|=>|\(\)|^[\w-]+:[\w-]/.test(t)) return false;
  if (/^[a-z][\w-]*$/.test(t)) return false;            // identifiers, keys, lower-case words (search words)
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t)) return false; // camelCase
  if (/^[A-Z_]+$/.test(t)) return false;                // CONSTANTS
  if (/^(flex|row|column|center|bold|nowrap|hidden|scroll|normal|absolute|none|auto)/.test(t) && !/\s/.test(t)) return false;
  return /\s/.test(t) || /^\p{Lu}/u.test(t);
}

// {words} out of the way of the translator, and back.
function protect(text) {
  const vars = [];
  const out = text.replace(/\{(\w+)\}/g, (m) => { vars.push(m); return `[${vars.length - 1}]`; });
  return { out, vars };
}
function restore(text, vars) {
  let ok = true;
  const out = vars.reduce((t, v, i) => {
    const re = new RegExp(`\\[\\s*${i}\\s*\\]`);
    if (!re.test(t)) { ok = false; return t; }
    return t.replace(re, v);
  }, text);
  return ok ? out : null;
}

// Posts to the server from inside its container, with the container's own Python.
const DOCKER_PY = 'import sys,urllib.request;r=urllib.request.Request("http://127.0.0.1:5000/translate",data=sys.stdin.buffer.read(),headers={"Content-Type":"application/json"});sys.stdout.buffer.write(urllib.request.urlopen(r,timeout=600).read())';

async function translate(texts, target) {
  const body = { q: texts, source: 'en', target, format: 'text' };
  if (API_KEY) body.api_key = API_KEY;
  if (process.env.LIBRETRANSLATE_DOCKER) {
    const { execFileSync } = require('child_process');
    const raw = execFileSync('docker', ['exec', '-i', process.env.LIBRETRANSLATE_DOCKER, 'python3', '-c', DOCKER_PY],
      { input: JSON.stringify(body), maxBuffer: 16 * 1024 * 1024 });
    const out = JSON.parse(raw.toString('utf8')).translatedText;
    return Array.isArray(out) ? out : [out];
  }
  const res = await fetch(`${URL_BASE}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`LibreTranslate said ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const out = json.translatedText;
  return Array.isArray(out) ? out : [out];
}

function readExisting(code) {
  const file = path.join(OUT_DIR, `${code}.js`);
  if (!fs.existsSync(file)) return {};
  const src = fs.readFileSync(file, 'utf8');
  // The object after FVP_STRINGS["code"] = (the line before it has a {} of its own).
  const start = src.indexOf('{', src.indexOf(`FVP_STRINGS["${code}"]`));
  const json = src.slice(start, src.lastIndexOf('}') + 1);
  try { return JSON.parse(json); } catch (e) { console.warn(`${code}.js isn't readable, starting again:`, e.message); return {}; }
}

function write(code, dict) {
  const sorted = Object.fromEntries(Object.keys(dict).sort().map(k => [k, dict[k]]));
  const src = `// The playlist panel in ${code}: English -> translation. Made by scripts/translate-i18n.js with\n`
    + `// LibreTranslate (machine translation); corrections by hand are kept when it runs again.\n`
    + `var FVP_STRINGS = typeof FVP_STRINGS === 'undefined' ? {} : FVP_STRINGS;\n`
    + `FVP_STRINGS[${JSON.stringify(code)}] = ${JSON.stringify(sorted, null, 2)};\n`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${code}.js`), src);
}

async function main() {
  const { force, langs } = args();
  const strings = extract();
  if (process.argv.includes('--list')) return console.log(strings.join('\n'));
  console.log(`${strings.length} strings in the panel.`);
  for (const code of langs) {
    const old = force ? {} : readExisting(code);
    const dict = {};
    for (const s of strings) if (old[s]) dict[s] = old[s];
    const todo = strings.filter(s => !dict[s]);
    console.log(`${code}: ${todo.length} to translate, ${strings.length - todo.length} kept.`);
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      const prepared = chunk.map(protect);
      const out = await translate(prepared.map(p => p.out), code);
      chunk.forEach((s, k) => {
        const back = out[k] != null ? restore(String(out[k]), prepared[k].vars) : null;
        if (back) dict[s] = back;
        else console.warn(`  ${code}: lost a {word} in "${s}" -> "${out[k]}", left in English`);
      });
      process.stdout.write(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}\r`);
    }
    write(code, dict);
    console.log(`\n${code}: wrote public/i18n/${code}.js (${Object.keys(dict).length} strings).`);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
