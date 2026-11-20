import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import {
  deletePath, listDirectory, makeDirectory, planDelete, readTextFile, renamePath, statPath,
} from "../src/server/fsOps.ts";
import { TEXT_EDIT_MAX_BYTES } from "../src/shared/protocol.ts";
import { Failure } from "../src/server/failure.ts";
import { sandbox, decode } from "./support.ts";

test("lists directories first in natural order with metadata", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("zdir"));
    await mkdir(box.path("adir"));
    await writeFile(box.path("file10.txt"), "ten");
    await writeFile(box.path("file2.txt"), "two");

    const listing = await listDirectory({ path: box.root });
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["adir", "zdir", "file2.txt", "file10.txt"]);
    assert.equal(listing.total, 4);
    assert.equal(listing.parent, box.root.split("/").slice(0, -1).join("/") || "/");
    const file = listing.entries.find((entry) => entry.name === "file2.txt");
    assert.equal(file?.kind, "file");
    assert.equal(file?.size, 3);
    assert.ok((file?.mtimeMs ?? 0) > 0);
  } finally {
    await box.cleanup();
  }
});

test("pages a listing without losing the total", async () => {
  const box = await sandbox();
  try {
    for (let index = 0; index < 25; index += 1) await writeFile(box.path(`f${String(index).padStart(2, "0")}`), "x");
    const page = await listDirectory({ path: box.root, offset: 10, limit: 5 });
    assert.equal(page.entries.length, 5);
    assert.equal(page.total, 25);
    assert.equal(page.offset, 10);
    assert.deepEqual(page.entries.map((entry) => entry.name), ["f10", "f11", "f12", "f13", "f14"]);
  } finally {
    await box.cleanup();
  }
});

test("reports the filesystem root without a parent", async () => {
  const listing = await listDirectory({ path: "/" });
  assert.equal(listing.parent, null);
  assert.equal(listing.path, "/");
  assert.ok(listing.total > 0);
});

test("describes symlinks as links, including a broken one", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("target"));
    await writeFile(box.path("target/inside.txt"), "content");
    await symlink(box.path("target"), box.path("link-to-dir"));
    await symlink(box.path("missing"), box.path("broken"));

    const listing = await listDirectory({ path: box.root });
    const directoryLink = listing.entries.find((entry) => entry.name === "link-to-dir");
    assert.equal(directoryLink?.kind, "symlink");
    assert.equal(directoryLink?.linkKind, "directory");
    assert.equal(directoryLink?.linkBroken, undefined);
    assert.ok(directoryLink?.linkTarget?.endsWith("target"));

    const broken = listing.entries.find((entry) => entry.name === "broken");
    assert.equal(broken?.kind, "symlink");
    assert.equal(broken?.linkBroken, true);
  } finally {
    await box.cleanup();
  }
});

test("stat decides what can be edited", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("text.txt"), "hello");
    await writeFile(box.path("binary.bin"), Buffer.from([104, 105, 0, 106]));
    await writeFile(box.path("big.txt"), Buffer.alloc(TEXT_EDIT_MAX_BYTES + 1, 0x61));
    await mkdir(box.path("folder"));

    assert.equal((await statPath({ path: box.path("text.txt") })).editable, true);
    assert.equal((await statPath({ path: box.path("binary.bin") })).readOnlyReason, "binary");
    assert.equal((await statPath({ path: box.path("big.txt") })).readOnlyReason, "size");
    assert.equal((await statPath({ path: box.path("folder") })).readOnlyReason, "directory");
  } finally {
    await box.cleanup();
  }
});

test("reads text as base64 and refuses what is not editable", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("note.md"), "# title\n");
    await mkdir(box.path("folder"));
    await writeFile(box.path("binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(box.path("big.txt"), Buffer.alloc(TEXT_EDIT_MAX_BYTES + 1, 0x61));

    const read = await readTextFile({ path: box.path("note.md") });
    assert.equal(decode(read.data), "# title\n");
    assert.equal(read.size, 8);

    await assert.rejects(() => readTextFile({ path: box.path("folder") }), (error: unknown) => error instanceof Failure && error.code === "EISDIR");
    await assert.rejects(() => readTextFile({ path: box.path("binary.bin") }), (error: unknown) => error instanceof Failure && error.code === "EBINARY");
    await assert.rejects(() => readTextFile({ path: box.path("big.txt") }), (error: unknown) => error instanceof Failure && error.code === "ETOOBIG");
  } finally {
    await box.cleanup();
  }
});

test("creates one directory and reports an existing one", async () => {
  const box = await sandbox();
  try {
    await makeDirectory({ path: box.path("new") });
    assert.equal((await stat(box.path("new"))).isDirectory(), true);
    await assert.rejects(() => makeDirectory({ path: box.path("new") }), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
    await assert.rejects(() => makeDirectory({ path: box.path("missing/child") }), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await box.cleanup();
  }
});

test("renames and moves, refusing a silent overwrite", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("dest"));
    await writeFile(box.path("a.txt"), "a");
    await writeFile(box.path("dest/b.txt"), "b");

    await renamePath({ from: box.path("a.txt"), to: box.path("moved.txt") });
    assert.equal(await readFile(box.path("moved.txt"), "utf8"), "a");

    await renamePath({ from: box.path("moved.txt"), to: box.path("dest/moved.txt") });
    assert.equal(await readFile(box.path("dest/moved.txt"), "utf8"), "a");

    await assert.rejects(
      () => renamePath({ from: box.path("dest/moved.txt"), to: box.path("dest/b.txt") }),
      (error: unknown) => error instanceof Failure && error.code === "EEXIST",
    );
    assert.equal(await readFile(box.path("dest/b.txt"), "utf8"), "b");

    await renamePath({ from: box.path("dest/moved.txt"), to: box.path("dest/b.txt"), overwrite: true });
    assert.equal(await readFile(box.path("dest/b.txt"), "utf8"), "a");
  } finally {
    await box.cleanup();
  }
});

test("renames the same path only when nothing would move", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("a.txt"), "a");
    await assert.rejects(() => renamePath({ from: box.path("a.txt"), to: box.path("a.txt") }), (error: unknown) => error instanceof Failure && error.code === "EINVAL");
  } finally {
    await box.cleanup();
  }
});

test("refuses to rename or delete the filesystem root", async () => {
  await assert.rejects(() => renamePath({ from: "/", to: "/tmp" }), (error: unknown) => error instanceof Failure && error.code === "EINVAL");
  await assert.rejects(() => planDelete({ path: "/" }), (error: unknown) => error instanceof Failure && error.code === "EINVAL");
  await assert.rejects(() => deletePath({ path: "/", recursive: true }), (error: unknown) => error instanceof Failure && error.code === "EINVAL");
});

test("counts a recursive delete without following symlinks", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("tree/inner"), { recursive: true });
    await writeFile(box.path("tree/one.txt"), "12345");
    await writeFile(box.path("tree/inner/two.txt"), "abc");
    await mkdir(box.path("outside"));
    await writeFile(box.path("outside/keep.txt"), "keep");
    await symlink(box.path("outside"), box.path("tree/link"));

    const plan = await planDelete({ path: box.path("tree") });
    // tree, inner, two.txt, one.txt, link — the link is counted, its target is not.
    assert.equal(plan.kind, "directory");
    assert.equal(plan.entries, 5);
    assert.equal(plan.bytes, 5 + 3);

    await deletePath({ path: box.path("tree"), recursive: true });
    assert.equal((await stat(box.path("tree")).catch(() => undefined)), undefined);
    assert.equal(await readFile(box.path("outside/keep.txt"), "utf8"), "keep");
  } finally {
    await box.cleanup();
  }
});

test("deletes a symlink without touching its target", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("keep"));
    await writeFile(box.path("keep/file.txt"), "safe");
    await symlink(box.path("keep"), box.path("link"));

    await deletePath({ path: box.path("link") });
    assert.equal((await stat(box.path("link")).catch(() => undefined)), undefined);
    assert.equal(await readFile(box.path("keep/file.txt"), "utf8"), "safe");
  } finally {
    await box.cleanup();
  }
});

test("refuses to remove a non-empty directory without recursion", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("full"));
    await writeFile(box.path("full/child.txt"), "x");
    await assert.rejects(() => deletePath({ path: box.path("full") }), (error: unknown) => error instanceof Failure && error.code === "ENOTEMPTY");
    await deletePath({ path: box.path("full"), recursive: true });
  } finally {
    await box.cleanup();
  }
});

test("removes an empty directory without recursion", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("empty"));
    assert.deepEqual(await deletePath({ path: box.path("empty") }), { removed: 1 });
  } finally {
    await box.cleanup();
  }
});

test("keeps mtimes comparable for the editor's conflict check", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("file.txt"), "one");
    const first = await statPath({ path: box.path("file.txt") });
    await utimes(box.path("file.txt"), new Date(), new Date(Date.now() + 5000));
    const second = await statPath({ path: box.path("file.txt") });
    assert.notEqual(first.entry.mtimeMs, second.entry.mtimeMs);
  } finally {
    await box.cleanup();
  }
});

test("returns a whole directory in one response when no page is asked for", async () => {
  const box = await sandbox();
  try {
    for (let index = 0; index < 300; index += 1) await writeFile(box.path(`f${String(index).padStart(3, "0")}.txt`), "x");
    const listing = await listDirectory({ path: box.root });
    assert.equal(listing.entries.length, 300);
    assert.equal(listing.total, 300);
    assert.equal(listing.truncated, false);
  } finally {
    await box.cleanup();
  }
});

test("hides in-flight temporaries and sweeps the stale ones", async () => {
  const box = await sandbox();
  try {
    const { utimes, access } = await import("node:fs/promises");
    await writeFile(box.path("real.txt"), "real");
    const stale = box.path(".real.txt.fm-11111111-2222-3333-4444-555555555555");
    const fresh = box.path(".real.txt.fm-66666666-7777-8888-9999-000000000000");
    await writeFile(stale, "junk");
    await writeFile(fresh, "in flight");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const listing = await listDirectory({ path: box.root });
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["real.txt"]);

    // The sweep runs after the response; the stale temporary must disappear
    // without the caller having to ask, and the live one must survive.
    await waitForGone(stale);
    assert.equal(await readFile(fresh, "utf8"), "in flight");
    await assert.rejects(() => access(stale));
  } finally {
    await box.cleanup();
  }
});

async function waitForGone(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const present = await readFile(path).then(() => true, () => false);
    if (!present) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${path} was not swept`);
}
