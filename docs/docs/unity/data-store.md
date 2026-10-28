---
sidebar_position: 6
title: Data Store
---

# Data Store

The data store keeps small amounts of data on the server, e.g. the color a player selected, the settings of a game
or the condition of a study. Unlike [messages](./messages.md) and synchronized objects, the data stays saved after
all clients disconnect and after the server restarts. A server can be set to delete values that are not saved again
for some days. The public test server deletes them after 30 days
([server configuration](../server/configuration.md#data-store)).

The Remote Store sample saves and loads an object of its own class.

## Example: saving a player's color

```csharp
using HCIKonstanz.Colibri.Store;
using UnityEngine;

public class PlayerColor : MonoBehaviour
{
    public string PlayerName;
    public Renderer Avatar;

    async void Start()
    {
        Color? color = await Store.Get<Color?>("color-" + PlayerName);
        if (color != null)
        {
            Avatar.material.color = color.Value;
        }
    }

    // Call this when the player selects a color.
    public async void SelectColor(Color color)
    {
        Avatar.material.color = color;
        await Store.Put("color-" + PlayerName, color);
    }
}
```

`SelectColor` colors the player's avatar and saves the color on the server under the name `color-<player name>`. In
`Start`, the script loads the saved color, so the player gets their color back in the next session. `Store.Get`
returns `null` if the player has not selected a color yet or the request fails. Both methods log failures. Other
clients see a new value the next time they call `Store.Get`. It is not sent to them automatically.

## Saving, loading and deleting

All three methods are `async`. Use them with `await` in an `async` method.

| Method | Returns |
|---|---|
| `Store.Put(name, value)` | `true` if the server saved the value, `false` if the value cannot be converted to JSON or the request failed |
| `Store.Get<T>(name)` | The saved value, or `default` (`null` for classes and nullable types) if nothing is saved under the name, the request failed or the saved value does not fit `T` |
| `Store.Delete(name)` | `true` if the value was deleted, `false` if nothing was saved under the name or the request failed |

```csharp
public class ExampleClass
{
    public int Id;
    public string Name;
}
```

```csharp
using HCIKonstanz.Colibri.Store;
using UnityEngine;

public class StoreExample : MonoBehaviour
{
    async void Start()
    {
        ExampleClass exampleObject = new ExampleClass { Id = 1234, Name = "Charly Sharp" };
        bool putSuccess = await Store.Put("exampleObject", exampleObject);

        ExampleClass loaded = await Store.Get<ExampleClass>("exampleObject");
        if (loaded == null)
        {
            Debug.LogError("Loading the example object failed!");
        }

        bool deleteSuccess = await Store.Delete("exampleObject");
    }
}
```

- Use a nullable type such as `Color?`, `int?` or `bool?` with `Store.Get` to tell a missing value from `0`,
  `false` or black.
- Failures do not throw. Colibri logs the reason, e.g.
  `Colibri: could not load "<name>" at <url> - <error> (HTTP <status>). …`. Loading a name under which nothing is
  saved yet also logs this error, with HTTP 404.
- Exceptions thrown by your own class, e.g. by its constructor, are passed on to your code.
- Requests give up after 10 seconds.

## What can be saved

The data store takes anything Newtonsoft JSON can convert, up to 5 MiB of JSON per name, e.g. a number, a string, a
list or an object of your own class.

- Newtonsoft JSON saves the public fields and properties of your class. `[Serializable]` is not needed. A private
  field, also one with `[SerializeField]`, is not saved. Make it public or add `[JsonProperty]`.
- A `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Color`, also inside your class, is saved as an array of its
  components, e.g. `[1, 0, 0, 1]` for red. Values that Colibri 1 saved as `{"x": …}` still load.
- A saved `null` loads as `null`.
- Values are saved per app name. Clients with another app name do not see them.
- Names can contain any characters, including `/`, `#`, `?`, `%` and spaces.
- Spaces at the start and end of a name, and slashes at its start, are removed: `" /color "` is the same name as
  `"color"`.
- An empty name, `.` or `..` stores and finds nothing: `Put` and `Delete` return `false`, `Get` returns `default`.

:::note
On IL2CPP builds with a *Managed Stripping Level* above *Minimal*, Unity may remove members of classes that only the
data store uses. See [Meta Quest and Android](./configuration.md#meta-quest-and-android).
:::

## Server connection

The data store uses the server's web port (*Web server Port*, `9211` by default), not the connection of messages
and synchronized objects. It works without a connection to the TCP port, and the data store has no outage queue: a
request that fails is not repeated.

- With TLS, the data store uses `https` and follows the [certificate settings](./configuration.md#certificates).
- For a server without TLS, set *Project Settings → Player → Other Settings → Allow downloads over HTTP* to *Always
  allowed*. Otherwise every request to a server other than `localhost` fails with "Insecure connection not allowed".
  See [Allow downloads over HTTP](./configuration.md#allow-downloads-over-http).

## Web clients

Web clients read and write the same values. A name addresses the same value in Unity and on the web. A color that
a web client saves as `[r, g, b, a]` loads in Unity as a `Color`, so the `PlayerColor` example also works with a
color selected in a browser. See [Data Store](../web/data-store.md) for the web side.
