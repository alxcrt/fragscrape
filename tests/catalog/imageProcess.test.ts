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
