using System;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The values one [Sync] member of one object sent around the time the connection last worked,
    /// and the one it held before them, kept for a single decision: what to do with that member in
    /// the server's answers to the requests made again after a reconnect (see <see cref="Judge"/>
    /// and Sync.ReconnectRound).
    /// </summary>
    /// <remarks>
    /// <para>
    /// A change made the moment a headset's Wi-Fi drops is written into a connection that is
    /// already dead, and is lost: the client only notices about two seconds later, when the
    /// server's heartbeats stop. After the reconnect the server answers the request with the value
    /// from before that change, and applying it, as every update used to be applied, put the
    /// object back on the very client that had changed it, while every other client kept the old
    /// value as well - until the member changed again, which a released grab or a switched-off
    /// object never does.
    /// </para>
    /// <para>
    /// The answer alone cannot tell such a lost change from one another client made during the
    /// outage. What the member held can: a value it held before the one it sent last says that
    /// one never arrived, while a value it did not hold was set by someone else.
    /// </para>
    /// <para>
    /// What it held is what it sent in the window (<see cref="WindowSeconds"/>), and the value it
    /// held when the window began. The latter is all there is for an object that sat still: one
    /// switched on a minute ago and switched off at the drop sent only <c>false</c> in the window,
    /// and the answer's <c>true</c> is the change lost, not another client's. It is the newest
    /// value sent before the window if one is kept, and otherwise the value held before the oldest
    /// one kept: the last one dropped, or the one the server last showed. That is a value the
    /// member took from elsewhere, such as the server's state when the object first came up, or
    /// the one an answer held when it showed the member's last change lost.
    /// </para>
    /// <para>
    /// Which values are kept follows from when this client last heard from the server, which
    /// heartbeats every 100 ms: the link died at most about that long after, and the value the
    /// server has was sent around then. Everything sent from then until the outage is noticed went
    /// into the dead link, about 60 values for an object moved at 30 updates a second. So kept are
    /// the latest <see cref="Capacity"/> values sent up to that time, the first
    /// <see cref="Capacity"/> sent after it, and the newest, however long the outage. While the
    /// connection works, this client hears from the server all the time, and a value dropped from
    /// in between was replaced by a later one that reached the server as well.
    /// </para>
    /// <para>
    /// While the answers to the requests made again after a reconnect are coming in, the values
    /// kept when the requests went out stay as they are (see <see cref="KeepUntilAnswered"/>), and
    /// of those sent since, only the newest is kept besides: the answers hold what the server had
    /// before it read anything sent after the requests. Hearing from the server on the new
    /// connection says nothing about the values sent into the dead one, and an object moved on
    /// right after the reconnect used to push them out.
    /// </para>
    /// </remarks>
    internal sealed class SentValues
    {
        internal enum Verdict
        {
            /// <summary>Nothing sent recently: the answer is applied, as any update is.</summary>
            NotSentRecently,

            /// <summary>The server holds the value sent last: it arrived, and there is nothing to do.</summary>
            Arrived,

            /// <summary>
            /// The server holds a value the member held before the one it sent last: what was sent
            /// after it never arrived. The local value stays, and goes out again.
            /// </summary>
            Lost,

            /// <summary>
            /// The server holds a value this member did not hold recently: another client set it
            /// while this one was away, and the answer is applied.
            /// </summary>
            ChangedElsewhere,
        }

        /// <summary>
        /// How many values are kept on either side of when this client last heard from the server:
        /// the latest sent up to then, and the first sent after. The newest is kept as well.
        /// </summary>
        internal const int Capacity = 8;

        private const double DefaultWindowSeconds = 10;

        /// <summary>
        /// How long before the connection was lost a value may have been sent and still count. A
        /// member that sent nothing in that time has nothing to judge. A value sent long before
        /// cannot tell a lost change from another client's: a member that went from A to B a minute
        /// ago and that another client has set back to A during the outage would look as if B had
        /// been lost, and the other client's change would be undone.
        /// </summary>
        /// <remarks>
        /// <para>
        /// For a member that did send in the window, that is what happens, and is accepted: another
        /// client that sets it back during the outage, to a value it held in the window or when the
        /// window began, is undone.
        /// </para>
        /// <para>
        /// Counted back from the moment this client noticed the outage, not from the answer, so a
        /// change lost at the drop is still recognised after an outage of any length; after a link
        /// that drops again before the answers arrive, from the first outage (see
        /// Sync.RequestModelsAgain). Settable only so the test suite can shorten it.
        /// </para>
        /// </remarks>
        internal static double WindowSeconds = DefaultWindowSeconds;

        /// <summary>A setting changed by a test does not carry into the next Play session.</summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetWindow() => WindowSeconds = DefaultWindowSeconds;

        // Oldest first: the first _heard were sent by the time this client last heard from the
        // server, as the latest send knew it, the rest after. Made at the first send, since every
        // member that takes a value from elsewhere has a SentValues too, and on an object only ever
        // moved by other clients none of them sends. Capacity on either side, the newest, and room
        // for the value coming in.
        private JToken[] _values;
        private double[] _times;
        private int _count;
        private int _heard;

        // The value the member held before the oldest one kept: the last one dropped from those sent
        // by the time the server was last heard from, or the one the server last showed. Null when
        // there is neither.
        private JToken _heldBefore;

        // While the answers to the requests made again after a reconnect are coming in, how many of
        // the values, oldest first, were kept when the requests went out; zero otherwise.
        private int _keptForAnswers;

        /// <param name="value">
        /// The value as it went into the update. It must not change afterwards; the caller copies
        /// one that may.
        /// </param>
        /// <param name="time">When it was sent, on <see cref="SyncTicker"/>'s clock.</param>
        /// <param name="heardAt">When this client last heard from the server, on the same clock.</param>
        /// <param name="answersPending">
        /// Whether the answers to the requests made again after a reconnect are still coming in.
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

            // Sent after the requests, so no answer holds it: kept as the newest only, after the
            // values kept for the answers.
            if (_keptForAnswers > 0)
            {
                _values[_keptForAnswers] = value;
                _times[_keptForAnswers] = time;
                _count = _keptForAnswers + 1;
                return;
            }

            // Once the answers are in, the newest value sent while they came in may still have the
            // slot that is otherwise free for the value coming in.
            if (_count == _values.Length)
                DropOldest(1);

            _values[_count] = value;
            _times[_count] = time;
            _count++;

            // Sent in order, so those sent by the time the server was last heard from come first.
            while (_heard < _count && _times[_heard] <= heardAt)
                _heard++;

            // Of those, the latest are kept, and the one before them is what the member held before
            // the oldest one kept.
            if (_heard > Capacity)
                DropOldest(_heard - Capacity);

            // Of those sent after, the first are kept, and the newest: the value before the newest
            // goes unless it is one of the first.
            while (_count - _heard > Capacity + 1)
            {
                _count--;
                _values[_count - 1] = _values[_count];
                _times[_count - 1] = _times[_count];
                _values[_count] = null;
            }
        }

        /// <summary>
        /// For when the requests made again after a reconnect go out: until their answers are in
        /// (see <see cref="Remember"/>), the values kept now stay as they are. A round that follows
        /// one whose answers never came keeps that one's values, and the newest sent since: should
        /// that fill every slot, the oldest goes.
        /// </summary>
        internal void KeepUntilAnswered()
        {
            if (_count == 0)
                return;

            if (_count == _values.Length)
                DropOldest(1);

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
        /// For when the server shows that it holds <paramref name="value"/>: in an update the member
        /// takes from elsewhere, or in an answer that shows the member's last change lost. What
        /// this object sent before says nothing about the server any more, and is forgotten. The
        /// value shown is kept as the one before the next send: should that be lost as well, an
        /// answer still holding this value tells it.
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
            _heldBefore = value;
        }

        /// <summary>Whether a value was sent at or after <paramref name="since"/>.</summary>
        internal bool HasSentSince(double since) => _count > 0 && _times[_count - 1] >= since;

        /// <summary>
        /// Compares the server's value with the values sent at or after <paramref name="since"/>,
        /// newest first, and then with the one the member held when that time began, as they read
        /// on the wire.
        /// </summary>
        internal Verdict Judge(JToken serverValue, double since)
        {
            if (!HasSentSince(since))
                return Verdict.NotSentRecently;

            var server = ToWireForm(serverValue);
            for (var i = _count - 1; i >= 0; i--)
            {
                var held = WireEquals(ToWireForm(_values[i]), server);

                // Sent before the window: the value held when it began. Sent in order, so
                // everything past this one is older still and does not count.
                if (_times[i] < since)
                    return held ? Verdict.Lost : Verdict.ChangedElsewhere;

                if (held)
                    return i == _count - 1 ? Verdict.Arrived : Verdict.Lost;
            }

            // Everything kept was sent in the window, so the value from before the oldest of
            // them was held in the window too, or when it began.
            return _heldBefore != null && WireEquals(ToWireForm(_heldBefore), server)
                ? Verdict.Lost
                : Verdict.ChangedElsewhere;
        }

        /// <summary>
        /// The value as a client reads it off the wire: written as the connection writes it, and
        /// read back as it reads every payload, with dates left as strings (see
        /// <c>WebServerConnection.ParsePayload</c>). A value sent from here is held as the float it
        /// was made from, 0.1f, which is not the double 0.1 that the server's answer reads as.
        /// </summary>
        private static JToken ToWireForm(JToken value)
        {
            if (value == null)
                return JValue.CreateNull();

            using (var reader = new JsonTextReader(new StringReader(value.ToString(Formatting.None))) { DateParseHandling = DateParseHandling.None })
                return JToken.ReadFrom(reader);
        }

        /// <summary>
        /// JSON equality, with one difference from <see cref="JToken.DeepEquals(JToken, JToken)"/>:
        /// an integer and a float of the same value are equal. A float member holding a whole number
        /// goes out as <c>2.0</c>, and the server, which is JavaScript, sends it back as <c>2</c>.
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
