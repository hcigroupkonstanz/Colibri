/** Makes a name safe as a file name part: runs of characters other than ASCII letters, digits, dots, dashes and underscores become '_'. Cut to 64 characters. */
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
    // Revoke only after the click has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
