using System;
using System.Collections;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// Every payload shape Colibri supports, over a real socket, in both directions.
    ///
    /// The outbound half asserts the exact bytes, because the wire form is a contract with
    /// colibri-web and with anything else that ever speaks this protocol - "Unity round-trips with
    /// Unity" would pass just as happily with both ends wrong in the same way. The inbound half
    /// feeds Colibri what colibri-web actually sends, which is how two 2.0.0 bugs got in: a colour
    /// arrived as an exception, and an integer was silently dropped.
    /// </summary>
    public class BroadcastTests : ColibriE2EFixture
    {
        /*
         *  Unity -> the wire
         */

        [UnityTest]
        public IEnumerator SendsABool() => UnityToPeer(ch => Sync.Send(ch, true), "broadcast::bool", "true");

        [UnityTest]
        public IEnumerator SendsAnInt() => UnityToPeer(ch => Sync.Send(ch, 42), "broadcast::int", "42");

        [UnityTest]
        public IEnumerator SendsAFloat() => UnityToPeer(ch => Sync.Send(ch, 1.5f), "broadcast::float", "1.5");

        /// <summary>
        /// Quoted, unlike the raw text the log channel carries. v1 wrote strings unquoted, which is
        /// not valid JSON, so the server fell back to a different reader and a Unity string and a
        /// web string did not round-trip identically.
        /// </summary>
        [UnityTest]
        public IEnumerator SendsAString() => UnityToPeer(ch => Sync.Send(ch, "hi"), "broadcast::string", "\"hi\"");

        [UnityTest]
        public IEnumerator SendsAVector2()
            => UnityToPeer(ch => Sync.Send(ch, new Vector2(1f, 2f)), "broadcast::vector2", "[1.0,2.0]");

        [UnityTest]
        public IEnumerator SendsAVector3()
            => UnityToPeer(ch => Sync.Send(ch, new Vector3(1f, 2f, 3f)), "broadcast::vector3", "[1.0,2.0,3.0]");

        [UnityTest]
        public IEnumerator SendsAQuaternion()
            => UnityToPeer(ch => Sync.Send(ch, Quaternion.identity), "broadcast::quaternion", "[0.0,0.0,0.0,1.0]");

        [UnityTest]
        public IEnumerator SendsAColor()
            => UnityToPeer(ch => Sync.Send(ch, Color.red), "broadcast::color", "\"#FF0000FF\"");

        [UnityTest]
        public IEnumerator SendsABoolArray()
            => UnityToPeer(ch => Sync.Send(ch, new[] { true, false }), "broadcast::bool[]", "[true,false]");

        [UnityTest]
        public IEnumerator SendsAnIntArray()
            => UnityToPeer(ch => Sync.Send(ch, new[] { 1, 2 }), "broadcast::int[]", "[1,2]");

        [UnityTest]
        public IEnumerator SendsAFloatArray()
            => UnityToPeer(ch => Sync.Send(ch, new[] { 1.5f, 2.5f }), "broadcast::float[]", "[1.5,2.5]");

        [UnityTest]
        public IEnumerator SendsAStringArray()
            => UnityToPeer(ch => Sync.Send(ch, new[] { "a", "b" }), "broadcast::string[]", "[\"a\",\"b\"]");

        [UnityTest]
        public IEnumerator SendsAVector2Array()
            => UnityToPeer(ch => Sync.Send(ch, new[] { new Vector2(1f, 2f) }), "broadcast::vector2[]", "[[1.0,2.0]]");

        [UnityTest]
        public IEnumerator SendsAVector3Array()
            => UnityToPeer(ch => Sync.Send(ch, new[] { new Vector3(1f, 2f, 3f) }), "broadcast::vector3[]", "[[1.0,2.0,3.0]]");

        [UnityTest]
        public IEnumerator SendsAQuaternionArray()
            => UnityToPeer(ch => Sync.Send(ch, new[] { Quaternion.identity }), "broadcast::quaternion[]", "[[0.0,0.0,0.0,1.0]]");

        [UnityTest]
        public IEnumerator SendsAColorArray()
            => UnityToPeer(ch => Sync.Send(ch, new[] { Color.red }), "broadcast::color[]", "[\"#FF0000FF\"]");

        [UnityTest]
        public IEnumerator SendsJson()
            => UnityToPeer(ch => Sync.Send(ch, (JToken)new JObject { { "a", 1 } }), "broadcast::json", "{\"a\":1}");


        /*
         *  The wire -> Unity
         */

        [UnityTest]
        public IEnumerator ReceivesABool() => PeerToUnity("broadcast::bool", "true", true);

        [UnityTest]
        public IEnumerator ReceivesAnInt() => PeerToUnity("broadcast::int", "42", 42);

        [UnityTest]
        public IEnumerator ReceivesAFloat() => PeerToUnity("broadcast::float", "1.5", 1.5f);

        /// <summary>JSON has one number type, so a whole number loses its decimal point in transit.</summary>
        [UnityTest]
        public IEnumerator ReceivesAWholeNumberAsAFloat() => PeerToUnity("broadcast::float", "2", 2f);

        [UnityTest]
        public IEnumerator ReceivesAString() => PeerToUnity("broadcast::string", "\"hi\"", "hi");

        [UnityTest]
        public IEnumerator ReceivesAVector2() => PeerToUnity("broadcast::vector2", "[1,2]", new Vector2(1f, 2f));

        [UnityTest]
        public IEnumerator ReceivesAVector3() => PeerToUnity("broadcast::vector3", "[1,2,3]", new Vector3(1f, 2f, 3f));

        [UnityTest]
        public IEnumerator ReceivesAQuaternion()
            => PeerToUnity("broadcast::quaternion", "[0,0,0,1]", Quaternion.identity);

        /// <summary>The form colibri-web's <c>sendColor</c> puts on the wire. This used to throw.</summary>
        [UnityTest]
        public IEnumerator ReceivesAColorAsAnRgbaArray()
            => PeerToUnity("broadcast::color", "[1,0,0,1]", Color.red);

        /// <summary>And the form Unity itself writes, which has to keep working.</summary>
        [UnityTest]
        public IEnumerator ReceivesAColorAsAnHtmlString()
            => PeerToUnity("broadcast::color", "\"#FF0000FF\"", Color.red);

        [UnityTest]
        public IEnumerator ReceivesABoolArray()
            => PeerToUnity("broadcast::bool[]", "[true,false]", new[] { true, false });

        [UnityTest]
        public IEnumerator ReceivesAnIntArray() => PeerToUnity("broadcast::int[]", "[1,2]", new[] { 1, 2 });

        [UnityTest]
        public IEnumerator ReceivesAFloatArray()
            => PeerToUnity("broadcast::float[]", "[1.5,2.5]", new[] { 1.5f, 2.5f });

        [UnityTest]
        public IEnumerator ReceivesAStringArray()
            => PeerToUnity("broadcast::string[]", "[\"a\",\"b\"]", new[] { "a", "b" });

        [UnityTest]
        public IEnumerator ReceivesAVector2Array()
            => PeerToUnity("broadcast::vector2[]", "[[1,2]]", new[] { new Vector2(1f, 2f) });

        [UnityTest]
        public IEnumerator ReceivesAVector3Array()
            => PeerToUnity("broadcast::vector3[]", "[[1,2,3]]", new[] { new Vector3(1f, 2f, 3f) });

        [UnityTest]
        public IEnumerator ReceivesAQuaternionArray()
            => PeerToUnity("broadcast::quaternion[]", "[[0,0,0,1]]", new[] { Quaternion.identity });

        [UnityTest]
        public IEnumerator ReceivesAColorArray()
            => PeerToUnity("broadcast::color[]", "[[1,0,0,1]]", new[] { Color.red });

        [UnityTest]
        public IEnumerator ReceivesJson()
        {
            var channel = E2EServer.Channel("in-json");
            JToken received = null;
            Action<JToken> handler = value => received = value;

            Sync.Receive(channel, handler);
            Cleanup.Add(() => Sync.Unregister(channel, handler));

            Peer.Send(channel, "broadcast::json", "{\"a\":1}");

            yield return E2EServer.WaitUntil(() => received != null,
                $"Unity never received 'broadcast::json' on channel '{channel}'");

            Assert.That(JToken.DeepEquals(received, new JObject { { "a", 1 } }), Is.True,
                $"Received {received} instead of {{\"a\":1}}");
        }


        /*
         *  Helpers
         */

        private IEnumerator UnityToPeer(Action<string> send, string command, string expectedPayload)
        {
            var channel = E2EServer.Channel("out");

            send(channel);

            yield return Peer.Expect(channel, command,
                frame => Assert.That(TcpPeer.Text(frame), Is.EqualTo(expectedPayload)));
        }

        private IEnumerator PeerToUnity<T>(string command, string payload, T expected)
        {
            var channel = E2EServer.Channel("in");
            var received = default(T);
            var arrived = false;

            // Deliberately the cast-free Sync.Receive<T>, since that is what the samples and the
            // documentation tell people to write.
            Action<T> handler = value =>
            {
                received = value;
                arrived = true;
            };

            Sync.Receive(channel, handler);
            Cleanup.Add(() => Sync.Unregister(channel, handler));

            Peer.Send(channel, command, payload);

            yield return E2EServer.WaitUntil(() => arrived,
                $"Unity never received '{command}' on channel '{channel}'");

            Assert.That(received, Is.EqualTo(expected));
        }
    }
}
