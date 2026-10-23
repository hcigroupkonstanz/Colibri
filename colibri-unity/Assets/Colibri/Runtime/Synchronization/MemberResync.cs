using System;
using Newtonsoft.Json.Linq;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>A <see cref="SyncBehaviour{T}"/>'s state for the answers after a reconnect: what its members sent, which keep their local value, and its round.</summary>
    internal sealed class MemberResync<T> where T : SyncBehaviour<T>
    {
        // Parallel to SyncMembers<T>.AttributeList, made lazily: when a member first sends or takes the server's value.
        private SentValues[] _sentValues;

        // The ReconnectRound the object is in: after a reconnect, or opened at its first answer to
        // keep changes made before it. Null otherwise.
        private ReconnectRound _round;

        // Parallel to SyncMembers<T>.AttributeList: members that keep their local value for the rest of the round, and
        // send it again.
        private bool[] _keptInRound;

        // Parallel to SyncMembers<T>.AttributeList: members that sent after the round's requests went out; the server
        // reads what they sent after everything in the round.
        private bool[] _sentInRound;

        internal string RoundEndMarker => _round == null || _round.IsOver ? null : _round.EndMarkerId;

        internal void Reset()
        {
            _round = null;
            _keptInRound = null;
            _sentInRound = null;
            _sentValues = null;
        }

        internal ReconnectRound CurrentRound()
        {
            var round = _round;
            if (round != null && round.IsOver)
                round = _round = null;
            return round;
        }

        internal ReconnectRound EnterRound(ReconnectRound round) => _round = round;

        /// <summary>
        /// Keeps the values of an outgoing update, for judging the server's answers after a reconnect
        /// (see <see cref="KeepsLocalValue"/>).
        /// </summary>
        internal void RememberSent(JObject update, double now, double heardAt)
        {
            var answersPending = _round != null && !_round.IsOver;

            // By hand: Properties() would allocate an enumerator per update.
            for (var token = update.First; token != null; token = token.Next)
            {
                var property = (JProperty)token;
                if (!SyncMembers<T>.SyncedAttributes.TryGetValue(property.Name, out var attribute))
                    continue;

                SentValuesOf(attribute).Remember(ToKeep(attribute, property.Value), now, heardAt, answersPending);

                if (answersPending)
                    (_sentInRound ??= new bool[SyncMembers<T>.AttributeList.Count])[attribute.Index] = true;
            }
        }

        internal void ServerShowed(SyncedAttribute<T> attribute, JToken value)
            => SentValuesOf(attribute).ServerShowed(ToKeep(attribute, value));

        private SentValues SentValuesOf(SyncedAttribute<T> attribute)
        {
            _sentValues ??= new SentValues[SyncMembers<T>.AttributeList.Count];
            return _sentValues[attribute.Index] ??= new SentValues();
        }

        /// <summary>
        /// A value as SentValues keeps it. A JObject member's value is the application's own object,
        /// which it may change in place later, so it is cloned.
        /// </summary>
        private static JToken ToKeep(SyncedAttribute<T> attribute, JToken value)
            => attribute.PropertyType == typeof(JObject) ? value.DeepClone() : value;


        // The answers to the requests made again after a reconnect.
        //
        // A change made as the link dropped is lost and the server answers with the value from before it.
        // Applied, that undoes the change here while every other client keeps the old value. So each member of
        // what arrives in the round (see ReconnectRound) is judged against the values it sent recently and
        // the one it held before them (SentValues):
        //
        // 1. The value sent last: it arrived, nothing to do.
        // 2. A value sent before that, or the one held before them (all an object that sat still has: switched
        //    off at the drop after a minute on, it sent only the lost `false`): what followed was lost. The local
        //    value goes out again as an ordinary update under the rate limit, and the member takes nothing more
        //    from the round. The answer's value becomes the value held before the resend, so a second loss is
        //    recognised too. A remote reset to one of these values during the outage looks the same and is undone.
        // 3. Any other value, or a member that did not send recently: another client set it, and it is applied.
        //
        // A member missing from what arrives is left alone: a remote update carries only what changed.
        // Until the answers are in, a member keeps the values it had sent when the requests went out
        // (SentValues.KeepUntilAnswered). What it sends after the requests reaches the server after everything
        // in the round, so it keeps its value whatever arrives and is sent again, with what arrived as the
        // value held before it.

        /// <summary>Told by Sync that the model has just been asked for again after a reconnect.</summary>
        internal void OnRequestedAgain(ReconnectRound round)
        {
            _round = round;

            if (_keptInRound != null)
                Array.Clear(_keptInRound, 0, _keptInRound.Length);
            if (_sentInRound != null)
                Array.Clear(_sentInRound, 0, _sentInRound.Length);

            if (_sentValues != null)
            {
                foreach (var sent in _sentValues)
                    sent?.KeepUntilAnswered();
            }
        }

        internal bool KeepsLocalValue(SyncedAttribute<T> attribute, JToken serverValue, ReconnectRound round,
            out bool sendAgain)
        {
            sendAgain = false;

            // Includes a member kept at the first answer, which may not have sent yet.
            if (_keptInRound != null && _keptInRound[attribute.Index])
                return true;

            var sent = _sentValues?[attribute.Index];
            if (sent == null)
                return false;

            switch (sent.Judge(serverValue, round.DisconnectedAt - SentValues.WindowSeconds))
            {
                case SentValues.Verdict.Arrived:
                    return true;

                case SentValues.Verdict.Lost:
                    break;

                default:
                    // Sent after the requests, and read by the server after this value.
                    if (_sentInRound == null || !_sentInRound[attribute.Index])
                        return false;
                    break;
            }

            // The server holds this value; if the resend is lost too, the next round recognises it by this value.
            sent.ServerShowed(ToKeep(attribute, serverValue));
            sendAgain = true;
            return true;
        }

        internal void MarkKept(SyncedAttribute<T> attribute)
        {
            _keptInRound ??= new bool[SyncMembers<T>.AttributeList.Count];
            _keptInRound[attribute.Index] = true;
        }
    }
}
