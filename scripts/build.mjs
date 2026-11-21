import { build } from "esbuild";
import { rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("browser", { recursive: true, force: true });
await rm("server-plugin.js", { force: true });
// A build from before this name settled; leaving it would ship a second copy.
await rm("server-plugin.mjs", { force: true });
await rm("server-plugin.mjs.map", { force: true });

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
    // esbuild renders a CommonJS dependency's `require()` calls through its own
    // shim, which throws "Dynamic require of … is not supported" when the
    // bundle is imported as an ES module and no `require` is in scope. The
    // host imports this entry as ESM, so the bundle supplies a real one.
    banner: {
      js: 'import { createRequire as __fmCreateRequire } from "node:module"; const require = __fmCreateRequire(import.meta.url);',
    },
  }),
]);
