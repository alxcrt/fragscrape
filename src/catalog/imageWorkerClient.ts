import { fork, ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import logger from '../utils/logger';

/**
 * Runs mask inference in a low-priority child process (see imageWorker.ts).
 * One request at a time; the worker is restarted on the next request if it dies.
 */
let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, (mask: Buffer | null) => void>();

function worker(): ChildProcess {
  if (child && child.connected) return child;
  const proc = fork(path.join(__dirname, 'imageWorker.js'), [], { serialization: 'advanced', stdio: 'inherit' });
  try {
    os.setPriority(proc.pid!, 19); // lowest: API requests always get the CPU first
  } catch (err) {
    logger.warn(`Could not lower image worker priority: ${(err as Error).message}`);
  }
  proc.on('message', (msg: { rid: number; mask: Uint8Array | null; error?: string }) => {
    if (msg.error) logger.warn(`Image worker: ${msg.error}`);
    pending.get(msg.rid)?.(msg.mask ? Buffer.from(msg.mask) : null);
    pending.delete(msg.rid);
  });
  proc.on('exit', (code, signal) => {
    logger.warn(`Image worker exited (${signal ?? code}); it restarts on the next job`);
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    if (child === proc) child = null;
  });
  child = proc;
  return proc;
}

/** Alpha mask (one byte per pixel) at width x height, or null on failure. */
export function matteInWorker(image: Buffer, width: number, height: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const rid = nextId++;
    pending.set(rid, resolve);
    worker().send({ rid, image, width, height });
  });
}

export function stopImageWorker(): void {
  child?.kill();
  child = null;
}
