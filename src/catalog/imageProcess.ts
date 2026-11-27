/**
 * Remove a plain white background from product photos.
 *
 * Only white connected to the image border is removed (flood fill), so white
 * labels, caps and highlights inside the bottle stay. Edge pixels get partial
 * alpha and their white fringe is taken out of the colour, so there is no halo.
 */

const HARD = 18;  // whiteness distance treated as pure background
const SOFT = 85;  // up to this distance, edge pixels fade from transparent to opaque

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

/** Returns a new RGBA buffer with the border-connected white background made transparent. */
export function removeWhiteBackground(rgba: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(rgba);
  const n = width * height;
  const background = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  const seed = (p: number) => {
    if (background[p]) return;
    const i = p * 4;
    if (distance(rgba[i], rgba[i + 1], rgba[i + 2]) <= HARD) {
      background[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width, y = (p - x) / width;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (y > 0) seed(p - width);
    if (y < height - 1) seed(p + width);
  }

  // Edge band: light pixels within a few pixels of the background (glass rims,
  // anti-aliasing) fade out by their lightness instead of leaving white specks
  const BAND = 6;
  const depth = new Uint8Array(n);
  const ring = new Int32Array(n);
  let rh = 0, rt = 0;
  for (let p = 0; p < n; p++) if (background[p]) ring[rt++] = p;
  while (rh < rt) {
    const p = ring[rh++];
    const level = background[p] ? 0 : depth[p];
    if (level >= BAND) continue;
    const x = p % width, y = (p - x) / width;
    const visit = (q: number) => {
      if (background[q] || depth[q]) return;
      const j = q * 4;
      if (distance(rgba[j], rgba[j + 1], rgba[j + 2]) >= SOFT) return;
      depth[q] = level + 1;
      ring[rt++] = q;
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }

  const alpha = new Float32Array(n).fill(1);
  for (let p = 0; p < n; p++) {
    if (background[p]) alpha[p] = 0;
    else if (depth[p]) {
      const i = p * 4;
      alpha[p] = Math.max(0, Math.min(1, (distance(rgba[i], rgba[i + 1], rgba[i + 2]) - HARD) / (SOFT - HARD)));
    }
  }

  // Smooth the cut-out edge (3x3 average) only near the background
  const smooth = Float32Array.from(alpha);
  for (let p = 0; p < n; p++) {
    if (!background[p] && !depth[p]) continue;
    const x = p % width, y = (p - x) / width;
    let sum = 0, cnt = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      sum += alpha[yy * width + xx]; cnt++;
    }
    smooth[p] = background[p] ? Math.min(alpha[p], sum / cnt) : sum / cnt;
  }

  for (let p = 0; p < n; p++) {
    const a = smooth[p];
    if (a >= 1) continue;
    const i = p * 4;
    if (a <= 0.02) { out[i + 3] = 0; continue; }
    // Un-blend from white so edges keep their own colour (no halo)
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((rgba[i + c] - 255 * (1 - a)) / a)));
    out[i + 3] = Math.round(rgba[i + 3] * a);
  }
  return out;
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
