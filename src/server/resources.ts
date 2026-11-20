import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ZipFile } from "yazl";
import type { ResourceContext, ResourceResponse } from "./pluginApi.ts";
import { absolutePath } from "./paths.ts";
import { Failure } from "./failure.ts";

/**
 * Bytes leaving the plugin: one file, or a directory tree as a zip.
 *
 * Resources stream rather than buffer, so a 3 GiB video and a 40 000-file tree
 * cost the same memory. The host caps a resource stream at 30 minutes and
 * forces `Content-Disposition: inline`, so a download must be started with an
 * anchor's `download` attribute rather than by navigating to the URL.
 */

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  ini: "text/plain; charset=utf-8",
  xml: "application/xml",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  rs: "text/plain; charset=utf-8",
  go: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
  patch: "text/plain; charset=utf-8",
  diff: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

export function contentTypeFor(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function selectorPath(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Failure("EINVAL", "Resource selector must be an object");
  const record = input as Record<string, unknown>;
  return absolutePath(record["path"]);
}

export async function downloadResource(context: ResourceContext): Promise<ResourceResponse> {
  const path = selectorPath(context.input);
  context.signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let transferred = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Failure("EINVAL", "Not a regular file", path);
    if (!Number.isSafeInteger(info.size)) throw new Failure("EINVAL", "File size is not representable", path);
    if (info.size === 0) return { body: new Uint8Array(), contentType: contentTypeFor(path), contentLength: 0 };
    const stream = handle.createReadStream({ autoClose: true, signal: context.signal });
    stream.on("error", () => { /* the async iterator propagates read failures */ });
    transferred = true;
    return { body: stream, contentType: contentTypeFor(path), contentLength: info.size };
  } finally {
    if (!transferred) await handle.close();
  }
}

/**
 * Build the zip lazily: entries are added as the tree is walked, and yazl
 * streams the result as it goes. Symlinks are skipped rather than followed —
 * a zip of a directory should not silently contain a copy of everything a link
 * points at.
 */
async function addTree(zip: ZipFile, directory: string, prefix: string): Promise<number> {
  let added = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = join(directory, entry.name);
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    const info = await lstat(full);
    if (info.isDirectory()) {
      zip.addEmptyDirectory(name, { mtime: info.mtime, mode: info.mode });
      added += 1 + await addTree(zip, full, name);
    } else if (info.isFile()) {
      zip.addFile(full, name, { mtime: info.mtime, mode: info.mode });
      added += 1;
    }
  }
  return added;
}

export async function zipResource(context: ResourceContext): Promise<ResourceResponse> {
  const path = selectorPath(context.input);
  context.signal.throwIfAborted();
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Failure("ENOTDIR", "Not a directory", path);
  const root = basename(path) === "" ? "root" : basename(path);
  const zip = new ZipFile();
  // Walking is asynchronous, so the stream is primed before it is handed back:
  // `end()` is deferred until the tree has been enumerated.
  const started = addTree(zip, path, root).then(() => { zip.end(); });
  started.catch(() => { /* a walk failure surfaces through the output stream */ });
  const body = (async function* stream(): AsyncIterable<Uint8Array> {
    await started;
    for await (const chunk of zip.outputStream as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
  })();
  return { body, contentType: "application/zip" };
}
