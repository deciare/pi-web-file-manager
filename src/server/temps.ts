import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Temporary siblings for in-flight transfers.
 *
 * A transfer writes `.<name>.fm-<uuid>` beside its destination and publishes it
 * with a link or a rename, so a crash or a cancellation can never leave a
 * half-written file under the name the user will look at. What it can leave is
 * the temporary itself, if the process dies between the write and the publish.
 *
 * Three things keep those from accumulating:
 *
 * 1. a cancelled or failed transfer unlinks its own temporary immediately,
 * 2. listing a directory sweeps stale temporaries in it, since that is exactly
 *    where someone would next notice them, and
 * 3. a low-frequency timer sweeps the directories this daemon has written in.
 *
 * Temporaries that outlive the container are swept the first time their
 * directory is listed, which covers the case a timer cannot: the process that
 * knew about them is gone.
 */

export const TEMP_STALE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_DIRECTORIES = 64;

const TEMP_NAME = /^\..*\.fm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function tempNameFor(fileName: string): string {
  return `.${fileName}.fm-${randomUUID()}`;
}

export function isTempName(name: string): boolean {
  return TEMP_NAME.test(name);
}

const tracked = new Set<string>();

/** Remember a directory this daemon wrote into, so the timer can return to it. */
export function trackDirectory(directory: string): void {
  if (tracked.has(directory)) {
    tracked.delete(directory);
  } else if (tracked.size >= MAX_TRACKED_DIRECTORIES) {
    const oldest = tracked.values().next().value;
    if (oldest !== undefined) tracked.delete(oldest);
  }
  tracked.add(directory);
}

/** Remove stale temporaries in one directory. Returns how many were removed. */
export async function sweepDirectory(directory: string, staleMs = TEMP_STALE_MS, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isTempName(name)) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs < staleMs) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // A file removed between the listing and the unlink is already gone.
    }
  }
  return removed;
}

/** Sweep every directory written into recently. Called by the timer below. */
export async function sweepTracked(): Promise<number> {
  let removed = 0;
  for (const directory of [...tracked]) removed += await sweepDirectory(directory);
  return removed;
}

/** Start the periodic sweep; the returned function stops it. */
export function startTempSweeper(): () => void {
  const timer = setInterval(() => { void sweepTracked(); }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => { clearInterval(timer); };
}
