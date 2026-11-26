/**
 * Pagination: the document's blocks, in flow order, become pages of drawables
 * with coordinates. Policy came from the engine (breaks, keep-together, repeating headers,
 * anchors); the arithmetic — which line lands where — is decided here, from the fonts'
 * measurements, and nowhere else.
 *
 * Coordinates in this module run top-down in points (y grows toward the page's foot); the
 * writer flips them into PDF space when it draws.
 */
import { DEFAULT_PDF_PAGE_SETUP, pdfPageDimensions, type ResolvedPdfPageSetup } from "@argusvane/datum-engine/core";
import type {
  PdfAnchoredBox,
  PdfBlock,
  PdfBlockStyle,
  PdfBoxBlock,
  PdfDocument,
  PdfFontSpec,
  PdfFormFieldSpec,
  PdfHeadingBlock,
  PdfLabelValueBlock,
  PdfListBlock,
  PdfPageReport,
  PdfTableBlock,
  PdfTextRun,
  PdfTypography,
  PdfThemeColors,
  PdfWarning,
  PdfWidgetBlock
} from "@argusvane/datum-engine/render";
import { PdfKernelError, resolvePdfRenderLimits } from "@argusvane/datum-engine/render";
import type { FontSet } from "./fonts.js";
import type { LayoutSettings } from "./settings.js";
import { listItemIds } from "./tagging.js";
import { layoutLines, resolveRuns, weightOf, type LinePiece, type TextLine, type TextStyle } from "./text.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Drawable = (
  | { kind: "text"; x: number; baselineY: number; piece: LinePiece; blockId?: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; thickness: number; color: string; blockId?: string }
  | { kind: "rect"; rect: Rect; fill?: string; stroke?: { width: number; color: string }; radius?: number; blockId?: string }
  | { kind: "image"; rect: Rect; resourceId: string; alt: string; blockId?: string }
  | { kind: "widget"; rect: Rect; field: PdfFormFieldSpec; option?: string; blockId?: string }
  | {
      kind: "checkmark";
      rect: Rect;
      checked: boolean;
      color: string;
      /** Draw the box around the tick. Default on; off where the page already prints one (template areas). */
      border?: boolean;
      /** A square with a tick (default), or a circle with a dot — a radio. */
      shape?: "square" | "circle";
      borderWidth?: number;
      radius?: number;
      markStroke?: number;
      dotSize?: number;
      /** The dot's colour; absent: `color`. */
      markColor?: string;
      blockId?: string;
    }
) & {
  /** Decoration a reader skips (running headers and footers, rules, borders): tagged as an artifact. */
  artifact?: boolean;
};

export interface LaidOutPage {
  setup: ResolvedPdfPageSetup;
  width: number;
  height: number;
  drawables: Drawable[];
}

export interface LayoutContext {
  fonts: FontSet;
  typography: PdfTypography;
  colors: PdfThemeColors;
  /** The theme's geometry, or the kernel's fallbacks for a document that carries none. */
  settings: LayoutSettings;
  textDirection: "ltr" | "rtl";
  /** Natural sizes of the embedded images, by resource id; absent means the image was not embedded. */
  images: Map<string, { width: number; height: number }>;
  warnings: PdfWarning[];
}

interface Region {
  x: number;
  width: number;
}

const RULE_GAP = 1.6;
/** Between a step tag and its heading. */
const TAG_GAP = 2;

const SCRATCH_HEIGHT = 1e9;

/** The pages being filled, with the cursor on the current one. */
class Flow {
  public readonly pages: LaidOutPage[] = [];
  public y = 0;
  private setup: ResolvedPdfPageSetup;
  private pageEmpty = true;
  /** The spacing advanced after the last block, with no content since: what a fixed-height region need not hold. */
  private trailing = 0;
  private static warnedRow = false;

  constructor(setup: ResolvedPdfPageSetup, private readonly bounded: boolean, private readonly pageCap: number = Infinity) {
    this.setup = setup;
    this.newPage();
  }

  public get page(): LaidOutPage {
    return this.pages[this.pages.length - 1]!;
  }

  public currentSetup(): ResolvedPdfPageSetup {
    return this.setup;
  }

  public contentX(): number {
    return this.setup.margins.left;
  }

  public contentWidth(): number {
    const { width } = pdfPageDimensions(this.setup);
    return width - this.setup.margins.left - this.setup.margins.right;
  }

  public contentTop(): number {
    return this.setup.margins.top + (this.setup.header?.height ?? 0);
  }

  public contentBottom(): number {
    if (!this.bounded) {
      return SCRATCH_HEIGHT;
    }
    const { height } = pdfPageDimensions(this.setup);
    return height - this.setup.margins.bottom - (this.setup.footer?.height ?? 0);
  }

  public contentHeight(): number {
    return this.contentBottom() - this.contentTop();
  }

  public remaining(): number {
    return this.contentBottom() - this.y;
  }

  public atPageTop(): boolean {
    return this.pageEmpty;
  }

  public newPage(setup?: ResolvedPdfPageSetup): void {
    if (setup) {
      this.setup = setup;
    }
    if (this.bounded && this.pages.length >= this.pageCap) {
      // A document past its page cap is refused, not truncated: the cap is the layout's `limits.pages`.
      throw new PdfKernelError("render_limit", `render.pageCap: the document runs past its ${this.pageCap}-page cap; shorten the answers or raise the layout's limits.pages.`);
    }
    const { width, height } = pdfPageDimensions(this.setup);
    this.pages.push({ setup: this.setup, width, height: this.bounded ? height : SCRATCH_HEIGHT, drawables: [] });
    this.y = this.contentTop();
    this.pageEmpty = true;
    this.trailing = 0;
  }

  /** Makes room for `height`, breaking the page unless it is already empty. */
  public ensure(height: number): void {
    if (this.bounded && this.remaining() < height && !this.pageEmpty) {
      this.newPage();
    }
  }

  public add(drawable: Drawable): void {
    this.page.drawables.push(drawable);
    this.pageEmpty = false;
    this.trailing = 0;
  }

  public advance(height: number): void {
    this.y += height;
    if (height > 0) {
      this.pageEmpty = false;
      this.trailing = 0;
    }
  }

  /** Advances the spacing that follows a block, remembered until content lands below it. */
  public trail(height: number): void {
    this.y += height;
    if (height > 0) {
      this.pageEmpty = false;
      this.trailing += height;
    }
  }

  /** The height laid out on a scratch flow's single page. */
  public scratchHeight(): number {
    return this.y - this.contentTop();
  }

  /**
   * The height the content occupies: `scratchHeight` less the spacing that trails the last
   * block — what a region of fixed height (a running band, an anchored box) has to hold.
   */
  public contentExtent(): number {
    return this.scratchHeight() - this.trailing;
  }

  public static warnRowOnce(): boolean {
    if (Flow.warnedRow) {
      return false;
    }
    Flow.warnedRow = true;
    return true;
  }
}

export function translate(drawables: readonly Drawable[], dx: number, dy: number): Drawable[] {
  return drawables.map((drawable) => {
    switch (drawable.kind) {
      case "text":
        return { ...drawable, x: drawable.x + dx, baselineY: drawable.baselineY + dy };
      case "line":
        return { ...drawable, x1: drawable.x1 + dx, x2: drawable.x2 + dx, y1: drawable.y1 + dy, y2: drawable.y2 + dy };
      default:
        return { ...drawable, rect: { ...drawable.rect, x: drawable.rect.x + dx, y: drawable.rect.y + dy } };
    }
  });
}

function bodyStyle(ctx: LayoutContext, style?: PdfBlockStyle): TextStyle {
  const body = ctx.typography.body;
  return {
    family: style?.family ?? body.family,
    size: style?.size ?? body.size,
    lineHeight: body.lineHeight ?? 1.35,
    color: style?.color ?? body.color ?? ctx.colors.text,
    weight: weightOf(body) ?? 400,
    ...(body.transform ? { transform: body.transform } : {})
  };
}

function labelStyle(ctx: LayoutContext): TextStyle {
  const label = ctx.typography.label;
  return {
    family: label.family,
    size: label.size,
    lineHeight: label.lineHeight ?? 1.3,
    color: label.color ?? ctx.colors.muted,
    weight: weightOf(label) ?? 700,
    ...(label.transform ? { transform: label.transform } : {})
  };
}

function headingStyle(ctx: LayoutContext, level: number, style?: PdfBlockStyle): TextStyle {
  const heading = ctx.typography.heading;
  const sizes = heading.sizes;
  const index = Math.min(level, sizes.length) - 1;
  const size = style?.size ?? sizes[index] ?? sizes[sizes.length - 1] ?? 12;
  const lineHeights = heading.lineHeights ?? [];
  return {
    family: style?.family ?? heading.family,
    size,
    lineHeight: lineHeights[Math.min(level, lineHeights.length) - 1] ?? lineHeights[lineHeights.length - 1] ?? 1.25,
    color: style?.color ?? heading.color ?? ctx.colors.text,
    weight: weightOf(heading) ?? 700
  };
}

/** A theme's optional type role as a style: its own family, size and colour, or `fallback` when the theme names none. */
function roleStyle(spec: PdfFontSpec | undefined, color: string, fallback: TextStyle, defaultWeight: number): TextStyle {
  if (!spec) {
    return fallback;
  }
  return {
    family: spec.family,
    size: spec.size,
    lineHeight: spec.lineHeight ?? fallback.lineHeight,
    color: spec.color ?? color,
    weight: weightOf(spec) ?? defaultWeight,
    ...(spec.transform ? { transform: spec.transform } : {})
  };
}

/** A field's hint: the theme's hint type, else the body in the muted colour. */
function hintStyle(ctx: LayoutContext): TextStyle {
  const body = bodyStyle(ctx);
  return roleStyle(ctx.typography.hint, ctx.colors.muted, { ...body, color: ctx.colors.muted, weight: 400 }, 400);
}

/** A choice option's caption: the theme's option type, else the body. */
function optionStyle(ctx: LayoutContext, style?: PdfBlockStyle): TextStyle {
  const body = bodyStyle(ctx, style);
  const spec = ctx.typography.option;
  return spec ? roleStyle(spec, ctx.colors.text, body, 400) : body;
}

/** A choice group's caption: the theme's legend type, else the label. */
function legendStyle(ctx: LayoutContext): TextStyle {
  const label = labelStyle(ctx);
  return roleStyle(ctx.typography.legend, label.color, label, 700);
}

/** The required marker: the theme's required type, else the label's face at regular weight. */
function requiredStyle(ctx: LayoutContext, label: TextStyle): TextStyle {
  return roleStyle(ctx.typography.required, label.color, { ...label, weight: 400, transform: "none" }, 400);
}

/** A prefix or suffix: the theme's affix type, else the body in the muted colour. */
function affixStyle(ctx: LayoutContext): TextStyle {
  const body = bodyStyle(ctx);
  return roleStyle(ctx.typography.affix, ctx.colors.muted, { ...body, color: ctx.colors.muted }, 400);
}

/** The step line above a heading: the theme's step-tag type, else its small type, else the label's face at regular weight. */
function stepTagStyle(ctx: LayoutContext): TextStyle {
  const label = labelStyle(ctx);
  const small = roleStyle(ctx.typography.small, ctx.colors.muted, { ...label, weight: 400, color: ctx.colors.muted, transform: "none" }, 400);
  return roleStyle(ctx.typography.stepTag, ctx.colors.muted, small, 700);
}

/** The label's runs: the caption, then the required marker in its own type. */
function labelRuns(label: string, suffix: string | undefined, labelStyleUsed: TextStyle, ctx: LayoutContext): PdfTextRun[] {
  if (suffix === undefined || suffix === "") {
    return [{ text: label }];
  }
  const marker = requiredStyle(ctx, labelStyleUsed);
  return [
    { text: label },
    {
      text: suffix,
      weight: marker.weight ?? 400,
      color: marker.color,
      transform: marker.transform ?? "none",
      ...(marker.family !== labelStyleUsed.family ? { family: marker.family } : {}),
      ...(marker.size !== labelStyleUsed.size ? { size: marker.size } : {})
    }
  ];
}

function spacingOf(block: PdfBlock, ctx: LayoutContext): [number, number] {
  const [before, after] = ctx.settings.spacing[block.kind];
  return [block.style?.spacingBefore ?? before, block.style?.spacingAfter ?? after];
}

/** The width a frame or widget takes: the block's own, capped by the theme's reading width, never wider than the column. */
function controlWidth(own: number | undefined, region: Region, ctx: LayoutContext): number {
  const cap = ctx.settings.controls.maxWidth;
  return Math.max(1, Math.min(region.width, own ?? cap ?? region.width, cap ?? region.width));
}

/** The label column of the `inline` arrangement, in points; `undefined` when the theme keeps label and value on one line. */
function inlineLabelWidth(region: Region, ctx: LayoutContext): number | undefined {
  const width = ctx.settings.fields.inlineLabelWidth;
  if (width === undefined) {
    return undefined;
  }
  const points = typeof width === "number" ? width : width.fraction * region.width;
  return Math.max(1, Math.min(points, region.width * 0.8));
}

/** A hint under a label or a control, at the field's indent. */
async function placeHint(text: string, flow: Flow, region: Region, ctx: LayoutContext, blockId: string, indent = 0): Promise<void> {
  await placeText([{ text }], hintStyle(ctx), flow, region, ctx, { indent, blockId });
}

interface PlaceTextOptions {
  align?: PdfBlockStyle["align"] | undefined;
  indent?: number;
  blockId?: string | undefined;
  tokens?: { pageNumber: number; pageCount: number } | undefined;
  /** Drawn beside the first line, at the region's start; used by check marks and list markers. */
  leading?: ((firstLineY: number, lineHeight: number, line: TextLine) => Drawable) | undefined;
}

/** Lays runs out as lines into the flow, page by page. Returns the height taken. */
async function placeText(
  runs: readonly PdfTextRun[],
  style: TextStyle,
  flow: Flow,
  region: Region,
  ctx: LayoutContext,
  options: PlaceTextOptions = {}
): Promise<number> {
  const indent = options.indent ?? 0;
  const shaped = await resolveRuns(runs, style, ctx.fonts, options.tokens);
  const width = Math.max(1, region.width - indent);
  const lines = layoutLines(shaped, width, ctx.textDirection, style.lineHeight);
  const align = options.align ?? "start";
  const start = flow.y;
  let first = true;
  for (const line of lines) {
    flow.ensure(line.height);
    let offset = 0;
    const slack = width - line.width;
    const right = ctx.textDirection === "rtl" ? align !== "end" : align === "end";
    if (align === "center") {
      offset = slack / 2;
    } else if (right) {
      offset = slack;
    }
    const lineTop = flow.y;
    if (first && options.leading) {
      flow.add(options.leading(lineTop, line.height, line));
    }
    for (const piece of line.pieces) {
      if (piece.text.length === 0) {
        continue;
      }
      flow.add({
        kind: "text",
        x: region.x + indent + offset + piece.x,
        baselineY: lineTop + line.ascent,
        piece,
        ...(options.blockId ? { blockId: options.blockId } : {})
      });
    }
    flow.advance(line.height);
    first = false;
  }
  return flow.y - start;
}

async function measureBlocks(
  blocks: readonly PdfBlock[],
  width: number,
  setup: ResolvedPdfPageSetup,
  ctx: LayoutContext
): Promise<{ height: number; extent: number; drawables: Drawable[] }> {
  const scratch = new Flow(setup, false);
  await layoutBlocks(blocks, scratch, { x: 0, width }, ctx);
  // `height` keeps the last block's trailing spacing (a flow box draws it); `extent` does not.
  return { height: scratch.scratchHeight(), extent: scratch.contentExtent(), drawables: translate(scratch.page.drawables, 0, -scratch.contentTop()) };
}

/**
 * Blocks laid out on their own, `width` wide, with no page to break on: their height and
 * their drawables from the origin — for content placed by hand on a page the kernel did not
 * lay out (a template's areas). The page setup only lends its margins, which cancel out.
 */
export async function measureFragment(blocks: readonly PdfBlock[], width: number, ctx: LayoutContext): Promise<{ height: number; drawables: Drawable[] }> {
  return measureBlocks(blocks, width, DEFAULT_PDF_PAGE_SETUP, ctx);
}

async function layoutBlocks(blocks: readonly PdfBlock[], flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  for (let index = 0; index < blocks.length; index += 1) {
    await layoutBlock(blocks[index]!, blocks[index + 1], flow, region, ctx);
  }
}

async function layoutBlock(block: PdfBlock, next: PdfBlock | undefined, flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  const [before, after] = spacingOf(block, ctx);
  const spaceBefore = (): void => {
    if (!flow.atPageTop()) {
      flow.advance(before);
    }
  };
  switch (block.kind) {
    case "heading": {
      spaceBefore();
      await layoutHeading(block, flow, region, ctx, after);
      flow.trail(after);
      return;
    }
    case "paragraph": {
      spaceBefore();
      if (block.keepWithNext && next) {
        const measured = await measureBlocks([block, next], region.width, flow.currentSetup(), ctx);
        if (measured.height <= flow.contentHeight()) {
          flow.ensure(measured.height);
        }
      }
      await placeText(block.runs, bodyStyle(ctx, block.style), flow, region, ctx, {
        align: block.style?.align,
        blockId: block.id,
        indent: block.style?.indent ?? 0
      });
      flow.trail(after);
      return;
    }
    case "labelValue":
      spaceBefore();
      await layoutLabelValue(block, flow, region, ctx);
      flow.trail(after);
      return;
    case "widget":
      spaceBefore();
      await layoutWidget(block, flow, region, ctx);
      flow.trail(after);
      return;
    case "checkmark": {
      spaceBefore();
      const choice = ctx.settings.choice;
      const style = optionStyle(ctx, block.style);
      await placeChoiceItem(
        { caption: block.label, mark: (rect) => checkmarkDrawable(rect, block.checked, "square", block.id, ctx) },
        choice.size,
        style,
        undefined,
        flow,
        region,
        ctx,
        block.id
      );
      if (block.hint) {
        flow.advance(ctx.settings.fields.labelToHint);
        await placeHint(block.hint, flow, region, ctx, block.id, choice.size + choice.labelGap);
      }
      flow.trail(after);
      return;
    }
    case "checklist": {
      spaceBefore();
      const choice = ctx.settings.choice;
      const fields = ctx.settings.fields;
      const hintFirst = block.hint !== undefined && fields.hintPosition === "afterLabel";
      if (block.label) {
        const legend = legendStyle(ctx);
        await placeText(labelRuns(block.label, block.labelSuffix, legend, ctx), legend, flow, region, ctx, { blockId: block.id });
        if (hintFirst) {
          flow.advance(fields.labelToHint);
          await placeHint(block.hint!, flow, region, ctx, block.id);
          flow.advance(fields.hintToControl);
        } else {
          flow.advance(choice.legendGap);
        }
      } else if (hintFirst) {
        await placeHint(block.hint!, flow, region, ctx, block.id);
        flow.advance(fields.hintToControl);
      }
      const style = optionStyle(ctx, block.style);
      // An option's hint: the theme's hint type, else a smaller muted line under the caption, indented past the box like it.
      const descriptionStyle: TextStyle = ctx.typography.hint
        ? hintStyle(ctx)
        : { ...style, size: Math.max(6, style.size - 1.5), color: ctx.colors.muted, weight: 400 };
      const shape = block.marker === "radio" ? "circle" : "square";
      await placeChoiceItems(
        block.items.map((item) => ({
          caption: item.label,
          ...(item.description ? { description: item.description } : {}),
          mark: (rect) => checkmarkDrawable(rect, item.checked, shape, block.id, ctx)
        })),
        choice.size,
        style,
        descriptionStyle,
        flow,
        region,
        ctx,
        block.id
      );
      if (block.hint !== undefined && !hintFirst) {
        await placeHint(block.hint, flow, region, ctx, block.id);
      }
      flow.trail(after);
      return;
    }
    case "list": {
      spaceBefore();
      await layoutList(block, flow, region, ctx, 0);
      flow.trail(after);
      return;
    }
    case "table":
      spaceBefore();
      await layoutTable(block, flow, region, ctx);
      flow.trail(after);
      return;
    case "image": {
      const natural = ctx.images.get(block.resourceId);
      if (!natural) {
        ctx.warnings.push({ code: "image.unavailable", message: `Image "${block.resourceId}" was not embedded; skipped.`, blockId: block.id });
        return;
      }
      spaceBefore();
      let width = block.width ?? natural.width;
      let height = block.height ?? (block.width ? (natural.height * block.width) / natural.width : natural.height);
      if (block.width === undefined && block.height !== undefined) {
        width = (natural.width * block.height) / natural.height;
      }
      if (width > region.width) {
        height = (height * region.width) / width;
        width = region.width;
      }
      if (height > flow.contentHeight()) {
        width = (width * flow.contentHeight()) / height;
        height = flow.contentHeight();
      }
      flow.ensure(height);
      const x = ctx.textDirection === "rtl" ? region.x + region.width - width : region.x;
      flow.add({ kind: "image", rect: { x, y: flow.y, width, height }, resourceId: block.resourceId, alt: block.alt, blockId: block.id });
      flow.advance(height + after);
      return;
    }
    case "rule": {
      spaceBefore();
      const thickness = block.thickness ?? 0.75;
      flow.ensure(thickness);
      flow.add({
        kind: "line",
        x1: region.x,
        y1: flow.y + thickness / 2,
        x2: region.x + region.width,
        y2: flow.y + thickness / 2,
        thickness,
        color: block.color ?? ctx.colors.border,
        blockId: block.id
      });
      flow.advance(thickness + after);
      return;
    }
    case "spacer":
      flow.advance(Math.min(block.height, flow.remaining()));
      return;
    case "box":
      spaceBefore();
      await layoutBox(block, flow, region, ctx);
      flow.trail(after);
      return;
    case "group": {
      if (block.keepTogether) {
        const measured = await measureBlocks(block.blocks, region.width, flow.currentSetup(), ctx);
        if (measured.height <= flow.contentHeight()) {
          flow.ensure(measured.height);
        }
      }
      await layoutBlocks(block.blocks, flow, region, ctx);
      return;
    }
    case "pageBreak":
      flow.newPage(block.page);
      return;
  }
}

/** The drawn mark for a check box or radio, in the theme's geometry. */
function checkmarkDrawable(rect: Rect, checked: boolean, shape: "square" | "circle", blockId: string, ctx: LayoutContext): Drawable {
  const choice = ctx.settings.choice;
  return {
    kind: "checkmark",
    rect,
    checked,
    color: ctx.colors.text,
    shape,
    borderWidth: choice.borderWidth,
    radius: choice.radius,
    markStroke: choice.markStroke,
    ...(choice.dotSize !== undefined ? { dotSize: choice.dotSize } : {}),
    markColor: ctx.colors.choiceMark ?? ctx.colors.text,
    blockId
  };
}

interface ChoiceItem {
  caption: string;
  description?: string;
  /** The drawn mark beside the first line (a check box or radio), or… */
  mark?: (rect: Rect) => Drawable;
  /** …the AcroForm widget, added after the caption as widgets always were. */
  widget?: (rect: Rect) => Drawable;
}

/**
 * One option: its mark or widget at the region's start, its caption beside it, its hint under
 * the caption. A box taller than the line is the row's height, the caption centred beside it;
 * a box no taller than the line changes nothing about how the row always lay out.
 */
async function placeChoiceItem(
  item: ChoiceItem,
  size: number,
  style: TextStyle,
  descriptionStyle: TextStyle | undefined,
  flow: Flow,
  region: Region,
  ctx: LayoutContext,
  blockId: string
): Promise<void> {
  const choice = ctx.settings.choice;
  const indent = size + choice.labelGap;
  const lineHeight = style.size * style.lineHeight;
  flow.ensure(Math.max(size, lineHeight));
  const top = flow.y;
  const textOffset = Math.max(0, (size - lineHeight) / 2);
  if (textOffset > 0) {
    flow.advance(textOffset);
  }
  const markRect = (lineTop: number, lh: number): Rect => ({ x: region.x, y: lineTop + (lh - size) / 2, width: size, height: size });
  if (item.caption.length > 0 || item.mark) {
    await placeText([{ text: item.caption }], style, flow, region, ctx, {
      indent,
      blockId,
      ...(item.mark ? { leading: (lineTop: number, lh: number) => item.mark!(markRect(lineTop, lh)) } : {})
    });
  } else {
    flow.advance(lineHeight);
  }
  if (item.widget) {
    flow.add(item.widget(markRect(top + textOffset, lineHeight)));
  }
  if (item.description && descriptionStyle) {
    await placeText([{ text: item.description }], descriptionStyle, flow, region, ctx, { indent, blockId });
  }
  if (flow.y < top + size) {
    flow.advance(top + size - flow.y);
  }
}

/** The options of a choice, one under another, or in the theme's columns, row by row. */
async function placeChoiceItems(
  items: ChoiceItem[],
  size: number,
  style: TextStyle,
  descriptionStyle: TextStyle | undefined,
  flow: Flow,
  region: Region,
  ctx: LayoutContext,
  blockId: string
): Promise<void> {
  const choice = ctx.settings.choice;
  const columns = Math.max(1, Math.min(choice.columns, items.length || 1));
  if (columns === 1) {
    for (const item of items) {
      await placeChoiceItem(item, size, style, descriptionStyle, flow, region, ctx, blockId);
      flow.advance(choice.optionGap);
    }
    return;
  }
  const columnWidth = region.width / columns;
  for (let start = 0; start < items.length; start += columns) {
    const row = items.slice(start, start + columns);
    const measured: Array<{ height: number; drawables: Drawable[] }> = [];
    for (const item of row) {
      const scratch = new Flow(flow.currentSetup(), false);
      await placeChoiceItem(item, size, style, descriptionStyle, scratch, { x: 0, width: columnWidth - choice.labelGap }, ctx, blockId);
      measured.push({ height: scratch.scratchHeight(), drawables: translate(scratch.page.drawables, 0, -scratch.contentTop()) });
    }
    const rowHeight = Math.max(...measured.map((entry) => entry.height));
    flow.ensure(rowHeight);
    const top = flow.y;
    measured.forEach((entry, index) => {
      const column = ctx.textDirection === "rtl" ? columns - 1 - index : index;
      for (const drawable of translate(entry.drawables, region.x + column * columnWidth, top)) {
        flow.add(drawable);
      }
    });
    flow.advance(rowHeight + choice.optionGap);
  }
}

/** A heading with the theme's dressing: a step tag above, a section number before, a band behind, a rule beneath. */
async function layoutHeading(block: PdfHeadingBlock, flow: Flow, region: Region, ctx: LayoutContext, after: number): Promise<void> {
  const style = headingStyle(ctx, block.level, block.style);
  const headings = ctx.settings.headings;
  const indent = block.style?.indent ?? 0;
  const align = block.style?.align;
  const tagStyle = block.tag !== undefined ? stepTagStyle(ctx) : undefined;
  const tagHeight = tagStyle ? tagStyle.size * tagStyle.lineHeight + TAG_GAP : 0;
  const bandPad = block.band ? headings.bandPadding : 0;
  const ruleHeight = block.rule ? headings.bandPadding + headings.titleRuleWidth : 0;
  if (block.keepWithNext !== false) {
    // A heading is never the last thing on a page: keep two body lines' worth with it.
    const body = bodyStyle(ctx);
    flow.ensure(tagHeight + 2 * bandPad + style.size * style.lineHeight + ruleHeight + body.size * body.lineHeight * 2 + after);
  }
  if (tagStyle && block.tag !== undefined) {
    await placeText([{ text: block.tag }], tagStyle, flow, region, ctx, { blockId: block.id, indent, align });
    flow.advance(TAG_GAP);
  }
  const runs: PdfTextRun[] = block.number !== undefined ? [{ text: `${block.number}  ` }, ...block.runs] : block.runs;
  if (block.band) {
    const shaped = await resolveRuns(runs, style, ctx.fonts);
    const lines = layoutLines(shaped, Math.max(1, region.width - 2 * bandPad - indent), ctx.textDirection, style.lineHeight);
    const bandHeight = lines.reduce((sum, line) => sum + line.height, 0) + 2 * bandPad;
    flow.ensure(bandHeight);
    const accent = headings.band === "accent";
    flow.add({
      kind: "rect",
      rect: { x: region.x, y: flow.y, width: region.width, height: bandHeight },
      fill: accent ? ctx.colors.accent : ctx.colors.surface,
      artifact: true,
      blockId: block.id
    });
    flow.advance(bandPad);
    const onBand: TextStyle = accent ? { ...style, color: ctx.colors.onAccent ?? "#ffffff" } : style;
    await placeText(runs, onBand, flow, { x: region.x + bandPad, width: region.width - 2 * bandPad }, ctx, { align, blockId: block.id, indent });
    flow.advance(bandPad);
  } else {
    await placeText(runs, style, flow, region, ctx, { align, blockId: block.id, indent });
  }
  if (block.rule) {
    const width = headings.titleRuleWidth;
    flow.advance(headings.bandPadding);
    const y = flow.y + width / 2;
    flow.add({ kind: "line", x1: region.x, y1: y, x2: region.x + region.width, y2: y, thickness: width, color: ctx.colors.border, artifact: true, blockId: block.id });
    flow.advance(width);
  }
}

/** A list from authored content: a marker at the start, the text at the theme's hanging indent, nested lists indented once more. */
async function layoutList(block: PdfListBlock, flow: Flow, region: Region, ctx: LayoutContext, depth: number): Promise<void> {
  const list = ctx.settings.list;
  const style = bodyStyle(ctx, block.style);
  const inner: Region = { x: region.x + list.indent, width: Math.max(1, region.width - list.indent) };
  for (const [index, item] of block.items.entries()) {
    const ids = listItemIds(block.id, index);
    const marker = block.ordered ? `${index + 1}.` : depth > 0 ? "–" : list.bullet;
    const [shapedMarker] = await resolveRuns([{ text: marker }], style, ctx.fonts);
    if (item.runs.length > 0) {
      await placeText(item.runs, style, flow, inner, ctx, {
        blockId: ids.body,
        leading: (lineTop, _lineHeight, line) => ({
          kind: "text",
          x: region.x,
          baselineY: lineTop + line.ascent,
          piece: {
            text: shapedMarker?.text ?? marker,
            font: shapedMarker!.font,
            size: shapedMarker!.size,
            color: shapedMarker!.color,
            x: 0,
            width: shapedMarker ? shapedMarker.font.font.widthOfTextAtSize(shapedMarker.text, shapedMarker.size) : 0
          },
          blockId: ids.label
        })
      });
    }
    for (const nested of item.blocks ?? []) {
      await layoutList(nested, flow, inner, ctx, depth + 1);
    }
    if (index < block.items.length - 1) {
      flow.advance(list.gap);
    }
  }
}

/** The affix runs around a value: the prefix before, the suffix after, in the theme's affix type. */
function affixRuns(block: Pick<PdfLabelValueBlock, "prefix" | "suffix" | "value">, body: TextStyle, ctx: LayoutContext): PdfTextRun[] {
  if (block.prefix === undefined && block.suffix === undefined) {
    return block.value;
  }
  const affix = affixStyle(ctx);
  const run = (text: string): PdfTextRun => ({
    text,
    color: affix.color,
    weight: affix.weight ?? 400,
    ...(affix.family !== body.family ? { family: affix.family } : {}),
    ...(affix.size !== body.size ? { size: affix.size } : {})
  });
  return [...(block.prefix !== undefined ? [run(`${block.prefix} `)] : []), ...block.value, ...(block.suffix !== undefined ? [run(` ${block.suffix}`)] : [])];
}

/** A chevron at a select's end: two strokes, the theme's mark for a select on paper. */
function chevronDrawables(x: number, top: number, height: number, size: number, ctx: LayoutContext, blockId: string): Drawable[] {
  const stroke = Math.max(0.5, ctx.settings.controls.borderWidth);
  const color = ctx.colors.controlBorder ?? ctx.colors.border;
  const half = size / 2;
  const cy = top + height / 2;
  return [
    { kind: "line", x1: x - half, y1: cy - half / 2, x2: x, y2: cy + half / 2, thickness: stroke, color, artifact: true, blockId },
    { kind: "line", x1: x, y1: cy + half / 2, x2: x + half, y2: cy - half / 2, thickness: stroke, color, artifact: true, blockId }
  ];
}

interface FrameMeasure {
  width: number;
  x: number;
  chevron: number;
  runs: PdfTextRun[];
  inner: number;
  lines: TextLine[];
  lineHeight: number;
  height: number;
}

/** The control box a value takes: its width, the value's lines inside it, and the height the box grows to. */
async function measureFrame(block: PdfLabelValueBlock, body: TextStyle, region: Region, ctx: LayoutContext): Promise<FrameMeasure> {
  const controls = ctx.settings.controls;
  const width = controlWidth(block.width, region, ctx);
  const x = ctx.textDirection === "rtl" ? region.x + region.width - width : region.x;
  const chevron = block.control === "select" && controls.selectMark === "chevron" ? body.size * 0.5 : 0;
  const runs = affixRuns(block, body, ctx);
  const inner = Math.max(1, width - 2 * controls.padding - (chevron > 0 ? chevron + controls.padding : 0));
  const shaped = await resolveRuns(runs, body, ctx.fonts);
  const lines = layoutLines(shaped, inner, ctx.textDirection, body.lineHeight);
  const lineHeight = body.size * body.lineHeight;
  const rows = block.control === "textarea" ? (controls.textareaRows ?? 1) : 1;
  const textHeight = Math.max(lines.reduce((sum, line) => sum + line.height, 0), rows * lineHeight);
  const height = Math.max(controls.minHeight, textHeight + 2 * controls.padding);
  return { width, x, chevron, runs, inner, lines, lineHeight, height };
}

/** The height a run of text takes in a region, for keeping a label with what follows it. */
async function textHeight(runs: readonly PdfTextRun[], style: TextStyle, width: number, ctx: LayoutContext): Promise<number> {
  const shaped = await resolveRuns(runs, style, ctx.fonts);
  return layoutLines(shaped, Math.max(1, width), ctx.textDirection, style.lineHeight).reduce((sum, line) => sum + line.height, 0);
}

/**
 * The value inside the theme's control box: wrapped to the box, the box grown to
 * fit — never clipped, never shrunk. A box that fits a page but not what is left of this one
 * moves whole to the next; one taller than a page flows without its frame, as a `pdf-box`
 * does, with a `frame.overflow` warning.
 */
async function placeFramedValue(block: PdfLabelValueBlock, body: TextStyle, flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  const controls = ctx.settings.controls;
  const { width, x, chevron, runs, inner, lines, lineHeight, height } = await measureFrame(block, body, region, ctx);
  const textRegion: Region = { x: x + controls.padding, width: inner };
  if (height > flow.contentHeight()) {
    ctx.warnings.push({ code: "frame.overflow", message: "A value is taller than a page; it flows without its box.", blockId: block.id });
    await placeText(runs, body, flow, textRegion, ctx, { blockId: block.id });
    return;
  }
  flow.ensure(height);
  const top = flow.y;
  flow.add({
    kind: "rect",
    rect: { x, y: top, width, height },
    fill: ctx.colors.controlFill ?? "#ffffff",
    ...(controls.borderWidth > 0 ? { stroke: { width: controls.borderWidth, color: ctx.colors.controlBorder ?? ctx.colors.border } } : {}),
    ...(controls.radius > 0 ? { radius: controls.radius } : {}),
    blockId: block.id
  });
  // A single line sits centred in a box taller than it, as an input's text does; a textarea's starts at the top.
  const offset = lines.length === 1 && block.control !== "textarea" ? (height - lineHeight) / 2 : controls.padding;
  flow.advance(offset);
  await placeText(runs, body, flow, textRegion, ctx, { blockId: block.id });
  if (chevron > 0) {
    const centre = ctx.textDirection === "rtl" ? x + controls.padding + chevron / 2 : x + width - controls.padding - chevron / 2;
    for (const drawable of chevronDrawables(centre, top, height, chevron, ctx, block.id)) {
      flow.add(drawable);
    }
  }
  flow.advance(Math.max(0, top + height - flow.y));
}

async function layoutLabelValue(block: PdfLabelValueBlock, flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  const fields = ctx.settings.fields;
  const label = labelStyle(ctx);
  const body = bodyStyle(ctx, block.style);
  const hasLabel = block.label.length > 0;
  const hintFirst = block.hint !== undefined && fields.hintPosition === "afterLabel";
  const hintLast = block.hint !== undefined && !hintFirst;
  if (block.arrangement === "inline" && hasLabel) {
    const column = inlineLabelWidth(region, ctx);
    if (column === undefined) {
      const runs: PdfTextRun[] = [
        ...labelRuns(block.label, block.labelSuffix, label, ctx).map((run, index) => (index === 0 ? { ...run, text: block.labelSuffix ? run.text : `${run.text}  `, bold: true, size: label.size, color: label.color } : run)),
        ...(block.labelSuffix ? [{ text: "  " }] : []),
        ...affixRuns(block, body, ctx)
      ];
      await placeText(runs, body, flow, region, ctx, { blockId: block.id });
    } else {
      // The label in its column, the value beside it; the row is the taller of the two.
      const labelRegion: Region = { x: region.x, width: column - fields.labelToValue };
      const valueRegion: Region = { x: region.x + column, width: Math.max(1, region.width - column) };
      const setup = flow.currentSetup();
      const left = new Flow(setup, false);
      await placeText(labelRuns(block.label, block.labelSuffix, label, ctx), label, left, { x: 0, width: labelRegion.width }, ctx, { blockId: block.id });
      const right = new Flow(setup, false);
      if (block.frame) {
        await placeFramedValue(block, body, right, { x: 0, width: valueRegion.width }, ctx);
      } else {
        await placeText(affixRuns(block, body, ctx), body, right, { x: 0, width: valueRegion.width }, ctx, { blockId: block.id });
      }
      const height = Math.max(left.scratchHeight(), right.scratchHeight());
      flow.ensure(height);
      const top = flow.y;
      for (const drawable of translate(left.page.drawables, labelRegion.x, top - left.contentTop())) {
        flow.add(drawable);
      }
      for (const drawable of translate(right.page.drawables, valueRegion.x, top - right.contentTop())) {
        flow.add(drawable);
      }
      flow.advance(height);
      if (block.hint !== undefined) {
        flow.advance(fields.labelToHint);
        await placeHint(block.hint, flow, valueRegion, ctx, block.id);
      }
    }
    return;
  }
  if (hasLabel) {
    // Keep the label with what it labels: a framed value's whole box (and the hint between them)
    // when that fits a page, else at least the first line of the value.
    const runs = labelRuns(block.label, block.labelSuffix, label, ctx);
    let keep = label.size * label.lineHeight + body.size * body.lineHeight;
    if (block.frame && block.arrangement === "stacked") {
      const labelHeight = await textHeight(runs, label, region.width, ctx);
      const hintHeight = hintFirst ? (await textHeight([{ text: block.hint! }], hintStyle(ctx), region.width, ctx)) + fields.labelToHint + fields.hintToControl : fields.labelToValue;
      const together = labelHeight + hintHeight + (await measureFrame(block, body, region, ctx)).height;
      if (together <= flow.contentHeight()) {
        keep = together;
      }
    }
    flow.ensure(keep);
    await placeText(runs, label, flow, region, ctx, { blockId: block.id });
    if (hintFirst) {
      flow.advance(fields.labelToHint);
      await placeHint(block.hint!, flow, region, ctx, block.id);
      flow.advance(fields.hintToControl);
    } else {
      flow.advance(fields.labelToValue);
    }
  } else if (hintFirst) {
    await placeHint(block.hint!, flow, region, ctx, block.id);
    flow.advance(fields.hintToControl);
  }
  if (block.arrangement === "ruled") {
    const lines = Math.max(1, block.lines ?? 1);
    const ruleHeight = body.size * RULE_GAP;
    const value = block.value.map((run) => run.text).join("");
    for (let line = 0; line < lines; line += 1) {
      flow.ensure(ruleHeight);
      if (line === 0 && value.trim().length > 0) {
        const shaped = await resolveRuns(block.value, body, ctx.fonts);
        const laid = layoutLines(shaped, region.width, ctx.textDirection, body.lineHeight)[0];
        if (laid) {
          for (const piece of laid.pieces) {
            flow.add({ kind: "text", x: region.x + piece.x, baselineY: flow.y + ruleHeight - 3, piece, blockId: block.id });
          }
        }
      }
      const y = flow.y + ruleHeight;
      flow.add({ kind: "line", x1: region.x, y1: y, x2: region.x + region.width, y2: y, thickness: 0.5, color: ctx.colors.border, blockId: block.id });
      flow.advance(ruleHeight);
    }
  } else if (block.frame) {
    await placeFramedValue(block, body, flow, region, ctx);
  } else {
    await placeText(affixRuns(block, body, ctx), body, flow, region, ctx, { blockId: block.id });
  }
  if (hintLast) {
    flow.advance(fields.labelToHint);
    await placeHint(block.hint!, flow, region, ctx, block.id);
  }
}

/** A widget's height: the block's own, else the theme's for the kind (a textarea's rows, a pre-filled multiline grown to its lines). */
async function widgetHeight(field: PdfFormFieldSpec, block: PdfWidgetBlock, width: number, ctx: LayoutContext): Promise<number> {
  if (block.height !== undefined) {
    return block.height;
  }
  const controls = ctx.settings.controls;
  switch (field.kind) {
    case "multiline":
    case "listbox": {
      if (controls.textareaRows === undefined) {
        return 56;
      }
      const body = bodyStyle(ctx);
      const lineHeight = body.size * body.lineHeight;
      let lines = 0;
      if (field.kind === "multiline" && typeof field.value === "string" && field.value.length > 0) {
        const shaped = await resolveRuns([{ text: field.value }], body, ctx.fonts);
        lines = layoutLines(shaped, Math.max(1, width - 2 * (controls.borderWidth + 1) - 2 * controls.padding), ctx.textDirection, body.lineHeight).length;
      }
      return Math.max(controls.textareaRows, lines) * lineHeight + 2 * controls.padding;
    }
    case "checkbox":
      return ctx.settings.choice.widgetSize;
    case "signature":
      return 40;
    default:
      return controls.minHeight;
  }
}

async function layoutWidget(block: PdfWidgetBlock, flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  const { field } = block;
  const position = block.labelPosition ?? "above";
  const choice = ctx.settings.choice;
  const fields = ctx.settings.fields;
  const hintFirst = block.hint !== undefined && fields.hintPosition === "afterLabel";
  if (field.kind === "checkbox") {
    const label = block.label ?? "";
    await placeChoiceItem(
      { caption: label, widget: (rect) => ({ kind: "widget", rect, field, blockId: block.id }) },
      choice.widgetSize,
      optionStyle(ctx),
      undefined,
      flow,
      region,
      ctx,
      block.id
    );
    if (block.hint !== undefined) {
      flow.advance(fields.labelToHint);
      await placeHint(block.hint, flow, region, ctx, block.id, choice.widgetSize + choice.labelGap);
    }
    return;
  }
  if (field.kind === "radio") {
    if (block.label) {
      const legend = legendStyle(ctx);
      await placeText(labelRuns(block.label, block.labelSuffix, legend, ctx), legend, flow, region, ctx, { blockId: block.id });
      if (hintFirst) {
        flow.advance(fields.labelToHint);
        await placeHint(block.hint!, flow, region, ctx, block.id);
        flow.advance(fields.hintToControl);
      } else {
        flow.advance(choice.legendGap);
      }
    } else if (hintFirst) {
      await placeHint(block.hint!, flow, region, ctx, block.id);
      flow.advance(fields.hintToControl);
    }
    await placeChoiceItems(
      (field.options ?? []).map((option) => ({
        caption: option.label,
        widget: (rect) => ({ kind: "widget", rect, field, option: option.value, blockId: block.id })
      })),
      choice.widgetSize,
      optionStyle(ctx),
      undefined,
      flow,
      region,
      ctx,
      block.id
    );
    if (block.hint !== undefined && !hintFirst) {
      await placeHint(block.hint, flow, region, ctx, block.id);
    }
    return;
  }
  const column = position === "before" && block.label ? inlineLabelWidth(region, ctx) : undefined;
  const widgetRegion: Region = column !== undefined ? { x: region.x + column, width: Math.max(1, region.width - column) } : region;
  // A block may ask for less than the column (a signature box); never more.
  const width = block.width !== undefined && block.width > 0 ? Math.min(block.width, widgetRegion.width) : controlWidth(undefined, widgetRegion, ctx);
  const height = await widgetHeight(field, block, width, ctx);
  const affix = affixStyle(ctx);
  const affixWidth = async (text: string | undefined): Promise<number> => {
    if (text === undefined) {
      return 0;
    }
    const [shaped] = await resolveRuns([{ text }], affix, ctx.fonts);
    return shaped ? shaped.font.font.widthOfTextAtSize(shaped.text, shaped.size) + choice.labelGap : 0;
  };
  const prefixWidth = await affixWidth(block.prefix);
  const suffixWidth = await affixWidth(block.suffix);
  const boxWidth = Math.max(1, width - prefixWidth - suffixWidth);
  const placeAffixes = (top: number, x: number): void => {
    const affixHeight = affix.size * affix.lineHeight;
    const baseline = top + (height - affixHeight) / 2 + affix.size * 0.8;
    const draw = async (text: string | undefined, at: number): Promise<void> => {
      if (text === undefined) {
        return;
      }
      const [shaped] = await resolveRuns([{ text }], affix, ctx.fonts);
      if (shaped) {
        flow.add({ kind: "text", x: at, baselineY: baseline, piece: { text: shaped.text, font: shaped.font, size: shaped.size, color: shaped.color, x: 0, width: shaped.font.font.widthOfTextAtSize(shaped.text, shaped.size) }, blockId: block.id });
      }
    };
    void draw(block.prefix, x);
    void draw(block.suffix, x + prefixWidth + boxWidth + choice.labelGap);
  };
  if (column !== undefined && block.label) {
    // The label in its column beside the widget, the row the taller of the two.
    const label = labelStyle(ctx);
    const setup = flow.currentSetup();
    const left = new Flow(setup, false);
    await placeText(labelRuns(block.label, block.labelSuffix, label, ctx), label, left, { x: 0, width: Math.max(1, column - fields.labelToControl) }, ctx, { blockId: block.id });
    const rowHeight = Math.max(left.scratchHeight(), height);
    flow.ensure(rowHeight);
    const top = flow.y;
    for (const drawable of translate(left.page.drawables, region.x, top - left.contentTop())) {
      flow.add(drawable);
    }
    const x = ctx.textDirection === "rtl" ? widgetRegion.x + widgetRegion.width - width : widgetRegion.x;
    placeAffixes(top, x);
    flow.add({ kind: "widget", rect: { x: x + prefixWidth, y: top, width: boxWidth, height }, field, blockId: block.id });
    flow.advance(rowHeight);
    if (block.hint !== undefined) {
      flow.advance(fields.labelToHint);
      await placeHint(block.hint, flow, widgetRegion, ctx, block.id);
    }
    return;
  }
  if (block.label && position === "above") {
    const label = labelStyle(ctx);
    flow.ensure(label.size * 1.3 + height);
    await placeText(labelRuns(block.label, block.labelSuffix, label, ctx), label, flow, region, ctx, { blockId: block.id });
    if (hintFirst) {
      flow.advance(fields.labelToHint);
      await placeHint(block.hint!, flow, region, ctx, block.id);
      flow.advance(fields.hintToControl);
    } else {
      flow.advance(fields.labelToControl);
    }
  } else if (hintFirst) {
    await placeHint(block.hint!, flow, region, ctx, block.id);
    flow.advance(fields.hintToControl);
  }
  flow.ensure(height);
  const x = ctx.textDirection === "rtl" ? region.x + region.width - width : region.x;
  placeAffixes(flow.y, x);
  flow.add({ kind: "widget", rect: { x: x + prefixWidth, y: flow.y, width: boxWidth, height }, field, blockId: block.id });
  flow.advance(height);
  if (block.hint !== undefined && !hintFirst) {
    flow.advance(fields.labelToHint);
    await placeHint(block.hint, flow, region, ctx, block.id);
  }
}

function resolveColumnWidths(block: PdfTableBlock, available: number): number[] {
  const columns = block.columns.length > 0 ? block.columns : [{}];
  const fixed = columns.map((column) => (typeof column.width === "number" ? column.width : column.width && typeof column.width === "object" ? column.width.fraction * available : undefined));
  const used = fixed.reduce<number>((sum, width) => sum + (width ?? 0), 0);
  const flexible = fixed.filter((width) => width === undefined).length;
  const share = flexible > 0 ? Math.max(0, available - used) / flexible : 0;
  const widths = fixed.map((width) => width ?? share);
  const total = widths.reduce((sum, width) => sum + width, 0);
  // Never wider than the region: scale down when the author over-allocated.
  return total > available && total > 0 ? widths.map((width) => (width * available) / total) : widths;
}

interface LaidRow {
  height: number;
  cells: Array<{ x: number; width: number; drawables: Drawable[]; header: boolean }>;
}

async function layoutTable(block: PdfTableBlock, flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  const table = ctx.settings.table;
  const widths = resolveColumnWidths(block, region.width);
  const rtl = ctx.textDirection === "rtl";
  const columnX: number[] = [];
  let acc = region.x;
  for (const width of rtl ? [...widths].reverse() : widths) {
    columnX.push(acc);
    acc += width;
  }
  if (rtl) {
    columnX.reverse();
  }

  const layoutRow = async (row: PdfTableBlock["rows"][number], header: boolean): Promise<LaidRow> => {
    const cells: LaidRow["cells"] = [];
    let column = 0;
    let height = 0;
    for (const cell of row.cells) {
      const span = Math.max(1, cell.colSpan ?? 1);
      const width = widths.slice(column, column + span).reduce((sum, w) => sum + w, 0);
      const x = rtl ? (columnX[column + span - 1] ?? region.x) : (columnX[column] ?? region.x);
      const isHeader = header || cell.header === true;
      // A header cell's plain runs take the theme's header weight; a run that says its own weight keeps it.
      const blocks = isHeader
        ? cell.blocks.map((inner) =>
            inner.kind === "paragraph"
              ? { ...inner, runs: inner.runs.map((run) => (run.bold === undefined && run.weight === undefined ? { ...run, weight: table.headerWeight } : run)) }
              : inner
          )
        : cell.blocks;
      const measured = await measureBlocks(blocks, Math.max(1, width - 2 * table.cellPadding), flow.currentSetup(), ctx);
      const cellHeight = measured.height + 2 * table.cellPadding;
      height = Math.max(height, cellHeight);
      cells.push({ x, width, drawables: measured.drawables, header: isHeader });
      column += span;
    }
    return { height: Math.max(height, table.rowMinHeight), cells };
  };

  const placeRow = (laid: LaidRow, header: boolean, stripe: boolean): void => {
    const top = flow.y;
    for (const cell of laid.cells) {
      if (header || cell.header) {
        flow.add({ kind: "rect", rect: { x: cell.x, y: top, width: cell.width, height: laid.height }, fill: table.headerFill ?? ctx.colors.surface, blockId: block.id });
      } else if (stripe && table.stripeFill !== undefined) {
        flow.add({ kind: "rect", rect: { x: cell.x, y: top, width: cell.width, height: laid.height }, fill: table.stripeFill, blockId: block.id });
      }
      if (block.borders === "all") {
        flow.add({ kind: "rect", rect: { x: cell.x, y: top, width: cell.width, height: laid.height }, stroke: { width: table.borderWidth, color: ctx.colors.border }, blockId: block.id });
      }
      for (const drawable of translate(cell.drawables, cell.x + table.cellPadding, top + table.cellPadding)) {
        flow.add({ ...drawable, blockId: drawable.blockId ?? block.id });
      }
    }
    if (block.borders === "horizontal") {
      const y = top + laid.height;
      flow.add({ kind: "line", x1: region.x, y1: y, x2: region.x + region.width, y2: y, thickness: table.borderWidth, color: ctx.colors.border, blockId: block.id });
    }
    flow.advance(laid.height);
  };

  const header = block.header ? await layoutRow(block.header, true) : undefined;
  const rows: LaidRow[] = [];
  for (const row of block.rows) {
    rows.push(await layoutRow(row, false));
  }
  if (header) {
    flow.ensure(header.height + (rows[0]?.height ?? 0));
    placeRow(header, true, false);
  }
  rows.forEach((laid, index) => {
    if (flow.remaining() < laid.height && !flow.atPageTop()) {
      flow.newPage();
      if (header && block.repeatHeader) {
        placeRow(header, true, false);
      }
    }
    if (laid.height > flow.contentHeight() && Flow.warnRowOnce()) {
      ctx.warnings.push({ code: "table.rowOverflow", message: "A table row is taller than a page and overflows it.", blockId: block.id });
    }
    placeRow(laid, false, index % 2 === 1);
  });
  if (block.borders === "horizontal" && header && rows.length === 0) {
    // A header alone still closes with a line.
  }
}

async function layoutBox(block: PdfBoxBlock, flow: Flow, region: Region, ctx: LayoutContext): Promise<void> {
  const padding = block.padding ?? ctx.settings.box.padding;
  const inner = Math.max(1, region.width - 2 * padding);
  const setup = flow.currentSetup();
  const measured = await measureBlocks(block.blocks, inner, setup, ctx);
  // A panel's title band: its blocks on their own fill, above the body, inside the border.
  const headerPad = block.header?.padding ?? 0;
  const header = block.header ? await measureBlocks(block.header.blocks, Math.max(1, region.width - 2 * headerPad), setup, ctx) : undefined;
  const headerHeight = header ? header.height + 2 * headerPad : 0;
  const height = headerHeight + measured.height + 2 * padding;
  if (height > flow.contentHeight()) {
    ctx.warnings.push({ code: "box.overflow", message: "A box is taller than a page; its content flows without the border.", blockId: block.id });
    if (block.header) {
      await layoutBlocks(block.header.blocks, flow, { x: region.x + headerPad, width: Math.max(1, region.width - 2 * headerPad) }, ctx);
    }
    await layoutBlocks(block.blocks, flow, { x: region.x + padding, width: inner }, ctx);
    return;
  }
  flow.ensure(height);
  const top = flow.y;
  if (block.fill || block.border) {
    flow.add({
      kind: "rect",
      rect: { x: region.x, y: top, width: region.width, height },
      ...(block.fill ? { fill: block.fill } : {}),
      ...(block.border ? { stroke: { width: block.border.width, color: block.border.color } } : {}),
      ...(block.radius ? { radius: block.radius } : {}),
      blockId: block.id
    });
  }
  if (header && block.header) {
    flow.add({
      kind: "rect",
      rect: { x: region.x, y: top, width: region.width, height: headerHeight },
      fill: block.header.fill ?? ctx.colors.surface,
      ...(block.radius ? { radius: block.radius } : {}),
      artifact: true,
      blockId: block.id
    });
    for (const drawable of translate(header.drawables, region.x + headerPad, top + headerPad)) {
      flow.add(drawable);
    }
  }
  for (const drawable of translate(measured.drawables, region.x + padding, top + headerHeight + padding)) {
    flow.add(drawable);
  }
  flow.advance(height);
}

function anchorPages(page: PdfAnchoredBox["anchor"]["page"], count: number): number[] {
  if (page === "every") {
    return Array.from({ length: count }, (_, index) => index);
  }
  if (page === "first") {
    return count > 0 ? [0] : [];
  }
  if (page === "last") {
    return count > 0 ? [count - 1] : [];
  }
  return page >= 1 && page <= count ? [page - 1] : [];
}

async function placeAnchored(entry: PdfAnchoredBox, pages: LaidOutPage[], ctx: LayoutContext): Promise<void> {
  const { anchor, box } = entry;
  const padding = box.padding ?? ctx.settings.box.padding;
  const inner = Math.max(1, anchor.width - 2 * padding);
  let warned = false;
  for (const index of anchorPages(anchor.page, pages.length)) {
    const page = pages[index]!;
    const measured = await measureBlocks(box.blocks, inner, page.setup, ctx);
    if (measured.extent + 2 * padding > anchor.height && !warned) {
      warned = true;
      ctx.warnings.push({ code: "anchored.overflow", message: `Anchored box "${entry.id}" holds more than its height.`, blockId: box.id });
    }
    if (box.fill || box.border) {
      page.drawables.push({
        kind: "rect",
        rect: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
        ...(box.fill ? { fill: box.fill } : {}),
        ...(box.border ? { stroke: { width: box.border.width, color: box.border.color } } : {}),
        ...(box.radius ? { radius: box.radius } : {}),
        blockId: box.id
      });
    }
    page.drawables.push(...translate(measured.drawables, anchor.x + padding, anchor.y + padding));
  }
}

async function placeRunning(
  blocks: readonly PdfBlock[],
  page: LaidOutPage,
  band: "header" | "footer",
  tokens: { pageNumber: number; pageCount: number },
  ctx: LayoutContext,
  warned: { header: boolean; footer: boolean }
): Promise<void> {
  const height = page.setup[band]?.height;
  if (!height || blocks.length === 0) {
    return;
  }
  const scratch = new Flow(page.setup, false);
  const region = { x: 0, width: scratch.contentWidth() };
  // Running regions lay out with the page's numbers substituted, so every page measures its own.
  const withTokens = blocks.map((block) => substituteTokens(block, tokens));
  await layoutBlocks(withTokens, scratch, region, ctx);
  const used = scratch.contentExtent();
  if (used > height && !warned[band]) {
    warned[band] = true;
    ctx.warnings.push({ code: `${band}.overflow`, message: `The ${band} needs ${Math.ceil(used)}pt but its band is ${height}pt.` });
  }
  const top = band === "header" ? page.setup.margins.top : page.height - page.setup.margins.bottom - height;
  // A running region is pagination furniture: readers skip it, so its content is an artifact.
  page.drawables.push(
    ...translate(scratch.page.drawables, page.setup.margins.left, top - scratch.contentTop()).map((drawable) => ({ ...drawable, artifact: true }))
  );
}

function substituteTokens(block: PdfBlock, tokens: { pageNumber: number; pageCount: number }): PdfBlock {
  const swap = (runs: readonly PdfTextRun[]): PdfTextRun[] =>
    runs.map((run) => {
      if (!run.token) {
        return run;
      }
      const { token, ...rest } = run;
      return { ...rest, text: String(token === "pageNumber" ? tokens.pageNumber : tokens.pageCount) };
    });
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return { ...block, runs: swap(block.runs) };
    case "labelValue":
      return { ...block, value: swap(block.value) };
    case "group":
      return { ...block, blocks: block.blocks.map((child) => substituteTokens(child, tokens)) };
    case "box":
      return {
        ...block,
        blocks: block.blocks.map((child) => substituteTokens(child, tokens)),
        ...(block.header ? { header: { ...block.header, blocks: block.header.blocks.map((child) => substituteTokens(child, tokens)) } } : {})
      };
    case "list":
      return { ...block, items: block.items.map((item) => ({ ...item, runs: swap(item.runs) })) };
    case "table": {
      const swapRow = (row: PdfTableBlock["rows"][number]) => ({
        ...row,
        cells: row.cells.map((cell) => ({ ...cell, blocks: cell.blocks.map((child) => substituteTokens(child, tokens)) }))
      });
      return { ...block, ...(block.header ? { header: swapRow(block.header) } : {}), rows: block.rows.map(swapRow) };
    }
    default:
      return block;
  }
}

export interface LayoutResult {
  pages: LaidOutPage[];
  report: PdfPageReport[];
}

export async function layoutDocument(document: PdfDocument, ctx: LayoutContext): Promise<LayoutResult> {
  const flow = new Flow(document.page, true, resolvePdfRenderLimits(document.limits).pages);
  for (let index = 0; index < document.blocks.length; index += 1) {
    const region = { x: flow.contentX(), width: flow.contentWidth() };
    await layoutBlock(document.blocks[index]!, document.blocks[index + 1], flow, region, ctx);
  }
  const pages = flow.pages;
  for (const entry of document.anchored) {
    await placeAnchored(entry, pages, ctx);
  }
  const warned = { header: false, footer: false };
  for (let index = 0; index < pages.length; index += 1) {
    const tokens = { pageNumber: index + 1, pageCount: pages.length };
    await placeRunning(document.header ?? [], pages[index]!, "header", tokens, ctx, warned);
    await placeRunning(document.footer ?? [], pages[index]!, "footer", tokens, ctx, warned);
  }
  const report: PdfPageReport[] = pages.map((page, index) => {
    const seen = new Set<string>();
    const blockIds: string[] = [];
    for (const drawable of page.drawables) {
      if (drawable.blockId && !seen.has(drawable.blockId)) {
        seen.add(drawable.blockId);
        blockIds.push(drawable.blockId);
      }
    }
    return { index, width: page.width, height: page.height, blockIds };
  });
  return { pages, report };
}
