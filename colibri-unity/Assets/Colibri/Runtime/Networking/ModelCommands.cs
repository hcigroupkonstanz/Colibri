using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>Model commands in the connection's queues: which messages may be dropped, and which updates fold into a queued one.</summary>
    internal static class ModelCommands
    {
        private const string MODEL_REQUEST_COMMAND = "model::request";
        internal const string MODEL_UPDATE_COMMAND = "model::update";
        private const string MODEL_DELETE_COMMAND = "model::delete";

        internal static bool IsDroppable(string command)
            => command != MODEL_REQUEST_COMMAND && command != MODEL_UPDATE_COMMAND && command != MODEL_DELETE_COMMAND;

        internal static bool TryGetModelId(JToken payload, out JObject update, out string id)
        {
            update = payload as JObject;
            id = null;

            if (update == null || !(update["id"] is JValue value) || value.Type != JTokenType.String)
                return false;

            id = (string)value;
            return true;
        }

        internal static bool IsFoldableUpdate(string command, JToken payload, out JObject update, out string id)
        {
            if (command != MODEL_UPDATE_COMMAND || !TryGetModelId(payload, out update, out id))
            {
                update = null;
                id = null;
                return false;
            }

            // A bare { id } is the server's answer to a request for a model it does not hold, which
            // SyncBehaviour acts on as such. Folded into an update with members, it would be lost.
            return update.Count > 1;
        }

        // Under the lock that guards folds, for a model command that is not folded (an awaited update, a
        // request, a delete). A folded update goes to the back, so the update queued for an object may absorb later
        // ones only while nothing else about it is queued behind: otherwise its older values would
        // overtake a newer update, arrive after a delete and revive the object, or miss a request the
        // server then answers without them.
        internal static void EndFolds<T>(Dictionary<(string Channel, string Id), T> folds, string channel, JToken payload)
        {
            if (TryGetModelId(payload, out _, out var id))
            {
                folds.Remove((channel, id));
                return;
            }

            // No id: a request for the whole channel, which is about every object on it. (A
            // malformed update or delete ends up here too; ending more folds than needed only
            // costs queue space.)
            List<(string Channel, string Id)> onChannel = null;
            foreach (var key in folds.Keys)
            {
                if (key.Channel == channel)
                    (onChannel ??= new List<(string Channel, string Id)>()).Add(key);
            }

            if (onChannel != null)
            {
                foreach (var key in onChannel)
                    folds.Remove(key);
            }
        }
    }
}
