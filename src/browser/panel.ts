import { LitElement, css, html } from "lit";
import type { FileEntry } from "../shared/protocol.ts";
import type { PanelContext, SelectionService, SelectionSnapshot } from "./pluginApi.ts";
import { clientFor, fromBase64, type FileManagerClient } from "./client.ts";
import { hostCapabilities } from "./capabilities.ts";
import { defineFileTypeIcon, folderIcon, resolveIcon } from "./fileIcon.ts";
import {
  baseName, breadcrumbSegments, formatSize, isHiddenName, joinPath, parentPath, relativeToRoot, resolveAddress,
} from "./breadcrumbs.ts";

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
  if (customElements.get(PANEL_TAG) === undefined) customElements.define(PANEL_TAG, FileManagerPanel);
}

/** Per-session directory, for the lifetime of this page. Not persisted. */
const rememberedDirectories = new Map<string, string>();

const HIDDEN_PREFERENCE_KEY = "pi-web.file-manager.show-hidden";

interface Preview {
  readonly entry: FileEntry;
  readonly text?: string;
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
  | { readonly kind: "newFolder"; readonly draft: string; readonly error?: string }
  | { readonly kind: "newFile"; readonly draft: string; readonly error?: string }
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
  | { readonly kind: "replace"; readonly file: File; readonly error?: string }
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
}

export class FileManagerPanel extends LitElement {
  static override styles = css`
    :host { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--pi-text); background: var(--pi-bg); font-size: 13px; }
    .toolbar { gap: 0; border-bottom: 1px solid var(--pi-border-muted); }
    .breadcrumbs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; cursor: text; align-self: stretch; }
    .crumb { flex: 0 0 auto; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); padding: 3px 5px; font: inherit; font-family: var(--pi-mono, ui-monospace, monospace); cursor: pointer; }
    .crumb:hover { background: var(--pi-surface); color: var(--pi-text); }
    .crumb.current { color: var(--pi-text); }
    .separator { flex: 0 0 auto; color: var(--pi-dim); }
    /* .ui-input scaled to a 32px toolbar row: the field fills the row from the
       panel edge to the first button, so there is no seam to look unfinished. */
    .address.ui-input { flex: 1 1 auto; align-self: stretch; width: auto; min-width: 0; min-height: 0; height: auto; border: 0; border-radius: 0; background: var(--pi-bg); color: var(--pi-text); padding: 0 10px; font: 13px/1.4 var(--pi-mono, ui-monospace, monospace); direction: ltr; }
    .address.ui-input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    main { flex: 1; display: grid; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); min-height: 0; }
    .list { overflow: auto; min-height: 0; border-bottom: 1px solid var(--pi-border); }
    .row-wrap { position: relative; }
    .row-wrap .ui-button.ui-file-row { width: 100%; padding-inline-end: 34px; }
    .row-more { position: absolute; inset-inline-end: 0; top: 50%; transform: translateY(-50%); opacity: 0; }
    .row-wrap:hover .row-more, .row-more:focus-visible, .row-wrap.menu-open .row-more { opacity: 1; }
    @media (pointer: coarse) { .row-more { opacity: 1; } }
    .viewer { display: flex; flex-direction: column; min-height: 0; }
    .viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; padding-inline-start: 10px; border-bottom: 1px solid var(--pi-border-muted); }
    .viewer-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
    .viewer-actions { align-self: stretch; display: flex; align-items: center; gap: 0; flex: 0 1 auto; min-width: 0; max-width: 100%; }
    .viewer-actions small { padding-inline: 8px; color: var(--pi-muted); font-size: 12px; }
    .viewer-action { box-sizing: border-box; align-self: stretch; display: inline-flex; align-items: center; min-height: 32px; border: 0; background: transparent; color: var(--pi-muted); font: 12px/20px var(--pi-font, system-ui, sans-serif); padding: 6px 8px; text-decoration: none; white-space: nowrap; cursor: pointer; }
    .viewer-actions > :not(small) + * { border-inline-start: 1px solid var(--pi-border-muted); }
    .viewer-action:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .viewer-body { flex: 1; overflow: auto; min-height: 0; }
    pre { margin: 0; padding: 10px; font-family: var(--pi-mono, monospace); font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    img.preview { max-width: 100%; display: block; margin: 10px auto; }
    .notice { padding: 12px; color: var(--pi-muted); }
    .error { color: var(--pi-danger); }
    .truncated { padding: 6px 10px; color: var(--pi-dim); }
    .leading { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--pi-muted); }
    .menu { position: fixed; z-index: 40; min-width: 190px; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg-overlay, var(--pi-surface)); box-shadow: 0 10px 30px var(--pi-shadow, rgba(0, 0, 0, 0.4)); }
    .menu button { display: block; width: 100%; border: 0; border-radius: 5px; background: none; color: var(--pi-text); padding: 7px 9px; text-align: start; font: inherit; cursor: pointer; }
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
    dialog.dialog.move-dialog { width: min(480px, calc(100vw - 32px)); }
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
  #uploading: { readonly name: string; readonly received: number; readonly total: number } | undefined;

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
    document.addEventListener("pointerdown", this.#onDocumentPointerDown, true);
    this.#scheduleStart();
  }

  override disconnectedCallback(): void {
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

  async #openDirectory(path: string, remember = true): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.#loading = true;
    this.#error = undefined;
    this.#preview = undefined;
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

  async #openEntry(entry: FileEntry): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    if (entry.kind === "directory" || entry.linkKind === "directory") {
      await this.#openDirectory(entry.path);
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
    this.#preview = read.ok === false
      ? { entry, error: read.error.message }
      : { entry, text: new TextDecoder().decode(fromBase64(read.data.data)) };
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
    this.#draft = this.#directory ?? "";
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
    this.renderRoot.querySelector<HTMLInputElement>("input[type=file]")?.click();
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

    const target = joinPath(directory, name);
    // A new file is an empty save; a save refuses an existing name, which is
    // exactly the conflict we want to report here.
    const result = dialog.kind === "newFolder" ? await client.mkdir(target) : await client.save(target, null, "", new AbortController().signal);
    if (result.ok === false) {
      this.#dialog = { ...dialog, error: result.error.message };
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

  #pendingUploads: File[] = [];

  #startUploads(files: File[]): void {
    if (files.length === 0) return;
    this.#pendingUploads = [...files];
    void this.#processUploads();
  }

  async #processUploads(): Promise<void> {
    const client = this.#client;
    const directory = this.#directory;
    if (client === undefined || directory === undefined) return;
    while (this.#pendingUploads.length > 0) {
      const file = this.#pendingUploads[0];
      if (file === undefined) return;
      this.#uploading = { name: file.name, received: 0, total: file.size };
      this.requestUpdate();
      const result = await client.upload(directory, file, new AbortController().signal, (received) => {
        this.#uploading = { name: file.name, received, total: file.size };
        this.requestUpdate();
      });
      this.#uploading = undefined;
      if (result.ok === false && result.error.code === "EEXIST") {
        // Keep the file at the head of the queue; the answer decides its fate.
        this.#dialog = { kind: "replace", file };
        this.requestUpdate();
        return;
      }
      this.#pendingUploads.shift();
      if (result.ok === false) {
        this.#setStatus(`Upload failed: ${result.error.message}`);
        this.#pendingUploads = [];
        this.requestUpdate();
        return;
      }
      this.#setStatus(`Uploaded ${file.name}`);
      this.requestUpdate();
    }
    await this.#refresh();
  }

  async #confirmReplace(): Promise<void> {
    const dialog = this.#dialog;
    const client = this.#client;
    const directory = this.#directory;
    if (dialog?.kind !== "replace" || client === undefined || directory === undefined) return;
    this.#dialog = undefined;
    const file = this.#pendingUploads[0];
    if (file === undefined) return;
    const result = await client.upload(directory, file, new AbortController().signal, () => undefined, true);
    this.#pendingUploads.shift();
    if (result.ok === false) {
      this.#setStatus(`Upload failed: ${result.error.message}`);
      this.#pendingUploads = [];
      this.requestUpdate();
      return;
    }
    this.#setStatus(`Replaced ${file.name}`);
    this.requestUpdate();
    await this.#processUploads();
  }

  // ---- rendering ---------------------------------------------------------

  #visibleEntries(): FileEntry[] {
    if (this.#showHidden) return this.#entries;
    return this.#entries.filter((entry) => !isHiddenName(entry.name));
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
    const directory = this.#directory;
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

  #renderMenu() {
    const menu = this.#menu;
    if (menu === undefined) return "";
    const entry = menu.entry;
    return html`
      <div class="menu" role="menu" style=${`left:${String(menu.x)}px; top:${String(menu.y)}px`} @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") { this.#closeMenu(); }
      }}>
        ${entry === undefined
          ? html`
            ${this.#menuItem("New folder…", () => this.#askNewFolder())}
            ${this.#menuItem("New file…", () => this.#askNewFile())}
            ${this.#menuItem("Upload files…", () => this.#askUpload())}
            ${this.#menuItem("Download this folder (.zip)", () => this.#downloadDirectory())}
            <hr>
            ${this.#menuItem(this.#showHidden ? "Hide hidden files" : "Show hidden files", () => this.#toggleHidden())}
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
    if (dialog.kind === "replace") {
      return html`
        <dialog class="dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
          <h2>Replace ${dialog.file.name}?</h2>
          <p>A file with that name already exists in this folder.</p>
          ${dialog.error === undefined ? "" : html`<p class="dialog-error">${dialog.error}</p>`}
          <footer>
            <button @click=${() => this.#cancelDialog()}>Cancel</button>
            <button class="primary" @click=${() => void this.#confirmReplace()}>Replace</button>
          </footer>
        </dialog>
      `;
    }
    const title = dialog.kind === "newFolder" ? "New folder" : dialog.kind === "newFile" ? "New file" : `Rename ${dialog.entry.name}`;
    const action = dialog.kind === "rename" ? "Rename" : "Create";
    const replacing = dialog.kind === "rename" && dialog.canReplace === true;
    return html`
      <dialog class="dialog" @cancel=${(event: Event) => { event.preventDefault(); this.#cancelDialog(); }} @close=${() => this.#cancelDialog()}>
        <h2>${title}</h2>
        <input
          aria-label="Name"
          .value=${dialog.draft}
          @input=${(event: Event) => {
            const draft = (event.target as HTMLInputElement).value;
            const cleared = dialog.kind === "rename" && dialog.blockedName !== undefined && draft.trim() !== dialog.blockedName;
            this.#dialog = cleared
              ? { ...dialog, draft, error: undefined, blockedName: undefined, canReplace: false, conflictKind: undefined }
              : { ...dialog, draft };
            this.requestUpdate();
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") { event.preventDefault(); void this.#submitName(); }
          }}
          @focus=${(event: Event) => (event.target as HTMLInputElement).select()}
        >
        ${dialog.error === undefined ? "" : html`<p class="dialog-error">${dialog.error}</p>`}
        <footer>
          <button @click=${() => this.#cancelDialog()}>Cancel</button>
          ${replacing
            ? html`<button class="danger" @click=${() => void this.#submitName(true)}>Replace ${dialog.conflictKind ?? "item"}</button>`
            : html`<button
                class="primary"
                ?disabled=${dialog.kind === "rename" && dialog.blockedName !== undefined && dialog.draft.trim() === dialog.blockedName}
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
    this.requestUpdate();
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
          const files = Array.from(input.files ?? []);
          input.value = "";
          this.#startUploads(files);
        }}
      >
      ${this.#error === undefined ? "" : html`<div class="notice error">${this.#error}</div>`}
      <main>
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
        <div class="viewer">${this.#renderViewer()}</div>
      </main>
      <div class="status-stack">
        ${this.#uploading === undefined ? "" : html`<div class="status" role="status">Uploading ${this.#uploading.name} — ${formatSize(this.#uploading.received)} of ${formatSize(this.#uploading.total)}</div>`}
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
      <div class="viewer-head">
        <strong>${preview.entry.name}</strong>
        <div class="viewer-actions">
          <small>${formatSize(preview.entry.size)}</small>
          ${downloadUrl === undefined ? "" : html`<a class="viewer-action" href=${downloadUrl} download=${preview.entry.name}>Download</a>`}
          <button class="viewer-action" @click=${() => this.#copyText(preview.entry.path)}>Copy path</button>
          ${this.#relativePath(preview.entry.path) === undefined ? "" : html`<button class="viewer-action" @click=${() => this.#copyText(this.#relativePath(preview.entry.path) ?? "")}>Copy relative path</button>`}
        </div>
      </div>`;
    if (preview.error !== undefined) return html`${head}<div class="notice error">${preview.error}</div>`;
    if (preview.text !== undefined) return html`${head}<div class="viewer-body"><pre>${preview.text}</pre></div>`;
    if (preview.previewUrl !== undefined && isImage(preview.entry.name)) {
      return html`${head}<div class="viewer-body"><img class="preview" src=${preview.previewUrl} alt=${preview.entry.name}></div>`;
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
  try {
    window.localStorage.setItem(HIDDEN_PREFERENCE_KEY, value ? "1" : "0");
  } catch {
    // A browser that refuses storage keeps the toggle for this page only.
  }
}
