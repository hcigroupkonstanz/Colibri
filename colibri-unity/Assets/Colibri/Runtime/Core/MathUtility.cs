using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        private static Transform tempChild = null;
        private static Transform tempParent = null;

        public static void Init()
        {

            tempChild = (new GameObject("Math3d_TempChild")).transform;
            tempParent = (new GameObject("Math3d_TempParent")).transform;

            tempChild.gameObject.hideFlags = HideFlags.HideAndDontSave;
            MonoBehaviour.DontDestroyOnLoad(tempChild.gameObject);

            tempParent.gameObject.hideFlags = HideFlags.HideAndDontSave;
            MonoBehaviour.DontDestroyOnLoad(tempParent.gameObject);

            //set the parent
            tempChild.parent = tempParent;
        }
    }
}
