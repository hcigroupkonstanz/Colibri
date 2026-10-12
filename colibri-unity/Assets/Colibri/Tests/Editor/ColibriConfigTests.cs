using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// A new configuration uses colibri-server 2.x's default ports, not 1.x's 9011, 9012 and 9013,
    /// so that a new project reaches a 2.x server by its defaults and not a 1.x server on the same
    /// host.
    /// </summary>
    public class ColibriConfigTests
    {
        [Test]
        public void ANewConfigurationUsesTheServersDefaultPorts()
        {
            var config = ScriptableObject.CreateInstance<ColibriConfig>();
            try
            {
                Assert.That(new[] { config.WebServerPort, config.TcpServerPort, config.VoiceServerPort },
                    Is.EqualTo(new[] { 9211, 9212, 9213 }));
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }
    }
}
