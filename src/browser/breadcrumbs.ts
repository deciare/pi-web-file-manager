/**
 * Path helpers with no Lit or DOM dependency, so they can be unit-tested
 * without constructing a component.
 */

export interface BreadcrumbSegment {
  readonly name: string;
  readonly path: string;
}

/** Split an absolute path into clickable segments, root first. */
export function breadcrumbSegments(directory: string): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [{ name: "/", path: "/" }];
  let accumulated = "";
  for (const part of directory.split("/").filter((value) => value !== "")) {
    accumulated += `/${part}`;
    segments.push({ name: part, path: accumulated });
  }
  return segments;
}

/**
 * Turn typed text into the path to open. `~` and absolute paths are the server's
 * business; anything else is relative to the directory on screen, because that
 * is what a user typing into a breadcrumb means by it.
 */
export function resolveAddress(input: string, current: string | undefined): string {
  const value = input.trim();
  if (value.startsWith("/") || value === "~" || value.startsWith("~/")) return value;
  const base = current ?? "/";
  return `${base === "/" ? "" : base}/${value}`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "B"}`;
}

/** Join a directory and a single name, without doubling the separator at the root. */
export function joinPath(directory: string, name: string): string {
  return `${directory === "/" ? "" : directory.replace(/\/+$/u, "")}/${name}`;
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

/**
 * The path as it reads from `root`, in the form a shell command run from the
 * root would accept. A path outside the root climbs out with `..`, the same
 * thing `realpath --relative-to` produces, so the answer is available wherever
 * a root is known. The root itself is `.`.
 */
export function relativeToRoot(path: string, root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  const from = segments(trimTrailingSlashes(root));
  const to = segments(trimTrailingSlashes(path));
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const up = from.slice(common).map(() => "..");
  const rest = to.slice(common);
  return [...up, ...rest].join("/") || ".";
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

function trimTrailingSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

/** Dotfiles: hidden from a listing unless the user asks for them. */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}
