/**
 * The builder's command palette: Ctrl+K or
 * Cmd+K, a box, every command the builder offers filtered as you type, Enter to run. Loaded in a
 * chunk of its own the first time it opens (`palette-loader.ts`). The shell builds the commands;
 * each runs through the same method its control calls, so nothing here is a second path.
 */
import { builderTokens, esc } from "../web-component/builder-shared.js";
import { HTMLElementBase, canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { rankCommands, type BuilderCommand, type BuilderCommandGroup, type RankedCommand } from "./palette-filter.js";
import type { BuilderTextCatalog, BuilderTextKey } from "../logic/builder-texts.js";
import { areaWords } from "./palette-texts-en.js";
import { MODAL_BACKDROP_CLIP, MODAL_H, MODAL_INSET, MODAL_W, showBuilderModal } from "../web-component/modal-place.js";

export const DATUM_BUILDER_PALETTE_TAG = "datum-builder-palette";

export interface PaletteOpenOptions {
  commands: BuilderCommand[];
  /** Ids of the commands run last, most recent first. */
  recent: readonly string[];
  /** After a command ran (the shell records it as recent). */
  onRun?: ((id: string) => void) | undefined;
  /** After the palette closed, run or not (the shell gives focus back). */
  onClose?: (() => void) | undefined;
}

const GROUP_LABELS: Record<BuilderCommandGroup, BuilderTextKey> = {
  workspaces: "palette.group.workspaces",
  add: "palette.group.add",
  "go to": "palette.group.goTo",
  edit: "palette.group.edit",
  documents: "palette.group.documents",
  view: "palette.group.view",
  host: "palette.group.host"
};

export class DatumBuilderPaletteElement extends HTMLElementBase {
  private readonly root: ShadowRoot;
  private options: PaletteOpenOptions | undefined;
  private ranked: RankedCommand[] = [];
  private active = 0;
  private bound = false;
  /** The builder's words (the text catalog) for the palette's labels. */
  private readonly words = areaWords();
  /** Bumped when the words move, so an open-again palette is drawn in them. */
  private wordsVersion = 0;
  private drawnVersion = -1;

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.wordsVersion += 1;
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.wordsVersion += 1;
    }
  }

  public constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  /** Opens over the builder, the box focused, every command listed. */
  public open(options: PaletteOpenOptions): void {
    this.options = options;
    this.render();
    const dialog = this.dialog();
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        showBuilderModal(dialog);
      } else {
        dialog.setAttribute("open", "");
      }
    }
    const input = this.input();
    if (input) {
      input.value = "";
      input.focus();
    }
    this.filter("");
  }

  public close(): void {
    const dialog = this.dialog();
    if (dialog?.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
    const done = this.options?.onClose;
    this.options = undefined;
    done?.();
  }

  public get isOpen(): boolean {
    return this.dialog()?.open === true;
  }

  private dialog(): HTMLDialogElement | null {
    return this.root.querySelector<HTMLDialogElement>("dialog");
  }

  private input(): HTMLInputElement | null {
    return this.root.querySelector<HTMLInputElement>("[data-palette-input]");
  }

  private render(): void {
    if (this.root.querySelector("dialog") && this.drawnVersion === this.wordsVersion) {
      this.bind();
      return;
    }
    this.drawnVersion = this.wordsVersion;
    const w = this.words;
    const commands = esc(w.text("palette.label"));
    this.root.innerHTML = `<style>${builderTokens()}${PALETTE_STYLES}</style>
      <dialog class="palette" aria-label="${commands}" data-palette>
        <div class="palette-box">
          <input type="text" data-palette-input role="combobox" aria-expanded="true" aria-controls="palette-list"
            aria-autocomplete="list" aria-label="${esc(w.text("palette.search.label"))}" placeholder="${esc(w.text("palette.search.placeholder"))}" autocomplete="off" spellcheck="false">
          <ul class="palette-list" id="palette-list" role="listbox" aria-label="${commands}" data-palette-list></ul>
          <p class="palette-count sr-only" aria-live="polite" data-palette-count></p>
        </div>
      </dialog>`;
    this.bind();
  }

  private filter(query: string): void {
    const options = this.options;
    if (!options) {
      return;
    }
    this.ranked = rankCommands(options.commands, query, options.recent);
    this.active = this.firstEnabled(0, 1) ?? 0;
    this.drawList(query.trim() === "");
    const count = this.root.querySelector<HTMLElement>("[data-palette-count]");
    if (count) {
      count.textContent = this.ranked.length === 0 ? this.words.text("palette.none") : this.words.plural("palette.commands", this.ranked.length);
    }
  }

  private drawList(empty: boolean): void {
    const list = this.root.querySelector<HTMLElement>("[data-palette-list]");
    if (!list) {
      return;
    }
    const recent = new Set(this.options?.recent ?? []);
    list.innerHTML =
      this.ranked.length === 0
        ? `<li class="palette-empty" role="presentation">${esc(this.words.text("palette.none.line"))}</li>`
        : this.ranked
            .map(({ command, matched }, index) => {
              const disabled = command.enabled ? !command.enabled() : false;
              const where = empty && recent.has(command.id) ? this.words.text("palette.recent") : this.words.text(GROUP_LABELS[command.group]);
              return `<li role="option" id="palette-option-${index}" class="palette-option" data-palette-option="${index}"
                  aria-selected="${index === this.active}"${disabled ? ' aria-disabled="true"' : ""}>
                  <span class="palette-label">${highlight(command.label, matched)}</span>
                  <span class="palette-meta">${command.shortcut ? `<kbd>${esc(command.shortcut)}</kbd>` : ""}<span class="palette-group">${esc(where)}</span></span>
                </li>`;
            })
            .join("");
    this.syncActive();
  }

  private syncActive(): void {
    const input = this.input();
    for (const option of this.root.querySelectorAll<HTMLElement>("[data-palette-option]")) {
      const on = Number(option.dataset.paletteOption) === this.active;
      option.setAttribute("aria-selected", String(on));
      if (on) {
        option.scrollIntoView?.({ block: "nearest" });
      }
    }
    if (input) {
      if (this.ranked.length > 0) {
        input.setAttribute("aria-activedescendant", `palette-option-${this.active}`);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }
  }

  /** The first enabled command from `start` stepping by `step`; `undefined` when none. */
  private firstEnabled(start: number, step: 1 | -1): number | undefined {
    for (let index = start; index >= 0 && index < this.ranked.length; index += step) {
      const command = this.ranked[index]!.command;
      if (!command.enabled || command.enabled()) {
        return index;
      }
    }
    return undefined;
  }

  private move(step: 1 | -1): void {
    if (this.ranked.length === 0) {
      return;
    }
    const length = this.ranked.length;
    for (let tries = 1; tries <= length; tries += 1) {
      const index = (this.active + step * tries + length) % length;
      const command = this.ranked[index]!.command;
      if (!command.enabled || command.enabled()) {
        this.active = index;
        break;
      }
    }
    this.syncActive();
  }

  private runAt(index: number): void {
    const entry = this.ranked[index];
    if (!entry || (entry.command.enabled && !entry.command.enabled())) {
      return;
    }
    const options = this.options;
    // Closed first: a command may open a prompt or a menu of its own, which must not sit under it.
    this.close();
    options?.onRun?.(entry.command.id);
    void entry.command.run();
  }

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("input", (event) => {
      if ((event.target as HTMLElement).dataset?.paletteInput !== undefined) {
        this.filter((event.target as HTMLInputElement).value);
      }
    });
    this.root.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        this.move(key === "ArrowDown" ? 1 : -1);
      } else if (key === "Home" || key === "End") {
        if ((event.target as HTMLElement).dataset?.paletteInput !== undefined && (event as KeyboardEvent).ctrlKey !== true) {
          event.preventDefault();
          this.active = (key === "Home" ? this.firstEnabled(0, 1) : this.firstEnabled(this.ranked.length - 1, -1)) ?? this.active;
          this.syncActive();
        }
      } else if (key === "Enter") {
        event.preventDefault();
        this.runAt(this.active);
      } else if (key === "Tab") {
        // The box keeps focus: the list is reached by the arrows (a combobox's pattern).
        event.preventDefault();
      }
    });
    this.root.addEventListener("click", (event) => {
      const option = (event.target as HTMLElement).closest<HTMLElement>("[data-palette-option]");
      if (option) {
        this.runAt(Number(option.dataset.paletteOption));
        return;
      }
      // A click on the backdrop (the dialog itself, outside its box) closes it.
      if ((event.target as HTMLElement).dataset?.palette !== undefined) {
        this.close();
      }
    });
    this.root.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        this.close();
      },
      true
    );
  }
}

function highlight(label: string, matched: readonly number[]): string {
  if (matched.length === 0) {
    return esc(label);
  }
  const marks = new Set(matched);
  let out = "";
  for (let index = 0; index < label.length; index += 1) {
    const char = esc(label[index]!);
    out += marks.has(index) ? `<mark>${char}</mark>` : char;
  }
  return out;
}

const PALETTE_STYLES = `
  :host { display: contents; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  dialog.palette {
    inset: ${MODAL_INSET};
    margin: calc(${MODAL_H} * .12) auto auto; padding: 0; width: min(560px, calc(${MODAL_W} - 32px)); max-height: calc(${MODAL_H} * .7);
    border: var(--db-border-w) solid var(--db-line-card); border-radius: var(--db-radius-xl);
    background: var(--db-surface); color: var(--db-ink); box-shadow: var(--db-shadow-overlay);
    font-family: var(--db-font); font-size: var(--db-text-md);
  }
  dialog.palette::backdrop { background: var(--db-scrim, rgba(22, 23, 26, .42)); ${MODAL_BACKDROP_CLIP} }
  .palette-box { display: flex; flex-direction: column; max-height: calc(${MODAL_H} * .7); }
  [data-palette-input] {
    box-sizing: border-box; width: 100%; min-block-size: 52px; padding: 0 var(--db-space-4);
    border: 0; border-bottom: var(--db-border-w) solid var(--db-line-divider); border-radius: 0; background: transparent; color: var(--db-ink);
    font: inherit; font-size: var(--db-text-lg); outline: none;
  }
  [data-palette-input]:focus-visible { box-shadow: inset 0 -2px 0 var(--db-focus); }
  .palette-list { list-style: none; margin: 0; padding: var(--db-space-1); overflow: auto; }
  .palette-option {
    display: flex; align-items: center; justify-content: space-between; gap: var(--db-space-3);
    min-block-size: 40px; padding: 0 var(--db-space-3); border-radius: var(--db-radius-md); cursor: pointer;
  }
  .palette-option[aria-selected="true"] { background: var(--db-selected); color: var(--db-selected-ink); }
  .palette-option[aria-disabled="true"] { opacity: .45; cursor: default; }
  .palette-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .palette-label mark { background: none; color: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
  .palette-meta { display: inline-flex; align-items: center; gap: var(--db-space-2); flex: none; font-size: var(--db-text-sm); opacity: .8; }
  kbd { font-family: var(--db-font-mono); font-size: var(--db-text-xs); padding: 1px var(--db-space-1); border: var(--db-border-w) solid currentColor; border-radius: var(--db-radius-xs); }
  .palette-empty { padding: var(--db-space-4); color: var(--db-ink-muted); }
  @media (forced-colors: active) {
    .palette-option[aria-selected="true"] { outline: 2px solid Highlight; }
    [data-palette-input]:focus-visible { outline: 2px solid Highlight; outline-offset: -2px; }
  }
  /* A phone: a tall sheet from the window's bottom edge, its rows a finger tall. */
  :host([data-phone]) dialog.palette {
    margin: auto 0 0; width: ${MODAL_W}; max-width: ${MODAL_W}; height: calc(var(--db-modal-h, 100dvh) - 8px); max-height: calc(var(--db-modal-h, 100dvh) - 8px);
    border-width: 0; border-radius: 22px 22px 0 0;
  }
  :host([data-phone]) .palette-box { height: 100%; max-height: none; padding-bottom: env(safe-area-inset-bottom, 0px); }
  :host([data-phone]) [data-palette-input] { min-block-size: 56px; font-size: var(--db-text-lg); }
  :host([data-phone]) .palette-option { min-block-size: 48px; }
`;

export function defineBuilderPalette(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_PALETTE_TAG)) {
    customElements.define(DATUM_BUILDER_PALETTE_TAG, DatumBuilderPaletteElement);
  }
}

defineBuilderPalette();
