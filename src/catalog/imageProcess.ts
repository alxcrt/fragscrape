/**
 * Helpers for cutting products out of white studio photos. The cut-out mask
 * itself comes from the AI model (imageAi.ts).
 */

const HARD = 18; // whiteness distance treated as background white

/** Distance from white for an RGB pixel, ignoring slight tints from JPEG noise. */
function distance(r: number, g: number, b: number): number {
  return 255 - Math.min(r, g, b);
}

/** Share of border pixels that are near-white: only those images get their background removed. */
export function whiteBorderRatio(rgba: Buffer, width: number, height: number): number {
  let white = 0, total = 0;
  const check = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    total++;
    if (distance(rgba[i], rgba[i + 1], rgba[i + 2]) <= HARD && rgba[i + 3] > 0) white++;
  };
  for (let x = 0; x < width; x++) { check(x, 0); check(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { check(0, y); check(width - 1, y); }
  return total ? white / total : 0;
}

/**
 * Apply an alpha matte (0-255 per pixel) to an RGBA image on a white background,
 * removing the white that bled into semi-transparent edge pixels.
 */
export function applyMatte(rgba: Buffer, matte: Buffer): Buffer {
  const out = Buffer.from(rgba);
  for (let p = 0, i = 0; p < matte.length; p++, i += 4) {
    const a = matte[p] / 255;
    if (a >= 0.999) continue;
    if (a <= 0.02) { out[i + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((rgba[i + c] - 255 * (1 - a)) / a)));
    out[i + 3] = Math.round(rgba[i + 3] * a);
  }
  return out;
}
