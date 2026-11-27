import { removeWhiteBackground, whiteBorderRatio } from '../../src/catalog/imageProcess';

/** 20x20 white image with a red 10x10 square holding a white 4x4 centre (like a label). */
function bottle(): Buffer {
  const w = 20, buf = Buffer.alloc(w * w * 4, 255);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) {
    const i = (y * w + x) * 4;
    const label = x >= 8 && x < 12 && y >= 8 && y < 12;
    buf[i] = 255; buf[i + 1] = label ? 255 : 0; buf[i + 2] = label ? 255 : 0;
  }
  return buf;
}
const alphaAt = (b: Buffer, x: number, y: number) => b[(y * 20 + x) * 4 + 3];

describe('removeWhiteBackground', () => {
  it('detects white borders', () => {
    expect(whiteBorderRatio(bottle(), 20, 20)).toBe(1);
  });

  it('makes the outer background transparent and keeps the product', () => {
    const out = removeWhiteBackground(bottle(), 20, 20);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 2, 17)).toBe(0);
    expect(alphaAt(out, 6, 6)).toBe(255);
  });

  it('keeps white enclosed by the product', () => {
    const out = removeWhiteBackground(bottle(), 20, 20);
    expect(alphaAt(out, 9, 9)).toBe(255);
  });

  it('fades light edge pixels without a white halo', () => {
    const img = bottle();
    const i = (5 * 20 + 10) * 4; // top edge of the square, made light pink
    img[i] = 255; img[i + 1] = 215; img[i + 2] = 215;
    const out = removeWhiteBackground(img, 20, 20);
    expect(out[i + 3]).toBeGreaterThan(0);
    expect(out[i + 3]).toBeLessThan(255);
    expect(out[i + 1]).toBeLessThan(215); // white fringe removed from the colour
  });
});

describe('applyMatte', () => {
  const { applyMatte } = require('../../src/catalog/imageProcess');
  it('uses the matte as alpha and removes white fringes', () => {
    const rgba = Buffer.from([255, 255, 255, 255, 200, 100, 100, 255, 255, 0, 0, 255]);
    const out: Buffer = applyMatte(rgba, Buffer.from([0, 128, 255]));
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(128);
    expect(out[5]).toBeLessThan(100);
    expect(out[11]).toBe(255);
  });
});
