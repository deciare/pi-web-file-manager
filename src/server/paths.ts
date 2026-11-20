import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { invalid } from "./failure.ts";

/**
 * Path handling for a file manager that is allowed to reach everywhere.
 *
 * There is no allowlist here, by design: the plugin does what a terminal does.
 * What remains is *correctness* — turning user input into exactly one absolute
 * path, refusing strings that cannot be a path at all, and refusing the few
 * operations that have no sane meaning (`/` renamed, `/` deleted). Every
 * filesystem call downstream receives a normalized absolute path.
 */

export const MAX_PATH_LENGTH = 4096;
export const MAX_NAME_BYTES = 255;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Expand `~` and require the result to be absolute.
 *
 * Relative input is rejected rather than resolved against the daemon's working
 * directory: a browser has no idea what that directory is, so a relative path
 * would silently mean something the user did not ask for. The panel resolves
 * relative input against the directory it is showing and sends an absolute path.
 */
export function absolutePath(input: unknown, label = "path"): string {
  if (typeof input !== "string") throw invalid(`${label} must be a string`);
  const trimmed = input.trim();
  if (trimmed === "") throw invalid(`${label} is empty`);
  if (trimmed.length > MAX_PATH_LENGTH) throw invalid(`${label} is longer than ${String(MAX_PATH_LENGTH)} characters`);
  if (CONTROL_CHARACTERS.test(trimmed)) throw invalid(`${label} contains a control character`);

  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) throw invalid(`${label} must be absolute or start with ~`);
  return resolve(expanded);
}

/** `~` and `~/x`; anything else is returned unchanged. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function isRootPath(path: string): boolean {
  return resolve(path) === "/";
}

/**
 * Names that arrive from the browser as a new file or folder name, or as the
 * final component of a rename. They are a single path segment, never a path.
 */
export function singleName(input: unknown, label = "name"): string {
  if (typeof input !== "string") throw invalid(`${label} must be a string`);
  if (input === "") throw invalid(`${label} is empty`);
  if (input === "." || input === "..") throw invalid(`${label} cannot be . or ..`);
  if (input.includes("/") || input.includes("\\")) throw invalid(`${label} cannot contain a path separator`);
  if (CONTROL_CHARACTERS.test(input)) throw invalid(`${label} contains a control character`);
  if (Buffer.byteLength(input, "utf8") > MAX_NAME_BYTES) throw invalid(`${label} is longer than ${String(MAX_NAME_BYTES)} bytes`);
  return input;
}

/**
 * Guard for the operations that must never touch the filesystem root itself.
 * Renaming or deleting `/` has no meaning the UI could confirm, and both would
 * be catastrophic; refusing here keeps that decision away from the caller.
 */
export function refuseRoot(path: string, action: string): void {
  if (isRootPath(path)) throw invalid(`Refusing to ${action} the filesystem root`, path);
}
