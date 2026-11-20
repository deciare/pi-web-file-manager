import type { Json, Peer } from "./pluginApi.ts";
import { CONTENT_CHUNK_BYTES, ERROR_CODES } from "../shared/protocol.ts";
import type { ErrorCode, FileEntry, Result } from "../shared/protocol.ts";
import { isEntry, isRecord } from "../shared/protocol.ts";

/**
 * Typed client for the package's server half.
 *
 * Every response is validated here rather than at each call site: a payload
 * that does not match the protocol is a bug in the pairing, and the panel
 * should say so plainly instead of rendering `undefined`.
 */

export interface FileManagerClient {
  list(path: string, signal?: AbortSignal): Promise<Result<{ path: string; parent: string | null; entries: FileEntry[]; total: number; truncated: boolean }>>;
  stat(path: string, signal?: AbortSignal): Promise<Result<{ entry: FileEntry; editable: boolean; readOnlyReason?: "size" | "binary" | "directory" }>>;
  readText(path: string, signal?: AbortSignal): Promise<Result<{ data: string; size: number; mtimeMs: number }>>;
  mkdir(path: string): Promise<Result<{ path: string }>>;
  rename(from: string, to: string, overwrite: boolean): Promise<Result<{ path: string }>>;
  deletePlan(path: string): Promise<Result<{ kind: string; entries: number; bytes: number; truncated: boolean }>>;
  remove(path: string, recursive: boolean): Promise<Result<{ removed: number }>>;
  downloadUrl(path: string): string | undefined;
  zipUrl(path: string): string | undefined;
  upload(directory: string, file: File, signal: AbortSignal, onProgress: (received: number) => void, overwrite?: boolean): Promise<Result<{ path: string; size: number; mtimeMs: number }>>;
  save(path: string, expectedMtimeMs: number | null, text: string, signal: AbortSignal, force?: boolean): Promise<Result<{ path: string; size: number; mtimeMs: number }>>;
}

export class MissingBackendError extends Error {
  constructor() {
    super("This PI WEB host did not supply a plugin backend; update PI WEB and restart its session daemon.");
    this.name = "MissingBackendError";
  }
}

export function clientFor(context: { readonly backend?: { forScope(scope: { kind: "machine" }): Peer } }): FileManagerClient {
  const backend = context.backend;
  if (backend === undefined) throw new MissingBackendError();
  return createClient(backend.forScope({ kind: "machine" }));
}

function parseEnvelope(raw: Json): Result<unknown> {
  if (!isRecord(raw) || typeof raw["ok"] !== "boolean") return { ok: false, error: { code: "EINVAL", message: "Malformed response envelope" } };
  if (raw["ok"] === true) return { ok: true, data: raw["data"] };
  const error = raw["error"];
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
    return { ok: false, error: { code: "EINVAL", message: "Malformed error envelope" } };
  }
  const code = (ERROR_CODES as readonly string[]).includes(error["code"]) ? error["code"] as ErrorCode : "EUNKNOWN";
  return { ok: false, error: { code, message: error["message"] } };
}

function entries(value: unknown): value is { path: string; parent: string | null; entries: FileEntry[]; total: number; truncated: boolean } {
  return isRecord(value) && typeof value["path"] === "string" && typeof value["total"] === "number"
    && typeof value["truncated"] === "boolean" && Array.isArray(value["entries"]) && value["entries"].every(isEntry)
    && (value["parent"] === null || typeof value["parent"] === "string");
}

async function call<T>(peer: Peer, operation: string, input: Json, shape: (value: unknown) => value is T, signal?: AbortSignal): Promise<Result<T>> {
  let raw: Json;
  try {
    raw = await peer.request(operation, input, signal === undefined ? undefined : { signal });
  } catch (error) {
    return { ok: false, error: { code: "EUNKNOWN", message: error instanceof Error ? error.message : String(error) } };
  }
  const parsed = parseEnvelope(raw);
  if (parsed.ok === false) return parsed;
  if (!shape(parsed.data)) return { ok: false, error: { code: "EINVAL", message: `Malformed ${operation} response` } };
  return { ok: true, data: parsed.data };
}

function isPathResult(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value["path"] === "string";
}

function isStatResult(value: unknown): value is { entry: FileEntry; editable: boolean; readOnlyReason?: "size" | "binary" | "directory" } {
  return isRecord(value) && isEntry(value["entry"]) && typeof value["editable"] === "boolean";
}

function isReadResult(value: unknown): value is { data: string; size: number; mtimeMs: number } {
  return isRecord(value) && typeof value["data"] === "string" && typeof value["size"] === "number" && typeof value["mtimeMs"] === "number";
}

function isDeletePlan(value: unknown): value is { kind: string; entries: number; bytes: number; truncated: boolean } {
  return isRecord(value) && typeof value["kind"] === "string" && typeof value["entries"] === "number"
    && typeof value["bytes"] === "number" && typeof value["truncated"] === "boolean";
}

function isRemoved(value: unknown): value is { removed: number } {
  return isRecord(value) && typeof value["removed"] === "number";
}

function isWriteResult(value: unknown): value is { path: string; size: number; mtimeMs: number } {
  return isRecord(value) && typeof value["path"] === "string" && typeof value["size"] === "number" && typeof value["mtimeMs"] === "number";
}

/** Send content over a channel and resolve with the terminal frame. */
async function sendContent(
  peer: Peer,
  operation: string,
  open: Json,
  chunks: () => AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  onProgress: (received: number) => void,
): Promise<Result<{ path: string; size: number; mtimeMs: number }>> {
  if (peer.openChannel === undefined) return { ok: false, error: { code: "EUNKNOWN", message: "This host does not support plugin channels" } };
  let settled: Result<{ path: string; size: number; mtimeMs: number }> | undefined;
  const channel = await peer.openChannel(operation, open, {
    signal,
    onData(data) {
      if (!isRecord(data)) return;
      if (data["type"] === "progress" && typeof data["received"] === "number") onProgress(data["received"]);
      if (data["type"] === "error" && typeof data["message"] === "string") {
        const code = typeof data["code"] === "string" && (ERROR_CODES as readonly string[]).includes(data["code"]) ? data["code"] as ErrorCode : "EUNKNOWN";
        settled = { ok: false, error: { code, message: data["message"] } };
      }
      if (data["type"] === "done" && isWriteResult(data)) {
        settled = { ok: true, data: { path: data.path, size: data.size, mtimeMs: data.mtimeMs } };
      }
    },
  }).catch((error: unknown) => {
    settled = { ok: false, error: { code: "EUNKNOWN", message: error instanceof Error ? error.message : String(error) } };
    return undefined;
  });
  if (channel === undefined) return settled ?? { ok: false, error: { code: "EUNKNOWN", message: "Channel failed to open" } };

  try {
    for await (const chunk of chunks()) {
      channel.send({ type: "chunk", data: toBase64(chunk) });
    }
    channel.send({ type: "end" });
  } catch (error) {
    channel.close("client aborted");
    return { ok: false, error: { code: "EUNKNOWN", message: error instanceof Error ? error.message : String(error) } };
  }
  await channel.closed;
  return settled ?? { ok: false, error: { code: "EUNKNOWN", message: "The server closed the channel without a result" } };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Slice a byte stream into the frame-sized chunks the protocol expects. */
async function* chunked(blob: Blob, chunkBytes: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    yield new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
  }
}

export function createClient(peer: Peer): FileManagerClient {
  return {
    list: (path, signal) => call(peer, "list", { path }, entries, signal),
    stat: (path, signal) => call(peer, "stat", { path }, isStatResult, signal),
    readText: (path, signal) => call(peer, "read.text", { path }, isReadResult, signal),
    mkdir: (path) => call(peer, "mkdir", { path }, isPathResult),
    rename: (from, to, overwrite) => call(peer, "rename", { from, to, overwrite }, isPathResult),
    deletePlan: (path) => call(peer, "delete.plan", { path }, isDeletePlan),
    remove: (path, recursive) => call(peer, "delete", { path, recursive }, isRemoved),
    downloadUrl: (path) => peer.resourceUrl?.("download", { path }),
    zipUrl: (path) => peer.resourceUrl?.("zip", { path }),
    upload: (directory, file, signal, onProgress, overwrite) =>
      sendContent(
        peer,
        "upload",
        { path: directory, name: file.name, size: file.size, ...(overwrite === true ? { overwrite: true } : {}) },
        () => chunked(file, CONTENT_CHUNK_BYTES),
        signal,
        onProgress,
      ),
    save: (path, expectedMtimeMs, text, signal, force) =>
      sendContent(
        peer,
        "save.text",
        { path, expectedMtimeMs, ...(force === true ? { force: true } : {}) },
        async function* () { yield new TextEncoder().encode(text); },
        signal,
        () => undefined,
      ),
  };
}
