import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type {
  DeletePlanResponse, DeleteRequest, DeleteResponse, FileEntry, ListResponse, MkdirResponse,
  ReadTextResponse, RenameRequest, RenameResponse, StatResponse,
} from "../shared/protocol.ts";
import { BINARY_SNIFF_BYTES, LIST_MAX_ENTRIES, TEXT_EDIT_MAX_BYTES } from "../shared/protocol.ts";
import { absolutePath, refuseRoot } from "./paths.ts";
import { isTempName, sweepDirectory, tempNameFor, trackDirectory } from "./temps.ts";
import { Failure, invalid } from "./failure.ts";

/** Backstop for counting a recursive delete, so a runaway tree cannot stall a request. */
export const DELETE_COUNT_CAP = 100_000;

/** Where a page starts. Negative or fractional input is a bug, not a hint. */
export function pageOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid("offset must be a non-negative integer");
  return value;
}

export function pageLimit(value: unknown): number {
  if (value === undefined) return LIST_MAX_ENTRIES;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid("limit must be a positive integer");
  return Math.min(value, LIST_MAX_ENTRIES);
}

/**
 * Directory order: directories first, then case-insensitive natural order, so
 * `file2` sorts before `file10`. The host's own panel sorts the same way and
 * users read both lists.
 */
export function compareEntries(left: FileEntry, right: FileEntry): number {
  const leftDirectory = left.kind === "directory" || left.linkKind === "directory";
  const rightDirectory = right.kind === "directory" || right.linkKind === "directory";
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export async function describeEntry(path: string, knownName?: string): Promise<FileEntry> {
  const info = await lstat(path);
  const name = knownName ?? basename(path) ?? path;
  if (info.isSymbolicLink()) {
    let linkTarget: string | undefined;
    let linkKind: "file" | "directory" | undefined;
    let linkBroken = false;
    try {
      linkTarget = await readlink(path);
      const resolved = await stat(path);
      linkKind = resolved.isDirectory() ? "directory" : "file";
    } catch {
      linkBroken = true;
    }
    return {
      name, path, kind: "symlink", size: info.size, mtimeMs: info.mtimeMs,
      ...(linkTarget === undefined ? {} : { linkTarget }),
      ...(linkKind === undefined ? {} : { linkKind }),
      ...(linkBroken ? { linkBroken: true } : {}),
    };
  }
  return { name, path, kind: info.isDirectory() ? "directory" : "file", size: info.size, mtimeMs: info.mtimeMs };
}

export async function listDirectory(input: { path?: unknown; offset?: unknown; limit?: unknown }): Promise<ListResponse> {
  const path = absolutePath(input.path);
  const offset = pageOffset(input.offset);
  const limit = pageLimit(input.limit);

  const entries = await readdir(path, { withFileTypes: true });
  // Temporaries from interrupted transfers are ours, not the user's; they are
  // hidden from listings and swept here, where someone would otherwise see them.
  if (entries.some((entry) => isTempName(entry.name))) void sweepDirectory(path);
  const sorted = entries
    .filter((entry) => !isTempName(entry.name))
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });

  const page = sorted.slice(offset, offset + limit);
  const described = await Promise.all(page.map((entry) => describeEntry(join(path, entry.name), entry.name)));
  described.sort(compareEntries);

  return {
    path,
    parent: path === "/" ? null : dirname(path),
    entries: described,
    total: sorted.length,
    offset,
    truncated: offset + described.length < sorted.length,
  };
}

/** True when the bytes look like text: no NUL in the sniff window. */
export function looksBinary(firstBytes: Uint8Array): boolean {
  for (const byte of firstBytes) if (byte === 0) return true;
  return false;
}

async function openRegularFile(path: string): Promise<FileHandle> {
  // O_NONBLOCK keeps a FIFO from hanging the open; fstat then rejects anything
  // that is not a regular file, so a named pipe reads as an error, not a stall.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalid("Not a regular file", path);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function sniffBinary(path: string): Promise<boolean> {
  const handle = await openRegularFile(path);
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function statPath(input: { path?: unknown }): Promise<StatResponse> {
  const path = absolutePath(input.path);
  const entry = await describeEntry(path);
  if (entry.kind === "directory" || entry.linkKind === "directory") return { entry, editable: false, readOnlyReason: "directory" };
  if (entry.linkBroken === true) return { entry, editable: false, readOnlyReason: "binary" };
  if (entry.size > TEXT_EDIT_MAX_BYTES) return { entry, editable: false, readOnlyReason: "size" };
  if (await sniffBinary(path)) return { entry, editable: false, readOnlyReason: "binary" };
  return { entry, editable: true };
}

export async function readTextFile(input: { path?: unknown }): Promise<ReadTextResponse> {
  const path = absolutePath(input.path);
  const info = await lstat(path);
  if (info.isDirectory()) throw new Failure("EISDIR", "Cannot read a directory as text", path);
  const handle = await openRegularFile(path);
  try {
    const info = await handle.stat();
    if (info.size > TEXT_EDIT_MAX_BYTES) {
      throw new Failure("ETOOBIG", `File is larger than ${String(TEXT_EDIT_MAX_BYTES)} bytes`, path);
    }
    const content = await handle.readFile();
    if (looksBinary(content.subarray(0, Math.min(content.length, BINARY_SNIFF_BYTES)))) {
      throw new Failure("EBINARY", "File is not text", path);
    }
    return { data: content.toString("base64"), size: content.length, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

export async function makeDirectory(input: { path?: unknown }): Promise<MkdirResponse> {
  const path = absolutePath(input.path);
  await mkdir(path);
  return { path };
}

export async function renamePath(input: RenameRequest): Promise<RenameResponse> {
  const from = absolutePath(input.from, "from");
  const to = absolutePath(input.to, "to");
  refuseRoot(from, "rename");
  refuseRoot(to, "rename");
  if (from === to) throw invalid("Source and destination are the same path", from);
  // A directory cannot become its own descendant; the OS refuses this too, with
  // an errno that says nothing to a reader.
  if (to.startsWith(`${from}/`)) throw invalid("Cannot move a folder into itself", to);

  const destination = await lstat(to).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
  if (destination !== undefined && input.overwrite !== true) {
    // Naming the kind matters: replacing a file costs a file, replacing a
    // folder can cost a tree, and the caller decides whether to offer that.
    const kind = destination.isDirectory() ? "folder" : "file";
    throw new Failure("EEXIST", `A ${kind} with that name already exists`, to);
  }
  // Replacing a folder only works when it is empty, and the errno that says so
  // reads as noise. Naming it here keeps the refusal legible.
  if (destination?.isDirectory() === true) {
    const names = await readdir(to).catch(() => []);
    if (names.length > 0) throw new Failure("ENOTEMPTY", "The folder at the destination is not empty, so it cannot be replaced", to);
  }
  await rename(from, to);
  return { path: to };
}

export interface DeleteCount {
  readonly entries: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Count what a recursive delete would remove, without following symlinks: a
 * link is one entry, and its target is not walked.
 */
export async function countDeletion(path: string, cap = DELETE_COUNT_CAP): Promise<DeleteCount> {
  let entries = 0;
  let bytes = 0;
  let truncated = false;

  async function visit(current: string): Promise<void> {
    if (entries >= cap) { truncated = true; return; }
    const info = await lstat(current);
    entries += 1;
    // Directory entries carry inode sizes, which say nothing useful about what
    // deleting this tree frees; only file contents are counted.
    if (info.isFile()) bytes += info.size;
    if (!info.isDirectory()) return;
    const names = await readdir(current);
    for (const name of names) {
      if (entries >= cap) { truncated = true; return; }
      await visit(join(current, name));
    }
  }

  await visit(path);
  return { entries, bytes, truncated };
}

export async function planDelete(input: { path?: unknown }): Promise<DeletePlanResponse> {
  const path = absolutePath(input.path);
  refuseRoot(path, "delete");
  const entry = await describeEntry(path);
  if (entry.kind !== "directory") return { kind: entry.kind, entries: 1, bytes: entry.size, truncated: false };
  const count = await countDeletion(path);
  return { kind: entry.kind, ...count };
}

export async function deletePath(input: DeleteRequest): Promise<DeleteResponse> {
  const path = absolutePath(input.path);
  refuseRoot(path, "delete");
  const info = await lstat(path);
  if (!info.isDirectory()) {
    await rm(path);
    return { removed: 1 };
  }
  const names = await readdir(path);
  if (input.recursive !== true) {
    if (names.length > 0) throw new Failure("ENOTEMPTY", "Directory is not empty", path);
    await rmdir(path);
    return { removed: 1 };
  }
  const count = await countDeletion(path);
  await rm(path, { recursive: true });
  return { removed: count.entries };
}

/** Shared by the upload and save channels: write a temp file, then publish it. */
export async function createTempSibling(finalPath: string): Promise<{ temp: string; handle: FileHandle }> {
  const directory = dirname(finalPath);
  const name = basename(finalPath);
  const temp = join(directory, tempNameFor(name));
  const handle = await open(temp, "wx", 0o600);
  trackDirectory(directory);
  return { temp, handle };
}

/** Publish a finished temp file under its real name, refusing to overwrite. */
export async function publishNew(temp: string, finalPath: string): Promise<void> {
  try {
    await link(temp, finalPath);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Replace an existing file atomically, keeping the permissions it had. */
export async function replaceFile(temp: string, finalPath: string, mode: number): Promise<void> {
  await chmod(temp, mode & 0o7777);
  await rename(temp, finalPath);
}
