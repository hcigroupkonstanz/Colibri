// Date.now() of an instant on the performance.now() clock.
export const wallClock = function (performanceMillis: number, now: number, performanceNow: number): number {
    return Math.round(now - (performanceNow - performanceMillis));
};
