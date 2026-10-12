using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The setup window's warning about app names that strangers use too. The server puts every
    /// client with the same app name into one app, so unrelated projects that settle on an example
    /// name - colibri-web's samples use "myAppName" - see each other's objects, and the server's
    /// work grows with the square of the number of clients in the app, with nothing at runtime to
    /// say why.
    /// </summary>
    public class AppNameCheckTests
    {
        [TestCase("myAppName")]
        [TestCase("MYAPPNAME")]
        [TestCase("  myAppName ")]
        [TestCase("test")]
        [TestCase("Colibri")]
        public void ANameOthersUseTooIsWarnedAbout(string appName)
        {
            var warning = ColibriConfig.SharedAppNameWarning(appName);

            Assert.That(warning, Is.Not.Null);
            Assert.That(warning, Does.Contain($"'{appName.Trim()}'"), "The warning should name the App Name it is about");
        }

        [TestCase("vr-annotation-project-3")]
        [TestCase("myAppName2")]
        [TestCase("testing-hand-tracking")]
        public void ANameOfOnesOwnIsNot(string appName)
        {
            Assert.That(ColibriConfig.SharedAppNameWarning(appName), Is.Null);
        }

        /// <summary>No name at all is an error of its own, not this warning.</summary>
        [TestCase(null)]
        [TestCase("")]
        [TestCase("   ")]
        public void AnEmptyNameIsLeftToTheConfiguredCheck(string appName)
        {
            Assert.That(ColibriConfig.SharedAppNameWarning(appName), Is.Null);
        }
    }
}
