# colibri-unity conventions

For developers working on colibri-unity itself. Running the tests: [development.md](development.md).

## Files and types

- One top-level type per file, named after the type. Unity requires it for `MonoBehaviour` and `ScriptableObject`, StyleCop SA1402 for the rest.
- Nested types only when private and small (about 20 lines).
- No `#region`. A file that needs one is a class that needs splitting (SA1124).
- `partial` only for:
  - a facade of many independent overloads, in files named `Type.Concern.cs` (like dotnet/runtime's `Enumerable`, split per operator)
  - a short-lived step before Extract Class, never the end state

## Size guides

Checked by the metrics report. Exceeding one needs a reason in review.

| Metric | Guide |
|---|---|
| Code lines per file | up to ~400 |
| Lines per method | up to ~40 |
| Cyclomatic complexity per method (CA1502) | at most 15 |
| Class coupling (CA1506) | flagged |

## Design

- Humble Object: a `MonoBehaviour` holds the Unity lifecycle and the Unity API calls.
- Logic goes into `internal sealed` plain C# classes. Pass time, sending and similar dependencies in, so EditMode tests reach it.
- `internal` by default, `public` only for user API.
- Public API is removed or made internal only in a major release. In a minor release it gets `[Obsolete]` naming the release that removes it, and the package suppresses CS0618 where it still uses it.
- `InternalsVisibleTo` only for the test assemblies and the package's Editor assembly.
- Internal and private types are `sealed` or `static`, unless derived from.

## Threading

- A class owns its lock and every field the lock protects.
- Check cancellation tokens inside that lock.
- Document which members run off the main thread.

## Namespaces

- Namespaces follow the feature folders under `HCIKonstanz.Colibri`.
- `Runtime/` and `Editor/` are assembly roots, not namespace segments. Editor code keeps the namespace of its feature folder, e.g. `HCIKonstanz.Colibri.Setup`.
- No namespace named `Editor`. It would shadow `UnityEditor.Editor`.
- Nothing in the global namespace.

## Package layout

- Unity's package layout: `Runtime/`, `Editor/`, `Tests/Editor/`, `Samples~/`.
- One asmdef per folder: `HCIKonstanz.Colibri`, `HCIKonstanz.Colibri.Editor`, `HCIKonstanz.Colibri.Tests`.
- Exception: the PlayMode/E2E tests stay in the development project (`colibri-unity/Assets/Tests`, assembly `HCIKonstanz.Colibri.E2E`), because they need a running colibri-server.

## Style

- Private fields `_camelCase`. PascalCase for types and members. `I` prefix for interfaces.
- Explicit visibility, as the first modifier.
- Fields at the top of the type.
- `using` outside the namespace, `System` first.
- Allman braces, 4 spaces.
- Few parameters. No hidden side effects.

`colibri-unity/.editorconfig` enforces what it can.

## Comments

- Comment only the why the code cannot say: ordering, protocol, threading, Unity and IL2CPP gotchas.
- Public API gets a one-sentence summary.
- No bug history. That goes in the commit message.

## Refactoring

- One Extract Class or Move per commit.
- Tests green before and after.
- No behaviour change mixed into a move.
- Forwarders may keep tests compiling for a step. Remove them afterwards.

## Commits

Conventional commits: `type(scope): subject`, with the why in the body.

## Sources

- [Unity C# style guide](https://unity.com/blog/engine-platform/clean-up-your-code-how-to-create-your-own-c-code-style)
- [Unity package layout](https://docs.unity3d.com/6/Documentation/Manual/cus-layout.html)
- [dotnet/runtime coding style](https://github.com/dotnet/runtime/blob/main/docs/coding-guidelines/coding-style.md)
- [Unity unit testing, Humble Object](https://unity.com/blog/technology/unit-testing-part-2-unit-testing-monobehaviours)
- [StyleCop analyzers rules](https://github.com/DotNetAnalyzers/StyleCopAnalyzers/tree/master/documentation)
- [Microsoft code metrics rules](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1505)
