/**
 * Host capabilities this plugin uses, declared as structural types.
 *
 * Two of them buy visual parity with the rest of PI WEB rather than imitation:
 * `file-icons` resolves the icon for a path through whichever file-icon theme
 * the user has chosen, and `stylesheet-integration` adopts the host's shared UI
 * sheet — buttons, toolbars, and the compact 32px file rows — into our shadow
 * root. Copying artwork and pixel values would drift the moment either changes;
 * asking the host gives the running frontend's own answer.
 */

export interface FileIcons {
  resolveIcon(path: string): string | undefined;
  subscribe(listener: () => void): () => void;
}

export interface StylesheetIntegration {
  registerRoot(root: ShadowRoot, options?: { sharedUi?: boolean }): () => void;
  subscribe(listener: () => void): () => void;
  createController(host: object, options?: { sharedUi?: boolean }): void;
}

export interface CapabilityToken<Value> {
  readonly pluginId: string;
  readonly id: string;
  readonly version: number;
  readonly parse: (value: unknown) => Value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const fileIconsCapability: CapabilityToken<FileIcons> = {
  pluginId: "pi-web",
  id: "file-icons",
  version: 1,
  parse(value) {
    if (!isRecord(value) || typeof value["resolveIcon"] !== "function" || typeof value["subscribe"] !== "function") {
      throw new Error("File icons capability v1 is unavailable");
    }
    return value as unknown as FileIcons;
  },
};

export const stylesheetIntegrationCapability: CapabilityToken<StylesheetIntegration> = {
  pluginId: "pi-web",
  id: "stylesheet-integration",
  version: 1,
  parse(value) {
    if (!isRecord(value) || typeof value["createController"] !== "function" || typeof value["registerRoot"] !== "function") {
      throw new Error("Stylesheet integration capability v1 is unavailable");
    }
    return value as unknown as StylesheetIntegration;
  },
};

/**
 * Capabilities are resolved in `start`, which runs after contributions are
 * declared but before any panel renders. Elements are constructed by the host's
 * template, so the resolved values are held here rather than passed down as
 * properties: a Lit element's constructor runs before any property is assigned.
 */
interface HostCapabilityState {
  icons: FileIcons | undefined;
  styles: StylesheetIntegration | undefined;
}

const state: HostCapabilityState = { icons: undefined, styles: undefined };

export function setHostCapabilities(next: HostCapabilityState): void {
  state.icons = next.icons;
  state.styles = next.styles;
}

export function hostCapabilities(): Readonly<HostCapabilityState> {
  return state;
}
