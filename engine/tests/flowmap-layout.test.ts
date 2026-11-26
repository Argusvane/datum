import { describe, expect, it } from "vitest";

import { checkJourneyTree, findingsSummary, indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import {
  estimateTextWidth,
  layoutFlow,
  wrapText,
  type FlowBox,
  type FlowDirection,
  type FlowEdgeInput,
  type FlowLayout,
  type FlowLayoutInput,
  type FlowNodeInput
} from "../form-engine/builder/journey-map/journey-map-layout.js";
import { journeyMapGraph, journeyMapLayoutInput, type JourneyMapGraph, type JourneyMapWords } from "../form-engine/builder/journey-map/journey-map-model.js";
import { journeyFlow } from "../form-engine/core/journey/journey-flow.js";
import { mapSource, mapWords } from "./flowmap-words.js";
import { applyJourney, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey, JourneyPage } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The flow map's layered layout: deterministic, never overlapping, monotone along the
 * flow, and straight along the main line — the staircase a plain barycentre layout drifts into
 * at every split is what the alignment step is for.
 */

const DIRECTIONS: FlowDirection[] = ["down", "right"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random forward graph: boxes, pills (small square ones among them) and labelled and unlabelled edges, some flagged as the main line. */
function randomGraph(seed: number, maxNodes = 60): Pick<FlowLayoutInput, "nodes" | "edges"> {
  const next = random(seed);
  const count = 2 + Math.floor(next() * (maxNodes - 1));
  const nodes: FlowNodeInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const roll = next();
    nodes.push(
      roll < 0.2
        ? { key: `n${index}`, order: index * 3, width: 28, height: 28, shape: "pill" }
        : roll < 0.28
          ? { key: `n${index}`, order: index * 3, width: 104, height: 30, shape: "pill" }
          : { key: `n${index}`, order: index * 3, width: 208, height: 52 + 16 * Math.floor(next() * 4), shape: "box" }
    );
  }
  const pairs: Array<[number, number]> = [];
  for (let index = 1; index < count; index += 1) {
    if (next() < 0.9) {
      pairs.push([Math.floor(next() * index), index]);
    }
    if (next() < 0.5 && index + 1 < count) {
      pairs.push([index, index + 1 + Math.floor(next() * (count - index - 1))]);
    }
  }
  const outs = new Map<number, number>();
  const edges: FlowEdgeInput[] = pairs.map(([from, to], index) => {
    const order = outs.get(from) ?? 0;
    outs.set(from, order + 1);
    const edge: FlowEdgeInput = { key: `e${index}`, from: `n${from}`, to: `n${to}`, order, weight: 1 + Math.floor(next() * 3) };
    if (order === 0 && next() < 0.8) {
      edge.spine = true;
    }
    if (next() < 0.6) {
      edge.label = { width: Math.round(30 + next() * 138), height: next() < 0.7 ? 22 : 36 };
    }
    return edge;
  });
  return { nodes, edges };
}

function overlaps(a: FlowBox, b: FlowBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(point: { x: number; y: number }, box: FlowBox, margin = 0.75): boolean {
  return point.x > box.x + margin && point.x < box.x + box.width - margin && point.y > box.y + margin && point.y < box.y + box.height - margin;
}

type Command = { op: "M" | "L"; to: [number, number] } | { op: "C"; c1: [number, number]; c2: [number, number]; to: [number, number] };

function parsePath(d: string): Command[] {
  const out: Command[] = [];
  for (const match of d.matchAll(/([MLC])([^MLCZ]*)/g)) {
    const numbers = match[2]!.trim().split(/\s+/).map(Number);
    if (match[1] === "C") {
      out.push({ op: "C", c1: [numbers[0]!, numbers[1]!], c2: [numbers[2]!, numbers[3]!], to: [numbers[4]!, numbers[5]!] });
    } else {
      out.push({ op: match[1] as "M" | "L", to: [numbers[0]!, numbers[1]!] });
    }
  }
  return out;
}

/** Points along a path: every end point, and inside each curve. */
function sample(d: string, steps = 6): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let at: [number, number] = [0, 0];
  for (const command of parsePath(d)) {
    if (command.op === "C") {
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const u = 1 - t;
        const x = u * u * u * at[0] + 3 * u * u * t * command.c1[0] + 3 * u * t * t * command.c2[0] + t * t * t * command.to[0];
        const y = u * u * u * at[1] + 3 * u * u * t * command.c1[1] + 3 * u * t * t * command.c2[1] + t * t * t * command.to[1];
        points.push([x, y]);
      }
    } else if (command.op === "L") {
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        points.push([at[0] + (command.to[0] - at[0]) * t, at[1] + (command.to[1] - at[1]) * t]);
      }
    } else {
      points.push(command.to);
    }
    at = command.to;
  }
  return points;
}

/** A path as a polyline with points at most about 2 px apart. */
function polyline(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let at: [number, number] = [0, 0];
  for (const command of parsePath(d)) {
    if (command.op === "M") {
      points.push(command.to);
    } else {
      const steps = Math.max(1, Math.ceil(Math.hypot(command.to[0] - at[0], command.to[1] - at[1]) / 2));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const u = 1 - t;
        const c1 = command.op === "C" ? command.c1 : at;
        const c2 = command.op === "C" ? command.c2 : command.to;
        points.push([
          u * u * u * at[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * command.to[0],
          u * u * u * at[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * command.to[1]
        ]);
      }
    }
    at = command.to;
  }
  return points;
}

/** A polyline's points by 3-px cell, to find the ones near a point quickly. */
function cells(points: ReadonlyArray<[number, number]>): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  for (const point of points) {
    const key = `${Math.floor(point[0] / 3)},${Math.floor(point[1] / 3)}`;
    out.set(key, [...(out.get(key) ?? []), point]);
  }
  return out;
}

/** Whether a point of the polyline in `grid` lies within 3 px of `point` (its points are at most 2 px apart). */
function nearLine(point: [number, number], grid: Map<string, Array<[number, number]>>): boolean {
  const cx = Math.floor(point[0] / 3);
  const cy = Math.floor(point[1] / 3);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const other of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (Math.hypot(other[0] - point[0], other[1] - point[1]) < 3) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Pairs of edges that run within 3 px of each other for more than `limit` px, as sentences.
 * Edges from one source may share a trunk as they leave it, and edges into one target as they
 * arrive; the stretch they share at that end is theirs, anywhere else it is not.
 */
function runTogether(edges: readonly FlowEdgeInput[], layout: FlowLayout, limit: number): string[] {
  const lines = edges.map((edge) => polyline(layout.edges[edge.key]!.d));
  const grids = lines.map(cells);
  const bounds = lines.map((points) => ({
    low: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))] as const,
    high: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))] as const
  }));
  const out: string[] = [];
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const [x, y] = [bounds[i]!, bounds[j]!];
      if (x.low[0] > y.high[0] + 3 || y.low[0] > x.high[0] + 3 || x.low[1] > y.high[1] + 3 || y.low[1] > x.high[1] + 3) {
        continue;
      }
      const a = lines[i]!;
      const near = a.map((point) => nearLine(point, grids[j]!));
      let from = 0;
      let to = near.length;
      if (edges[i]!.from === edges[j]!.from) {
        while (from < to && near[from]) {
          from += 1;
        }
      }
      if (edges[i]!.to === edges[j]!.to) {
        while (to > from && near[to - 1]) {
          to -= 1;
        }
      }
      let length = 0;
      for (let at = Math.max(1, from); at < to; at += 1) {
        if (near[at] && near[at - 1]) {
          length += Math.hypot(a[at]![0] - a[at - 1]![0], a[at]![1] - a[at - 1]![1]);
        }
      }
      if (length > limit) {
        out.push(`${layout.direction}: ${edges[i]!.key} and ${edges[j]!.key} run together for ${Math.round(length)} px`);
      }
    }
  }
  return out;
}

/** Whether segment p1-p2 and segment p3-p4 cross at a point inside both (touching ends and running along each other do not count). */
function segmentsCross(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): boolean {
  const side = (a: [number, number], b: [number, number], c: [number, number]): number => {
    const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(value) < 1e-6 ? 0 : Math.sign(value);
  };
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Pairs of lines that cross one another on the drawing, as sentences: the picture's crossings,
 * not the layout's count of them. Two lines from one node, or into one, may meet there (they
 * share a port or a trunk): they are not compared.
 */
function crossingLines(input: Pick<FlowLayoutInput, "edges">, layout: FlowLayout): string[] {
  const lines = input.edges.map((edge) => polyline(layout.edges[edge.key]!.d));
  const out: string[] = [];
  for (let i = 0; i < input.edges.length; i += 1) {
    for (let j = i + 1; j < input.edges.length; j += 1) {
      const [x, y] = [input.edges[i]!, input.edges[j]!];
      if (x.from === y.from || x.to === y.to || x.from === y.to || x.to === y.from) {
        continue;
      }
      const [a, b] = [lines[i]!, lines[j]!];
      let crossed = false;
      for (let at = 1; at < a.length && !crossed; at += 1) {
        for (let other = 1; other < b.length && !crossed; other += 1) {
          crossed = segmentsCross(a[at - 1]!, a[at]!, b[other - 1]!, b[other]!);
        }
      }
      if (crossed) {
        out.push(`${layout.direction}: ${x.key} crosses ${y.key}`);
      }
    }
  }
  return out;
}

/** The flow coordinate of every point a path passes through or pulls toward, in order. */
function flowCoordinates(d: string, direction: FlowDirection): number[] {
  const axis = direction === "down" ? 1 : 0;
  return parsePath(d).flatMap((command) => (command.op === "C" ? [command.c1[axis], command.c2[axis], command.to[axis]] : [command.to[axis]]));
}

/**
 * Everything wrong with a layout, as sentences: boxes or chips that overlap or leave the
 * drawing, a line that turns back, a lane or a line through a box it does not belong to, a chip
 * off its line. Collected rather than asserted one by one, which keeps 800 layouts fast.
 */
function layoutProblems(input: FlowLayoutInput, layout: FlowLayout, withPaths: boolean): string[] {
  const problems: string[] = [];
  const context = input.direction;
  const boxes: Array<{ key: string; box: FlowBox }> = [
    ...Object.entries(layout.nodes).map(([key, box]) => ({ key: `node:${key}`, box })),
    ...Object.entries(layout.edges).flatMap(([key, edge]) => (edge.label ? [{ key: `label:${key}`, box: edge.label }] : []))
  ];
  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      if (overlaps(boxes[a]!.box, boxes[b]!.box)) {
        problems.push(`${context}: ${boxes[a]!.key} overlaps ${boxes[b]!.key}`);
      }
    }
  }
  for (const { key, box } of boxes) {
    if (box.x < 0 || box.y < 0 || box.x + box.width > layout.width || box.y + box.height > layout.height) {
      problems.push(`${context}: ${key} leaves the drawing`);
    }
  }
  for (const edge of input.edges) {
    const route = layout.edges[edge.key];
    if (route === undefined) {
      problems.push(`${context}: ${edge.key} is not drawn`);
      continue;
    }
    const flow = flowCoordinates(route.d, input.direction);
    for (let index = 1; index < flow.length; index += 1) {
      if (flow[index]! < flow[index - 1]! - 0.001) {
        problems.push(`${context}: ${edge.key} turns back`);
      }
    }
    for (const point of route.via) {
      for (const { key, box } of boxes) {
        if (key !== `label:${edge.key}` && inside(point, box)) {
          problems.push(`${context}: ${edge.key} has a lane in ${key}`);
        }
      }
    }
    if (route.label && !inside(route.via[0]!, route.label, 0)) {
      problems.push(`${context}: ${edge.key}'s chip is off its line`);
    }
    if (withPaths) {
      for (const [x, y] of sample(route.d)) {
        for (const { key, box } of boxes) {
          if (key !== `node:${edge.from}` && key !== `node:${edge.to}` && key !== `label:${edge.key}` && inside({ x, y }, box)) {
            problems.push(`${context}: ${edge.key} crosses ${key} at ${x.toFixed(1)},${y.toFixed(1)}`);
          }
        }
      }
    }
    if (problems.length > 20) {
      break;
    }
  }
  return problems;
}

function checkLayout(input: FlowLayoutInput, layout: FlowLayout, withPaths: boolean): void {
  expect(layoutProblems(input, layout, withPaths)).toEqual([]);
}

describe("layoutFlow", () => {
  it("gives byte-identical output for the same graph, however its input is ordered", () => {
    for (const seed of [3, 17, 42]) {
      const graph = randomGraph(seed);
      for (const direction of DIRECTIONS) {
        const first = JSON.stringify(layoutFlow({ ...graph, direction }));
        expect(JSON.stringify(layoutFlow({ ...graph, direction }))).toBe(first);
        const shuffle = random(seed * 7);
        const nodes = [...graph.nodes].sort(() => shuffle() - 0.5);
        const edges = [...graph.edges].sort(() => shuffle() - 0.5);
        expect(JSON.stringify(layoutFlow({ nodes, edges, direction }))).toBe(first);
      }
    }
  });

  for (const direction of DIRECTIONS) {
    it(`never overlaps boxes or chips, runs every line forward, and keeps lanes clear, over 200 random graphs, ${direction}`, () => {
      const problems: string[] = [];
      for (let seed = 1; seed <= 200 && problems.length === 0; seed += 1) {
        const input: FlowLayoutInput = { ...randomGraph(seed), direction };
        problems.push(...layoutProblems(input, layoutFlow(input), seed <= 25).map((problem) => `seed ${seed} ${problem}`));
      }
      expect(problems).toEqual([]);
    }, 60_000);
  }

  it("draws Right as Down transposed when every node is square and nothing is labelled", () => {
    const next = random(9);
    const nodes: FlowNodeInput[] = Array.from({ length: 14 }, (_value, index) => ({
      key: `n${index}`,
      order: index,
      width: index % 3 === 0 ? 28 : 40,
      height: index % 3 === 0 ? 28 : 40,
      shape: index % 3 === 0 ? "pill" : "box"
    }));
    const edges: FlowEdgeInput[] = [];
    for (let index = 1; index < nodes.length; index += 1) {
      edges.push({ key: `a${index}`, from: `n${Math.floor(next() * index)}`, to: `n${index}`, order: 0, spine: index % 2 === 0 });
      if (index + 2 < nodes.length) {
        edges.push({ key: `b${index}`, from: `n${index}`, to: `n${index + 2}`, order: 1 });
      }
    }
    const down = layoutFlow({ nodes, edges, direction: "down" });
    const right = layoutFlow({ nodes, edges, direction: "right" });
    expect([right.width, right.height]).toEqual([down.height, down.width]);
    for (const key of Object.keys(down.nodes)) {
      const a = down.nodes[key]!;
      const b = right.nodes[key]!;
      expect([b.x, b.y, b.rank]).toEqual([a.y, a.x, a.rank]);
    }
    const swap = (d: string): string => d.replace(/(-?[\d.]+) (-?[\d.]+)/g, "$2 $1");
    for (const key of Object.keys(down.edges)) {
      expect(right.edges[key]!.d).toBe(swap(down.edges[key]!.d));
      expect(right.edges[key]!.head).toBe(swap(down.edges[key]!.head));
    }
  });

  it("draws a diamond, a three-way fan and nested branches without a crossing", () => {
    const box = (key: string, order: number): FlowNodeInput => ({ key, order, width: 120, height: 40 });
    const shapes: Array<Pick<FlowLayoutInput, "nodes" | "edges">> = [
      {
        nodes: [box("a", 0), box("b", 1), box("c", 2), box("d", 3)],
        edges: [
          { key: "ab", from: "a", to: "b", order: 0 },
          { key: "ac", from: "a", to: "c", order: 1 },
          { key: "bd", from: "b", to: "d", order: 0 },
          { key: "cd", from: "c", to: "d", order: 0 }
        ]
      },
      {
        nodes: [box("a", 0), box("b", 1), box("c", 2), box("d", 3), box("e", 4)],
        edges: [
          { key: "ab", from: "a", to: "b", order: 0, label: { width: 60, height: 22 } },
          { key: "ac", from: "a", to: "c", order: 1, label: { width: 60, height: 22 } },
          { key: "ad", from: "a", to: "d", order: 2, label: { width: 60, height: 22 } },
          { key: "be", from: "b", to: "e", order: 0 },
          { key: "ce", from: "c", to: "e", order: 0 },
          { key: "de", from: "d", to: "e", order: 0 }
        ]
      },
      {
        nodes: ["a", "b", "b1", "b2", "bj", "c", "c1", "c2", "cj", "z"].map((key, order) => box(key, order)),
        edges: [
          { key: "a-b", from: "a", to: "b", order: 0 },
          { key: "a-c", from: "a", to: "c", order: 1 },
          { key: "b-b1", from: "b", to: "b1", order: 0 },
          { key: "b-b2", from: "b", to: "b2", order: 1 },
          { key: "b1-bj", from: "b1", to: "bj", order: 0 },
          { key: "b2-bj", from: "b2", to: "bj", order: 0 },
          { key: "c-c1", from: "c", to: "c1", order: 0 },
          { key: "c-c2", from: "c", to: "c2", order: 1 },
          { key: "c1-cj", from: "c1", to: "cj", order: 0 },
          { key: "c2-cj", from: "c2", to: "cj", order: 0 },
          { key: "bj-z", from: "bj", to: "z", order: 0 },
          { key: "cj-z", from: "cj", to: "z", order: 0 }
        ]
      }
    ];
    for (const shape of shapes) {
      for (const direction of DIRECTIONS) {
        const layout = layoutFlow({ ...shape, direction });
        expect(layout.crossings).toBe(0);
        expect(crossingLines(shape, layout)).toEqual([]);
      }
    }
  });

  it("puts alternatives on one layer, in try order across", () => {
    const nodes: FlowNodeInput[] = ["a", "b", "c", "d", "e"].map((key, order) => ({ key, order, width: 100, height: 40 }));
    const edges: FlowEdgeInput[] = [
      { key: "ab", from: "a", to: "b", order: 0 },
      { key: "ac", from: "a", to: "c", order: 1 },
      { key: "ad", from: "a", to: "d", order: 2 },
      { key: "be", from: "b", to: "e", order: 0 },
      { key: "ce", from: "c", to: "e", order: 0 },
      { key: "de", from: "d", to: "e", order: 0 }
    ];
    const branches = layoutFlow({ nodes, edges, direction: "down" });
    expect(["a", "b", "c", "d", "e"].map((key) => branches.nodes[key]!.rank)).toEqual([0, 2, 2, 2, 4]);
    // In try order across.
    expect(branches.nodes.b!.x).toBeLessThan(branches.nodes.c!.x);
    expect(branches.nodes.c!.x).toBeLessThan(branches.nodes.d!.x);
  });

  it("brings every edge into its target at one arrowhead, the centre of its in side", () => {
    const graph = randomGraph(77, 30);
    for (const direction of DIRECTIONS) {
      const layout = layoutFlow({ ...graph, direction });
      for (const edge of graph.edges) {
        const box = layout.nodes[edge.to]!;
        const tip = layout.edges[edge.key]!.end;
        expect(tip).toEqual(direction === "down" ? { x: box.x + box.width / 2, y: box.y } : { x: box.x, y: box.y + box.height / 2 });
      }
    }
  });

  it("lays out 60 pages and 150 edges quickly (a loose bound)", () => {
    const next = random(5);
    const nodes: FlowNodeInput[] = Array.from({ length: 60 }, (_value, index) => ({ key: `p${index}`, order: index, width: 208, height: 76 }));
    const edges: FlowEdgeInput[] = [];
    for (let index = 0; index + 1 < 60; index += 1) {
      edges.push({ key: `next${index}`, from: `p${index}`, to: `p${index + 1}`, order: 9, spine: true, label: { width: 70, height: 22 } });
    }
    while (edges.length < 150) {
      const from = Math.floor(next() * 58);
      const to = from + 2 + Math.floor(next() * (59 - from - 1));
      if (to < 60) {
        edges.push({ key: `jump${edges.length}`, from: `p${from}`, to: `p${to}`, order: edges.length % 5, label: { width: 120, height: 36 } });
      }
    }
    const started = performance.now();
    for (const direction of DIRECTIONS) {
      layoutFlow({ nodes, edges, direction });
    }
    expect(performance.now() - started).toBeLessThan(4000);
  });
});

function eq(path: string, value: string): Expression {
  return { kind: "binary", operator: "eq", left: { kind: "path", path }, right: { kind: "literal", value } };
}

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      ...Array.from({ length: 24 }, (_value, index): ComponentNode => ({ id: `q${index}`, type: "text", configuration: { label: `Question ${index}` } })),
      { id: "sorry", type: "html", configuration: { content: "Sorry" } },
      { id: "hid", type: "text", configuration: { label: "Hideable" }, rules: { visibleWhen: { kind: "literal", value: true } } }
    ]
  }
};

const WORDS: JourneyMapWords = {
  journeyName: "Chain",
  condition: () => ({ join: "and", terms: [{ subject: "a condition", test: "in words" }] }),
  pageName: (entry) => entry.pageId,
  summary: findingsSummary
};

/** The map of `journey` over {@link FORM}, as the designer would build it. */
function graphOf(journey: Journey): JourneyMapGraph {
  const tree = treeFromJourney(journey);
  const view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(FORM, tree, journey.id) };
  return journeyMapGraph(view, journeyFlow(view.check.journey!), WORDS);
}

/**
 * What bends the main line from Start: a node on it off Start's cross coordinate, or a line
 * between two of them that is not straight. Its length alongside.
 */
function mainLineProblems(graph: JourneyMapGraph, layout: FlowLayout, direction: FlowDirection): { length: number; problems: string[] } {
  const context = direction;
  const cross = (box: FlowBox): number => (direction === "down" ? box.x + box.width / 2 : box.y + box.height / 2);
  const main: string[] = ["$start"];
  const mainEdges: string[] = [];
  for (;;) {
    const onward = graph.edges.find((edge) => edge.spine && edge.from === main[main.length - 1]);
    if (!onward) {
      break;
    }
    main.push(onward.to);
    mainEdges.push(onward.key);
  }
  const problems: string[] = [];
  const line = cross(layout.nodes["$start"]!);
  for (const key of main) {
    if (cross(layout.nodes[key]!) !== line) {
      problems.push(`${context}: ${key} is off the main line`);
    }
  }
  // Another chain may bend where it joins one drawn before it; the main line never does.
  const axis = direction === "down" ? 0 : 1;
  for (const key of mainEdges) {
    const commands = parsePath(layout.edges[key]!.d);
    if (commands.some((command) => command.op === "C" || command.to[axis] !== line)) {
      problems.push(`${context}: ${key} bends`);
    }
  }
  return { length: main.length, problems };
}

/** Every node on the main line from Start has one cross coordinate, and every line between them is straight. */
function expectStraight(graph: JourneyMapGraph, direction: FlowDirection): number {
  const input = journeyMapLayoutInput(graph, { direction });
  const layout = layoutFlow(input);
  checkLayout(input, layout, true);
  const { length, problems } = mainLineProblems(graph, layout, direction);
  expect(problems).toEqual([]);
  return length;
}

describe("the main line stays straight", () => {
  it("through ten eligibility exits, each reached by a route", () => {
    const routes = Array.from({ length: 10 }, (_value, index) => ({ when: eq("q0", `no${index + 1}`), to: `stop${index + 1}` }));
    const pages: JourneyPage[] = [{ id: "start", components: ["q0"], routes: [...routes, { to: "go" }] }];
    for (let index = 1; index <= 10; index += 1) {
      pages.push({ id: `stop${index}`, kind: "exit", components: ["sorry"] });
    }
    pages.push({ id: "go", components: ["q1"] });
    const graph = graphOf({ id: "chain", pages });
    // The first step's eleven ways out all leave its box: there is no diamond.
    expect(graph.edges.filter((edge) => edge.from === "page:journey-page_1")).toHaveLength(11);
    for (const direction of DIRECTIONS) {
      // Start, the first step, the last step, End.
      expect(expectStraight(graph, direction)).toBe(4);
    }
  });

  it("through a chain of ten pages whose questions may each hide, each shown", () => {
    const pages: JourneyPage[] = [];
    for (let index = 0; index < 10; index += 1) {
      pages.push({ id: `p${index}`, components: ["hid"] });
    }
    const graph = graphOf({ id: "chain", pages });
    // Each goes on by its fall-through: one line each.
    expect(graph.edges.every((edge) => edge.kind === "start" || edge.kind === "next")).toBe(true);
    expect(graph.edges.filter((edge) => edge.kind === "next")).toHaveLength(10);
    for (const direction of DIRECTIONS) {
      // Start, ten steps, End.
      expect(expectStraight(graph, direction)).toBe(12);
    }
  });

  it("through fans of routes, jumps and joins", () => {
    const graph = graphOf({
      id: "fans",
      pages: [
        { id: "ask", components: ["q0"], routes: [{ when: eq("q0", "a"), to: "a" }, { when: eq("q0", "b"), to: "b" }, { when: eq("q0", "c"), to: "join" }] },
        { id: "main", components: ["q1"] },
        { id: "a", components: ["q2"], routes: [{ to: "join" }] },
        { id: "b", components: ["hid"] },
        {
          id: "join",
          components: ["q4"],
          routes: [{ when: eq("q4", "x"), to: "$end" }, { when: eq("q4", "y"), to: "last" }, { when: { ...eq("q4", "z"), operator: "neq" } as Expression, to: "more" }]
        },
        { id: "stop", kind: "exit", components: ["sorry"] },
        { id: "more", components: ["q5"] },
        { id: "last", components: ["q6"] }
      ]
    });
    for (const direction of DIRECTIONS) {
      // Start, ask, main, join, the exit after it, and on: the two steps with several ways out have no diamond now.
      expect(expectStraight(graph, direction)).toBeGreaterThanOrEqual(6);
    }
  });

  it("when a branch's own way on rejoins it before the main line gets there", () => {
    // The side page's route to c is its way on too, and it is written before the route that
    // leads the main line into c: the main line must still win c.
    const graph = graphOf({
      id: "rejoin",
      pages: [
        { id: "a", components: ["q0"], routes: [{ when: eq("q0", "rent"), to: "side" }, { when: eq("q0", "stop"), to: "b" }, { to: "c" }] },
        { id: "side", components: ["q1"], routes: [{ to: "c" }] },
        { id: "b", kind: "exit", components: ["sorry"] },
        { id: "c", components: ["q2"] }
      ]
    });
    for (const direction of DIRECTIONS) {
      // Start, a, c, End.
      expect(expectStraight(graph, direction)).toBe(4);
    }
  });

  it("over 150 random journeys", () => {
    const form: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          ...Array.from({ length: 40 }, (_value, index): ComponentNode => ({ id: `q${index}`, type: "text", configuration: { label: `Q${index}` } })),
          { id: "sorry", type: "html", configuration: { content: "Sorry" } },
          { id: "hid", type: "text", configuration: { label: "H" }, rules: { visibleWhen: eq("q0", "x") } }
        ]
      }
    };
    const problems: string[] = [];
    for (let seed = 1; seed <= 150; seed += 1) {
      const next = random(seed);
      const count = 3 + Math.floor(next() * 25);
      const pages: JourneyPage[] = [];
      for (let index = 0; index < count; index += 1) {
        const page: JourneyPage = { id: `p${index}`, components: [`q${index % 40}`] };
        const roll = next();
        if (roll > 0.88) {
          page.kind = "exit";
          page.components = ["sorry"];
        }
        if (next() < 0.06) {
          page.components = ["hid"];
        }
        if (next() < 0.3 && index + 2 < count) {
          const routes = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
            when: eq(`q${index % 40}`, `r${Math.floor(next() * 100)}`),
            to: next() < 0.08 ? "$end" : `p${index + 1 + Math.floor(next() * Math.min(8, count - index - 1))}`
          }));
          page.routes = next() < 0.2 ? [...routes, { to: `p${Math.min(count - 1, index + 2)}` }] : routes;
        }
        pages.push(page);
      }
      const tree = treeFromJourney({ id: `j${seed}`, pages });
      const view = { tree, index: indexJourneyTree(tree), check: checkJourneyTree(form, tree, `j${seed}`) };
      const graph = journeyMapGraph(view, journeyFlow(view.check.journey!), WORDS);
      for (const direction of DIRECTIONS) {
        const layout = layoutFlow(journeyMapLayoutInput(graph, { direction }));
        problems.push(...mainLineProblems(graph, layout, direction).problems.map((problem) => `seed ${seed} ${problem}`));
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("crossings", () => {
  it("draws an exit branch on whichever side of the main line crosses nothing", () => {
    // Its condition is tried first, so the sweeps start it on the side the rejoining branch
    // takes; the drawing without a crossing has it on the other.
    const rejoin = graphOf({
      id: "rejoin",
      pages: [
        { id: "a", components: ["q0"], routes: [{ when: eq("q0", "rent"), to: "side" }, { when: eq("q0", "stop"), to: "b" }, { to: "c" }] },
        { id: "side", components: ["q1"], routes: [{ to: "c" }] },
        { id: "b", kind: "exit", components: ["sorry"] },
        { id: "c", components: ["q2"] }
      ]
    });
    // Forty-five pages: pages that may show nothing, jumps forward, a route back; then the same
    // with an exit every nine pages, reached by a route from the step before it, tried last or
    // first.
    const longPages = (): JourneyPage[] => {
      const pages: JourneyPage[] = [];
      for (let index = 0; index < 45; index += 1) {
        const page: JourneyPage = { id: `s${index}`, components: [`q${index % 24}`] };
        if (index % 7 === 3) {
          page.components = ["hid"];
        }
        if (index % 6 === 1 && index + 4 < 45) {
          page.routes = [{ when: eq(`q${index % 24}`, "a"), to: `s${index + 3}` }, ...(index % 12 === 1 ? [{ when: eq(`q${index % 24}`, "b"), to: `s${index + 4}` }] : [])];
        }
        if (index === 20) {
          page.routes = [{ when: eq("q20", "back"), to: "s2" }, { to: "s22" }, { when: eq("q20", "late"), to: "s30" }];
        }
        if (index === 30) {
          page.components = ["hid"];
        }
        pages.push(page);
      }
      return pages;
    };
    const long = graphOf({ id: "long", pages: longPages() });
    const withExits = (first: boolean): JourneyMapGraph => {
      const pages = longPages();
      for (let index = 5; index < pages.length; index += 9) {
        pages[index] = { id: `s${index}`, kind: "exit", components: ["sorry"] };
        const before = pages[index - 1]!;
        const route = { when: eq(`q${(index - 1) % 24}`, "stop"), to: `s${index}` };
        before.routes = first ? [route, ...(before.routes ?? [])] : [...(before.routes ?? []), route];
      }
      return graphOf({ id: first ? "exits-first" : "exits-last", pages });
    };
    for (const graph of [rejoin, long, withExits(false), withExits(true)]) {
      for (const direction of DIRECTIONS) {
        const input = journeyMapLayoutInput(graph, { direction });
        const layout = layoutFlow(input);
        expect(layout.crossings, `${graph.label} ${direction}`).toBe(0);
        expect(crossingLines(input, layout), `${graph.label} ${direction}`).toEqual([]);
      }
    }
  });
});

describe("pages nothing leads to", () => {
  it("stand clear of the column of the page above, so they never read as its way on", () => {
    // d is an exit; "lost" comes after it and no path reaches it; its fall-through goes on to x1.
    const graph = graphOf({
      id: "orphans",
      pages: [
        { id: "a", components: ["q0"], routes: [{ to: "c" }] },
        { id: "b", components: ["q1"] },
        { id: "c", components: ["q2"], routes: [{ when: eq("q2", "x"), to: "x1" }] },
        { id: "d", kind: "exit", components: ["sorry"] },
        { id: "lost", components: ["q3"] },
        { id: "x1", kind: "exit", components: ["sorry"] },
        { id: "e", components: ["q4"] }
      ]
    });
    for (const direction of DIRECTIONS) {
      const input = journeyMapLayoutInput(graph, { direction });
      const layout = layoutFlow(input);
      checkLayout(input, layout, true);
      const extent = (box: FlowBox): [number, number] => (direction === "down" ? [box.x, box.x + box.width] : [box.y, box.y + box.height]);
      const [exitLow, exitHigh] = extent(layout.nodes["page:journey-page_4"]!);
      const [lostLow, lostHigh] = extent(layout.nodes["page:journey-page_5"]!);
      expect(lostLow >= exitHigh || lostHigh <= exitLow, direction).toBe(true);
    }
  });
});

describe("lines keep apart", () => {
  /** A page with `routes` conditional routes to branch pages, each rejoining at "join" with the page's own way on. */
  function fan(routes: number): Journey {
    return {
      id: `fan${routes}`,
      pages: [
        { id: "ask", components: ["q0"], routes: Array.from({ length: routes }, (_value, index) => ({ when: eq("q0", `o${index}`), to: `b${index}` })) },
        { id: "main", components: ["q1"], routes: [{ to: "join" }] },
        ...Array.from({ length: routes }, (_value, index): JourneyPage => ({ id: `b${index}`, components: [`q${index + 2}`], routes: [{ to: "join" }] })),
        { id: "join", components: ["q20"] },
        { id: "check", components: ["q21"] }
      ]
    };
  }

  /** Six pages, each with a way straight to the end. */
  const ENDS: Journey = {
    id: "ends",
    pages: Array.from({ length: 6 }, (_value, index): JourneyPage => ({
      id: `e${index}`,
      components: [`q${index}`],
      ...(index < 5 ? { routes: [{ when: eq(`q${index}`, "done"), to: "$end" }] } : {})
    }))
  };

  it("in a fan out of a page, the lines rejoining after it, and lines converging on the end", () => {
    const problems: string[] = [];
    for (const journey of [fan(3), fan(5), fan(8), ENDS]) {
      const graph = graphOf(journey);
      for (const direction of DIRECTIONS) {
        const input = journeyMapLayoutInput(graph, { direction });
        problems.push(...runTogether(input.edges, layoutFlow(input), 16).map((problem) => `${journey.id} ${problem}`));
      }
    }
    expect(problems).toEqual([]);
  });

  it("over random graphs", () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const direction of DIRECTIONS) {
        const input: FlowLayoutInput = { ...randomGraph(seed, 24), direction };
        problems.push(...runTogether(input.edges, layoutFlow(input), 16).map((problem) => `seed ${seed} ${problem}`));
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it("leaves a card by ports at least 8 apart, neighbours sharing one where its side is too short", () => {
    const outPorts = (input: FlowLayoutInput, layout: FlowLayout): string[] => {
      const problems: string[] = [];
      for (const node of input.nodes) {
        if ((node.shape ?? "box") !== "box") {
          continue;
        }
        const starts = input.edges
          .filter((edge) => edge.from === node.key)
          .map((edge) => layout.edges[edge.key]!.start)
          .map((point) => (input.direction === "down" ? point.x : point.y));
        const distinct = [...new Set(starts)].sort((a, b) => a - b);
        for (let index = 1; index < distinct.length; index += 1) {
          if (distinct[index]! - distinct[index - 1]! < 8) {
            problems.push(`${input.direction}: ${node.key} leaves by ports ${distinct[index]! - distinct[index - 1]!} px apart`);
          }
        }
      }
      return problems;
    };
    const problems: string[] = [];
    for (const journey of [fan(3), fan(4), fan(8)]) {
      for (const direction of DIRECTIONS) {
        const input = journeyMapLayoutInput(graphOf(journey), { direction });
        problems.push(...outPorts(input, layoutFlow(input)).map((problem) => `${journey.id} ${problem}`));
      }
    }
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const direction of DIRECTIONS) {
        const input: FlowLayoutInput = { ...randomGraph(seed, 30), direction };
        problems.push(...outPorts(input, layoutFlow(input)).map((problem) => `seed ${seed} ${problem}`));
      }
    }
    expect(problems).toEqual([]);
    // Drawn left to right, a card is 52 high: eight ways out of one share ports, and part on their
    // tracks.
    const input: FlowLayoutInput = {
      nodes: [
        { key: "ask", order: 0, width: 208, height: 52 },
        ...Array.from({ length: 8 }, (_value, index): FlowNodeInput => ({ key: `b${index}`, order: index + 1, width: 208, height: 52 }))
      ],
      edges: Array.from({ length: 8 }, (_value, index): FlowEdgeInput => ({ key: `ask-b${index}`, from: "ask", to: `b${index}`, order: index, label: { width: 120, height: 22 } })),
      direction: "right"
    };
    const layout = layoutFlow(input);
    checkLayout(input, layout, true);
    expect(new Set(input.edges.map((edge) => layout.edges[edge.key]!.start.y)).size).toBeLessThan(input.edges.length);
  });
});

describe("a step with three or more ways out", () => {
  /**
   * A card with `ways` ways out in try order, each to a card of its own, all rejoining at a last
   * card. The `main`-th way is the main line, so the ways before it lie on one side and those
   * after it on the other. Every way leaves the card itself: there is no diamond.
   */
  function decision(ways: number, main: number): Pick<FlowLayoutInput, "nodes" | "edges"> {
    const nodes: FlowNodeInput[] = [
      { key: "card", order: 0, width: 208, height: 52 },
      ...Array.from({ length: ways }, (_value, index): FlowNodeInput => ({ key: `to${index}`, order: index + 1, width: 208, height: 52 + 16 * (index % 2) })),
      { key: "last", order: ways + 1, width: 208, height: 52 }
    ];
    const edges: FlowEdgeInput[] = [];
    for (let index = 0; index < ways; index += 1) {
      edges.push({ key: `way${index}`, from: "card", to: `to${index}`, order: index, weight: index === main ? 3 : 1, spine: index === main, label: { width: 70 + 24 * index, height: index % 2 === 0 ? 36 : 22 } });
      edges.push({ key: `on${index}`, from: `to${index}`, to: "last", order: 0, weight: 3, spine: index === main });
    }
    return { nodes, edges };
  }

  /**
   * How two lines leaving one card part, as sentences: they may share a trunk from the card (at
   * most `trunk` px of it, where a short side makes them share a port), and once apart they
   * never come within 3 px of each other again — so they never look like one line, and never
   * cross.
   */
  function partingProblems(layout: FlowLayout, a: string, b: string, trunk: number): string[] {
    const line = polyline(layout.edges[a]!.d);
    const grid = cells(polyline(layout.edges[b]!.d));
    const near = line.map((point) => nearLine(point, grid));
    const parted = near.indexOf(false);
    const problems: string[] = [];
    if (parted < 0) {
      return [`${a} never parts from ${b}`];
    }
    let shared = 0;
    for (let at = 1; at < parted; at += 1) {
      shared += Math.hypot(line[at]![0] - line[at - 1]![0], line[at]![1] - line[at - 1]![1]);
    }
    if (shared > trunk) {
      problems.push(`${a} runs with ${b} for ${Math.round(shared)} px from their card`);
    }
    if (near.slice(parted).includes(true)) {
      problems.push(`${a} meets ${b} again after parting`);
    }
    return problems;
  }

  for (const direction of DIRECTIONS) {
    it(`leaves the card by its out side, each way to its own lane, across no box or chip, ${direction}`, () => {
      // Four ways out, the third the main line (two on one side); then three, five and seven.
      for (const [ways, main] of [[4, 2], [4, 0], [4, 3], [3, 1], [5, 2], [7, 6]] as const) {
        const input: FlowLayoutInput = { ...decision(ways, main), direction };
        const layout = layoutFlow(input);
        const context = `${ways} ways, main ${main}`;
        // No line crosses a box or a chip, no two boxes or chips overlap, every line runs forward.
        expect(layoutProblems(input, layout, true), context).toEqual([]);
        // The same input, the same bytes.
        expect(JSON.stringify(layoutFlow(input)), context).toBe(JSON.stringify(layout));
        // The main way runs straight on from the card's centre into its card, and on to the last.
        const cross = (box: FlowBox): number => (direction === "down" ? box.x + box.width / 2 : box.y + box.height / 2);
        expect([cross(layout.nodes[`to${main}`]!), cross(layout.nodes.last!)], context).toEqual(Array(2).fill(cross(layout.nodes.card!)));
        const card = layout.nodes.card!;
        const outSide = direction === "down" ? card.y + card.height : card.x + card.width;
        for (let index = 0; index < ways; index += 1) {
          // Every way leaves the card's out side, within it.
          const start = layout.edges[`way${index}`]!.start;
          const [along, across, low, high] =
            direction === "down" ? [start.y, start.x, card.x, card.x + card.width] : [start.x, start.y, card.y, card.y + card.height];
          expect(along, `${context} way${index}`).toBe(outSide);
          expect(across > low && across < high, `${context} way${index}`).toBe(true);
          if (index === main) {
            expect(across, context).toBe(cross(card));
          }
        }
        // Lines from one card share a short trunk at most, then part for good.
        const problems: string[] = [];
        for (let a = 0; a < ways; a += 1) {
          for (let b = 0; b < ways; b += 1) {
            if (a !== b) {
              problems.push(...partingProblems(layout, `way${a}`, `way${b}`, 64));
            }
          }
        }
        expect(problems, context).toEqual([]);
        // And no two lines of the drawing run together anywhere else, nor cross.
        expect(runTogether(input.edges, layout, 16), context).toEqual([]);
        expect(layout.crossings, context).toBe(0);
        expect(crossingLines(input, layout), context).toEqual([]);
        // Each chip sits on its own line, clear of every other chip.
        const chips = Array.from({ length: ways }, (_value, index) => layout.edges[`way${index}`]!.label!);
        for (let a = 0; a < chips.length; a += 1) {
          for (let b = a + 1; b < chips.length; b += 1) {
            expect(overlaps(chips[a]!, chips[b]!), `${context}: chips ${a} and ${b}`).toBe(false);
          }
        }
      }
    });
  }

  it("draws a journey's steps so: every way leaves its step's box, the main line straight, nothing crossing, in both directions", () => {
    const journeys: Journey[] = [
      // The demo journey's shape: a route, then a step that may show nothing, reached only by falling through.
      {
        id: "demo",
        pages: [
          { id: "about", components: ["q0"] },
          { id: "contact", components: ["q1"], routes: [{ when: eq("q1", "phone"), to: "details" }] },
          { id: "address", components: ["hid"] },
          { id: "updates", components: ["q3"] },
          { id: "details", components: ["q4"] },
          { id: "finish", components: ["q5"] }
        ]
      },
      // Three routes and a fall-through: four ways out of one step.
      {
        id: "three",
        pages: [
          { id: "ask", components: ["q0"], routes: [{ when: eq("q0", "a"), to: "c" }, { when: eq("q0", "b"), to: "d" }, { when: eq("q0", "c"), to: "$end" }] },
          { id: "b", components: ["q1"], routes: [{ to: "e" }] },
          { id: "c", components: ["q2"], routes: [{ to: "e" }] },
          { id: "d", components: ["q3"] },
          { id: "e", components: ["q4"] }
        ]
      },
      // Four routes, two of them to exits, the last into a step that may show nothing.
      {
        id: "exits",
        pages: [
          { id: "ask", components: ["q0"], routes: [{ when: eq("q0", "a"), to: "finish" }, { when: eq("q0", "y"), to: "young" }, { when: eq("q0", "o"), to: "old" }, { to: "address" }] },
          { id: "young", kind: "exit", components: ["sorry"] },
          { id: "old", kind: "exit", components: ["sorry"] },
          { id: "address", components: ["hid"] },
          { id: "finish", components: ["q2"] }
        ]
      }
    ];
    for (const journey of journeys) {
      const graph = graphOf(journey);
      expect(graph.nodes.map((node) => node.kind).filter((kind) => kind !== "page" && kind !== "start" && kind !== "end"), journey.id).toEqual([]);
      for (const direction of DIRECTIONS) {
        const context = `${journey.id} ${direction}`;
        expectStraight(graph, direction);
        const input = journeyMapLayoutInput(graph, { direction });
        const layout = layoutFlow(input);
        // Every way out of a step starts on its card's out side.
        for (const edge of graph.edges.filter((candidate) => candidate.from.startsWith("page:"))) {
          const box = layout.nodes[edge.from]!;
          const start = layout.edges[edge.key]!.start;
          expect(direction === "down" ? start.y : start.x, `${context} ${edge.key}`).toBe(direction === "down" ? box.y + box.height : box.x + box.width);
        }
        expect(layout.crossings, context).toBe(0);
        expect(crossingLines(input, layout), context).toEqual([]);
        expect(runTogether(input.edges, layout, 16), context).toEqual([]);
        expect(JSON.stringify(layoutFlow(journeyMapLayoutInput(graphOf(journey), { direction })))).toBe(JSON.stringify(layout));
      }
    }
  });
});

describe("the home-repair journey (two rules from one step, one to an exit step)", () => {
  // Home repair: Your home, then Owning or renting, whose rule 1 goes to The work and rule 2 to
  // the exit step You cannot apply; otherwise on to Your landlord, then The work, then the end.
  const HOME_REPAIR: Journey = {
    id: "home-repair",
    pages: [
      { id: "home", title: "Your home", components: ["q0", "q1"] },
      {
        id: "owning",
        title: "Owning or renting",
        components: ["q2"],
        routes: [
          { when: eq("q2", "own"), to: "work" },
          { when: eq("q2", "mobile"), to: "cannot" }
        ]
      },
      { id: "landlord", title: "Your landlord", components: ["q3", "q4"] },
      // The work goes to the end: the exit step is listed after it, so nothing falls into it.
      { id: "work", title: "The work", components: ["q5", "q6"], routes: [{ to: "$end" }] },
      { id: "cannot", title: "You cannot apply", kind: "exit", components: ["sorry"] }
    ]
  };

  it("draws with no line crossing another, the main line straight, in both directions", () => {
    const graph = graphOf(HOME_REPAIR);
    // Step 2's three ways leave its box: rule 1, rule 2, then Otherwise.
    expect(
      graph.edges
        .filter((edge) => edge.from === "page:journey-page_2")
        .sort((a, b) => a.order - b.order)
        .map((edge) => [edge.key, edge.to, edge.label?.text])
    ).toEqual([
      ["route:journey-page_2:0", "page:journey-page_4", "1 · If a condition in words"],
      ["route:journey-page_2:1", "page:journey-page_5", "2 · If a condition in words"],
      ["next:journey-page_2", "page:journey-page_3", "Otherwise"]
    ]);
    // The exit step stops one way; the others submit.
    expect(graph.nodes.at(-1)).toMatchObject({ key: "$end", failing: false });
    expect(graph.counts).toMatchObject({ pages: 5, exits: 1 });
    for (const direction of DIRECTIONS) {
      const input = journeyMapLayoutInput(graph, { direction });
      const layout = layoutFlow(input);
      checkLayout(input, layout, true);
      expect(layout.crossings, direction).toBe(0);
      expect(crossingLines(input, layout), direction).toEqual([]);
      expect(runTogether(input.edges, layout, 16), direction).toEqual([]);
      // Start, steps 1 to 4 by the fall-through, End: one straight line.
      expect(expectStraight(graph, direction)).toBe(6);
    }
  });
});

describe("text", () => {
  it("estimates widths by character class", () => {
    expect(estimateTextWidth("", 13)).toBe(0);
    expect(estimateTextWidth("il", 10)).toBeCloseTo(6);
    expect(estimateTextWidth("ab", 10)).toBeCloseTo(11);
    expect(estimateTextWidth("AB", 10)).toBeCloseTo(13);
    expect(estimateTextWidth("mw", 10)).toBeCloseTo(16);
    expect(estimateTextWidth("日本", 10)).toBeCloseTo(20);
  });

  it("wraps between words, breaks a word too long for a line, and ends what does not fit in an ellipsis", () => {
    expect(wrapText("", 100, 11, 2)).toEqual([]);
    expect(wrapText("Short", 100, 11, 2)).toEqual(["Short"]);
    expect(wrapText("Contact method equals post", 100, 11, 2)).toEqual(["Contact method", "equals post"]);
    const long = wrapText("Supercalifragilisticexpialidocious", 60, 11, 10);
    expect(long.length).toBeGreaterThan(1);
    expect(long.join("")).toBe("Supercalifragilisticexpialidocious");
    for (const line of long) {
      expect(estimateTextWidth(line, 11)).toBeLessThanOrEqual(60);
    }
    const cut = wrapText("One two three four five six seven eight nine ten eleven twelve", 80, 11, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.endsWith("…")).toBe(true);
    expect(estimateTextWidth(cut[1]!, 11)).toBeLessThanOrEqual(80);
  });
});

describe("presentations' own nodes", () => {
  /** The shared fixture's journey with a second page a route may pass, holding an own layout of a reference and a paragraph. */
  function withRoute(): Journey {
    const journey = applyJourney();
    journey.pages[0]!.routes = [{ when: { ...eq("name", "x"), operator: "neq" } as Expression, to: "income" }];
    journey.pages.splice(1, 0, {
      id: "extra",
      title: "More about you",
      components: [
        {
          id: "more",
          type: "fieldset",
          configuration: { label: "More" },
          children: { content: [{ type: "journey-field", configuration: { componentId: "name" } }, { id: "aside", type: "html", configuration: { content: "Aside" } }] }
        }
      ]
    } as JourneyPage);
    return journey;
  }

  function ownGraph(journey: Journey): JourneyMapGraph {
    const { view, flow } = mapSource(presentationRoot(), journey);
    return journeyMapGraph(view, flow, mapWords(presentationRoot(), journey.id));
  }

  it("lays out an alias, a worked-out value and an own layout of references: nothing overlaps or crosses, the main line straight, the same bytes every time", () => {
    for (const journey of [applyJourney(), publicVariant(), withRoute()]) {
      const graph = ownGraph(journey);
      // The cards saying what they fill and work out are a row taller than the others.
      const cards = graph.nodes.filter((node) => node.kind === "page");
      expect(cards.length, journey.id).toBe(journey.pages.length);
      for (const direction of DIRECTIONS) {
        const context = `${journey.id} ${direction}`;
        expectStraight(graph, direction);
        const input = journeyMapLayoutInput(graph, { direction });
        const layout = layoutFlow(input);
        expect(layout.crossings, context).toBe(0);
        expect(crossingLines(input, layout), context).toEqual([]);
        expect(runTogether(input.edges, layout, 16), context).toEqual([]);
        for (const card of cards) {
          expect(layout.nodes[card.key]!.height, `${context} ${card.key}`).toBe(card.height);
        }
        expect(JSON.stringify(layoutFlow(journeyMapLayoutInput(ownGraph(journey), { direction }))), context).toBe(JSON.stringify(layout));
      }
    }
    const [details, extra, income] = ownGraph(withRoute()).nodes.filter((node) => node.kind === "page");
    expect([details!.height, extra!.height, income!.height]).toEqual([65, 52, 65]);
    expect(extra).toMatchObject({ meta: "extra · 1 question", notes: [], unreachable: false });
  });
});
