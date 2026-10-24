# Usage & Embedding Guide

Fire-V-Player is designed to be embedded in the **Banter** VR social platform, and in SideQuest/Altspace Creator SDK worlds (see [Snippet](#sidequest--altspace-creator-sdk-snippet)). Its behavior is configured through attributes on a single `<script>` tag, or a `<bs-snippet>` element.

## Modes

The player has two primary modes, determined by which script you include (or, for a snippet, its `karaoke` checkbox):

- **Playlist Mode:** The default collaborative player. Use `playlist.js`, or leave the snippet's `karaoke` unticked.
- **Karaoke Mode:** A turn-based system where users join a queue to sing. Use `karaoke.js`, or tick the snippet's `karaoke`.

That choice is the default. In a Creator SDK world a space admin can switch the mode in world from the panel; see [Switching mode in world](#switching-mode-in-world).

## Basic Example (Playlist Mode)

```html
<!-- This script is intended to be used within a Banter world's HTML. -->
<script
  src="https://vidya.firer.at/playlist.js"
  instance="my-private-room"
  playlist="PLZWiw-xxQ4SPDmADhvme7-pU2bx3s7nKX"
  volume="10"
  hand-controls="true"
  position="0 1.5 -2"
  rotation="0 0 0"
  scale="2 2 2"
></script>
```

## Karaoke Mode Example

To use Karaoke mode, simply change the `src` to point to `karaoke.js`. The player will now operate in a turn-based queue mode.

```html
<script
  src="https://vidya.firer.at/karaoke.js"
  instance="my-karaoke-bar"
  volume="10"
  hand-controls="true"
  position="0 1.5 -2"
  rotation="0 0 0"
  scale="2 2 2"
></script>
```

## SideQuest / Altspace Creator SDK (Snippet)

In a Creator SDK world (`Assets/WebRoot/index.html`), add the player as a snippet. `karaoke="false"` (the default) runs a shared playlist; `karaoke="true"` runs a singer queue instead. Unity's Inspector shows it as a checkbox.

```html
<!-- snippet section -->
<bs-snippet name="fire-v-player" title="Fire-V-Player" single="true"
  description="Synced YouTube player with an in-world panel. Tick karaoke for a singer queue instead of a shared playlist."
  script="https://vidya.firer.at/snippet.js"
  room=""
  karaoke="false"
  playlist="PLZWiw-xxQ4SPDmADhvme7-pU2bx3s7nKX"
  youtube=""
  volume="10"
  mute="false"
  captions="true"
  untrusted-links="false"
  hand-controls="true"
  position="0 1.5 2"
  rotation="0 0 0"
  scale="2"
  resolution="1600"
  spatial="true"
  spatial-min-distance="5"
  spatial-max-distance="40"
  controls-follow-screen="false"
  button-position="0 0.83 2"
  button-rotation=""
  button-scale="1"
  playlist-ui="auto"
  playlist-panel-position="1.8 1.5 1.85"
  playlist-panel-rotation="0 20 0"
  playlist-panel-scale="1"
  singer-button-position="0 1 -1"
  singer-button-rotation="30 180 0">
  <bs-gizmo type="position" attribute="position"/>
  <bs-gizmo type="plane" attribute="position" size="2 1.125" rotation="0 180 0"/>
  <bs-gizmo type="position" attribute="playlist-panel-position"/>
  <bs-gizmo type="plane" attribute="playlist-panel-position" size="1.4 1.2" rotation="0 200 0"/>
  <bs-gizmo type="position" attribute="button-position"/>
  <bs-gizmo type="position" attribute="singer-button-position"/>
</bs-snippet>
<!-- end snippet section -->
```

Settings are the same as the script attributes below, except:

- `position` and `rotation` are **Unity world values**, as for every snippet, so the Scene-view gizmo shows where the screen will be. (Script-tag values use A-Frame axes, where Z is flipped: script `position="0 1.5 -2"` is snippet `position="0 1.5 2"`.)
- `scale` can be a single number. The screen is 1 m wide and 0.5625 m tall at scale 1, so the gizmo's `size` should be `scale × 1` by `scale × 0.5625`.
- `karaoke` is a checkbox: ticked (`true`) is karaoke mode, unticked or empty is playlist mode. A hand-written `mode="karaoke"` works too. Both modes use the same settings; `playlist` (the default YouTube playlist) only matters in playlist mode.
- `singer-button-position` and `singer-button-rotation` (karaoke) place the Singers button, a Unity world position and rotation like `button-position`, with its own drag handle. An empty rotation tilts the button back 30° and turns it with the screen. With `controls-follow-screen="true"` they're offsets from the screen instead. Empty `singer-button-position` keeps the old default: below and in front of the in-world buttons, placed from them. Unity picks each setting's field from its value, so an empty setting shows as a single text box instead of X, Y and Z: the example gives both a value (`30 180 0` is the usual tilt for a screen with no rotation). To fix an empty one in Unity, type all three numbers into the box at once (for example `0 1 -1`), then select another object and back, and it shows as X, Y and Z with a drag handle. The `box-trigger-*` settings from the parameter reference work too.
- The room ID is `room`, not `instance`: Unity's BSSnippet component writes its own `instance` attribute. Without `room`, the space URL is used, so each space has its own room.
- `playlist-panel-position` and `playlist-panel-rotation` place the in-world panel in the world (Unity values), and it has its own drag handle in the Scene view. Clear `playlist-panel-position` to put the panel beside the screen instead; `playlist-panel-rotation` is then relative to the screen.
- `button-position` is where the in-world buttons go (Unity world position), with its own drag handle. Empty puts them just under the screen; an empty `button-rotation` uses the screen's.
- `controls-follow-screen="true"` makes `button-position`, `playlist-panel-position`, `singer-button-position` and their rotations offsets from the screen (in the screen's own axes) instead of world values, so the buttons and panel move and turn with the screen. Their drag handles then don't show where they'll be, as a gizmo can only show a setting's own value. For example `button-position="0 -0.67 0"` puts the buttons 0.67 m below the screen's centre.
- An empty `youtube` uses the default silent video.
- The section between the two comments is read as XML by Unity: quote every attribute, close every element, and write `&` as `&amp;`.

The player uses the SDK's legacy A-Frame bridge, so `snippet.js` adds an `<a-scene>` if the page has none. With the plain script tag, add `<a-scene></a-scene>` to the page yourself.

In these worlds the Playlist button opens an **in-world panel** beside the screen. The main view has playback and volume controls, the playlist (play, reorder, remove, vote) and YouTube search. Under the search box are your last five searches (kept on your device; click one to search again, **Clear** forgets them) and, in karaoke mode, **+ karaoke**, **+ lyrics** and **+ zoom karaoke**, which add that word to the search. Search also accepts a video link, or a playlist link (host only), which replaces the playlist. **Refresh** fetches the latest playlist from the server; the panel also does this each time it opens. **More...** opens a second view with:

- host controls: lock, take over, voting, clear, load the default playlist
- seek to a time (host)
- your player only: skip back/forward, Auto Sync and Captions (closed captions on or off for you, remembered on your device)
- add by link: a video (YouTube, Twitch, Vimeo or a direct link, see [Links from other sites](#links-from-other-sites)), or a YouTube playlist (host)
- mode: switch between playlist and karaoke, for space admins (see [Switching mode in world](#switching-mode-in-world))

The Creator SDK client currently doesn't open the 2D playlist page, so the panel has no button for it.

When someone can't play a video, the panel shows the suggested replacement with Replace (host) and Dismiss.

In karaoke mode the Singers button (and the Join/Leave Queue button) opens the same panel as a **Singers panel**:

- **Now singing** shows who is singing which song. The host and the person singing get **Restart Song** and **Stop Song**.
- **Singers** is the queue. The host can **Play & Sing** anyone, move singers **Up** / **Down** and **Remove** them. The singer at the top can start their own song, and anyone can **Remove Me**.
- **Search** finds a song (or takes a pasted video link). **Sing It** adds you to the queue with that song. You can be in the queue once.
- **More...** has the host controls (lock, take over, Auto Advance, which starts the next singer when a song ends), seek, and your own player's skip, Auto Sync and Captions.

Whoever runs the karaoke should take over the player first, as only the host can start other people's songs.

### Links from other sites

Search (and add by link) takes more than YouTube links. Paste one and it shows as a single result to add or play.

These always work, as the sites moderate what's on them:

| Link | Example | Notes |
|---|---|---|
| Twitch channel | `https://www.twitch.tv/<channel>` | Live, so it plays until someone skips. Seek and skip do nothing. If Twitch waits for a click to start, or starts muted, the player clicks the screen for you until it plays with sound (a few tries at most). |
| Twitch video (VOD) | `https://www.twitch.tv/videos/<id>` | Stays in sync like YouTube. |
| Twitch clip | `https://www.twitch.tv/<channel>/clip/<id>` or `https://clips.twitch.tv/<id>` | Twitch's clip player can't be controlled, so clips aren't kept in sync, volume, mute and the `spatial` fade don't change them, and each gets 60 seconds (the longest a clip can be) before the playlist moves on. |
| Vimeo | `https://vimeo.com/<id>` | Only videos whose owner allows embedding on other sites. |

These only work with `untrusted-links="true"` in the snippet, as they can come from any site:

| Link | Example | Notes |
|---|---|---|
| Video or audio file | `https://.../movie.mp4` (also .webm, .mov, .m4v, .mp3, .m4a, .ogg) | Stays in sync. |
| HLS stream | `https://.../index.m3u8` | Live streams play until someone skips; recorded ones stay in sync. The server must allow other sites to load it (CORS). |
| VDO.Ninja | `https://vdo.ninja/?view=<stream id>`, or `?room=<room>&scene` for a whole room | Shown as VDO.Ninja's own page and plays until someone skips. Volume and mute work; there's no pause or seek. Its video controls (picture-in-picture, fullscreen) are hidden, as fullscreen would blank the screen. Links that would join a room or send video (`?push=`, `?room=` without `scene`) aren't accepted. |

Without it, the server won't add them, and a player whose world doesn't allow them shows a notice instead of playing one. If a browser won't start a file with sound, it starts muted and the sound comes on at the first click on the screen.

Files, streams and Twitch videos show no length until the first player loads them; after that the playlist moves on when they end. Captions and the "unavailable in your region" check only apply to YouTube. Pages that need a login can't be played. Dailymotion isn't supported, because its player now needs a player ID from a Dailymotion account.

### Switching mode in world

At the bottom of the panel's **More...** view, the **Mode (space admins only)** section has:

- **Switch to Karaoke** / **Switch to Playlist**, which switches the player for everyone in the space.
- **Use Snippet Default**, shown once the mode has been changed, which goes back to the snippet's `karaoke` setting.

Everyone sees these buttons, because the client can't always tell who is a space admin, but they only work for a space admin: the world's owner, an Owner or Moderator of the community hosting it, or a SideQuest admin. The choice is saved as protected space state (the key `fire-v-player-mode`), which the server refuses to let anyone else write, so a modified client can't change it either. When someone else presses one, nothing changes and the panel says so after a few seconds. Everyone in the space switches straight away, and people who join later start in the saved mode. With nothing saved, the player uses the snippet's setting.

- Space state lasts 24 hours after its last change, so after a day with no changes the player goes back to the snippet's mode.
- The shared playlist is kept while the room is in karaoke mode. Switching back to playlist mode brings it back and plays its current track from the start. Switching to karaoke stops what's playing.
- Only the in-world panel has the switch. Players using the 2D playlist page (`playlist-ui="page"`) still follow the saved mode.

---

## Parameter Reference

All parameters are optional unless marked as **(Required)**.

### Core Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `src` | **(Required)** The URL to your running Fire-V-Player instance's `playlist.js` or `karaoke.js` file. | N/A |
| `instance` | **(Required)** A unique ID for the player instance. All users with the same ID will see the same player. | The current page URL |
| `playlist` | The ID of a YouTube playlist (e.g., `PL...`) to load by default if the instance is empty. | `""` |
| `youtube` | The URL of a single YouTube video to use as the default "silent" video when nothing is playing. | A silent visual video |
| `volume` | The initial volume, from `0` to `100`. | `40` |
| `mute` | Whether the player should start muted. | `false` |
| `untrusted-links` | Whether links from any site (video files, `.m3u8` streams, VDO.Ninja) can be played, as well as YouTube, Twitch and Vimeo. Off by default, as those links aren't moderated. Each viewer's own world must allow them for them to play on their screen. See [Links from other sites](#links-from-other-sites). | `false` |
| `captions` | Whether closed captions start on. Each viewer can turn them on or off in the panel's More view, and their choice is remembered on their device. | `true` |
| `resolution` | The resolution (width in pixels) of the browser surface. Higher values are crisper but use more resources. | `1600` |

### 3D Environment Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `position` | The `x y z` position of the player screen in the 3D scene. | `0 0 0` |
| `rotation` | The `x y z` rotation of the player screen. | `0 0 0` |
| `scale` | The `x y z` scale of the player screen. | `1 1 1` |
| `spatial` | Set to `true` to make the volume fade as you move away from the screen. It only changes the volume: Banter always plays the screen's sound in 3D, coming from the screen, and has no setting for 2D sound. | `true` |
| `spatial-min-distance` | With `spatial` on, the distance at which the volume starts to fade. | `5` |
| `spatial-max-distance` | With `spatial` on, how far past `spatial-min-distance` the volume reaches zero. | `40` |
| `mip-maps` | The number of mip-map levels for the browser texture. Affects visual quality at sharp angles. | `1` |

### UI & Control Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `hand-controls` | Set to `true` to enable a small UI attached to the user's left hand in VR. | `false` |
| `button-position` | The `x y z` position of the in-world UI buttons, relative to the player screen. | `0 0 0` |
| `button-rotation` | The `x y z` rotation of the in-world UI buttons. | `0 0 0` |
| `button-scale` | The `x y z` scale of the in-world UI buttons. | `1 1 1` |
| `playlist-ui` | What the Playlist (or, in karaoke mode, Singers) button opens. `panel`: an in-world panel (UI Toolkit) with controls, the playlist or singer queue, and search. `page`: the 2D playlist page in the client's menu browser. `auto`: `panel` whenever the client has the UI system (the SideQuest/Altspace Creator SDK), otherwise `page`. | `auto` |
| `playlist-panel-position` | Where the in-world panel sits in the world, in the same units as `position`. When set, `playlist-panel-rotation` is a world rotation too (empty = the screen's rotation), and `playlist-panel-offset` is ignored. | (beside the screen) |
| `playlist-panel-offset` | Where the in-world panel sits, relative to the screen, in metres: `x` right, `y` up, `z` toward the viewer. Empty puts it just right of the screen. | (beside the screen) |
| `playlist-panel-rotation` | The in-world panel's rotation: relative to the screen, or a world rotation when `playlist-panel-position` is set. Empty: relative `0 -20 0` (turned slightly toward the screen's centre), or the screen's rotation. | (see description) |
| `playlist-panel-scale` | Size of the in-world panel. `1` is 1.4 m wide. | `1` |
| `data-playlist-icon-url` | URL for a custom "Playlist/Singers" button icon. | Default icon |
| `data-vol-up-icon-url` | URL for a custom "Volume Up" button icon. | Default icon |
| `data-vol-down-icon-url` | URL for a custom "Volume Down" button icon. | Default icon |
| `data-mute-icon-url` | URL for a custom "Mute" button icon. | Default icon |
| `data-skip-forward-icon-url` | URL for a custom "Skip Forward" button icon. | Default icon |
| `data-skip-backward-icon-url` | URL for a custom "Skip Backward" button icon. | Default icon |

### Karaoke Mode Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `singer-button-position` | The `x y z` position of the "Join/Leave Queue" button. | `0 ${-yScale*0.335} 3` |
| `singer-button-rotation` | The `x y z` rotation of the "Join/Leave Queue" button. | `-30 180 0` |
| `box-trigger-enter-enabled` | Set to `true` to automatically start the next singer's song when they enter a trigger volume. | `false` |
| `box-trigger-exit-enabled` | Set to `true` to automatically stop the song and remove the singer when they leave a trigger volume. | `false` |
| `box-trigger-position` | The `x y z` position of the trigger volume. | `0 0 0` |
| `box-trigger-rotation` | The `x y z` rotation of the trigger volume. | `0 0 0` |
| `box-trigger-scale` | The `x y z` scale of the trigger volume. | `1 1 1` |

### Miscellaneous Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `announce` | Set to `true` to enable voice announcements for users joining. | `true` |
| `announce-four-twenty` | Set to `true` to enable a special 4:20 announcement. | `false` |
| `one-for-each-instance` | Set to `true` to create a unique player instance for each unique user, even with the same `instance` ID. | `false` |

---

## Programmatic Control

You can control the player programmatically using the `window.videoPlayerCore` object once it has been initialized.

### Volume Control

- **Set Absolute Volume:**

```javascript
// Sets the volume to 50%
window.videoPlayerCore.setAbsoluteVolume(50);
```

- **Adjust Volume by Increment:**

```javascript
// Increases volume by 10%
window.videoPlayerCore.setVolumeIncrement(10);

// Decreases volume by 15%
window.videoPlayerCore.setVolumeIncrement(-15);
```
