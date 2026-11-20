import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { openChannel } from "../src/server/index.ts";
import { base64, channelHarness, sandbox } from "./support.ts";

function framesOf(frames: unknown[]): Array<Record<string, unknown>> {
  return frames as Array<Record<string, unknown>>;
}

test("uploads a file in chunks and reports completion", async () => {
  const box = await sandbox();
  try {
    const harness = channelHarness("upload", { path: box.root, name: "note.txt", size: 11 });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("hello ") }, harness.controller.signal);
    await channel.receive({ type: "chunk", data: base64("world") }, harness.controller.signal);
    await channel.receive({ type: "end" }, harness.controller.signal);

    assert.equal(await readFile(box.path("note.txt"), "utf8"), "hello world");
    const done = framesOf(harness.frames).find((frame) => frame["type"] === "done");
    assert.equal(done?.["path"], box.path("note.txt"));
    assert.equal(done?.["size"], 11);
    assert.equal(typeof done?.["mtimeMs"], "number");
  } finally {
    await box.cleanup();
  }
});

test("refuses to upload over an existing name", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("taken.txt"), "original");
    const harness = channelHarness("upload", { path: box.root, name: "taken.txt" });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("new") }, harness.controller.signal);
    const error = framesOf(harness.frames).find((frame) => frame["type"] === "error");
    assert.equal(error?.["code"], "EEXIST");
    assert.equal(await readFile(box.path("taken.txt"), "utf8"), "original");
  } finally {
    await box.cleanup();
  }
});

test("a cancelled upload leaves nothing behind", async () => {
  const box = await sandbox();
  try {
    const harness = channelHarness("upload", { path: box.root, name: "partial.bin" });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("half") }, harness.controller.signal);
    await channel.close?.({ code: 1000, reason: "cancelled", signal: harness.controller.signal });

    assert.deepEqual(await readdir(box.root), []);
  } finally {
    await box.cleanup();
  }
});

test("saves over an existing file and keeps its permissions", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("script.sh"), "#!/bin/sh\nold\n");
    await chmod(box.path("script.sh"), 0o640);
    const current = await stat(box.path("script.sh"));

    const harness = channelHarness("save.text", { path: box.path("script.sh"), expectedMtimeMs: current.mtimeMs });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("#!/bin/sh\nnew\n") }, harness.controller.signal);
    await channel.receive({ type: "end" }, harness.controller.signal);

    assert.equal(await readFile(box.path("script.sh"), "utf8"), "#!/bin/sh\nnew\n");
    assert.equal((await stat(box.path("script.sh"))).mode & 0o777, 0o640);
  } finally {
    await box.cleanup();
  }
});

test("refuses to save over a file that changed underneath the editor", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("note.txt"), "as opened");
    const current = await stat(box.path("note.txt"));

    const harness = channelHarness("save.text", { path: box.path("note.txt"), expectedMtimeMs: current.mtimeMs - 10_000 });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("clobber") }, harness.controller.signal);
    const error = framesOf(harness.frames).find((frame) => frame["type"] === "error");
    assert.equal(error?.["code"], "ECONFLICT");
    assert.equal(await readFile(box.path("note.txt"), "utf8"), "as opened");
  } finally {
    await box.cleanup();
  }
});

test("refuses to save a file that was removed since it was opened", async () => {
  const box = await sandbox();
  try {
    const harness = channelHarness("save.text", { path: box.path("gone.txt"), expectedMtimeMs: 1234 });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("text") }, harness.controller.signal);
    const error = framesOf(harness.frames).find((frame) => frame["type"] === "error");
    assert.equal(error?.["code"], "ECONFLICT");
  } finally {
    await box.cleanup();
  }
});

test("creates a new file when it was opened as one", async () => {
  const box = await sandbox();
  try {
    const harness = channelHarness("save.text", { path: box.path("fresh.txt"), expectedMtimeMs: null });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("new file") }, harness.controller.signal);
    await channel.receive({ type: "end" }, harness.controller.signal);
    assert.equal(await readFile(box.path("fresh.txt"), "utf8"), "new file");
  } finally {
    await box.cleanup();
  }
});

test("rejects a frame that is not valid base64", async () => {
  const box = await sandbox();
  try {
    const harness = channelHarness("upload", { path: box.root, name: "bad.bin" });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: "not base64!!" }, harness.controller.signal);
    const error = framesOf(harness.frames).find((frame) => frame["type"] === "error");
    assert.equal(error?.["code"], "EINVAL");
    assert.deepEqual(await readdir(box.root), []);
  } finally {
    await box.cleanup();
  }
});

test("replaces an existing file when the caller confirms an overwrite", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("uploaded.txt"), "old contents");
    await chmod(box.path("uploaded.txt"), 0o640);
    const harness = channelHarness("upload", { path: box.root, name: "uploaded.txt", overwrite: true });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("new contents") }, harness.controller.signal);
    await channel.receive({ type: "end" }, harness.controller.signal);

    assert.equal(await readFile(box.path("uploaded.txt"), "utf8"), "new contents");
    assert.equal((await stat(box.path("uploaded.txt"))).mode & 0o777, 0o640);
    assert.equal(framesOf(harness.frames).find((frame) => frame["type"] === "error"), undefined);
  } finally {
    await box.cleanup();
  }
});

test("saves anyway when the caller forces past a changed mtime", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("note.txt"), "on disk now");
    const harness = channelHarness("save.text", { path: box.path("note.txt"), expectedMtimeMs: 1, force: true });
    const channel = await openChannel(harness.context);
    await channel.receive({ type: "chunk", data: base64("what the editor saw") }, harness.controller.signal);
    await channel.receive({ type: "end" }, harness.controller.signal);

    assert.equal(await readFile(box.path("note.txt"), "utf8"), "what the editor saw");
    assert.equal(framesOf(harness.frames).find((frame) => frame["type"] === "error"), undefined);
  } finally {
    await box.cleanup();
  }
});
