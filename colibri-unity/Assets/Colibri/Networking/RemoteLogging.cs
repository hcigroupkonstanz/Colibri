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

        /// <summary>
        /// Lines kept between two sends, connected or not; past this the oldest go. While connected
        /// that is a second's worth - which is also all a runaway log loop can cost the server - and
        /// while not, an outage's worth: held here rather than in the connection's own queue so that
        /// a long outage's log output cannot crowd the messages that synchronize the application out
        /// of that queue's bound. What is dropped is not lost without a trace: the next send starts
        /// with one line saying how many are missing.
        /// </summary>
        private const int MaxBufferedLines = 1000;

        // Filled from Application.logMessageReceivedThreaded - that is, from whichever threads log,
        // several at once - and drained on the main thread. A ConcurrentQueue: the LockFreeQueue
        // this used to be recycles its nodes through a pool that is only safe with one producer.
        private readonly ConcurrentQueue<LogMsg> _messages = new ConcurrentQueue<LogMsg>();

        // Kept alongside the queue rather than asking it: ConcurrentQueue.Count walks its segments.
        private int _bufferedLines;

        // Lines dropped by MaxBufferedLines since the last send.
        private int _droppedLines;

        private WebServerConnection _server;
        private float _nextSendTime;

        /// <summary>How many log lines are waiting to be sent. For the test suite.</summary>
        internal int BufferedLineCount => Volatile.Read(ref _bufferedLines);

        /// <summary>The log lines waiting to be sent, oldest first. For the test suite.</summary>
        internal string[] BufferedLines => _messages.Select(m => m.Message).ToArray();

        void OnEnable()
        {
            _server = WebServerConnection.Instance;
            Application.logMessageReceivedThreaded += OnLogMessage;
        }

        void OnDisable()
        {
            Application.logMessageReceivedThreaded -= OnLogMessage;
        }

        void Update()
        {
            // Unity's ==: the connection is rebuilt when a new Play session starts without a
            // domain reload, and this component may outlive the one it first found.
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
                    // Final - nothing will be sent again - so anything kept would be kept forever.
                    Discard();
                    return;

                default:
                    // Kept for when the connection is back, up to MaxBufferedLines.
                    return;
            }

            // Batches a second's worth of log lines at a time.
            if (BufferedLineCount == 0 || Time.unscaledTime < _nextSendTime)
                return;

            _nextSendTime = Time.unscaledTime + SendIntervalSeconds;
            SendLog();
        }

        /// <remarks>Internal so the EditMode tests can log from several threads without a player loop.</remarks>
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

        /// <summary>
        /// Hands every waiting line to the connection, once. The connection keeps them, in order,
        /// if it drops on the way, so there is nothing to retry here - and retrying is what used to
        /// send some lines twice: a send that failed after connecting was both queued for retry by
        /// the connection and put back in this queue.
        /// </summary>
        private void SendLog() => SendLog((type, line) => _server.SendCommand("log", type, line));

        /// <remarks>Internal, with the send handed in, so the EditMode tests can see what a batch sends.</remarks>
        internal void SendLog(Action<string, string> send)
        {
            // Where the lines went missing, and once for all of them. Handed straight to the
            // connection: through Debug.Log it would come back in here as one more line to buffer.
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
