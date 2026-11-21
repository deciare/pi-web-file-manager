/**
 * Planning for uploads, with no Lit or DOM dependency so the rules can be
 * tested without a browser.
 *
 * An upload is a list of items — a file and the path it should occupy relative
 * to the directory on screen — because a folder pick arrives as a flat list of
 * files that carry their paths, not as a tree. Everything the panel needs to
 * decide before a byte moves lives here: which folders have to exist first, and
 * what to do about a name that is already taken.
 */

export interface UploadItem {
  readonly file: File;
  /** Path under the browsed directory, with `/` separators. */
  readonly relative: string;
}

/** What to do about names that already exist. */
export type UploadPolicy = "skip" | "replace" | "newer";

export type UploadAction = "upload" | "replace" | "skip";

/**
 * Every folder the items need, shallowest first, without duplicates.
 *
 * Order matters: creating `a/b` before `a` fails, and the caller creates them in
 * the order given. A folder is only listed once however many files it holds.
 */
export function directoriesToCreate(relatives: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const relative of relatives) {
    const parts = relative.split("/").filter((part) => part !== "");
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
}

/**
 * What to do with one item, given what is already at its destination.
 *
 * `newer` compares modification times and keeps the later file, which is the
 * only rule here that needs a fact about the file already on disk. An incoming
 * file with the same timestamp is not newer, so it is skipped: "no change" is a
 * safer answer than "write it again and call it a replacement".
 */
export function uploadAction(item: UploadItem, existingMtimeMs: number | undefined, policy: UploadPolicy): UploadAction {
  if (existingMtimeMs === undefined) return "upload";
  if (policy === "skip") return "skip";
  if (policy === "replace") return "replace";
  return item.file.lastModified > existingMtimeMs ? "replace" : "skip";
}

/** The folder an item belongs in, relative to the browsed directory; "" for the directory itself. */
export function parentRelative(relative: string): string {
  const parts = relative.split("/").filter((part) => part !== "");
  return parts.slice(0, -1).join("/");
}
