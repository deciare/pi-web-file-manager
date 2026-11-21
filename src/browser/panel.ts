import { LitElement, css, html } from "lit";
import type { FileEntry } from "../shared/protocol.ts";
import type { PanelContext, SelectionService, SelectionSnapshot } from "./pluginApi.ts";
import { clientFor, fromBase64, type FileManagerClient } from "./client.ts";
import { hostCapabilities } from "./capabilities.ts";
import { defineFileTypeIcon, folderIcon, resolveIcon } from "./fileIcon.ts";
import { FileEditor, defineFileEditor } from "./editor.ts";
import {
  baseName, breadcrumbSegments, formatSize, isHiddenName, joinPath, parentPath, relativeToRoot, resolveAddress,
} from "./breadcrumbs.ts";
import {
  conflictTree, directoriesToCreate, parentRelative, treeRows, uploadAction,
  type UploadItem, type UploadPolicy,
} from "./uploads.ts";

/**
 * The browse panel.
 *
 * The list is one vertically scrolling region rather than pages, opened by a
 * `..` row and by breadcrumbs that double as an address bar. There is no root
 * switcher — every path is reachable, so a list of shortcuts would only be a
 * second, worse address bar.
 *
 * Which directory was open is remembered per session in this page's memory
 * only. That memory lives at module scope rather than on the element, because
 * the host destroys this panel when another tab is selected: keeping it on the
 * instance lost the directory every time Terminal was opened.
 */

export const PANEL_TAG = "pi-web-file-manager-panel";

/** How long a selection burst is allowed to settle before the panel acts on it. */
const RECONCILE_DELAY_MS = 120;

export function defineFileManagerPanel(): void {
  defineFileTypeIcon();
  defineFileEditor();
  if (customElements.get(PANEL_TAG) === undefined) customElements.define(PANEL_TAG, FileManagerPanel);
}

/** Per-session directory, for the lifetime of this page. Not persisted. */
const rememberedDirectories = new Map<string, string>();

const HIDDEN_PREFERENCE_KEY = "pi-web.file-manager.show-hidden";
const WRAP_PREFERENCE_KEY = "pi-web.file-manager.wrap";
const FULL_HEIGHT_KEY = "pi-web.file-manager.full-height";
const MARKDOWN_PREVIEW_KEY = "pi-web.file-manager.markdown-preview";
/** Rows drawn in the conflict tree before it stops and says how many are left. */
const CONFLICT_TREE_MAX_ROWS = 500;

interface Preview {
  readonly entry: FileEntry;
  readonly text?: string;
  /** The file's modification time when it was read, for save conflicts. */
  readonly mtimeMs?: number;
  readonly previewUrl?: string;
  readonly readOnlyReason?: "size" | "binary" | "directory";
  readonly error?: string;
}

interface DeletePlan {
  readonly entries: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** What kind of thing is in the way, as far as the reader is concerned. */
type ConflictKind = "file" | "folder";

function kindOf(entry: FileEntry): ConflictKind {
  return entry.kind === "directory" || entry.linkKind === "directory" ? "folder" : "file";
}

/**
 * Only a file can replace a file. A folder cannot stand in for a file or the
 * reverse — the kernel refuses both — and replacing a folder would mean
 * deleting a tree, which is the user's decision to make, not a button's.
 */
function isReplaceable(source: ConflictKind, destination: ConflictKind): boolean {
  return source === "file" && destination === "file";
}

type DialogState =
  | { readonly kind: "newFolder"; readonly draft: string; readonly error?: string | undefined; readonly blockedName?: string | undefined }
  | { readonly kind: "newFile"; readonly draft: string; readonly error?: string | undefined; readonly blockedName?: string | undefined }
  | {
    readonly kind: "rename";
    readonly entry: FileEntry;
    readonly draft: string;
    readonly error?: string | undefined;
    /** The new name is taken; offer to replace instead of refusing. */
    readonly canReplace?: boolean | undefined;
    readonly conflictKind?: ConflictKind | undefined;
    /** The name that is taken, so the action stays disabled until it changes. */
    readonly blockedName?: string | undefined;
  }
  | { readonly kind: "delete"; readonly entry: FileEntry; readonly plan: DeletePlan; readonly error?: string }
  | {
    readonly kind: "uploadBatch";
    readonly total: number;
    /** The items whose destination name is already taken, as paths under the browsed folder. */
    readonly conflicts: readonly string[];
  }
  | {
    readonly kind: "save";
    readonly entry: FileEntry;
    readonly message: string;
    /** The file changed underneath; offer to overwrite it anyway. */
    readonly conflicted: boolean;
  }
  | { readonly kind: "discard"; readonly entry?: FileEntry }
  | {
    readonly kind: "move";
    readonly entry: FileEntry;
    /** The folder being browsed as the destination. */
    readonly directory: string;
    /** Undefined while the folder is loading. */
    readonly directories?: FileEntry[] | undefined;
    readonly error?: string | undefined;
    /** The destination name is taken; offer to replace instead of refusing. */
    readonly canReplace?: boolean | undefined;
    readonly conflictKind?: ConflictKind | undefined;
  };

interface MenuState {
  readonly x: number;
  readonly y: number;
  /** Undefined for the toolbar menu, set for a row menu. */
  readonly entry?: FileEntry;
  /** The viewer's own menu, which acts on the open file. */
  readonly viewer?: boolean;
}

export class FileManagerPanel extends LitElement {
  static override styles = css`
    :host { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--pi-text); background: var(--pi-bg); font-size: 13px; }
    .toolbar { gap: 0; border-bottom: 1px solid var(--pi-border-muted); }
    /* The host draws a toolbar group's leading edge, which marks a boundary
       between groups rather than the control that follows it. Here the border
       belongs to the control: the first button in a group carries it, so both
       rows are separated by buttons and by nothing else. */
    .toolbar > .ui-toolbar-group { border-inline-start: 0; }
    .toolbar > .ui-toolbar-group > .ui-button:first-child { border-inline-start: 1px solid var(--pi-border-muted); }
    .breadcrumbs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; cursor: text; align-self: stretch; }
    .crumb { flex: 0 0 auto; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); padding: 3px 5px; font: inherit; font-family: var(--pi-mono, ui-monospace, monospace); cursor: pointer; }
    .crumb:hover { background: var(--pi-surface); color: var(--pi-text); }
    .crumb.current { color: var(--pi-text); }
    .separator { flex: 0 0 auto; color: var(--pi-dim); }
    /* .ui-input scaled to a 32px toolbar row: the field fills the row from the
       panel edge to the first button, so there is no seam to look unfinished. */
    .address.ui-input { flex: 1 1 auto; align-self: stretch; width: auto; min-width: 0; min-height: 0; height: auto; border: 0; border-radius: 0; background: var(--pi-bg); color: var(--pi-text); padding: 0 10px; font: 13px/1.4 var(--pi-mono, ui-monospace, monospace); direction: ltr; }
    .address.ui-input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    /* One column that cannot grow past the panel: an unwrapped line inside the
       editor must scroll within its own box, not stretch the header out of view.
       Rows depend on whether anything is open: a viewer with no file in it is
       dead space, and full height means the file instead of the listing. */
    main { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
    main.alone { grid-template-rows: minmax(0, 1fr); }
    main.split { grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); }
    main.full { grid-template-rows: minmax(0, 1fr); }
    main.full .list { display: none; }
    .list, .viewer { min-width: 0; }
    .viewer-body.editing { overflow: hidden; display: flex; min-height: 0; }
    /* The host's document renderer supplies the typography; this is only the
       frame, so a long document scrolls inside the panel instead of resizing it. */
    .viewer-body.document { overflow: auto; min-height: 0; padding: 4px 16px 16px; }
    .viewer-body embed.pdf { display: block; flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; border: 0; background: var(--pi-bg); }
    fm-editor { flex: 1 1 auto; min-width: 0; min-height: 0; }
    .viewer-head .dirty-dot { color: var(--pi-warning); padding-inline-end: 6px; }
    .list { overflow: auto; min-height: 0; border-bottom: 1px solid var(--pi-border); }
    .row-wrap { position: relative; }
    .row-wrap .ui-button.ui-file-row { width: 100%; padding-inline-end: 34px; }
    .row-more { position: absolute; inset-inline-end: 0; top: 50%; transform: translateY(-50%); opacity: 0; }
    .row-wrap:hover .row-more, .row-more:focus-visible, .row-wrap.menu-open .row-more { opacity: 1; }
    @media (pointer: coarse) { .row-more { opacity: 1; } }
    .viewer { display: flex; flex-direction: column; min-height: 0; }
    .viewer-head { min-height: 32px; }
    /* Centred on itself, like the size label: the row stretches its children, and
       a stretched one-line box puts its text against the top edge. */
    .viewer-head strong { flex: 1 1 auto; align-self: center; min-width: 0; padding-inline-start: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
    /* A rule after it, so the close button reads as a control rather than as
       part of the file name that follows. */
    .viewer-head .close { width: 32px; min-width: 32px; border-inline-end: 1px solid var(--pi-border-muted); }
    /* Both bars are the same object built the same way: a ui-toolbar holding
       ui-toolbar-groups, so one set of rules above describes the separators in
       both. What the file bar adds is text between two groups, which is why its
       close button ends with a rule the address bar has no equivalent for. */
    .viewer-actions { flex: 0 1 auto; min-width: 0; max-width: 100%; }
    .viewer-actions small { align-self: center; padding-inline: 8px; color: var(--pi-muted); font: 12px/20px var(--pi-font, system-ui, sans-serif); }
    .viewer-actions .ui-button--icon { width: 32px; min-width: 32px; }
    .viewer-actions .ui-button:hover:not(:disabled) { background: var(--pi-surface-hover); color: var(--pi-text); }
    .viewer-actions .ui-button:disabled { opacity: 0.5; cursor: default; }
    .viewer-body { flex: 1; overflow: auto; min-height: 0; }
    pre { margin: 0; padding: 10px; font-family: var(--pi-mono, monospace); font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    img.preview { max-width: 100%; display: block; margin: 10px auto; }
    .notice { padding: 12px; color: var(--pi-muted); }
    .error { color: var(--pi-danger); }
    .truncated { padding: 6px 10px; color: var(--pi-dim); }
    .leading { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--pi-muted); }
    .menu { position: fixed; z-index: 40; min-width: 190px; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg-overlay, var(--pi-surface)); box-shadow: 0 10px 30px var(--pi-shadow, rgba(0, 0, 0, 0.4)); }
    .menu button { display: block; width: 100%; border: 0; border-radius: 5px; background: none; color: var(--pi-text); padding: 7px 9px; text-align: start; font: inherit; white-space: nowrap; cursor: pointer; }
    .menu button:hover, .menu button:focus-visible { background: var(--pi-surface-hover, var(--pi-surface)); outline: none; }
    .menu button.danger { color: var(--pi-danger); }
    .menu hr { margin: 4px 2px; border: 0; border-top: 1px solid var(--pi-border-muted); }
    dialog.dialog { box-sizing: border-box; width: min(420px, calc(100vw - 32px)); padding: 16px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); color: var(--pi-text); }
    dialog.dialog h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
    dialog.dialog p { margin: 0 0 12px; color: var(--pi-muted); }
    dialog.dialog input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; }
    dialog.dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    dialog.dialog .dialog-error { margin: 8px 0 0; color: var(--pi-danger); }
    dialog.dialog button { font: inherit; border-radius: 6px; border: 1px solid var(--pi-border); background: var(--pi-surface); color: var(--pi-text); padding: 6px 12px; cursor: pointer; }
    dialog.dialog button[disabled] { opacity: 0.5; cursor: not-allowed; }
    dialog.dialog button.primary { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-accent-contrast, #06121a); }
    dialog.dialog button.danger { border-color: var(--pi-danger); background: var(--pi-danger); color: #fff; }
    dialog.dialog.move-dialog, dialog.dialog.upload-dialog { width: min(480px, calc(100vw - 32px)); }
    /* The rows are the host's file rows, so a conflicting path reads like a
       listing does; only the frame around them is ours. */
    .upload-list { max-height: min(400px, 50vh); overflow-y: auto; border: 1px solid var(--pi-border-muted); border-radius: 8px; margin: 0 0 4px; }
    .upload-list .ui-file-row { cursor: default; }
    .move-path { margin: 0 0 8px; color: var(--pi-muted); font: 12px var(--pi-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
    .move-list { max-height: min(320px, 45vh); overflow-y: auto; border: 1px solid var(--pi-border-muted); border-radius: 8px; }
    dialog.dialog .move-row { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; border-radius: 0; background: none; color: var(--pi-text); padding: 7px 9px; text-align: start; }
    dialog.dialog .move-row:hover, dialog.dialog .move-row:focus-visible { background: var(--pi-surface-hover, var(--pi-surface)); outline: none; }
    dialog.dialog .move-row[disabled] { color: var(--pi-dim, var(--pi-muted)); cursor: not-allowed; opacity: 0.55; }
    dialog.dialog .move-row[disabled]:hover { background: none; }
    .move-hint { margin: 8px 0 0; color: var(--pi-muted); }
    .status-stack { position: absolute; inset-inline-end: 10px; bottom: 10px; z-index: 20; display: grid; gap: 6px; justify-items: end; pointer-events: none; }
    .status { max-width: min(420px, 80%); border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-bg-overlay, var(--pi-surface)); box-shadow: 0 6px 18px var(--pi-shadow, rgba(0, 0, 0, 0.35)); color: var(--pi-text); padding: 5px 10px; font-size: 12px; }
  `;

  #context: PanelContext | undefined;
  #selectionService: SelectionService | undefined;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeIcons: (() => void) | undefined;
  #client: FileManagerClient | undefined;
  #directory: string | undefined;
  #parent: string | null = null;
  #entries: FileEntry[] = [];
  #total = 0;
  #truncated = false;
  #loading = false;
  #error: string | undefined;
  #status: string | undefined;
  #statusTimer: ReturnType<typeof setTimeout> | undefined;
  #preview: Preview | undefined;
  #controller: AbortController | undefined;
  #key: string | undefined;
  #machineScope: string | undefined;
  #pendingReconcile: ReturnType<typeof setTimeout> | undefined;
  #workspaceId = "";
  /** The root that "relative" is measured from: the workspace the panel is in. */
  #workspaceRoot: string | undefined;
  #startScheduled = false;
  #editing = false;
  #draft = "";
  #menu: MenuState | undefined;
  #dialog: DialogState | undefined;
  #showHidden = readHiddenPreference();
  #wrap = readToggle(WRAP_PREFERENCE_KEY, true);
  #fullHeight = readToggle(FULL_HEIGHT_KEY, false);
  /** Markdown opens as a document; the source is one menu item away. */
  #markdownPreview = readToggle(MARKDOWN_PREVIEW_KEY, true);
  #dirty = false;
  #saving = false;
  /** The text as it was when read or last saved: the baseline for "changed". */
  #savedText: string | undefined;
  /** What to do once the user agrees to lose their edits. */
  #pendingNavigation: (() => void) | undefined;
  #uploading: {
    readonly name: string;
    readonly received: number;
    readonly total: number;
    /** Position in the batch, so a long upload says how far along it is. */
    readonly index: number;
    readonly count: number;
  } | undefined;

  constructor() {
    super();
    // Adopts the host's shared UI sheet into this shadow root: compact buttons,
    // the toolbar, and the 32px file rows that the bundled panels use.
    hostCapabilities().styles?.createController(this, { sharedUi: true });
    // Icons resolve through the user's file-icon theme, which loads after the
    // first render; re-render when it does, or every file keeps the fallback.
    this.#unsubscribeIcons = hostCapabilities().icons?.subscribe(() => { this.requestUpdate(); });
  }

  get context(): PanelContext | undefined {
    return this.#context;
  }

  set context(value: PanelContext | undefined) {
    this.#context = value;
    this.#scheduleStart();
  }

  get selectionService(): SelectionService | undefined {
    return this.#selectionService;
  }

  set selectionService(value: SelectionService | undefined) {
    this.#selectionService = value;
    this.#scheduleStart();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    // Save works wherever the focus is in the panel. CodeMirror's own binding
    // only covers the editor, and the user's attention is on the Save button
    // exactly when it matters least.
    document.addEventListener("keydown", this.#onDocumentKeyDown, true);
    document.addEventListener("pointerdown", this.#onDocumentPointerDown, true);
    this.#scheduleStart();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    document.removeEventListener("keydown", this.#onDocumentKeyDown, true);
    document.removeEventListener("pointerdown", this.#onDocumentPointerDown, true);
    if (this.#pendingReconcile !== undefined) { clearTimeout(this.#pendingReconcile); this.#pendingReconcile = undefined; }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeIcons?.();
    this.#unsubscribeIcons = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    super.disconnectedCallback();
  }

  override updated(): void {
    const input = this.renderRoot.querySelector<HTMLInputElement>(".address");
    const root = this.renderRoot as ShadowRoot;
    if (input !== null && root.activeElement !== input) {
      input.focus();
      input.select();
    }
    const dialog = this.renderRoot.querySelector<HTMLDialogElement>("dialog.dialog");
    if (this.#dialog !== undefined) {
      if (dialog !== null && !dialog.open) dialog.showModal();
    } else if (dialog?.open === true) {
      dialog.close();
    }
  }

  readonly #onDocumentPointerDown = (event: Event): void => {
    if (this.#menu === undefined) return;
    const path = event.composedPath();
    const menu = this.renderRoot.querySelector(".menu");
    if (menu !== null && path.includes(menu)) return;
    this.#menu = undefined;
    this.requestUpdate();
  };

  #scheduleStart(): void {
    if (!this.isConnected || this.#startScheduled) return;
    this.#startScheduled = true;
    queueMicrotask(() => {
      this.#startScheduled = false;
      void this.#start();
    });
  }

  async #start(): Promise<void> {
    // The client is machine-scoped, and a workspace or session change is
    // handled by the selection subscription. Re-initialising here on every
    // context assignment — which the host makes on each render, and several
    // times during a responsive layout change — aborted the current listing and
    // started another, flickering the toolbar and the list.
    const machine = this.#context?.machine.id ?? "";
    if (this.#client !== undefined && machine === this.#machineScope) {
      this.#ensureSubscription();
      this.#onSelectionChanged();
      return;
    }
    this.#machineScope = machine;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#controller?.abort();
    this.#client = undefined;
    try {
      this.#client = this.#context === undefined ? undefined : clientFor(this.#context);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
      return;
    }
    const snapshot = this.#selectionService?.getSnapshot();
    const workspace = this.#context?.workspace;
    if (snapshot !== undefined && hasSelection(snapshot) && selectionMatchesContext(this.#context, snapshot)) {
      this.#workspaceId = snapshot.selectedWorkspace?.id ?? "";
      this.#workspaceRoot = this.#context?.workspace?.path ?? snapshot.selectedWorkspace?.path ?? snapshot.selectedSession?.cwd;
      this.#key = keyFor(this.#context, snapshot);
      await this.#openFor(this.#key, snapshot);
    } else if (workspace !== undefined) {
      // A panel with a workspace opens at that workspace, even if the selection
      // service has not caught up yet.
      this.#workspaceId = workspace.id;
      this.#workspaceRoot = workspace.path;
      this.#key = `workspace:${workspace.id}`;
      await this.#openDirectory(workspace.path, false);
    } else {
      await this.#openDirectory("~", false);
    }
    this.#ensureSubscription();
  }

  /** Subscribe once per connected panel; disconnection releases the listener. */
  #ensureSubscription(): void {
    const selection = this.#selectionService;
    if (selection === undefined || this.#unsubscribe !== undefined) return;
    this.#unsubscribe = selection.subscribe(() => { this.#onSelectionChanged(); });
  }

  /**
   * Selection arrives in bursts: switching projects clears the workspace and
   * session, then restores them, and the panel's context can briefly describe
   * the project that was left. Acting on each step opened several directories
   * in a row and wrote the wrong one into a session's memory. The burst is
   * collapsed by scheduling one reconciliation and reading the state at the
   * moment it runs.
   */
  #onSelectionChanged(): void {
    if (this.#pendingReconcile !== undefined) clearTimeout(this.#pendingReconcile);
    this.#pendingReconcile = setTimeout(() => {
      this.#pendingReconcile = undefined;
      this.#reconcileSelection();
    }, RECONCILE_DELAY_MS);
  }

  #reconcileSelection(): void {
    const snapshot = this.#selectionService?.getSnapshot();
    if (snapshot === undefined || !hasSelection(snapshot) || !selectionMatchesContext(this.#context, snapshot)) return;
    const key = keyFor(this.#context, snapshot);
    if (key === this.#key) return;
    const target = this.#targetFor(key, snapshot);
    if (this.#directory !== undefined && this.#key !== undefined) {
      rememberedDirectories.set(this.#key, this.#directory);
    }
    this.#key = key;
    this.#workspaceId = snapshot.selectedWorkspace?.id ?? "";
    this.#workspaceRoot = this.#context?.workspace?.path ?? snapshot.selectedWorkspace?.path ?? snapshot.selectedSession?.cwd;
    void this.#openFor(key, snapshot);
    if (target === this.#directory) this.requestUpdate();
  }

  /** The directory a session or workspace should open at. */
  #targetFor(key: string | undefined, snapshot: SelectionSnapshot | undefined): string {
    const remembered = key === undefined ? undefined : rememberedDirectories.get(key);
    const workspacePath = snapshot?.selectedWorkspace?.path ?? this.#context?.workspace?.path;
    return remembered ?? workspacePath ?? "~";
  }

  async #openFor(key: string | undefined, snapshot: SelectionSnapshot | undefined): Promise<void> {
    const target = this.#targetFor(key, snapshot);
    // Re-opening the directory already on screen would only cost a request and
    // a redraw, and the selection can arrive in more than one step.
    if (target === this.#directory) return;
    await this.#openDirectory(target, false);
  }

  async #openDirectory(path: string, remember = true, confirm = true): Promise<void> {
    if (confirm && this.#dirty) {
      this.#askDiscard(() => void this.#openDirectory(path, remember, false));
      return;
    }
    const client = this.#client;
    if (client === undefined) return;
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.#loading = true;
    this.#error = undefined;
    this.#preview = undefined;
    this.#savedText = undefined;
    this.#dirty = false;
    this.requestUpdate();

    const result = await client.list(path, controller.signal);
    if (controller.signal.aborted) return;
    this.#loading = false;
    if (result.ok === false) {
      this.#error = result.error.message;
      this.requestUpdate();
      return;
    }
    this.#directory = result.data.path;
    this.#parent = result.data.parent ?? result.data.path;
    this.#entries = [...result.data.entries];
    this.#total = result.data.total;
    this.#truncated = result.data.truncated;
    // Only navigation the user asked for updates the memory. A listing opened
    // while the selection was settling is not somewhere they chose to be, and
    // recording it would overwrite the directory they actually left behind.
    if (remember && this.#key !== undefined) rememberedDirectories.set(this.#key, result.data.path);
    this.requestUpdate();
  }

  async #refresh(): Promise<void> {
    if (this.#directory !== undefined) await this.#openDirectory(this.#directory);
  }

  async #openEntry(entry: FileEntry, confirm = true): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    if (confirm && this.#dirty) {
      this.#askDiscard(() => void this.#openEntry(entry, false));
      return;
    }
    if (entry.kind === "directory" || entry.linkKind === "directory") {
      await this.#openDirectory(entry.path, true, false);
      return;
    }
    this.#preview = { entry };
    this.requestUpdate();

    const info = await client.stat(entry.path);
    if (info.ok === false) {
      this.#preview = { entry, error: info.error.message };
      this.requestUpdate();
      return;
    }
    if (info.data.editable === false) {
      const url = client.downloadUrl(entry.path);
      this.#preview = {
        entry,
        ...(info.data.readOnlyReason === undefined ? {} : { readOnlyReason: info.data.readOnlyReason }),
        ...(url === undefined ? {} : { previewUrl: url }),
      };
      this.requestUpdate();
      return;
    }
    const read = await client.readText(entry.path);
    if (read.ok === false) {
      this.#preview = { entry, error: read.error.message };
      this.requestUpdate();
      return;
    }
    const text = new TextDecoder().decode(fromBase64(read.data.data));
    this.#preview = { entry, text, mtimeMs: read.data.mtimeMs };
    this.#savedText = text;
    this.#dirty = false;
    this.requestUpdate();
  }

  // ---- menus -------------------------------------------------------------

  #openMenu(event: Event, entry?: FileEntry): void {
    event.stopPropagation();
    const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(8, Math.min(anchor.left, window.innerWidth - 210));
    const y = Math.min(anchor.bottom + 4, Math.max(8, window.innerHeight - 240));
    this.#menu = entry === undefined ? { x, y } : { x, y, entry };
    this.requestUpdate();
  }

  #openViewerMenu(event: Event): void {
    event.stopPropagation();
    const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(8, Math.min(anchor.left, window.innerWidth - 210));
    const y = Math.min(anchor.bottom + 4, Math.max(8, window.innerHeight - 240));
    this.#menu = { x, y, viewer: true };
    this.requestUpdate();
  }

  #toggleWrap(): void {
    this.#wrap = !this.#wrap;
    writeToggle(WRAP_PREFERENCE_KEY, this.#wrap);
    this.#closeMenu();
  }

  #toggleMarkdownPreview(): void {
    this.#markdownPreview = !this.#markdownPreview;
    writeToggle(MARKDOWN_PREVIEW_KEY, this.#markdownPreview);
    this.#closeMenu();
    this.requestUpdate();
  }

  /**
   * Whether the open file is being shown as a document rather than as source.
   * Only Markdown qualifies, only with the renderer available, and never while
   * the editor holds unsaved text: the document has no editor to keep it.
   */
  #showingDocument(): boolean {
    const preview = this.#preview;
    if (preview === undefined || preview.text === undefined) return false;
    return this.#markdownPreview && isMarkdown(preview.entry.name) && !this.#dirty
      && hostCapabilities().markdown !== undefined && this.#context?.machine.id !== undefined;
  }

  #closePreview(): void {
    if (this.#dirty) {
      this.#askDiscard(() => this.#clearPreview());
      return;
    }
    this.#clearPreview();
  }

  #clearPreview(): void {
    this.#preview = undefined;
    this.#savedText = undefined;
    this.#dirty = false;
    this.requestUpdate();
  }

  #toggleFullHeight(): void {
    this.#fullHeight = !this.#fullHeight;
    writeToggle(FULL_HEIGHT_KEY, this.#fullHeight);
    this.#closeMenu();
  }

  #closeMenu(): void {
    this.#menu = undefined;
    this.requestUpdate();
  }

  // ---- operations --------------------------------------------------------

  /** A transient line under the toolbar; it clears itself so it cannot become furniture. */
  #setStatus(text: string): void {
    this.#status = text;
    if (this.#statusTimer !== undefined) clearTimeout(this.#statusTimer);
    this.#statusTimer = setTimeout(() => {
      this.#status = undefined;
      this.#statusTimer = undefined;
      this.requestUpdate();
    }, 6000);
  }

  #startEditingPath(): void {
    if (this.#editing) return;
    this.#editing = true;
    this.#draft = this.#crumbPath() ?? "";
    this.requestUpdate();
  }

  #commitPath(): void {
    const draft = this.#draft.trim();
    this.#editing = false;
    if (draft === "") {
      this.requestUpdate();
      return;
    }
    void this.#openDirectory(resolveAddress(draft, this.#directory));
  }

  #cancelEditing(): void {
    this.#editing = false;
    this.requestUpdate();
  }

  #askNewFolder(): void {
    this.#closeMenu();
    this.#dialog = { kind: "newFolder", draft: "" };
    this.requestUpdate();
  }

  #askNewFile(): void {
    this.#closeMenu();
    this.#dialog = { kind: "newFile", draft: "" };
    this.requestUpdate();
  }

  #askRename(entry: FileEntry): void {
    this.#closeMenu();
    this.#dialog = { kind: "rename", entry, draft: entry.name };
    this.requestUpdate();
  }

  async #askDelete(entry: FileEntry): Promise<void> {
    this.#closeMenu();
    const client = this.#client;
    if (client === undefined) return;
    this.#dialog = { kind: "delete", entry, plan: { entries: 1, bytes: entry.size, truncated: false } };
    this.requestUpdate();
    const plan = await client.deletePlan(entry.path);
    if (this.#dialog?.kind !== "delete" || this.#dialog.entry.path !== entry.path) return;
    if (plan.ok === false) {
      this.#dialog = { kind: "delete", entry, plan: { entries: 1, bytes: entry.size, truncated: false }, error: plan.error.message };
    } else {
      this.#dialog = { kind: "delete", entry, plan: plan.data };
    }
    this.requestUpdate();
  }

  #askUpload(): void {
    this.#closeMenu();
    this.renderRoot.querySelector<HTMLInputElement>("input[type=file][multiple]:not([webkitdirectory])")?.click();
  }

  /**
   * A folder pick is one attribute on the same control. The browser hands back a
   * flat list of files, each carrying the path it had inside the picked folder,
   * so the tree is rebuilt from those paths rather than walked.
   */
  #askUploadFolder(): void {
    this.#closeMenu();
    this.renderRoot.querySelector<HTMLInputElement>("input[webkitdirectory]")?.click();
  }

  #toggleHidden(): void {
    this.#showHidden = !this.#showHidden;
    writeHiddenPreference(this.#showHidden);
    this.#closeMenu();
  }

  #downloadEntry(entry: FileEntry): void {
    const client = this.#client;
    if (client === undefined) return;
    const directory = entry.kind === "directory" || entry.linkKind === "directory";
    const url = directory ? client.zipUrl(entry.path) : client.downloadUrl(entry.path);
    if (url === undefined) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = directory ? `${entry.name}.zip` : entry.name;
    anchor.click();
  }

  #copyPath(entry: FileEntry): void {
    this.#closeMenu();
    this.#copyText(entry.path);
  }

  #copyRelativePath(entry: FileEntry): void {
    const relative = this.#relativePath(entry.path);
    if (relative === undefined) return;
    this.#closeMenu();
    this.#copyText(relative);
  }

  /**
   * No feedback: a copy is self-evident when the text appears, and anything
   * that appears and vanishes here would move the list under the pointer.
   */
  #copyText(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  /** The path as it reads from the workspace root, or nothing outside it. */
  #relativePath(path: string): string | undefined {
    return relativeToRoot(path, this.#workspaceRoot);
  }

  #downloadDirectory(): void {
    this.#closeMenu();
    const directory = this.#directory;
    const client = this.#client;
    if (directory === undefined || client === undefined) return;
    const url = client.zipUrl(directory);
    if (url === undefined) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName(directory) || "root"}.zip`;
    anchor.click();
  }

  // ---- editing -----------------------------------------------------------

  /** A reload with unsaved edits asks first, in the browser's own words. */
  #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.#dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };

  #onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "s" && event.key !== "S") return;
    if (event.metaKey !== true && event.ctrlKey !== true) return;
    if (!event.composedPath().includes(this)) return;
    event.preventDefault();
    void this.#save();
  };

  #editor(): FileEditor | undefined {
    return this.renderRoot.querySelector<FileEditor>("fm-editor") ?? undefined;
  }

  #onEditorChange(): void {
    const editor = this.#editor();
    if (editor === undefined || this.#savedText === undefined) return;
    const dirty = editor.documentText !== this.#savedText;
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.requestUpdate();
  }

  async #save(force = false): Promise<void> {
    const client = this.#client;
    const preview = this.#preview;
    const editor = this.#editor();
    if (client === undefined || preview === undefined || editor === undefined || this.#saving) return;
    const text = editor.documentText;
    this.#saving = true;
    this.requestUpdate();
    const result = await client.save(preview.entry.path, preview.mtimeMs ?? null, text, new AbortController().signal, force);
    this.#saving = false;
    if (result.ok === false) {
      this.#dialog = result.error.code === "ECONFLICT"
        ? { kind: "save", entry: preview.entry, message: "Someone else saved it after you opened it. Reloading shows their version; saving anyway replaces it with yours.", conflicted: true }
        : { kind: "save", entry: preview.entry, message: result.error.message, conflicted: false };
      this.requestUpdate();
      return;
    }
    this.#savedText = text;
    this.#dirty = false;
    this.#dialog = undefined;
    const entry = { ...preview.entry, size: result.data.size, mtimeMs: result.data.mtimeMs };
    this.#preview = { ...preview, entry, mtimeMs: result.data.mtimeMs };
    this.#entries = this.#entries.map((item) => (item.path === entry.path ? entry : item));
    this.#setStatus(`Saved ${entry.name}`);
    this.requestUpdate();
    this.#restoreFocus();
    // "Save" in the discard dialog means "save, then do what I asked for".
    const next = this.#pendingNavigation;
    this.#pendingNavigation = undefined;
    next?.();
  }

  async #reloadFromDisk(): Promise<void> {
    const client = this.#client;
    const preview = this.#preview;
    if (client === undefined || preview === undefined) return;
    const read = await client.readText(preview.entry.path);
    if (read.ok === false) {
      this.#dialog = { kind: "save", entry: preview.entry, message: read.error.message, conflicted: false };
      this.requestUpdate();
      return;
    }
    const text = new TextDecoder().decode(fromBase64(read.data.data));
    const entry = { ...preview.entry, size: read.data.size, mtimeMs: read.data.mtimeMs };
    this.#preview = { ...preview, entry, text, mtimeMs: read.data.mtimeMs };
    this.#entries = this.#entries.map((item) => (item.path === entry.path ? entry : item));
    this.#savedText = text;
    this.#dirty = false;
    this.#dialog = undefined;
    this.requestUpdate();
    this.#restoreFocus();
  }

  /** Ask before losing edits; `next` runs if the user agrees. */
  #askDiscard(next: () => void): void {
    this.#pendingNavigation = next;
    this.#dialog = { kind: "discard", ...(this.#preview === undefined ? {} : { entry: this.#preview.entry }) };
    this.requestUpdate();
  }

  #discardChanges(): void {
    const next = this.#pendingNavigation;
    this.#pendingNavigation = undefined;
    this.#dialog = undefined;
    this.#dirty = false;
    this.#savedText = undefined;
    this.requestUpdate();
    next?.();
  }

  #askMove(entry: FileEntry): void {
    this.#closeMenu();
    const directory = parentPath(entry.path);
    this.#dialog = { kind: "move", entry, directory };
    this.requestUpdate();
    void this.#loadMoveDirectory(directory);
  }

  /** Browse the destination folder inside the move dialog. */
  async #loadMoveDirectory(directory: string): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    const dialog = this.#dialog;
    if (dialog?.kind !== "move") return;
    this.#dialog = { ...dialog, directory, directories: undefined, error: undefined, canReplace: false, conflictKind: undefined };
    this.requestUpdate();
    const result = await client.list(directory);
    const current = this.#dialog;
    if (current?.kind !== "move" || current.directory !== directory) return;
    this.#dialog = result.ok
      ? { ...current, directories: result.data.entries.filter((item) => item.kind === "directory" || item.linkKind === "directory") }
      : { ...current, directories: [], error: result.error.message };
    this.requestUpdate();
  }

  /** What sits at a path a rename was refused for. */
  async #conflictKind(client: FileManagerClient, path: string): Promise<ConflictKind> {
    const result = await client.stat(path);
    if (result.ok === false) return "file";
    return kindOf(result.data.entry);
  }

  async #submitMove(overwrite = false): Promise<void> {
    const dialog = this.#dialog;
    const client = this.#client;
    if (dialog?.kind !== "move" || client === undefined) return;
    const target = joinPath(dialog.directory, dialog.entry.name);
    const result = await client.rename(dialog.entry.path, target, overwrite);
    if (result.ok === false) {
      // The server's code is the contract; the sentence is this dialog's, so a
      // wording fix lands with a reload instead of a daemon restart.
      if (result.error.code !== "EEXIST") {
        this.#dialog = { ...dialog, error: result.error.message, canReplace: false, conflictKind: undefined };
        this.requestUpdate();
        return;
      }
      const conflictKind = await this.#conflictKind(client, target);
      this.#dialog = {
        ...dialog,
        error: `A ${conflictKind} named ${dialog.entry.name} already exists in this folder.`,
        canReplace: isReplaceable(kindOf(dialog.entry), conflictKind),
        conflictKind,
      };
      this.requestUpdate();
      return;
    }
    this.#dialog = undefined;
    this.#setStatus(`Moved ${dialog.entry.name}`);
    if (this.#preview?.entry.path === dialog.entry.path) this.#preview = undefined;
    await this.#refresh();
  }

  async #submitName(overwrite = false): Promise<void> {
    const dialog = this.#dialog;
    const client = this.#client;
    if (dialog === undefined || client === undefined) return;
    if (dialog.kind !== "newFolder" && dialog.kind !== "newFile" && dialog.kind !== "rename") return;
    const name = dialog.draft.trim();
    if (name === "") {
      this.#dialog = { ...dialog, error: "Enter a name" };
      this.requestUpdate();
      return;
    }
    if (name.includes("/")) {
      this.#dialog = { ...dialog, error: "A name cannot contain a slash" };
      this.requestUpdate();
      return;
    }
    const directory = this.#directory ?? "/";

    if (dialog.kind === "rename") {
      // The action is disabled while this exact name is known to be taken;
      // Enter must not be a way around the disabled button.
      if (dialog.blockedName !== undefined && dialog.canReplace !== true && name === dialog.blockedName) return;
      const target = joinPath(parentPath(dialog.entry.path), name);
      const result = await client.rename(dialog.entry.path, target, overwrite);
      if (result.ok === false) {
        if (result.error.code !== "EEXIST") {
          this.#dialog = { ...dialog, error: result.error.message, canReplace: false };
          this.requestUpdate();
          return;
        }
        const conflictKind = await this.#conflictKind(client, target);
        this.#dialog = {
          ...dialog,
          error: `A ${conflictKind} with that name already exists.`,
          canReplace: isReplaceable(kindOf(dialog.entry), conflictKind),
          conflictKind,
          blockedName: name,
        };
        this.requestUpdate();
        return;
      }
      this.#dialog = undefined;
      await this.#refresh();
      return;
    }

    if (dialog.blockedName !== undefined && name === dialog.blockedName) return;
    const target = joinPath(directory, name);
    // A new file is an empty save; a save refuses an existing name, which is
    // exactly the conflict we want to report here.
    const result = dialog.kind === "newFolder" ? await client.mkdir(target) : await client.save(target, null, "", new AbortController().signal);
    if (result.ok === false) {
      // Same sentence a rename uses, so one rule covers every "that name is
      // taken" in the panel instead of one per operation.
      if (result.error.code === "EEXIST" || result.error.code === "ECONFLICT") {
        const conflictKind = await this.#conflictKind(client, target);
        this.#dialog = { ...dialog, error: `A ${conflictKind} with that name already exists.`, blockedName: name };
      } else {
        this.#dialog = { ...dialog, error: result.error.message };
      }
      this.requestUpdate();
      return;
    }
    this.#dialog = undefined;
    await this.#refresh();
  }

  async #submitDelete(): Promise<void> {
    const dialog = this.#dialog;
    const client = this.#client;
    if (dialog?.kind !== "delete" || client === undefined) return;
    const result = await client.remove(dialog.entry.path, true);
    if (result.ok === false) {
      this.#dialog = { ...dialog, error: result.error.message };
      this.requestUpdate();
      return;
    }
    this.#dialog = undefined;
    this.#setStatus(`Deleted ${dialog.entry.name}`);
    if (this.#preview?.entry.path === dialog.entry.path) this.#preview = undefined;
    await this.#refresh();
  }

  #pendingUploads: UploadItem[] = [];
  /** What is already at each item's destination, for the batch decision. */
  #uploadExisting = new Map<string, number>();

  #startUploads(items: UploadItem[]): void {
    if (items.length === 0) return;
    this.#pendingUploads = [...items];
    this.#uploadExisting = new Map();
    void this.#planUploads();
  }

  /**
   * Find out which names are taken, before anything at all is written.
   *
   * A folder pick arrives as a flat list, and asking file by file about a tree
   * that half-exists would be a dialog per file, so the whole batch is planned
   * first and answered once. Planning only reads: a cancel leaves the folder
   * exactly as it was, folders included.
   */
  async #planUploads(): Promise<void> {
    const client = this.#client;
    const directory = this.#directory;
    if (client === undefined || directory === undefined) return;
    const items = this.#pendingUploads;

    const conflicts: string[] = [];
    for (const item of items) {
      const info = await client.stat(joinPath(directory, item.relative));
      if (info.ok === false) continue;
      if (info.data.entry.kind === "directory") return this.#failUpload(`${item.relative} is a folder, not a file`);
      this.#uploadExisting.set(item.relative, info.data.entry.mtimeMs);
      conflicts.push(item.relative);
    }

    if (conflicts.length === 0) {
      await this.#runUploadsNow("replace");
      return;
    }
    this.#dialog = { kind: "uploadBatch", total: items.length, conflicts };
    this.requestUpdate();
  }

  #failUpload(message: string): void {
    this.#setStatus(`Upload failed: ${message}`);
    this.#pendingUploads = [];
    this.#uploading = undefined;
    this.requestUpdate();
  }

  #cancelUploads(): void {
    this.#dialog = undefined;
    this.#pendingUploads = [];
    this.#uploadExisting = new Map();
    this.requestUpdate();
  }

  #runUploads(policy: UploadPolicy): void {
    this.#dialog = undefined;
    void this.#runUploadsNow(policy);
  }

  /** Create the folders the batch needs, shallowest first, then write the files. */
  async #createFolders(): Promise<boolean> {
    const client = this.#client;
    const directory = this.#directory;
    if (client === undefined || directory === undefined) return false;
    for (const relative of directoriesToCreate(this.#pendingUploads.map((item) => item.relative))) {
      const target = joinPath(directory, relative);
      const made = await client.mkdir(target);
      if (made.ok === true) continue;
      if (made.error.code !== "EEXIST") {
        this.#failUpload(made.error.message);
        return false;
      }
      // Already there is fine when it is a folder, and a dead end when a file
      // holds the name: the folder cannot exist and its contents cannot land.
      const info = await client.stat(target);
      if (info.ok && info.data.entry.kind !== "directory") {
        this.#failUpload(`${relative} is a file, not a folder`);
        return false;
      }
    }
    return true;
  }

  async #runUploadsNow(policy: UploadPolicy): Promise<void> {
    const client = this.#client;
    const directory = this.#directory;
    if (client === undefined || directory === undefined) return;
    const items = this.#pendingUploads;
    if (!(await this.#createFolders())) return;
    let written = 0;
    let skipped = 0;
    try {
      for (const [index, item] of items.entries()) {
        const action = uploadAction(item, this.#uploadExisting.get(item.relative), policy);
        if (action === "skip") {
          skipped += 1;
          continue;
        }
        const target = joinPath(directory, item.relative);
        const folder = parentRelative(item.relative);
        this.#uploading = {
          name: item.relative, received: 0, total: item.file.size, index: index + 1, count: items.length,
        };
        this.requestUpdate();
        const result = await client.upload(
          folder === "" ? directory : joinPath(directory, folder),
          item.file,
          new AbortController().signal,
          (received) => {
            this.#uploading = {
              name: item.relative, received, total: item.file.size, index: index + 1, count: items.length,
            };
            this.requestUpdate();
          },
          { name: baseName(item.relative), overwrite: action === "replace" },
        );
        this.#uploading = undefined;
        if (result.ok === false) return this.#failUpload(result.error.message);
        written += 1;
        this.requestUpdate();
      }
    } finally {
      this.#pendingUploads = [];
      this.#uploadExisting = new Map();
    }
    this.#setStatus(skipped === 0 ? `Uploaded ${countOf(written, "file")}` : `Uploaded ${countOf(written, "file")}, skipped ${String(skipped)}`);
    await this.#refresh();
  }

  // ---- rendering ---------------------------------------------------------

  #visibleEntries(): FileEntry[] {
    if (this.#showHidden) return this.#entries;
    return this.#entries.filter((entry) => !isHiddenName(entry.name));
  }

  /**
   * What the address bar describes: the file in full height, because that is
   * the whole panel then, and the directory otherwise.
   */
  #crumbPath(): string | undefined {
    return this.#fullHeight && this.#preview !== undefined ? this.#preview.entry.path : this.#directory;
  }

  #renderBreadcrumbs() {
    if (this.#editing) {
      return html`
        <input
          class="ui-input address"
          dir="ltr"
          spellcheck="false"
          autocomplete="off"
          aria-label="Path"
          .value=${this.#draft}
          @input=${(event: Event) => { this.#draft = (event.target as HTMLInputElement).value; }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") { event.preventDefault(); this.#commitPath(); }
            if (event.key === "Escape") { event.preventDefault(); this.#cancelEditing(); }
          }}
          @blur=${() => this.#cancelEditing()}
        >
      `;
    }
    const directory = this.#crumbPath();
    if (directory === undefined) return html`<span class="crumb current">…</span>`;
    return breadcrumbSegments(directory).map((segment, index, all) => html`
      ${index === 0 ? "" : html`<span class="separator" aria-hidden="true">/</span>`}
      <button
        class=${`crumb ${index === all.length - 1 ? "current" : ""}`}
        title=${index === all.length - 1 ? "Edit path" : segment.path}
        @click=${() => {
          // The last segment is the directory already shown, so it is the
          // natural target for editing rather than navigating to itself.
          if (index === all.length - 1) this.#startEditingPath();
          else void this.#openDirectory(segment.path);
        }}
      >${segment.name}</button>
    `);
  }

  #renderRow(entry: FileEntry) {
    const selected = this.#preview?.entry.path === entry.path;
    const directory = entry.kind === "directory" || entry.linkKind === "directory";
    const menuOpen = this.#menu?.entry?.path === entry.path;
    return html`
      <div class=${`row-wrap ${menuOpen ? "menu-open" : ""}`}>
        <button
          type="button"
          class=${`ui-button ui-file-row ${selected ? "selected" : ""}`}
          title=${entry.path}
          aria-current=${selected ? "page" : "false"}
          @click=${() => void this.#openEntry(entry)}
        >
          <span class="ui-file-leading leading" aria-hidden="true">
            ${directory ? folderIcon() : html`<fm-file-icon .url=${resolveIcon(entry.path)}></fm-file-icon>`}
          </span>
          <span class="ui-file-label" dir="ltr">${entry.name}${entry.kind === "symlink" ? " ↗" : ""}</span>
          <span class="ui-file-meta">${directory ? "" : formatSize(entry.size)}</span>
        </button>
        <button
          class="ui-button ui-button--compact ui-button--icon row-more"
          aria-label=${`Actions for ${entry.name}`}
          title="Actions"
          aria-haspopup="menu"
          @click=${(event: Event) => this.#openMenu(event, entry)}
        >⋯</button>
      </div>
    `;
  }

  #menuItem(label: string, run: () => void, className = ""): unknown {
    return html`<button role="menuitem" class=${className} @click=${(event: Event) => { event.stopPropagation(); run(); }}>${label}</button>`;
  }

  #menuItemBlocked(label: string, reason: string): unknown {
    return html`<button role="menuitem" disabled title=${reason}>${label}</button>`;
  }

  #renderMenu() {
    const menu = this.#menu;
    if (menu === undefined) return "";
    const entry = menu.entry;
    return html`
      <div class="menu" role="menu" style=${`left:${String(menu.x)}px; top:${String(menu.y)}px`} @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") { this.#closeMenu(); }
      }}>
        ${menu.viewer === true
          ? html`
            ${this.#menuItem("Copy path", () => { this.#closeMenu(); if (this.#preview !== undefined) this.#copyText(this.#preview.entry.path); })}
            ${this.#preview === undefined || this.#relativePath(this.#preview.entry.path) === undefined
              ? ""
              : this.#menuItem("Copy relative path", () => { this.#closeMenu(); this.#copyText(this.#relativePath(this.#preview?.entry.path ?? "") ?? ""); })}
            <hr>
            ${this.#preview !== undefined && isMarkdown(this.#preview.entry.name) && hostCapabilities().markdown !== undefined
              ? this.#dirty
                ? this.#menuItemBlocked(this.#markdownPreview ? "Show source" : "Show preview", "Save your changes first")
                : this.#menuItem(this.#markdownPreview ? "Show source" : "Show preview", () => this.#toggleMarkdownPreview())
              : ""}
            ${this.#showingDocument() ? "" : this.#menuItem(this.#wrap ? "Wrap lines ✓" : "Wrap lines", () => this.#toggleWrap())}
          `
          : entry === undefined
          ? html`
            ${this.#menuItem("New folder…", () => this.#askNewFolder())}
            ${this.#menuItem("New file…", () => this.#askNewFile())}
            ${this.#menuItem("Upload files…", () => this.#askUpload())}
            ${this.#menuItem("Upload folder…", () => this.#askUploadFolder())}
            ${this.#menuItem("Download this folder (.zip)", () => this.#downloadDirectory())}
            <hr>
            ${this.#menuItem(this.#showHidden ? "Hide hidden files" : "Show hidden files", () => this.#toggleHidden())}
            ${this.#menuItem(this.#fullHeight ? "Full height ✓" : "Full height", () => this.#toggleFullHeight())}
          `
          : html`
            ${this.#menuItem(entry.kind === "directory" ? "Download as .zip" : "Download", () => { this.#closeMenu(); this.#downloadEntry(entry); })}
            ${this.#menuItem("Copy path", () => this.#copyPath(entry))}
            ${this.#relativePath(entry.path) === undefined ? "" : this.#menuItem("Copy relative path", () => this.#copyRelativePath(entry))}
            <hr>
            ${this.#menuItem("Rename…", () => this.#askRename(entry))}
            ${this.#menuItem("Move to…", () => this.#askMove(entry))}
            ${this.#menuItem("Delete…", () => void this.#askDelete(entry), "danger")}
          `}
      </div>
    `;
  }

  #renderDialog() {
    const dialog = this.#dialog;
    if (dialog === undefined) return "";
    if (dialog.kind === "delete") {
      const count = dialog.plan.entries;
      const detail = count > 1 ? `${String(count)} entries, ${formatSize(dialog.plan.bytes)}` : formatSize(dialog.plan.bytes);
      return html`
        <dialog class="dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
          <h2>Delete ${dialog.entry.name}?</h2>
          <p>This removes ${detail} and cannot be undone.</p>
          ${dialog.error === undefined ? "" : html`<p class="dialog-error">${dialog.error}</p>`}
          <footer>
            <button @click=${() => this.#cancelDialog()}>Cancel</button>
            <button class="danger" @click=${() => void this.#submitDelete()}>Delete</button>
          </footer>
        </dialog>
      `;
    }
    if (dialog.kind === "move") return this.#renderMoveDialog(dialog);
    if (dialog.kind === "uploadBatch") {
      const rows = treeRows(conflictTree(dialog.conflicts));
      const shown = rows.slice(0, CONFLICT_TREE_MAX_ROWS);
      const files = countOf(dialog.total, "file");
      const taken = dialog.conflicts.length === 1 ? "1 name already exists" : `${String(dialog.conflicts.length)} names already exist`;
      return html`
        <dialog class="dialog upload-dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
          <h2>Upload ${files}?</h2>
          <p>${taken} in this folder. Nothing has been written yet.</p>
          <div class="upload-list" role="tree" aria-label="Files that already exist">
            ${shown.map(({ node, depth }) => html`
              <div class="ui-button ui-file-row" style=${`--depth:${String(depth)}`} title=${node.path} role="treeitem" aria-level=${String(depth + 1)}>
                <span class="ui-file-leading" aria-hidden="true">${node.kind === "directory" ? "▾" : html`<fm-file-icon .url=${resolveIcon(node.path)}></fm-file-icon>`}</span>
                <span class="ui-file-label" dir="ltr">${node.name}</span>
              </div>
            `)}
            ${rows.length === shown.length ? "" : html`<div class="truncated">and ${countOf(rows.length - shown.length, "more path")}</div>`}
          </div>
          <footer>
            <button @click=${() => this.#cancelUploads()}>Cancel</button>
            <button class="primary" @click=${() => this.#runUploads("skip")}>Skip ${dialog.conflicts.length === 1 ? "it" : "them"}</button>
            <button @click=${() => this.#runUploads("newer")}>Keep newer</button>
            <button class="danger" @click=${() => this.#runUploads("replace")}>Replace all</button>
          </footer>
        </dialog>
      `;
    }
    if (dialog.kind === "save") {
      return html`
        <dialog class="dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
          <h2>${dialog.conflicted ? "This file changed on disk" : `Could not save ${dialog.entry.name}`}</h2>
          <p>${dialog.message}</p>
          <footer>
            ${dialog.conflicted
              ? html`
                <button @click=${() => this.#cancelDialog()}>Cancel</button>
                <button @click=${() => void this.#reloadFromDisk()}>Reload from disk</button>
                <button class="primary" @click=${() => void this.#save(true)}>Save anyway</button>
              `
              : html`<button class="primary" @click=${() => this.#cancelDialog()}>Close</button>`}
          </footer>
        </dialog>
      `;
    }
    if (dialog.kind === "discard") {
      return html`
        <dialog class="dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
          <h2>Discard changes?</h2>
          <p>${dialog.entry === undefined ? "This file" : dialog.entry.name} has edits that are not saved.</p>
          <footer>
            <button @click=${() => this.#cancelDialog()}>Cancel</button>
            <button @click=${() => void this.#save()}>Save</button>
            <button class="danger" @click=${() => this.#discardChanges()}>Discard</button>
          </footer>
        </dialog>
      `;
    }
    const named = dialog;
    const title = named.kind === "newFolder" ? "New folder" : named.kind === "newFile" ? "New file" : `Rename ${named.entry.name}`;
    const action = named.kind === "rename" ? "Rename" : "Create";
    const replacing = named.kind === "rename" && named.canReplace === true;
    return html`
      <dialog class="dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
        <h2>${title}</h2>
        <input
          aria-label="Name"
          .value=${named.draft}
          @input=${(event: Event) => {
            const draft = (event.target as HTMLInputElement).value;
            const cleared = named.blockedName !== undefined && draft.trim() !== named.blockedName;
            this.#dialog = cleared
              ? {
                ...named,
                draft,
                error: undefined,
                blockedName: undefined,
                ...(named.kind === "rename" ? { canReplace: false, conflictKind: undefined } : {}),
              }
              : { ...named, draft };
            this.requestUpdate();
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") { event.preventDefault(); void this.#submitName(); }
          }}
          @focus=${(event: Event) => (event.target as HTMLInputElement).select()}
        >
        ${named.error === undefined ? "" : html`<p class="dialog-error">${named.error}</p>`}
        <footer>
          <button @click=${() => this.#cancelDialog()}>Cancel</button>
          ${replacing
            ? html`<button class="danger" @click=${() => void this.#submitName(true)}>Replace ${named.conflictKind ?? "item"}</button>`
            : html`<button
                class="primary"
                ?disabled=${named.blockedName !== undefined && named.draft.trim() === named.blockedName}
                @click=${() => void this.#submitName()}
              >${action}</button>`}
        </footer>
      </dialog>
    `;
  }

  /**
   * The destination picker: same list-of-choices shape as moving a session
   * between workspaces, because that is the metaphor the rest of the app uses
   * for "this thing belongs somewhere else now".
   */
  #renderMoveDialog(dialog: Extract<DialogState, { kind: "move" }>) {
    const parent = parentPath(dialog.entry.path);
    const insideItself = dialog.entry.kind === "directory"
      && (dialog.directory === dialog.entry.path || dialog.directory.startsWith(`${dialog.entry.path}/`));
    const alreadyHere = dialog.directory === parent;
    const stoppedByConflict = dialog.conflictKind !== undefined && dialog.canReplace !== true;
    const blocked = dialog.directories === undefined || insideItself || alreadyHere || stoppedByConflict;
    return html`
      <dialog class="dialog move-dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
        <h2>Move ${dialog.entry.name}</h2>
        <p class="move-path" dir="ltr">${dialog.directory}</p>
        <div class="move-list">
          ${dialog.directory === "/" ? "" : html`
            <button class="move-row" @click=${() => void this.#loadMoveDirectory(parentPath(dialog.directory))}>
              <span class="leading" aria-hidden="true">↰</span>..
            </button>
          `}
          ${dialog.directories === undefined
            ? html`<div class="notice" role="status">Loading folders…</div>`
            : dialog.directories.length === 0
              ? html`<div class="notice">No folders in here</div>`
              : dialog.directories.map((child) => {
                // The item being moved and everything under it are not
                // destinations: a folder cannot become its own descendant.
                const forbidden = dialog.entry.kind === "directory"
                  && (child.path === dialog.entry.path || child.path.startsWith(`${dialog.entry.path}/`));
                return html`
                  <button
                    class="move-row"
                    ?disabled=${forbidden}
                    title=${forbidden ? "A folder cannot move into itself" : child.path}
                    @click=${() => { if (!forbidden) void this.#loadMoveDirectory(child.path); }}
                  >
                    <span class="leading" aria-hidden="true">${folderIcon()}</span>${child.name}
                  </button>
                `;
              })}
        </div>
        ${insideItself ? html`<p class="move-hint">A folder cannot move into itself.</p>` : alreadyHere ? html`<p class="move-hint">Already in this folder.</p>` : ""}
        ${dialog.error === undefined ? "" : html`<p class="dialog-error">${dialog.error}</p>`}
        <footer>
          <button @click=${() => this.#cancelDialog()}>Cancel</button>
          ${dialog.canReplace === true
            ? html`<button class="danger" @click=${() => void this.#submitMove(true)}>Replace ${dialog.conflictKind ?? "item"}</button>`
            : html`<button class="primary" ?disabled=${blocked} @click=${() => void this.#submitMove()}>Move here</button>`}
        </footer>
      </dialog>
    `;
  }

  #cancelDialog(): void {
    if (this.#dialog === undefined) return;
    this.#dialog = undefined;
    this.#pendingNavigation = undefined;
    this.requestUpdate();
    this.#restoreFocus();
  }

  /**
   * A closed dialog takes the focus with it, which leaves the panel deaf to
   * keys: Ctrl+S after dismissing a dialog did nothing until the editor was
   * clicked again.
   */
  #restoreFocus(): void {
    void this.updateComplete.then(() => {
      const editor = this.#editor();
      if (editor !== undefined) editor.focusEditor();
      else this.focus();
    });
  }

  override render() {
    const atRoot = this.#directory === undefined || this.#parent === null || this.#parent === this.#directory;
    const entries = this.#visibleEntries();
    return html`
      <div class="ui-toolbar toolbar">
        <div class="ui-toolbar-group breadcrumbs" @click=${(event: MouseEvent) => {
          if (this.#editing) return;
          if ((event.target as HTMLElement).closest(".crumb") !== null) return;
          this.#startEditingPath();
        }}>${this.#renderBreadcrumbs()}</div>
        <div class="ui-toolbar-group">
          <button
            class="ui-button ui-button--compact ui-button--icon"
            title="Refresh directory"
            aria-label="Refresh directory"
            ?disabled=${this.#loading}
            @click=${() => void this.#refresh()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>
          </button>
          <button
            class="ui-button ui-button--compact ui-button--icon"
            aria-label="File actions"
            title="Actions"
            aria-haspopup="menu"
            @click=${(event: Event) => this.#openMenu(event)}
          >⋯</button>
        </div>
      </div>
      <input
        class="visually-hidden"
        type="file"
        multiple
        aria-hidden="true"
        style="display:none"
        @change=${(event: Event) => {
          const input = event.target as HTMLInputElement;
          const items = pickedItems(input.files);
          input.value = "";
          this.#startUploads(items);
        }}
      >
      <input
        class="visually-hidden"
        type="file"
        webkitdirectory
        aria-hidden="true"
        style="display:none"
        @change=${(event: Event) => {
          const input = event.target as HTMLInputElement;
          const items = pickedItems(input.files);
          input.value = "";
          this.#startUploads(items);
        }}
      >
      ${this.#error === undefined ? "" : html`<div class="notice error">${this.#error}</div>`}
      <main class=${this.#preview === undefined ? "alone" : this.#fullHeight ? "full" : "split"}>
        <div class="list ui-file-list" role="listbox" aria-label="Directory listing">
          ${atRoot ? "" : html`
            <button type="button" class="ui-button ui-file-row" title="Parent directory" @click=${() => void this.#openDirectory(this.#parent ?? "/")}>
              <span class="ui-file-leading leading" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 6 6v4"></path></svg>
              </span>
              <span class="ui-file-label">..</span>
            </button>
          `}
          ${entries.length === 0
            ? html`<div class="notice">${this.#loading ? "Loading…" : "Empty directory"}</div>`
            : entries.map((entry) => this.#renderRow(entry))}
          ${this.#truncated ? html`<div class="truncated">Showing the first ${String(entries.length)} of ${String(this.#total)} entries.</div>` : ""}
        </div>
        ${this.#preview === undefined ? "" : html`<div class="viewer">${this.#renderViewer()}</div>`}
      </main>
      <div class="status-stack">
        ${this.#uploading === undefined ? "" : html`<div class="status" role="status">Uploading ${this.#uploading.name}${this.#uploading.count > 1 ? ` (${String(this.#uploading.index)} of ${String(this.#uploading.count)})` : ""} — ${formatSize(this.#uploading.received)} of ${formatSize(this.#uploading.total)}</div>`}
        ${this.#status === undefined ? "" : html`<div class="status" role="status">${this.#status}</div>`}
      </div>
      ${this.#renderMenu()}
      ${this.#renderDialog()}
    `;
  }

  #renderViewer() {
    const preview = this.#preview;
    if (preview === undefined) return html`<div class="notice">Select a file to look at it.</div>`;
    const downloadUrl = this.#client?.downloadUrl(preview.entry.path);
    const head = html`
      <div class="ui-toolbar toolbar viewer-head">
        <button
          class="ui-button ui-button--compact ui-button--icon close"
          title="Close file"
          aria-label="Close file"
          @click=${() => this.#closePreview()}
        >${closeIcon()}</button>
        <strong>${this.#dirty ? html`<span class="dirty-dot" title="Unsaved changes">●</span>` : ""}${preview.entry.name}</strong>
        <div class="ui-toolbar-group viewer-actions">
          <small>${formatSize(preview.entry.size)}</small>
          ${this.#dirty
            ? html`<button
                class="ui-button ui-button--compact ui-button--icon"
                title=${this.#saving ? "Saving…" : "Save"}
                aria-label="Save"
                ?disabled=${this.#saving}
                @click=${() => void this.#save()}
              >${saveIcon()}</button>`
            : ""}
          ${downloadUrl === undefined ? "" : html`<a class="ui-button ui-button--compact ui-button--icon" title="Download" aria-label="Download" href=${downloadUrl} download=${preview.entry.name}>${downloadIcon()}</a>`}
          <button class="ui-button ui-button--compact ui-button--icon" title="Reload from disk" aria-label="Reload from disk" @click=${() => void this.#reloadFromDisk()}>${reloadIcon()}</button>
          <button class="ui-button ui-button--compact ui-button--icon" title="File actions" aria-label="File actions" aria-haspopup="menu" @click=${(event: Event) => this.#openViewerMenu(event)}>⋯</button>
        </div>
      </div>`;
    if (preview.error !== undefined) return html`${head}<div class="notice error">${preview.error}</div>`;
    if (preview.text !== undefined && this.#showingDocument()) {
      const machineId = this.#context?.machine.id ?? "";
      const markdown = hostCapabilities().markdown;
      return html`${head}
        <div class="viewer-body document">
          ${markdown === undefined ? "" : markdown.render({ machineId, text: preview.text })}
        </div>`;
    }
    if (preview.text !== undefined) {
      return html`${head}
        <div class="viewer-body editing">
          <fm-editor
            .path=${preview.entry.path}
            .text=${preview.text}
            .wrap=${this.#wrap}
            @fm-change=${() => this.#onEditorChange()}
            @fm-save=${() => void this.#save()}
          ></fm-editor>
        </div>`;
    }
    if (preview.previewUrl !== undefined && isImage(preview.entry.name)) {
      return html`${head}<div class="viewer-body"><img class="preview" src=${preview.previewUrl} alt=${preview.entry.name}></div>`;
    }
    /* A PDF is a document the browser already knows how to draw. The download
       resource streams it as `application/pdf` with an inline disposition, which
       is exactly what the viewer needs, so nothing is fetched or re-encoded here. */
    if (preview.previewUrl !== undefined && isPdf(preview.entry.name)) {
      return html`${head}<div class="viewer-body"><embed class="pdf" type="application/pdf" src=${preview.previewUrl} title=${preview.entry.name}></div>`;
    }
    if (preview.previewUrl !== undefined) {
      return html`${head}<div class="notice">Not shown inline (${preview.readOnlyReason ?? "unsupported"}).</div>`;
    }
    return html`${head}<div class="notice">No preview.</div>`;
  }
}

function hasSelection(snapshot: SelectionSnapshot | undefined): snapshot is SelectionSnapshot & { selectedWorkspace?: SelectionSnapshot["selectedWorkspace"] } {
  return snapshot !== undefined && (snapshot.selectedWorkspace !== undefined || snapshot.selectedSession !== undefined);
}

/**
 * A selection belongs to this panel when it names the same workspace, and when
 * the selected session is working in it. The host moves through intermediate
 * states the panel must not act on: no workspace at all, or the previous
 * project's session still selected while the new workspace is already set.
 */
function selectionMatchesContext(context: PanelContext | undefined, snapshot: SelectionSnapshot): boolean {
  const workspace = context?.workspace;
  if (workspace === undefined) return true;
  if (snapshot.selectedWorkspace !== undefined && snapshot.selectedWorkspace.id !== workspace.id) return false;
  const cwd = snapshot.selectedSession?.cwd;
  return cwd === undefined || cwd === workspace.path;
}

function keyFor(context: PanelContext | undefined, snapshot: SelectionSnapshot | undefined): string | undefined {
  const sessionId = snapshot?.selectedSession?.id;
  if (sessionId !== undefined) return `session:${sessionId}`;
  const workspaceId = snapshot?.selectedWorkspace?.id ?? context?.workspace?.id;
  if (workspaceId !== undefined) return `workspace:${workspaceId}`;
  const machineId = context?.machine.id;
  return machineId === undefined ? undefined : `machine:${machineId}`;
}

function closeIcon() {
  return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="m18 6-12 12"></path></svg>`;
}

function saveIcon() {
  return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>`;
}

function downloadIcon() {
  return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>`;
}

function reloadIcon() {
  return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>`;
}

function isPdf(name: string): boolean {
  return /\.pdf$/iu.test(name);
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/iu.test(name);
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/iu.test(name);
}

function readHiddenPreference(): boolean {
  // Dotfiles are shown by default: this is a filesystem browser, and the files
  // that matter — .git, .config, .env — are the ones a hidden-by-default view
  // would keep out of the way.
  try {
    return window.localStorage.getItem(HIDDEN_PREFERENCE_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeHiddenPreference(value: boolean): void {
  writeToggle(HIDDEN_PREFERENCE_KEY, value);
}

function readToggle(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

function writeToggle(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // A browser that refuses storage keeps the toggle for this page only.
  }
}

/** A picker's files as upload items, keeping the path each has inside a folder pick. */
function pickedItems(files: FileList | null): UploadItem[] {
  return Array.from(files ?? []).map((file) => ({
    file,
    relative: (file as File & { readonly webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${String(count)} ${noun}s`;
}
