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
    }
}
