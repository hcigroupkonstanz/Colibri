using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Assigns the model ids of synced components. Ids only have to be unique per channel and each
    /// type syncs on its own, so all synced components on an object's anchor (its topmost synced
    /// GameObject) share one id. A component further down takes
    /// <c>&lt;anchorId&gt;/Body/LeftHand[1]#2</c>: its path from the anchor, <c>[i]</c> for sibling
    /// GameObjects with the same name, <c>#n</c> for the n-th component of a type on one
    /// GameObject. Every client derives the same ids from the same prefab.
    /// </summary>
    /// <remarks>
    /// The anchor search stops at a GameObject named "(Clone)", where a manager builds an
    /// object, so an object created below another synced one gets its own anchor.
    /// </remarks>
    internal static class SyncedIds
    {
        private const string CloneSuffix = "(Clone)";

        // Live synced components per id; the components on one anchor share theirs.
        private static readonly Dictionary<string, int> _live = new Dictionary<string, int>();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetForPlaySession() => _live.Clear();

        internal static void Register(string id)
        {
            if (String.IsNullOrEmpty(id))
                return;
            _live.TryGetValue(id, out var count);
            _live[id] = count + 1;
        }

        internal static void Deregister(string id)
        {
            if (String.IsNullOrEmpty(id) || !_live.TryGetValue(id, out var count))
                return;
            if (count <= 1)
                _live.Remove(id);
            else
                _live[id] = count - 1;
        }

        internal static bool IsLive(string id) => !String.IsNullOrEmpty(id) && _live.ContainsKey(id);

        /// <summary>Gives <paramref name="self"/>, whose id is empty, the anchor id plus its path.</summary>
        internal static void Assign(ISyncedObject self, Component component)
        {
            var anchor = FindAnchor(component.transform);
            var anchorId = AnchorId(anchor, out var madeHere);
            // AnchorId already gave self an id if it made a new anchor id.
            if (String.IsNullOrEmpty(self.Id))
                self.TakeId(anchorId + Suffix(anchor, component), madeHere);
        }

        internal static Transform FindAnchor(Transform transform)
        {
            var anchor = transform;
            for (var current = transform; current != null; current = current.parent)
            {
                if (current.GetComponents<ISyncedObject>().Length > 0)
                    anchor = current;
                if (current.name.EndsWith(CloneSuffix, StringComparison.Ordinal))
                    break;
            }
            return anchor;
        }

        // The id of the anchor's first component that has one; if none has, a new one given to all of them.
        private static string AnchorId(Transform anchor, out bool madeHere)
        {
            var parts = anchor.GetComponents<ISyncedObject>();
            foreach (var part in parts)
            {
                if (String.IsNullOrEmpty(part.Id))
                    continue;
                madeHere = part.MadeItsId;
                return BaseId(part.Id, Suffix(anchor, (Component)part));
            }

            var id = Guid.NewGuid().ToString();
            foreach (var part in parts)
            {
                if (String.IsNullOrEmpty(part.Id))
                    part.TakeId(id + Suffix(anchor, (Component)part), true);
            }
            madeHere = true;
            return id;
        }

        // The anchor id inside an id that ends with suffix; any other id is the anchor id itself.
        private static string BaseId(string id, string suffix)
            => suffix.Length > 0 && id.EndsWith(suffix, StringComparison.Ordinal) ? id.Substring(0, id.Length - suffix.Length) : id;

        /// <summary>
        /// The part of an id after the anchor id, e.g. "/Body/LeftHand[1]#2"; empty for the first
        /// component of its type on the anchor.
        /// </summary>
        internal static string Suffix(Transform anchor, Component component)
        {
            var path = new StringBuilder();
            for (var current = component.transform; current != null && current != anchor; current = current.parent)
                path.Insert(0, "/" + Segment(current));

            var sameType = component.GetComponents(component.GetType());
            var index = Array.IndexOf(sameType, component);
            if (index > 0)
                path.Append('#').Append(index);
            return path.ToString();
        }

        private static string Segment(Transform transform)
        {
            var parent = transform.parent;
            if (parent == null)
                return transform.name;

            var sameName = 0;
            var position = 0;
            for (var i = 0; i < parent.childCount; i++)
            {
                var sibling = parent.GetChild(i);
                if (sibling.name != transform.name)
                    continue;
                if (sibling == transform)
                    position = sameName;
                sameName++;
            }
            return sameName > 1 ? $"{transform.name}[{position}]" : transform.name;
        }

        /// <summary>
        /// The longest prefix of a part's id before a '/' or '#' that <paramref name="isAnchor"/>
        /// accepts, or null.
        /// </summary>
        internal static string AnchorOfPart(string id, Func<string, bool> isAnchor)
        {
            if (id == null)
                return null;
            // Chosen ids can contain '/' too ("team/1"), so only isAnchor tells where the anchor id ends.
            for (var i = id.Length - 1; i > 0; i--)
            {
                if (id[i] != '/' && id[i] != '#')
                    continue;
                var anchorId = id.Substring(0, i);
                if (isAnchor(anchorId))
                    return anchorId;
            }
            return null;
        }

        /// <summary>Whether the id is a generated anchor id (a GUID) followed by a part suffix.</summary>
        internal static bool LooksLikeRuntimePart(string id)
        {
            const int guidLength = 36;
            return id != null && id.Length > guidLength && (id[guidLength] == '/' || id[guidLength] == '#')
                && Guid.TryParseExact(id.Substring(0, guidLength), "D", out _);
        }

        /// <summary>
        /// Whether a clone of <paramref name="template"/> with anchor id <paramref name="anchorId"/>
        /// has a <paramref name="type"/> component with <paramref name="id"/>.
        /// </summary>
        internal static bool TemplateHasPart(Component template, Type type, string anchorId, string id)
        {
            var anchor = template.transform;
            foreach (var part in template.GetComponentsInChildren(type, true))
            {
                // A part with a preset id keeps it; the template itself takes anchorId.
                if (part is ISyncedObject synced && !String.IsNullOrEmpty(synced.Id) && part != template)
                    continue;
                if (anchorId + Suffix(anchor, part) == id)
                    return true;
            }
            return false;
        }
    }
}
