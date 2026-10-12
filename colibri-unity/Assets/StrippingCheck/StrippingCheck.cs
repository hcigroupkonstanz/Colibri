using System;
using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.StrippingCheck
{
    /// <summary>
    /// A model in user code, the way an application writes one: a private serialized field, a
    /// public value field, a public reference field and a property, all [Sync].
    /// </summary>
    public class StrippingCheckModel : SyncBehaviour<StrippingCheckModel>
    {
        [Sync, SerializeField]
        private int _private;

        [Sync]
        public float PublicValue;

        [Sync]
        public string PublicReference = "";

        [Sync]
        public Vector3 Property { get; set; }

        public int PrivateValue => _private;
    }

    /// <summary>
    /// The player side of run-tests.mjs --stripping. Built into a Release IL2CPP player with
    /// Managed Stripping High, it checks that every [Sync] member survived the linker with its
    /// attribute, and that SyncBehaviour's member table finds them and applies an update. It
    /// exits with 0 when everything holds and 1 otherwise.
    ///
    /// Only acts when the player is started with -colibriStrippingCheck, so it is inert in the
    /// Editor and in the PlayMode suite.
    /// </summary>
    public static class StrippingCheck
    {
        private const string Flag = "-colibriStrippingCheck";

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Run()
        {
            if (!Environment.GetCommandLineArgs().Contains(Flag))
                return;

            var failures = new List<string>();
            var unableToSync = new List<string>();
            void OnLog(string message, string stackTrace, LogType type)
            {
                if (message.Contains("Unable to sync attribute"))
                    unableToSync.Add(message);
            }
            Application.logMessageReceived += OnLog;

            try
            {
                CheckAttribute(failures, typeof(SyncTransform), "Active", "Position", "Rotation", "Scale", "PhysicsId");
                CheckAttribute(failures, typeof(StrippingCheckModel), "_private", "PublicValue", "PublicReference", "Property");

                // The member table, through the same path a model from another client takes. The
                // objects stay switched off, so they never wake up and never connect anywhere.
                var transformObject = new GameObject("transform");
                transformObject.SetActive(false);
                var transform = transformObject.AddComponent<SyncTransform>();
                transform.Id = "transform";
                transform.OnModelUpdate(new JObject
                {
                    { "id", "transform" },
                    { "position", new JArray(1f, 2f, 3f) },
                    { "scale", new JArray(2f, 2f, 2f) },
                });
                Expect(failures, "SyncTransform position", transformObject.transform.position, new Vector3(1f, 2f, 3f));
                Expect(failures, "SyncTransform scale", transformObject.transform.localScale, new Vector3(2f, 2f, 2f));

                var modelObject = new GameObject("model");
                modelObject.SetActive(false);
                var model = modelObject.AddComponent<StrippingCheckModel>();
                model.Id = "model";
                model.OnModelUpdate(new JObject
                {
                    { "id", "model" },
                    { "_private", 7 },
                    { "publicvalue", 1.5f },
                    { "publicreference", "kept" },
                    { "property", new JArray(4f, 5f, 6f) },
                });
                Expect(failures, "private field", model.PrivateValue, 7);
                Expect(failures, "public value field", model.PublicValue, 1.5f);
                Expect(failures, "public reference field", model.PublicReference, "kept");
                Expect(failures, "property", model.Property, new Vector3(4f, 5f, 6f));

                failures.AddRange(unableToSync);
            }
            catch (Exception e)
            {
                failures.Add($"threw {e}");
            }
            finally
            {
                Application.logMessageReceived -= OnLog;
            }

            if (failures.Count == 0)
            {
                Debug.Log("[StrippingCheck] PASS: every [Sync] member survived stripping with its attribute and synced");
                Application.Quit(0);
            }
            else
            {
                foreach (var failure in failures)
                    Debug.Log($"[StrippingCheck] FAIL: {failure}");
                Application.Quit(1);
            }
        }

        private static void CheckAttribute(List<string> failures, Type type, params string[] members)
        {
            const System.Reflection.BindingFlags all = System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
            foreach (var name in members)
            {
                var member = (System.Reflection.MemberInfo)type.GetProperty(name, all) ?? type.GetField(name, all);
                if (member == null)
                    failures.Add($"{type.Name}.{name} was stripped");
                else if (!member.IsDefined(typeof(SyncAttribute), true))
                    failures.Add($"{type.Name}.{name} survived without its [Sync]");
            }
        }

        private static void Expect<T>(List<string> failures, string what, T actual, T expected)
        {
            if (!EqualityComparer<T>.Default.Equals(actual, expected))
                failures.Add($"{what}: expected {expected}, got {actual}");
        }
    }
}
