/**
 * The outline panel: the component tree as a selectable list, docked beside the
 * canvas by the shell's activity strip. It is the index of the form — every component,
 * including the ones the canvas is not painting, with a marker on those — and the way to reach
 * a component gated behind a rule. Navigation only: a row selects, and the inspector's footer
 * is where a component is deleted.
 *
 * A docked panel hears every controller change, per-keystroke draft edits included, so it
 * repaints only when what it shows changed: the tree's shape and labels, the hidden set, the
 * selection.
 */
import type { NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import { canDefineCustomElements } from "../../render/web-component/custom-element-base.js";
import { BuilderPanelElement } from "./builder-panels.js";
import { BuilderWords, type BuilderTextCatalog } from "../logic/builder-texts.js";
import { builderTokens, esc, treeTabHtml, TREE_STYLES } from "./builder-shared.js";

export const DATUM_BUILDER_OUTLINE_TAG = "datum-builder-outline";

/** What the outline draws, flattened, so two paints that would look the same can be told apart cheaply. */
function treeSignature(view: NestedTreeNodeView): string {
  const parts: string[] = [];
  const walk = (node: NestedTreeNodeView, depth: number): void => {
    parts.push(`${depth}:${node.id}:${node.type}:${node.label}`);
    for (const slot of node.slots) {
      for (const child of slot.children) {
        walk(child, depth + 1);
      }
    }
  };
  walk(view, 0);
  return parts.join("\n");
}

export class DatumBuilderOutlineElement extends BuilderPanelElement {
  private bound = false;
  private signature: string | undefined;
  private hiddenSource: (() => ReadonlySet<string>) | undefined;
  /** The builder's words (the text catalog), English until the host sets a locale or catalog. */
  private readonly words = new BuilderWords();

  /** The builder's own language for its words, not the form's. */
  public set textLocale(value: string | undefined) {
    if (this.words.locale !== value) {
      this.words.locale = value;
      this.signature = undefined;
      this.paint();
    }
  }

  /** A host's translations of the builder's words, by key; absent keys fall back to English. */
  public set textCatalog(value: BuilderTextCatalog | undefined) {
    if (this.words.catalog !== value) {
      this.words.catalog = value;
      this.signature = undefined;
      this.paint();
    }
  }

  /**
   * Which components the canvas is currently hiding (a false `rules.visibleWhen`, or `hidden`),
   * read on every paint. The shell points this at the canvas; a panel used on its own marks none.
   */
  public set hiddenIds(source: (() => ReadonlySet<string>) | undefined) {
    this.hiddenSource = source;
    this.signature = undefined;
    this.paint();
  }

  public get hiddenIds(): (() => ReadonlySet<string>) | undefined {
    return this.hiddenSource;
  }

  protected override onIconsChange(): void {
    this.signature = undefined;
    this.paint();
  }

  protected render(): void {
    if (!this.ctrl) {
      this.root.innerHTML = `<style>${builderTokens()}</style><div class="panel card-stack"><div class="card empty-state"><p>${esc(this.words.text("shell.noController"))}</p></div></div>`;
      this.signature = undefined;
      return;
    }
    const view = this.ctrl.treeView();
    const hidden = this.hiddenSource?.() ?? new Set<string>();
    const selectedId = this.ctrl.selectedComponentId();
    const signature = `${treeSignature(view)}\n#${[...hidden].sort().join(",")}\n@${selectedId ?? ""}`;
    if (signature === this.signature && this.root.querySelector("[data-outline-list]")) {
      return;
    }
    this.signature = signature;
    this.root.innerHTML = `
      <style>${builderTokens()}${TREE_STYLES}${this.iconCss()}</style>
      <div class="panel card-stack">
        <div class="card"><h2 class="card-title">${esc(this.words.text("outline.title"))}</h2></div>
        <div class="card" data-outline-list>${treeTabHtml(view, {
          selectedId,
          hiddenIds: hidden,
          deletable: false,
          words: this.words.options(),
          ...(view.type === "journey" ? { note: this.words.text("outline.journeyNote") } : {})
        })}</div>
      </div>`;
    this.bind();
    // The selected row is brought into view: a selection made on the canvas or from the
    // palette may sit far down a long form.
    const active = this.root.querySelector<HTMLElement>(".tree-select.active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  private bind(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.root.addEventListener("click", (event) => {
      const id = (event.target as Element).closest?.<HTMLElement>("[data-tree-select]")?.dataset.treeSelect;
      if (id !== undefined) {
        // Asks first when the selection has unsaved edits — the prompt shows in the
        // properties panel, where Save and Cancel live.
        this.ctrl?.requestSelect(id);
      }
    });
    this.root.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key.toLowerCase() === "z") {
        keyEvent.preventDefault();
        // Through the shell's one Undo when it set one: a Step view undoes over the form and the journey.
        this.stepHistory(keyEvent.shiftKey ? "redo" : "undo");
      }
    });
  }
}

export function defineBuilderOutline(): void {
  if (!canDefineCustomElements()) {
    return;
  }
  if (!customElements.get(DATUM_BUILDER_OUTLINE_TAG)) {
    customElements.define(DATUM_BUILDER_OUTLINE_TAG, DatumBuilderOutlineElement);
  }
}
