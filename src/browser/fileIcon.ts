import { LitElement, css, html } from "lit";
import { hostCapabilities } from "./capabilities.ts";

/**
 * A file-type glyph from the host's active file-icon theme.
 *
 * The theme supplies a URL to an icon whose colour is meaningless here, so it
 * is painted as an alpha mask in `currentColor` — the same approach the bundled
 * Files panel uses, which is why the icons match it exactly rather than merely
 * resembling it. The hidden probe image exists so a broken URL falls back to
 * the plain document glyph instead of an invisible mask.
 */
export class FileTypeIcon extends LitElement {
  static override styles = css`
    :host { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--pi-muted, currentColor); }
    .mask { display: block; width: 16px; height: 16px; background-color: currentColor; mask-size: contain; mask-repeat: no-repeat; mask-position: center; }
    svg { display: block; }
  `;

  url: string | undefined;
  #loadedUrl: string | undefined;
  #failedUrl: string | undefined;

  override render() {
    const url = this.url;
    const fallback = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path></svg>`;
    if (url === undefined || url === this.#failedUrl) return fallback;
    return html`
      ${this.#loadedUrl === url
        ? html`<span class="mask" style=${`mask-image:url(${JSON.stringify(url)})`}></span>`
        : fallback}
      <img
        hidden
        src=${url}
        alt=""
        crossorigin="anonymous"
        referrerpolicy="no-referrer"
        draggable="false"
        @load=${() => { if (this.url === url) { this.#loadedUrl = url; this.requestUpdate(); } }}
        @error=${() => { if (this.url === url) { this.#failedUrl = url; this.requestUpdate(); } }}
      >
    `;
  }
}

/** The folder glyph, matching the tab icon and the host's stroke weight. */
export function folderIcon() {
  return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path></svg>`;
}

export function resolveIcon(path: string): string | undefined {
  return hostCapabilities().icons?.resolveIcon(path);
}

export function defineFileTypeIcon(): void {
  if (customElements.get("fm-file-icon") === undefined) customElements.define("fm-file-icon", FileTypeIcon);
}
