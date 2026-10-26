using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        public static Vector3 Average(IEnumerable<Vector3> vectors)
        {
            var avg = Vector3.zero;
            foreach (var vec in vectors)
            {
                avg += vec;
            }
            return avg / (Mathf.Max(vectors.Count(), 1));
        }

        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        //increase or decrease the length of vector by size
        public static Vector3 AddVectorLength(Vector3 vector, float size)
        {

            //get the vector length
            float magnitude = Vector3.Magnitude(vector);

            //calculate new vector length
            float newMagnitude = magnitude + size;

            //calculate the ratio of the new length to the old length
            float scale = newMagnitude / magnitude;

            //scale the vector
            return vector * scale;
        }

        //create a vector of direction "vector" with length "size"
        public static Vector3 SetVectorLength(Vector3 vector, float size)
        {

            //normalize the vector
            Vector3 vectorNormalized = Vector3.Normalize(vector);

            //scale the vector
            return vectorNormalized *= size;
        }

        //This function calculates a signed (+ or - sign instead of being ambiguous) dot product. It is basically used
        //to figure out whether a vector is positioned to the left or right of another vector. The way this is done is
        //by calculating a vector perpendicular to one of the vectors and using that as a reference. This is because
        //the result of a dot product only has signed information when an angle is transitioning between more or less
        //than 90 degrees.
        public static float SignedDotProduct(Vector3 vectorA, Vector3 vectorB, Vector3 normal)
        {

            Vector3 perpVector;
            float dot;

            //Use the geometry object normal and one of the input vectors to calculate the perpendicular vector
            perpVector = Vector3.Cross(normal, vectorA);

            //Now calculate the dot product between the perpendicular vector (perpVector) and the other input vector
            dot = Vector3.Dot(perpVector, vectorB);

            return dot;
        }

        public static float SignedVectorAngle(Vector3 referenceVector, Vector3 otherVector, Vector3 normal)
        {
            Vector3 perpVector;
            float angle;

            //Use the geometry object normal and one of the input vectors to calculate the perpendicular vector
            perpVector = Vector3.Cross(normal, referenceVector);

            //Now calculate the dot product between the perpendicular vector (perpVector) and the other input vector
            angle = Vector3.Angle(referenceVector, otherVector);
            angle *= Mathf.Sign(Vector3.Dot(perpVector, otherVector));

            return angle;
        }

        //Calculate the angle between a vector and a plane. The plane is made by a normal vector.
        //Output is in radians.
        public static float AngleVectorPlane(Vector3 vector, Vector3 normal)
        {

            float dot;
            float angle;

            //calculate the the dot product between the two input vectors. This gives the cosine between the two vectors
            dot = Vector3.Dot(vector, normal);

            //this is in radians
            angle = (float)Math.Acos(dot);

            return 1.570796326794897f - angle; //90 degrees - angle
        }

        //Calculate the dot product as an angle
        public static float DotProductAngle(Vector3 vec1, Vector3 vec2)
        {

            double dot;
            double angle;

            //get the dot product
            dot = Vector3.Dot(vec1, vec2);

            //Clamp to prevent NaN error. Shouldn't need this in the first place, but there could be a rounding error issue.
            if (dot < -1.0f)
            {
                dot = -1.0f;
            }
            if (dot > 1.0f)
            {
                dot = 1.0f;
            }

            //Calculate the angle. The output is in radians
            //This step can be skipped for optimization...
            angle = Math.Acos(dot);

            return (float)angle;
        }
    }
}
