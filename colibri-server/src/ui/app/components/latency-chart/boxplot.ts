/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable prefer-const */
import { max, min, quantile } from 'd3';
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

export const boxplot = (
    vertical = false,
    scale = scaleLinear(),
    bandwidth = 20,
    boxwidth = 20,
    showInnerDots = true,
    symbol = boxplotSymbolDot,
    opacity = 0.8,
    jitter = 0.2,
) => {
    let key: any = undefined;

    const boxplot = (ctx: any) => {
        const x = vertical ? 'y' : 'x';
        const y = vertical ? 'x' : 'y';
        const h = vertical ? 'width' : 'height';
        const coor = vertical ? (x: number, y: number) => [y, x] : (x: number, y: number) => [x, y];
        const inversed = scale.range()[0] > scale.range()[1];

        const renderers: any = {};
        renderers[boxplotSymbolDot] = {
            nodeName: 'circle',
            enter: function (ctx: any) {
                ctx
                    .attr('fill', 'currentColor')
                    .attr('stroke', 'none')
                    .attr('opacity', 0)
                    .attr('r', 0)
                    .attr(`c${x}`, (d: Point) => scale(d.value))
                    .attr(`c${y}`, jitterer);
            },
            update: function (ctx: any) {
                ctx
                    .attr('opacity', opacity)
                    .attr('r', (d: Point) => (d.farout ? r * 1.5 : r))
                    .attr(`c${x}`, (d: Point) => scale(d.value))
                    .attr(`c${y}`, jitterer);
            },
            exit: function (context: any) {
                context.attr('opacity', 0).attr('r', 0);
            },
        };

        renderers[boxplotSymbolTick] = {
            nodeName: 'line',
            enter: function (ctx: any) {
                ctx
                    .attr('stroke', 'currentColor')
                    .attr('opacity', 0)
                    .attr(`${x}1`, (d: Point) => scale(d.value))
                    .attr(`${x}2`, (d: Point) => scale(d.value))
                    .attr(`${y}1`, 0)
                    .attr(`${y}2`, 0);
            },
            update: function (ctx: any) {
                ctx
                    .attr('opacity', opacity)
                    .attr(`${x}1`, (d: Point) => scale(d.value))
                    .attr(`${x}2`, (d: Point) => scale(d.value))
                    .attr(`${y}1`, Math.min(-2, boxwidth * -0.25))
                    .attr(`${y}2`, Math.max(2, boxwidth * 0.25));
            },
            exit: function (ctx: any) {
                ctx.attr('opacity', 0).attr(`${y}1`, 0).attr(`${y}2`, 0);
            },
        };
        const renderer = renderers[symbol];

        const selection = ctx.selection ? ctx.selection() : ctx;
        const whiskerPath = (d: Whisker) =>
            `M${coor(scale(d.start || 0), -0.5 * boxwidth)} l${coor(0, boxwidth)} ` +
            `m${coor(0, -0.5 * boxwidth)} L${coor(scale(d.end), 0)}`;
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

        let gWhisker = selection.select('g.whisker');
        if (gWhisker.empty())
            gWhisker = selection
                .append('g')
                .attr('class', 'whisker')
                .attr('transform', `translate(${coor(0, bandwidth * 0.5)})`);

        let gBox = selection.select('g.box');
        if (gBox.empty())
            gBox = selection
                .append('g')
                .attr('class', 'box')
                .attr('transform', `translate(${coor(0, bandwidth * 0.5)})`);

        let gPoint = selection.select('g.point');
        if (gPoint.empty())
            gPoint = selection
                .append('g')
                .attr('class', 'point')
                .attr('transform', `translate(${coor(0, bandwidth * 0.5)})`);

        let whisker = gWhisker.selectAll('path').data((d: BoxplotStats) => d.whiskers);
        whisker = whisker
            .enter()
            .append('path')
            .attr('fill', 'none')
            .attr('stroke', 'currentColor')
            .attr('opacity', 0)
            .attr('d', whiskerPath)
            .merge(whisker);

        let box = gBox.selectAll('line').data((d: BoxplotStats) => d.boxes);
        box = box
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

        // Remove old symbols
        gPoint
            .selectAll('.point')
            // .filter(function () {
            //     return this.nodeName !== renderer.nodeName:
            // })
            .remove();

        let point = gPoint
            .selectAll('.point')
            .data(
                (d: BoxplotStats) => (showInnerDots ? d.points : d.points.filter((d2: Point) => d2.outlier)),
                key ? (d: Point) => key(d.datum) : undefined
            );
        let pointExit = point.exit();
        point = point
            .enter()
            .append(renderer.nodeName)
            .attr('class', 'point')
            .call(renderer.enter)
            .merge(point)
            .classed('outlier', (d: Point) => d.outlier)
            .classed('farout', (d: Point) => d.farout);

        if (ctx !== selection) {
            gWhisker = gWhisker.transition(ctx);
            gBox = gBox.transition(ctx);
            gPoint = gPoint.transition(ctx);
            whisker = whisker.transition(ctx);
            box = box.transition(ctx);
            point = point.transition(ctx);
            pointExit = pointExit.transition(ctx);
        }

        gWhisker.attr('transform', `translate(${coor(0, bandwidth * 0.5)})`);
        gBox.attr('transform', `translate(${coor(0, bandwidth * 0.5)})`);
        gPoint.attr('transform', `translate(${coor(0, bandwidth * 0.5)})`);
        whisker.attr('opacity', opacity).attr('d', whiskerPath);
        box
            .attr('opacity', opacity)
            .attr('stroke-width', boxwidth)
            .attr(`${x}1`, (d: Box, i: number) => scale(d.start) + (i === 0 ? 0 : 0.5) * (inversed ? -1 : +1))
            .attr(`${x}2`, (d: Box, i: number) => scale(d.end) - (i === 0 ? 0.5 : 0) * (inversed ? -1 : +1))
            .attr(`${y}1`, 0)
            .attr(`${y}2`, 0);
        point.call(renderer.update);
        pointExit.call(renderer.exit).remove();

        return this;
    };

    // boxplot.vertical = (..._) => (_.length ? ((vertical = _[0]), boxplot) : vertical)
    // boxplot.scale = (..._) => (_.length ? ((scale = _[0]), boxplot) : scale)
    // boxplot.showInnerDots = (..._) => (_.length ? ((showInnerDots = _[0]), boxplot) : showInnerDots)
    // boxplot.bandwidth = (..._) => (_.length ? ((bandwidth = _[0]), boxplot) : bandwidth)
    // boxplot.boxwidth = (..._) => (_.length ? ((boxwidth = _[0]), boxplot) : boxwidth)
    // boxplot.symbol = (..._) => (_.length ? ((symbol = _[0]), boxplot) : symbol)
    // boxplot.opacity = (..._) => (_.length ? ((opacity = _[0]), boxplot) : opacity)
    // boxplot.jitter = (..._) => (_.length ? ((jitter = _[0]), boxplot) : jitter)
    // boxplot.key = (..._) => (_.length ? ((key = _[0]), boxplot) : key)

    return boxplot;
};

// export function boxplotStats(data, valueof) {
//     const values = valueof ? data.map(valueof) : data
//     const fiveNums = [0.0, 0.25, 0.5, 0.75, 1.0].map((d) => quantile(values, d))
//     const iqr = fiveNums[3] - fiveNums[1]
//     const step = iqr * 1.5
//     const fences = [
//         { start: fiveNums[1] - step - step, end: fiveNums[1] - step },
//         { start: fiveNums[1] - step, end: fiveNums[1] },
//         { start: fiveNums[1], end: fiveNums[3] },
//         { start: fiveNums[3], end: fiveNums[3] + step },
//         { start: fiveNums[3] + step, end: fiveNums[3] + step + step },
//     ]
//     const boxes = [
//         { start: fiveNums[1], end: fiveNums[2] },
//         { start: fiveNums[2], end: fiveNums[3] },
//     ]
//     const whiskers = [
//         { start: min(values.filter((d) => fences[1].start <= d)), end: fiveNums[1] },
//         { start: max(values.filter((d) => fences[3].end >= d)), end: fiveNums[3] },
//     ]
//     const points = values.map((d, i) => ({
//         value: d,
//         datum: data[i],
//         outlier: d < fences[1].start || fences[3].end < d,
//         farout: d < fences[0].start || fences[4].end < d,
//     }))
//     return { fiveNums, iqr, step, fences, boxes, whiskers, points }
// }

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
