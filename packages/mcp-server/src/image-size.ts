/** Pixel size and format of PNG, JPEG and GIF images (the formats Figma accepts), from their headers. */
export interface ImageInfo {
  format: 'PNG' | 'JPEG' | 'GIF';
  width: number;
  height: number;
}

export function imageInfo(b: Uint8Array): ImageInfo | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: signature, then the IHDR chunk with width and height (big endian).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { format: 'PNG', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF: "GIF87a"/"GIF89a", then the logical screen size (little endian).
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { format: 'GIF', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG: walk the markers to the first start-of-frame segment.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { format: 'JPEG', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}
