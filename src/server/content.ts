import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { ChannelOpenContext, Json, PeerChannel } from "./pluginApi.ts";
import type { ContentRequestFrame } from "../shared/protocol.ts";
import { CONTENT_CHUNK_BYTES } from "../shared/protocol.ts";
import { absolutePath, singleName } from "./paths.ts";
import { Failure, invalid } from "./failure.ts";
import { createTempSibling, publishNew, replaceFile } from "./fsOps.ts";

/**
 * Chunked content transfer in the browser-to-server direction.
 *
 * Content never travels through `request`: its input cap is 256 KiB, which a
 * single photograph exceeds. A channel carries one bounded JSON frame at a
 * time, so the same code serves a 2 MiB editor save and a multi-gigabyte
 * upload, and both can report progress and be cancelled.
 *
 * Everything is written to a temporary sibling and published with a rename, so
 * a failed or cancelled transfer never leaves a half-written file where the
 * user expects a whole one.
 */

/** How often progress is reported. Frequent enough to feel live, rare enough to be cheap. */
const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_INTERVAL_BYTES = 2 * 1024 * 1024;

interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ path: string; size: number; mtimeMs: number }>;
  abort(): Promise<void>;
}

export interface UploadOpenInput {
  readonly path: string;
  readonly name: string;
  readonly size?: number;
  readonly overwrite?: boolean;
}

export function parseUploadOpen(input: unknown): UploadOpenInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("Upload input must be an object");
  const record = input as Record<string, unknown>;
  const path = absolutePath(record["path"], "destination");
  const name = singleName(record["name"]);
  const size = record["size"];
  if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)) throw invalid("size must be a non-negative integer");
  const overwrite = record["overwrite"];
  if (overwrite !== undefined && typeof overwrite !== "boolean") throw invalid("overwrite must be a boolean");
  return {
    path, name,
    ...(size === undefined ? {} : { size }),
    ...(overwrite === undefined ? {} : { overwrite }),
  };
}

export interface SaveOpenInput {
  readonly path: string;
  readonly expectedMtimeMs: number | null;
  readonly force?: boolean;
}

export function parseSaveOpen(input: unknown): SaveOpenInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("Save input must be an object");
  const record = input as Record<string, unknown>;
  const path = absolutePath(record["path"]);
  const expected = record["expectedMtimeMs"];
  if (expected !== null && (typeof expected !== "number" || !Number.isFinite(expected))) {
    throw invalid("expectedMtimeMs must be a number or null");
  }
  const force = record["force"];
  if (force !== undefined && typeof force !== "boolean") throw invalid("force must be a boolean");
  return force === undefined ? { path, expectedMtimeMs: expected as number | null } : { path, expectedMtimeMs: expected as number | null, force };
}

function isFrame(value: unknown): value is ContentRequestFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] === "end") return true;
  return record["type"] === "chunk" && typeof record["data"] === "string";
}

/** Strict base64, so a truncated frame is an error rather than a short write. */
export function decodeChunk(data: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) throw invalid("Chunk is not valid base64");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > CONTENT_CHUNK_BYTES) throw invalid("Chunk is larger than one frame allows");
  return bytes;
}

class TempFileSink implements Sink {
  readonly #handle: FileHandle;
  readonly #temp: string;
  readonly #finalPath: string;
  readonly #publish: (temp: string, finalPath: string) => Promise<void>;
  #finished = false;

  constructor(handle: FileHandle, temp: string, finalPath: string, publish: (temp: string, finalPath: string) => Promise<void>) {
    this.#handle = handle;
    this.#temp = temp;
    this.#finalPath = finalPath;
    this.#publish = publish;
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.#handle.write(chunk);
  }

  async finish(): Promise<{ path: string; size: number; mtimeMs: number }> {
    await this.#handle.close();
    try {
      await this.#publish(this.#temp, this.#finalPath);
    } catch (error) {
      await unlink(this.#temp).catch(() => undefined);
      this.#finished = true;
      throw error;
    }
    this.#finished = true;
    const info = await lstat(this.#finalPath);
    return { path: this.#finalPath, size: info.size, mtimeMs: info.mtimeMs };
  }

  async abort(): Promise<void> {
    if (this.#finished) return;
    await this.#handle.close().catch(() => undefined);
    await unlink(this.#temp).catch(() => undefined);
  }
}

async function prepareUpload(open: UploadOpenInput): Promise<Sink> {
  const finalPath = join(open.path, open.name);
  const existing = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
  if (existing?.isDirectory() === true) throw new Failure("EISDIR", "A directory has that name", finalPath);
  if (existing !== undefined && open.overwrite !== true) {
    throw new Failure("EEXIST", "A file with that name already exists", finalPath);
  }
  const { temp, handle } = await createTempSibling(finalPath);
  // Replacing keeps the destination's permissions, exactly as a save does.
  const publish = existing === undefined
    ? publishNew
    : (from: string, to: string) => replaceFile(from, to, existing.mode);
  return new TempFileSink(handle, temp, finalPath, publish);
}

async function prepareSave(open: SaveOpenInput): Promise<Sink> {
  const existing = await lstat(open.path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
  // `force` is the user answering "save anyway" after seeing the conflict; it
  // skips the comparison, never the check that the destination is a file.
  if (open.force !== true) {
    if (open.expectedMtimeMs === null) {
      if (existing !== undefined) throw new Failure("ECONFLICT", "The file exists but was opened as a new file", open.path);
    } else if (existing === undefined) {
      throw new Failure("ECONFLICT", "The file was removed since it was opened", open.path);
    } else if (Math.abs(existing.mtimeMs - open.expectedMtimeMs) > 1) {
      throw new Failure("ECONFLICT", "The file changed on disk since it was opened", open.path);
    }
  }
  if (existing?.isDirectory() === true) throw new Failure("EISDIR", "Cannot save over a directory", open.path);
  const mode = existing === undefined ? 0o666 : existing.mode;
  const { temp, handle } = await createTempSibling(open.path);
  return new TempFileSink(handle, temp, open.path, (from, to) => replaceFile(from, to, mode));
}

function send(context: ChannelOpenContext, frame: Json): void {
  context.send(frame);
}

function sendError(context: ChannelOpenContext, error: unknown): void {
  const code = error instanceof Failure ? error.code : "EUNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  try {
    send(context, { type: "error", code, message });
  } catch {
    // The channel is already gone; the host reports the close.
  }
}

function buildChannel(context: ChannelOpenContext, prepare: () => Promise<Sink>): PeerChannel {
  const ready = prepare();
  let finished = false;
  let failed = false;
  let received = 0;
  let lastProgressAt = Date.now();
  let lastProgressBytes = 0;
  let queue: Promise<void> = Promise.resolve();

  // A rejected `ready` is reported once, as an error frame, then left alone:
  // every queued frame simply aborts the sink it never created.
  ready.catch((error: unknown) => {
    failed = true;
    sendError(context, error);
  });

  function maybeProgress(): void {
    const now = Date.now();
    if (received - lastProgressBytes < PROGRESS_INTERVAL_BYTES && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    lastProgressBytes = received;
    send(context, { type: "progress", received });
  }

  async function processChunk(frame: { data: string }): Promise<void> {
    const sink = await ready;
    const chunk = decodeChunk(frame.data);
    await sink.write(chunk);
    received += chunk.length;
    maybeProgress();
  }

  async function processEnd(): Promise<void> {
    const sink = await ready;
    const result = await sink.finish();
    finished = true;
    send(context, { type: "done", ...result });
  }

  return {
    receive(data: Json, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (finished || failed) return queue;
      if (!isFrame(data)) {
        failed = true;
        sendError(context, invalid("Unrecognised content frame"));
        return queue;
      }
      const frame = data;
      queue = queue
        .then(() => (frame.type === "chunk" ? processChunk(frame) : processEnd()))
        .catch(async (error: unknown) => {
          const first = !failed;
          failed = true;
          if (first) sendError(context, error);
          const sink = await ready.catch(() => undefined);
          await sink?.abort();
        });
      return queue;
    },
    async close(): Promise<void> {
      if (finished) return;
      const sink = await ready.catch(() => undefined);
      await sink?.abort();
    },
  };
}

export function openUploadChannel(context: ChannelOpenContext): PeerChannel {
  return buildChannel(context, () => prepareUpload(parseUploadOpen(context.input)));
}

export function openSaveChannel(context: ChannelOpenContext): PeerChannel {
  return buildChannel(context, () => prepareSave(parseSaveOpen(context.input)));
}
