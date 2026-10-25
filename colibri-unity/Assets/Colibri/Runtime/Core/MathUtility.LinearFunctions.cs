namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        //Get y from a linear function, with x as an input. The linear function goes through points
        //0,0 on the left ,and Qxy on the right.
        public static float LinearFunction2DBasic(float x, float Qx, float Qy)
        {

            float y = x * (Qy / Qx);

            return y;
        }

        //Get y from a linear function, with x as an input. The linear function goes through points
        //Pxy on the left ,and Qxy on the right.
        public static float LinearFunction2DFull(float x, float Px, float Py, float Qx, float Qy)
        {

            float y = 0f;

            float A = Qy - Py;
            float B = Qx - Px;
            float C = A / B;

            y = Py + (C * (x - Px));

            return y;
        }
    }
}
