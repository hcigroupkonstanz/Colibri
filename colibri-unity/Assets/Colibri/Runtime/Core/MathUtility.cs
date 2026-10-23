using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        private static Transform _tempChild = null;
        private static Transform _tempParent = null;

        public static void Init()
        {

            _tempChild = (new GameObject("Math3d_TempChild")).transform;
            _tempParent = (new GameObject("Math3d_TempParent")).transform;

            _tempChild.gameObject.hideFlags = HideFlags.HideAndDontSave;
            MonoBehaviour.DontDestroyOnLoad(_tempChild.gameObject);

            _tempParent.gameObject.hideFlags = HideFlags.HideAndDontSave;
            MonoBehaviour.DontDestroyOnLoad(_tempParent.gameObject);

            //set the parent
            _tempChild.parent = _tempParent;
        }
    }
}
