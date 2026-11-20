import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { absolutePath, expandHome, isRootPath, refuseRoot, singleName } from "../src/server/paths.ts";
import { Failure } from "../src/server/failure.ts";

test("expands ~ and requires an absolute path", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/notes"), `${homedir()}/notes`);
  assert.equal(expandHome("/etc/hosts"), "/etc/hosts");
  assert.equal(absolutePath("/etc/../etc/hosts"), "/etc/hosts");
  assert.equal(absolutePath("~/notes/"), `${homedir()}/notes`);
});

test("rejects relative input rather than resolving it against the daemon cwd", () => {
  assert.throws(() => absolutePath("notes"), Failure);
  assert.throws(() => absolutePath(""), Failure);
  assert.throws(() => absolutePath("   "), Failure);
  assert.throws(() => absolutePath("/etc/\u0000passwd"), Failure);
  assert.throws(() => absolutePath("/etc/\nhosts"), Failure);
  assert.throws(() => absolutePath("x".repeat(5000)), Failure);
});

test("rejects non-strings outright", () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.throws(() => absolutePath(value), Failure);
  }
});

test("a name is one segment, never a path", () => {
  assert.equal(singleName("notes.md"), "notes.md");
  assert.equal(singleName(".hidden"), ".hidden");
  for (const value of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "x".repeat(256)]) {
    assert.throws(() => singleName(value), Failure, String(value));
  }
});

test("the filesystem root is recognised however it is written", () => {
  assert.equal(isRootPath("/"), true);
  assert.equal(isRootPath("//"), true);
  assert.equal(isRootPath("/."), true);
  assert.equal(isRootPath("/home"), false);
  assert.throws(() => refuseRoot("/", "delete"), Failure);
  assert.doesNotThrow(() => refuseRoot("/home", "delete"));
});
