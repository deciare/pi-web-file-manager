import { LitElement, css, html } from "lit";
import type { FileEntry } from "../shared/protocol.ts";
import type { PanelContext, SelectionService, SelectionSnapshot } from "./pluginApi.ts";
import { clientFor, fromBase64, type FileManagerClient } from "./client.ts";
import { hostCapabilities } from "./capabilities.ts";
import { defineFileTypeIcon, folderIcon, resolveIcon } from "./fileIcon.ts";
import { breadcrumbSegments, formatSize, resolveAddress } from "./breadcrumbs.ts";

/**
 * The browse panel.
 *
 * The list is one vertically scrolling region rather than pages, opened by a
 * `..` row and by breadcrumbs that double as an address bar: clicking the last
 * segment turns it into a text field holding the full path. There is no root
 * switcher — every path is reachable, so a list of shortcuts would only be a
 * second, worse address bar.
 *
 * Which directory was open is remembered per session in this page's memory
 * only, so switching sessions and coming back restores it, while a reload
 * starts again at the workspace root.
 */

export const PANEL_TAG = "pi-web-file-manager-panel";

export function defineFileManagerPanel(): void {
  defineFileTypeIcon();
  if (customElements.get(PANEL_TAG) === undefined) customElements.define(PANEL_TAG, FileManagerPanel);
}

interface Preview {
  readonly entry: FileEntry;
  readonly text?: string;
  readonly previewUrl?: string;
  readonly readOnlyReason?: "size" | "binary" | "directory";
  readonly error?: string;
}

export class FileManagerPanel extends LitElement {
  static override styles = css`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--pi-text); background: var(--pi-bg); font-size: 13px; }
    .toolbar { gap: 8px; padding-inline: 8px; border-bottom: 1px solid var(--pi-border-muted); }
    .breadcrumbs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; }
    .crumb { flex: 0 0 auto; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); padding: 3px 5px; font: inherit; font-family: var(--pi-mono, ui-monospace, monospace); cursor: pointer; }
    .crumb:hover { background: var(--pi-surface); color: var(--pi-text); }
    .crumb.current { color: var(--pi-text); }
    .separator { flex: 0 0 auto; color: var(--pi-dim); }
    .address { flex: 1 1 auto; min-width: 0; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 7px; font: inherit; font-family: var(--pi-mono, ui-monospace, monospace); direction: ltr; }
    main { flex: 1; display: grid; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); min-height: 0; }
    .list { overflow: auto; min-height: 0; border-bottom: 1px solid var(--pi-border); }
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
  `;

  #context: PanelContext | undefined;
  #selectionService: SelectionService | undefined;
  #unsubscribe: (() => void) | undefined;
  #client: FileManagerClient | undefined;
  #directory: string | undefined;
  #parent: string | null = null;
  #entries: FileEntry[] = [];
  #total = 0;
  #truncated = false;
  #loading = false;
  #error: string | undefined;
  #preview: Preview | undefined;
  #controller: AbortController | undefined;
  #key: string | undefined;
  #remembered = new Map<string, string>();
  #startScheduled = false;
  #editing = false;
  #draft = "";

  #unsubscribeIcons: (() => void) | undefined;

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
    this.#scheduleStart();
  }

  override disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeIcons?.();
    this.#unsubscribeIcons = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    super.disconnectedCallback();
  }

  override updated(): void {
    if (!this.#editing) return;
    const input = this.renderRoot.querySelector<HTMLInputElement>(".address");
    const root = this.renderRoot as ShadowRoot;
    if (input !== null && root.activeElement !== input) {
      input.focus();
      input.select();
    }
  }

  #scheduleStart(): void {
    if (!this.isConnected || this.#startScheduled) return;
    this.#startScheduled = true;
    queueMicrotask(() => {
      this.#startScheduled = false;
      void this.#start();
    });
  }

  async #start(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#controller?.abort();
    this.#client = undefined;
    this.#directory = undefined;
    try {
      this.#client = this.#context === undefined ? undefined : clientFor(this.#context);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
      return;
    }
    const snapshot = this.#selectionService?.getSnapshot();
    this.#key = keyFor(this.#context, snapshot);
    await this.#openFor(this.#key, snapshot);
    if (this.#selectionService !== undefined) {
      this.#unsubscribe = this.#selectionService.subscribe((next) => { this.#onSelectionChanged(next); });
    }
  }

  #onSelectionChanged(snapshot: SelectionSnapshot): void {
    const key = keyFor(this.#context, snapshot);
    if (key === this.#key) return;
    if (this.#directory !== undefined && this.#key !== undefined) this.#remembered.set(this.#key, this.#directory);
    this.#key = key;
    void this.#openFor(key, snapshot);
  }

  async #openFor(key: string | undefined, snapshot: SelectionSnapshot | undefined): Promise<void> {
    const remembered = key === undefined ? undefined : this.#remembered.get(key);
    const workspacePath = snapshot?.selectedWorkspace?.path ?? this.#context?.workspace?.path;
    await this.#openDirectory(remembered ?? workspacePath ?? "~");
  }

  async #openDirectory(path: string): Promise<void> {
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
    this.requestUpdate();
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

  #startEditingPath(): void {
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

  #renderBreadcrumbs() {
    const directory = this.#directory;
    if (this.#editing) {
      return html`
        <input
          class="address"
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
    if (directory === undefined) return html`<span class="crumb current">…</span>`;
    const segments = breadcrumbSegments(directory);
    return segments.map((segment, index) => html`
      ${index === 0 ? "" : html`<span class="separator" aria-hidden="true">/</span>`}
      <button
        class=${`crumb ${index === segments.length - 1 ? "current" : ""}`}
        title=${index === segments.length - 1 ? "Edit path" : segment.path}
        @click=${() => { if (index === segments.length - 1) this.#startEditingPath(); else void this.#openDirectory(segment.path); }}
      >${segment.name}</button>
    `);
  }

  #renderRow(entry: FileEntry) {
    const selected = this.#preview?.entry.path === entry.path;
    const directory = entry.kind === "directory" || entry.linkKind === "directory";
    return html`
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
    `;
  }

  override render() {
    const atRoot = this.#directory === undefined || this.#parent === null || this.#parent === this.#directory;
    return html`
      <div class="ui-toolbar toolbar">
        <div class="ui-toolbar-group breadcrumbs">${this.#renderBreadcrumbs()}</div>
        <div class="ui-toolbar-group">
          <button
            class="ui-button ui-button--compact ui-button--icon"
            title="Refresh directory"
            aria-label="Refresh directory"
            ?disabled=${this.#loading}
            @click=${() => { if (this.#directory !== undefined) void this.#openDirectory(this.#directory); }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>
          </button>
        </div>
      </div>
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
          ${this.#entries.length === 0
            ? html`<div class="notice">${this.#loading ? "Loading…" : "Empty directory"}</div>`
            : this.#entries.map((entry) => this.#renderRow(entry))}
          ${this.#truncated ? html`<div class="truncated">Showing the first ${String(this.#entries.length)} of ${String(this.#total)} entries.</div>` : ""}
        </div>
        <div class="viewer">${this.#renderViewer()}</div>
      </main>
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
          <button class="viewer-action" @click=${() => void navigator.clipboard?.writeText(preview.entry.path)}>Copy path</button>
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
