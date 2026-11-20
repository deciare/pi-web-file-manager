import { build } from "esbuild";
import { rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("browser", { recursive: true, force: true });
await rm("server-plugin.js", { force: true });

/**
 * Both halves are bundled so the installed package has no bare specifiers to
 * resolve at runtime: the host imports each entry as a plain ES module from a
 * URL, with no import map and no node_modules next to it.
 *
 * The browser half inlines lit and CodeMirror. The server half is Node ESM and
 * keeps `node:` builtins external, which `platform: "node"` does by default.
 */
const common = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  sourcemap: true,
  logLevel: "info",
  ...(watch ? {} : { minify: false }),
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/browser/index.ts"],
    outfile: "browser/pi-web-plugin.js",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    ...common,
    entryPoints: ["src/server/index.ts"],
    outfile: "server-plugin.js",
    platform: "node",
  }),
]);
