/**
 * Clear-glass repair for the AI cut-out mask.
 *
 * On white studio photos, clear glass is as white as the background behind it, so the
 * model sometimes leaves part of a bottle wall out: the page background then shows
 * through a "bite" between the faint outer glass outline and the bottle body.
 *
 * Pixel colour cannot tell such a bite from a real see-through gap (the inside of a ring
 * cap, a stiletto arch): both are pure white in the photo and transparent to the model.
 * What differs is the material around them:
 * - bites are surrounded by clear glass, which is light in the photo;
 * - real gaps are framed by metal, plastic or coloured glass.
 *
 * The model also hesitates at real gaps, so a hole is filled only when it looks like a bite:
 * - completely surrounded by the product (after sealing hairline cracks in the outline);
 * - showing the photo's white background (dark or coloured details are left alone);
 * - a sliver: not tiny (mesh, filigree) and not wide (the space between two parts);
 * - framed mostly by light, colourless pixels, i.e. clear glass. Real gaps are framed by
 *   metal, gold, ribbon or tinted glass.
 * Thresholds scale with the product's size and were checked on 794 catalog cut-outs.
 */

const BG_TOLERANCE = 8; // max channel difference from the photo's background colour
const LIGHT = 200; // luminance of "light" product pixels (clear glass, white labels)
const NEUTRAL = 20; // max channel spread of colourless pixels
const WHITE_SHARE = 0.25; // share of background-coloured pixels for a hole to be see-through
const LIGHT_SHARE = 0.35; // share of light pixels around a region for it to count as glass
const MIN_THICK = 0.0085; // share of the product's size: thinner holes (mesh, filigree, corners) stay as the model drew them
const MAX_THICK = 0.026; // share of the product's size: wider white regions are real gaps between parts
const SEAL = 0.006; // share of the product's size: outline breaks up to ~2x this are sealed

function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(r, width); x++) count += mask[row + x];
    for (let x = 0; x < width; x++) {
      if (x + r < width) count += mask[row + x + r];
      if (x - r - 1 >= 0) count -= mask[row + x - r - 1];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y++) count += tmp[y * width + x];
    for (let y = 0; y < height; y++) {
      if (y + r < height) count += tmp[(y + r) * width + x];
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * width + x];
      out[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

/** Median colour of the image border. */
function borderColour(rgba: Buffer, width: number, height: number): [number, number, number] {
  const ch: number[][] = [[], [], []];
  const add = (p: number) => { for (let c = 0; c < 3; c++) ch[c].push(rgba[p * 4 + c]); };
  for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { add(y * width); add(y * width + width - 1); }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
}

/** Flood from the image border over pixels accepted by `open`. */
function floodFromBorder(width: number, height: number, open: (p: number) => boolean, queue: Int32Array): Uint8Array {
  const n = width * height;
  const seen = new Uint8Array(n);
  let head = 0, tail = 0;
  const push = (p: number) => { if (!seen[p] && open(p)) { seen[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < n - width) push(p + width);
  }
  return seen;
}

/** 4-connected regions of `mask`, each as a list of pixel indices. */
function regions(mask: Uint8Array, width: number, queue: Int32Array): number[][] {
  const n = mask.length;
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    let head = 0, tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width;
      comp.push(p);
      const visit = (q: number) => { if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } };
      if (x > 0) visit(p - 1);
      if (x < width - 1) visit(p + 1);
      if (p >= width) visit(p - width);
      if (p < n - width) visit(p + width);
    }
    out.push(comp);
  }
  return out;
}

/** Largest distance (in px, city-block) from a region pixel to the region's border. */
function thickness(comp: number[], width: number, height: number): number {
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (const p of comp) {
    const x = p % width, y = (p / width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = maxX - minX + 3, h = maxY - minY + 3;
  const d = new Uint16Array(w * h);
  for (const p of comp) d[((p / width | 0) - minY + 1) * w + (p % width) - minX + 1] = 65535;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (d[i]) d[i] = Math.min(d[i], d[i - 1] + 1, d[i - w] + 1);
  }
  let max = 0;
  for (let y = h - 2; y > 0; y--) for (let x = w - 2; x > 0; x--) {
    const i = y * w + x;
    if (d[i]) { d[i] = Math.min(d[i], d[i + 1] + 1, d[i + w] + 1); if (d[i] > max) max = d[i]; }
  }
  return max;
}

/** Share of light pixels among the product pixels within `r` px of the region. */
function lightShareAround(comp: number[], product: Uint8Array, rgba: Buffer, width: number, height: number, r: number): number {
  const counted = new Set<number>();
  let light = 0;
  for (const p of comp) {
    const x = p % width, y = (p / width) | 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const k = yy * width + xx;
        if (!product[k] || counted.has(k)) continue;
        counted.add(k);
        const r0 = rgba[k * 4], g0 = rgba[k * 4 + 1], b0 = rgba[k * 4 + 2];
        // clear glass is light and colourless; gold, ribbons and tinted glass are not
        if (r0 * 0.299 + g0 * 0.587 + b0 * 0.114 >= LIGHT && Math.max(r0, g0, b0) - Math.min(r0, g0, b0) <= NEUTRAL) light++;
      }
    }
  }
  return counted.size ? light / counted.size : 0;
}

/**
 * Returns a copy of the model's mask with clear-glass bites made opaque.
 * `rgba` is the photo at the mask's size. Photos without a uniform light background
 * are returned unchanged.
 */
export function sealGlass(matte: Buffer, width: number, height: number, rgba: Buffer): Buffer {
  const n = width * height;
  const bg = borderColour(rgba, width, height);
  if (Math.min(...bg) < 230) return matte; // not a white studio shot

  const scale = Math.max(width, height) / 720;
  const around = Math.max(2, Math.round(3 * scale));

  const product = new Uint8Array(n);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let p = 0; p < n; p++) {
    if (matte[p] < 128) continue;
    product[p] = 1;
    const x = p % width, y = (p / width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return matte;
  // Real gaps between parts scale with the product, not the photo
  const size = Math.max(maxX - minX, maxY - minY);
  const maxThick = Math.round(MAX_THICK * size);
  const minThick = Math.max(2, Math.round(MIN_THICK * size));
  const bgLike = (p: number) => Math.max(
    Math.abs(rgba[p * 4] - bg[0]), Math.abs(rgba[p * 4 + 1] - bg[1]), Math.abs(rgba[p * 4 + 2] - bg[2]),
  ) <= BG_TOLERANCE;

  const queue = new Int32Array(n);
  // Holes: parts the model left out that are surrounded by the product. A small closing
  // first seals hairline breaks in faint glass outlines, so a bite that leaks out through
  // a crack still counts as enclosed.
  const seal = Math.max(1, Math.round(SEAL * size));
  const sealed = invert(dilate(invert(dilate(product, width, height, seal)), width, height, seal));
  const outside = floodFromBorder(width, height, (p) => !sealed[p], queue);
  const holes = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (!product[p] && !outside[p]) holes[p] = 1;

  const out = Buffer.from(matte);
  const filled = new Uint8Array(n);
  for (const hole of regions(holes, width, queue)) {
    // A gap you can see through shows the photo's background colour; a hole without any
    // is just a dark or coloured detail the model was unsure about, and stays as it is
    let white = 0;
    for (const p of hole) if (bgLike(p)) white++;
    if (white < hole.length * WHITE_SHARE) continue;
    const t = thickness(hole, width, height);
    if (t < minThick || t > maxThick) continue;
    if (lightShareAround(hole, product, rgba, width, height, around) >= LIGHT_SHARE) for (const p of hole) filled[p] = 1;
  }
  // Also make the model's half-transparent rim around a filled hole opaque, so no faint
  // ring is left where the hole was
  const rim = dilate(filled, width, height, around);
  for (let p = 0; p < n; p++) if (filled[p] || (rim[p] && (product[p] || !outside[p]))) out[p] = 255;
  return out;
}
