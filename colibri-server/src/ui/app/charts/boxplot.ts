import { max, min, quantile } from 'd3';
import type { BaseType, Selection, Transition, ValueFn } from 'd3';
import type { ScaleLinear } from 'd3-scale';
import { scaleLinear } from 'd3-scale';

// Adapted from https://github.com/akngs/d3-boxplot/blob/main/src/boxplot.js

export interface BoxplotStats {
    fiveNums: number[];
    iqr: number;
    step: number;
    fences: Fence[];
    boxes: Box[];
    whiskers: Whisker[];
    points: Point[];
}

export interface Fence {
    start: number;
    end: number;
}

export interface Box {
    start: number;
    end: number;
}

export interface Whisker {
    start: number | undefined;
    end: number;
}

export interface Point {
    value: number;
    datum: number;
    outlier: boolean;
    farout: boolean;
}

interface BoxplotOptions {
    vertical?: boolean;
    scale?: ScaleLinear<number, number>;
    bandwidth?: number;
    boxwidth?: number;
    showInnerDots?: boolean;
    symbol?: string;
    opacity?: number;
    jitter?: number;
}

type BoxplotSettings = Required<BoxplotOptions>;

interface Orientation {
    x: string;
    y: string;
    h: string;
    coor: (x: number, y: number) => string;
    inversed: boolean;
}

type PlotSelection = Selection<SVGGElement, BoxplotStats, null, undefined>;
type PlotTransition = Transition<SVGGElement, BoxplotStats, null, undefined>;
type PlotContext = PlotSelection | PlotTransition;

// The one transition type selection.transition(t) accepts in @types/d3-transition;
// a typed transition goes through unknown.
type AnyTransition = Transition<BaseType, unknown, null, undefined>;
type PartSelection<GElement extends BaseType, Datum> = Selection<GElement, Datum, SVGGElement, BoxplotStats>;

// The attr() a selection and a transition both offer.
interface RenderContext<GElement extends BaseType, Datum> {
    attr(name: string, value: string | number | ValueFn<GElement, Datum, string | number | boolean | null>): this;
}

// What drawBoxplot calls on a part, as a selection and then as its transition.
interface PartContext<GElement extends BaseType, Datum> extends RenderContext<GElement, Datum> {
    transition(transition: AnyTransition): PartContext<GElement, Datum>;
    call(func: (ctx: RenderContext<GElement, Datum>) => void): this;
    remove(): this;
}

type PointElement = SVGCircleElement | SVGLineElement;
type PointContext = RenderContext<PointElement, Point>;
type PointKey = (datum: number) => string;

interface PointRenderer {
    nodeName: 'circle' | 'line';
    enter: (ctx: PointContext) => void;
    update: (ctx: PointContext) => void;
    exit: (ctx: PointContext) => void;
}

const orientationOf = function ({ vertical, scale }: BoxplotSettings): Orientation {
    return {
        x: vertical ? 'y' : 'x',
        y: vertical ? 'x' : 'y',
        h: vertical ? 'width' : 'height',
        coor: vertical ? (x: number, y: number) => [y, x].join(',') : (x: number, y: number) => [x, y].join(','),
        inversed: scale.range()[0] > scale.range()[1],
    };
};

const dotRenderer = function ({ scale, bandwidth, opacity, jitter }: BoxplotSettings, { x, y }: Orientation): PointRenderer {
    const jitterer =
        jitter === 0
            ? 0
            : (d: Point, i: number) =>
                // 1. determinisic pseudo random noise
                Math.sin(1e5 * (i + d.value)) *
                0.5 *
                // 2. scale
                (d.farout ? 0 : d.outlier ? 0.5 : 1) *
                jitter *
                bandwidth;
    const r = Math.max(1.5, Math.sqrt(bandwidth) * 0.5);

    return {
        nodeName: 'circle',
        enter: function (ctx: PointContext) {
            ctx
                .attr('fill', 'currentColor')
                .attr('stroke', 'none')
                .attr('opacity', 0)
                .attr('r', 0)
                .attr(`c${x}`, (d: Point) => scale(d.value))
                .attr(`c${y}`, jitterer);
        },
        update: function (ctx: PointContext) {
            ctx
                .attr('opacity', opacity)
                .attr('r', (d: Point) => (d.farout ? r * 1.5 : r))
                .attr(`c${x}`, (d: Point) => scale(d.value))
                .attr(`c${y}`, jitterer);
        },
        exit: function (context: PointContext) {
            context.attr('opacity', 0).attr('r', 0);
        },
    };
};

const tickRenderer = function ({ scale, boxwidth, opacity }: BoxplotSettings, { x, y }: Orientation): PointRenderer {
    return {
        nodeName: 'line',
        enter: function (ctx: PointContext) {
            ctx
                .attr('stroke', 'currentColor')
                .attr('opacity', 0)
                .attr(`${x}1`, (d: Point) => scale(d.value))
                .attr(`${x}2`, (d: Point) => scale(d.value))
                .attr(`${y}1`, 0)
                .attr(`${y}2`, 0);
        },
        update: function (ctx: PointContext) {
            ctx
                .attr('opacity', opacity)
                .attr(`${x}1`, (d: Point) => scale(d.value))
                .attr(`${x}2`, (d: Point) => scale(d.value))
                .attr(`${y}1`, Math.min(-2, boxwidth * -0.25))
                .attr(`${y}2`, Math.max(2, boxwidth * 0.25));
        },
        exit: function (ctx: PointContext) {
            ctx.attr('opacity', 0).attr(`${y}1`, 0).attr(`${y}2`, 0);
        },
    };
};

const pointRenderer = function (settings: BoxplotSettings, orientation: Orientation): PointRenderer {
    const renderers: Record<string, PointRenderer> = {};
    renderers[boxplotSymbolDot] = dotRenderer(settings, orientation);
    renderers[boxplotSymbolTick] = tickRenderer(settings, orientation);
    return renderers[settings.symbol];
};

const selectOrAppendGroup = function (selection: PlotSelection, name: string, transform: string): PlotSelection {
    const group = selection.select<SVGGElement>(`g.${name}`);
    if (group.empty())
        return selection
            .append('g')
            .attr('class', name)
            .attr('transform', transform);
    return group;
};

const enterWhiskers = function (gWhisker: PlotSelection, whiskerPath: (d: Whisker) => string): PartSelection<SVGPathElement, Whisker> {
    const whisker = gWhisker.selectAll<SVGPathElement, Whisker>('path').data((d: BoxplotStats) => d.whiskers);
    return whisker
        .enter()
        .append('path')
        .attr('fill', 'none')
        .attr('stroke', 'currentColor')
        .attr('opacity', 0)
        .attr('d', whiskerPath)
        .merge(whisker);
};

const enterBoxes = function (gBox: PlotSelection, { scale, boxwidth }: BoxplotSettings, { x, y, h, inversed }: Orientation): PartSelection<SVGLineElement, Box> {
    const box = gBox.selectAll<SVGLineElement, Box>('line').data((d: BoxplotStats) => d.boxes);
    return box
        .enter()
        .append('line')
        .attr('stroke', 'currentColor')
        .attr('stroke-width', boxwidth)
        .attr('opacity', 0)
        .attr(`${x}1`, (d: Box, i: number) => scale(d.start) + (i === 0 ? 0 : 0.5) * (inversed ? -1 : +1))
        .attr(`${x}2`, (d: Box, i: number) => scale(d.end) - (i === 0 ? 0.5 : 0) * (inversed ? -1 : +1))
        .attr(`${y}1`, 0)
        .attr(`${y}2`, 0)
        .attr(h, boxwidth)
        .merge(box);
};

const updateBoxes = function (box: RenderContext<SVGLineElement, Box>, { scale, boxwidth, opacity }: BoxplotSettings, { x, y, inversed }: Orientation): void {
    box
        .attr('opacity', opacity)
        .attr('stroke-width', boxwidth)
        .attr(`${x}1`, (d: Box, i: number) => scale(d.start) + (i === 0 ? 0 : 0.5) * (inversed ? -1 : +1))
        .attr(`${x}2`, (d: Box, i: number) => scale(d.end) - (i === 0 ? 0.5 : 0) * (inversed ? -1 : +1))
        .attr(`${y}1`, 0)
        .attr(`${y}2`, 0);
};

const enterPoints = function (
    gPoint: PlotSelection,
    { showInnerDots }: BoxplotSettings,
    renderer: PointRenderer,
    key: PointKey | undefined
): Record<'point' | 'pointExit', PartSelection<PointElement, Point>> {
    // Remove old symbols
    gPoint
        .selectAll('.point')
        // .filter(function () {
        //     return this.nodeName !== renderer.nodeName:
        // })
        .remove();

    const point = gPoint
        .selectAll<PointElement, Point>('.point')
        .data(
            (d: BoxplotStats) => (showInnerDots ? d.points : d.points.filter((d2: Point) => d2.outlier)),
            key ? (d: Point) => key(d.datum) : undefined
        );
    const pointExit = point.exit<Point>();
    return {
        point: point
            .enter()
            .append(renderer.nodeName)
            .attr('class', 'point')
            .call(renderer.enter)
            .merge(point)
            .classed('outlier', (d: Point) => d.outlier)
            .classed('farout', (d: Point) => d.farout),
        pointExit,
    };
};

const drawBoxplot = function (ctx: PlotContext, settings: BoxplotSettings, key: PointKey | undefined): void {
    const { scale, bandwidth, boxwidth, opacity } = settings;
    const orientation = orientationOf(settings);
    const { coor } = orientation;
    const renderer = pointRenderer(settings, orientation);

    // A transition has selection(); in d3 v7 so does a selection, which returns itself.
    const selection = (ctx.selection ? ctx.selection() : ctx) as PlotSelection;
    const whiskerPath = (d: Whisker) =>
        `M${coor(scale(d.start || 0), -0.5 * boxwidth)} l${coor(0, boxwidth)} ` +
        `m${coor(0, -0.5 * boxwidth)} L${coor(scale(d.end), 0)}`;
    const transform = `translate(${coor(0, bandwidth * 0.5)})`;

    let gWhisker: PlotContext = selectOrAppendGroup(selection, 'whisker', transform);
    let gBox: PlotContext = selectOrAppendGroup(selection, 'box', transform);
    let gPoint: PlotContext = selectOrAppendGroup(selection, 'point', transform);

    let whisker: PartContext<SVGPathElement, Whisker> = enterWhiskers(gWhisker, whiskerPath);
    let box: PartContext<SVGLineElement, Box> = enterBoxes(gBox, settings, orientation);
    let { point, pointExit }: Record<'point' | 'pointExit', PartContext<PointElement, Point>> = enterPoints(gPoint, settings, renderer, key);

    if (ctx !== selection) {
        gWhisker = gWhisker.transition(ctx as unknown as AnyTransition);
        gBox = gBox.transition(ctx as unknown as AnyTransition);
        gPoint = gPoint.transition(ctx as unknown as AnyTransition);
        whisker = whisker.transition(ctx as unknown as AnyTransition);
        box = box.transition(ctx as unknown as AnyTransition);
        point = point.transition(ctx as unknown as AnyTransition);
        pointExit = pointExit.transition(ctx as unknown as AnyTransition);
    }

    gWhisker.attr('transform', transform);
    gBox.attr('transform', transform);
    gPoint.attr('transform', transform);
    whisker.attr('opacity', opacity).attr('d', whiskerPath);
    updateBoxes(box, settings, orientation);
    point.call(renderer.update);
    pointExit.call(renderer.exit).remove();
};

export const boxplot = ({
    vertical = false,
    scale = scaleLinear(),
    bandwidth = 20,
    boxwidth = 20,
    showInnerDots = true,
    symbol = boxplotSymbolDot,
    opacity = 0.8,
    jitter = 0.2,
}: BoxplotOptions = {}) => {
    const settings: BoxplotSettings = { vertical, scale, bandwidth, boxwidth, showInnerDots, symbol, opacity, jitter };
    const key: PointKey | undefined = undefined;

    const boxplot = (ctx: PlotContext) => {
        drawBoxplot(ctx, settings, key);
        return this;
    };

    return boxplot;
};


export const boxplotSymbolDot = 'dot';
export const boxplotSymbolTick = 'tick';

// Adapted from https://github.com/akngs/d3-boxplot/blob/main/src/boxplot.js
export const boxplotStats= (values: number[]): BoxplotStats => {
    const fiveNums = [0.0, 0.25, 0.5, 0.75, 1.0].map((d) => quantile(values, d)) as number[];
    const iqr = fiveNums[3] - fiveNums[1];
    const step = iqr * 1.5;
    const fences = [
        { start: fiveNums[1] - step - step, end: fiveNums[1] - step },
        { start: fiveNums[1] - step, end: fiveNums[1] },
        { start: fiveNums[1], end: fiveNums[3] },
        { start: fiveNums[3], end: fiveNums[3] + step },
        { start: fiveNums[3] + step, end: fiveNums[3] + step + step },
    ];
    const boxes = [
        { start: fiveNums[1], end: fiveNums[2] },
        { start: fiveNums[2], end: fiveNums[3] },
    ];
    const whiskers = [
        { start: min(values.filter((d) => fences[1].start <= d)) || 0, end: fiveNums[1] },
        { start: max(values.filter((d) => fences[3].end >= d)) || 0, end: fiveNums[3] },
    ];
    const points = values.map((d) => ({
        value: d,
        datum: d,
        outlier: d < fences[1].start || fences[3].end < d,
        farout: d < fences[0].start || fences[4].end < d,
    }));
    return { fiveNums, iqr, step, fences, boxes, whiskers, points };
};
