# Usage & Embedding Guide

Fire-V-Player is designed to be embedded in the **Banter** VR social platform, and in SideQuest/Altspace Creator SDK worlds (see [Snippet](#sidequest--altspace-creator-sdk-snippet)). Its behavior is configured through attributes on a single `<script>` tag, or a `<bs-snippet>` element.

## Getting Started: Adding the Snippet

In a SideQuest / Altspace Creator SDK world, add the player as a snippet. Its slug is **`fire-v-player`**. Only one Fire-V-Player per world is supported. There are two ways to add it.

### In Unity

1. Create an empty GameObject (**GameObject > Create Empty**).
2. Make sure its Transform **Position is `0 0 0`** (and its Rotation `0 0 0`). The snippet's settings are world values: the player never sees the GameObject, so moving it (or its parents) doesn't move the player, and the SDK's blue outlines are then off by however far it's moved. The orange [live preview](#in-unity) always shows the real place, and labels the object when it isn't at the origin.
3. **Add Component** and pick **Snippet** (`BSSnippet`).
4. Type `fire-v-player` as the slug, then refresh / load it. The component downloads the snippet and writes it into your world's `Assets/WebRoot/index.html`.
5. The player's settings now show in the Inspector. Change them there, or drag the handles in the Scene view to place the screen, buttons and playlist panel. See [Settings](#sidequest--altspace-creator-sdk-snippet) for what each one does.

**Live preview (optional):** the SDK's outlines follow a setting's position, but not its scale or rotation. For a preview that updates as you change anything, copy [`unity/Editor/FireVPlayerSnippetPreview.cs`](unity/Editor/FireVPlayerSnippetPreview.cs) into an `Editor` folder in your project (e.g. `Assets/Editor/`). With the snippet's GameObject selected, it draws the screen, buttons and playlist panel in orange, and karaoke's Singers button in pink, where the player will put them.

### On the website

1. Edit your world on the website and open the **Snippets** section.
2. Choose to show **All** snippets, then search for or scroll to **Fire-V-Player** and open it.
3. Use **Copy & open index.html**, and paste the copied code into your world's HTML (`index.html`), between the `<!-- snippet section -->` comments if your page has them.
4. Change the settings by editing the attributes in the pasted code. See [Settings](#sidequest--altspace-creator-sdk-snippet) for what each one does.

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

In a Creator SDK world (`Assets/WebRoot/index.html`), add the player as a snippet (see [Getting Started](#getting-started-adding-the-snippet)). This is the code it adds. `karaoke="false"` (the default) runs a shared playlist; `karaoke="true"` runs a singer queue instead. Unity's Inspector shows it as a checkbox.

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
  playlist-panel-position="-1.8 1.5 1.85"
  playlist-panel-rotation="0 -20 0"
  playlist-panel-scale="1"
  singer-button-position="0 0 0"
  singer-button-rotation="0 0 0">
  <bs-gizmo type="position" attribute="position"/>
  <bs-gizmo type="plane" attribute="position" size="2 1.125" rotation="0 180 0"/>
  <bs-gizmo type="position" attribute="playlist-panel-position"/>
  <bs-gizmo type="plane" attribute="playlist-panel-position" size="1.4 1.2" rotation="0 160 0"/>
  <bs-gizmo type="position" attribute="button-position"/>
  <bs-gizmo type="plane" attribute="button-position" size="1.6 0.35" rotation="0 180 0"/>
</bs-snippet>
<!-- end snippet section -->
```

Settings are the same as the script attributes below, except:

- `position` and `rotation` are **Unity world values**, as for every snippet, so the Scene-view gizmo shows where the screen will be. (Script-tag values use A-Frame axes, where Z is flipped: script `position="0 1.5 -2"` is snippet `position="0 1.5 2"`.)
- `scale` can be a single number. The screen is 1 m wide and 0.5625 m tall at scale 1, at any `resolution`, so the gizmo's `size` should be `scale × 1` by `scale × 0.5625`.
- `karaoke` is a checkbox: ticked (`true`) is karaoke mode, unticked or empty is playlist mode. A hand-written `mode="karaoke"` works too. Both modes use the same settings; `playlist` (the default YouTube playlist) only matters in playlist mode.
- `singer-button-position` and `singer-button-rotation` (karaoke) place the Singers button, a Unity world position and rotation like `button-position`. (It has no drag handle; the [live preview](#in-unity) shows where it goes.) `0 0 0` (or empty) means the default: for the position, below and in front of the in-world buttons, placed from them; for the rotation, tilted back 30° and turned with the screen. With `controls-follow-screen="true"` they're offsets from the screen instead. They default to `0 0 0` rather than empty because Unity picks each setting's field from its value: an empty one shows as a single text box instead of X, Y and Z. The `box-trigger-*` settings from the parameter reference work too.
- The room ID is `room`, not `instance`: Unity's BSSnippet component writes its own `instance` attribute. Without `room`, the space URL is used, so each space has its own room.
- `playlist-panel-position` and `playlist-panel-rotation` place the in-world panel in the world (Unity values), and it has its own drag handle in the Scene view. Clear `playlist-panel-position` to put the panel beside the screen instead; `playlist-panel-rotation` is then relative to the screen.
- `button-position` is where the in-world buttons go (Unity world position), with its own drag handle. Empty (or `0 0 0`) puts them just under the screen; an empty or `0 0 0` `button-rotation` uses the screen's.
- `controls-follow-screen="true"` makes `button-position`, `playlist-panel-position`, `singer-button-position` and their rotations offsets from the screen (in the screen's own axes) instead of world values, so the buttons and panel move and turn with the screen. Their drag handles then don't show where they'll be, as a gizmo can only show a setting's own value. For example `button-position="0 -0.67 0"` puts the buttons 0.67 m below the screen's centre.
- An empty `youtube` uses the default silent video.
- The section between the two comments is read as XML by Unity: quote every attribute, close every element, and write `&` as `&amp;`.

The player builds everything in the world with the BS SDK (`BS.GameObject` and components such as `BS.Browser`), so the page needs no `<a-scene>`; one left over from older versions does no harm. Script-tag positions and rotations still use A-Frame axes (Z flipped from Unity's), as before, so existing script tags keep working.

In these worlds the Playlist button opens an **in-world panel** beside the screen. The main view has playback and volume controls, the playlist (play, reorder, remove, vote) and YouTube search. Under the search box are your last five searches (kept on your device; click one to search again, **Clear** forgets them) and, in karaoke mode, **+ karaoke**, **+ lyrics** and **+ zoom karaoke**, which add that word to the search. Search also accepts a video link, or a playlist link (host only), which replaces the playlist. Beside the page number, **<** and **>** turn one page, **<<** and **>>** five (shown once there are more than five pages), and **|<** and **>|** go to the first and last page. To move the panel, grab the pill under it in VR and carry it; the panel comes with it, stays upright and stays where you let go. The hand's Playlist button opens it in front of you, karaoke's Singers button opens it just above that button, and the Playlist button by the screen puts it back beside the screen. Only your own panel moves. **Refresh** fetches the latest playlist from the server; the panel also does this each time it opens. **More...** opens a second view with:

- host controls: lock, take over, voting, clear, load the default playlist
- seek to a time (host)
- your player only: skip back/forward, Auto Sync, Captions (closed captions on or off for you, remembered on your device) and Resolution (steps your screen's page through 1280 x 720, 1600 x 900 and 1920 x 1080, then back to the snippet's `resolution`; remembered on your device)
- add by link: a video (YouTube, Twitch, Vimeo or a direct link, see [Links from other sites](#links-from-other-sites)), or a YouTube playlist (host)
- space admins only: **Admin Take Over** (see [Admin Take Over](#admin-take-over)) and the mode switch between playlist and karaoke (see [Switching mode in world](#switching-mode-in-world))

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
| Video or audio file | `https://.../movie.mp4` (also .webm, .mov, .m4v, .mp3, .m4a, .ogg) | Plays on the world's own video player, which takes the browser screen's place while it plays (see below). Stays in sync to within about a second. |
| HLS stream | `https://.../index.m3u8` | Live streams play until someone skips; recorded ones stay in sync. The server must allow other sites to load it (CORS). |
| VDO.Ninja | `https://vdo.ninja/?view=<stream id>`, or `?room=<room>&scene` for a whole room | Shown as VDO.Ninja's own page and plays until someone skips. Volume and mute work; there's no pause or seek. Its video controls (picture-in-picture, fullscreen) are hidden, as fullscreen would blank the screen. Links that would join a room or send video (`?push=`, `?room=` without `scene`) aren't accepted. |

Without it, the server won't add them, and a player whose world doesn't allow them shows a notice instead of playing one. If a browser won't start a file with sound, it starts muted and the sound comes on at the first click on the screen.

**Files play on the world's video player.** Many file hosts (Hostforever, for one) won't let a web page on another site load their files, so in a world a file plays on the SDK's own video player (Unity's) instead of in the browser. While it plays, the browser screen is removed and the video player is put in its place, and when the playlist moves on to YouTube or anything else, the video player is removed and the browser comes back, so only one runs at a time. Volume, mute, `spatial`, skips, pause and the host's controls work as usual. Unity's player can't change speed, so instead of easing back into step it jumps when it is more than a second out. Which formats play depends on the device (MP4 with H.264 video is the safest, especially on Quest). The video player is sized like the browser screen; set `native-screen-size` if it doesn't match yours. Outside a world (the 2D page) files still play in the browser.

Files, streams and Twitch videos show no length until the first player loads them; after that the playlist moves on when they end. A file whose length can't be found still plays, syncs, pauses and seeks, and shows how far in it is; it stays on its last frame at the end until someone skips to the next track. Captions and the "unavailable in your region" check only apply to YouTube. Pages that need a login can't be played. Dailymotion isn't supported, because its player now needs a player ID from a Dailymotion account.

### Switching mode in world

At the bottom of the panel's **More...** view, the **Space admins only** section has:

- **Switch to Karaoke** / **Switch to Playlist**, which switches the player for everyone in the space.
- **Use Snippet Default**, shown once the mode has been changed, which goes back to the snippet's `karaoke` setting.

Everyone sees these buttons, because the client can't always tell who is a space admin, but they only work for a space admin: the world's owner, an Owner or Moderator of the community hosting it, or a SideQuest admin. The choice is saved as protected space state (the key `fire-v-player-mode`), which the server refuses to let anyone else write, so a modified client can't change it either. When someone else presses one, nothing changes and the panel says so after a few seconds. Everyone in the space switches straight away, and people who join later start in the saved mode. With nothing saved, the player uses the snippet's setting.

- Space state lasts 24 hours after its last change, so after a day with no changes the player goes back to the snippet's mode.
- The shared playlist is kept while the room is in karaoke mode. Switching back to playlist mode brings it back and plays its current track from the start. Switching to karaoke stops what's playing.
- Only the in-world panel has the switch. Players using the 2D playlist page (`playlist-ui="page"`) still follow the saved mode.

### Admin Take Over

The **Space admins only** section also has **Admin Take Over** (shown when you aren't the host). It makes a space admin the host even when the player is locked or the host has turned Take Over off, so a world's owner or moderators can always stop someone running the player.

- While the admin is in the space, nobody else can take over (Take Over is turned off for them). They can turn it back on, or Lock / Unlock, like any host.
- When they leave the space, the usual rule applies: 42 seconds later anyone can take over again. So people can still use the player when no admin is around.
- It works the same way as the mode switch: pressing it saves the admin's ID as protected space state (the key `fire-v-player-admin`), which only space admins can write. When that change arrives, the admin's own player asks the server for control. For anyone else the write is refused, and after a few seconds the panel says "Only space admins can take control this way."
- The player server can't check who is a space admin itself. It trusts the admin's player, as it trusts every player's own user ID. That stops anyone using the normal client, but not a modified one.
- The room is shared by everyone with the same `room`, so an admin of one world can take control of a room another world uses too. Without a `room`, each space has its own.

### Blacklist

The owner of the server can stop someone using the player in every world (see [DEPLOYMENT.md](DEPLOYMENT.md#blacklist)). A blacklisted person still sees and hears the video, but every button, the panel and the hand controls do nothing, clicking on the screen does nothing, and their volume stays at 100%. They aren't told why: the player just looks frozen to them. They're matched by their Banter user ID, not their name, so someone else with the same name isn't affected.

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
| `resolution` | The width in pixels of the screen's page, which is 16:9 (`1600` is 1600 x 900). Higher is sharper, and YouTube and Twitch lay out as for a bigger window, but each frame costs more to draw, especially on Quest. The screen stays the same size in the world whatever the resolution. Each viewer can pick another for their own screen in the panel's More view. From 640 to 3840. | `1600` |
| `native-screen-size` | The size (`"width height"`, before `scale`) of the world video player that video and audio files play on. Empty matches the browser screen. | `""` (1 x 0.5625) |
| `screen-debug` | Set to `true` to show, in a corner of the screen, the page's size, zoom and pixel ratio as the screen's browser reports them. For checking how the page fits the screen on a headset. | `false` |

### 3D Environment Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `position` | The `x y z` position of the player screen in the 3D scene. | `0 0 0` |
| `rotation` | The `x y z` rotation of the player screen. | `0 0 0` |
| `scale` | The `x y z` scale of the player screen. | `1 1 1` |
| `spatial` | Set to `true` to make the volume fade as you move away from the screen. Turned off, the volume is the same wherever you stand. Either way it only changes the volume: on PC the SDK always plays the screen's sound from the screen's direction (its browser has no 2D sound setting), and on Quest the page plays its own sound, which isn't placed in the world, so it's effectively 2D. | `true` |
| `spatial-min-distance` | With `spatial` on, the distance at which the volume starts to fade. | `5` |
| `spatial-max-distance` | With `spatial` on, how far past `spatial-min-distance` the volume reaches zero. | `40` |
| `mip-maps` | The number of mip-map levels for the browser texture, in older Banter clients. The Creator SDK ignores it. | `1` |

### UI & Control Parameters

| Attribute | Description | Default Value |
| :--- | :--- | :--- |
| `hand-controls` | Set to `true` to put six buttons on your left hand in VR: mute, volume down and up, skip back and forward (your player only), and the Playlist / Singers panel, which opens in front of you. They lie flat on the back of the wrist, and come back if you leave and rejoin the space. | `false` |
| `hand-controls-position` | Moves the hand buttons: `x y z` in metres, in the hand's own Unity axes (not converted, in a snippet or a script tag). Empty uses the built-in layout. `z` slides them along the hand, away from the wrist toward the fingers (bigger) or toward the wrist (smaller); `x` lifts them off the back of the hand (more negative). | `0 0.046 0.07` |
| `hand-controls-rotation` | Turns the hand buttons: `x y z` in degrees, in the hand's own Unity axes. For example add `180` to `y` if they face into the wrist, add `180` to `z` if they're upside down, or change `z` by `90` to turn them on the wrist. | `0 90 180` |
| `button-position` | The `x y z` position of the in-world UI buttons, relative to the player screen. | `0 0 0` |
| `button-rotation` | The `x y z` rotation of the in-world UI buttons. `0 0 0` (or empty) means "the same as the screen's rotation", not zero, so for a true zero on a turned screen use something like `0.001 0 0`. | `0 0 0` |
| `button-scale` | The `x y z` scale of the in-world UI buttons. | `1 1 1` |
| `playlist-ui` | What the Playlist (or, in karaoke mode, Singers) button opens. `panel`: an in-world panel (UI Toolkit) with controls, the playlist or singer queue, and search. `page`: the 2D playlist page in the client's menu browser. `auto`: `panel` whenever the client has the UI system (the SideQuest/Altspace Creator SDK), otherwise `page`. | `auto` |
| `playlist-panel-position` | Where the in-world panel sits in the world, in the same units as `position`. When set, `playlist-panel-rotation` is a world rotation too (empty = the screen's rotation), and `playlist-panel-offset` is ignored. | (beside the screen) |
| `playlist-panel-offset` | Where the in-world panel sits, relative to the screen, in metres: `x` right, `y` up, `z` toward the viewer. Empty puts it just right of the screen. | (beside the screen) |
| `playlist-panel-rotation` | The in-world panel's rotation: relative to the screen, or a world rotation when `playlist-panel-position` is set. Empty: relative `0 -20 0` (turned slightly toward the screen's centre), or the screen's rotation. | (see description) |
| `playlist-panel-scale` | Size of the in-world panel. `1` is 1.4 m wide. | `1` |
| `playlist-panel-front-height` | When the hand's Playlist button opens the panel in front of you, how high above the floor you stand on its middle goes, in metres. | `1.4` |
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
| `box-trigger-exit-enabled` | Set to `true` to automatically stop the song and remove the singer when they leave a trigger volume (5 seconds after the last of their body, head and hands is out). | `false` |
| `box-trigger-position` | The `x y z` position of the trigger volume, relative to the in-world buttons. | `0 0 0` |
| `box-trigger-rotation` | The `x y z` rotation of the trigger volume. | `0 0 0` |
| `box-trigger-scale` | The `x y z` size of the trigger volume, in metres (it's a 1 m box before scaling). | `1 1 1` |

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
