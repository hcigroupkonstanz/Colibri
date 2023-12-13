using UnityEngine;
using UniRx;
using System.Reflection;
using System.Collections.Generic;
using System;
using System.Linq.Expressions;
using Newtonsoft.Json.Linq;
using System.Linq;
using Cysharp.Threading.Tasks;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviour<T> : MonoBehaviour
        where T : SyncBehaviour<T>
    {
        private struct SyncedAttribute
        {
            public Func<T, object> Getter;
            public Action<T, object> Setter;
            public Type PropertyType;
        }


        private static readonly Subject<SyncBehaviour<T>> _modelCreateSubject = new Subject<SyncBehaviour<T>>();
        public static IObservable<SyncBehaviour<T>> ModelCreated() => _modelCreateSubject.AsObservable();

        private static readonly Subject<SyncBehaviour<T>> _modelDestroySubject = new Subject<SyncBehaviour<T>>();
        public static IObservable<SyncBehaviour<T>> ModelDestroyed() => _modelDestroySubject.AsObservable();


        private static readonly Dictionary<string, SyncedAttribute> _syncedAttributes = new Dictionary<string, SyncedAttribute>();
        private static bool _isInitialized = false;
        private static void Initialize()
        {
            if (_isInitialized)
                return;

            _isInitialized = true;

            var props = typeof(T).GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            foreach (var prop in props)
            {
                object[] attrs = prop.GetCustomAttributes(true);
                foreach (object attr in attrs)
                {
                    var syncAttribute = attr as SyncAttribute;
                    if (syncAttribute != null)
                    {
                        _syncedAttributes.Add(prop.Name.ToLower(), new SyncedAttribute
                        {
                            Getter = BuildUntypedGetter(prop),
                            Setter = BuildUntypedSetter(prop),
                            PropertyType = prop.PropertyType
                        });
                    }
                }
            }

            var fields = typeof(T).GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            foreach (var field in fields)
            {
                object[] attrs = field.GetCustomAttributes(true);
                foreach (object attr in attrs)
                {
                    var syncAttribute = attr as SyncAttribute;
                    if (syncAttribute != null)
                    {
                        _syncedAttributes.Add(field.Name.ToLower(), new SyncedAttribute
                        {
                            Getter = t => field.GetValue(t),
                            Setter = (t, val) => field.SetValue(t, val),
                            PropertyType = field.FieldType
                        });
                    }
                }
            }
        }


        // see: https://stackoverflow.com/a/17669142/4090817
        private static Action<T, object> BuildUntypedSetter(PropertyInfo propertyInfo)
        {
            var targetType = propertyInfo.DeclaringType;
            var methodInfo = propertyInfo.GetSetMethod(true);
            var exTarget = Expression.Parameter(targetType, "t");
            var exValue = Expression.Parameter(typeof(object), "p");
            var exBody = Expression.Call(exTarget, methodInfo,
               Expression.Convert(exValue, propertyInfo.PropertyType));
            var lambda = Expression.Lambda<Action<T, object>>(exBody, exTarget, exValue);
            var action = lambda.Compile();
            return action;
        }

        // see: https://stackoverflow.com/a/17669142/4090817
        private static Func<T, object> BuildUntypedGetter(PropertyInfo propertyInfo)
        {
            var targetType = propertyInfo.DeclaringType;
            var methodInfo = propertyInfo.GetGetMethod(true);
            var returnType = methodInfo.ReturnType;

            var exTarget = Expression.Parameter(targetType, "t");
            var exBody = Expression.Call(exTarget, methodInfo);
            var exBody2 = Expression.Convert(exBody, typeof(object));

            var lambda = Expression.Lambda<Func<T, object>>(exBody2, exTarget);

            var action = lambda.Compile();
            return action;
        }

        public string Id;

        public string ModelId = "";
        private readonly string ChannelPrefix = typeof(T).Name.ToLower();
        private string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(ModelId) ? "" : $"_{ModelId}"); }

        private readonly Dictionary<string, bool> _hasReceivedUpdate = new Dictionary<string, bool>();

        private JObject _nextUpdate;

        private bool _isQuitting;
        private bool _hasReceivedDestroyCommand;
        private bool _hasReceivedFirstUpdate;

        private UniTaskCompletionSource<bool> _isReady = new UniTaskCompletionSource<bool>();


        protected virtual void Awake()
        {
            Initialize();

            var isPrefab = gameObject.scene == null;
            if (!isPrefab && String.IsNullOrEmpty(Id))
                Id = Guid.NewGuid().ToString();
            
            foreach (var attribute in _syncedAttributes)
            {
                if (!_hasReceivedUpdate.ContainsKey(attribute.Key))
                    _hasReceivedUpdate.Add(attribute.Key, false);

                this.ObserveEveryValueChanged(_ => attribute.Value.Getter(this as T))
                    .TakeUntilDestroy(this)
                    .Where(_ => _hasReceivedFirstUpdate)
                    .Subscribe(_ => AddUpdate(attribute.Key, attribute.Value.Getter(this as T)));
            }

            Sync.AddModelUpdateListener(Channel, OnModelUpdate, Id);
            Sync.AddModelDeleteListener(Channel, OnModelDelete);

            _modelCreateSubject.OnNext(this);

            // check if the scene contains a matching manager
            var managers = FindObjectsOfType<SyncBehaviourManager<T>>();
            var hasManager = FindObjectsOfType<SyncBehaviourManager<T>>()
                .Where(m => m.Template?.ModelId == ModelId || (String.IsNullOrEmpty(m.Template?.ModelId) && String.IsNullOrEmpty(ModelId)))
                .Any();

            if (!hasManager)
            {
                if (String.IsNullOrEmpty(ModelId))
                    Debug.LogWarning("No generic Colibri SyncManager found (without ModelId) - synchronization of newly created objects may be restricted");
                else 
                    Debug.LogWarning($"No Colibri SyncManager found (ModelID '{ModelId}') - synchronization of newly created objects may be restricted");
            }
        }

        protected virtual void OnApplicationQuit()
        {
            _isQuitting = true;
        }

        protected virtual void OnDestroy()
        {
            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);
            Sync.RemoveModelDeleteListener(Channel, OnModelDelete);
            _hasReceivedUpdate.Clear();

            _modelDestroySubject.OnNext(this);
            if (_isQuitting || _hasReceivedDestroyCommand)
                return;

            Sync.SendModelDelete(Channel, Id);
            _isReady.TrySetCanceled();
        }

        public void OnModelUpdate(JObject data)
        {
            var id = data["id"].Value<string>();
            if (id == Id)
            {
                _hasReceivedFirstUpdate = true;

                foreach (var prop in data)
                {
                    if (prop.Key != "id")
                        UpdateAttribute(prop.Key, prop.Value);
                }

                _isReady.TrySetResult(true);
            }
        }

        public void SetReady()
        {
            _isReady.TrySetResult(true);
        }

        public async void TriggerSync()
        {
            await _isReady.Task;

            foreach (var attribute in _syncedAttributes)
                AddUpdate(attribute.Key, attribute.Value.Getter(this as T));
        }


        private void OnModelDelete(JObject data)
        {
            var id = data["id"].Value<string>();
            if (id == Id)
            {
                _hasReceivedDestroyCommand = true;
                Destroy(gameObject, 0.001f);
            }
        }

        private void AddUpdate(string name, object value)
        {
            if (_hasReceivedUpdate[name])
            {
                _hasReceivedUpdate[name] = false;
                return;
            }


            if (_nextUpdate == null)
                _nextUpdate = new JObject { { "id", Id } };

            if (_nextUpdate.ContainsKey(name))
                _nextUpdate[name] = value.ToJson();
            else
                _nextUpdate.Add(name, value.ToJson());

            SendUpdate();
        }

        private async void SendUpdate()
        {
            await UniTask.Yield(PlayerLoopTiming.PostLateUpdate);
            if (_nextUpdate != null)
            {
                Sync.SendModelUpdate(Channel, _nextUpdate);
                _nextUpdate = null;
            }
        }

        private void UpdateAttribute(string name, JToken value)
        {
            if (!_syncedAttributes.ContainsKey(name))
            {
                Debug.LogWarning($"Unable to sync attribute {name}");
                return;
            }    

            var attribute = _syncedAttributes[name];
            var oldValue = attribute.Getter(this as T);

            if (attribute.PropertyType == typeof(bool))
                attribute.Setter(this as T, value.Value<bool>());
            else if (attribute.PropertyType == typeof(int))
                attribute.Setter(this as T, value.Value<int>());
            else if (attribute.PropertyType == typeof(float))
                attribute.Setter(this as T, value.Value<float>());
            else if (attribute.PropertyType == typeof(string))
                attribute.Setter(this as T, value.Value<string>());
            else if (attribute.PropertyType == typeof(Vector2))
                attribute.Setter(this as T, value.ToVector2());
            else if (attribute.PropertyType == typeof(Vector3))
                attribute.Setter(this as T, value.ToVector3());
            else if (attribute.PropertyType == typeof(Quaternion))
                attribute.Setter(this as T, value.ToQuaternion());
            else if (attribute.PropertyType == typeof(Color))
                attribute.Setter(this as T, value.ToColor());
            else if (attribute.PropertyType == typeof(bool[]))
                attribute.Setter(this as T, value.Select(x => (bool)x).ToArray());
            else if (attribute.PropertyType == typeof(int[]))
                attribute.Setter(this as T, value.Select(x => (int)x).ToArray());
            else if (attribute.PropertyType == typeof(float[]))
                attribute.Setter(this as T, value.Select(x => (float)x).ToArray());
            else if (attribute.PropertyType == typeof(string[]))
                attribute.Setter(this as T, value.Select(x => (string)x).ToArray());
            else if (attribute.PropertyType == typeof(Vector2[]))
                attribute.Setter(this as T, value.Select(x => x.ToVector2()).ToArray());
            else if (attribute.PropertyType == typeof(Vector3[]))
                attribute.Setter(this as T, value.Select(x => x.ToVector3()).ToArray());
            else if (attribute.PropertyType == typeof(Quaternion[]))
                attribute.Setter(this as T, value.Select(x => x.ToQuaternion()).ToArray());
            else if (attribute.PropertyType == typeof(Color[]))
                attribute.Setter(this as T, value.Select(x => x.ToColor()).ToArray());
            else if (attribute.PropertyType == typeof(JObject))
                attribute.Setter(this as T, value);
            else
                Debug.LogError($"Unable to update attribute {name}: Unsupported type {attribute.PropertyType}");

            var newValue = attribute.Getter(this as T);
            if (newValue != null)
                _hasReceivedUpdate[name] = !newValue.Equals(oldValue);
            else
                _hasReceivedUpdate[name] = newValue != oldValue;
        }
    }
}
