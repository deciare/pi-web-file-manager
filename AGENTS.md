# AGENTS.md — pi-web-file-manager

Instructions for an agent changing this code. It assumes you know nothing about the project and cannot see the conversation that produced it.

## What this is

A PI WEB plugin that browses the machine's whole filesystem: listing, preview, editing, and mutation (create, rename, move, delete, upload, download, zip). It exists because PI WEB's bundled Files panel is rooted at the selected workspace and cannot mutate anything.

Two facts shape everything below.

**It is a PI WEB plugin and nothing else.** It has no Pi extension, so it is not a Pi package: there is no `pi` field in `package.json`, it is never added to the agent's package settings, and it is installed as `<pi-web data dir>/plugins/file-manager`. PI WEB discovers local plugins by reading that directory and takes the plugin id from the directory name and from `piWeb.plugins[0]` in `package.json`. A resource-less package directory registered as a Pi package gets picked up by the agent's package fallback and becomes one unloadable extension — that is the failure this shape avoids, so do not reintroduce a `pi` field "for completeness".

**It reaches the entire filesystem, by design.** There is no allowlist and no root switcher: every path the daemon's user can reach is reachable, exactly as a shell would reach it. Nothing in the panel should assume a workspace, a project, or an allowed-paths configuration.

## Layout

```
src/shared/protocol.ts     wire types, operation names, every size and count limit
src/server/index.ts        request dispatch; one handler per operation
src/server/fsOps.ts        listing, stat, read, mkdir, rename, delete
src/server/content.ts      chunked transfer in (upload, save)
src/server/resources.ts    bytes out (file download, directory zip)
src/server/temps.ts        temp-sibling naming and the sweeper
src/server/paths.ts        input path normalisation; the file's own doc comment explains its limits
src/server/failure.ts      Failure with a code and a human sentence
src/browser/index.ts       plugin manifest, capabilities, panel registration
src/browser/panel.ts       the panel element: state, rendering, dialogs, menus
src/browser/client.ts      typed client over the server half, response validation, chunking
src/browser/capabilities.ts  host capabilities as structural types: file icons, stylesheet, markdown
src/browser/breadcrumbs.ts   path helpers, DOM-free and unit-tested
src/browser/uploads.ts       upload planning: folders to create, collision policy, conflict tree; DOM-free
src/browser/editor.ts        CodeMirror element
src/browser/fileIcon.ts      file-type icon element
scripts/build.mjs          esbuild both halves
scripts/install.js         build and copy into a plugins directory
test/*.test.ts             node --test over real temporary directories
```

The records: `README.md` is the user-facing guide, `PLAN.md` is the design record (what the plugin does and why it is shaped this way), and this file is how to work on it. When a decision changes, the change lands in `PLAN.md` with its reasoning; `README.md` describes behaviour, never deployment state.

`panel.ts` is the only DOM-heavy file. Anything that can be a pure function goes in `breadcrumbs.ts` or `uploads.ts` so it can be tested without a browser.

## The wire

Three transports, and which one carries what is a rule, not a preference:

- **`request`** — small JSON in, small JSON out. Used for `list`, `stat`, `read.text`, `mkdir`, `rename`, `delete.plan`, `delete`. Its input cap is a few hundred kilobytes — smaller than one photo — so file *content* must never travel through it.
- **channel** (`openChannel`) — chunked transfer in one direction. `upload` (browser to server) and `save.text` (browser to server). Each frame is JSON with a base64 payload.
- **resource** — bytes out. `download` (one file) and `zip` (one directory tree), streamed rather than buffered.

Every response is an envelope: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Failures are returned, not thrown: the host turns a throw into a transport-level failure that the panel cannot distinguish from a lost connection. Codes are a closed list in `src/shared/protocol.ts`.

Operation names are lowercase and dotted (`read.text`, `delete.plan`, `save.text`) because the host validates them against `^[a-z][a-z0-9.-]*$` before the plugin sees them; a capital letter rejects the request outright.

**Limits live in `src/shared/protocol.ts` and are the source of truth.** Read them there rather than from prose, and keep the comments beside them: several encode a relationship rather than a number.

## Design decisions worth keeping

**Guards are shell parity, not policy.** The plugin refuses what a shell would refuse, plus what a shell does that a browser must not do silently: no operation on the filesystem root, no replacing a file or folder without being told to, no following a symlink when deleting (the link is removed, never its target), no shell, no privilege escalation. Every operation is a `node:fs` call under the daemon's own user.

**Conflicts are asked about, never silently resolved and never flatly refused.** The server enforces the *asking*: `overwrite` and `force` are explicit flags on the wire. What the answer should be is the user's business, so the server never decides it.

**Content is written to a temp sibling and published by rename.** Temporaries are named `.<name>.fm-<uuid>`, hidden from listings, swept when their directory is listed and by a timer. A cancelled or failed transfer leaves the destination exactly as it was.

**A big listing is scrolled, not paged.** One list, one pass, a cap that reports when it stopped short. Paging was considered and rejected: a pane that scrolls is what a file browser is.

**Transfers are chunked, and the chunk size is derived from the frame bound.** Base64 costs four thirds, so a chunk equal to the frame bound would fill the frame before its own fields are counted. Two transfer paths once disagreed about this — uploads chunked, saves did not — so **any new path that sends content must go through the same chunking helper** (`chunkBytes` in `src/browser/client.ts`).

**Progress frames are also acknowledgements.** The browser stops sending when it is a window's worth of bytes ahead of the last progress report, so the server's reporting cadence must stay inside that window. A cadence above it is a deadlock, not slowness: the browser waits for a report that only a new chunk would trigger. Both constants live beside each other in the protocol module for that reason.

**Binary detection checks signatures before heuristics.** Bytes with no NUL can still be a PDF whose streams happen to be printable; the sniff in `fsOps.ts` matches known file signatures first.

## Browser conventions

**Use the host's primitives; do not draw your own.** Buttons are `.ui-button` with `--compact`/`--icon` modifiers; bars are `.ui-toolbar` containing `.ui-toolbar-group`s; rows are `.ui-file-row` with `.ui-file-leading`, `.ui-file-label`, optional `.ui-file-meta`, and indentation through the `--depth` custom property; icons come from the `file-icons` capability and styles from `stylesheet-integration` with `sharedUi: true`. Copying pixel values or artwork drifts the moment the host changes; asking the host gives the running frontend's own answer.

**A border belongs to the control it precedes, never to a wrapper.** A group border marks a boundary between groups, so it lands wherever the group's first child happens to sit — correct only by coincidence. When two bars hold the same kind of controls, build them the same way and let one rule set describe both.

**Colours and type come from theme custom properties** (`--pi-*`), never literals.

**State that must survive a tab switch lives at module scope.** The host destroys the panel element when another tab is selected, so an instance field would forget it. The per-session directory memory is the example, and it is written *only* by user navigation: automatic opens pass a flag rather than recording.

**Prompt on the way through, not after.** Unsaved edits guard navigation and page unload; a save over a changed file offers cancel, reload, save anyway; a batch upload asks once with the collisions listed. Dialogs restore focus when they close, because a closed dialog takes the keyboard with it.

**Read host state through capabilities.** A missing capability should be reported by the host rather than papered over, and optional ones are read as `undefined` and degrade to the plain fallback (a Markdown file opens as source when the host has no renderer).

## Server conventions

- Validate every input at the boundary; nothing arriving over the wire can be assumed to be shaped as sent.
- Speak in `Failure(code, message)` with a message written for a person: the panel shows it verbatim, so an errno and a syscall name are noise.
- Never resolve a path with `path.resolve` alone: inputs may be relative, may contain `~`, and may try to escape; `paths.ts` is the only place that decides.
- Long-running work belongs in a channel or a resource, never in a request.
- Do not record deployment state anywhere: not in this file, not in `README.md`, not in comments. Documentation says what the code does, never whether it is currently installed, enabled or live.

## Testing

```sh
npm install       # once; dev dependencies only, nothing ships from node_modules
npm test          # node --test test/*.test.ts, real temp directories
npm run typecheck # tsc, strict with noUncheckedIndexedAccess and exactOptionalPropertyTypes
npm run build     # esbuild both halves
```

What each layer's tests actually prove:

- `fsOps`, `paths`, `content`, `resources`, `plugin` drive the **server** half directly. They are the place for filesystem behaviour, conflict rules, symlink safety, transfer framing at the receiving end.
- `breadcrumbs`, `uploads`, `protocol` are pure-function tests. Anything about **what the client puts on the wire** — chunk sizes against the frame bound, the shape of an upload plan, the collision policy — belongs here, because server tests feed ready-made frames and would not notice a client that builds them wrongly.
- Nothing in this repository drives the real UI. The panel, the dialogs, and the CSS are verified by running a PI WEB instance and driving the browser against it; do that before claiming a visual or interaction change works, and check geometry by measurement rather than by eye.

A build of a browser change reaches the page on reload. A change to the server half is loaded when the session daemon starts, so it needs that daemon restarted; the installer does not do this for you and nothing in the tree should attempt it.

## Conventions

- TypeScript, checked by the flags above. No `any`; narrow unknown values at the boundary.
- Comments explain **why**, and record the trap they prevent. A comment that restates the code is noise; a comment that says "this was once wrong this way" is the most valuable line in the file.
- Custom elements carry an `fm-` prefix, or the panel's own long tag name, so they cannot collide with the host's.
- Prefer changing an existing mechanism over adding a second one. Two implementations of the same widget in one panel is how a pixel drifts for an hour.
- Commit only the files you changed, by explicit path. Never `git add -A`: working trees here carry untracked scratch files on purpose.
- Commit messages and code name no people. Describe the change and the reasoning; attribution belongs elsewhere.

## Adding a feature

A new request operation touches: `src/shared/protocol.ts` (types, operation name, limits), a handler in `src/server/fsOps.ts` and its registration in `src/server/index.ts`, a validated method in `src/browser/client.ts`, the call site in `panel.ts`, tests on both sides of that boundary, and `PLAN.md` if it changes a decision.

A new transfer path touches: the chunking helper in `client.ts`, the sink in `src/server/content.ts`, and a test asserting that a full chunk still fits the frame bound.

A new preview type touches: `panel.ts` only, unless it needs bytes the plugin does not already serve. Prefer a host capability over a bundled renderer: a preview drawn by the host is parsed, styled and policed by the host.
