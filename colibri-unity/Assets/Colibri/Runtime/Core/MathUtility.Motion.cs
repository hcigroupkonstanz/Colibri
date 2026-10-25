using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        private static Vector3[] _positionRegister;
        private static float[] _posTimeRegister;
        private static int _positionSamplesTaken = 0;

        private static Quaternion[] _rotationRegister;
        private static float[] _rotTimeRegister;
        private static int _rotationSamplesTaken = 0;

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
            if (_positionRegister == null)
            {

                _positionRegister = new Vector3[samples];
                _posTimeRegister = new float[samples];
            }

            //Fill the position and time sample array and shift the location in the array to the left
            //each time a new sample is taken. This way index 0 will always hold the oldest sample and the
            //highest index will always hold the newest sample. 
            for (int i = 0; i < _positionRegister.Length - 1; i++)
            {

                _positionRegister[i] = _positionRegister[i + 1];
                _posTimeRegister[i] = _posTimeRegister[i + 1];
            }
            _positionRegister[_positionRegister.Length - 1] = position;
            _posTimeRegister[_posTimeRegister.Length - 1] = Time.time;

            _positionSamplesTaken++;

            //The output acceleration can only be calculated if enough samples are taken.
            if (_positionSamplesTaken >= samples)
            {

                //Calculate average speed change.
                for (int i = 0; i < _positionRegister.Length - 2; i++)
                {

                    deltaDistance = _positionRegister[i + 1] - _positionRegister[i];
                    deltaTime = _posTimeRegister[i + 1] - _posTimeRegister[i];

                    //If deltaTime is 0, the output is invalid.
                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedA = deltaDistance / deltaTime;
                    deltaDistance = _positionRegister[i + 2] - _positionRegister[i + 1];
                    deltaTime = _posTimeRegister[i + 2] - _posTimeRegister[i + 1];

                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedB = deltaDistance / deltaTime;

                    //This is the accumulated speed change at this stage, not the average yet.
                    averageSpeedChange += speedB - speedA;
                }

                //Now this is the average speed change.
                averageSpeedChange /= _positionRegister.Length - 2;

                //Get the total time difference.
                float deltaTimeTotal = _posTimeRegister[_posTimeRegister.Length - 1] - _posTimeRegister[0];

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
            if (_rotationRegister == null)
            {

                _rotationRegister = new Quaternion[samples];
                _rotTimeRegister = new float[samples];
            }

            //Fill the rotation and time sample array and shift the location in the array to the left
            //each time a new sample is taken. This way index 0 will always hold the oldest sample and the
            //highest index will always hold the newest sample. 
            for (int i = 0; i < _rotationRegister.Length - 1; i++)
            {

                _rotationRegister[i] = _rotationRegister[i + 1];
                _rotTimeRegister[i] = _rotTimeRegister[i + 1];
            }
            _rotationRegister[_rotationRegister.Length - 1] = rotation;
            _rotTimeRegister[_rotTimeRegister.Length - 1] = Time.time;

            _rotationSamplesTaken++;

            //The output acceleration can only be calculated if enough samples are taken.
            if (_rotationSamplesTaken >= samples)
            {

                //Calculate average speed change.
                for (int i = 0; i < _rotationRegister.Length - 2; i++)
                {

                    deltaRotation = SubtractRotation(_rotationRegister[i + 1], _rotationRegister[i]);
                    deltaTime = _rotTimeRegister[i + 1] - _rotTimeRegister[i];

                    //If deltaTime is 0, the output is invalid.
                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedA = RotDiffToSpeedVec(deltaRotation, deltaTime);
                    deltaRotation = SubtractRotation(_rotationRegister[i + 2], _rotationRegister[i + 1]);
                    deltaTime = _rotTimeRegister[i + 2] - _rotTimeRegister[i + 1];

                    if (deltaTime == 0)
                    {

                        return false;
                    }

                    speedB = RotDiffToSpeedVec(deltaRotation, deltaTime);

                    //This is the accumulated speed change at this stage, not the average yet.
                    averageSpeedChange += speedB - speedA;
                }

                //Now this is the average speed change.
                averageSpeedChange /= _rotationRegister.Length - 2;

                //Get the total time difference.
                float deltaTimeTotal = _rotTimeRegister[_rotTimeRegister.Length - 1] - _rotTimeRegister[0];

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
