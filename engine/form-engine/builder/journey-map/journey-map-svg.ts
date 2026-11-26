/**
 * The journey flow map as SVG markup: a pure function of the map's model and its
 * layout, written into the map's surface as one string — the `template-pages.ts` way.
 *
 * - **Colours only through classes** (`JOURNEY_MAP_STYLES`, on the builder's `--db-*` tokens):
 *   `var()` does not work in SVG presentation attributes, so no fill or stroke is written here.
 *   Arrowheads are paths of their own: no `<marker>`, no ids, so two maps on a page never
 *   collide.
 * - **No view state in the string**: no selection, no highlight, no roving `tabindex="0"`, no
 *   zoomed size, no current step or way taken — every item is `tabindex="-1"`, and the surface
 *   lays those on after each write from its own state. A redraw is then a pure function of the
 *   journey, and a write that changes nothing is skipped.
 * - **No nested interactive roles**: a step is a plain group holding its card, the chips of its
 *   ways out and its stub rows as sibling buttons, never a button inside a button.
 * - **Items** (`data-map-item`) are the focusable things — Start, pages, route chips, stubs,
 *   End — each `role="button"` (`role="img"` on a map drawn to look at, `graph.readOnly`) with a full `aria-label`, and a `<title>` for the tooltip inside
 *   an `aria-hidden` group of its picture, so the name is not read again as a description; in
 *   the markup in reading order. Anything clickable carries `data-select`, the designer node a
 *   click selects.
 * - **Label in Name** (WCAG 2.5.3): an item's visible words must appear, in order, inside its
 *   accessible name, so speech input can say what it sees. {@link itemName} puts them first
 *   (`1 About you about · 2 questions. Page 1 of 3, …`) unless the sentence already holds them
 *   (`Start`), computed where the picture is written from the same strings it draws, so the two
 *   cannot drift. The text elements of a picture are separated by a space in the markup, as the
 *   words of a line are, so a reader of the DOM sees words, not one run of letters; the group
 *   they are in draws no spaces.
 *   Plain edges and the chips that are not items (a fall-through's "Otherwise") are not
 *   focusable, and those chips are `aria-hidden`: their meaning is in the steps' labels (a
 *   step's name says where each way out goes).
 *
 * Nothing runs at import.
 */
import { escapeHtml } from "../../render/core/escape-html.js";
import type { FlowLayout } from "./journey-map-layout.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./journey-map-texts-en.js";
import {
  JOURNEY_MAP_METRICS,
  type JourneyMapEdge,
  type JourneyMapGraph,
  type JourneyMapLabel,
  type JourneyMapPage,
  type JourneyMapTerminal
} from "./journey-map-model.js";

const esc = escapeHtml;

function num(value: number): string {
  const rounded = Math.round(value * 2) / 2;
  return String(rounded === 0 ? 0 : rounded);
}

/** ` name="value"` for each defined value, escaped. */
function attributes(values: Record<string, string | number | undefined>): string {
  let out = "";
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      out += ` ${name}="${esc(typeof value === "number" ? num(value) : value)}"`;
    }
  }
  return out;
}

function classes(...names: Array<string | false | undefined>): string {
  return names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");
}

/** A text as the words a label is compared by: lower case, parentheticals and punctuation gone, spaces around. */
function wordsOf(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\([^()]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/**
 * An item's accessible name (WCAG 2.5.3, Label in Name): the words it draws, in the order it
 * draws them, then its sentence, unless the sentence already holds those words as they are.
 * `visible` are the texts of its picture in reading order (the numbers, titles, badges), the
 * very strings written into it.
 */
export function itemName(visible: ReadonlyArray<string | undefined>, label: string | undefined): string | undefined {
  const shown = visible
    .map((text) => (text ?? "").trim())
    .filter((text) => text !== "")
    .join(" ");
  if (label === undefined || shown === "" || wordsOf(label).includes(wordsOf(shown))) {
    return label;
  }
  return `${shown}. ${label}`;
}

/**
 * The attributes that make a group a focusable item: a button, or on a map drawn to look at
 * (`graph.readOnly`), an image, which promises no action, with the same name.
 */
function item(key: string | undefined, label: string | undefined, readOnly: boolean | undefined): Record<string, string | undefined> {
  return key === undefined ? {} : { "data-map-item": key, role: readOnly === true ? "img" : "button", tabindex: "-1", "aria-label": label };
}

/**
 * A group's picture and its tooltip, the `<title>`. An item is named by its `aria-label`, and
 * a `<title>` of its own would also become its accessible description (SVG-AAM): a screen
 * reader would say the sentence twice, or the chip's words after the route's. So an item's
 * picture and `<title>` go in a group hidden from assistive technology — the tooltip still
 * shows on hover, and the name is said once. Anything else keeps its `<title>` as its name.
 */
function face(key: string | undefined, picture: string, tooltip: string): string {
  const titled = `${picture}<title>${esc(tooltip)}</title>`;
  return key === undefined ? titled : `<g aria-hidden="true">${titled}</g>`;
}

function edgeSvg(edge: JourneyMapEdge, layout: FlowLayout): string {
  const route = layout.edges[edge.key];
  if (route === undefined) {
    return "";
  }
  const name = classes(
    "jm-edge",
    `jm-edge--${edge.kind}`,
    edge.conditional && "is-conditional",
    edge.otherwise && "is-otherwise",
    edge.spine && "is-spine",
    !edge.live && "is-dead"
  );
  return `<g${attributes({ class: name, "data-edge": edge.key, "data-from": edge.from, "data-to": edge.to, "data-select": edge.select })}><path class="jm-edge__hit" d="${esc(
    route.d
  )}"/><path class="jm-edge__line" d="${esc(route.d)}"/><path class="jm-edge__head" d="${esc(route.head)}"/></g>`;
}

/** A coordinate as {@link num} rounds it, as a number: so a difference of two is exact. */
function half(value: number): number {
  return Math.round(value * 2) / 2;
}

/** A chip, placed in the coordinates of the group it is drawn in (`origin`, a page's corner, or the picture's). */
function labelSvg(edge: JourneyMapEdge, label: JourneyMapLabel, layout: FlowLayout, readOnly: boolean | undefined, origin: { x: number; y: number } = { x: 0, y: 0 }): string {
  const box = layout.edges[edge.key]?.label;
  if (box === undefined) {
    return "";
  }
  const m = JOURNEY_MAP_METRICS.chip;
  const name = classes(
    label.item !== undefined && "jm-item",
    "jm-label",
    `jm-label--${edge.kind}`,
    edge.conditional && "is-conditional",
    edge.otherwise && "is-otherwise",
    label.lines.length === 0 && "is-handle",
    !edge.live && "is-dead"
  );
  // The chip's width comes from an estimate that runs wide, so words set from the left edge leave
  // the box's right side empty and the edge, which meets the box at its middle, seems to pass
  // beside the words: a chip with no badge centres them on that middle. One with a badge keeps
  // them to the left, where the badge's own room was reserved on the right.
  const centred = label.badge === undefined;
  // A space between the lines, and before the badge: the words of a wrapped line stay words.
  const tspans = label.lines
    .map((line, index) => `<tspan${attributes({ x: centred ? box.width / 2 : m.padX, y: m.padY + 10.5 + index * m.line })}>${esc(line)}</tspan>`)
    .join(" ");
  const badge =
    label.badge !== undefined
      ? ` <text${attributes({ class: `jm-badge jm-badge--${label.badgeSeverity ?? "warning"}`, x: box.width - m.padX, y: m.padY + 10.5 })}>${esc(label.badge)}</text>`
      : "";
  // A handle (a lone rule with no words) is small to look at and no smaller to hit: a transparent square of the
  // least target size WCAG 2.5.8 allows is drawn about it, so a pointer finds it (it needs no room of its own: it is only a target).
  const handle = label.lines.length === 0 ? m.hit : 0;
  const hit =
    handle > 0
      ? `<rect${attributes({ class: "jm-label__hit", x: (box.width - handle) / 2, y: (box.height - handle) / 2, width: handle, height: handle })}/>`
      : "";
  const picture = `${hit}<rect${attributes({ class: "jm-ring", x: -3, y: -3, width: box.width + 6, height: box.height + 6, rx: 6 })}/><rect${attributes({
    class: "jm-label__box",
    width: box.width,
    height: box.height,
    rx: 4
  })}/><text${attributes({ class: "jm-label__text", "text-anchor": centred ? "middle" : undefined })}>${tspans}</text>${badge}`;
  return `<g${attributes({
    class: name,
    "data-edge": edge.key,
    "data-select": edge.select,
    ...item(label.item, itemName([...label.lines, label.badge], label.ariaLabel), readOnly),
    transform: `translate(${num(half(box.x) - half(origin.x))} ${num(half(box.y) - half(origin.y))})`
  })}>${face(label.item, picture, label.text)}</g>`;
}

function terminalSvg(node: JourneyMapTerminal, layout: FlowLayout, readOnly: boolean | undefined): string {
  const box = layout.nodes[node.key];
  if (box === undefined) {
    return "";
  }
  const m = JOURNEY_MAP_METRICS.pill;
  const picture = `<rect${attributes({ class: "jm-ring", x: -4, y: -4, width: box.width + 8, height: box.height + 8, rx: box.height / 2 + 4 })}/><rect${attributes({
    class: "jm-terminal__box",
    width: box.width,
    height: box.height,
    rx: box.height / 2
  })}/><text${attributes({ class: "jm-terminal__text", x: box.width / 2, y: box.height / 2 + m.px * 0.36 })}>${esc(node.text)}</text>`;
  return `<g${attributes({
    class: classes("jm-item", "jm-terminal", `jm-terminal--${node.kind}`, node.failing && "is-failing"),
    "data-map-node": node.key,
    "data-select": node.select,
    ...item(node.item, itemName([node.text], node.ariaLabel), readOnly),
    transform: `translate(${num(box.x)} ${num(box.y)})`
  })}>${face(node.item, picture, node.ariaLabel)}</g>`;
}

/** A page: its card, the chips of its ways out (items of their own, in try order), then its stub rows — the reading order. */
function pageSvg(page: JourneyMapPage, layout: FlowLayout, waysOut: JourneyMapEdge[], readOnly: boolean | undefined): string {
  const box = layout.nodes[page.key];
  if (box === undefined) {
    return "";
  }
  const m = JOURNEY_MAP_METRICS.card;
  const rows = page.rows;
  // The card's texts are separated by a space in the markup, in the order they are named in (itemName).
  const title = page.titleLines
    .map((line, index) => `<tspan${attributes({ x: m.titleX, y: rows.title[index] })}>${esc(line)}</tspan>`)
    .join(" ");
  // The caption wraps under the title, a line each, rather than ending in "…"; one line is one text, as it always was.
  const meta =
    page.metaLines.length <= 1
      ? `<text${attributes({ class: "jm-node__meta", x: m.titleX, y: rows.meta })}>${esc(page.metaLines[0] ?? page.meta)}</text>`
      : `<text class="jm-node__meta">${page.metaLines
          .map((line, index) => `<tspan${attributes({ x: m.titleX, y: rows.meta + index * m.metaLine })}>${esc(line)}</tspan>`)
          .join(" ")}</text>`;
  const badge =
    page.badge !== undefined
      ? ` <text${attributes({ class: `jm-badge jm-badge--${page.badgeSeverity ?? "warning"}`, x: box.width - m.padX, y: rows.meta })}>${esc(page.badge)}</text>`
      : "";
  const notes = page.notes.map((note, index) => ` <text${attributes({ class: "jm-node__note", x: m.titleX, y: rows.notes[index] })}>${esc(note)}</text>`).join("");
  const divider =
    rows.divider !== undefined
      ? `<line${attributes({ class: "jm-node__divider", x1: m.padX, x2: box.width - m.padX, y1: rows.divider, y2: rows.divider })}/>`
      : "";
  const picture = `<rect${attributes({ class: "jm-ring", x: -4, y: -4, width: box.width + 8, height: box.height + 8, rx: 11 })}/><rect${attributes({
    class: "jm-node__box",
    width: box.width,
    height: box.height,
    rx: 7
  })}/><circle${attributes({ class: "jm-node__disc", cx: m.discX, cy: m.discY, r: m.discR })}/><text${attributes({
    class: "jm-node__number",
    x: m.discX,
    y: m.discY + 4
  })}>${page.number}</text> <text class="jm-node__title">${title}</text> ${meta}${badge}${notes}${divider}`;
  const card = `<g${attributes({
    class: classes("jm-item", "jm-node"),
    "data-select": page.select,
    ...item(page.item, itemName([String(page.number), ...page.titleLines, ...page.metaLines, page.badge, ...page.notes], page.description), readOnly)
  })}>${face(page.item, picture, page.description)}</g>`;

  const shown = page.stubs.slice(0, rows.stubs.length - (page.more !== undefined ? 1 : 0));
  const row = (baseline: number): Record<string, number> => ({ x: m.padX - 4, y: baseline - 12, width: box.width - 2 * m.padX + 8, height: m.stubLine });
  const stubs = shown
    .map((stub, index) => {
      const baseline = rows.stubs[index] as number;
      const picture = `<rect${attributes({ class: "jm-ring", ...row(baseline), rx: 4 })}/><rect${attributes({ class: "jm-stub__hit", ...row(baseline) })}/><text${attributes({
        class: "jm-stub__text",
        x: m.padX,
        y: baseline
      })}>${esc(stub.text)}</text>`;
      return `<g${attributes({
        class: classes(stub.item !== undefined && "jm-item", "jm-stub", `jm-stub--${stub.severity}`),
        "data-stub": stub.reason,
        "data-select": stub.item,
        ...item(stub.item, itemName([stub.text], stub.ariaLabel), readOnly)
      })}>${face(stub.item, picture, stub.ariaLabel)}</g>`;
    })
    .join("");
  let more = "";
  if (page.more !== undefined) {
    const baseline = rows.stubs[rows.stubs.length - 1] as number;
    const picture = `<rect${attributes({ class: "jm-ring", ...row(baseline), rx: 4 })}/><rect${attributes({ class: "jm-stub__hit", ...row(baseline) })}/><text${attributes({
      class: "jm-more__text",
      x: m.padX,
      y: baseline
    })}>${esc(page.more.text)}</text>`;
    more = `<g${attributes({
      class: classes(page.more.item !== undefined && "jm-item", "jm-more"),
      "data-select": page.more.item !== undefined ? page.select : undefined,
      ...item(page.more.item, itemName([page.more.text], page.more.ariaLabel), readOnly)
    })}>${face(page.more.item, picture, page.more.ariaLabel)}</g>`;
  }

  return `<g${attributes({
    class: classes(
      "jm-page",
      page.exit && "jm-page--exit",
      page.unreachable && "is-unreachable",
      page.findings.errors > 0 ? "has-errors" : page.findings.warnings > 0 && "has-warnings"
    ),
    "data-map-node": page.key,
    transform: `translate(${num(box.x)} ${num(box.y)})`
  })}>${card}${waysOut.map((edge) => labelSvg(edge, edge.label as JourneyMapLabel, layout, readOnly, box)).join("")}${stubs}${more}</g>`;
}

/**
 * The map's SVG: edges (the ways no path takes first, so live lines draw over them), the chips
 * that are not items (a fall-through's "Otherwise"), then Start, the steps and End. The items are in reading order in the markup, so a screen
 * reader's browse order is the arrows' order: each step's card, the chips of its ways out, its
 * stubs. The chips that are not items are hidden from assistive technology: what they say is
 * in the steps' labels. See the module comment.
 */
export function journeyMapSvg(graph: JourneyMapGraph, layout: FlowLayout): string {
  const edges = [...graph.edges.filter((edge) => !edge.live), ...graph.edges.filter((edge) => edge.live)];
  const edgeMarkup = edges.map((edge) => edgeSvg(edge, layout)).join("");
  const pageKeys = new Set(graph.nodes.filter((node) => node.kind === "page" && layout.nodes[node.key] !== undefined).map((node) => node.key));
  const waysOut = new Map<string, JourneyMapEdge[]>();
  let labels = "";
  let loose = "";
  for (const edge of graph.edges) {
    if (edge.label === undefined) {
      continue;
    }
    // A route's chip is its step's: its line leaves the step's card.
    const page = edge.from;
    if (edge.label.item === undefined) {
      labels += labelSvg(edge, edge.label, layout, graph.readOnly);
    } else if (pageKeys.has(page)) {
      waysOut.set(page, [...(waysOut.get(page) ?? []), edge]);
    } else {
      // An item chip whose page is not drawn: still an item, after the nodes.
      loose += labelSvg(edge, edge.label, layout, graph.readOnly);
    }
  }
  const nodes = graph.nodes
    .map((node) => (node.kind === "page" ? pageSvg(node, layout, waysOut.get(node.key) ?? [], graph.readOnly) : terminalSvg(node, layout, graph.readOnly)))
    .join("");
  return `<svg${attributes({
    xmlns: "http://www.w3.org/2000/svg",
    class: classes("jm-svg", graph.stale && "is-stale"),
    viewBox: `0 0 ${num(layout.width)} ${num(layout.height)}`,
    role: "group",
    "aria-roledescription": "journey map",
    "aria-label": graph.label,
    "data-direction": layout.direction
  })}><g class="jm-edges">${edgeMarkup}</g><g class="jm-labels" aria-hidden="true">${labels}</g><g class="jm-nodes">${nodes}${loose}</g></svg>`;
}
