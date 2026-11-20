import { test } from "node:test";
import assert from "node:assert/strict";
import { breadcrumbSegments, formatSize, resolveAddress } from "../src/browser/breadcrumbs.ts";

test("splits a path into clickable segments from the root", () => {
  assert.deepEqual(breadcrumbSegments("/data/home/airi/knowledge-base"), [
    { name: "/", path: "/" },
    { name: "data", path: "/data" },
    { name: "home", path: "/data/home" },
    { name: "airi", path: "/data/home/airi" },
    { name: "knowledge-base", path: "/data/home/airi/knowledge-base" },
  ]);
});

test("the root is its own single segment", () => {
  assert.deepEqual(breadcrumbSegments("/"), [{ name: "/", path: "/" }]);
});

test("keeps trailing separators out of the segments", () => {
  assert.deepEqual(breadcrumbSegments("/data//home/"), [
    { name: "/", path: "/" },
    { name: "data", path: "/data" },
    { name: "home", path: "/data/home" },
  ]);
});

test("an absolute address is taken as written", () => {
  assert.equal(resolveAddress("/etc/hosts", "/data/home"), "/etc/hosts");
});

test("~ addresses are left for the server to expand", () => {
  assert.equal(resolveAddress("~", "/data/home"), "~");
  assert.equal(resolveAddress("~/airi", "/data/home"), "~/airi");
});

test("a relative address resolves against the directory on screen", () => {
  assert.equal(resolveAddress("airi", "/data/home"), "/data/home/airi");
  assert.equal(resolveAddress("etc", "/"), "/etc");
  assert.equal(resolveAddress("  notes  ", "/data"), "/data/notes");
});

test("sizes read the way a file manager should", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(999), "999 B");
  assert.equal(formatSize(1024), "1.0 KiB");
  assert.equal(formatSize(1536), "1.5 KiB");
  assert.equal(formatSize(10 * 1024 * 1024), "10 MiB");
  assert.equal(formatSize(Number.NaN), "");
});
