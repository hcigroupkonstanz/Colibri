/** What the chart specs need to run d3 transitions in jsdom and compare the markup they leave. */
export interface ChartTestEnvironment {
    /** Runs the d3 transitions under `root` to their end. */
    settle(root: Element): Promise<void>;
    /** Puts back what `useChartTestEnvironment` replaced. */
    restore(): void;
}

const translate = /translate\(\s*([-\d.e+]+)\s*(?:,\s*([-\d.e+]+)\s*)?\)/;
const MAX_FRAMES = 50;
const FRAME_STEP_MILLIS = 2000;

// Never set back: d3 keeps its timers between specs, and its clock must not run backwards.
let now = 1000;

const hasTransition = function (root: Element): boolean {
    return [ root, ...Array.from(root.querySelectorAll('*')) ].some(element => '__transition' in element);
};

/**
 * Local time is UTC, so the axis labels do not depend on the machine. d3 reads the clock of its
 * transitions from performance.now: the frames stay real, the time is a counter that `settle` moves.
 */
export const useChartTestEnvironment = function (): ChartTestEnvironment {
    const timeZone = process.env['TZ'];
    process.env['TZ'] = 'UTC';

    // jsdom has no SVGElement.transform, which d3 reads to interpolate a transform attribute.
    Object.defineProperty(SVGElement.prototype, 'transform', {
        configurable: true,
        get(this: Element) {
            const match = translate.exec(this.getAttribute('transform') ?? '');
            const matrix = { a: 1, b: 0, c: 0, d: 1, e: Number(match?.[1] ?? 0), f: Number(match?.[2] ?? 0) };
            return { baseVal: { consolidate: () => match ? { matrix } : null } };
        }
    });

    const realNow = performance.now;
    performance.now = () => now;

    return {
        settle: async (root: Element) => {
            for (let frame = 0; frame < MAX_FRAMES && hasTransition(root); frame++) {
                now += FRAME_STEP_MILLIS;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            }
            if (hasTransition(root)) throw new Error('The transitions did not end');
        },
        restore: () => {
            performance.now = realNow;
            delete (SVGElement.prototype as { transform?: unknown }).transform;
            if (timeZone === undefined) delete process.env['TZ'];
            else process.env['TZ'] = timeZone;
        }
    };
};
