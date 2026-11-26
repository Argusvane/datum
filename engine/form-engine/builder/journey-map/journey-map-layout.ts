/**
 * A layered layout for the journey flow map: nodes of known sizes and forward edges
 * with optional labels, laid out top down or left to right, layered: a node sits one layer below
 * the lowest of its sources, so alternatives share a layer. It knows nothing of journeys: the
 * map's model (`journey-map-model.ts`) turns a journey into its input.
 *
 * The phases are the usual ones for a layered drawing, in house because every library that does
 * this is larger than the whole map or wrongly licensed:
 *
 * 1. **Ranks** on doubled layers: nodes on even layers, labels and lanes on the odd ones
 *    between. The input is already in a topological order (every edge goes forward), so there
 *    is no cycle to break.
 * 2. **Virtual vertices**: an edge gets one on each layer strictly between its ends; the first
 *    is its label, sized to the chip, when it has one.
 * 3. **Order within layers**: barycentre sweeps in which a node's ways out keep their try
 *    order, each followed by adjacent swaps that strictly lower the crossings of the two
 *    swapped, the best order kept by a Fenwick-tree crossing count. Two more runs without the
 *    try order — one starting each lane beside its target rather than its source — replace it
 *    only when they cross strictly less; so a page's chips read in try order across unless
 *    that costs a crossing (their numbers say the order either way). Then two tries at what the
 *    sweeps leave tied: two neighbours that cross as much either way round, swapped with the
 *    layers around them re-sorted; and a branch that ends where it goes (an exit page a route
 *    leads to), moved to either end of its layers. Each is kept only when the whole drawing
 *    crosses strictly less.
 * 4. **Alignment**: chains of vertices that must share one cross coordinate. The main line
 *    comes first — from the first node, each node's first edge flagged `spine` — so it stays
 *    straight however the branches fan out or rejoin it (an iterative barycentre alone drifts
 *    sideways a little at every split, a staircase); then the other `spine` edges (a branch's own
 *    way on), then the lanes of long edges, then an edge's last lane into its target and its
 *    first out of its source. A chain is refused where it would cross one already kept (Brandes
 *    and Köpf's rule); the main line's, kept first and one per layer, never is.
 * 5. **Cross coordinates**: each chain is one variable; neighbours on a layer keep their
 *    separation; the chains are packed, then each is moved in turn to the weighted mean of its
 *    neighbours within the room its neighbours leave. Nothing can overlap.
 * 6. **Tracks and flow coordinates**: in each gap, every edge that moves sideways gets a track
 *    of its own, ordered so that edges the order does not cross do not cross, and edges whose
 *    spans are apart share one; a layer is as thick as its largest vertex, and a gap as tall as
 *    its tracks need, more when its edges move far sideways.
 * 7. **Routing**: an edge runs straight through every layer it crosses (at its lane, so beside
 *    every box there) and bends only in the gaps, on its track with a rounded turn at each end,
 *    so no line crosses a box or a chip and no two run together. Out-ports sit under their next
 *    point, 16 apart, inside the box, the main line's at the centre; where a side is too short
 *    for 8 apart (a card drawn left to right), neighbours share a port and part on their tracks.
 *    In-ports meet at the centre of the target's in side, so converging edges share one
 *    arrowhead, each joining the trunk of those before it.
 *
 * Everything is computed as (across, along) and turned into (x, y) at the end: down maps
 * (x, y) = (across, along), right maps (x, y) = (along, across). Deterministic — no randomness,
 * a fixed number of rounds, stable sorts with full tie-breaks, inputs canonicalised — so the
 * same input gives byte-identical output. Pure: no DOM, nothing runs at import.
 */

export type FlowDirection = "down" | "right";
/** What a node is drawn as; the layout treats both alike. */
export type FlowShape = "box" | "pill";

export interface FlowNodeInput {
  key: string;
  /** Position in the author's list; every edge goes from a lower order to a higher one. */
  order: number;
  width: number;
  height: number;
  shape?: FlowShape;
}

export interface FlowEdgeInput {
  key: string;
  from: string;
  to: string;
  /** Try order among its source's edges: lower is tried first, and drawn first across. */
  order: number;
  /** How hard the edge pulls its ends together (default 1). */
  weight?: number;
  /** Part of the main line: kept straight wherever the layout can. */
  spine?: boolean;
  /** The chip on the edge, drawn as the edge crosses the layer below its source. */
  label?: { width: number; height: number };
}

export interface FlowLayoutInput {
  nodes: readonly FlowNodeInput[];
  edges: readonly FlowEdgeInput[];
  direction: FlowDirection;
}

export interface FlowPoint {
  x: number;
  y: number;
}

/** A box from its top-left corner. */
export interface FlowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowNodeLayout extends FlowBox {
  /** Its layer (doubled: nodes are on even layers). */
  rank: number;
}

export interface FlowEdgeLayout {
  /** The line, arrowhead excluded: `M`, `L` and `C` commands in absolute coordinates. */
  d: string;
  /** The arrowhead: a closed triangle whose tip is {@link end}. */
  head: string;
  /** Where the line leaves its source. */
  start: FlowPoint;
  /** Where the arrowhead's tip meets its target. */
  end: FlowPoint;
  /** One point per layer the edge crosses, in order: its label's centre first when it has one. */
  via: FlowPoint[];
  label?: FlowBox;
}

export interface FlowLayout {
  direction: FlowDirection;
  width: number;
  height: number;
  /** Edge crossings between adjacent layers in the order kept. */
  crossings: number;
  nodes: Record<string, FlowNodeLayout>;
  /** Edges that do not go forward between known nodes are left out. */
  edges: Record<string, FlowEdgeLayout>;
}

/** A lane's width across: the room one line takes beside its neighbours. */
const LANE_ACROSS = 10;
/** Room between neighbours on a layer, by what they are. */
const GAP_NODES = 28;
const GAP_LANES = 10;
const GAP_NODE_LANE = 14;
const GAP_LABEL = 12;
/** Room between layers: a straight line needs little; one that moves sideways needs more. */
const MIN_LAYER_GAP = 18;
const MAX_LAYER_GAP = 56;
const ARROW_LENGTH = 7;
const ARROW_HALF = 4;
const PORT_SPACING = 16;
/** Closer than this, two out-ports would read as one line: neighbours share a port instead, and part on their tracks. */
const MIN_PORT_SPACING = 8;
const PORT_INSET = 10;
/**
 * A line that moves sideways crosses its gap on a track of its own: down to it, a rounded turn,
 * across, a rounded turn, on. Tracks are this far apart, and the turns' radius less than that,
 * so two lines never run within a line's width of each other for more than a turn.
 */
const TRACK_SPACING = 8;
const CORNER = 6;
/** Room above the first track: the line leaves its layer straight. */
const TRACK_LEAD = 4;
/** Two spans closer than this share no track, so the turns at their ends never touch. */
const TRACK_CLEARANCE = 2 * CORNER + 2;
/** A cubic's control arm for a quarter circle, as a fraction of its radius. */
const KAPPA = 0.5523;
const MARGIN = 16;
const ORDER_SWEEPS = 8;
const TRANSPOSE_ROUNDS = 4;
const PLACE_ROUNDS = 24;
/** A lane pulls hard on the next lane (long edges run straight); an end less so. */
const LANE_PULL = 8;
const END_PULL = 2;

interface Vertex {
  /** The input node's key; undefined for a lane or a label. */
  key: string | undefined;
  label: boolean;
  /** The edge a lane or a label belongs to; -1 for a node. */
  edge: number;
  rank: number;
  across: number;
  along: number;
  /** Initial order within the layer. */
  initial: readonly [number, number, number];
  ups: number[];
  downs: number[];
}

interface Segment {
  upper: number;
  lower: number;
  edge: number;
  weight: number;
  /** Among the segments leaving a node, in try order; 0 of 1 elsewhere. */
  tryIndex: number;
  tryCount: number;
}

interface CanonicalEdge {
  input: FlowEdgeInput;
  from: number;
  to: number;
  weight: number;
  spine: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function round(value: number): number {
  const rounded = Math.round(value * 2) / 2;
  return rounded === 0 ? 0 : rounded;
}

// --- text ---------------------------------------------------------------------------------------

/** Characters about a third of an em wide in the builder's sans faces. */
const NARROW = "iljI|!.,:;'`\"()[]{} ";
/** Characters about four fifths of an em wide. */
const WIDE = "mwMW@%&…▲⊘→↓";

/**
 * About how wide `text` is at `px` in the builder's sans faces, from four width classes (narrow
 * 0.3em, capitals 0.65em, wide 0.8em, CJK and full-width 1em, everything else 0.55em). An
 * estimate: the map sizes its boxes by it, and the real-browser pass checks it.
 */
export function estimateTextWidth(text: string, px: number): number {
  let ems = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (NARROW.includes(character)) {
      ems += 0.3;
    } else if (WIDE.includes(character)) {
      ems += 0.8;
    } else if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300
    ) {
      ems += 1;
    } else if (character >= "A" && character <= "Z") {
      ems += 0.65;
    } else {
      ems += 0.55;
    }
  }
  return ems * px;
}

/** `text` cut to fit `maxWidth` with an ellipsis, or as it is when it fits. */
function ellipsize(text: string, maxWidth: number, px: number): string {
  if (estimateTextWidth(text, px) <= maxWidth) {
    return text;
  }
  const characters = [...text];
  while (characters.length > 0 && estimateTextWidth(`${characters.join("").trimEnd()}…`, px) > maxWidth) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}…`;
}

/** Breaks one word too wide for a line into pieces that fit. */
function breakWord(word: string, maxWidth: number, px: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const character of word) {
    if (current !== "" && estimateTextWidth(current + character, px) > maxWidth) {
      pieces.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current !== "") {
    pieces.push(current);
  }
  return pieces;
}

/**
 * `text` in at most `maxLines` lines of at most `maxWidth` at `px`, broken between words (a word
 * too long for a line is broken inside); the last line ends in "…" when the text does not fit.
 * Empty text gives no lines.
 */
export function wrapText(text: string, maxWidth: number, px: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0 || maxLines < 1) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (estimateTextWidth(candidate, px) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
      current = "";
    }
    if (estimateTextWidth(word, px) <= maxWidth) {
      current = word;
    } else {
      const pieces = breakWord(word, maxWidth, px);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  // The last line kept takes as much of the rest as fits, then the ellipsis.
  const kept = lines.slice(0, maxLines - 1);
  let last = ellipsize(lines.slice(maxLines - 1).join(" "), maxWidth, px);
  if (!last.endsWith("…")) {
    last = ellipsize(`${last}…`, maxWidth, px);
  }
  kept.push(last);
  return kept;
}

// --- ports --------------------------------------------------------------------------------------

/**
 * Points from `low` to `high`, in the order given, each as close to its ideal as it can be with
 * at least `spacing` between neighbours: isotonic regression by pool-adjacent-violators over
 * `ideal[i] - i * spacing`, then clamped (which is exact for bounds the same for every point).
 * The spacing shrinks when the side is too short for it.
 */
function spreadPorts(ideal: readonly number[], low: number, high: number, spacing: number): number[] {
  const count = ideal.length;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return [Math.min(high, Math.max(low, ideal[0] as number))];
  }
  const step = Math.min(spacing, Math.max(0, high - low) / (count - 1));
  const pools: Array<{ sum: number; size: number }> = [];
  ideal.forEach((value, index) => {
    pools.push({ sum: value - index * step, size: 1 });
    while (pools.length > 1) {
      const last = pools[pools.length - 1]!;
      const before = pools[pools.length - 2]!;
      if (before.sum / before.size <= last.sum / last.size) {
        break;
      }
      pools.pop();
      pools[pools.length - 1] = { sum: before.sum + last.sum, size: before.size + last.size };
    }
  });
  const top = Math.max(low, high - (count - 1) * step);
  const out: number[] = [];
  for (const pool of pools) {
    const value = Math.min(top, Math.max(low, pool.sum / pool.size));
    for (let index = 0; index < pool.size; index += 1) {
      out.push(value + out.length * step);
    }
  }
  return out;
}

/**
 * Ports for `ideal` (sorted) from `low` to `high`, spread as {@link spreadPorts} does while
 * {@link MIN_PORT_SPACING} fits between them; when it does not (a short side, as a card's is
 * drawn left to right), neighbours in order share a port, as evenly as can be, and part on their
 * tracks in the gap below.
 */
function portsWithin(ideal: readonly number[], low: number, high: number): number[] {
  const count = ideal.length;
  const slots = Math.min(count, Math.floor(Math.max(0, high - low) / MIN_PORT_SPACING) + 1);
  if (slots >= count) {
    return spreadPorts(ideal, low, high, PORT_SPACING);
  }
  const slotOf = (index: number): number => Math.floor((index * slots) / count);
  const sums: number[] = new Array<number>(slots).fill(0);
  const sizes: number[] = new Array<number>(slots).fill(0);
  ideal.forEach((value, index) => {
    sums[slotOf(index)]! += value;
    sizes[slotOf(index)]! += 1;
  });
  const placed = spreadPorts(
    sums.map((sum, slot) => sum / sizes[slot]!),
    low,
    high,
    PORT_SPACING
  );
  return ideal.map((_value, index) => placed[slotOf(index)]!);
}

/**
 * A box's out-ports, sorted as `ideal` is: the main line's (`spine`, or -1) at the centre, the
 * others on either side of it, each side's spacing shrinking to fit down to
 * {@link MIN_PORT_SPACING}, then sharing ports ({@link portsWithin}).
 */
function placePorts(ideal: readonly number[], spine: number, low: number, high: number, centre: number): number[] {
  if (spine < 0) {
    return portsWithin(ideal, low, high);
  }
  const before = ideal.slice(0, spine);
  const after = ideal.slice(spine + 1);
  /** How far a side's nearest port keeps from the centre: its spacing, at least the minimum, within the room. */
  const clear = (count: number, room: number): number =>
    Math.min(Math.max(0, room), Math.max(MIN_PORT_SPACING, Math.min(PORT_SPACING, Math.max(0, room) / count)));
  const stepBefore = before.length > 0 ? clear(before.length, centre - low) : 0;
  const stepAfter = after.length > 0 ? clear(after.length, high - centre) : 0;
  return [...portsWithin(before, low, centre - stepBefore), centre, ...portsWithin(after, centre + stepAfter, high)];
}

// --- a small binary heap of numbers, for a deterministic topological order ------------------

function heapPush(heap: number[], value: number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent]! <= value) {
      break;
    }
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: number[]): number {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      let smallestValue = last;
      if (left < heap.length && heap[left]! < smallestValue) {
        smallest = left;
        smallestValue = heap[left]!;
      }
      if (right < heap.length && heap[right]! < smallestValue) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }
      heap[index] = heap[smallest]!;
      index = smallest;
    }
    heap[index] = last;
  }
  return top;
}

// --- the layout ---------------------------------------------------------------------------------

/** Lays out `input`; see the module comment. */
export function layoutFlow(input: FlowLayoutInput): FlowLayout {
  const down = input.direction !== "right";
  const direction: FlowDirection = down ? "down" : "right";

  // Canonical input: nodes by (order, key), the first of a repeated key kept; edges by
  // (source position, order, key), forward between known nodes only.
  const nodes: FlowNodeInput[] = [];
  const position = new Map<string, number>();
  for (const node of [...input.nodes].sort((a, b) => finite(a.order, 0) - finite(b.order, 0) || compareText(a.key, b.key))) {
    if (!position.has(node.key)) {
      position.set(node.key, nodes.length);
      nodes.push(node);
    }
  }
  const edgeKeys = new Set<string>();
  const edges: CanonicalEdge[] = [];
  for (const edge of [...input.edges]
    .filter((edge) => {
      const from = position.get(edge.from);
      const to = position.get(edge.to);
      return from !== undefined && to !== undefined && from < to;
    })
    .sort(
      (a, b) =>
        (position.get(a.from) as number) - (position.get(b.from) as number) || finite(a.order, 0) - finite(b.order, 0) || compareText(a.key, b.key)
    )) {
    if (edgeKeys.has(edge.key)) {
      continue;
    }
    edgeKeys.add(edge.key);
    edges.push({
      input: edge,
      from: position.get(edge.from) as number,
      to: position.get(edge.to) as number,
      weight: Math.max(0.01, finite(edge.weight ?? 1, 1)),
      spine: edge.spine === true
    });
  }

  if (nodes.length === 0) {
    return { direction, width: MARGIN * 2, height: MARGIN * 2, crossings: 0, nodes: {}, edges: {} };
  }

  // 1. Ranks.
  const rankOf: number[] = new Array<number>(nodes.length).fill(0);
  const sourcesOf: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    sourcesOf[edge.to]!.push(edge.from);
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const sources = sourcesOf[index]!;
    if (sources.length > 0) {
      let rank = 0;
      for (const source of sources) {
        rank = Math.max(rank, rankOf[source]! + 2);
      }
      rankOf[index] = rank;
    } else {
      rankOf[index] = index === 0 ? 0 : rankOf[index - 1]! + 2;
    }
  }

  // 2. Vertices: the nodes, then each edge's lanes; segments between consecutive ones.
  const vertices: Vertex[] = nodes.map((node, index) => {
    const width = Math.max(0, finite(node.width, 0));
    const height = Math.max(0, finite(node.height, 0));
    return {
      key: node.key,
      label: false,
      edge: -1,
      rank: rankOf[index]!,
      across: down ? width : height,
      along: down ? height : width,
      initial: [index, 0, 0],
      ups: [],
      downs: []
    };
  });
  const segments: Segment[] = [];
  const chains: number[][] = [];
  /** An edge's first segment; the rest follow it, one per layer. */
  const segmentStart: number[] = [];
  edges.forEach((edge, edgeIndex) => {
    segmentStart.push(segments.length);
    const chain: number[] = [edge.from];
    const low = rankOf[edge.from]!;
    const high = rankOf[edge.to]!;
    for (let rank = low + 1; rank < high; rank += 1) {
      const isLabel = rank === low + 1 && edge.input.label !== undefined;
      const labelWidth = isLabel ? Math.max(0, finite(edge.input.label!.width, 0)) : 0;
      const labelHeight = isLabel ? Math.max(0, finite(edge.input.label!.height, 0)) : 0;
      chain.push(vertices.length);
      vertices.push({
        key: undefined,
        label: isLabel,
        edge: edgeIndex,
        rank,
        across: isLabel ? (down ? labelWidth : labelHeight) : LANE_ACROSS,
        along: isLabel ? (down ? labelHeight : labelWidth) : 0,
        initial: [edge.from, 1, edgeIndex],
        ups: [],
        downs: []
      });
    }
    chain.push(edge.to);
    for (let index = 0; index + 1 < chain.length; index += 1) {
      const upper = chain[index]!;
      const lower = chain[index + 1]!;
      const bothLanes = vertices[upper]!.key === undefined && vertices[lower]!.key === undefined;
      const id = segments.length;
      segments.push({ upper, lower, edge: edgeIndex, weight: (bothLanes ? LANE_PULL : END_PULL) * edge.weight, tryIndex: 0, tryCount: 1 });
      vertices[upper]!.downs.push(id);
      vertices[lower]!.ups.push(id);
    }
    chains.push(chain);
  });
  for (const vertex of vertices) {
    if (vertex.key !== undefined) {
      vertex.downs.forEach((segmentId, index) => {
        const segment = segments[segmentId]!;
        segment.tryIndex = index;
        segment.tryCount = vertex.downs.length;
      });
    }
  }

  // Nodes hold the highest rank: lanes lie strictly between their ends.
  const layerCount = rankOf.reduce((most, rank) => Math.max(most, rank), 0) + 1;
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  vertices.forEach((vertex, id) => layers[vertex.rank]!.push(id));
  const compareInitial = (a: number, b: number): number => {
    const x = vertices[a]!.initial;
    const y = vertices[b]!.initial;
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a - b;
  };
  for (const layer of layers) {
    layer.sort(compareInitial);
  }
  const pos: number[] = new Array<number>(vertices.length).fill(0);
  const renumber = (layer: readonly number[]): void => {
    layer.forEach((id, index) => {
      pos[id] = index;
    });
  };
  layers.forEach(renumber);

  // 3. Order within layers.
  const crossingsBelow = (rank: number): number => {
    const size = layers[rank + 1]?.length ?? 0;
    if (size === 0) {
      return 0;
    }
    // The layer is in order already; only a vertex's own ends need sorting, and they are few.
    const tree = new Array<number>(size + 1).fill(0);
    let seen = 0;
    let crossings = 0;
    const lowers: number[] = [];
    for (const id of layers[rank]!) {
      lowers.length = 0;
      for (const segmentId of vertices[id]!.downs) {
        lowers.push(pos[segments[segmentId]!.lower]!);
      }
      if (lowers.length > 1) {
        lowers.sort((a, b) => a - b);
      }
      for (const lower of lowers) {
        let atMost = 0;
        for (let index = lower + 1; index > 0; index -= index & -index) {
          atMost += tree[index]!;
        }
        crossings += seen - atMost;
        for (let index = lower + 1; index <= size; index += index & -index) {
          tree[index]! += 1;
        }
        seen += 1;
      }
    }
    return crossings;
  };
  const countCrossings = (): number => {
    let total = 0;
    for (let rank = 0; rank + 1 < layerCount; rank += 1) {
      total += crossingsBelow(rank);
    }
    return total;
  };

  /**
   * Sorts a layer by barycentre; a vertex with no neighbours that way keeps its slot. `nudged`:
   * a node's ways out keep their try order, each neighbour nudged by its rank among them.
   */
  const reorder = (rank: number, fromAbove: boolean, nudged: boolean): void => {
    const layer = layers[rank]!;
    const movable: Array<{ id: number; at: number; centre: number }> = [];
    const fixed = new Set<number>();
    layer.forEach((id, at) => {
      const vertex = vertices[id]!;
      const neighbours = fromAbove ? vertex.ups : vertex.downs;
      if (neighbours.length === 0) {
        fixed.add(at);
        return;
      }
      let sum = 0;
      for (const segmentId of neighbours) {
        const segment = segments[segmentId]!;
        if (fromAbove) {
          sum += pos[segment.upper]! + (nudged ? (segment.tryIndex - (segment.tryCount - 1) / 2) / (segment.tryCount + 1) : 0);
        } else {
          sum += pos[segment.lower]!;
        }
      }
      movable.push({ id, at, centre: sum / neighbours.length });
    });
    movable.sort((a, b) => a.centre - b.centre || a.at - b.at || compareInitial(a.id, b.id));
    const next: number[] = new Array<number>(layer.length);
    let taken = 0;
    for (let at = 0; at < layer.length; at += 1) {
      next[at] = fixed.has(at) ? layer[at]! : movable[taken++]!.id;
    }
    layers[rank] = next;
    renumber(next);
  };

  /** The crossings between the two vertices' own segments with `first` before `second`. */
  const pairCrossings = (first: number, second: number): number => {
    let crossings = 0;
    const a = vertices[first]!;
    const b = vertices[second]!;
    for (const x of a.ups) {
      const xPos = pos[segments[x]!.upper]!;
      for (const y of b.ups) {
        if (xPos > pos[segments[y]!.upper]!) {
          crossings += 1;
        }
      }
    }
    for (const x of a.downs) {
      const xPos = pos[segments[x]!.lower]!;
      for (const y of b.downs) {
        if (xPos > pos[segments[y]!.lower]!) {
          crossings += 1;
        }
      }
    }
    return crossings;
  };
  /** One pass of adjacent swaps, each kept only when it strictly lowers the pair's own crossings; whether any was. */
  const transpose = (): boolean => {
    let improved = false;
    for (const layer of layers) {
      for (let index = 0; index + 1 < layer.length; index += 1) {
        const first = layer[index]!;
        const second = layer[index + 1]!;
        if (pairCrossings(second, first) < pairCrossings(first, second)) {
          layer[index] = second;
          layer[index + 1] = first;
          pos[first] = index + 1;
          pos[second] = index;
          improved = true;
        }
      }
    }
    return improved;
  };

  const snapshot = (): number[][] => layers.map((layer) => [...layer]);
  const restore = (order: readonly number[][]): void => {
    order.forEach((layer, rank) => {
      layers[rank] = [...layer];
      renumber(layers[rank]!);
    });
  };
  const bySource = snapshot();
  // A second start: each lane just before its target rather than just after its source, which
  // finds the drawings where a jump runs beside the main line into a page on it.
  const byTarget = layers.map((layer) =>
    [...layer].sort((a, b) => {
      const key = (id: number): number => {
        const vertex = vertices[id]!;
        return vertex.key !== undefined ? vertex.initial[0] : edges[vertex.edge]!.to - 0.5;
      };
      return key(a) - key(b) || compareInitial(a, b);
    })
  );
  /** Alternating sweeps from `start`, each followed by swaps; then swaps on the best order found. */
  const orderLayers = (start: readonly number[][], nudged: boolean): { crossings: number; order: number[][] } => {
    restore(start);
    let fewest = countCrossings();
    let order = snapshot();
    for (let sweep = 0; sweep < ORDER_SWEEPS && fewest > 0; sweep += 1) {
      if (sweep % 2 === 0) {
        for (let rank = 1; rank < layerCount; rank += 1) {
          reorder(rank, true, nudged);
        }
      } else {
        for (let rank = layerCount - 2; rank >= 0; rank -= 1) {
          reorder(rank, false, nudged);
        }
      }
      transpose();
      const crossings = countCrossings();
      if (crossings < fewest) {
        fewest = crossings;
        order = snapshot();
      }
    }
    restore(order);
    for (let round = 0; round < TRANSPOSE_ROUNDS && fewest > 0 && transpose(); round += 1) {
      fewest = countCrossings();
    }
    return { crossings: countCrossings(), order: snapshot() };
  };
  // Try order across first: chips then read in the order their routes are tried. Plain
  // barycentres from either start get a say, and win only with strictly fewer crossings.
  let ordered = orderLayers(bySource, true);
  for (const start of [bySource, byTarget]) {
    if (ordered.crossings === 0) {
      break;
    }
    const plain = orderLayers(start, false);
    if (plain.crossings < ordered.crossings) {
      ordered = plain;
    }
  }
  restore(ordered.order);
  let best = ordered.crossings;
  // Ties the sweeps cannot break: two neighbours, a node among them, that cross as much either
  // way round, where the better order needs the layers around them to change too (an exit
  // page, its condition tried first, whose branch crosses nothing on the far side of the main
  // line). Each such pair is tried the other way round, the layers above and below re-sorted
  // from it, and kept only when the whole drawing then crosses strictly less.
  for (let rank = 0; rank < layerCount && best > 0; rank += 1) {
    for (let index = 0; index + 1 < layers[rank]!.length && best > 0; index += 1) {
      const first = layers[rank]![index]!;
      const second = layers[rank]![index + 1]!;
      const crossing = pairCrossings(first, second);
      if ((vertices[first]!.key === undefined && vertices[second]!.key === undefined) || crossing === 0 || pairCrossings(second, first) !== crossing) {
        continue;
      }
      const before = snapshot();
      layers[rank]![index] = second;
      layers[rank]![index + 1] = first;
      renumber(layers[rank]!);
      for (let above = rank - 1; above >= 0; above -= 1) {
        reorder(above, false, false);
      }
      for (let below = rank + 1; below < layerCount; below += 1) {
        reorder(below, true, false);
      }
      transpose();
      const crossings = countCrossings();
      if (crossings < best) {
        best = crossings;
      } else {
        restore(before);
      }
    }
  }
  // A branch that ends where it goes (an exit page a route leads to: one way in, none out) can
  // lie on either side of what it passes, but the sweeps keep it on the side its try order
  // starts it on. Each is tried at both ends of its layers — its chip's, its lanes', its own —
  // and kept where the whole drawing crosses strictly less.
  for (let id = 0; id < nodes.length && best > 0; id += 1) {
    const vertex = vertices[id]!;
    if (vertex.ups.length !== 1 || vertex.downs.length !== 0) {
      continue;
    }
    const branch = chains[segments[vertex.ups[0]!]!.edge]!.slice(1);
    for (const atStart of [true, false]) {
      const before = snapshot();
      for (const member of branch) {
        const rank = vertices[member]!.rank;
        const layer = layers[rank]!.filter((other) => other !== member);
        if (atStart) {
          layer.unshift(member);
        } else {
          layer.push(member);
        }
        layers[rank] = layer;
        renumber(layer);
      }
      const crossings = countCrossings();
      if (crossings < best) {
        best = crossings;
      } else {
        restore(before);
      }
    }
  }

  // 4. Alignment into blocks.
  const separation = (a: number, b: number): number => {
    const x = vertices[a]!;
    const y = vertices[b]!;
    const xNode = x.key !== undefined;
    const yNode = y.key !== undefined;
    const gap = xNode && yNode ? GAP_NODES : x.label || y.label ? GAP_LABEL : !xNode && !yNode ? GAP_LANES : GAP_NODE_LANE;
    return (x.across + y.across) / 2 + gap;
  };

  // The main line: from the first node, each node's first spine edge on. Its chains are aligned
  // before any other, so a branch's own way on that rejoins the main line (a side page's
  // fall-through into a page on it) cannot claim that page first and bend the main line there.
  const mainLine: number[] = [];
  const firstSpine = new Map<number, number>();
  edges.forEach((edge, index) => {
    if (edge.spine && !firstSpine.has(edge.from)) {
      firstSpine.set(edge.from, index);
    }
  });
  for (let at = firstSpine.get(0); at !== undefined; at = firstSpine.get(edges[at]!.to)) {
    mainLine.push(at);
  }

  const buildBlocks = (level: number): { blockOf: number[]; blocks: number[][] } => {
    const alignUp: number[] = new Array<number>(vertices.length).fill(-1);
    const alignDown: number[] = new Array<number>(vertices.length).fill(-1);
    const kept: Array<Array<[number, number]>> = layers.map(() => []);
    const align = (upper: number, lower: number): void => {
      if (alignDown[upper] !== -1 || alignUp[lower] !== -1) {
        return;
      }
      const a = pos[upper]!;
      const b = pos[lower]!;
      for (const [c, d] of kept[vertices[upper]!.rank]!) {
        if ((c < a && d > b) || (c > a && d < b)) {
          return;
        }
      }
      kept[vertices[upper]!.rank]!.push([a, b]);
      alignDown[upper] = lower;
      alignUp[lower] = upper;
    };
    if (level < 2) {
      const alignChain = (index: number): void => {
        const chain = chains[index]!;
        for (let at = 0; at + 1 < chain.length; at += 1) {
          align(chain[at]!, chain[at + 1]!);
        }
      };
      mainLine.forEach(alignChain);
      edges.forEach((edge, index) => {
        if (edge.spine) {
          alignChain(index);
        }
      });
    }
    if (level < 1) {
      const others = chains.filter((_chain, index) => !edges[index]!.spine);
      for (const chain of others) {
        for (let at = 1; at + 2 < chain.length; at += 1) {
          align(chain[at]!, chain[at + 1]!);
        }
      }
      for (const chain of others) {
        align(chain[chain.length - 2]!, chain[chain.length - 1]!);
      }
      for (const chain of others) {
        align(chain[0]!, chain[1]!);
      }
    }
    const blockOf: number[] = new Array<number>(vertices.length).fill(-1);
    const blocks: number[][] = [];
    for (const layer of layers) {
      for (const id of layer) {
        if (alignUp[id] !== -1) {
          continue;
        }
        const members: number[] = [];
        for (let member = id; member !== -1; member = alignDown[member]!) {
          blockOf[member] = blocks.length;
          members.push(member);
        }
        blocks.push(members);
      }
    }
    return { blockOf, blocks };
  };

  // 5. Cross coordinates: the blocks packed, then eased toward their neighbours.
  let blockOf: number[] = [];
  let blocks: number[][] = [];
  let order: number[] = [];
  let predecessors: Array<Map<number, number>> = [];
  let successors: Array<Map<number, number>> = [];
  for (let level = 0; level <= 2; level += 1) {
    ({ blockOf, blocks } = buildBlocks(level));
    predecessors = blocks.map(() => new Map<number, number>());
    successors = blocks.map(() => new Map<number, number>());
    for (const layer of layers) {
      for (let index = 0; index + 1 < layer.length; index += 1) {
        const a = layer[index]!;
        const b = layer[index + 1]!;
        const from = blockOf[a]!;
        const to = blockOf[b]!;
        const distance = separation(a, b);
        if (distance > (successors[from]!.get(to) ?? -Infinity)) {
          successors[from]!.set(to, distance);
          predecessors[to]!.set(from, distance);
        }
      }
    }
    const waiting = predecessors.map((map) => map.size);
    const heap: number[] = [];
    waiting.forEach((count, block) => {
      if (count === 0) {
        heapPush(heap, block);
      }
    });
    order = [];
    while (heap.length > 0) {
      const block = heapPop(heap);
      order.push(block);
      for (const next of successors[block]!.keys()) {
        waiting[next]! -= 1;
        if (waiting[next] === 0) {
          heapPush(heap, next);
        }
      }
    }
    // A cycle among the blocks would mean two chains cross; fewer chains cannot.
    if (order.length === blocks.length) {
      break;
    }
  }

  const coordinate: number[] = new Array<number>(blocks.length).fill(0);
  for (const block of order) {
    let at = 0;
    for (const [before, distance] of predecessors[block]!) {
      at = Math.max(at, coordinate[before]! + distance);
    }
    coordinate[block] = at;
  }
  const pulls: Array<Array<[number, number]>> = blocks.map((members, block) => {
    const out: Array<[number, number]> = [];
    for (const member of members) {
      const vertex = vertices[member]!;
      for (const segmentId of [...vertex.ups, ...vertex.downs]) {
        const segment = segments[segmentId]!;
        const other = segment.upper === member ? segment.lower : segment.upper;
        if (blockOf[other] !== block) {
          out.push([blockOf[other]!, segment.weight]);
        }
      }
    }
    return out;
  });
  /** Where a block may go: the room its neighbours on every layer leave it. */
  const roomOf = (block: number): [number, number] => {
    let low = -Infinity;
    let high = Infinity;
    for (const [before, distance] of predecessors[block]!) {
      low = Math.max(low, coordinate[before]! + distance);
    }
    for (const [after, distance] of successors[block]!) {
      high = Math.min(high, coordinate[after]! - distance);
    }
    return [low, high];
  };
  const reversed = [...order].reverse();
  for (let round = 0; round < PLACE_ROUNDS; round += 1) {
    for (const block of round % 2 === 0 ? order : reversed) {
      const pull = pulls[block]!;
      if (pull.length === 0) {
        continue;
      }
      let sum = 0;
      let weight = 0;
      for (const [other, w] of pull) {
        sum += coordinate[other]! * w;
        weight += w;
      }
      const [low, high] = roomOf(block);
      coordinate[block] = Math.min(high, Math.max(low, sum / weight));
    }
  }
  // A node nothing leads to (a page after an exit, which no path reaches) has nothing pulling it
  // sideways, so it would sit in the column of the node just above it and read as that node's
  // way on. It is moved clear of that column, to the nearer side with room for it.
  for (let id = 1; id < nodes.length; id += 1) {
    const vertex = vertices[id]!;
    const block = blockOf[id]!;
    if (vertex.ups.length > 0 || blocks[block]![0] !== id) {
      continue;
    }
    let previousRank = -1;
    for (let other = 0; other < nodes.length; other += 1) {
      if (vertices[other]!.rank < vertex.rank) {
        previousRank = Math.max(previousRank, vertices[other]!.rank);
      }
    }
    const at = coordinate[block]!;
    const above = layers[previousRank]?.find(
      (other) => vertices[other]!.key !== undefined && Math.abs(coordinate[blockOf[other]!]! - at) < (vertices[other]!.across + vertex.across) / 2 + GAP_NODES
    );
    if (above === undefined) {
      continue;
    }
    const centre = coordinate[blockOf[above]!]!;
    const clear = (vertices[above]!.across + vertex.across) / 2 + GAP_NODES;
    const [low, high] = roomOf(block);
    for (const side of at >= centre ? [1, -1] : [-1, 1]) {
      const to = centre + side * clear;
      if (to >= low && to <= high) {
        coordinate[block] = to;
        break;
      }
    }
  }
  const across: number[] = vertices.map((_vertex, id) => coordinate[blockOf[id]!]!);
  let leftmost = Infinity;
  vertices.forEach((vertex, id) => {
    leftmost = Math.min(leftmost, across[id]! - vertex.across / 2);
  });
  for (let id = 0; id < across.length; id += 1) {
    across[id] = across[id]! - leftmost + MARGIN;
  }

  // Ports: where each segment leaves a node, across.
  const ports = new Map<number, number>();
  vertices.forEach((vertex, id) => {
    if (vertex.key === undefined || vertex.downs.length === 0) {
      return;
    }
    const centre = across[id]!;
    const sorted = [...vertex.downs].sort(
      (a, b) => across[segments[a]!.lower]! - across[segments[b]!.lower]! || segments[a]!.tryIndex - segments[b]!.tryIndex
    );
    const inset = Math.min(PORT_INSET, vertex.across / 2);
    const spread = placePorts(
      sorted.map((segmentId) => across[segments[segmentId]!.lower]!),
      sorted.findIndex((segmentId) => edges[segments[segmentId]!.edge]!.spine),
      centre - vertex.across / 2 + inset,
      centre + vertex.across / 2 - inset,
      centre
    );
    sorted.forEach((segmentId, index) => ports.set(segmentId, spread[index]!));
  });
  const leaveAt = (segmentId: number): number => {
    const segment = segments[segmentId]!;
    return ports.get(segmentId) ?? across[segment.upper]!;
  };

  // 6. Tracks: in each gap, every line that moves sideways crosses on a track of its own, so a fan
  // out of a page or lines rejoining one never run together, and no line crosses another its
  // order does not cross. Of two moving the same way whose spans overlap, the one further along
  // that way turns first (the upper track): its run then passes over the other's turn down, and
  // a line rejoining a target meets the trunk of those that turned before it. Two moving
  // opposite ways cross (or meet) at most once, on tracks apart, unless they only meet at a
  // shared end — two lines into one target from either side. Lines whose spans are apart share
  // a track.
  const trackOf = new Map<number, number>();
  const tracksIn: number[] = [];
  for (let rank = 0; rank + 1 < layerCount; rank += 1) {
    const moving: Array<{ id: number; from: number; to: number; low: number; high: number; rightward: boolean }> = [];
    for (const id of layers[rank]!) {
      for (const segmentId of vertices[id]!.downs) {
        const from = leaveAt(segmentId);
        const to = across[segments[segmentId]!.lower]!;
        if (Math.abs(to - from) >= 0.01) {
          moving.push({ id: segmentId, from, to, low: Math.min(from, to), high: Math.max(from, to), rightward: to > from });
        }
      }
    }
    moving.sort(
      (x, y) =>
        Number(y.rightward) - Number(x.rightward) ||
        (x.rightward ? y.from - x.from || y.to - x.to : x.from - y.from || x.to - y.to) ||
        x.id - y.id
    );
    const clash = (x: (typeof moving)[number], y: (typeof moving)[number]): boolean => {
      if (x.rightward !== y.rightward && (x.to === y.to || x.from === y.from) && Math.min(x.high, y.high) <= Math.max(x.low, y.low)) {
        return false;
      }
      return x.low < y.high + TRACK_CLEARANCE && y.low < x.high + TRACK_CLEARANCE;
    };
    let count = 0;
    moving.forEach((line, at) => {
      let track = 0;
      for (let other = 0; other < at; other += 1) {
        if (clash(line, moving[other]!)) {
          track = Math.max(track, trackOf.get(moving[other]!.id)! + 1);
        }
      }
      trackOf.set(line.id, track);
      count = Math.max(count, track + 1);
    });
    tracksIn.push(count);
  }

  // Flow coordinates: each gap as tall as its tracks need, more when its lines move far.
  const thickness: number[] = layers.map((layer) => layer.reduce((most, id) => Math.max(most, vertices[id]!.along), 0));
  const gaps: number[] = [];
  for (let rank = 0; rank + 1 < layerCount; rank += 1) {
    let widest = 0;
    for (const id of layers[rank]!) {
      for (const segmentId of vertices[id]!.downs) {
        widest = Math.max(widest, Math.abs(across[segments[segmentId]!.lower]! - leaveAt(segmentId)));
      }
    }
    const tracks = tracksIn[rank]!;
    const trackRoom = tracks > 0 ? TRACK_LEAD + 2 * CORNER + (tracks - 1) * TRACK_SPACING + ARROW_LENGTH : 0;
    gaps.push(Math.max(trackRoom, Math.min(MAX_LAYER_GAP, Math.max(MIN_LAYER_GAP, ARROW_LENGTH + 8 + widest / 3))));
  }
  const along: number[] = [];
  layers.forEach((_layer, rank) => {
    along.push(rank === 0 ? MARGIN + thickness[0]! / 2 : along[rank - 1]! + thickness[rank - 1]! / 2 + gaps[rank - 1]! + thickness[rank]! / 2);
  });
  const bandTop = (rank: number): number => along[rank]! - thickness[rank]! / 2;
  const bandBottom = (rank: number): number => along[rank]! + thickness[rank]! / 2;
  /** Where a track in the gap below `rank` runs: the gap's tracks centred in it, clear of an arrowhead. */
  const trackAlong = (rank: number, track: number): number => {
    const low = bandBottom(rank) + TRACK_LEAD + CORNER;
    const high = bandTop(rank + 1) - ARROW_LENGTH - CORNER;
    const span = (tracksIn[rank]! - 1) * TRACK_SPACING;
    return Math.max(low, (low + high - span) / 2) + track * TRACK_SPACING;
  };

  // 7. Routing, then the axis swap.
  const point = (a: number, f: number): FlowPoint => (down ? { x: round(a), y: round(f) } : { x: round(f), y: round(a) });
  const text = (a: number, f: number): string => {
    const p = point(a, f);
    return `${p.x} ${p.y}`;
  };
  /** A path command in (x, y), rounded: its op and its points' coordinates, end point last. */
  const command = (op: PathOp, ...pairs: Array<[number, number]>): PathCommand => ({
    op,
    points: pairs.flatMap(([a, f]) => {
      const p = point(a, f);
      return [p.x, p.y];
    })
  });

  let extentAcross = 0;
  vertices.forEach((vertex, id) => {
    extentAcross = Math.max(extentAcross, across[id]! + vertex.across / 2);
  });
  const extentAlong = bandBottom(layerCount - 1);

  const outNodes: Array<[string, FlowNodeLayout]> = nodes.map((node, index) => {
    const vertex = vertices[index]!;
    const centre = point(across[index]!, along[vertex.rank]!);
    const width = Math.max(0, finite(node.width, 0));
    const height = Math.max(0, finite(node.height, 0));
    return [node.key, { x: round(centre.x - width / 2), y: round(centre.y - height / 2), width, height, rank: vertex.rank }];
  });

  const outEdges: Array<[string, FlowEdgeLayout]> = edges.map((edge, edgeIndex) => {
    const chain = chains[edgeIndex]!;
    const source = vertices[chain[0]!]!;
    const sourceAlong = along[source.rank]!;
    const commands: PathCommand[] = [];
    let a = ports.get(segmentStart[edgeIndex]!) ?? across[chain[0]!]!;
    let f = sourceAlong + source.along / 2;
    const start: FlowPoint = point(a, f);
    commands.push(command("M", [a, f]));
    const bottom = bandBottom(source.rank);
    if (bottom > f) {
      f = bottom;
      commands.push(command("L", [a, f]));
    }
    const via: FlowPoint[] = [];
    let label: FlowBox | undefined;
    let end: FlowPoint = start;
    /** Across the gap to `toAcross`: straight, or on the segment's track with a rounded turn at each end. */
    const bend = (index: number, toAcross: number, toAlong: number): void => {
      const segmentId = segmentStart[edgeIndex]! + index - 1;
      const track = trackOf.get(segmentId);
      if (track === undefined || Math.abs(toAcross - a) < 0.01) {
        commands.push(command("L", [toAcross, toAlong]));
      } else {
        const y = trackAlong(vertices[segments[segmentId]!.upper]!.rank, track);
        const sign = toAcross > a ? 1 : -1;
        const r = Math.min(CORNER, Math.abs(toAcross - a) / 2);
        const arm = r * KAPPA;
        commands.push(command("L", [a, y - r]));
        commands.push(command("C", [a, y - r + arm], [a + sign * (r - arm), y], [a + sign * r, y]));
        commands.push(command("L", [toAcross - sign * r, y]));
        commands.push(command("C", [toAcross - sign * (r - arm), y], [toAcross, y + r - arm], [toAcross, y + r]));
        commands.push(command("L", [toAcross, toAlong]));
      }
      a = toAcross;
      f = toAlong;
    };
    for (let index = 1; index < chain.length; index += 1) {
      const id = chain[index]!;
      const vertex = vertices[id]!;
      const top = bandTop(vertex.rank);
      if (index === chain.length - 1) {
        const tip = along[vertex.rank]! - vertex.along / 2;
        const base = tip - ARROW_LENGTH;
        bend(index, across[id]!, Math.min(top, base));
        if (f < base) {
          commands.push(command("L", [a, base]));
          f = base;
        }
        end = point(a, tip);
        break;
      }
      bend(index, across[id]!, top);
      via.push(point(across[id]!, along[vertex.rank]!));
      if (vertex.label) {
        const centre = point(across[id]!, along[vertex.rank]!);
        const width = down ? vertex.across : vertex.along;
        const height = down ? vertex.along : vertex.across;
        label = { x: round(centre.x - width / 2), y: round(centre.y - height / 2), width, height };
      }
      const below = bandBottom(vertex.rank);
      if (below > f) {
        commands.push(command("L", [a, below]));
        f = below;
      }
    }
    const tipAlong = f + ARROW_LENGTH;
    const head = `M${text(a - ARROW_HALF, f)} L${text(a, tipAlong)} L${text(a + ARROW_HALF, f)} Z`;
    const layout: FlowEdgeLayout = { d: compactPath(commands), head, start, end, via };
    if (label) {
      layout.label = label;
    }
    return [edge.input.key, layout];
  });

  const width = round(down ? extentAcross + MARGIN : extentAlong + MARGIN);
  const height = round(down ? extentAlong + MARGIN : extentAcross + MARGIN);
  return {
    direction,
    width,
    height,
    crossings: best,
    nodes: Object.fromEntries(outNodes),
    edges: Object.fromEntries(outEdges)
  };
}

type PathOp = "M" | "L" | "C";

interface PathCommand {
  op: PathOp;
  points: number[];
}

/** The path's `d`: a line to where the pen already is dropped, and straight runs merged. */
function compactPath(commands: readonly PathCommand[]): string {
  const out: PathCommand[] = [];
  const endOf = (entry: PathCommand): [number, number] => [entry.points[entry.points.length - 2]!, entry.points[entry.points.length - 1]!];
  for (const entry of commands) {
    const previous = out[out.length - 1];
    if (entry.op === "L" && previous !== undefined) {
      const [x1, y1] = endOf(previous);
      const [x2, y2] = endOf(entry);
      if (x1 === x2 && y1 === y2) {
        continue;
      }
      const before = out[out.length - 2];
      if (previous.op === "L" && before !== undefined) {
        const [x0, y0] = endOf(before);
        if ((x0 === x1 && x1 === x2) || (y0 === y1 && y1 === y2)) {
          out[out.length - 1] = entry;
          continue;
        }
      }
    }
    out.push(entry);
  }
  return out.map((entry) => `${entry.op}${entry.points.join(" ")}`).join(" ");
}
