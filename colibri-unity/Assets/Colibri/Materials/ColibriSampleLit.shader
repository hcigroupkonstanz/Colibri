// The shader of the samples' objects, in place of Unity's Default-Material: that one belongs to the
// built-in render pipeline and draws magenta under URP. The single pass has no LightMode tag, which
// the built-in pipeline and URP both draw, and it shades from a fixed direction instead of the
// scene's lights, which the two pipelines hand to a shader in different ways.
Shader "Colibri/Sample Lit"
{
    Properties
    {
        [MainColor] _Color ("Color", Color) = (1, 1, 1, 1)
    }

    SubShader
    {
        Tags { "RenderType" = "Opaque" "Queue" = "Geometry" }

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"

            half4 _Color;

            struct appdata
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                half shade : TEXCOORD0;
                // Single-pass stereo on a headset: without it the object shows in one eye only.
                UNITY_VERTEX_OUTPUT_STEREO
            };

            v2f vert(appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                o.pos = UnityObjectToClipPos(v.vertex);
                float3 normal = UnityObjectToWorldNormal(v.normal);
                o.shade = 0.45 + 0.55 * saturate(dot(normal, normalize(float3(0.4, 1.0, -0.6))));
                return o;
            }

            half4 frag(v2f i) : SV_Target
            {
                return half4(_Color.rgb * i.shade, _Color.a);
            }
            ENDCG
        }
    }
}
