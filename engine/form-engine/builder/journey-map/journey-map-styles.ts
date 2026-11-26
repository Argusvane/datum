/**
 * The journey flow map's styles, for the map's surface: in the canvas, and in any
 * other root a second map is put in (a shadow tree, or the page itself), which adopts them with
 * the map (`journeyMapStylesInto`). Every rule is the map's own: a class of the map's (`jm-`) or
 * under its root class, so nothing here reaches the page around it. Every colour
 * is a builder token (`--db-*`), aliased once on the map's root, so every builder theme — a
 * host-registered dark one included — restyles the map with no token of its own. SVG presentation attributes
 * cannot read `var()`, so the markup carries classes and nothing else.
 *
 * Contrast rules the map keeps, on an HDR display too:
 * - The picture's text is never faded (a disabled tool in the bar fades as every bar's does). A way no path takes is a dotted muted line and a page no path reaches
 *   a dotted muted outline, both at full strength; the hover highlight dims lines only.
 * - Lines and arrowheads are ink, accent or muted on the backdrop: 3:1 or more.
 * - Text sits on the panel fill (cards, chips) or the accent wash (Start, End): 4.5:1 or more.
 *   Selection is an outline, never a fill, so danger and warning text keep their contrast.
 * - A card stands on the backdrop by its outline: in a flat theme the panel can be only about
 *   1.1:1 from the backdrop, and the panel border is what separates them.
 *
 * The picture's text is drawn at fixed pixel sizes, the ones its layout measures text at
 * (`JOURNEY_MAP_METRICS`): a theme that moved them would clip the chips and cards. Everything
 * around the picture (the bar, the status, the words) reads the type scale's tokens.
 * No backticks in the comments below: this is a template literal.
 */

/** The class on the map's root element, and the bundle checks' sentinel for the map's chunk. */
export const JOURNEY_MAP_ROOT_CLASS = "datum-journey-map";

export const JOURNEY_MAP_STYLES = `
  .datum-journey-map {
    --jm-bg: var(--db-backdrop);
    --jm-panel: var(--db-surface);
    --jm-ink: var(--db-ink);
    --jm-muted: var(--db-ink-muted);
    --jm-accent: var(--db-accent);
    --jm-accent-soft: var(--db-accent-soft);
    --jm-danger: var(--db-danger);
    --jm-danger-bg: var(--db-danger-soft);
    --jm-warn: var(--db-warn);
    --jm-border: var(--db-line-card);
    --jm-chip-border: var(--db-line-input);
    --jm-line: 1.5px;
    color: var(--jm-ink);
    font-family: var(--db-font);
  }
  .jm-svg { display: block; margin: 0 auto; overflow: visible; font-family: inherit; }
  .jm-svg text { fill: var(--jm-ink); font-family: inherit; }
  .datum-journey-map [data-select] { cursor: pointer; }
  .datum-journey-map[data-read-only] [data-select] { cursor: default; }

  /*
    Lines: the way on in ink, a condition in accent, a way no path takes dotted.
  */
  .jm-edge__line { fill: none; stroke: var(--jm-ink); stroke-width: var(--jm-line); vector-effect: non-scaling-stroke; }
  .jm-edge__head { fill: var(--jm-ink); stroke: none; }
  .jm-edge.is-conditional .jm-edge__line { stroke: var(--jm-accent); }
  .jm-edge.is-conditional .jm-edge__head { fill: var(--jm-accent); }
  .jm-edge.is-dead .jm-edge__line { stroke: var(--jm-muted); stroke-dasharray: 1.5 3.5; stroke-linecap: round; }
  .jm-edge.is-dead .jm-edge__head { fill: var(--jm-muted); }
  .jm-edge__hit { fill: none; stroke: transparent; stroke-width: 12px; pointer-events: stroke; }

  /* Chips on the lines. */
  .jm-label__box { fill: var(--jm-panel); stroke: var(--jm-chip-border); stroke-width: 1px; }
  .jm-label__hit { fill: transparent; stroke: none; }
  .jm-label__text { font-size: 11px; }
  .jm-label.is-conditional .jm-label__text { fill: var(--jm-accent); }
  .jm-label.is-dead .jm-label__box { stroke: var(--jm-muted); stroke-dasharray: 1.5 2.5; }
  .jm-label.is-dead .jm-label__text { fill: var(--jm-muted); }

  /* Page cards. */
  .jm-node__box { fill: var(--jm-panel); stroke: var(--jm-border); stroke-width: var(--db-border-w); }
  .jm-page--exit .jm-node__box { stroke-dasharray: 6 3; }
  .jm-page.is-unreachable .jm-node__box { stroke: var(--jm-muted); stroke-dasharray: 2 3; }
  .jm-node__disc { fill: var(--jm-accent-soft); stroke: var(--jm-accent); stroke-width: 1px; }
  .jm-node__number { font-size: 11px; font-weight: 600; text-anchor: middle; }
  .jm-node__title { font-size: 13px; font-weight: 600; }
  .jm-node__meta, .jm-node__note, .jm-more__text { font-size: 11px; }
  .jm-svg .jm-node__meta, .jm-svg .jm-more__text { fill: var(--jm-muted); }
  .jm-node__divider { stroke: var(--jm-border); stroke-width: 1px; }
  .jm-stub__text { font-size: 11px; }
  .jm-svg .jm-stub--error .jm-stub__text { fill: var(--jm-danger); }
  .jm-svg .jm-stub--warning .jm-stub__text { fill: var(--jm-warn); }
  .jm-svg .jm-stub--note .jm-stub__text { fill: var(--jm-muted); }
  .jm-stub__hit { fill: transparent; stroke: none; }
  .jm-badge { font-size: 11px; font-weight: 600; text-anchor: end; }
  .jm-svg .jm-badge--error { fill: var(--jm-danger); }
  .jm-svg .jm-badge--warning { fill: var(--jm-warn); }

  /* Start and End; End in danger when no path submits. */
  .jm-terminal__box { fill: var(--jm-accent-soft); stroke: var(--jm-accent); stroke-width: var(--db-border-w); }
  .jm-terminal__text { font-size: 12px; font-weight: 600; text-anchor: middle; }
  .jm-terminal.is-failing .jm-terminal__box { fill: var(--jm-danger-bg); stroke: var(--jm-danger); stroke-dasharray: 4 3; }
  .jm-svg .jm-terminal.is-failing .jm-terminal__text { fill: var(--jm-danger); }

  /* Focus, hover and selection: outlines only. */
  .jm-ring { fill: none; stroke: var(--jm-accent); stroke-width: 2px; visibility: hidden; }
  .jm-item:focus { outline: none; }
  .jm-item:focus-visible .jm-ring { visibility: visible; }
  .jm-item:hover .jm-node__box, .jm-item:hover .jm-label__box, .jm-item:hover .jm-terminal__box { stroke: var(--jm-accent); stroke-dasharray: 4 2; }
  .jm-item.is-selected .jm-node__box, .jm-item.is-selected .jm-label__box, .jm-item.is-selected .jm-terminal__box {
    stroke: var(--jm-accent); stroke-width: 2.5px; stroke-dasharray: none;
  }
  .jm-page.is-within .jm-node__box { stroke: var(--jm-accent); }
  .jm-item.is-selected .jm-stub__hit { stroke: var(--jm-accent); stroke-width: 1.5px; }

  /*
    The way taken (setState, as Try it gives it): the current step on the accent wash in a
    thick accent outline, the steps already shown outlined in accent, and the ways taken drawn
    in accent, a little heavier. The ways not taken go muted
    at full strength (never faded). Outlines and the wash only: the text keeps its contrast.
  */
  .jm-page.is-current .jm-node__box { fill: var(--jm-accent-soft); stroke: var(--jm-accent); stroke-width: 3px; stroke-dasharray: none; }
  .jm-page.is-taken .jm-node__box { stroke: var(--jm-accent); stroke-width: 2px; stroke-dasharray: none; }
  .jm-terminal.is-taken .jm-terminal__box { stroke-width: 2.5px; }
  .datum-journey-map.has-path .jm-edge:not(.is-taken) .jm-edge__line { stroke: var(--jm-muted); }
  .datum-journey-map.has-path .jm-edge:not(.is-taken) .jm-edge__head { fill: var(--jm-muted); }
  .datum-journey-map .jm-edge.is-taken .jm-edge__line { stroke: var(--jm-accent); stroke-width: 2.5px; }
  .datum-journey-map .jm-edge.is-taken .jm-edge__head { fill: var(--jm-accent); }
  .jm-label.is-taken .jm-label__box { stroke: var(--jm-accent); stroke-width: 1.5px; }
  .jm-svg .jm-label.is-taken .jm-label__text { fill: var(--jm-accent); font-weight: 600; }

  /* The highlight dims the lines it does not light, never text. */
  .datum-journey-map.is-lighting .jm-svg .jm-edge:not(.is-lit) .jm-edge__line,
  .datum-journey-map.is-lighting .jm-svg .jm-edge:not(.is-lit) .jm-edge__head { opacity: .35; }
  .jm-edge__line, .jm-edge__head { transition: opacity var(--db-motion-fast) var(--db-ease); }

  /*
    A map the tree cannot be written as is the last one that could: every line muted at full
    strength (3:1 still, never faded) and the picture outlined dashed, beside the problem line.
  */
  .jm-svg.is-stale { outline: 1px dashed var(--jm-muted); outline-offset: 4px; }
  .jm-svg.is-stale .jm-edge__line { stroke: var(--jm-muted); }
  .jm-svg.is-stale .jm-edge__head { fill: var(--jm-muted); }

  /*
    An item scrolled into view (a selection, a focused item) lands below the sticky head (the
    surface measures it) and in line with it, clear of the side drawer.
  */
  .jm-item, .jm-page { scroll-margin-top: var(--jm-head-room, 80px); scroll-margin-left: calc(var(--jm-cover, 0px) + 16px); }

  /*
    The surface around the picture. The canvas page scrolls it both ways, so the surface is as
    wide as the picture and the head sticks to the page's top and left edges while the picture
    moves under it: at most as wide as the page shows (the surface sets --jm-view-w as it
    measures), on the panel fill so nothing shows through.
    The builder's side drawer lies over the page's start edge, so the head and the
    foot stick clear of it: --jm-cover is how far it reaches (the shell's --db-side-w, which
    is nothing while the drawer is folded), less what would leave them under 160px wide. The
    picture starts clear of it too, so its start (Left to right) is never out of reach.
    Only the canvas's map lies under the drawer: a map scrolled anywhere else (Try it's card)
    pins --jm-cover to 0px on its own element, as the surface measures its scroller.
  */
  .datum-journey-map {
    width: max-content; min-width: 100%; box-sizing: border-box;
    --jm-cover: min(var(--db-side-w, 0px), max(0px, calc(var(--jm-view-w, 100%) - 160px)));
    --jm-props: min(var(--db-props-w, 0px), max(0px, calc(var(--jm-view-w, 100%) - 160px)));
  }
  /*
    A map that builds the journey is at least as tall as the room it has (--jm-view-h, which the
    surface measures), so the selected step's bar sticks to the foot of that room whatever the
    picture's height, as the canvas's own selection bar does.
  */
  .datum-journey-map[data-editable] { display: flex; flex-direction: column; min-height: var(--jm-view-h, 0px); }
  /*
    The head is the canvas bar's pill, right-aligned: a strip as wide as the room between the side
    drawer and the inspector (the zone the canvas bar keeps to), on the page's top edge. The strip
    takes no pointer of its own, so the picture under its empty part stays reachable. The
    counts and the problem sit under the pill as quiet lines, on the backdrop so the picture
    scrolling beneath never shows through them. Tools are borderless 32px rounds with the hover
    fill, the direction is the shared segmented control, and the one action that adds is the
    accent pill at the end. A tool that is off fades to .4 like every other bar.
  */
  .jm-head {
    position: sticky; top: 0; left: var(--jm-cover, 0px); z-index: 2;
    box-sizing: border-box; width: calc(var(--jm-view-w, 100%) - var(--jm-cover, 0px) - var(--jm-props, 0px)); max-width: calc(var(--jm-view-w, 100%) - var(--jm-cover, 0px));
    display: flex; flex-direction: column; align-items: flex-end; gap: var(--db-space-1);
    margin: 0 0 var(--db-space-3); padding: var(--db-gap, 12px) var(--db-gap, 12px) 0; pointer-events: none;
  }
  .jm-bar {
    pointer-events: auto; display: flex; flex-wrap: wrap; align-items: center; gap: var(--db-space-1); max-width: 100%;
    padding: var(--db-space-1); border: var(--db-border-w) solid var(--jm-border); border-radius: var(--db-radius-pill);
    background: var(--jm-panel); box-shadow: var(--db-shadow-pill); font-size: var(--db-text-sm);
  }
  .jm-bar[hidden] { display: none; }
  /* A divider is the border on the group it opens. */
  .jm-zoom, .jm-edit {
    display: inline-flex; align-items: center; gap: 2px; padding-inline-start: var(--db-space-1); margin-inline-start: var(--db-space-1);
    border-inline-start: var(--db-border-w) solid var(--db-line-divider);
  }
  .jm-btn {
    display: inline-flex; align-items: center; justify-content: center; flex: none; min-inline-size: 32px; min-block-size: 32px; padding: 0 var(--db-space-2);
    border: 0; border-radius: var(--db-radius-pill); background: transparent; color: var(--jm-muted);
    font: inherit; font-weight: 500; font-variant-numeric: tabular-nums; cursor: pointer;
    transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .jm-btn:hover { background: var(--db-surface-hover); color: var(--jm-ink); }
  .jm-btn:focus-visible { outline: 2px solid var(--db-focus); outline-offset: 2px; }
  .jm-btn[aria-disabled="true"] { opacity: .4; cursor: default; }
  .jm-btn[aria-disabled="true"]:hover { background: transparent; color: var(--jm-muted); }
  .jm-btn--primary { padding: 0 var(--db-space-3); background: var(--db-accent); color: var(--db-accent-ink); font-weight: 600; }
  .jm-btn--primary:hover { background: var(--db-accent-hover); color: var(--db-accent-ink); }
  .jm-btn[hidden] { display: none; }

  /*
    The bar on the selected step: the canvas selection bar's look (the selected colour, pill
    buttons, tooltips) from the same tokens, in its own classes, so the canvas's keys and actions
    (its data-selection-* hooks) never see it. It sticks to the foot of the room the map has,
    between the side drawer and the inspector (--jm-cover, --jm-props).
  */
  .jm-selzone {
    position: sticky; bottom: var(--db-gap, 12px); left: var(--jm-cover, 0px); z-index: 2; margin-top: auto;
    box-sizing: border-box; width: calc(var(--jm-view-w, 100%) - var(--jm-cover, 0px) - var(--jm-props, 0px)); max-width: calc(var(--jm-view-w, 100%) - var(--jm-cover, 0px));
    display: flex; justify-content: center; padding-top: var(--db-space-3); pointer-events: none;
  }
  .jm-selzone[hidden] { display: none; }
  .jm-selbar {
    pointer-events: auto; display: flex; align-items: center; gap: var(--db-space-1); max-width: 100%;
    padding: var(--db-space-1); border-radius: var(--db-radius-pill); font-family: var(--db-font); font-size: var(--db-text-sm);
    background: var(--db-selected); color: var(--db-selected-ink); box-shadow: var(--db-shadow-overlay);
  }
  .jm-selname { flex: 0 1 auto; padding: 0 var(--db-space-3); font-weight: 600; min-width: 0; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jm-selopen {
    min-block-size: 32px; padding: 0 var(--db-space-3); border: 0; border-radius: var(--db-radius-pill);
    background: var(--db-selected-ink); color: var(--db-selected); font: inherit; font-weight: 600; cursor: pointer;
  }
  .jm-selbtn {
    display: inline-flex; align-items: center; justify-content: center; flex: none; inline-size: 32px; block-size: 32px; padding: 0;
    border: 0; border-radius: var(--db-radius-pill); background: transparent; color: inherit; cursor: pointer;
    transition: background-color var(--db-motion-fast) var(--db-ease);
  }
  .jm-selbtn svg { inline-size: var(--db-icon-size); block-size: var(--db-icon-size); fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .jm-selbtn--delete { margin-inline-start: var(--db-space-1); }
  .jm-selbtn:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected-ink) 16%, transparent); }
  .jm-selopen:hover:not(:disabled) { background: color-mix(in oklab, var(--db-selected-ink) 85%, var(--db-selected)); }
  .jm-selbtn:disabled { color: color-mix(in oklab, var(--db-selected-ink) 45%, var(--db-selected)); cursor: default; }
  .jm-selopen:disabled { background: color-mix(in oklab, var(--db-selected-ink) 45%, var(--db-selected)); cursor: default; }
  .jm-selbtn:focus-visible, .jm-selopen:focus-visible { outline: 2px solid var(--db-focus-on-dark); outline-offset: -2px; }
  @media (pointer: coarse) {
    .jm-selbtn { inline-size: 44px; block-size: 44px; }
    .jm-selopen { min-block-size: 44px; }
    .jm-btn { min-block-size: 44px; min-inline-size: 44px; }
  }

  .jm-status, .jm-problem { max-width: 100%; margin: 0; padding: 0 var(--db-space-2); border-radius: var(--db-radius-sm); background: var(--jm-bg); font-size: var(--db-text-sm); text-align: end; }
  .jm-status { color: var(--jm-muted); }
  .jm-problem { color: var(--jm-danger); }
  .jm-problem[hidden] { display: none; }
  .jm-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .jm-stage { padding: 2px 0 12px var(--jm-cover, 0px); }
  .jm-stage:focus-within { outline: none; }

  /*
    Forced colours. Inside SVG the browser forces no fill or stroke, so this block is all there
    is; and the state rules (a condition, a dead way, findings, failing End, hover) outrank any
    rule here. So the aliases every rule reads are what change: every colour the map draws is a
    system colour, and dashes and dots still tell the kinds of line apart.
  */
  @media (forced-colors: active) {
    .datum-journey-map {
      --jm-bg: Canvas; --jm-panel: Canvas; --jm-accent-soft: Canvas; --jm-danger-bg: Canvas;
      --jm-ink: CanvasText; --jm-danger: CanvasText; --jm-warn: CanvasText; --jm-border: CanvasText; --jm-chip-border: CanvasText;
      --jm-muted: GrayText; --jm-accent: Highlight;
    }
    .jm-btn[aria-disabled="true"] { color: GrayText; opacity: 1; }
    .jm-btn--primary { border: 1px solid CanvasText; }
    .jm-selbar { border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
    .jm-selopen { border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
    .jm-selbtn:disabled, .jm-selopen:disabled { color: GrayText; }
    .jm-edge__line, .jm-node__box, .jm-label__box, .jm-terminal__box, .jm-node__disc, .jm-node__divider { stroke: CanvasText; }
    .jm-edge__head { fill: CanvasText; }
    .jm-node__box, .jm-label__box, .jm-terminal__box, .jm-node__disc { fill: Canvas; }
    .jm-svg text, .jm-svg .jm-node__meta, .jm-svg .jm-more__text, .jm-svg .jm-stub--error .jm-stub__text, .jm-svg .jm-stub--warning .jm-stub__text, .jm-svg .jm-stub--note .jm-stub__text { fill: CanvasText; }
    .jm-ring, .jm-item.is-selected .jm-node__box, .jm-item.is-selected .jm-label__box, .jm-item.is-selected .jm-terminal__box { stroke: Highlight; }
  }
`;

/** The attribute that marks the map's stylesheet in a root, so it is put there once. */
const STYLES_MARK = "data-journey-map-styles";

/**
 * Puts the map's stylesheet into `root` once, for a map drawn there: a shadow root (a panel's
 * tree, as the canvas's own surface styles are), or a document, in its head, for a map in the
 * page itself. A root that has it already gets nothing more; the sheet it has is returned.
 */
export function journeyMapStylesInto(root: ShadowRoot | Document): HTMLStyleElement {
  const found = root.querySelector<HTMLStyleElement>(`style[${STYLES_MARK}]`);
  if (found) {
    return found;
  }
  const doc = (root as ShadowRoot).ownerDocument ?? (root as Document);
  const style = doc.createElement("style");
  style.setAttribute(STYLES_MARK, "");
  style.textContent = JOURNEY_MAP_STYLES;
  const host = (root as Document).head ?? root;
  host.append(style);
  return style;
}
