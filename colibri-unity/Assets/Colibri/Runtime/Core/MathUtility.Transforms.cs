using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        //Same as the build in TransformDirection(), but using a rotation instead of a transform.
        public static Vector3 TransformDirectionMath(Quaternion rotation, Vector3 vector)
        {

            Vector3 output = rotation * vector;
            return output;
        }

        //Same as the build in InverseTransformDirection(), but using a rotation instead of a transform.
        public static Vector3 InverseTransformDirectionMath(Quaternion rotation, Vector3 vector)
        {

            Vector3 output = Quaternion.Inverse(rotation) * vector;
            return output;
        }

        //Rotate a vector as if it is attached to an object with rotation "from", which is then rotated to rotation "to".
        //Similar to TransformWithParent(), but rotating a vector instead of a transform.
        public static Vector3 RotateVectorFromTo(Quaternion from, Quaternion to, Vector3 vector)
        {
            //Note: comments are in case all inputs are in World Space.
            Quaternion Q = SubtractRotation(to, from);              //Output is in object space.
            Vector3 A = InverseTransformDirectionMath(from, vector);//Output is in object space.
            Vector3 B = Q * A;                                      //Output is in local space.
            Vector3 C = TransformDirectionMath(from, B);            //Output is in world space.
            return C;
        }

        //Gets a quaternion from a matrix
        public static Quaternion QuaternionFromMatrix(Matrix4x4 m)
        {

            return Quaternion.LookRotation(m.GetColumn(2), m.GetColumn(1));
        }

        //Gets a position from a matrix
        public static Vector3 PositionFromMatrix(Matrix4x4 m)
        {

            Vector4 vector4Position = m.GetColumn(3);
            return new Vector3(vector4Position.x, vector4Position.y, vector4Position.z);
        }

        //This is an alternative for Quaternion.LookRotation. Instead of aligning the forward and up vector of the game 
        //object with the input vectors, a custom direction can be used instead of the fixed forward and up vectors.
        //alignWithVector and alignWithNormal are in world space.
        //customForward and customUp are in object space.
        //Usage: use alignWithVector and alignWithNormal as if you are using the default LookRotation function.
        //Set customForward and customUp to the vectors you wish to use instead of the default forward and up vectors.
        public static void LookRotationExtended(ref GameObject gameObjectInOut, Vector3 alignWithVector, Vector3 alignWithNormal, Vector3 customForward, Vector3 customUp)
        {

            //Set the rotation of the destination
            Quaternion rotationA = Quaternion.LookRotation(alignWithVector, alignWithNormal);

            //Set the rotation of the custom normal and up vectors. 
            //When using the default LookRotation function, this would be hard coded to the forward and up vector.
            Quaternion rotationB = Quaternion.LookRotation(customForward, customUp);

            //Calculate the rotation
            gameObjectInOut.transform.rotation = rotationA * Quaternion.Inverse(rotationB);
        }

        //This function transforms one object as if it was parented to the other.
        //Before using this function, the Init() function must be called
        //Input: parentRotation and parentPosition: the current parent transform.
        //Input: startParentRotation and startParentPosition: the transform of the parent object at the time the objects are parented.
        //Input: startChildRotation and startChildPosition: the transform of the child object at the time the objects are parented.
        //Output: childRotation and childPosition.
        //All transforms are in world space.
        public static void TransformWithParent(out Quaternion childRotation, out Vector3 childPosition, Quaternion parentRotation, Vector3 parentPosition, Quaternion startParentRotation, Vector3 startParentPosition, Quaternion startChildRotation, Vector3 startChildPosition)
        {

            childRotation = Quaternion.identity;
            childPosition = Vector3.zero;

            //set the parent start transform
            tempParent.rotation = startParentRotation;
            tempParent.position = startParentPosition;
            tempParent.localScale = Vector3.one; //to prevent scale wandering

            //set the child start transform
            tempChild.rotation = startChildRotation;
            tempChild.position = startChildPosition;
            tempChild.localScale = Vector3.one; //to prevent scale wandering

            //translate and rotate the child by moving the parent
            tempParent.rotation = parentRotation;
            tempParent.position = parentPosition;

            //get the child transform
            childRotation = tempChild.rotation;
            childPosition = tempChild.position;
        }

        //With this function you can align a triangle of an object with any transform.
        //Usage: gameObjectInOut is the game object you want to transform.
        //alignWithVector, alignWithNormal, and alignWithPosition is the transform with which the triangle of the object should be aligned with.
        //triangleForward, triangleNormal, and trianglePosition is the transform of the triangle from the object.
        //alignWithVector, alignWithNormal, and alignWithPosition are in world space.
        //triangleForward, triangleNormal, and trianglePosition are in object space.
        //trianglePosition is the mesh position of the triangle. The effect of the scale of the object is handled automatically.
        //trianglePosition can be set at any position, it does not have to be at a vertex or in the middle of the triangle.
        public static void PreciseAlign(ref GameObject gameObjectInOut, Vector3 alignWithVector, Vector3 alignWithNormal, Vector3 alignWithPosition, Vector3 triangleForward, Vector3 triangleNormal, Vector3 trianglePosition)
        {

            //Set the rotation.
            LookRotationExtended(ref gameObjectInOut, alignWithVector, alignWithNormal, triangleForward, triangleNormal);

            //Get the world space position of trianglePosition
            Vector3 trianglePositionWorld = gameObjectInOut.transform.TransformPoint(trianglePosition);

            //Get a vector from trianglePosition to alignWithPosition
            Vector3 translateVector = alignWithPosition - trianglePositionWorld;

            //Now transform the object so the triangle lines up correctly.
            gameObjectInOut.transform.Translate(translateVector, Space.World);
        }

        //Convert a position, direction, and normal vector to a transform
        public static void VectorsToTransform(ref GameObject gameObjectInOut, Vector3 positionVector, Vector3 directionVector, Vector3 normalVector)
        {

            gameObjectInOut.transform.position = positionVector;
            gameObjectInOut.transform.rotation = Quaternion.LookRotation(directionVector, normalVector);
        }
    }
}
