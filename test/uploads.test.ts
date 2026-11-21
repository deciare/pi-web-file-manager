import test from "node:test";
import assert from "node:assert/strict";
import {
  directoriesToCreate, parentRelative, uploadAction, type UploadItem,
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
