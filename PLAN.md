# pi-web-file-manager — design record

A PI WEB plugin that browses, previews, edits, and reorganises the machine's whole filesystem. It replaces the experience of Open WebUI's open-terminal sidebar, which the bundled Files panel cannot match: that panel is rooted at the selected workspace, wraps inconsistently between view modes, and cannot mutate anything.

This file records what the plugin is, why it is shaped this way, and what each part is responsible for. It is the spec the implementation is written against, and it is updated as decisions land.

## The load-bearing constraint

The browser-side file helpers a PI WEB panel receives (`listFiles`, `readFile`, `writeFile`, `moveFile`, `deleteFile`) are workspace-contained by design: the server rejects any path outside the workspace root, and explicit external roots only via `pathAccess.allowedPaths`.

A general file manager cannot be built on them. It is built instead on a **server half** that runs in sessiond as ordinary Node and uses `node:fs` directly, reached through a machine-scoped plugin backend:

- `request` for metadata operations and small payloads,
- `openChannel` for chunked content in both directions (upload, save),
- `resource` for streaming downloads, including a directory as a zip.

The plugin's reach is therefore the whole filesystem, with **no allowlist**. `pathAccess.allowedPaths` is a separate concern about what the *host's own* file API exposes; the file manager reaches any path a terminal can, and the user's own discretion governs destructive actions, exactly as it does in a terminal. Registering a project rooted at `/` is not an alternative: project registration inside real directory hierarchies carries meaning that a root project throws away.

## What the plugin refuses to do

Parity with a terminal is the goal, but four things stay true regardless:

- **No privilege escalation.** No `sudo`, no spawning `rm`/`mv`/`zip`, no shell at all. Every operation is a `node:fs` call made as the daemon's user.
- **No symlink-induced destruction.** Deleting a symlink unlinks the link. Recursive delete never traverses into a symlinked directory, so a link into `~` cannot turn "delete this folder" into "delete my home".
- **No silent overwrite, and no refusal without a way forward.** An open editor carries the mtime the file had when it was loaded; a save over a changed file offers cancel, reload from disk, or save anyway. A move or upload onto an existing name stops and asks — replace, keep both under a derived name, or cancel. The server enforces the *asking* (`force` and `overwrite` are explicit flag), not the answer: replacing a file deliberately is a legitimate thing to do.
- **No operation on `/` itself.** Renaming or deleting the filesystem root is refused before it becomes a catastrophe rather than after.

## Panel shape

A no-workspace **application panel**, so it is available with or without a project selected, and follows the selected machine. Title "File manager"; local contribution id `files`.

- Breadcrumbs double as an address bar: each segment navigates, and clicking the last one turns it into a text field holding the full path. There is no root switcher — every path is reachable, so shortcuts would only be a second, worse address bar. A `..` row opens the listing, which makes the parent reachable without a dedicated control.
- Icons and row styling come from the host, not from copies: the `file-icons` capability resolves each path through the user's chosen file-icon theme, and `stylesheet-integration` adopts the shared UI sheet, so rows are the same 32 px `ui-file-row` the bundled panels use.
- List rows with a per-row menu (open, download, copy path, rename, delete) and a folder-level menu (new folder, new file, upload, download as zip, show hidden files).
- Split view: list above, viewer/editor below, with a full-height toggle. Chosen over left/right because a side-by-side split is unusable on mobile.
- Soft-wrap is a single global toggle persisted per browser, applied identically to raw and highlighted views. The split state is persisted the same way. There is no per-file state.
- Deep-linkable: the current directory and selected file live in the panel's query namespace, so a path can be bookmarked or shared.
- Refresh is explicit rather than watched, so the panel never redraws under the user's cursor: a refresh control re-lists the current directory, and an open file whose mtime no longer matches disk offers to reload it.
- The list scrolls; it does not page. A directory is returned whole, subject to a protocol-level entry cap, and a truncated response says so rather than silently hiding entries.
- The panel remembers the directory open in each *session* for the life of the page: switching session and coming back restores it, and a reload starts at the workspace root again.

## Transfer and size policy

Host protocol limits shape the design; these are the numbers the implementation is written to.

| Path | Limit | Consequence |
| --- | --- | --- |
| `request` input | 256 KiB | metadata only, never file content |
| `request` output | 8 MiB | small listings and stats only |
| channel frame | 64 KiB | content moves in base64 chunks of 48 KiB |
| channel queue | 1 MiB | backpressure must be honoured, not ignored |
| resource selector | 4 KiB | download and zip identify by path only |
| resource stream | 30 min | zip streaming is bounded by time, not size |

So: file **content** always travels over channels or resources, never through `request`. Text opens for editing up to 2 MiB; larger files and binaries open read-only with a download link. A listing returns the whole directory up to 20 000 entries and reports `truncated` beyond that, because the list is scrolled rather than paged.

Interrupted transfers leave a temporary sibling (`.<name>.fm-<uuid>`) rather than a half-written file. Three things stop those accumulating: a cancelled or failed transfer unlinks its own temporary, listing a directory sweeps stale ones in it (which also covers a container that died mid-transfer, whose directories are next listed by a new process), and a ten-minute timer revisits the directories this daemon wrote into. Listing filters temporaries out regardless, so they are never shown as the user's files.

## Wire protocol

Operations are versioned by the package itself: the host pairs browser and server halves of the same package revision, so the two always agree. Each request returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`; codes are stable (`ENOENT`, `EACCES`, `EEXIST`, `ECONFLICT`, `EISDIR`, `ENOTDIR`, `EINVAL`, `ETOOBIG`, `EBINARY`, `ELOOP`).

Requests: `list`, `stat`, `readText` (base64 content), `mkdir`, `rename`, `deletePlan` (count first), `delete`, `copyPath` helper input? (no — path copying is browser-side string work).

Channels: `upload` (open with destination and expected size, then chunk frames, then done), `saveText` (open with path and expected mtime, chunks, done).

Resources: `download` (one file), `zip` (one directory tree, deflate, no symlink following).

## Phases

1. **Read.** Browse, breadcrumbs, go-to-path, paged listing, directory refresh, per-row and folder menus, text viewer, image/PDF/Markdown preview, download file, copy absolute path, copy workspace-relative path, hidden-files toggle, deep links, per-browser persistence.
2. **Edit.** CodeMirror with syntax highlighting and wrap toggle, save with conflict detection, reload-from-disk for a file that changed underneath the editor, dirty guard on navigation and unload, full-height toggle.

   Built: the editor surface, highlighting for the languages we ship grammars for (JavaScript/TypeScript, JSON, CSS, HTML, Markdown, Python, YAML, and the stream modes for shell, TOML and Dockerfile), wrap and full-height as per-browser preferences in the viewer menu, save with `Ctrl`/`Cmd`+`S` from anywhere in the panel, the changed-on-disk prompt with Reload from disk and Save anyway, and the discard prompt on navigation and page unload. Not built yet: a preview mode for Markdown, and PDF rendering.
3. **Mutate.** New file, new folder, rename, move (dialog) with a resolution step when the destination name is taken, delete with confirmation and item count, upload files, upload a directory tree, download a directory as zip.
4. **Polish.** Drag-and-drop move, in-directory filter, "open terminal here" if the Terminal plugin exposes a way to open a shell at an existing directory (otherwise dropped rather than hacked).

Each phase is usable on its own; nothing in an earlier phase depends on a later one landing.

## Testing

- Server half: `node --test` against real temporary directories — listing and paging, read limits and binary detection, write conflicts, rename across directories, recursive delete counts, symlink safety (link to a directory must not be traversed), zip contents verified by extracting, upload resumption and cancellation.
- Protocol: validation of malformed inputs, path normalization, and the error codes above.
- Browser half: pure functions (sorting, breadcrumb construction, path joins, dirty state) unit-tested; a smoke script that drives the panel against a fake backend.

## Packaging

Package `@house/pi-web-file-manager`, plugin id `file-manager`, installed into `$PI_WEB_DATA_DIR/packages/pi-web-file-manager` as one package serving both halves. Both halves are bundled with esbuild: the browser half inlines lit and CodeMirror and imports nothing bare at runtime; the server half is Node ESM with only `node:` builtins external. The canonical tree is this one.

## Open questions

- "Open terminal here" depends on a Terminal plugin hook that may not exist. Verify before phase 4; drop it if the only route is synthesising a command.
- Whether the list needs a virtualised scroller depends on how large a listing realistically gets; paging at 500 is the first answer, measured before adding more.
