import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import plugin, { openChannel, request } from "../src/server/index.ts";
import { decode, sandbox } from "./support.ts";
import { CHANNEL_OPERATIONS, REQUEST_OPERATIONS, RESOURCE_OPERATIONS } from "../src/shared/protocol.ts";

function call(operation: string, input: unknown, signal = new AbortController().signal) {
  return request({ operation, input: input as never, signal });
}

test("exposes a v5 server plugin with all three peer operations", () => {
  assert.equal(plugin.apiVersion, 5);
  const peer = plugin.activate().peer;
  assert.equal(typeof peer.request, "function");
  assert.equal(typeof peer.openChannel, "function");
  assert.equal(typeof peer.resource, "function");
});

test("answers an unknown operation in the envelope, not with a thrown error", async () => {
  const result = await call("explode", {});
  assert.equal(result.ok, false);
  assert.equal((result as { error: { code: string } }).error.code, "EINVAL");
});

test("turns a bad path into a validation failure", async () => {
  const result = await call("list", { path: "relative/path" });
  assert.equal(result.ok, false);
  assert.equal((result as { error: { code: string } }).error.code, "EINVAL");
});

test("maps a missing file to ENOENT with its path", async () => {
  const box = await sandbox();
  try {
    const missing = box.path("nope.txt");
    const result = await call("read.text", { path: missing });
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code: string; path?: string } }).error.code, "ENOENT");
    assert.equal((result as { error: { path?: string } }).error.path, missing);
  } finally {
    await box.cleanup();
  }
});

test("returns listing data through the success envelope", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("a.txt"), "a");
    const result = await call("list", { path: box.root });
    assert.equal(result.ok, true);
    const data = (result as { data: { entries: Array<{ name: string }>; total: number } }).data;
    assert.equal(data.total, 1);
    assert.equal(data.entries[0]?.name, "a.txt");
  } finally {
    await box.cleanup();
  }
});

test("reads a file as base64 through the envelope", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("hello.txt"), "hello");
    const result = await call("read.text", { path: box.path("hello.txt") });
    assert.equal(result.ok, true);
    assert.equal(decode((result as { data: { data: string } }).data.data), "hello");
  } finally {
    await box.cleanup();
  }
});

test("honours an aborted request instead of reading the filesystem", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => call("list", { path: "/" }, controller.signal), (error: unknown) => (error as Error).name === "AbortError");
});

test("rejects an unknown channel operation", async () => {
  await assert.rejects(
    () => openChannel({ operation: "teleport", input: {}, signal: new AbortController().signal, send: () => undefined }),
  );
});

test("every wire operation name is one the host will accept", () => {
  // The host rejects an operation before dispatch when it does not match this
  // pattern, so a camelCase name fails as "backend request unavailable".
  const pattern = /^[a-z][a-z0-9.-]*$/u;
  for (const name of [...REQUEST_OPERATIONS, ...CHANNEL_OPERATIONS, ...RESOURCE_OPERATIONS]) {
    assert.match(name, pattern, name);
    assert.ok(name.length <= 128, name);
  }
});

test("dispatches the dotted operations", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("note.txt"), "hello");
    assert.equal((await call("read.text", { path: box.path("note.txt") })).ok, true);
    assert.equal((await call("delete.plan", { path: box.path("note.txt") })).ok, true);
  } finally {
    await box.cleanup();
  }
});
