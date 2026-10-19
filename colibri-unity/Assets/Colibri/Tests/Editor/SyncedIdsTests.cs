using System;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The ids of an object's synced components. Each used to make its own random id, so a prefab
    /// with more than one, such as an avatar with a SyncTransform for each hand, had ids on every
    /// other client that its owner did not know, and every client built new avatars without end.
    /// Edit mode calls no Awake, so the tests call what Awake calls.
    /// </summary>
    public class SyncedIdsTests
    {
        private class Body : SyncBehaviour<Body>
        {
        }

        private class Hand : SyncBehaviour<Hand>
        {
        }

        private readonly List<GameObject> _objects = new List<GameObject>();

        [TearDown]
        public void DestroyObjects()
        {
            foreach (var go in _objects)
            {
                if (go != null)
                    Object.DestroyImmediate(go);
            }
            _objects.Clear();
        }

        private GameObject Make(string name, Transform parent = null)
        {
            var go = new GameObject(name);
            if (parent != null)
                go.transform.SetParent(parent, false);
            else
                _objects.Add(go);
            return go;
        }

        private static void Assign<T>(T component) where T : SyncBehaviour<T>
            => SyncedIds.Assign(component, component);

        [Test]
        public void ThePartsOfANewObjectShareItsNewIdAndAddTheirPath()
        {
            var root = Make("Avatar(Clone)");
            var body = root.AddComponent<Body>();
            var hand = root.AddComponent<Hand>();
            var left = Make("LeftHand", root.transform).AddComponent<Hand>();

            // A child may wake before its top: it makes the top's id.
            Assign(left);
            Assign(body);
            Assign(hand);

            Assert.That(Guid.TryParse(body.Id, out _), Is.True);
            Assert.That(hand.Id, Is.EqualTo(body.Id));
            Assert.That(left.Id, Is.EqualTo(body.Id + "/LeftHand"));
            Assert.That(((ISyncedObject)left).MadeItsId, Is.True);
            Assert.That(((ISyncedObject)body).MadeItsId, Is.True);
        }

        /// <summary>The clone a manager builds, its template's id set to the owner's.</summary>
        [Test]
        public void TheClientBuildingTheObjectGetsTheOwnersIds()
        {
            var root = Make("Avatar(Clone)");
            var body = root.AddComponent<Body>();
            body.Id = "4f8a2c1e-0000-4000-8000-000000000001";
            var hand = Make("RightHand", Make("Arm", root.transform).transform).AddComponent<Hand>();

            Assign(hand);

            Assert.That(hand.Id, Is.EqualTo(body.Id + "/Arm/RightHand"));
            Assert.That(((ISyncedObject)hand).MadeItsId, Is.False);
        }

        [Test]
        public void SiblingsWithOneNameAndComponentsOfOneTypeAreNumbered()
        {
            var root = Make("Avatar(Clone)");
            root.AddComponent<Body>().Id = "top";
            var first = Make("Hand", root.transform).AddComponent<Hand>();
            var second = Make("Hand", root.transform).AddComponent<Hand>();
            var extra = second.gameObject.AddComponent<Hand>();

            Assign(first);
            Assign(second);
            Assign(extra);

            Assert.That(first.Id, Is.EqualTo("top/Hand[0]"));
            Assert.That(second.Id, Is.EqualTo("top/Hand[1]"));
            Assert.That(extra.Id, Is.EqualTo("top/Hand[1]#1"));
        }

        /// <summary>
        /// A player created below a synced room is its own object, as it is on the clients that
        /// build it: the root of an Instantiate is named "(Clone)".
        /// </summary>
        [Test]
        public void AnObjectCreatedBelowAnotherSyncedObjectHasItsOwnId()
        {
            var room = Make("Room");
            room.AddComponent<Body>().Id = "room";
            var player = Make("Player(Clone)", room.transform);
            var playerBody = player.AddComponent<Body>();
            var hand = Make("Hand", player.transform).AddComponent<Hand>();

            Assign(hand);

            Assert.That(playerBody.Id, Is.Not.EqualTo("room"));
            Assert.That(Guid.TryParse(playerBody.Id, out _), Is.True);
            Assert.That(hand.Id, Is.EqualTo(playerBody.Id + "/Hand"));
        }

        /// <summary>A placed object's part without an id now syncs: it is the same on every client.</summary>
        [Test]
        public void APlacedPartWithoutAnIdTakesItFromTheTopOfItsObject()
        {
            var table = Make("Table");
            table.AddComponent<Body>().Id = "table";
            var cup = Make("Cup", table.transform).AddComponent<Hand>();

            Assign(cup);

            Assert.That(cup.Id, Is.EqualTo("table/Cup"));
        }

        [Test]
        public void AnIdItWasGivenIsKept()
        {
            var root = Make("Avatar(Clone)");
            root.AddComponent<Body>().Id = "top";
            var hand = Make("Hand", root.transform).AddComponent<Hand>();
            hand.Id = "chosen";

            Assign(hand);

            Assert.That(hand.Id, Is.EqualTo("chosen"));
        }

        [TestCase("4f8a2c1e-0000-4000-8000-000000000001/Hand", "4f8a2c1e-0000-4000-8000-000000000001")]
        [TestCase("4f8a2c1e-0000-4000-8000-000000000001/Arm/Hand[1]#2", "4f8a2c1e-0000-4000-8000-000000000001")]
        [TestCase("4f8a2c1e-0000-4000-8000-000000000001#1", "4f8a2c1e-0000-4000-8000-000000000001")]
        [TestCase("4f8a2c1e-0000-4000-8000-000000000001", null)]
        [TestCase("team/1", null)]
        [TestCase("not-a-guid-at-all-but-36-characters/Hand", null)]
        [TestCase(null, null)]
        public void OnlyAPartsIdIsTakenApart(string id, string anchor)
        {
            Assert.That(SyncedIds.AnchorOfPart(id), Is.EqualTo(anchor));
        }

        [Test]
        public void ATemplateHasThePartsItsClonesWouldHave()
        {
            var template = Make("Avatar");
            var body = template.AddComponent<Body>();
            Make("LeftHand", template.transform).AddComponent<Hand>();
            const string top = "4f8a2c1e-0000-4000-8000-000000000001";

            Assert.That(SyncedIds.TemplateHasPart(template.GetComponent<Body>(), typeof(Hand), top, top + "/LeftHand"), Is.True);
            Assert.That(SyncedIds.TemplateHasPart(body, typeof(Hand), top, top + "/RightHand"), Is.False);
            Assert.That(SyncedIds.TemplateHasPart(body, typeof(Body), top, top + "/LeftHand"), Is.False);
        }

        [Test]
        public void TheLiveIdsCountEachComponent()
        {
            SyncedIds.Register("shared-test-id");
            SyncedIds.Register("shared-test-id");
            SyncedIds.Deregister("shared-test-id");
            Assert.That(SyncedIds.IsLive("shared-test-id"), Is.True);

            SyncedIds.Deregister("shared-test-id");
            Assert.That(SyncedIds.IsLive("shared-test-id"), Is.False);
        }
    }
}
