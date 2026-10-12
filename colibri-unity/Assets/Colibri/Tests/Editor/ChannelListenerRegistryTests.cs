using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Sending a value on a channel whose listeners expect a different type is the most common
    /// mistake when getting started, and it used to be dropped in complete silence. These cover
    /// when that is worth reporting - and, just as importantly, when it is not: a channel nobody
    /// listens to is normal traffic, and warning about it would train people to ignore the console.
    /// </summary>
    public class ChannelListenerRegistryTests
    {
        [SetUp]
        public void Reset() => ChannelListenerRegistry.Clear();

        [TearDown]
        public void Cleanup() => ChannelListenerRegistry.Clear();

        [Test]
        public void ReportsNothingWhenTheChannelHasNoListeners()
        {
            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.False);
        }

        [Test]
        public void ReportsNothingWhenTheTypeMatches()
        {
            ChannelListenerRegistry.Add("chat", typeof(float));

            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.False);
        }

        [Test]
        public void ReportsAMismatchNamingBothTypesAndTheFix()
        {
            ChannelListenerRegistry.Add("chat", typeof(string));

            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out var message), Is.True);
            Assert.That(message, Does.Contain("chat"));
            Assert.That(message, Does.Contain("float"));
            Assert.That(message, Does.Contain("string"));
            Assert.That(message, Does.Contain("Sync.Receive<float>"));
        }

        [Test]
        public void ReportsAMismatchOnlyOncePerChannelAndType()
        {
            ChannelListenerRegistry.Add("chat", typeof(string));

            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.True);
            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.False);

            // ...but a different wrong type on the same channel is a different mistake.
            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(int), out _), Is.True);
        }

        [Test]
        public void ReportsAgainAfterAMatchingListenerIsAddedAndRemoved()
        {
            ChannelListenerRegistry.Add("chat", typeof(string));
            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.True);

            // Registering the missing listener is the fix, so the warning is armed again in case
            // it is later removed.
            ChannelListenerRegistry.Add("chat", typeof(float));
            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.False);

            ChannelListenerRegistry.Remove("chat", typeof(float));
            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out _), Is.True);
        }

        [Test]
        public void ListsEveryExpectedTypeWhenSeveralListenersDisagree()
        {
            ChannelListenerRegistry.Add("chat", typeof(string));
            ChannelListenerRegistry.Add("chat", typeof(int));

            Assert.That(ChannelListenerRegistry.TryDescribeMismatch("chat", typeof(float), out var message), Is.True);
            Assert.That(message, Does.Contain("int"));
            Assert.That(message, Does.Contain("string"));
            Assert.That(message, Does.Contain("listeners registered there expect"));
        }

        [Test]
        public void CountsListenersSoOneRemovalDoesNotDropTheWholeType()
        {
            ChannelListenerRegistry.Add("chat", typeof(float));
            ChannelListenerRegistry.Add("chat", typeof(float));
            ChannelListenerRegistry.Remove("chat", typeof(float));

            Assert.That(ChannelListenerRegistry.ListenerTypesFor("chat"), Is.EquivalentTo(new[] { "float" }));

            ChannelListenerRegistry.Remove("chat", typeof(float));
            Assert.That(ChannelListenerRegistry.ListenerTypesFor("chat"), Is.Empty);
        }

        [Test]
        public void ForgetsAChannelOnceItsLastListenerIsGone()
        {
            ChannelListenerRegistry.Add("chat", typeof(float));
            Assert.That(ChannelListenerRegistry.Channels, Is.EquivalentTo(new[] { "chat" }));

            ChannelListenerRegistry.Remove("chat", typeof(float));
            Assert.That(ChannelListenerRegistry.Channels, Is.Empty);
        }

        [Test]
        public void RemovingSomethingThatWasNeverAddedIsHarmless()
        {
            Assert.DoesNotThrow(() => ChannelListenerRegistry.Remove("chat", typeof(float)));

            ChannelListenerRegistry.Add("chat", typeof(float));
            Assert.DoesNotThrow(() => ChannelListenerRegistry.Remove("chat", typeof(string)));
            Assert.That(ChannelListenerRegistry.ListenerTypesFor("chat"), Is.EquivalentTo(new[] { "float" }));
        }

        [Test]
        public void UsesTheSpellingsPeopleActuallyWriteInTheirCode()
        {
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(bool)), Is.EqualTo("bool"));
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(int)), Is.EqualTo("int"));
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(float)), Is.EqualTo("float"));
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(string)), Is.EqualTo("string"));
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(Vector3)), Is.EqualTo("Vector3"));
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(float[])), Is.EqualTo("float[]"));
            Assert.That(ChannelListenerRegistry.FriendlyName(typeof(Vector3[])), Is.EqualTo("Vector3[]"));
        }

        [Test]
        public void ListsUnknownChannelsAsEmptyRatherThanThrowing()
        {
            Assert.That(ChannelListenerRegistry.ListenerTypesFor("nobody-here").ToArray(), Is.Empty);
        }
    }
}
