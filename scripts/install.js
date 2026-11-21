/**
 * Install this package into a PI WEB packages directory.
 *
 *   node scripts/install.js                      # $PI_WEB_DATA_DIR/packages
 *   node scripts/install.js /data/pi-web/packages
 *   node scripts/install.js --dir /tmp/packages
 *
 * The argument is the *packages directory*, not this package's directory inside
 * it: the destination is always `<packages>/<plugin id>`. The source tree is
 * canonical and the installed copy is output, so this replaces the destination
 * whole — but only after proving the destination is absent, empty, or a
 * previous install of this same package. It never deletes a directory it cannot
 * identify, and a failed copy leaves the previous install in place.
 *
 * The browser half is served from `browserRoot`, so the bundle has to exist in
 * the installed copy: this builds first, and refuses to install if the build
 * fails rather than copying a tree with no plugin code in it.
 */
import { cp, lstat, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packageName = manifest.name;
const pluginId = manifest.piWeb?.plugins?.[0]?.id;
if (typeof packageName !== "string" || typeof pluginId !== "string") {
  fail("the source package.json does not declare piWeb.plugins[0].id");
}

const packagesDirectory = resolve(selectArgument());
const destination = join(packagesDirectory, pluginId);

// ---- the argument must be a packages directory, and nothing else -------------

if (packagesDirectory === root) fail("that is the source tree, not a packages directory");
if (packagesDirectory.startsWith(`${root}/`)) fail("refusing to install inside the source tree");
if (await isFile(packagesDirectory)) fail(`${packagesDirectory} is a file, not a directory`);
if (await isOurs(packagesDirectory)) {
  fail(`${packagesDirectory} is a copy of this plugin, not the packages directory that contains it`);
}
if (!(await isDirectory(packagesDirectory))) fail(`${packagesDirectory} does not exist; pass the packages directory that contains ${pluginId}`);
if (basename(packagesDirectory) === pluginId) {
  fail(`${packagesDirectory} is already named ${pluginId}; pass its parent directory instead`);
}
if (basename(packagesDirectory) === "plugins") {
  fail(`${packagesDirectory} is a PI WEB plugins directory; a package that declares piWeb.plugins is installed under a packages directory and listed in Pi's packages, not copied into plugins`);
}
if (await isDirectory(join(packagesDirectory, "plugins"))) {
  fail(`${packagesDirectory} looks like the PI WEB data directory; pass a packages subdirectory, such as its "packages"`);
}

// ---- the destination must be absent, empty, or a previous install of ours ---

const existing = await lstatOrUndefined(destination);
if (existing !== undefined) {
  if (existing.isSymbolicLink()) fail(`${destination} is a symlink; replace it deliberately, then run this again`);
  if (!existing.isDirectory()) fail(`${destination} exists and is not a directory`);
  const entries = await readdir(destination);
  if (entries.length > 0 && !(await isOurs(destination))) {
    fail(`${destination} is not empty and is not an install of ${packageName}; refusing to delete it`);
  }
}

// ---- build before copying: the installed copy needs its bundles --------------

console.log("building…");
try {
  await run(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root });
} catch (error) {
  fail(`build failed, nothing installed: ${error instanceof Error ? error.message : String(error)}`);
}
for (const required of [join(root, "server-plugin.mjs"), join(root, "browser", manifest.piWeb.plugins[0].module.split("/").at(-1))]) {
  if (!(await isFile(required))) fail(`build produced no ${basename(required)}; nothing installed`);
}

// The daemon imports the server entry as an ES module. A bundle that only
// works from a CommonJS parent fails exactly here and nowhere else, so it is
// imported the way the host will import it before anything is installed.
console.log("verifying the server bundle imports as ESM…");
const probe = [
  "const m = await import(process.argv[1]);",
  "if (typeof m.default?.activate !== 'function') throw new Error('no activate export');",
  "const peer = m.default.activate().peer;",
  "for (const name of ['request', 'openChannel', 'resource']) if (typeof peer[name] !== 'function') throw new Error(`no ${name}`);",
  "console.log('ok');",
].join("\n");
try {
  await run(process.execPath, ["--input-type=module", "-e", probe, pathToFileURL(join(root, "server-plugin.mjs")).href]);
} catch (error) {
  fail(`the server bundle does not import as an ES module, nothing installed: ${String(error.stderr ?? error.message).trim()}`);
}

// ---- stage, then swap: a failed copy leaves the previous install intact -----

const staging = join(packagesDirectory, `.${pluginId}.incoming`);
const previous = join(packagesDirectory, `.${pluginId}.previous`);
await rm(staging, { recursive: true, force: true });
try {
  await cp(root, staging, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return name !== ".git" && name !== "node_modules" && name !== "test" && name !== ".github";
    },
  });
  await rm(previous, { recursive: true, force: true });
  if (existing !== undefined) await rename(destination, previous);
  await rename(staging, destination);
  await rm(previous, { recursive: true, force: true });
} catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  if (await isDirectory(previous)) await rename(previous, destination).catch(() => {});
  fail(`install failed: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`installed ${packageName} to ${destination}`);
console.log("next: list it in the agent's Pi packages, restart the session daemon, then reload the page");

function selectArgument() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node scripts/install.js [--dir] [packages-directory]");
    console.log(`default: ${defaultPackagesDirectory()}`);
    process.exit(0);
  }
  const flagIndex = args.findIndex((argument) => argument === "--dir" || argument === "--destination");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    if (value === undefined) fail("--dir needs a directory");
    return value;
  }
  const positional = args.find((argument) => !argument.startsWith("-"));
  return positional ?? defaultPackagesDirectory();
}

function defaultPackagesDirectory() {
  const dataDir = process.env["PI_WEB_DATA_DIR"];
  const base = dataDir !== undefined && dataDir.trim() !== "" ? dataDir : join(homedir(), ".pi-web");
  return join(base, "packages");
}

async function isOurs(directory) {
  try {
    const candidate = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return candidate.name === packageName
      && Array.isArray(candidate.piWeb?.plugins)
      && candidate.piWeb.plugins.some((plugin) => plugin?.id === pluginId);
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  const info = await stat(path).catch(() => undefined);
  return info?.isDirectory() === true;
}

async function isFile(path) {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() === true;
}

async function lstatOrUndefined(path) {
  return await lstat(path).catch(() => undefined);
}

function fail(message) {
  console.error(`install: ${message}`);
  process.exit(1);
}
