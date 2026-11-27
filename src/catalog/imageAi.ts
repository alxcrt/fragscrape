import fs from 'fs';
import sharp from 'sharp';
import logger from '../utils/logger';

/**
 * AI background removal (salient object segmentation) with ONNX Runtime.
 * Default model: ISNet general-use (Apache-2.0): kept whole bottles (stoppers,
 * clear glass) best in our tests, ~1.5 s per image, ~1.5 GB RAM.
 * BG_MODEL=birefnet uses BiRefNet (MIT): crisper edges but cut some glass,
 * ~5x slower and ~7-10 GB RAM, so it is not the default.
 */
interface ModelConfig { file: string; mean: number[]; std: number[]; sigmoid: boolean }

const MODELS: Record<string, ModelConfig> = {
  isnet: { file: 'isnet-general-use.onnx', mean: [0.5, 0.5, 0.5], std: [1, 1, 1], sigmoid: false },
  birefnet: { file: 'BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], sigmoid: true },
};
const SIZE = 1024;

type Ort = typeof import('onnxruntime-node');
let ort: Ort | null = null;
let session: import('onnxruntime-node').InferenceSession | null = null;
let loading: Promise<void> | null = null;
let unavailable = false;
const modelName = process.env.BG_MODEL === 'birefnet' ? 'birefnet' : 'isnet';
const model = MODELS[modelName];

async function load(): Promise<void> {
  const dir = process.env.BG_MODEL_DIR || '/app/models';
  const file = `${dir}/${model.file}`;
  if (!fs.existsSync(file)) {
    unavailable = true;
    logger.warn(`Background model not found at ${file}; using edge-based background removal`);
    return;
  }
  try {
    ort = await import('onnxruntime-node');
    session = await ort.InferenceSession.create(file, {
      intraOpNumThreads: parseInt(process.env.BG_MODEL_THREADS || '2', 10),
      graphOptimizationLevel: 'all',
    });
    logger.info(`Background model loaded: ${modelName}`);
  } catch (err) {
    unavailable = true;
    logger.warn(`Could not load background model: ${(err as Error).message}`);
  }
}

export function aiAvailable(): boolean {
  return !unavailable;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Alpha matte (one byte per pixel) for an image at the given output size,
 * or null when the model is unavailable. Runs one inference at a time.
 */
export async function matte(image: Buffer, width: number, height: number): Promise<Buffer | null> {
  if (unavailable) return null;
  if (!session) {
    loading ??= load();
    await loading;
    if (!session || !ort) return null;
  }
  const run = async (): Promise<Buffer> => {
    const raw = await sharp(image).removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer();
    const input = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      for (let c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = (raw[i * 3 + c] / 255 - model.mean[c]) / model.std[c];
    }
    const out = await session!.run({ [session!.inputNames[0]]: new ort!.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const pred = out[session!.outputNames[0]].data as Float32Array;
    let min = Infinity, max = -Infinity;
    const values = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < values.length; i++) {
      const v = model.sigmoid ? 1 / (1 + Math.exp(-pred[i])) : pred[i];
      values[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    const mask = Buffer.alloc(SIZE * SIZE);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.round(((values[i] - min) / range) * 255);
    return sharp(mask, { raw: { width: SIZE, height: SIZE, channels: 1 } })
      .resize(width, height, { fit: 'fill' })
      .extractChannel(0)
      .raw()
      .toBuffer();
  };
  const task = chain.then(run, run);
  chain = task.catch(() => undefined);
  try {
    return await task;
  } catch (err) {
    logger.warn(`Background model failed: ${(err as Error).message}`);
    return null;
  }
}
