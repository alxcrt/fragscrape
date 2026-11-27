import { whiteBorderRatio } from '../../src/catalog/imageProcess';

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

describe('whiteBorderRatio', () => {
  it('detects white studio backgrounds', () => {
    expect(whiteBorderRatio(bottle(), 20, 20)).toBe(1);
  });

  it('rejects photos with coloured backgrounds', () => {
    expect(whiteBorderRatio(Buffer.alloc(20 * 20 * 4, 40), 20, 20)).toBe(0);
  });
});

describe('refineMatte', () => {
  const { refineMatte, withAlpha } = require('../../src/catalog/imageProcess');
  // 12x12 mask: outer ring background, solid bottle with a half-transparent "glass" hole in the middle
  const w = 12;
  const mask = Buffer.alloc(w * w, 0);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) mask[y * w + x] = 255;
  for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) mask[y * w + x] = 90;
  mask[0] = 40; // faint shadow
  const out: Buffer = refineMatte(mask, w, w);

  it('removes faint shadows', () => {
    expect(out[0]).toBe(0);
  });

  it('fills half-transparent holes inside the product', () => {
    expect(out[5 * w + 5]).toBe(255);
  });

  it('keeps the product solid and softens only the outer edge', () => {
    expect(out[4 * w + 4]).toBe(255);
    expect(out[2 * w + 5]).toBeGreaterThan(0);
    expect(out[2 * w + 5]).toBeLessThan(255);
  });

  it('keeps highlights in a product cut off at the image edge', () => {
    // dark cap touching the top edge, with a light highlight stripe the model left half-transparent
    const cw = 10, img = Buffer.alloc(cw * cw * 4, 255), m = Buffer.alloc(cw * cw, 0);
    for (let y = 0; y < 6; y++) for (let x = 3; x < 7; x++) {
      const i = (y * cw + x) * 4;
      const stripe = x === 5 && y < 5; // highlight ends inside the cap
      img[i] = img[i + 1] = img[i + 2] = stripe ? 200 : 10;
      m[y * cw + x] = stripe ? 60 : 255;
    }
    const res: Buffer = refineMatte(m, cw, cw, img);
    expect(res[0 * cw + 5]).toBe(255);
    expect(res[3 * cw + 5]).toBe(255);
    expect(res[9 * cw + 0]).toBe(0);
  });

  it('keeps real see-through gaps inside the product transparent', () => {
    const cw = 10, img = Buffer.alloc(cw * cw * 4, 255), m = Buffer.alloc(cw * cw, 0);
    for (let y = 1; y < 9; y++) for (let x = 1; x < 9; x++) {
      const hole = x >= 4 && x < 6 && y >= 4 && y < 6;
      const i = (y * cw + x) * 4;
      if (!hole) { img[i] = img[i + 1] = img[i + 2] = 30; m[y * cw + x] = 255; }
    }
    expect(refineMatte(m, cw, cw, img)[4 * cw + 4]).toBe(0);
  });

  it('keeps dark product pixels the model hesitated on', () => {
    const cw = 6, img = Buffer.alloc(cw * cw * 4, 255), m = Buffer.alloc(cw * cw, 0);
    const i = (2 * cw + 2) * 4;
    img[i] = img[i + 1] = img[i + 2] = 20;
    m[2 * cw + 2] = 90;
    expect(refineMatte(m, cw, cw, img)[2 * cw + 2]).toBeGreaterThan(100);
  });

  it('applies the mask as alpha without changing colours', () => {
    const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
    expect([...withAlpha(rgba, Buffer.from([0, 128]))]).toEqual([10, 20, 30, 0, 40, 50, 60, 128]);
  });
});
