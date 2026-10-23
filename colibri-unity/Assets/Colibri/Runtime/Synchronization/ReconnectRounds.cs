using System;
using System.Collections.Generic;

namespace HCIKonstanz.Colibri.Synchronization
{
    internal sealed class ReconnectRounds
    {
        private ReconnectRound _reconnectRound;

        // Rounds an object opened at its first answer (see Sync.AskForEndOfAnswers), by the id their last request asks for,
        // until it is answered.
        private readonly Dictionary<string, ReconnectRound> _answerRounds = new Dictionary<string, ReconnectRound>();

        internal string CurrentEndMarker => _reconnectRound?.EndMarkerId;

        internal void AddAnswerRound(ReconnectRound round) => _answerRounds[round.EndMarkerId] = round;

        internal ReconnectRound OpenReconnectRound(double disconnectedAt)
        {
            // A round still open lost its answers: the link dropped again soon after the last reconnect. A change lost at
            // the earlier drop is still in question, so the new round counts from that outage. Counted from this one, that
            // change would predate DisconnectedAt and the stale answer would be applied.
            if (_reconnectRound != null)
            {
                disconnectedAt = Math.Min(disconnectedAt, _reconnectRound.DisconnectedAt);
                _reconnectRound.IsOver = true;
            }

            // Same for a round an object opened at its first answer: the object is in the new round now, and what it sent
            // in place of the server's values is judged like any other value sent.
            EndAnswerRounds();

            var round = new ReconnectRound(disconnectedAt);
            _reconnectRound = round;
            return round;
        }

        internal bool TryEndAnswerRound(string marker)
        {
            if (_answerRounds.TryGetValue(marker, out var answerRound))
            {
                _answerRounds.Remove(marker);
                answerRound.IsOver = true;
                return true;
            }
            return false;
        }

        internal bool TryEndReconnectRound(string marker)
        {
            var round = _reconnectRound;
            if (round == null || marker != round.EndMarkerId)
                return false;

            round.IsOver = true;
            _reconnectRound = null;
            return true;
        }

        internal void EndAll()
        {
            if (_reconnectRound != null)
            {
                _reconnectRound.IsOver = true;
                _reconnectRound = null;
            }
            EndAnswerRounds();
        }

        internal void Reset()
        {
            _reconnectRound = null;
            EndAnswerRounds();
        }

        // These rounds' end markers were requested on a connection that is gone. After a reconnect the requests made
        // again open the round those objects are in.
        private void EndAnswerRounds()
        {
            foreach (var round in _answerRounds.Values)
                round.IsOver = true;
            _answerRounds.Clear();
        }
    }
}
