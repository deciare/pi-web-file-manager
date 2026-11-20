/**
 * Wire contract shared by the file manager's browser and server halves.
 *
 * The host pairs both halves of the same package revision, so the two always
 * agree on this file. It is still validated at runtime on both sides: a
 * malformed frame is a bug, and a bug must never be read as a path.
 *
 * Sizes are not arbitrary. `request` input is capped at 256 KiB and output at
 * 8 MiB by the host, channel frames at 64 KiB, and a resource selector at 4
 * KiB. File content therefore never travels through `request`.
 */

export const PLUGIN_ID = "file-manager";

/** Entries per listing page, and the largest page a caller may ask for. */
export const LIST_PAGE_SIZE = 500;
export const LIST_PAGE_MAX = 2000;
/** Largest file offered for editing. Larger files open read-only. */
export const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** Raw bytes per channel frame, before base64 expands them to 64 KiB. */
export const CONTENT_CHUNK_BYTES = 48 * 1024;
/** Bytes inspected when deciding whether a file is text. */
export const BINARY_SNIFF_BYTES = 8192;

export type EntryKind = "file" | "directory" | "symlink";

export interface FileEntry {
  readonly name: string;
  /** Absolute path. The plugin has no notion of a relative root. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
  /** Symlink destination as stored, not resolved. */
  readonly linkTarget?: string;
  /** True when a symlink's destination cannot be resolved. */
  readonly linkBroken?: boolean;
}

export interface ListRequest {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ListResponse {
  readonly path: string;
  /** Parent directory, or null at the filesystem root. */
  readonly parent: string | null;
  readonly entries: readonly FileEntry[];
  readonly total: number;
  readonly offset: number;
}

export interface StatRequest {
  readonly path: string;
}

export interface StatResponse {
  readonly entry: FileEntry;
  readonly editable: boolean;
  /** Why editing is refused, when it is. */
  readonly readOnlyReason?: "size" | "binary" | "directory";
  readonly firstBytesPreview?: string;
}

export interface ReadTextRequest {
  readonly path: string;
}

export interface ReadTextResponse {
  /** Base64 so JSON escaping can never inflate a payload past host limits. */
  readonly data: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface MkdirRequest {
  readonly path: string;
}

export interface MkdirResponse {
  readonly path: string;
}

export interface RenameRequest {
  readonly from: string;
  readonly to: string;
  readonly overwrite?: boolean;
}

export interface RenameResponse {
  readonly path: string;
}

export interface DeletePlanRequest {
  readonly path: string;
}

export interface DeletePlanResponse {
  readonly kind: EntryKind;
  /** Entries a recursive delete would remove, including the target. */
  readonly entries: number;
  /** Total bytes a recursive delete would remove, from lstat sizes. */
  readonly bytes: number;
  /** True when the traversal hit its counting cap and stopped early. */
  readonly truncated: boolean;
}

export interface DeleteRequest {
  readonly path: string;
  readonly recursive?: boolean;
}

export interface DeleteResponse {
  readonly removed: number;
}

/** Operations served through `request`. */
export interface FileManagerRequests {
  readonly list: { readonly input: ListRequest; readonly output: ListResponse };
  readonly stat: { readonly input: StatRequest; readonly output: StatResponse };
  readonly readText: { readonly input: ReadTextRequest; readonly output: ReadTextResponse };
  readonly mkdir: { readonly input: MkdirRequest; readonly output: MkdirResponse };
  readonly rename: { readonly input: RenameRequest; readonly output: RenameResponse };
  readonly deletePlan: { readonly input: DeletePlanRequest; readonly output: DeletePlanResponse };
  readonly delete: { readonly input: DeleteRequest; readonly output: DeleteResponse };
}

export type FileManagerOperation = keyof FileManagerRequests;

/** Operations served through `openChannel`, each with its own open input. */
export interface UploadOpen {
  /** Destination directory. */
  readonly path: string;
  readonly name: string;
  readonly size?: number;
}

export interface SaveTextOpen {
  readonly path: string;
  /** mtime the file had when it was opened; null for a new file. */
  readonly expectedMtimeMs: number | null;
}

/** Browser to server. */
export type ContentRequestFrame =
  | { readonly type: "chunk"; readonly data: string }
  | { readonly type: "end" };

/** Server to browser. */
export type ContentResponseFrame =
  | { readonly type: "progress"; readonly received: number }
  | { readonly type: "done"; readonly path: string; readonly size: number; readonly mtimeMs: number }
  | { readonly type: "error"; readonly code: ErrorCode; readonly message: string };

/** Operations served through `resourceUrl`. Selectors stay under 4 KiB. */
export type FileManagerResource = "download" | "zip";

export interface ResourceSelector {
  readonly path: string;
}

export const ERROR_CODES = [
  "ENOENT",
  "EACCES",
  "EEXIST",
  "ENOTEMPTY",
  "ECONFLICT",
  "EISDIR",
  "ENOTDIR",
  "EINVAL",
  "ELOOP",
  "ETOOBIG",
  "EBINARY",
  "EUNKNOWN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: FileManagerError };

export interface FileManagerError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string, path?: string): { readonly ok: false; readonly error: FileManagerError } {
  return { ok: false, error: path === undefined ? { code, message } : { code, message, path } };
}

/** Map a Node filesystem error to a stable code, keeping its message. */
export function errorCode(error: unknown): ErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "ENOENT":
    case "EACCES":
    case "EEXIST":
    case "ENOTEMPTY":
    case "EISDIR":
    case "ENOTDIR":
    case "EINVAL":
    case "ELOOP":
      return code;
    default:
      return "EUNKNOWN";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject anything that cannot be a path: embedded NUL, control characters. */
export function validPathString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isEntry(value: unknown): value is FileEntry {
  if (!isRecord(value)) return false;
  return typeof value["name"] === "string"
    && typeof value["path"] === "string"
    && (value["kind"] === "file" || value["kind"] === "directory" || value["kind"] === "symlink")
    && typeof value["size"] === "number"
    && typeof value["mtimeMs"] === "number";
}

/** Result payloads arrive as JSON, so a malformed one is a bug worth naming. */
export function requireResult<T>(raw: unknown, shape: (value: unknown) => value is T): Result<T> {
  if (!isRecord(raw) || typeof raw["ok"] !== "boolean") return fail("EINVAL", "Malformed response envelope");
  if (raw["ok"] === false) {
    const error = raw["error"];
    if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
      return fail("EINVAL", "Malformed error envelope");
    }
    const code = (ERROR_CODES as readonly string[]).includes(error["code"]) ? error["code"] as ErrorCode : "EUNKNOWN";
    const path = typeof error["path"] === "string" ? error["path"] : undefined;
    return fail(code, error["message"], path);
  }
  if (!shape(raw["data"])) return fail("EINVAL", "Malformed response payload");
  return ok(raw["data"]);
}
