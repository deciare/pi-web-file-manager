import test from "node:test";
import assert from "node:assert/strict";
import {
  conflictTree, directoriesToCreate, parentRelative, treeRows, uploadAction, type UploadItem,
} from "../src/browser/uploads.ts";

function item(relative: string, lastModified: number): UploadItem {
  return { file: new File(["x"], relative.split("/").at(-1) ?? relative, { lastModified }), relative };
}

test("every folder a flat pick of files needs, shallowest first and once each", () => {
  assert.deepEqual(
    directoriesToCreate(["pkg/src/a.ts", "pkg/src/b.ts", "pkg/README.md", "top.txt"]),
    ["pkg", "pkg/src"],
  );
  assert.deepEqual(directoriesToCreate(["a/b/c/d.txt"]), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(directoriesToCreate(["only.txt"]), []);
});

test("the folder of an item is the path above it", () => {
  assert.equal(parentRelative("pkg/src/a.ts"), "pkg/src");
  assert.equal(parentRelative("top.txt"), "");
});

test("a name that is free is simply written", () => {
  assert.equal(uploadAction(item("a.txt", 100), undefined, "skip"), "upload");
  assert.equal(uploadAction(item("a.txt", 100), undefined, "newer"), "upload");
});

test("the policy decides what a taken name becomes", () => {
  const incoming = item("a.txt", 200);
  assert.equal(uploadAction(incoming, 100, "skip"), "skip");
  assert.equal(uploadAction(incoming, 100, "replace"), "replace");
  assert.equal(uploadAction(incoming, 300, "newer"), "skip");
  assert.equal(uploadAction(incoming, 100, "newer"), "replace");
});

test("a file with the same timestamp is not newer", () => {
  // Copying a tree and uploading it back leaves mtimes equal; rewriting every
  // file on that basis is not what "keep newer" was asked for.
  assert.equal(uploadAction(item("a.txt", 500), 500, "newer"), "skip");
});

test("conflicting paths become a tree of the folders that hold them", () => {
  const tree = conflictTree(["pkg/src/a.ts", "pkg/src/b.ts", "pkg/README.md", "top.txt"]);
  assert.deepEqual(
    tree.map((node) => [node.name, node.kind, node.children.map((child) => child.name)]),
    [
      ["pkg", "directory", ["src", "README.md"]],
      ["top.txt", "file", []],
    ],
  );
  assert.deepEqual(
    tree[0]?.children[0]?.children.map((node) => [node.name, node.kind]),
    [["a.ts", "file"], ["b.ts", "file"]],
  );
});

test("folders sort above files at every level, and a folder is shared once", () => {
  const tree = conflictTree(["z/y.txt", "a.txt", "z/x/w.txt"]);
  assert.deepEqual(tree.map((node) => node.name), ["z", "a.txt"]);
  assert.deepEqual(tree[0]?.children.map((node) => node.name), ["x", "y.txt"]);
  assert.deepEqual(tree[0]?.children[0]?.children.map((node) => node.path), ["z/x/w.txt"]);
});

test("every folder is open, so a tree is a flat list with depths", () => {
  const rows = treeRows(conflictTree(["pkg/src/a.ts", "top.txt"]));
  assert.deepEqual(
    rows.map((row) => `${String(row.depth)}:${row.node.name}`),
    ["0:pkg", "1:src", "2:a.ts", "0:top.txt"],
  );
});
