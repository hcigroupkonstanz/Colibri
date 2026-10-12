using System.Reflection;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine.Scripting;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// [Sync] members are only ever reached through reflection, so in a player build with managed
    /// code stripping above Minimal nothing would stop the Unity linker from removing them - and a
    /// SyncTransform whose Position property has been stripped syncs nothing, without an error.
    /// What protects them is that the linker sees a PreserveAttribute on every one.
    ///
    /// That alone is not enough: the linker treats PreserveAttribute and its subclasses as its own
    /// markers and removes them from what it writes out, so the members survived and the [Sync]
    /// on them did not - SyncBehaviour found nothing to sync, and logged "Unable to sync attribute"
    /// for every update. [RequireAttributeUsages] makes it keep them. An editor test cannot see
    /// stripping, so these only pin the setup that was verified in stripped IL2CPP builds.
    /// </summary>
    public class SyncStrippingTests
    {
        [Test]
        public void SyncIsAPreserveAttribute()
        {
            Assert.That(typeof(PreserveAttribute).IsAssignableFrom(typeof(SyncAttribute)), Is.True,
                "[Sync] no longer derives from UnityEngine.Scripting.PreserveAttribute, so stripping can remove synced members");
        }

        [Test]
        public void TheLinkerIsToldToKeepEverySyncAttribute()
        {
            Assert.That(typeof(SyncAttribute).IsDefined(typeof(RequireAttributeUsagesAttribute), false), Is.True,
                "[Sync] lost [RequireAttributeUsages], so stripping removes the [Sync] attributes and nothing is synced");
        }

        [TestCase("Active")]
        [TestCase("Position")]
        [TestCase("Rotation")]
        [TestCase("Scale")]
        [TestCase("PhysicsId")]
        public void EverySyncTransformMemberIsMarkedForPreservation(string propertyName)
        {
            var property = typeof(SyncTransform).GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance);

            Assert.That(property, Is.Not.Null);
            Assert.That(property.IsDefined(typeof(PreserveAttribute), true), Is.True);
        }
    }
}
