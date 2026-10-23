using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        private static Vector3[] positionRegister;
        private static float[] posTimeRegister;
        private static int positionSamplesTaken = 0;

        private static Quaternion[] rotationRegister;
        private static float[] rotTimeRegister;
        private static int rotationSamplesTaken = 0;

        //This function calculates the acceleration vector in meter/second^2.
        //Input: position. If the output is used for motion simulation, the input transform
        //has to be located at the seat base, not at the vehicle CG. Attach an empty GameObject
        //at the correct location and use that as the input for this function.
        //Gravity is not taken into account but this can be added to the output if needed.
        //A low number of samples can give a jittery result due to rounding errors.
        //If more samples are used, the output is more smooth but has a higher latency.
        public static bool LinearAcceleration(out Vector3 vector, Vector3 position, int samples)
        {

            Vector3 averageSpeedChange = Vector3.zero;
            vector = Vector3.zero;
            Vector3 deltaDistance;
            float deltaTime;
            Vector3 speedA;
            Vector3 speedB;

            //Clamp sample amount. In order to calculate acceleration we need at least 2 changes
            //in speed, so we need at least 3 position samples.
            if (samples < 3)
            {

                samples = 3;
            }

            //Initialize
            if (positionRegister == null)
            {

                positionRegister = new Vector3[samples];
                posTimeRegister = new float[samples];
            }

            //Fill the position and time sample array and shift the location in the array to the left
            //each time a new sample is taken. This way index 0 will always hold the oldest sample and the
            //highest index will always hold the newest sample. 
            for (int i = 0; i < positionRegister.Length - 1; i++)
            {

                positionRegister[i] = positionRegister[i + 1];
                posTimeRegister[i] = posTimeRegister[i + 1];
            }
            positionRegister[positionRegister.Length - 1] = position;
            posTimeRegister[posTimeRegister.Length - 1] = Time.time;

            positionSamplesTaken++;

            //The output acceleration can only be calculated if enough samples are taken.
            if (positionSamplesTaken >= samples)
            {

                //Calculate average speed change.
                for (int i = 0; i < positionRegister.Length - 2; i++)
                {

                    deltaDistance = positionRegister[i + 1] - positionRegister[i];
                    deltaTime = posTimeRegister[i + 1] - posTimeRegister[i];

                    //If deltaTime is 0, the output is invalid.
                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedA = deltaDistance / deltaTime;
                    deltaDistance = positionRegister[i + 2] - positionRegister[i + 1];
                    deltaTime = posTimeRegister[i + 2] - posTimeRegister[i + 1];

                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedB = deltaDistance / deltaTime;

                    //This is the accumulated speed change at this stage, not the average yet.
                    averageSpeedChange += speedB - speedA;
                }

                //Now this is the average speed change.
                averageSpeedChange /= positionRegister.Length - 2;

                //Get the total time difference.
                float deltaTimeTotal = posTimeRegister[posTimeRegister.Length - 1] - posTimeRegister[0];

                //Now calculate the acceleration, which is an average over the amount of samples taken.
                vector = averageSpeedChange / deltaTimeTotal;

                return true;
            }

            else
            {

                return false;
            }
        }

        /*
        //This function calculates angular acceleration in object space as deg/second^2, encoded as a vector. 
        //For example, if the output vector is 0,0,-5, the angular acceleration is 5 deg/second^2 around the object Z axis, to the left. 
        //Input: rotation (quaternion). If the output is used for motion simulation, the input transform
        //has to be located at the seat base, not at the vehicle CG. Attach an empty GameObject
        //at the correct location and use that as the input for this function.
        //A low number of samples can give a jittery result due to rounding errors.
        //If more samples are used, the output is more smooth but has a higher latency.
        //Note: the result is only accurate if the rotational difference between two samples is less than 180 degrees.
        //Note: a suitable way to visualize the result is:
        Vector3 dir;
        float scale = 2f;	
        dir = new Vector3(vector.x, 0, 0);
        dir = Math3d.SetVectorLength(dir, dir.magnitude * scale);
        dir = gameObject.transform.TransformDirection(dir);
        Debug.DrawRay(gameObject.transform.position, dir, Color.red);	
        dir = new Vector3(0, vector.y, 0);
        dir = Math3d.SetVectorLength(dir, dir.magnitude * scale);
        dir = gameObject.transform.TransformDirection(dir);
        Debug.DrawRay(gameObject.transform.position, dir, Color.green);	
        dir = new Vector3(0, 0, vector.z);
        dir = Math3d.SetVectorLength(dir, dir.magnitude * scale);
        dir = gameObject.transform.TransformDirection(dir);
        Debug.DrawRay(gameObject.transform.position, dir, Color.blue);	*/
        public static bool AngularAcceleration(out Vector3 vector, Quaternion rotation, int samples)
        {

            Vector3 averageSpeedChange = Vector3.zero;
            vector = Vector3.zero;
            Quaternion deltaRotation;
            float deltaTime;
            Vector3 speedA;
            Vector3 speedB;

            //Clamp sample amount. In order to calculate acceleration we need at least 2 changes
            //in speed, so we need at least 3 rotation samples.
            if (samples < 3)
            {

                samples = 3;
            }

            //Initialize
            if (rotationRegister == null)
            {

                rotationRegister = new Quaternion[samples];
                rotTimeRegister = new float[samples];
            }

            //Fill the rotation and time sample array and shift the location in the array to the left
            //each time a new sample is taken. This way index 0 will always hold the oldest sample and the
            //highest index will always hold the newest sample. 
            for (int i = 0; i < rotationRegister.Length - 1; i++)
            {

                rotationRegister[i] = rotationRegister[i + 1];
                rotTimeRegister[i] = rotTimeRegister[i + 1];
            }
            rotationRegister[rotationRegister.Length - 1] = rotation;
            rotTimeRegister[rotTimeRegister.Length - 1] = Time.time;

            rotationSamplesTaken++;

            //The output acceleration can only be calculated if enough samples are taken.
            if (rotationSamplesTaken >= samples)
            {

                //Calculate average speed change.
                for (int i = 0; i < rotationRegister.Length - 2; i++)
                {

                    deltaRotation = SubtractRotation(rotationRegister[i + 1], rotationRegister[i]);
                    deltaTime = rotTimeRegister[i + 1] - rotTimeRegister[i];

                    //If deltaTime is 0, the output is invalid.
                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedA = RotDiffToSpeedVec(deltaRotation, deltaTime);
                    deltaRotation = SubtractRotation(rotationRegister[i + 2], rotationRegister[i + 1]);
                    deltaTime = rotTimeRegister[i + 2] - rotTimeRegister[i + 1];

                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedB = RotDiffToSpeedVec(deltaRotation, deltaTime);

                    //This is the accumulated speed change at this stage, not the average yet.
                    averageSpeedChange += speedB - speedA;
                }

                //Now this is the average speed change.
                averageSpeedChange /= rotationRegister.Length - 2;

                //Get the total time difference.
                float deltaTimeTotal = rotTimeRegister[rotTimeRegister.Length - 1] - rotTimeRegister[0];

                //Now calculate the acceleration, which is an average over the amount of samples taken.
                vector = averageSpeedChange / deltaTimeTotal;

                return true;
            }

            else
            {

                return false;
            }
        }

        //Convert a rotation difference to a speed vector.
        //For internal use only.
        private static Vector3 RotDiffToSpeedVec(Quaternion rotation, float deltaTime)
        {

            float x;
            float y;
            float z;

            if (rotation.eulerAngles.x <= 180.0f)
            {

                x = rotation.eulerAngles.x;
            }

            else
            {

                x = rotation.eulerAngles.x - 360.0f;
            }

            if (rotation.eulerAngles.y <= 180.0f)
            {

                y = rotation.eulerAngles.y;
            }

            else
            {

                y = rotation.eulerAngles.y - 360.0f;
            }

            if (rotation.eulerAngles.z <= 180.0f)
            {

                z = rotation.eulerAngles.z;
            }

            else
            {

                z = rotation.eulerAngles.z - 360.0f;
            }

            return new Vector3(x / deltaTime, y / deltaTime, z / deltaTime);
        }
    }
}
