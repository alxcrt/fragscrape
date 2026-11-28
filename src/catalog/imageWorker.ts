/**
 * Child process that runs the background-removal model. Kept separate (and at
 * the lowest CPU priority) so inference never slows down API requests, and so a
 * model crash or memory spike only takes this worker down.
 */
import { matte } from './imageAi';

interface Request { rid: number; image: Uint8Array; width: number; height: number }

process.on('message', async (msg: Request) => {
  try {
    const mask = await matte(Buffer.from(msg.image), msg.width, msg.height);
    process.send?.({ rid: msg.rid, mask });
  } catch (err) {
    process.send?.({ rid: msg.rid, mask: null, error: (err as Error).message });
  }
});
