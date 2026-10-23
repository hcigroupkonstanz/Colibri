using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HCIKonstanz.Colibri.Networking;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Setup
{
    internal static class ConfigValidation
    {
        /// <summary>Every public serialized field of ColibriConfig, so one added later is copied too.</summary>
        private static readonly FieldInfo[] Settings = typeof(ColibriConfig)
            .GetFields(BindingFlags.Public | BindingFlags.Instance)
            .Where(field => !field.IsNotSerialized)
            .ToArray();

        /// <summary>
        /// The checks that Save makes, each with the settings it looks at, and its error if it
        /// fails, or null.
        /// </summary>
        private static readonly (string[] LooksAt, Func<ColibriConfig, string> Error)[] Checks =
        {
            // IsConfigured, the status window's test, which treats a name of spaces as empty.
            (new[] { nameof(ColibriConfig.AppName) },
                config => config.IsConfigured ? null : "App Name must not be empty!"),
            (new[] { nameof(ColibriConfig.ServerAddress) }, ServerAddressError),
            (new[] { nameof(ColibriConfig.WebServerPort) },
                config => IsPort(config.WebServerPort) ? null
                    : "Web server port invalid (must be a number between 1 - 65535, default 9211)"),
            (new[] { nameof(ColibriConfig.TcpServerPort) },
                config => IsPort(config.TcpServerPort) ? null
                    : "TCP server port invalid (must be a number between 1 - 65535, default 9212)"),
            (new[] { nameof(ColibriConfig.VoiceServerPort) },
                config => IsPort(config.VoiceServerPort) ? null
                    : "Voice server port invalid (must be a number between 1 - 65535, default 9213)"),
            (new[] { nameof(ColibriConfig.WebServerPort), nameof(ColibriConfig.TcpServerPort), nameof(ColibriConfig.VoiceServerPort) },
                config => new[] { config.WebServerPort, config.TcpServerPort, config.VoiceServerPort }.Distinct().Count() == 3 ? null
                    : "Two ports may not have the same value!"),
            (new[] { nameof(ColibriConfig.VoiceServerSamplingRate) },
                config => config.VoiceServerSamplingRate >= 16000 && config.VoiceServerSamplingRate <= 48000 ? null
                    : "Voice server sampling rate invalid (must be a number between 16000 - 48000, default 48000)"),
            (new[] { nameof(ColibriConfig.MaxSendRate) },
                config => config.MaxSendRate >= 0 ? null
                    : $"Max send rate invalid (updates per second per synced object; 0 = no limit, default {ColibriConfig.DEFAULT_MAX_SEND_RATE})"),
            (new[] { nameof(ColibriConfig.IsSSL), nameof(ColibriConfig.ServerCertificateSha256) }, CertificateSettingsError),
        };

        /// <summary>
        /// Copies <paramref name="config"/>'s settings to <paramref name="shown"/>, except the
        /// <paramref name="refused"/> ones, which keep the value typed in.
        /// </summary>
        internal static void ShowSettings(ColibriConfig config, ColibriConfig shown, ICollection<string> refused)
        {
            foreach (var setting in Settings)
                if (!refused.Contains(setting.Name))
                    setting.SetValue(shown, setting.GetValue(config));
        }

        /// <summary>
        /// Copies to <paramref name="config"/>, the configuration in use, each setting in which
        /// <paramref name="shown"/> differs from it, unless a check that Save makes on that setting
        /// then fails. So a valid change takes effect at once, even while another setting shows an
        /// error, and a refused value does not reach Play mode or the next asset save.
        /// </summary>
        /// <returns>The settings it did not copy, by name.</returns>
        internal static List<string> ApplyValidSettings(ColibriConfig shown, ColibriConfig config)
        {
            var changed = Settings.Where(setting => !Equals(setting.GetValue(shown), setting.GetValue(config))).ToList();
            if (changed.Count == 0)
                return new List<string>();

            var candidate = ScriptableObject.CreateInstance<ColibriConfig>();
            candidate.hideFlags = HideFlags.HideAndDontSave;
            try
            {
                // The settings a failing check looks at, with shown's value for those in the list
                // and config's for the rest.
                List<FieldInfo> Failing(List<FieldInfo> settings)
                {
                    foreach (var setting in Settings)
                        setting.SetValue(candidate, setting.GetValue(settings.Contains(setting) ? shown : config));
                    var looked = Checks.Where(check => check.Error(candidate) != null).SelectMany(check => check.LooksAt).ToList();
                    return settings.Where(setting => looked.Contains(setting.Name)).ToList();
                }

                // Two ports can only change together, so start with all and drop the failing ones
                // until the rest pass.
                var applied = changed.ToList();
                for (var failing = Failing(applied); failing.Count != 0; failing = Failing(applied))
                    applied = applied.Except(failing).ToList();

                // Then each of the others alone, so a refused value does not hold back a valid one
                // that shares a check with it.
                foreach (var setting in changed.Except(applied).ToList())
                    if (Failing(applied.Append(setting).ToList()).Count == 0)
                        applied.Add(setting);

                foreach (var setting in applied)
                    setting.SetValue(config, setting.GetValue(shown));
                return changed.Except(applied).Select(setting => setting.Name).ToList();
            }
            finally
            {
                Object.DestroyImmediate(candidate);
            }
        }

        private static bool IsPort(int port) => port > 0 && port <= 65535;

        /// <summary>
        /// What is wrong with the server address, or null. Only a host name or an IP address is
        /// valid: with a path or a port, the client cannot resolve it.
        /// </summary>
        internal static string ServerAddressError(ColibriConfig config)
        {
            var address = config.Host;
            if (address.Length == 0)
                return "Server address must not be empty!";
            if (address.Contains("://"))
                return "Server address should not contain a protocol (only IP or domain name)";
            if (address.Contains("/") || address.Any(char.IsWhiteSpace))
                return "Server address must be an IP address or a domain name only, without a path or spaces";

            // A host name has no colon, and an IPv6 address has two or more or brackets. So one colon,
            // or a colon after "]", is a port.
            var colons = address.Count(c => c == ':');
            if ((colons == 1 && !address.StartsWith("[")) || address.Contains("]:"))
                return "Server address must not contain a port: enter the ports in their own fields";
            return null;
        }

        /// <summary>What keeps the configuration from being saved; empty if nothing does.</summary>
        internal static List<string> ConfigurationErrors(ColibriConfig config)
            => Checks.Select(check => check.Error(config)).Where(error => error != null).ToList();

        /// <summary>
        /// What is wrong with the certificate settings, or null. A fingerprint that matches no
        /// certificate would reject every connection. Without TLS they are neither used nor checked.
        /// </summary>
        internal static string CertificateSettingsError(ColibriConfig config)
        {
            if (!config.IsSSL || ServerCertificatePolicy.TryNormalizeFingerprint(config.ServerCertificateSha256, out _))
                return null;

            return "Server certificate SHA-256 invalid (64 hexadecimal digits, with or without colons, as colibri-server logs it; or empty)";
        }
    }
}
