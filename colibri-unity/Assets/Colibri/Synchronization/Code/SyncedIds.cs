using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// What <see cref="SyncedIds"/> needs of a SyncBehaviour, whatever its type: found on a
    /// GameObject with GetComponents&lt;ISyncedObject&gt;().
    /// </summary>
    internal interface ISyncedObject
    {
        string Id { get; }

        /// <summary>Whether the object made its id on this client: the server holds nothing for it yet.</summary>
        bool MadeItsId { get; }

        /// <summary>Sets an empty id, before or during the object's Awake.</summary>
        void TakeId(string id, bool madeHere);

        /// <summary>Marks a part of a copy that a manager built from another client's update.</summary>
        void MarkAsCopy();
    }

    /// <summary>
    /// The ids of the synced components of one object.
    /// </summary>
    /// <remarks>
    /// A model id only has to be unique on its channel, and each type syncs on its own channel. So
    /// every synced component on an object's top GameObject (its anchor) takes the same id, and a
    /// synced component further down takes that id plus its path from the anchor:
    /// <c>&lt;id&gt;/Head</c>, <c>&lt;id&gt;/Body/LeftHand</c>. The client that creates the object
    /// and every client that builds it from an update get the same ids from the same prefab.
    ///
    /// Each component used to make its own random id. A prefab with more than one synced
    /// component, such as an avatar with a SyncTransform for the head and each hand, then had ids
    /// on every other client that its owner did not know: each part went out as a new object,
    /// every other client's manager built a whole avatar for it, whose parts made new ids again,
    /// and so on without end.
    ///
    /// The anchor is the topmost synced GameObject above a component, up to the root of an
    /// Instantiate: Unity names that "(Clone)", and a manager builds an object at it. Stopping
    /// there keeps an object created below another synced one, a player under a synced room say,
    /// apart from it, as it is on the clients that build it.
    /// </remarks>
    internal static class SyncedIds
    {
        private const string CloneSuffix = "(Clone)";

        // How many live synced components have each id. Several do: the components on one anchor
        // share it.
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

        /// <summary>Whether a synced component with this id is in the scene on this client.</summary>
        internal static bool IsLive(string id) => !String.IsNullOrEmpty(id) && _live.ContainsKey(id);

        /// <summary>
        /// Gives <paramref name="self"/>, whose id is empty, its id: the anchor's, plus its path
        /// below it. The anchor's components that have no id yet get a new one first.
        /// </summary>
        internal static void Assign(ISyncedObject self, Component component)
        {
            var anchor = FindAnchor(component.transform);
            var anchorId = AnchorId(anchor, out var madeHere);
            if (String.IsNullOrEmpty(self.Id))
                self.TakeId(anchorId + Suffix(anchor, component), madeHere);
        }

        /// <summary>The topmost synced GameObject above <paramref name="transform"/>, see the remarks.</summary>
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

        /// <summary>
        /// The id of the anchor's first synced component that has one. If none has, a new one,
        /// which every component on the anchor without an id takes now.
        /// </summary>
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

        // The anchor id that an id with this suffix was made from.
        private static string BaseId(string id, string suffix)
            => suffix.Length > 0 && id.EndsWith(suffix, StringComparison.Ordinal) ? id.Substring(0, id.Length - suffix.Length) : id;

        /// <summary>
        /// "/Head/LeftHand" for a component on the GameObject at that path below the anchor, ""
        /// for one on the anchor. A second component of the same type on one GameObject adds
        /// "#1", a third "#2", and a GameObject whose siblings share its name adds its index
        /// among them: "/Hand[1]".
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
        /// For an id made for a part below an anchor by <see cref="Assign"/> on a client that
        /// created the object: the anchor's id, which was new there. Null for any other id.
        /// </summary>
        /// <remarks>
        /// A manager builds a whole object from the update of one of its parts, once it can tell
        /// which object that is. An anchor made its id there as a GUID, so a part's id is a GUID
        /// followed by its suffix. An id that someone chose, "team/1" say, is not taken apart.
        /// </remarks>
        internal static string AnchorOfPart(string id)
        {
            const int guidLength = 36;
            if (id == null || id.Length <= guidLength || (id[guidLength] != '/' && id[guidLength] != '#'))
                return null;
            var anchorId = id.Substring(0, guidLength);
            return Guid.TryParseExact(anchorId, "D", out _) ? anchorId : null;
        }

        /// <summary>
        /// Whether a clone of <paramref name="template"/>, its anchor taking
        /// <paramref name="anchorId"/>, has a component of <paramref name="type"/> whose id is
        /// <paramref name="id"/>.
        /// </summary>
        internal static bool TemplateHasPart(Component template, Type type, string anchorId, string id)
        {
            var anchor = template.transform;
            foreach (var part in template.GetComponentsInChildren(type, true))
            {
                if (part is ISyncedObject synced && !String.IsNullOrEmpty(synced.Id) && part != template)
                    continue;
                if (anchorId + Suffix(anchor, part) == id)
                    return true;
            }
            return false;
        }
    }
}
