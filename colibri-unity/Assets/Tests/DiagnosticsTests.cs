using System;
using System.Collections;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// What Colibri says when a message cannot be delivered.
    ///
    /// Sending a value on a channel whose listener expects a different type is the most common
    /// mistake when getting started, and it used to be dropped in complete silence. Saying so is
    /// only useful if it is said once - a warning per message would arrive sixty times a second and
    /// be scrolled past.
    /// </summary>
    public class DiagnosticsTests : ColibriE2EFixture
    {
        [UnityTest]
        public IEnumerator AMismatchedTypeIsReportedOnceHoweverManyArrive()
        {
            var channel = E2EServer.Channel("mismatch");
            Action<float> handler = _ => Assert.Fail("A string reached a float listener");

            Sync.Receive(channel, handler);
            try
            {
                LogAssert.Expect(LogType.Warning, new Regex(
                    $"^Colibri: a string arrived on channel '{Regex.Escape(channel)}', "
                    + "but the listener registered there expects float\\."));

                for (var i = 0; i < 60; i++)
                    Peer.Send(channel, "broadcast::string", $"\"message {i}\"");

                yield return E2EServer.Settle(2f);

                // Anything beyond the one expected warning is left in the queue and fails here.
                LogAssert.NoUnexpectedReceived();
            }
            finally
            {
                Sync.Unregister(channel, handler);
            }
        }

        /// <summary>
        /// The other side of the same judgement: every client sees every channel its app uses, so a
        /// channel this client happens not to listen to is ordinary traffic, not a mistake. Warning
        /// about it would teach people that Colibri's warnings are noise.
        /// </summary>
        [UnityTest]
        public IEnumerator AChannelWithNoListenersIsNotReportedAtAll()
        {
            var channel = E2EServer.Channel("unwatched");

            Peer.Send(channel, "broadcast::string", "\"nobody is listening\"");

            yield return E2EServer.Settle(1.5f);

            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// A payload of the wrong shape has to be reported and skipped. Throwing takes down the
        /// frame's whole dispatch loop, which silently drops every message queued behind it.
        /// </summary>
        [UnityTest]
        public IEnumerator AMalformedPayloadDoesNotStopTheMessagesBehindIt()
        {
            var channel = E2EServer.Channel("malformed");
            var good = 0;
            Action<Vector3> handler = _ => good++;

            Sync.Receive(channel, handler);
            Cleanup.Add(() => Sync.Unregister(channel, handler));

            LogAssert.Expect(LogType.Warning, new Regex("^Colibri: received a vector3 "));

            Peer.Send(channel, "broadcast::vector3", "\"not a vector\"");
            Peer.Send(channel, "broadcast::vector3", "[1,2,3]");

            yield return E2EServer.WaitUntil(() => good > 0,
                "The message behind the malformed one never arrived");
        }
    }
}
