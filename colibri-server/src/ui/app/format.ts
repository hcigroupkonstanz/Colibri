// How the admin pages write durations, sizes and rates.

/** 45 s, 12 min, 2 h 5 min, 3 d 4 h: the two largest units, the second left out at 0. */
export const duration = function (seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
    const d = Math.floor(h / 24);
    return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
};

/** A size in bytes as B, KiB or MiB, with one decimal below 10. */
export const bytes = function (value: number): string {
    if (value < 1024) return `${value} B`;
    const units = [ 'KiB', 'MiB', 'GiB' ];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${size < 10 ? size.toFixed(1).replace(/\.0$/, '') : Math.round(size)} ${units[unit]}`;
};

/** 1234567 as 1,234,567. */
export const count = function (value: number): string {
    return value.toLocaleString('en-US');
};

/** A rate or latency with one decimal, or a dash for none. */
export const decimal = function (value: number | null): string {
    return value === null ? '-' : value.toFixed(1);
};

/** A file name part made of the name: letters, digits, dots, dashes and underscores. */
export const fileNamePart = function (name: string): string {
    return name.replace(/[^\w.-]+/g, '_').slice(0, 64);
};

/** Offers a text for download under a file name. Unlike the clipboard, this works over plain HTTP. */
export const download = function (name: string, text: string, type: string): void {
    const url = URL.createObjectURL(new Blob([ text ], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // after the click has started the download
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
