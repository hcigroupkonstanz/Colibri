// Sorts `values` in place.
export const median = function (values: number[]): number {
    values.sort((a, b) => a - b);
    const middle = values.length >> 1;
    return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
};
