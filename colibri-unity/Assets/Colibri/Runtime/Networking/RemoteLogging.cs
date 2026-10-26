using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public class RemoteLogging : MonoBehaviour
    {
        private struct LogMsg
        {
            public string Type;
            public string Message;
            public LogMsg(string type, string msg)
            {
                Type = type;
                Message = msg;
            }
        }

        private const float SendIntervalSeconds = 1f;

        // Oldest lines drop past this. During an outage lines wait here, not in the connection's outbox,
        // where they would push broadcasts out of its MAX_QUEUED_MESSAGES cap.
        private const int MaxBufferedLines = 1000;

        // Filled from any thread (logMessageReceivedThreaded), drained on the main thread.
        private readonly ConcurrentQueue<LogMsg> _messages = new ConcurrentQueue<LogMsg>();

        // ConcurrentQueue.Count walks its segments, so the count is kept here.
        private int _bufferedLines;

        // Lines dropped past MaxBufferedLines since the last send.
        private int _droppedLines;

        private WebServerConnection _server;
        private float _nextSendTime;

        // For the EditMode tests.
        internal int BufferedLineCount => Volatile.Read(ref _bufferedLines);
        internal string[] BufferedLines => _messages.Select(m => m.Message).ToArray();

        private void OnEnable()
        {
            _server = WebServerConnection.Instance;
            Application.logMessageReceivedThreaded += OnLogMessage;
        }

        private void OnDisable()
        {
            Application.logMessageReceivedThreaded -= OnLogMessage;
        }

        private void Update()
        {
            // Fetch again: Instance was null in OnEnable, or the connection has been destroyed since.
            if (_server == null)
            {
                _server = WebServerConnection.Instance;
                if (_server == null)
                    return;
            }

            switch (_server.Status)
            {
                case ConnectionStatus.Connected:
                    break;

                case ConnectionStatus.ProtocolMismatch:
                    // Final, so anything kept would be kept forever.
                    Discard();
                    return;

                default:
                    // Keep buffering until connected.
                    return;
            }

            if (BufferedLineCount == 0 || Time.unscaledTime < _nextSendTime)
                return;

            _nextSendTime = Time.unscaledTime + SendIntervalSeconds;
            SendLog();
        }

        // Internal for the EditMode tests.
        internal void OnLogMessage(string condition, string stackTrace, LogType type)
        {
            string logType;

            switch (type)
            {
                case LogType.Log:
                    logType = "info";
                    break;

                case LogType.Warning:
                    logType = "warning";
                    break;

                case LogType.Error:
                case LogType.Exception:
                    logType = "error";
                    break;

                case LogType.Assert:
                default:
                    logType = "debug";
                    break;
            }

            var msg = condition;
            if (type == LogType.Error || type == LogType.Exception)
                msg += "\n" + stackTrace;

            _messages.Enqueue(new LogMsg(logType, msg));

            if (Interlocked.Increment(ref _bufferedLines) > MaxBufferedLines && _messages.TryDequeue(out _))
            {
                Interlocked.Decrement(ref _bufferedLines);
                Interlocked.Increment(ref _droppedLines);
            }
        }

        // The connection keeps what it is handed if it drops, so nothing is retried here.
        private void SendLog() => SendLog((type, line) => _server.SendCommand("log", type, line));

        // Internal, with send injected, for the EditMode tests.
        internal void SendLog(Action<string, string> send)
        {
            // Sent directly: through Debug.Log it would come back here as another buffered line.
            var dropped = Interlocked.Exchange(ref _droppedLines, 0);
            if (dropped > 0)
            {
                send("warning", $"Colibri: {dropped} log {(dropped == 1 ? "line is" : "lines are")} missing here - more than {MaxBufferedLines} "
                    + "were logged before they could be sent, and the oldest were dropped. The device's own log has them all.");
            }

            var sentThisBatch = new HashSet<string>();
            while (_messages.TryDequeue(out var logMsg))
            {
                Interlocked.Decrement(ref _bufferedLines);

                // skip duplicated messages
                if (sentThisBatch.Add(logMsg.Message))
                    send(logMsg.Type, logMsg.Message);
            }
        }

        private void Discard()
        {
            while (_messages.TryDequeue(out _))
                Interlocked.Decrement(ref _bufferedLines);

            Interlocked.Exchange(ref _droppedLines, 0);
        }
    }
}
