// Second screens for the Fire-V-Player snippet (Banter Creator SDK).
//
// Any object with a BS Material, named "Fire-V-Player" (or starting with it) or with "Fire-V-Player"
// as its Texture, shows the same picture as the player's screen (and a "Fire-V-Player loading"
// picture until the screen is up), with no camera or render texture: the player finds those materials and keeps
// them on whatever its screen draws, the space page (asset_browser_world, YouTube and most links)
// or its own browser (Twitch). While a video file plays on the world's video player there is no
// texture to share, so they go black. Any mesh works, a curved screen or a sphere included.
//
// GameObject > Fire-V-Player > Second Screen makes one: a 16:9 quad as wide as the player's screen.
//
// GameObject > Fire-V-Player > Fit Camera Screen to Player is for the camera kind instead (a
// camera filming the screen into a render texture, such as the RenderTextureScreen prefab): it
// puts the selected object where the player's screen is and sizes its orthographic cameras to the
// screen. Those also show video files, but cost a camera render every frame.
//
// Put this file in a folder named Editor in a Unity project that has the Creator SDK
// (e.g. Assets/Editor/), next to FireVPlayerSnippetPreview.cs.
using System;
using System.Globalization;
using System.Xml.Linq;
using BS;
using BS.SDKEditor;
using UnityEditor;
using UnityEngine;

namespace FireVPlayer.EditorTools
{
    /// <summary>
    /// Menu items that add second screens for Fire-V-Player and fit camera-based ones to its screen.
    /// </summary>
    static class FireVPlayerSecondScreen
    {
        // What marks a second screen (core.js SECOND_SCREEN_TEXTURE): the object's name, or its BS
        // Material's Texture, which the player replaces with the screen's own texture.
        const string ScreenName = "Fire-V-Player";
        const string MarkerTexture = "Fire-V-Player";
        // What a new second screen's Texture starts as: the player's loading picture, so it shows
        // that (not plain white) until the player sets it. The object's name marks it as a screen.
        const string LoadingImage = "/assets/SecondScreenLoading.png";
        const string DefaultHost = "https://vidya.firer.at";
        const string SnippetName = "fire-v-player";
        const float ScreenAspect = 9f / 16f; // the player's screen is 1 m wide at scale 1, 16:9
        const float DefaultWidth = 2f;

        /// <summary>
        /// Creates a second screen: a 16:9 quad with a BS Material showing the player's screen.
        /// </summary>
        [MenuItem("GameObject/Fire-V-Player/Second Screen", false, 10)]
        static void AddSecondScreen(MenuCommand command)
        {
            // The same width as the player's screen, when there is one.
            var player = FindPlayer();
            float width = DefaultWidth;
            if (player != null)
            {
                var scale = Vec(player, "scale");
                if (scale.HasValue && scale.Value.x > 0) width = scale.Value.x;
            }

            var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
            go.name = GameObjectUtility.GetUniqueNameForSibling(null, ScreenName);
            // No collider: it would only get in the way of teleporting and clicks.
            UnityEngine.Object.DestroyImmediate(go.GetComponent<Collider>());
            go.transform.localScale = new Vector3(width, width * ScreenAspect, 1);

            var parent = command.context as GameObject;
            if (parent != null)
            {
                GameObjectUtility.SetParentAndAlign(go, parent);
            }
            else
            {
                // In front of the Scene view, turned to face it (a quad shows its picture to -Z).
                var view = SceneView.lastActiveSceneView;
                if (view != null)
                {
                    go.transform.position = view.pivot;
                    var toScreen = view.pivot - view.camera.transform.position;
                    toScreen.y = 0;
                    if (toScreen.sqrMagnitude > 0.0001f) go.transform.rotation = Quaternion.LookRotation(toScreen);
                }
            }

            // BS Material adds the BS Object Id the player needs to see the object.
            var material = go.AddComponent<BSMaterial>();
            var so = new SerializedObject(material);
            SetString(so, "shaderName", "Unlit/Diffuse");
            SetString(so, "texture", LoadingImageUrl(player));
            var color = so.FindProperty("color");
            if (color != null) color.vector4Value = Vector4.one;
            so.ApplyModifiedPropertiesWithoutUndo();

            Undo.RegisterCreatedObjectUndo(go, "Add Fire-V-Player Second Screen");
            Selection.activeGameObject = go;
            if (player == null)
                Debug.LogWarning("[Fire-V-Player] Added a second screen, but there's no Fire-V-Player snippet in the scene yet. It shows the player's screen once there is.");
            else
                Debug.Log($"[Fire-V-Player] Added \"{go.name}\" ({width:0.##} x {width * ScreenAspect:0.##} m). The player shows its screen on it in the world.");
        }

        /// <summary>
        /// Moves the selected camera rig to the player's screen and sizes its orthographic cameras to it.
        /// </summary>
        [MenuItem("GameObject/Fire-V-Player/Fit Camera Screen to Player", false, 11)]
        static void FitCameraScreen()
        {
            var root = Selection.activeGameObject;
            var player = FindPlayer();
            if (root == null || player == null)
            {
                Debug.LogWarning("[Fire-V-Player] Select the camera screen's object (e.g. RenderTextureScreen), with a Fire-V-Player snippet in the scene.");
                return;
            }
            // The snippet's values are Unity world values, measured from the origin.
            var position = Vec(player, "position") ?? Vector3.zero;
            var rotation = Vec(player, "rotation") ?? Vector3.zero;
            var scale = Vec(player, "scale") ?? Vector3.one;
            float height = scale.y * ScreenAspect;

            int cameras = 0;
            Undo.RecordObject(root.transform, "Fit Camera Screen to Player");
            root.transform.SetPositionAndRotation(position, Quaternion.Euler(rotation));
            foreach (var cam in root.GetComponentsInChildren<Camera>(true))
            {
                if (cam.targetTexture == null) continue; // a camera drawing to the screen isn't one of these
                Undo.RecordObject(cam, "Fit Camera Screen to Player");
                cam.orthographic = true;
                cam.orthographicSize = height / 2;
                cam.rect = new Rect(0, 0, 1, 1);
                cameras++;
            }
            if (cameras == 0)
                Debug.LogWarning($"[Fire-V-Player] Moved \"{root.name}\" to the screen, but it has no camera with a render texture to size.");
            else
                Debug.Log($"[Fire-V-Player] \"{root.name}\" now films the {scale.x:0.##} x {height:0.##} m screen at {position}. Turn off any placeholder screen in it before building: it sits where the video is and flickers with it.");
        }

        [MenuItem("GameObject/Fire-V-Player/Fit Camera Screen to Player", true)]
        static bool CanFitCameraScreen() =>
            Selection.activeGameObject != null && Selection.activeGameObject.GetComponentInChildren<Camera>(true) != null;

        // ---- the snippet's values

        /// <summary>
        /// The first Fire-V-Player snippet's element in index.html, or null.
        /// </summary>
        static XElement FindPlayer()
        {
            foreach (var snippet in UnityEngine.Object.FindObjectsByType<BSSnippet>(FindObjectsSortMode.InstanceID))
            {
                if (snippet == null || string.IsNullOrEmpty(snippet.InstanceId)) continue;
                XElement e;
                try { e = SnippetHtmlSync.Get(snippet.InstanceId); }
                catch (Exception) { continue; }
                // altvr.app accepts the slug in any case, so it's matched the same way.
                if (e != null && string.Equals(((string)e.Attribute("name") ?? "").Trim(), SnippetName, StringComparison.OrdinalIgnoreCase))
                    return e;
            }
            return null;
        }

        /// <summary>
        /// The loading picture on the server the snippet's script comes from (vidya.firer.at if unknown).
        /// </summary>
        static string LoadingImageUrl(XElement player)
        {
            var host = DefaultHost;
            Uri script;
            if (player != null && Uri.TryCreate(((string)player.Attribute("script") ?? "").Trim(), UriKind.Absolute, out script) &&
                (script.Scheme == Uri.UriSchemeHttps || script.Scheme == Uri.UriSchemeHttp))
                host = script.GetLeftPart(UriPartial.Authority);
            return host + LoadingImage;
        }

        /// <summary>
        /// Reads a vector attribute: three numbers, or one for all three.
        /// </summary>
        static Vector3? Vec(XElement e, string name)
        {
            var parts = ((string)e.Attribute(name) ?? "").Split(new[] { ' ', ',', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);
            var n = new float[parts.Length];
            for (int i = 0; i < parts.Length; i++)
                if (!float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out n[i])) return null;
            if (n.Length == 1) return new Vector3(n[0], n[0], n[0]);
            if (n.Length >= 3) return new Vector3(n[0], n[1], n[2]);
            return null;
        }

        static void SetString(SerializedObject so, string field, string value)
        {
            var prop = so.FindProperty(field);
            if (prop != null) prop.stringValue = value;
            else Debug.LogWarning($"[Fire-V-Player] This Creator SDK's BS Material has no \"{field}\": set it by hand.");
        }
    }
}
