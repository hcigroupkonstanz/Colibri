using HCIKonstanz.Colibri.Store;
using UnityEngine;

public class RestApiExample : MonoBehaviour
{
    async void Start()
    {
        // Create example object
        ExampleClass exampleObject = new ExampleClass();
        exampleObject.Id = 1234;
        exampleObject.Name = "Charly Sharp";
        exampleObject.Position = new Vector3(1f, 1f, 1f);
        exampleObject.Rotation = new Quaternion(0f, 0f, 0f, 0f);

        // Save example object using REST API
        bool putSuccess = await Store.Put("exampleObject", exampleObject);
        Debug.Log("Save Example Object Success: " + putSuccess);

        // Get saved example object from REST API
        ExampleClass exampleObjectGet = await Store.Get<ExampleClass>("exampleObject");
        if (exampleObjectGet != null)
        {
            Debug.Log("Get Example Object: " + exampleObjectGet.Name);
        }
        else
        {
            Debug.LogError("Get Example Object failed!");
        }

        // Delete saved example object with REST API
        // bool deleteSuccess = await restApi.Delete(APP_NAME, "exampleObject");
        // Debug.Log("Delete Example Object Success: " + deleteSuccess);

    }

}
