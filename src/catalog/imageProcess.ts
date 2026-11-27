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

const smoothstep = (x: number, lo: number, hi: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Turn the model's soft mask into a clean cut-out mask (one byte per pixel):
 * 1. Contrast curve: faint shadows and haze become transparent, the product solid.
 *    Clearly dark pixels are kept solid (the model can hesitate on glossy black).
 * 2. Fill holes: everything inside the bottle's outline is solid, so clear glass the
 *    model left half-transparent does not let the page background show through.
 *    "Outside" grows only from border pixels that are clearly background (transparent
 *    to the model and white in the photo), so a product cut off at the image edge
 *    (e.g. a cap touching the top) keeps its highlights.
 * 3. Soft 1 px trim of the outer edge, which removes the white fringe from the photo.
 * No colour un-mixing: dividing by small alpha values amplified JPEG noise into speckles.
 */
export function refineMatte(matte: Buffer, width: number, height: number, rgba?: Buffer): Buffer {
  const n = width * height;
  const a = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    a[p] = smoothstep(matte[p] / 255, 0.25, 0.75);
    // On a white studio background, clearly dark pixels are product even where the model
    // hesitates (glossy black caps); light shadows stay below this range
    if (rgba) a[p] = Math.max(a[p], smoothstep(distance(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]), 70, 120));
  }

  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const push = (p: number) => {
    if (!outside[p] && a[p] < 0.5) { outside[p] = 1; queue[tail++] = p; }
  };
  const seed = (p: number) => {
    if (a[p] > 0.02) return;
    if (rgba && distance(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]) > HARD) return;
    push(p);
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < n - width) push(p + width);
  }
  for (let p = 0; p < n; p++) {
    if (outside[p]) continue;
    const x = p % width;
    const edge = (x > 0 && outside[p - 1]) || (x < width - 1 && outside[p + 1])
      || (p >= width && outside[p - width]) || (p < n - width && outside[p + width]);
    // Real see-through gaps (ring caps, a stiletto arch) are white and the model is sure
    // they are background: leave those transparent
    const realGap = matte[p] < 20 && (!rgba || distance(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]) <= HARD);
    if (!edge && !realGap) a[p] = 1;
  }

  const out = Buffer.alloc(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let min = 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) min = Math.min(min, a[yy * width + xx]);
        }
      }
      out[y * width + x] = Math.round(255 * (0.5 * a[y * width + x] + 0.5 * min));
    }
  }
  return out;
}

/** Set the alpha channel of an RGBA image from a one-byte-per-pixel mask. */
export function withAlpha(rgba: Buffer, mask: Buffer): Buffer {
  const out = Buffer.from(rgba);
  for (let p = 0; p < mask.length; p++) out[p * 4 + 3] = mask[p];
  return out;
}
