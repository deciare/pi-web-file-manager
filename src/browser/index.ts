import { html, svg } from "lit";
import { defineFileManagerPanel } from "./panel.ts";
import {
  fileIconsCapability, markdownRenderingCapability, setHostCapabilities, stylesheetIntegrationCapability,
} from "./capabilities.ts";

/**
 * Browser half. One application panel, so the file manager is available with
 * or without a project selected and follows whichever machine is in view.
 *
 * `requires` names the host capabilities that give the panel the rest of
 * PI WEB's appearance — the active file-icon theme, the shared UI stylesheet —
 * and the host's Markdown renderer, so a Markdown preview is parsed and styled
 * by the same code as the rest of the application.
 * Resolving them in `start` means an older host reports a missing capability
 * instead of rendering a panel with no icons and no row styling.
 */
const plugin = {
  apiVersion: 5,
  name: "File manager",
  requires: [fileIconsCapability, stylesheetIntegrationCapability, markdownRenderingCapability],
  activate(context: { selection?: unknown }) {
    defineFileManagerPanel();
    const selection = context.selection;
    return {
      contributions: {
        applicationPanels: [
          {
            id: "files",
            order: 45,
            title: "File manager",
            icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path></svg>`,
            render: (panelContext: unknown) => html`<pi-web-file-manager-panel .context=${panelContext} .selectionService=${selection}></pi-web-file-manager-panel>`,
          },
        ],
      },
      start({ capabilities }: { capabilities: { resolve<T>(token: unknown): T } }) {
        setHostCapabilities({
          icons: capabilities.resolve(fileIconsCapability),
          styles: capabilities.resolve(stylesheetIntegrationCapability),
          markdown: capabilities.resolve(markdownRenderingCapability),
        });
      },
    };
  },
};

export default plugin;
