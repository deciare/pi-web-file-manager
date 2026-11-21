import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css as cssLanguage } from "@codemirror/lang-css";
import { html as htmlLanguage } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching, defaultHighlightStyle, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting,
} from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { LitElement, css, html } from "lit";

/**
 * Syntax highlighting without the parser for a language we do not have: the
 * file still opens, still edits, and reads as plain text.
 */
const NO_LANGUAGE = [] as const;

const LANGUAGES: Readonly<Record<string, () => Extension>> = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  jsonc: () => json(),
  css: () => cssLanguage(),
  html: () => htmlLanguage(),
  htm: () => htmlLanguage(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  yaml: () => yaml(),
  yml: () => yaml(),
  toml: () => StreamLanguage.define(toml),
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),
  dockerfile: () => StreamLanguage.define(dockerFile),
};

const FILENAME_LANGUAGES: Readonly<Record<string, () => Extension>> = {
  Dockerfile: () => StreamLanguage.define(dockerFile),
  Makefile: () => StreamLanguage.define(shell),
  ".gitignore": () => StreamLanguage.define(shell),
  ".gitattributes": () => StreamLanguage.define(shell),
  ".bashrc": () => StreamLanguage.define(shell),
  ".profile": () => StreamLanguage.define(shell),
};

export function languageForPath(path: string): Extension {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const byName = FILENAME_LANGUAGES[name];
  if (byName !== undefined) return byName();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return LANGUAGES[extension]?.() ?? NO_LANGUAGE;
}

/**
 * Colours come from the theme's own CSS variables, so the editor follows a
 * theme change the same way the rest of the panel does, including the syntax
 * palette the theme already defines.
 */
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--pi-text)",
    backgroundColor: "var(--pi-bg)",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    lineHeight: "1.5",
    overflow: "auto",
  },
  ".cm-content": { padding: "6px 0", caretColor: "var(--pi-accent)" },
  ".cm-line": { padding: "0 8px" },
  ".cm-gutters": {
    backgroundColor: "var(--pi-bg)",
    color: "var(--pi-dim)",
    border: "none",
    borderInlineEnd: "1px solid var(--pi-border-muted)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--pi-text) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--pi-text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--pi-accent)" },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--pi-selection-bg) !important",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--pi-accent) 25%, transparent)",
    outline: "none",
  },
  ".cm-panels": { backgroundColor: "var(--pi-surface)", color: "var(--pi-text)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--pi-warning) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--pi-warning) 55%, transparent)",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--pi-syntax-comment, var(--pi-muted))", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--pi-syntax-keyword, var(--pi-accent))" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--pi-syntax-string, var(--pi-success))" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--pi-syntax-number, var(--pi-warning))" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: "var(--pi-syntax-title, var(--pi-accent))" },
  { tag: [t.typeName, t.className, t.tagName, t.attributeName], color: "var(--pi-purple, var(--pi-text))" },
  { tag: [t.propertyName, t.variableName], color: "var(--pi-text)" },
  { tag: [t.deleted, t.invalid], color: "var(--pi-syntax-deletion, var(--pi-danger))" },
  { tag: [t.link, t.url], color: "var(--pi-accent)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.heading, color: "var(--pi-syntax-title, var(--pi-accent))", fontWeight: "600" },
]);

/**
 * The editing surface for one file.
 *
 * `path` and `wrap` are inputs; the document itself is owned by CodeMirror and
 * reported out through `fm-change`, so a re-render of the panel never reaches
 * into the text. Setting `revision` replaces the document — that is how a
 * reload from disk discards what was typed without losing the position.
 */
export class FileEditor extends LitElement {
  static override styles = css`
    :host { display: block; height: 100%; min-height: 0; }
    .host { height: 100%; }
  `;

  static override properties = {
    path: { type: String },
    wrap: { type: Boolean },
    text: { type: String },
    editable: { type: Boolean },
  };

  declare path: string;
  declare wrap: boolean;
  declare text: string;
  declare editable: boolean;

  #view: EditorView | undefined;
  #language = new Compartment();
  #wrapping = new Compartment();
  #host: HTMLDivElement | undefined;
  /** The document the parent last handed in, to ignore its own echoes. */
  #loaded = "";

  constructor() {
    super();
    this.path = "";
    this.wrap = true;
    this.text = "";
    this.editable = true;
  }

  override firstUpdated(): void {
    const host = this.renderRoot.querySelector<HTMLDivElement>(".host");
    if (host === null) return;
    this.#host = host;
    this.#loaded = this.text;
    const state = EditorState.create({
      doc: this.#loaded,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        syntaxHighlighting(highlightStyle),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        this.#language.of(languageForPath(this.path)),
        this.#wrapping.of(this.wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.#loaded = update.state.doc.toString();
          this.dispatchEvent(new CustomEvent("fm-change", { bubbles: true, composed: true }));
        }),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => {
          this.dispatchEvent(new CustomEvent("fm-save", { bubbles: true, composed: true }));
          return true;
        } }]),
        EditorView.editable.of(this.editable),
        editorTheme,
      ],
    });
    this.#view = new EditorView({ state, parent: host });
  }

  /** Called by the panel before it hands in a new document. */
  override updated(changed: Map<PropertyKey, unknown>): void {
    const view = this.#view;
    if (view === undefined) return;
    if (changed.has("path")) {
      view.dispatch({ effects: this.#language.reconfigure(languageForPath(this.path)) });
    }
    if (changed.has("wrap")) {
      view.dispatch({ effects: this.#wrapping.reconfigure(this.wrap ? EditorView.lineWrapping : []) });
    }
    // The document is CodeMirror's while it is open: only a value the panel
    // deliberately replaced — a reload from disk — reaches in here, and only
    // when it actually differs from what is on screen.
    if (changed.has("text") && view.state.doc.toString() !== this.text) {
      this.#loaded = this.text;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: this.text } });
    }
  }

  /** What is in the document right now, typed or loaded. */
  get documentText(): string {
    return this.#view?.state.doc.toString() ?? this.#loaded;
  }

  focusEditor(): void {
    this.#view?.focus();
  }

  override disconnectedCallback(): void {
    this.#view?.destroy();
    this.#view = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`<div class="host"></div>`;
  }
}

export function defineFileEditor(): void {
  if (customElements.get("fm-editor") === undefined) customElements.define("fm-editor", FileEditor);
}
