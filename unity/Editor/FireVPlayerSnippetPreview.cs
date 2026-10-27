// Live scene preview for the Fire-V-Player snippet (Banter Creator SDK).
//
// The SDK's <bs-gizmo> outlines only follow a setting's position: their size and rotation are
// fixed in the snippet. This draws where the player will really put the screen, the buttons, the
// playlist panel and karaoke's Singers button (in orange), and redraws as soon as any setting
// changes, scale and rotation included. It follows the same rules as snippet.js and core.js,
// controls-follow-screen too.
//
// Put this file in a folder named Editor in a Unity project that has the Creator SDK
// (e.g. Assets/Editor/). Anywhere else it doesn't compile (it uses editor-only code), and the
// Console shows errors instead. It draws while the snippet's GameObject is selected, and with
// karaoke on gives the Singers button a drag handle (the SDK has none for it).
using System;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using BS;
using BS.SDKEditor;
using UnityEditor;
using UnityEngine;

namespace FireVPlayer.EditorTools
{
    /// <summary>
    /// Editor tool providing live Scene view preview for Fire-V-Player snippets.
    /// Draws the screen, buttons, playlist panel, and karaoke Singers button
    /// reflecting Inspector changes in real time.
    /// </summary>
    [InitializeOnLoad]
    static class FireVPlayerSnippetPreview
    {
        const string SnippetName = "fire-v-player";

        // Sizes from the player (core.js / playlist-panel.js).
        const float ScreenAspect = 9f / 16f;      // the screen is 1 m wide at scale 1
        const float ButtonsDrop = 0.335f;         // buttons sit this far under the screen's middle, times its Y scale
        const float PanelWidth = 1.4f;            // playlist panel, times playlist-panel-scale
        const float PanelAspect = 940f / 1100f;
        static readonly float[] ButtonX = { -0.633f, -0.332f, -0.081f, 0.23f, 0.471f, 0.693f };
        const float IconSize = 0.2f;
        static readonly Vector2 SingerSize = new Vector2(1f, 0.3f);
        static readonly Vector3 SingerTilt = new Vector3(30, -180, 0);

        static readonly Color Outline = new Color(1f, 0.55f, 0.1f, 0.95f);
        static readonly Color Fill = new Color(1f, 0.55f, 0.1f, 0.07f);
        static readonly Color SingerOutline = new Color(1f, 0.3f, 0.7f, 0.95f);
        static readonly Color SingerFill = new Color(1f, 0.3f, 0.7f, 0.07f);

        /// <summary>
        /// Subscribes to snippet synchronization changes to trigger SceneView repaints.
        /// </summary>
        static FireVPlayerSnippetPreview()
        {
            // Inspector edits and gizmo drags all go through SnippetHtmlSync, so redraw on each.
            SnippetHtmlSync.Changed += (kind, instanceId, attribute) => SceneView.RepaintAll();
            SceneView.duringSceneGui += OnSceneGui;
        }

        /// <summary>
        /// Draws scene gizmos and component outlines for the selected snippet.
        /// </summary>
        /// <param name="snippet">Snippet component instance.</param>
        /// <param name="type">Gizmo drawing context type.</param>
        [DrawGizmo(GizmoType.Selected | GizmoType.Active)]
        static void Draw(BSSnippet snippet, GizmoType type)
        {
            if (snippet == null || string.IsNullOrEmpty(snippet.InstanceId)) return;
            XElement e;
            try { e = SnippetHtmlSync.Get(snippet.InstanceId); }
            catch (Exception) { return; }
            // altvr.app accepts the slug in any case, and the SDK names the element after what was
            // typed (e.g. "Fire-V-Player"), so the name is matched the same way.
            if (e == null || !IsFireVPlayer(e)) return;
            bool used = WarnAboutCopies(e);

            // The player never sees the snippet's GameObject (or its parents): every value is
            // measured from the world's origin. So this draws from the origin, where the player
            // will really be. The SDK's own blue gizmos are drawn from the object instead, so
            // they're off by the object's position and rotation when it isn't at the origin.
            var t = snippet.transform;
            var frame = Matrix4x4.identity;
            WarnIfMoved(t);

            bool follow = Attr(e, "controls-follow-screen") == "true";
            bool karaoke = Attr(e, "karaoke").ToLowerInvariant() == "true" || Attr(e, "mode").ToLowerInvariant() == "karaoke";

            // Screen
            var sPos = Vec(e, "position") ?? Vector3.zero;
            var sRot = Quaternion.Euler(Vec(e, "rotation") ?? Vector3.zero);
            var sScale = Vec(e, "scale") ?? Vector3.one;
            Rect(frame, sPos, sRot, Vector3.one, new Vector2(sScale.x, sScale.y * ScreenAspect), Outline, Fill,
                used ? "Screen" : "Screen (NOT USED: another Fire-V-Player comes first in index.html)");

            // Buttons: "0 0 0" (or empty) puts them under the screen, turned with it.
            var under = sPos + new Vector3(0, -sScale.y * ButtonsDrop, 0);
            var bp = SetVec(e, "button-position");
            var br = SetVec(e, "button-rotation");
            var bPos = bp.HasValue ? (follow ? sPos + sRot * bp.Value : bp.Value) : under;
            var bRot = br.HasValue ? (follow ? sRot * Quaternion.Euler(br.Value) : Quaternion.Euler(br.Value)) : sRot;
            var bScale = Vec(e, "button-scale") ?? Vector3.one;
            var bMatrix = frame * Matrix4x4.TRS(bPos, bRot, bScale);
            using (new Handles.DrawingScope(Outline, bMatrix))
            {
                float left = ButtonX[0] - IconSize / 2 - 0.02f, right = ButtonX[ButtonX.Length - 1] + IconSize / 2 + 0.02f;
                RectAt(new Vector2((left + right) / 2, -0.05f), new Vector2(right - left, 0.34f), Fill, Outline);
                foreach (var x in ButtonX)
                    RectAt(new Vector2(x, 0), new Vector2(IconSize, IconSize), Color.clear, Outline);
            }
            Handles.color = Outline;
            Handles.Label(bMatrix.MultiplyPoint3x4(new Vector3(ButtonX[0] - IconSize / 2, 0.2f, 0)), "Buttons");

            // Playlist panel (playlist-panel.js): a world position, or an offset from the screen.
            float ps = FirstNumber(e, "playlist-panel-scale", 1f);
            float pw = PanelWidth * ps;
            var pSize = new Vector2(pw, pw * PanelAspect);
            Vector3? worldPos = follow ? null : Vec(e, "playlist-panel-position");
            var offset = follow
                ? (Vec(e, "playlist-panel-position") ?? Vec(e, "playlist-panel-offset"))
                : Vec(e, "playlist-panel-offset");
            var defaultOffset = new Vector3(sScale.x * 0.5f + 0.1f + pw * 0.5f, 0, -0.15f);
            var pEuler = Vec(e, "playlist-panel-rotation");
            Vector3 pPos;
            Quaternion pRot;
            if (worldPos.HasValue)
            {
                pPos = worldPos.Value;
                pRot = pEuler.HasValue ? Quaternion.Euler(pEuler.Value) : sRot;
            }
            else
            {
                pPos = sPos + sRot * (offset ?? defaultOffset);
                pRot = sRot * Quaternion.Euler(pEuler ?? new Vector3(0, 20, 0));
            }
            Rect(frame, pPos, pRot, Vector3.one, pSize, Outline, Fill, "Playlist panel");

            // Karaoke's Singers button. With a position it's placed in the world (or from the
            // screen, with controls-follow-screen); otherwise it hangs off the buttons.
            var sp = SetVec(e, "singer-button-position");
            var sr = SetVec(e, "singer-button-rotation");
            Vector3 gPos, gScale;
            Quaternion gRot;
            if (sp.HasValue)
            {
                gPos = follow ? sPos + sRot * sp.Value : sp.Value;
                gRot = sr.HasValue && !follow ? Quaternion.Euler(sr.Value) : sRot * Quaternion.Euler(sr ?? SingerTilt);
                gScale = Vector3.one;
            }
            else
            {
                var local = new Vector3(0, -sScale.y * ButtonsDrop, -3);
                gPos = bPos + bRot * Vector3.Scale(bScale, local);
                gRot = bRot * Quaternion.Euler(sr ?? SingerTilt);
                gScale = bScale;
            }
            Rect(frame, gPos, gRot, gScale, SingerSize, SingerOutline, karaoke ? SingerFill : Color.clear,
                karaoke ? "Singers button" : "Singers button (karaoke only)");

            // Remembered for the drag handle (OnSceneGui): gizmo drawing can't take mouse input.
            _singer = karaoke && used
                ? new SingerSpot
                {
                    instanceId = snippet.InstanceId, pos = gPos, rot = gRot, follow = follow, sPos = sPos, sRot = sRot,
                    // Hanging off buttons turned away from the screen: keep that turn once it has a position.
                    keepRot = !sp.HasValue && !sr.HasValue && !follow && Quaternion.Angle(bRot, sRot) > 0.01f
                }
                : null;
        }

        // ---- the Singers button's drag handle

        // The SDK only puts handles on positions its <bs-gizmo> lines name. The Singers button has
        // none there, as its default ("0 0 0": hang off the buttons) would put the handle at the
        // origin. This one sits on the button wherever it really is.
        class SingerSpot
        {
            public string instanceId;
            public Vector3 pos, sPos;
            public Quaternion rot, sRot;
            public bool follow, keepRot;
        }

        static SingerSpot _singer;

        static void OnSceneGui(SceneView view)
        {
            var s = _singer;
            if (s == null) return;
            var go = Selection.activeGameObject;
            var snippet = go ? go.GetComponent<BSSnippet>() : null;
            if (snippet == null || snippet.InstanceId != s.instanceId) return;

            var handleRot = Tools.pivotRotation == PivotRotation.Local ? s.rot : Quaternion.identity;
            EditorGUI.BeginChangeCheck();
            var world = Handles.PositionHandle(s.pos, handleRot);
            if (!EditorGUI.EndChangeCheck()) return;

            // With controls-follow-screen it's an offset from the screen; otherwise a world position.
            var value = s.follow ? Quaternion.Inverse(s.sRot) * (world - s.sPos) : world;
            if (value == Vector3.zero) value.y = 0.001f; // "0 0 0" would mean the default spot
            if (s.keepRot)
            {
                var e = s.rot.eulerAngles;
                SnippetHtmlSync.SetAttribute(s.instanceId, "singer-button-rotation", Format(e));
                s.keepRot = false;
            }
            SnippetHtmlSync.SetAttribute(s.instanceId, "singer-button-position", Format(value));
            s.pos = world;
        }

        static string Format(Vector3 v) => string.Join(" ",
            new[] { v.x, v.y, v.z }.Select(n => (Mathf.Round(n * 1000f) / 1000f).ToString(CultureInfo.InvariantCulture)));

        // ---- the GameObject's own transform

        static readonly Color MovedColor = new Color(1f, 0.85f, 0.2f, 1f);
        static string _warnedMoved;

        /// <summary>
        /// When the snippet's GameObject (with its parents) isn't at the world's origin, labels it
        /// and draws a line from it to the origin, and says once in the Console that moving it
        /// doesn't move the player.
        /// </summary>
        /// <param name="t">The snippet's transform.</param>
        static void WarnIfMoved(Transform t)
        {
            bool moved = t.position.sqrMagnitude > 1e-6f || Quaternion.Angle(t.rotation, Quaternion.identity) > 0.01f;
            if (!moved) { _warnedMoved = null; return; }
            string key = t.GetInstanceID().ToString(); // once per object, not on every frame of a drag

            Handles.color = MovedColor;
            Handles.DrawDottedLine(t.position, Vector3.zero, 4f);
            Handles.Label(t.position, "Fire-V-Player ignores where this object is.\nThe orange outlines show where it really goes\n(measured from the world origin). The blue SDK\ngizmos are off by this object's position.");
            if (key == _warnedMoved) return;
            _warnedMoved = key;
            Debug.LogWarning($"[Fire-V-Player] '{t.name}' is at {t.position} (rotation {t.rotation.eulerAngles}) in the world, but the player " +
                             "never sees this object: its position, rotation and scale settings are measured from the world origin. The orange " +
                             "outlines show where it will really be; the SDK's blue gizmos are off by this object's position. To make them " +
                             "agree, put this object (and its parents) at 0 0 0 with no rotation.", t);
        }

        // ---- copies

        /// <summary>Whether an element is a Fire-V-Player snippet, whatever case its name is in.</summary>
        static bool IsFireVPlayer(XElement e) => string.Equals(Attr(e, "name"), SnippetName, StringComparison.OrdinalIgnoreCase);

        static int _warnedCount;

        /// <summary>
        /// Only the first Fire-V-Player in index.html loads (snippet.js and the SDK's single-instance rule),
        /// so extra copies, such as ones left behind by deleted or unsaved objects, do nothing. Warns once
        /// in the Console each time the number of copies changes.
        /// </summary>
        /// <param name="e">The selected snippet's element.</param>
        /// <returns>Whether this element is the one that loads.</returns>
        static bool WarnAboutCopies(XElement e)
        {
            XElement first = null;
            int count = 0;
            foreach (var other in SnippetHtmlSync.All())
            {
                if (!IsFireVPlayer(other)) continue;
                if (first == null) first = other;
                count++;
            }
            if (count > 1 && count != _warnedCount)
                Debug.LogWarning($"[Fire-V-Player] {SnippetHtmlSync.AssetPath} has {count} Fire-V-Player snippets; only the first one loads. " +
                                 "Delete the extra objects, or remove the extra <bs-snippet name=\"fire-v-player\"> entries between the snippet " +
                                 "section markers (on Creator SDK 4.0.24 or newer: Creator SDK > Setup > Tools > Recover orphaned snippets > Remove).");
            _warnedCount = count;
            return first == null || first == e;
        }

        // ---- drawing

        /// <summary>
        /// Draws a transformed oriented rectangle with an outline and text label in the scene.
        /// </summary>
        /// <param name="frame">Base transform matrix.</param>
        /// <param name="pos">Local position offset.</param>
        /// <param name="rot">Local rotation.</param>
        /// <param name="scale">Local scale.</param>
        /// <param name="size">2D width and height dimensions.</param>
        /// <param name="outline">Outline color.</param>
        /// <param name="fill">Interior fill color.</param>
        /// <param name="label">Text label displayed above the rectangle.</param>
        static void Rect(Matrix4x4 frame, Vector3 pos, Quaternion rot, Vector3 scale, Vector2 size, Color outline, Color fill, string label)
        {
            var m = frame * Matrix4x4.TRS(pos, rot, scale);
            using (new Handles.DrawingScope(outline, m))
                RectAt(Vector2.zero, size, fill, outline);
            Handles.color = outline;
            Handles.Label(m.MultiplyPoint3x4(new Vector3(-size.x / 2, size.y / 2 + 0.08f, 0)), label);
        }

        /// <summary>
        /// Draws a solid 2D rectangle with an outline around a given center point.
        /// </summary>
        /// <param name="centre">Center coordinates in local space.</param>
        /// <param name="size">Width and height of the rectangle.</param>
        /// <param name="fill">Fill color.</param>
        /// <param name="outline">Outline color.</param>
        static void RectAt(Vector2 centre, Vector2 size, Color fill, Color outline)
        {
            var h = size * 0.5f;
            Handles.DrawSolidRectangleWithOutline(new[]
            {
                new Vector3(centre.x - h.x, centre.y - h.y, 0),
                new Vector3(centre.x - h.x, centre.y + h.y, 0),
                new Vector3(centre.x + h.x, centre.y + h.y, 0),
                new Vector3(centre.x + h.x, centre.y - h.y, 0),
            }, fill, outline);
        }

        // ---- reading the snippet's values (Unity axes, as typed in the inspector)

        /// <summary>
        /// Reads a trimmed XML attribute value from a snippet element.
        /// </summary>
        /// <param name="e">Snippet XML element.</param>
        /// <param name="name">Attribute name.</param>
        /// <returns>Trimmed string value or empty string if missing.</returns>
        static string Attr(XElement e, string name) => ((string)e.Attribute(name) ?? "").Trim();

        /// <summary>
        /// Parses whitespace- or comma-delimited numbers from a snippet attribute.
        /// </summary>
        /// <param name="e">Snippet XML element.</param>
        /// <param name="name">Attribute name.</param>
        /// <returns>Array of parsed floats, or null if empty or invalid.</returns>
        static float[] Numbers(XElement e, string name)
        {
            var parts = Attr(e, name).Split(new[] { ' ', ',', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return null;
            var result = new float[parts.Length];
            for (int i = 0; i < parts.Length; i++)
                if (!float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out result[i])) return null;
            return result;
        }

        /// <summary>
        /// Parses a 3D vector from an attribute string (supporting 1 or 3 numbers).
        /// </summary>
        /// <param name="e">Snippet XML element.</param>
        /// <param name="name">Attribute name.</param>
        /// <returns>Vector3 if valid, or null if missing.</returns>
        static Vector3? Vec(XElement e, string name)
        {
            var n = Numbers(e, name);
            if (n == null) return null;
            if (n.Length == 1) return new Vector3(n[0], n[0], n[0]);
            if (n.Length >= 3) return new Vector3(n[0], n[1], n[2]);
            return null;
        }

        /// <summary>
        /// Parses a 3D vector, treating '0 0 0' as empty (indicating fallback to default).
        /// </summary>
        /// <param name="e">Snippet XML element.</param>
        /// <param name="name">Attribute name.</param>
        /// <returns>Vector3 if non-zero, or null if zero or missing.</returns>
        static Vector3? SetVec(XElement e, string name)
        {
            var v = Vec(e, name);
            return v.HasValue && v.Value != Vector3.zero ? v : null;
        }

        /// <summary>
        /// Reads the first numeric value from an attribute or falls back to a default value.
        /// </summary>
        /// <param name="e">Snippet XML element.</param>
        /// <param name="name">Attribute name.</param>
        /// <param name="fallback">Fallback value to return if missing or zero.</param>
        /// <returns>Parsed float or fallback.</returns>
        static float FirstNumber(XElement e, string name, float fallback)
        {
            var n = Numbers(e, name);
            return n != null && n[0] != 0 ? n[0] : fallback;
        }
    }
}
