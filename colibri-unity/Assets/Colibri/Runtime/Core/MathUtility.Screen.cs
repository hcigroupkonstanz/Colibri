using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    public partial class MathUtility
    {
        /**
         *  Functions below taken from http://wiki.unity3d.com/index.php/3d_Math_functions
         */

        //Returns the pixel distance from the mouse pointer to a line.
        //Alternative for HandleUtility.DistanceToLine(). Works both in Editor mode and Play mode.
        //Do not call this function from OnGUI() as the mouse position will be wrong.
        public static float MouseDistanceToLine(Vector3 linePoint1, Vector3 linePoint2)
        {

            Camera currentCamera;
            Vector3 mousePosition;

#if UNITY_EDITOR
            if (Camera.current != null)
            {

                currentCamera = Camera.current;
            }

            else
            {

                currentCamera = Camera.main;
            }

            //convert format because y is flipped
            mousePosition = new Vector3(Event.current.mousePosition.x, currentCamera.pixelHeight - Event.current.mousePosition.y, 0f);

#else
		currentCamera = Camera.main;
		mousePosition = Input.mousePosition;
#endif

            Vector3 screenPos1 = currentCamera.WorldToScreenPoint(linePoint1);
            Vector3 screenPos2 = currentCamera.WorldToScreenPoint(linePoint2);
            Vector3 projectedPoint = ProjectPointOnLineSegment(screenPos1, screenPos2, mousePosition);

            //set z to zero
            projectedPoint = new Vector3(projectedPoint.x, projectedPoint.y, 0f);

            Vector3 vector = projectedPoint - mousePosition;
            return vector.magnitude;
        }

        //Returns the pixel distance from the mouse pointer to a camera facing circle.
        //Alternative for HandleUtility.DistanceToCircle(). Works both in Editor mode and Play mode.
        //Do not call this function from OnGUI() as the mouse position will be wrong.
        //If you want the distance to a point instead of a circle, set the radius to 0.
        public static float MouseDistanceToCircle(Vector3 point, float radius)
        {

            Camera currentCamera;
            Vector3 mousePosition;

#if UNITY_EDITOR
            if (Camera.current != null)
            {

                currentCamera = Camera.current;
            }

            else
            {

                currentCamera = Camera.main;
            }

            //convert format because y is flipped
            mousePosition = new Vector3(Event.current.mousePosition.x, currentCamera.pixelHeight - Event.current.mousePosition.y, 0f);
#else
		currentCamera = Camera.main;
		mousePosition = Input.mousePosition;
#endif

            Vector3 screenPos = currentCamera.WorldToScreenPoint(point);

            //set z to zero
            screenPos = new Vector3(screenPos.x, screenPos.y, 0f);

            Vector3 vector = screenPos - mousePosition;
            float fullDistance = vector.magnitude;
            float circleDistance = fullDistance - radius;

            return circleDistance;
        }

        //Returns true if a line segment (made up of linePoint1 and linePoint2) is fully or partially in a rectangle
        //made up of RectA to RectD. The line segment is assumed to be on the same plane as the rectangle. If the line is 
        //not on the plane, use ProjectPointOnPlane() on linePoint1 and linePoint2 first.
        public static bool IsLineInRectangle(Vector3 linePoint1, Vector3 linePoint2, Vector3 rectA, Vector3 rectB, Vector3 rectC, Vector3 rectD)
        {

            bool pointAInside = false;
            bool pointBInside = false;

            pointAInside = IsPointInRectangle(linePoint1, rectA, rectC, rectB, rectD);

            if (!pointAInside)
            {

                pointBInside = IsPointInRectangle(linePoint2, rectA, rectC, rectB, rectD);
            }

            //none of the points are inside, so check if a line is crossing
            if (!pointAInside && !pointBInside)
            {

                bool lineACrossing = AreLineSegmentsCrossing(linePoint1, linePoint2, rectA, rectB);
                bool lineBCrossing = AreLineSegmentsCrossing(linePoint1, linePoint2, rectB, rectC);
                bool lineCCrossing = AreLineSegmentsCrossing(linePoint1, linePoint2, rectC, rectD);
                bool lineDCrossing = AreLineSegmentsCrossing(linePoint1, linePoint2, rectD, rectA);

                if (lineACrossing || lineBCrossing || lineCCrossing || lineDCrossing)
                {

                    return true;
                }

                else
                {

                    return false;
                }
            }

            else
            {

                return true;
            }
        }

        //Returns true if "point" is in a rectangle mad up of RectA to RectD. The line point is assumed to be on the same 
        //plane as the rectangle. If the point is not on the plane, use ProjectPointOnPlane() first.
        public static bool IsPointInRectangle(Vector3 point, Vector3 rectA, Vector3 rectC, Vector3 rectB, Vector3 rectD)
        {

            Vector3 vector;
            Vector3 linePoint;

            //get the center of the rectangle
            vector = rectC - rectA;
            float size = -(vector.magnitude / 2f);
            vector = AddVectorLength(vector, size);
            Vector3 middle = rectA + vector;

            Vector3 xVector = rectB - rectA;
            float width = xVector.magnitude / 2f;

            Vector3 yVector = rectD - rectA;
            float height = yVector.magnitude / 2f;

            linePoint = ProjectPointOnLine(middle, xVector.normalized, point);
            vector = linePoint - point;
            float yDistance = vector.magnitude;

            linePoint = ProjectPointOnLine(middle, yVector.normalized, point);
            vector = linePoint - point;
            float xDistance = vector.magnitude;

            if ((xDistance <= width) && (yDistance <= height))
            {

                return true;
            }

            else
            {

                return false;
            }
        }
    }
}
