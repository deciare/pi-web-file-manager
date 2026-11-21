# pi-web-file-manager

A general filesystem browser for PI WEB: browse anywhere the daemon's user can reach, look at files, and — as the later phases land — edit and reorganise them.

It exists because the bundled Files panel is rooted at the selected workspace, wraps inconsistently between view modes, and cannot rename, move or delete anything.

**Status: browsing, editing and mutation are in.** The server half covers listing, stat, read, mkdir, rename, delete with a count, chunked upload and save, file download, and directory zip. The panel browses with clickable breadcrumbs that double as an address bar, a `..` row, the host's file-type icons and row styling, and previews text, images, Markdown documents and PDFs. Text files open in an editor with syntax highlighting, explicit saving and conflict handling; Markdown opens as a rendered document with the source one menu item away. Rows can be renamed, moved through a destination picker, and deleted; folders can be created, uploaded into, and downloaded as a zip. Folder upload asks once about the whole batch when names collide — skip, keep newer, or replace — and lists the paths that collide as a tree. The polish items remain; `PLAN.md` is the design record.

## Install

```sh
node scripts/install.js                     # -> $PI_WEB_DATA_DIR/plugins/file-manager
node scripts/install.js /data/pi-web/plugins
node scripts/install.js --dir /tmp/plugins
```

The argument is the *plugins directory*; the plugin itself lands in `<plugins>/file-manager`. Installation builds first, replaces the destination whole, and refuses to delete a directory it does not recognise as a previous install of this plugin.

PI WEB discovers local plugins by reading `$PI_WEB_DATA_DIR/plugins`, so the directory has to be named `plugins` and the installed folder has to be named after the plugin id. Nothing else is needed: this is a PI WEB plugin with no Pi extension, so it is **not** a Pi package and does not go in the agent's package settings. Give it a Pi extension one day and that changes.

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
