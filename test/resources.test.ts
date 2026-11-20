import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resource } from "../src/server/index.ts";
import { Failure } from "../src/server/failure.ts";
import { collect, sandbox } from "./support.ts";

const run = promisify(execFile);

function context(operation: string, path: string, signal = new AbortController().signal) {
  return { operation, input: { path }, signal };
}

test("downloads a file with a type the browser can use", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("note.md"), "# heading\n");
    const response = await resource(context("download", box.path("note.md")));
    assert.equal(response.contentType, "text/markdown; charset=utf-8");
    assert.equal(response.contentLength, 10);
    assert.equal((await collect(response.body)).toString(), "# heading\n");
  } finally {
    await box.cleanup();
  }
});

test("downloads an empty file without a stream", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("empty.txt"), "");
    const response = await resource(context("download", box.path("empty.txt")));
    assert.equal(response.contentLength, 0);
    assert.equal((await collect(response.body)).length, 0);
  } finally {
    await box.cleanup();
  }
});

test("refuses to download a directory as a file", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("folder"));
    await assert.rejects(
      () => resource(context("download", box.path("folder"))),
      (error: unknown) => error instanceof Failure && error.code === "EINVAL",
    );
  } finally {
    await box.cleanup();
  }
});

test("zips a directory tree, skipping symlinks", async () => {
  const box = await sandbox();
  try {
    await mkdir(box.path("site/assets"), { recursive: true });
    await mkdir(box.path("site/empty"));
    await writeFile(box.path("site/index.html"), "<h1>hi</h1>");
    await writeFile(box.path("site/assets/app.js"), "console.log(1)");
    await writeFile(box.path("outside.txt"), "not in the zip");
    await symlink(box.path("outside.txt"), box.path("site/link.txt"));

    const response = await resource(context("zip", box.path("site")));
    assert.equal(response.contentType, "application/zip");
    const bytes = await collect(response.body);
    const archive = box.path("out.zip");
    await writeFile(archive, bytes);

    const script = [
      "import json, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "print(json.dumps({'names': sorted(z.namelist()), 'index': z.read('site/index.html').decode()}))",
    ].join("\n");
    const { stdout } = await run("python3", ["-c", script, archive]);
    const parsed = JSON.parse(stdout) as { names: string[]; index: string };
    assert.deepEqual(parsed.names, ["site/assets/", "site/assets/app.js", "site/empty/", "site/index.html"]);
    assert.equal(parsed.index, "<h1>hi</h1>");
  } finally {
    await box.cleanup();
  }
});

test("refuses to zip a file", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.path("file.txt"), "x");
    await assert.rejects(
      () => resource(context("zip", box.path("file.txt"))),
      (error: unknown) => error instanceof Failure && error.code === "ENOTDIR",
    );
  } finally {
    await box.cleanup();
  }
});
