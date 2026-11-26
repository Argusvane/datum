/**
 * The PDF mode's state with no DOM in it: the form's layouts as edited, which one is
 * on the page, and what a change to either means for the designer over it — so the logic
 * behind the mode's chrome is testable under Node. `createPdfBuilderMode` draws it.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import { readPdfConfiguration, validatePdfLayout, type PdfConfiguration, type PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import { effectivePdfDefaultLayoutId, pdfLayoutsOf, replacePdfLayout } from "./layout-catalog.js";

export interface PdfModeSeed {
  /** The definition's `pdf` block, if it declares one. */
  pdf?: PdfConfiguration | undefined;
  /** The form the layouts print. */
  root: ComponentNode;
  /** The form's title, for a derived layout's heading. Absent: the root's `configuration.title`. */
  title?: string | undefined;
}

/**
 * The declared layouts, valid ones only. A definition with none has none here either: nothing
 * is written into it for the author — a host asked for its PDF prints the layout the
 * engine derives from the form. `dropped` counts declared layouts left out as unusable, and
 * `unusable` says which and why ("paper: areas[0] … needs a rect …"), so the mode can tell the
 * author on every seed, the first included: a definition saved from here no longer has them.
 */
export function seededPdfConfiguration(seed: PdfModeSeed): { configuration: PdfConfiguration; dropped: number; unusable: string[] } {
  const declared = seed.pdf;
  const layouts = readPdfConfiguration({ pdf: declared });
  const declaredLayouts: unknown[] = Array.isArray(declared?.layouts) ? declared.layouts : [];
  const unusable: string[] = [];
  declaredLayouts.forEach((layout, index) => {
    const problems = validatePdfLayout(layout);
    if (problems.length > 0) {
      const id = typeof (layout as { id?: unknown } | null)?.id === "string" && (layout as { id: string }).id !== "" ? (layout as { id: string }).id : `#${index + 1}`;
      unusable.push(`${id}: ${problems.join("; ")}`);
    }
  });
  const dropped = declaredLayouts.length - layouts.length;
  return { configuration: { ...(declared ?? {}), layouts }, dropped, unusable };
}

/** What a configuration change means for the designer over the layout on the page. */
export interface PdfModeApplyResult {
  before: PdfLayoutDocument | undefined;
  after: PdfLayoutDocument | undefined;
  /** The designer must be rebuilt: the page moved to another layout, or the one it shows changed underneath it. */
  rebuild: boolean;
  /** Only the name changed, under the same id: the open tree's document root takes the new one. */
  renamed: boolean;
}

export class PdfModeModel {
  private pdfValue: PdfConfiguration;
  private layoutIdValue: string | undefined;
  /** `layoutIdValue` was pinned by {@link pinShown} rather than chosen: another definition forgets it. */
  private pinnedOnly = false;

  /** The declared layouts the last seed left out as unusable, each as "id: problems". */
  private unusableValue: string[];

  constructor(seed: PdfModeSeed, layoutId?: string) {
    const seeded = seededPdfConfiguration(seed);
    this.pdfValue = seeded.configuration;
    this.unusableValue = seeded.unusable;
    this.layoutIdValue = layoutId;
  }

  /** The declared layouts the last seed (the first one included) left out as unusable, each as "id: problems". */
  public get unusable(): readonly string[] {
    return this.unusableValue;
  }

  /** Starts over on another definition's layouts; returns how many declared layouts were unusable. */
  public reseed(seed: PdfModeSeed): number {
    const seeded = seededPdfConfiguration(seed);
    this.pdfValue = seeded.configuration;
    this.unusableValue = seeded.unusable;
    if (this.pinnedOnly) {
      // Every designer starts over on another definition, so the page does too: at its default.
      this.layoutIdValue = undefined;
      this.pinnedOnly = false;
    }
    return seeded.dropped;
  }

  public get configuration(): PdfConfiguration {
    return this.pdfValue;
  }

  public get layouts(): PdfLayoutDocument[] {
    return [...pdfLayoutsOf(this.pdfValue)];
  }

  public get defaultId(): string | undefined {
    return effectivePdfDefaultLayoutId(this.pdfValue);
  }

  /** The chosen layout's id; the page falls back to the default, then the first, when it names none. */
  public get layoutId(): string | undefined {
    return this.layoutIdValue;
  }

  public set layoutId(value: string | undefined) {
    this.layoutIdValue = value;
    this.pinnedOnly = false;
  }

  /**
   * The layout on the page: the chosen one, else the default, else the first — conditions
   * aside: a layout's `when` decides what a download prints, never what the
   * designer shows.
   */
  public selected(): PdfLayoutDocument | undefined {
    const layouts = pdfLayoutsOf(this.pdfValue);
    const defaultId = this.defaultId;
    return (
      layouts.find((layout) => layout.id === this.layoutIdValue) ??
      layouts.find((layout) => layout.id === defaultId) ??
      layouts[0]
    );
  }

  public require(id: string): PdfLayoutDocument {
    const found = pdfLayoutsOf(this.pdfValue).find((layout) => layout.id === id);
    if (!found) {
      throw new Error(`No PDF layout has the id "${id}"`);
    }
    return found;
  }

  /** Commits `next`, moving the page to `select` when given, and says what the designer must do about it. */
  public apply(next: PdfConfiguration, select?: string): PdfModeApplyResult {
    const before = this.selected();
    this.pdfValue = next;
    if (select !== undefined) {
      this.layoutIdValue = select;
      this.pinnedOnly = false;
    }
    const after = this.selected();
    const moved = after?.id !== before?.id || after?.kind !== before?.kind;
    // The same layout, whatever its kind: anything but its name changing underneath the
    // designer rebuilds it; the name alone is pushed into the open tree instead.
    const sameLayout = before !== undefined && after !== undefined && !moved;
    const sansName = (layout: PdfLayoutDocument): string => JSON.stringify({ ...layout, name: undefined });
    const structural = sameLayout && sansName(before) !== sansName(after);
    const renamed = sameLayout && !structural && JSON.stringify(before.name ?? null) !== JSON.stringify(after.name ?? null);
    return { before, after, rebuild: moved || structural, renamed };
  }

  /**
   * Makes the layout on the page the chosen one when nothing was chosen, so it stays on the
   * page whatever the catalog's default does next. Until then the page follows the default,
   * and a change to the default — a "Set as default", or one written because a layout gained
   * a `when` — would move it from under an open designer, whose controller, panels
   * and `ready` would then describe a layout the canvas does not show. Returns the pinned id.
   */
  public pinShown(): string | undefined {
    if (this.layoutIdValue === undefined || !pdfLayoutsOf(this.pdfValue).some((layout) => layout.id === this.layoutIdValue)) {
      this.layoutIdValue = this.selected()?.id;
      this.pinnedOnly = this.layoutIdValue !== undefined;
    }
    return this.layoutIdValue;
  }

  /**
   * Puts the layout with this id on the page for good when it is the one there (see
   * {@link pinShown}), writing nothing: what the mode does when it opens a layout, since opening
   * one is no edit and the definition stays as it was, byte for byte.
   */
  public keepShown(id: string): void {
    if (this.selected()?.id === id) {
      this.pinShown();
    }
  }

  /**
   * The layout with this id replaced by what the designer holds — its own edit, not a change
   * of page. A designer holds the layout on the page, so that layout is pinned first (see
   * {@link pinShown}): the mode builds a designer and hands its layout back through here —
   * with `declareDefault: false`, since opening a layout is no edit and must not write a
   * default the definition lacks (see `replacePdfLayout`).
   */
  public replaceQuietly(id: string, layout: PdfLayoutDocument, options: { declareDefault?: boolean | undefined } = {}): void {
    const onPage = this.selected()?.id === id;
    if (onPage) {
      this.pinShown();
    }
    const current = pdfLayoutsOf(this.pdfValue).find((entry) => entry.id === id);
    if (current !== undefined && options.declareDefault === false && JSON.stringify(current) === JSON.stringify(layout)) {
      // Handed back as the catalog holds it (a layout opened): nothing is written, so the
      // configuration stays the object, and the bytes, it was.
      return;
    }
    this.pdfValue = replacePdfLayout(this.pdfValue, id, layout, options);
    if (onPage && this.layoutIdValue === id) {
      // Under its new id when the edit renamed it: the page stays with the layout.
      this.layoutIdValue = layout.id;
    }
  }
}
