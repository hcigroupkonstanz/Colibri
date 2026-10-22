using System;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The values one [Sync] member of one object sent around the time the connection last worked,
    /// and the one it held before them. <see cref="Judge"/> uses them after a reconnect to tell a
    /// change lost in the dead link from a remote update made during the outage.
    /// </summary>
    /// <remarks>
    /// A change made as the link drops goes into a dead connection and is lost; the client only
    /// notices when the server's heartbeats stop, about two seconds later. After the reconnect the
    /// server answers with the value from before that change, and applying it reverts the object
    /// on the client that changed it while every other client keeps the old value. A value the
    /// member held before the one it sent last says that send never arrived; a value it never held
    /// was set by someone else.
    /// </remarks>
    // Held values are the ones sent within WindowSeconds, and the value held when the window began.
    // The latter is all an object that sat still has: switched on a minute ago and off at the drop,
    // it sent only `false`, and the answer's `true` is the lost change.
    //
    // The sent values are kept around when the server was last heard from (it heartbeats every
    // 100 ms): the link died about then, and everything sent until the outage is noticed went into
    // it (about 60 values for an object moved at 30 updates a second). While the connection works,
    // a value dropped from in between was replaced by a later one that reached the server too.
    internal sealed class SentValues
    {
        internal enum Verdict
        {
            /// <summary>Nothing sent in the window: the answer is applied.</summary>
            NotSentRecently,

            /// <summary>The server holds the value sent last: it arrived.</summary>
            Arrived,

            /// <summary>
            /// The server holds a value the member held before the one it sent last, so what was
            /// sent after it never arrived. The local value stays and goes out again.
            /// </summary>
            Lost,

            /// <summary>
            /// The server holds a value the member did not hold recently: another client set it
            /// during the outage, and the answer is applied.
            /// </summary>
            ChangedElsewhere,
        }

        /// <summary>
        /// How many values are kept on either side of when the server was last heard from: the
        /// latest sent up to then, and the first sent after. The newest is kept as well.
        /// </summary>
        internal const int Capacity = 8;

        private const double DefaultWindowSeconds = 10;

        /// <summary>
        /// How long before the outage was noticed a sent value still counts. A member that sent
        /// nothing in that time is not judged.
        /// </summary>
        /// <remarks>
        /// <para>
        /// A longer window would undo remote changes: a member that went from A to B a minute ago
        /// and was set back to A by another client would look as if B had been lost. Within the
        /// window that case is accepted: a remote reset to a value the member held in the window,
        /// or when it began, is undone.
        /// </para>
        /// <para>
        /// Counted from when this client noticed the outage, not from the answer, so a change lost
        /// at the drop is recognised after an outage of any length; after a link that drops again
        /// before the answers arrive, from the first outage (see Sync.RequestModelsAgain).
        /// Not readonly so tests can shorten it.
        /// </para>
        /// </remarks>
        internal static double WindowSeconds = DefaultWindowSeconds;

        // Statics survive between Play sessions when domain reload is disabled.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetWindow() => WindowSeconds = DefaultWindowSeconds;

        // Oldest first: the first _heard were sent by the time the server was last heard from (as of
        // the latest send), the rest after. Allocated at the first send, since a member that takes
        // remote values has a SentValues too and may never send. Room for Capacity on either side,
        // the newest, and the incoming value.
        private JToken[] _values;
        private double[] _times;
        private int _count;
        private int _heard;

        // The value held before the oldest one kept: the last one dropped from the oldest end, or the
        // one the server last showed. Null when there is neither.
        private JToken _heldBefore;

        // While the answers to a reconnect's requests come in: how many of the oldest values were kept
        // when the requests went out. Zero otherwise.
        private int _keptForAnswers;

        /// <param name="value">
        /// The value as it went into the update. It must not change afterwards; the caller copies
        /// one that may.
        /// </param>
        /// <param name="time">When it was sent, on <see cref="SyncTicker"/>'s clock.</param>
        /// <param name="heardAt">When the server was last heard from, on the same clock.</param>
        /// <param name="answersPending">
        /// Whether the answers to a reconnect's requests are still coming in.
        /// </param>
        internal void Remember(JToken value, double time, double heardAt, bool answersPending = false)
        {
            if (_values == null)
            {
                _values = new JToken[2 * Capacity + 2];
                _times = new double[2 * Capacity + 2];
            }

            if (!answersPending)
                _keptForAnswers = 0;

            // Sent after the requests, so no answer holds it: only the newest is kept, after the
            // values kept for the answers.
            if (_keptForAnswers > 0)
            {
                _values[_keptForAnswers] = value;
                _times[_keptForAnswers] = time;
                _count = _keptForAnswers + 1;
                return;
            }

            // The newest value sent while the answers came in may still occupy the slot for the
            // incoming value.
            if (_count == _values.Length)
                DropOldest(1);

            _values[_count] = value;
            _times[_count] = time;
            _count++;

            // Sent in order, so those sent by the time the server was last heard from come first.
            while (_heard < _count && _times[_heard] <= heardAt)
                _heard++;

            // Of those, the latest Capacity are kept; the newest one dropped is _heldBefore.
            if (_heard > Capacity)
                DropOldest(_heard - Capacity);

            // Of those sent after, the first Capacity and the newest are kept: the one before the
            // newest goes.
            while (_count - _heard > Capacity + 1)
            {
                _count--;
                _values[_count - 1] = _values[_count];
                _times[_count - 1] = _times[_count];
                _values[_count] = null;
            }
        }

        /// <summary>
        /// For when the requests made again after a reconnect go out: the values kept now stay as
        /// they are until their answers are in (see <see cref="Remember"/>).
        /// </summary>
        internal void KeepUntilAnswered()
        {
            if (_count == 0)
                return;

            // A round after one whose answers never came keeps that one's values and the newest
            // since; if that fills every slot, the oldest goes.
            if (_count == _values.Length)
                DropOldest(1);

            // Hearing from the server on the new connection says nothing about the values sent into
            // the dead one, which later sends would otherwise push out.
            _keptForAnswers = _count;
        }

        private void DropOldest(int dropped)
        {
            _heldBefore = _values[dropped - 1];
            _count -= dropped;
            _heard = Math.Max(0, _heard - dropped);
            Array.Copy(_values, dropped, _values, 0, _count);
            Array.Copy(_times, dropped, _times, 0, _count);
            Array.Clear(_values, _count, dropped);
        }

        /// <summary>
        /// For when the server shows that it holds <paramref name="value"/>, in a remote update or in
        /// an answer that shows the member's last change lost. Earlier sends say nothing about the
        /// server any more and are forgotten.
        /// </summary>
        /// <param name="value">
        /// The value as it arrived. It must not change afterwards; the caller copies one that may.
        /// </param>
        internal void ServerShowed(JToken value)
        {
            if (_values != null)
                Array.Clear(_values, 0, _count);
            _count = 0;
            _heard = 0;
            _keptForAnswers = 0;

            // The value before the next send: if that is lost too, an answer still holding this
            // value recognises it.
            _heldBefore = value;
        }

        internal bool HasSentSince(double since) => _count > 0 && _times[_count - 1] >= since;

        /// <summary>
        /// Compares the server's value with the values sent at or after <paramref name="since"/>,
        /// newest first, and then with the one the member held when that time began.
        /// </summary>
        internal Verdict Judge(JToken serverValue, double since)
        {
            if (!HasSentSince(since))
                return Verdict.NotSentRecently;

            var server = ToWireForm(serverValue);
            for (var i = _count - 1; i >= 0; i--)
            {
                var held = WireEquals(ToWireForm(_values[i]), server);

                // Sent before the window, so this is the value held when it began. Everything older
                // does not count.
                if (_times[i] < since)
                    return held ? Verdict.Lost : Verdict.ChangedElsewhere;

                if (held)
                    return i == _count - 1 ? Verdict.Arrived : Verdict.Lost;
            }

            // Everything kept was sent in the window, so the value before the oldest was held in the
            // window or when it began.
            return _heldBefore != null && WireEquals(ToWireForm(_heldBefore), server)
                ? Verdict.Lost
                : Verdict.ChangedElsewhere;
        }

        // The value as a client reads it off the wire: written as the connection writes it, read back
        // as it reads payloads, dates left as strings (see PayloadCodec.ParsePayload). A float
        // member's 0.1f is held as a float, which is not the double 0.1 the server's answer reads as.
        private static JToken ToWireForm(JToken value)
        {
            if (value == null)
                return JValue.CreateNull();

            using (var reader = new JsonTextReader(new StringReader(value.ToString(Formatting.None))) { DateParseHandling = DateParseHandling.None })
                return JToken.ReadFrom(reader);
        }

        /// <summary>
        /// JSON equality, except that an integer and a float of the same value are equal: a float
        /// member holding a whole number goes out as <c>2.0</c>, and the server sends back <c>2</c>.
        /// </summary>
        internal static bool WireEquals(JToken a, JToken b)
        {
            if (IsNumber(a) && IsNumber(b))
                return a.Type == b.Type ? JToken.DeepEquals(a, b) : (double)a == (double)b;

            if (a is JArray arrayA && b is JArray arrayB)
            {
                if (arrayA.Count != arrayB.Count)
                    return false;

                for (var i = 0; i < arrayA.Count; i++)
                {
                    if (!WireEquals(arrayA[i], arrayB[i]))
                        return false;
                }
                return true;
            }

            if (a is JObject objectA && b is JObject objectB)
            {
                if (objectA.Count != objectB.Count)
                    return false;

                foreach (var property in objectA)
                {
                    if (!objectB.TryGetValue(property.Key, out var other) || !WireEquals(property.Value, other))
                        return false;
                }
                return true;
            }

            return JToken.DeepEquals(a, b);
        }

        private static bool IsNumber(JToken token) => token.Type == JTokenType.Integer || token.Type == JTokenType.Float;
    }
}
