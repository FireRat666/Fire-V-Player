# Usage & Embedding Guide

Fire-V-Player is designed to be embedded in the **Banter** VR social platform, and in SideQuest/Altspace Creator SDK worlds (see [Snippet](#sidequest--altspace-creator-sdk-snippet)). Its behavior is configured through attributes on a single `<script>` tag, or a `<bs-snippet>` element.

## Modes

The player has two primary modes, determined by which script you include:

- **Playlist Mode:** The default collaborative player. Use `playlist.js`.
- **Karaoke Mode:** A turn-based system where users join a queue to sing. Use `karaoke.js`.

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

In a Creator SDK world (`Assets/WebRoot/index.html`), add the player as a snippet. Playlist mode only.

```html
<!-- snippet section -->
<bs-snippet name="fire-v-player" title="Fire-V-Player" single="true"
  description="Synced YouTube player with a shared playlist and an in-world playlist panel."
  script="https://vidya.firer.at/snippet.js"
  room="my-private-room"
  playlist="PLZWiw-xxQ4SPDmADhvme7-pU2bx3s7nKX"
  volume="10"
  hand-controls="true"
  position="0 1.5 2"
  rotation="0 0 0"
  scale="2"
  playlist-ui="auto">
  <bs-gizmo type="position" attribute="position"/>
  <bs-gizmo type="plane" attribute="position" size="2 1.125" rotation="0 180 0"/>
</bs-snippet>
<!-- end snippet section -->
```

Settings are the same as the script attributes below, except:

- `position` and `rotation` are **Unity world values**, as for every snippet, so the Scene-view gizmo shows where the screen will be. (Script-tag values use A-Frame axes, where Z is flipped: script `position="0 1.5 -2"` is snippet `position="0 1.5 2"`.)
- `scale` can be a single number. The screen is 1 m wide and 0.5625 m tall at scale 1, so the gizmo's `size` should be `scale × 1` by `scale × 0.5625`.
- The room ID is `room`, not `instance`: Unity's BSSnippet component writes its own `instance` attribute. Without `room`, that per-placement ID is used.
- The section between the two comments is read as XML by Unity: quote every attribute, close every element, and write `&` as `&amp;`.

The player uses the SDK's legacy A-Frame bridge, so `snippet.js` adds an `<a-scene>` if the page has none. With the plain script tag, add `<a-scene></a-scene>` to the page yourself.

In these worlds the Playlist button opens an **in-world panel** beside the screen: playback and volume controls, host controls (lock, take over, voting, clear), the playlist (play, reorder, remove, vote), and YouTube search. Search also accepts a video link, or a playlist link (host only), which replaces the playlist. The panel's **Open full page** button tries the 2D page in the menu browser.

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
| `resolution` | The resolution (width in pixels) of the browser surface. Higher values are crisper but use more resources. | `1600` |

### 3D Environment Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `position` | The `x y z` position of the player screen in the 3D scene. | `0 0 0` |
| `rotation` | The `x y z` rotation of the player screen. | `0 0 0` |
| `scale` | The `x y z` scale of the player screen. | `1 1 1` |
| `spatial` | Set to `true` to enable spatialized audio that gets quieter with distance. | `true` |
| `spatial-min-distance` | The distance at which the audio begins to fade out. | `5` |
| `spatial-max-distance` | The distance at which the audio becomes completely silent. | `40` |
| `mip-maps` | The number of mip-map levels for the browser texture. Affects visual quality at sharp angles. | `1` |

### UI & Control Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `hand-controls` | Set to `true` to enable a small UI attached to the user's left hand in VR. | `false` |
| `button-position` | The `x y z` position of the in-world UI buttons, relative to the player screen. | `0 0 0` |
| `button-rotation` | The `x y z` rotation of the in-world UI buttons. | `0 0 0` |
| `button-scale` | The `x y z` scale of the in-world UI buttons. | `1 1 1` |
| `playlist-ui` | What the Playlist button opens. `panel`: an in-world panel (UI Toolkit) with controls, playlist and search. `page`: the 2D playlist page in the client's menu browser. `auto`: `panel` on clients without the old `window.openPage` (the SideQuest/Altspace Creator SDK), otherwise `page`. Playlist mode only. | `auto` |
| `playlist-panel-offset` | Where the in-world panel sits, relative to the screen, in metres: `x` right, `y` up, `z` toward the viewer. Empty puts it just right of the screen. | (beside the screen) |
| `playlist-panel-rotation` | The in-world panel's rotation relative to the screen. The default turns it slightly toward the screen's centre. | `0 -20 0` |
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
