# pi-web-file-manager

A general filesystem browser for PI WEB: browse anywhere the daemon's user can reach, look at files, and — as the later phases land — edit and reorganise them.

It exists because the bundled Files panel is rooted at the selected workspace, wraps inconsistently between view modes, and cannot rename, move or delete anything.

**Status: phase one, in progress.** The server half is complete and tested: listing, stat, read, mkdir, rename, delete with a count, chunked upload and save, file download, and directory zip. The panel browses with clickable breadcrumbs that double as an address bar, a `..` row, the host's file-type icons and row styling, and previews text and images. A toolbar menu creates folders and files, uploads, downloads the current folder as a zip, and toggles hidden files; each row has a menu for open, download, copy path, rename and delete. The editor, move, and directory-upload trees are the next phases. `PLAN.md` is the design record.

## Install

```sh
node scripts/install.js                     # -> $PI_WEB_DATA_DIR/packages/file-manager
node scripts/install.js /data/pi-web/packages
node scripts/install.js --dir /tmp/packages
```

The argument is the *packages directory*; the package itself lands in `<packages>/file-manager`. Installation builds first, replaces the destination whole, and refuses to delete a directory it does not recognise as a previous install of this package.

Then list it as a Pi package so PI WEB can discover it. **Settings → Pi packages** accepts a local source, or add the path — relative to the agent directory or absolute — to `packages` in the agent's `settings.json`:

```json
"../pi-web/packages/file-manager"
```

The `pi` field in `package.json` declares an empty `extensions` list on purpose: a
package that declares no Pi resources at all is registered by the agent as a
single extension pointing at the directory, which cannot be imported and fails
with `Cannot find module`. This package's value is its PI WEB plugin, not a Pi
extension.

Restart the session daemon and reload the page. A server-backed plugin is loaded by the daemon at start, so a browser reload alone will not pick it up; restarting interrupts live sessions and terminals, so choose a quiet moment. The panel appears as a **File manager** tab.

## Boundary

The plugin has no allowlist: it reaches every path the daemon's user can, the way a terminal does. That is deliberate, and it is the same trust the shell already has.

What it will not do, because none of these has a meaning worth confirming:

- follow a symlink when deleting — the link is removed, never its target;
- replace a file or directory silently — a conflict is reported so the user can say cancel, reload or replace;
- write anywhere through a shell — every operation is a `node:fs` call, made with no privilege escalation;
- rename or delete the filesystem root.

Temporaries from interrupted transfers are named `.<name>.fm-<uuid>`, hidden from listings, and swept when their directory is listed or by a ten-minute timer.

## Development

```sh
npm install
npm run build         # esbuild: browser bundle + server bundle
npm test              # node --test over the real filesystem
npm run typecheck
```

Source is TypeScript run directly by Node's type stripping and bundled by esbuild. Tests use only `node:test` and real temporary directories, so nothing has to be mocked to exercise a delete.
