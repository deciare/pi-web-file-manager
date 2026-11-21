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

export interface ConflictNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: readonly ConflictNode[];
}

interface NodeBuilder {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, NodeBuilder>;
}

/**
 * Conflicting paths as a tree, for a reader who wants to see where they are.
 *
 * Folders come from the paths themselves rather than from the picked tree: only
 * the files that collide matter, so a folder appears exactly when it holds one
 * of them. Sorting puts folders above files at every level, the way a file
 * listing does.
 */
export function conflictTree(relatives: readonly string[]): ConflictNode[] {
  const root = new Map<string, NodeBuilder>();
  for (const relative of relatives) {
    const parts = relative.split("/").filter((part) => part !== "");
    let level = root;
    let path = "";
    for (const [index, part] of parts.entries()) {
      path = path === "" ? part : `${path}/${part}`;
      const existing = level.get(part);
      const node = existing ?? { name: part, path, children: new Map<string, NodeBuilder>() };
      if (existing === undefined) level.set(part, node);
      if (index === parts.length - 1) continue;
      level = node.children;
    }
  }
  return sortNodes(root);
}

function sortNodes(level: Map<string, NodeBuilder>): ConflictNode[] {
  return [...level.values()]
    .map((node) => ({
      name: node.name,
      path: node.path,
      kind: node.children.size > 0 ? "directory" as const : "file" as const,
      children: sortNodes(node.children),
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });
}

export interface ConflictRow {
  readonly node: ConflictNode;
  readonly depth: number;
}

/** The tree as one flat list with a depth per row: every folder is already open. */
export function treeRows(nodes: readonly ConflictNode[], depth = 0): ConflictRow[] {
  return nodes.flatMap((node) => [{ node, depth }, ...treeRows(node.children, depth + 1)]);
}
