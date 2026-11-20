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
