using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>The listeners per channel for one kind of message: registers and calls them, and drops those whose owner was destroyed.</summary>
    internal sealed class ListenerTable<T>
    {
        private readonly Dictionary<string, List<Listener<T>>> _listeners = new Dictionary<string, List<Listener<T>>>();

        internal bool HasChannel(string channel) => _listeners.ContainsKey(channel);

        internal KeyValuePair<string, List<Listener<T>>>[] Snapshot() => _listeners.ToArray();

        internal void RemoveChannel(string channel) => _listeners.Remove(channel);

        internal void Clear() => _listeners.Clear();

        // Calls the channel's listeners, pruning those whose owner was destroyed. False when none is left.
        internal bool Dispatch(string channel, string command, T val, bool track)
        {
            if (!_listeners.TryGetValue(channel, out var channelListeners))
                return false;

            Prune(channel, channelListeners, track);
            if (channelListeners.Count == 0)
            {
                // Not left empty: it would keep answering the lookup above, and later messages on this channel would be
                // dropped without a word.
                _listeners.Remove(channel);
                return false;
            }

            // Copied, because a listener is allowed to register or unregister while being called.
            foreach (var listener in channelListeners.ToArray())
            {
                try
                {
                    listener.Callback.Invoke(val);
                }
                catch (Exception e)
                {
                    // One listener's exception must not stop the others or the messages queued behind it.
                    Debug.LogError($"Colibri: a listener for {command} on channel '{channel}' threw an exception. "
                        + $"The other listeners still received the message.\n{e}");
                }
            }

            return true;
        }

        // Drops listeners whose owner was destroyed (see ListenerOwner); track also updates ChannelListenerRegistry.
        internal static void Prune(string channel, List<Listener<T>> channelListeners, bool track)
        {
            for (var i = channelListeners.Count - 1; i >= 0; i--)
            {
                if (!channelListeners[i].IsOrphaned)
                    continue;

                channelListeners.RemoveAt(i);
                if (track)
                    ChannelListenerRegistry.Remove(channel, typeof(T));
            }
        }

        internal void Add(string channel, Action<T> listener, bool track, string fetchId, Action<ReconnectRound> requestedAgain)
        {
            if (!_listeners.TryGetValue(channel, out var channelListeners))
            {
                channelListeners = new List<Listener<T>>();
                _listeners.Add(channel, channelListeners);
            }
            else
            {
                // Sweep on registration too: a scene reload registers everything again, and the old scene's listeners would
                // pile up on a channel nothing sends on.
                Prune(channel, channelListeners, track);

                // Skip a duplicate (same method, same object). Nothing prunes a static method or a lambda that captures
                // nothing (the compiler caches it), so it would be added again on every scene reload.
                for (var i = 0; i < channelListeners.Count; i++)
                {
                    if (channelListeners[i].Callback.Equals(listener) && channelListeners[i].FetchId == fetchId)
                        return;
                }
            }

            channelListeners.Add(new Listener<T>(listener, fetchId, requestedAgain));

            if (track)
                ChannelListenerRegistry.Add(channel, typeof(T));
        }

        internal void Remove(string channel, Action<T> listener, bool track = true)
        {
            if (!_listeners.TryGetValue(channel, out var channelListeners))
                return;

            for (var i = 0; i < channelListeners.Count; i++)
            {
                if (!channelListeners[i].Callback.Equals(listener))
                    continue;

                channelListeners.RemoveAt(i);
                if (track)
                    ChannelListenerRegistry.Remove(channel, typeof(T));
                break;
            }

            Prune(channel, channelListeners, track);

            if (channelListeners.Count == 0)
                _listeners.Remove(channel);
        }
    }
}
