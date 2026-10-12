using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using System;
using System.Collections.Generic;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Colibri drops a listener once the object that registered it is destroyed, which only works
    /// if it can tell what that object was. A method group says so outright; a lambda hides it in a
    /// compiler-generated closure, which is where this has to earn its keep - lambdas are how most
    /// people write a one-line listener.
    /// </summary>
    public class ListenerOwnerTests
    {
        private class Holder : MonoBehaviour
        {
            public float Received;

            public void Handle(float value) => Received = value;

            public Action<float> AsMethodGroup() => Handle;

            public Action<float> AsLambda() => value => Received = value;

            public Action<float> AsLambdaTouchingTheTransform() => value => transform.position = Vector3.one * value;

            /// <summary>
            /// Captures an outer local, a loop variable and the component, which is what makes the
            /// compiler nest one closure inside another - the component is then two hops away.
            /// </summary>
            public Action<float> AsNestedLambda()
            {
                var basis = 10f;
                Action<float> listener = null;

                foreach (var offset in new List<float> { 1f })
                    listener = value => Received = value + offset + basis + transform.position.x;

                return listener;
            }

            /// <summary>Captures a local only - no reference to the component at all.</summary>
            public Action<float> AsLambdaOverALocal()
            {
                var scale = 2f;
                return value => Debug.Log(value * scale);
            }
        }

        private class PlainOwner
        {
            public void Handle(float value) => Debug.Log(value);
        }

        private static void StaticHandler(float value) => Debug.Log(value);

        private GameObject _gameObject;
        private Holder _holder;

        [SetUp]
        public void CreateHolder()
        {
            _gameObject = new GameObject("owner-under-test");
            _holder = _gameObject.AddComponent<Holder>();
        }

        [TearDown]
        public void DestroyHolder()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        [Test]
        public void AMethodOnAComponentIsOwnedByThatComponent()
        {
            Assert.That(ListenerOwner.Of(_holder.AsMethodGroup()), Is.SameAs(_holder));
        }

        [Test]
        public void ALambdaWrittenInAComponentIsOwnedByThatComponent()
        {
            Assert.That(ListenerOwner.Of(_holder.AsLambda()), Is.SameAs(_holder));
        }

        [Test]
        public void ALambdaTouchingTheTransformIsOwnedByTheComponent()
        {
            // The dangerous case: this is exactly the listener that throws
            // MissingReferenceException after its object is gone.
            Assert.That(ListenerOwner.Of(_holder.AsLambdaTouchingTheTransform()), Is.SameAs(_holder));
        }

        [Test]
        public void ALambdaNestedInsideAnotherClosureIsStillOwned()
        {
            Assert.That(ListenerOwner.Of(_holder.AsNestedLambda()), Is.SameAs(_holder));
        }

        [Test]
        public void ALambdaCapturingAUnityObjectIsOwnedByIt()
        {
            var target = new GameObject("captured");
            try
            {
                Action<float> listener = value => target.transform.position = Vector3.one * value;

                Assert.That(ListenerOwner.Of(listener), Is.SameAs(target));
            }
            finally
            {
                Object.DestroyImmediate(target);
            }
        }

        [Test]
        public void ALambdaOverPlainLocalsHasNoOwner()
        {
            // Nothing here can be destroyed, so nothing should silently stop working. It stays
            // registered until Sync.Unregister is called.
            Assert.That(ListenerOwner.Of(_holder.AsLambdaOverALocal()), Is.Null);
        }

        [Test]
        public void AStaticMethodHasNoOwner()
        {
            Assert.That(ListenerOwner.Of((Action<float>)StaticHandler), Is.Null);
        }

        [Test]
        public void AMethodOnAPlainClassHasNoOwner()
        {
            var owner = new PlainOwner();

            Assert.That(ListenerOwner.Of((Action<float>)owner.Handle), Is.Null);
        }

        [Test]
        public void TheOwnerOfADestroyedComponentReadsAsNull()
        {
            // Not a detail: this Unity-null is the whole signal Colibri prunes on.
            var listener = _holder.AsLambda();
            Object.DestroyImmediate(_gameObject);

            var owner = ListenerOwner.Of(listener);

            Assert.That(ReferenceEquals(owner, null), Is.False, "the destroyed component should still be identified");
            Assert.That(owner == null, Is.True, "and should compare equal to null, the way Unity reports destruction");
        }
    }
}
