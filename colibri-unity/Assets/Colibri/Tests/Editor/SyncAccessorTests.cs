using System.Reflection;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The accessors an IL2CPP player - every Meta Quest build - reads and writes [Sync] members
    /// with. IL2CPP has no JIT, so instead of compiling expression trees it binds delegates to
    /// property methods and goes through FieldInfo for fields. The Editor always runs on Mono and
    /// would never take that path by itself, so these tests take it on purpose: a mistake here
    /// would otherwise first show up as a headset that syncs nothing.
    /// </summary>
    public class SyncAccessorTests
    {
        private class AccessorModel : SyncBehaviour<AccessorModel>
        {
            [Sync]
            public string Label = "";

            [Sync, SerializeField]
            private int _count;

            [Sync]
            public Vector3 Where { get; set; }

            [Sync]
            private Quaternion Turn { get; set; }

            public int Count
            {
                get => _count;
                set => _count = value;
            }

            public Quaternion TurnValue
            {
                get => Turn;
                set => Turn = value;
            }
        }

        private const BindingFlags AnyInstanceMember = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

        private GameObject _gameObject;

        [TearDown]
        public void DestroyObject()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        /// <summary>Edit mode does not call Awake, so this only constructs the component.</summary>
        private T Add<T>() where T : Component
        {
            _gameObject = new GameObject("accessor-under-test");
            return _gameObject.AddComponent<T>();
        }

        [Test]
        public void APropertyIsReadAndWritten()
        {
            var model = Add<AccessorModel>();
            SyncBehaviour<AccessorModel>.CreateReflectionAccessors<Vector3>(
                typeof(AccessorModel).GetProperty("Where", AnyInstanceMember), out var get, out var set);

            model.Where = new Vector3(1f, 2f, 3f);
            Assert.That(get(model), Is.EqualTo(new Vector3(1f, 2f, 3f)));

            set(model, new Vector3(4f, 5f, 6f));
            Assert.That(model.Where, Is.EqualTo(new Vector3(4f, 5f, 6f)));
        }

        [Test]
        public void APrivatePropertyIsReadAndWritten()
        {
            var model = Add<AccessorModel>();
            SyncBehaviour<AccessorModel>.CreateReflectionAccessors<Quaternion>(
                typeof(AccessorModel).GetProperty("Turn", AnyInstanceMember), out var get, out var set);

            var turn = Quaternion.Euler(0f, 90f, 0f);
            model.TurnValue = turn;
            Assert.That(get(model), Is.EqualTo(turn));

            set(model, Quaternion.identity);
            Assert.That(model.TurnValue, Is.EqualTo(Quaternion.identity));
        }

        /// <summary>
        /// The poll calls the getter for every synced member of every object, every frame. Bound
        /// straight to the get method, that call allocates nothing - which a delegate wrapping
        /// PropertyInfo.GetValue, or an interpreted expression, would not manage.
        /// </summary>
        [Test]
        public void APropertyIsCalledDirectlyRatherThanThroughAWrapper()
        {
            SyncBehaviour<AccessorModel>.CreateReflectionAccessors<Vector3>(
                typeof(AccessorModel).GetProperty("Where", AnyInstanceMember), out var get, out var set);

            Assert.That(get.Method.Name, Is.EqualTo("get_Where"));
            Assert.That(set.Method.Name, Is.EqualTo("set_Where"));
        }

        [Test]
        public void APrivateValueTypeFieldIsReadAndWritten()
        {
            var model = Add<AccessorModel>();
            SyncBehaviour<AccessorModel>.CreateReflectionAccessors<int>(
                typeof(AccessorModel).GetField("_count", AnyInstanceMember), out var get, out var set);

            model.Count = 7;
            Assert.That(get(model), Is.EqualTo(7));

            set(model, 9);
            Assert.That(model.Count, Is.EqualTo(9));
        }

        [Test]
        public void AReferenceTypeFieldIsReadAndWrittenIncludingNull()
        {
            var model = Add<AccessorModel>();
            SyncBehaviour<AccessorModel>.CreateReflectionAccessors<string>(
                typeof(AccessorModel).GetField("Label", AnyInstanceMember), out var get, out var set);

            model.Label = "hello";
            Assert.That(get(model), Is.EqualTo("hello"));

            set(model, null);
            Assert.That(model.Label, Is.Null);
            Assert.That(get(model), Is.Null);
        }

        /// <summary>
        /// SyncTransform's members live on its generic base class, so the delegate's target type
        /// (SyncTransform) is not the type that declares the method - the case an open-instance
        /// delegate is most likely to get wrong.
        /// </summary>
        [Test]
        public void APropertyDeclaredOnAGenericBaseClassIsReadAndWritten()
        {
            var sync = Add<SyncTransform>();
            SyncBehaviour<SyncTransform>.CreateReflectionAccessors<Vector3>(
                typeof(SyncTransform).GetProperty("Scale", AnyInstanceMember), out var get, out var set);

            sync.transform.localScale = new Vector3(2f, 2f, 2f);
            Assert.That(get(sync), Is.EqualTo(new Vector3(2f, 2f, 2f)));

            set(sync, new Vector3(3f, 3f, 3f));
            Assert.That(sync.transform.localScale, Is.EqualTo(new Vector3(3f, 3f, 3f)));
        }

        [Test]
        public void SyncTransformsActiveFlagIsReadAndWritten()
        {
            var sync = Add<SyncTransform>();
            SyncBehaviour<SyncTransform>.CreateReflectionAccessors<bool>(
                typeof(SyncTransform).GetProperty("Active", AnyInstanceMember), out var get, out var set);

            Assert.That(get(sync), Is.True);

            set(sync, false);
            Assert.That(sync.gameObject.activeSelf, Is.False);
            Assert.That(get(sync), Is.False);
        }
    }
}
