using System;
using System.Threading;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// What the connection reports about itself: log hints for a missing config, a protocol mismatch and TLS
    /// failures, and the values the Status window shows. Mostly connection loop only; what the main thread reads
    /// is volatile, so there is no lock.
    /// </summary>
    internal sealed class ConnectionDiagnostics
    {
        // A server on another framing cannot decode our frames and cannot send the explicit refusal, so the
        // only symptom is sessions failing before a frame is read. This many in a row log a hint instead of
        // reconnecting silently; unanswered sessions count the same (see CountSessionWithoutAFrame).
        private const int EARLY_FRAME_FAILURES_BEFORE_HINT = 3;

        private readonly ConnectionState _state;
        private readonly Func<ConnectionConfig> _currentConfig;
        private readonly long _heartbeatTimeoutMs;
        private readonly string _clientVersion;

        // Connection loop only.
        private bool _hasReportedMissingConfig;
        private string _reportedSanitizedApp;

        // Connection loop only: the TLS failure last logged as an error, so a server that keeps failing the
        // same way says so once. Cleared by a connection and by OnEnable.
        private string _reportedTlsFailure;

        // Cleared by OnEnable: the warning about a certificate accepted only because self-signed ones are
        // allowed is logged once, not at every reconnect.
        private volatile bool _hasWarnedAboutUntrustedCertificate;

        // Set by each TLS handshake, for the Status window: the certificate the server presented and how it
        // was accepted. Null until a TLS connection has been made.
        private volatile string _presentedCertificateSha256;
        private volatile string _certificateAcceptance;

        // Written by the receive loop off the main thread, read by the Editor status window and by user code
        // on the main thread.
        private volatile string _serverVersion;
        private volatile string _protocolMismatchReason;

        // Connection loop only (the receive loop is part of it), except for the test accessor.
        private int _consecutiveEarlyFrameFailures;
        private int _consecutiveUnansweredSessions;
        private volatile string _suspectedProtocolMismatch;

        private volatile string _lastConnectFailure;

        internal ConnectionDiagnostics(ConnectionState state, Func<ConnectionConfig> currentConfig, long heartbeatTimeoutMs, string clientVersion)
        {
            _state = state;
            _currentConfig = currentConfig;
            _heartbeatTimeoutMs = heartbeatTimeoutMs;
            _clientVersion = clientVersion;
        }

        internal string ServerVersion
        {
            get => _serverVersion;
            set => _serverVersion = value;
        }

        internal string ProtocolMismatchReason
        {
            get => _protocolMismatchReason;
            set => _protocolMismatchReason = value;
        }

        internal string SuspectedProtocolMismatch => _suspectedProtocolMismatch;

        internal string LastConnectFailure
        {
            get => _lastConnectFailure;
            set => _lastConnectFailure = value;
        }

        internal string PresentedCertificateSha256 => _presentedCertificateSha256;

        internal string CertificateAcceptance => _certificateAcceptance;

        internal int ConsecutiveEarlyFrameFailures => Volatile.Read(ref _consecutiveEarlyFrameFailures);

        internal void ResetTlsReports()
        {
            _hasWarnedAboutUntrustedCertificate = false;
            _reportedTlsFailure = null;
        }

        internal void ReportMissingConfig(string app)
        {
            if (!_hasReportedMissingConfig)
            {
                _hasReportedMissingConfig = true;
                Debug.LogError(string.IsNullOrWhiteSpace(app) ? ColibriConfig.NOT_CONFIGURED_MESSAGE : ColibriConfig.NO_SERVER_ADDRESS_MESSAGE);
            }
        }

        internal void ClearMissingConfigReport() => _hasReportedMissingConfig = false;

        internal void ReportSanitizedApp(string app, string handshakeApp)
        {
            if (handshakeApp != app && handshakeApp != _reportedSanitizedApp)
            {
                // Logged, since a client configured with the original name will not see this one.
                _reportedSanitizedApp = handshakeApp;
                Debug.LogWarning(
                    $"Colibri: the App Name '{app}' cannot be sent as it is - it may not contain '::' or start or end with ':'. " +
                    $"Connecting as '{handshakeApp}' instead; change the App Name if other clients use the original.");
            }
        }

        /// <summary>
        /// Called once for every session that ends, whatever ended it. A session that got past the handshake
        /// and ended without a decoded frame counts towards one of two hints, logged after
        /// <see cref="EARLY_FRAME_FAILURES_BEFORE_HINT"/> in a row. Each kind resets the other's count, and the
        /// first decoded frame resets both (<see cref="OnFrameDecoded"/>).
        /// </summary>
        /// <remarks>
        /// Framing hint: a server on another framing cannot decode our frames, so it cannot send the explicit
        /// refusal either. A suspicion only (it looks the same as a port that is not Colibri), so
        /// <see cref="WebServerConnection.Status"/> is left alone; only a refusal this client decoded is terminal.
        /// Unanswered hint: the watchdog ended the session, or with TLS it was closed or reset without a
        /// frame. A 1.x server heartbeats at once, behind a TLS-terminating proxy too, and that fails to
        /// decode; a 2.x server with TLS sends a frame after the handshake. What is left is a proxy whose
        /// backend is down, or a server that does not answer. Without TLS a close cannot be told apart from a
        /// TLS server hanging up on this client, so it counts as framing, whose hint names such a proxy too.
        /// </remarks>
        internal void CountSessionWithoutAFrame(ConnectionLoop loop)
        {
            // Server down, wrong address or closed port: says nothing about protocol versions.
            if (!loop.ReachedHandshake)
                return;

            if (loop.DecodedAnyFrame)
                return;

            // Unanswered session, see above.
            if (loop.EndedSilent || (_state.UsesTls && !loop.EndedOnBadFrame))
            {
                _consecutiveEarlyFrameFailures = 0;
                _consecutiveUnansweredSessions++;
                if (_consecutiveUnansweredSessions == EARLY_FRAME_FAILURES_BEFORE_HINT)
                {
                    var config = _currentConfig();
                    Debug.LogWarning(
                        $"Colibri: {_consecutiveUnansweredSessions} connections in a row to {config.ServerAddress}:{config.TcpPort} were accepted, " +
                        "but nothing was received on any of them: each was closed by the other end or dropped after " +
                        $"{_heartbeatTimeoutMs / 1000f:0.#} s of silence. " +
                        "Something accepts connections there and then closes them or forwards nothing (a proxy or port forwarding " +
                        "whose backend is down, a captive portal, a firewall), or the server there does not answer or is not a " +
                        "colibri-server. Check that colibri-server is running and reachable at this address and port. Retrying...");
                }
                return;
            }

            _consecutiveUnansweredSessions = 0;
            _consecutiveEarlyFrameFailures++;
            if (_consecutiveEarlyFrameFailures != EARLY_FRAME_FAILURES_BEFORE_HINT)
                return;

            var suspicion =
                $"{_consecutiveEarlyFrameFailures} connections in a row were accepted but ended before a single frame could be read. " +
                $"This usually means a protocol mismatch: this client speaks v{_clientVersion} and needs colibri-server >= 2.0.0. " +
                "Check the server's version.";

            // A server with TLS turned on hangs up on a client that is not using it, before a
            // frame, exactly like this, and so does a proxy or port forwarding whose backend is down.
            if (!_state.UsesTls)
            {
                suspicion += " If the server has TLS turned on, tick 'Server supports SSL/TLS' in the Colibri configuration. " +
                    "If a proxy or port forwarding is in front of the server, check that the server behind it is running.";
            }

            // Logged before it is published: this runs on the session loop's thread, and the main thread polls
            // SuspectedProtocolMismatch (Status window, tests) and could act on the value before the line exists.
            Debug.LogError($"Colibri: {suspicion}");
            _suspectedProtocolMismatch = suspicion;
        }

        /// <summary>
        /// The first frame of a session, a refusal included, shows that the server speaks our framing, so the
        /// counts and the suspicion are cleared at once rather than when the session ends.
        /// </summary>
        internal void OnFrameDecoded(ConnectionLoop loop)
        {
            loop.DecodedAnyFrame = true;
            _consecutiveEarlyFrameFailures = 0;
            _consecutiveUnansweredSessions = 0;
            _suspectedProtocolMismatch = null;
        }

        /// <summary>
        /// Keeps the handshake's verdict on the server's certificate for the Status window, and warns once
        /// when it was accepted only because self-signed certificates are allowed: the connection is
        /// encrypted, but nothing checks whose server it is.
        /// </summary>
        internal void NoteCertificate(ServerCertificateCheck check, string host, int port)
        {
            _presentedCertificateSha256 = check.Fingerprint;
            _certificateAcceptance = DescribeAcceptance(check.Verdict);

            if (check.Verdict != ServerCertificatePolicy.Verdict.AcceptedUntrusted || _hasWarnedAboutUntrustedCertificate)
                return;

            _hasWarnedAboutUntrustedCertificate = true;
            Debug.LogWarning($"Colibri: accepted the certificate of {host}:{port} although {check.Problems}, because "
                + "'Allow self-signed certificate' is on. The connection is encrypted, but nothing checks that it goes to your server. "
                + $"To accept only this certificate, enter its fingerprint as 'Server certificate SHA-256': {check.Fingerprint}. "
                + "Said once per session.");
        }

        private static string DescribeAcceptance(ServerCertificatePolicy.Verdict verdict)
        {
            switch (verdict)
            {
                case ServerCertificatePolicy.Verdict.Trusted: return "trusted by this device";
                case ServerCertificatePolicy.Verdict.Pinned: return "matches 'Server certificate SHA-256'";
                case ServerCertificatePolicy.Verdict.AcceptedUntrusted: return "not trusted, accepted because 'Allow self-signed certificate' is on";
                default: return null;
            }
        }

        /// <summary>
        /// Logs a failed TLS handshake as an error the first time it fails that way, since it will not go away
        /// until a setting changes, and after that as a note, like a refused connection. The connection keeps
        /// being retried, so a server switched to TLS or given another certificate is picked up without a restart.
        /// </summary>
        internal void ReportTlsFailure(TlsHandshakeException e)
        {
            var advice = e.Kind == TlsHandshakeException.Failure.NoTlsAnswer
                ? " 'Server supports SSL/TLS' is ticked in the Colibri configuration, so this client uses TLS on the TCP port too: "
                    + "turn TLS on at the server (TLS_CERT and TLS_KEY), or untick the setting."
                : "";

            // Keyed on the kind for a server that does not speak TLS, whose wording varies with how
            // it failed, and on the reason for a rejected certificate, which says what to change.
            var key = e.Kind == TlsHandshakeException.Failure.NoTlsAnswer ? e.Kind.ToString() : e.Message;
            if (key != _reportedTlsFailure)
            {
                _reportedTlsFailure = key;
                Debug.LogError($"Colibri: {e.Message}.{advice} Retrying...");
            }
            else
            {
                Debug.Log($"Colibri: {e.Message}, retrying...");
            }
        }

        internal void ClearReportedTlsFailure() => _reportedTlsFailure = null;
    }
}
