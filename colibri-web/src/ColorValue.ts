/**
 * A colour on the wire: `[r, g, b, a]` with components 0-1 from colibri-web, `"#RRGGBBAA"` from
 * colibri-unity. Received colours can be either; normalize with {@link toHexColor} or
 * {@link toRgbaColor}.
 */
export type ColorValue = string | [number, number, number, number];

// Colour normalization. A malformed colour warns and falls back to opaque black instead of
// throwing, like colibri-unity's JsonExtensions, so it cannot break the channel handler.

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const hexPair = (n: number) =>
    Math.round(clamp01(n) * 255)
        .toString(16)
        .padStart(2, '0');

const warnNotAColor = (val: unknown) => {
    console.warn(`Colibri: '${JSON.stringify(val)}' is not a colour - expected "#RRGGBBAA" or [r,g,b,a]. Using black.`);
};

// Takes `unknown`: this validates wire data, so the declared ColorValue must not be trusted.
const asComponents = (val: unknown): number[] | null => {
    if (!Array.isArray(val) || val.length < 3) return null;
    const numbers = val as unknown[];
    if (!numbers.every(c => typeof c === 'number' && !Number.isNaN(c))) return null;
    return numbers as number[];
};

/** Converts a colour to `"#RRGGBBAA"`. An unparseable colour warns and gives opaque black. */
export const toHexColor = (val: ColorValue): string => {
    const rgba = toRgbaColor(val);
    return `#${hexPair(rgba[0])}${hexPair(rgba[1])}${hexPair(rgba[2])}${hexPair(rgba[3])}`;
};

/** Converts a colour to `[r, g, b, a]` with components 0-1. An unparseable colour warns and gives opaque black. */
export const toRgbaColor = (val: ColorValue): [number, number, number, number] => {
    const components = asComponents(val);
    if (components !== null) {
        return [
            clamp01(components[0]),
            clamp01(components[1]),
            clamp01(components[2]),
            components.length > 3 ? clamp01(components[3]) : 1
        ];
    }

    if (typeof val === 'string') {
        const hex = val.startsWith('#') ? val.slice(1) : val;
        // Expand the #RGB and #RGBA shorthands that Unity's ColorUtility.TryParseHtmlString accepts.
        const digits = hex.length === 3 || hex.length === 4 ? hex.replace(/./g, c => c + c) : hex;

        if ((digits.length === 6 || digits.length === 8) && /^[0-9a-f]+$/i.test(digits)) {
            const byteAt = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
            return [byteAt(0), byteAt(2), byteAt(4), digits.length === 8 ? byteAt(6) : 1];
        }
    }

    warnNotAColor(val);
    return [0, 0, 0, 1];
};
