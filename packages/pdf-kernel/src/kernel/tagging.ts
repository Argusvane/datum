/**
 * Tagged PDF: the structure tree a reader navigates, built beside the page
 * content. Every block becomes a structure element with its role (H1, P, Table, Figure,
 * Form…), parented as the document nests it; a table gets TR and TD/TH elements around its
 * cells; every drawn piece of content is a marked-content sequence with an MCID under its
 * element; decorations and running regions are artifacts; widgets hang off `Form` elements
 * through OBJR references. Reading order is the drawing order, which is the flow order.
 *
 * Best-effort structure for assistive technology, not a conformance claim: no PDF/UA
 * validator runs here. Under PDF/A level "a" the tree is what the claim rests on;
 * `ExistingTagging` extends a template's own tree with what a fill adds.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  type PDFObject,
  type PDFPage
} from "@cantoo/pdf-lib";
import type { PdfBlock, PdfDocument, PdfListBlock, PdfTableBlock } from "@argusvane/datum-engine/render";

interface StructInfo {
  role: string;
  parent: string | undefined;
  alt: string | undefined;
  artifact: boolean;
}

const DOCUMENT_ELEMENT = "\u0000document";

function defaultRole(block: PdfBlock): string | undefined {
  switch (block.kind) {
    case "heading":
      return `H${block.level}`;
    case "paragraph":
    case "labelValue":
    case "checkmark":
    case "checklist":
      return "P";
    case "widget":
      return "Form";
    case "list":
      return "L";
    case "table":
      return "Table";
    case "image":
      return "Figure";
    case "box":
      return "Div";
    case "group":
      return "Div";
    default:
      return undefined;
  }
}

function collect(blocks: readonly PdfBlock[], parent: string, artifact: boolean, into: Map<string, StructInfo>): void {
  for (const block of blocks) {
    const role = block.role ?? defaultRole(block);
    const isArtifact = artifact || block.artifact === true || role === undefined;
    into.set(block.id, { role: role ?? "Artifact", parent, alt: block.alt, artifact: isArtifact });
    if (block.kind === "group" || block.kind === "box") {
      if (block.kind === "box" && block.header) {
        collect(block.header.blocks, block.id, isArtifact, into);
      }
      collect(block.blocks, block.id, isArtifact, into);
    } else if (block.kind === "list") {
      collectList(block, isArtifact, into);
    } else if (block.kind === "table" && block.artifact === true && !artifact) {
      collectLayoutTable(block, parent, into);
    } else if (block.kind === "table") {
      collectTable(block, isArtifact, into);
    }
  }
}

/**
 * A table marked an artifact in content (the grid rendition's columns): the table is layout,
 * so it and its rows and cells tag nothing, and what its cells hold is content under the
 * table's own parent, in reading order.
 */
function collectLayoutTable(table: PdfTableBlock, parent: string, into: Map<string, StructInfo>): void {
  const rows = table.header ? [table.header, ...table.rows] : table.rows;
  rows.forEach((row, rowIndex) => {
    const rowId = `${table.id}\u0000r${rowIndex}`;
    into.set(rowId, { role: "Artifact", parent, alt: undefined, artifact: true });
    row.cells.forEach((cell, cellIndex) => {
      into.set(`${rowId}c${cellIndex}`, { role: "Artifact", parent, alt: undefined, artifact: true });
      collect(cell.blocks, parent, false, into);
    });
  });
}

/** The element ids the layout marks a list's parts with: the item, its label (the bullet) and its body. */
export function listItemIds(listId: string, index: number): { item: string; label: string; body: string } {
  const item = `${listId} i${index}`;
  return { item, label: `${item} lbl`, body: `${item} body` };
}

function collectList(list: PdfListBlock, artifact: boolean, into: Map<string, StructInfo>): void {
  list.items.forEach((entry, index) => {
    const ids = listItemIds(list.id, index);
    into.set(ids.item, { role: "LI", parent: list.id, alt: undefined, artifact });
    into.set(ids.label, { role: "Lbl", parent: ids.item, alt: undefined, artifact });
    into.set(ids.body, { role: "LBody", parent: ids.item, alt: undefined, artifact });
    if (entry.blocks) {
      collect(entry.blocks, ids.body, artifact, into);
    }
  });
}

function collectTable(table: PdfTableBlock, artifact: boolean, into: Map<string, StructInfo>): void {
  const rows = table.header ? [{ row: table.header, header: true }, ...table.rows.map((row) => ({ row, header: false }))] : table.rows.map((row) => ({ row, header: false }));
  rows.forEach(({ row, header }, rowIndex) => {
    const rowId = `${table.id}\u0000r${rowIndex}`;
    into.set(rowId, { role: "TR", parent: table.id, alt: undefined, artifact });
    row.cells.forEach((cell, cellIndex) => {
      const cellId = `${rowId}c${cellIndex}`;
      into.set(cellId, { role: header || cell.header ? "TH" : "TD", parent: rowId, alt: undefined, artifact });
      collect(cell.blocks, cellId, artifact, into);
    });
  });
}

/** The structure every block of a document belongs to, keyed by block id. */
export function structureOf(document: PdfDocument): Map<string, StructInfo> {
  const info = new Map<string, StructInfo>();
  collect(document.blocks, DOCUMENT_ELEMENT, false, info);
  for (const entry of document.anchored) {
    collect([entry.box], DOCUMENT_ELEMENT, false, info);
  }
  collect(document.header ?? [], DOCUMENT_ELEMENT, true, info);
  collect(document.footer ?? [], DOCUMENT_ELEMENT, true, info);
  return info;
}

const WIDGET_KEY_BASE = 100_000;

export class Tagging {
  private readonly info: Map<string, StructInfo>;
  private readonly elements = new Map<string, PDFRef>();
  private readonly kids = new Map<string, PDFArray>();
  private readonly documentRef: PDFRef;
  private readonly documentKids: PDFArray;
  private readonly pageParents: PDFRef[][] = [];
  private readonly widgetParents: Array<[number, PDFRef]> = [];
  private pageIndex = -1;
  private mcid = 0;
  private open: { element: string | undefined; artifact: boolean } | undefined;

  constructor(
    private readonly pdf: PDFDocument,
    document: PdfDocument
  ) {
    this.info = structureOf(document);
    const context = pdf.context;
    this.documentKids = context.obj([]);
    this.documentRef = context.register(context.obj({ Type: "StructElem", S: "Document", K: this.documentKids }));
  }

  public beginPage(page: PDFPage, index: number): void {
    this.closeContent(page);
    this.pageIndex = index;
    this.mcid = 0;
    this.pageParents[index] = [];
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
  }

  /** The element a block draws into, created (with its parents) on first use. */
  private elementFor(blockId: string): PDFRef {
    const existing = this.elements.get(blockId);
    if (existing) {
      return existing;
    }
    const info = this.info.get(blockId);
    const parentRef = info?.parent && info.parent !== DOCUMENT_ELEMENT ? this.elementFor(info.parent) : this.documentRef;
    const parentKids = info?.parent && info.parent !== DOCUMENT_ELEMENT ? this.kids.get(info.parent)! : this.documentKids;
    const context = this.pdf.context;
    const kids = context.obj([]);
    const dict = context.obj({
      Type: "StructElem",
      S: info?.role ?? "Div",
      P: parentRef,
      K: kids,
      ...(info?.alt ? { Alt: PDFHexString.fromText(info.alt) } : {})
    });
    const ref = context.register(dict);
    parentKids.push(ref);
    this.elements.set(blockId, ref);
    this.kids.set(blockId, kids);
    return ref;
  }

  private isArtifact(blockId: string | undefined): boolean {
    if (blockId === undefined) {
      return true;
    }
    return this.info.get(blockId)?.artifact ?? true;
  }

  /**
   * Opens the marked-content sequence a drawable belongs to, closing the previous one when it
   * differs: content pieces of one block share a sequence, artifacts share an `/Artifact` one.
   */
  public markFor(page: PDFPage, blockId: string | undefined, artifact: boolean): void {
    const asArtifact = artifact || this.isArtifact(blockId);
    const element = asArtifact ? undefined : blockId;
    if (this.open && this.open.artifact === asArtifact && this.open.element === element) {
      return;
    }
    this.closeContent(page);
    if (asArtifact) {
      page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContent, [PDFName.of("Artifact")]));
    } else {
      const ref = this.elementFor(blockId!);
      const role = this.info.get(blockId!)?.role ?? "Div";
      const mcid = this.mcid;
      this.mcid += 1;
      // `BDC` takes an inline property dictionary; pdf-lib's operand typing omits dictionaries,
      // but it serializes one as `<< /MCID n >>`, which is exactly the syntax the operator wants.
      const properties = this.pdf.context.obj({ MCID: mcid }) as unknown as PDFName;
      page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(role), properties]));
      this.pageParents[this.pageIndex]![mcid] = ref;
      this.kids.get(blockId!)!.push(this.pdf.context.obj({ Type: "MCR", Pg: page.ref, MCID: mcid }));
    }
    this.open = { element, artifact: asArtifact };
  }

  public closeContent(page: PDFPage): void {
    if (!this.open) {
      return;
    }
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
    this.open = undefined;
  }

  /** Hangs a widget annotation off its block's `Form` element. */
  public attachWidget(page: PDFPage, blockId: string | undefined, widgetDict: PDFDict, widgetRef: PDFRef): void {
    if (blockId === undefined || this.isArtifact(blockId)) {
      return;
    }
    const ref = this.elementFor(blockId);
    const key = WIDGET_KEY_BASE + this.widgetParents.length;
    widgetDict.set(PDFName.of("StructParent"), PDFNumber.of(key));
    this.kids.get(blockId)!.push(this.pdf.context.obj({ Type: "OBJR", Obj: widgetRef, Pg: page.ref }));
    this.widgetParents.push([key, ref]);
  }

  /** Writes the structure tree root and marks the document as tagged. */
  public finish(): void {
    const context = this.pdf.context;
    const nums: Array<number | PDFRef | PDFArray> = [];
    this.pageParents.forEach((parents, index) => {
      const array = context.obj([]);
      for (let i = 0; i < parents.length; i += 1) {
        array.push(parents[i] ?? PDFName.of("null"));
      }
      nums.push(index, context.register(array));
    });
    for (const [key, ref] of this.widgetParents) {
      nums.push(key, ref);
    }
    const parentTree = context.obj({ Nums: context.obj(nums.map((entry) => (typeof entry === "number" ? PDFNumber.of(entry) : entry))) });
    const nextKey = WIDGET_KEY_BASE + this.widgetParents.length;
    const root = context.obj({
      Type: "StructTreeRoot",
      K: context.obj([this.documentRef]),
      ParentTree: context.register(parentTree),
      ParentTreeNextKey: PDFNumber.of(nextKey)
    });
    this.pdf.catalog.set(PDFName.of("StructTreeRoot"), context.register(root));
    this.pdf.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  }
}

/** A page's entry in the parent tree: the array its MCIDs index, under its `StructParents` key. */
interface PageParents {
  key: number;
  array: PDFArray;
}

/**
 * Tagging into a structure tree a document already has — a fill of a tagged template under
 * PDF/A level "a", where what the kernel adds must be part of the tree for the
 * claim to hold. Each drawn area becomes a `P` element under the document element (the first
 * kid of the structure tree root), its marked content given the next MCID of the page's
 * parent-tree array; each fillable area's widget becomes a `Form` element reached through an
 * `OBJR`, with a fresh `StructParent` key. `extendable` is false for a tree this cannot be
 * done to — none at all, or a parent tree with `Kids`, which this kernel does not rebalance —
 * and then nothing was touched.
 */
export class ExistingTagging {
  public readonly extendable: boolean;
  private readonly root: PDFDict | undefined;
  private readonly documentRef: PDFRef | undefined;
  private readonly documentKids: PDFArray | undefined;
  private readonly nums: PDFArray | undefined;
  private readonly pages = new Map<string, PageParents>();
  private nextKey = 0;
  private open: PDFPage | undefined;

  constructor(private readonly pdf: PDFDocument) {
    const context = pdf.context;
    const rootRef = pdf.catalog.get(PDFName.of("StructTreeRoot"));
    const root = pdf.catalog.lookupMaybe(PDFName.of("StructTreeRoot"), PDFDict);
    const parentTree = root?.lookupMaybe(PDFName.of("ParentTree"), PDFDict);
    if (!root || !(rootRef instanceof PDFRef) || parentTree?.has(PDFName.of("Kids"))) {
      this.extendable = false;
      return;
    }
    this.extendable = true;
    this.root = root;
    // The document element: the root's first kid, made when the root has none.
    const kids = root.get(PDFName.of("K"));
    let documentRef = kids instanceof PDFRef ? kids : kids instanceof PDFArray ? kids.asArray().find((kid): kid is PDFRef => kid instanceof PDFRef) : undefined;
    if (!documentRef) {
      documentRef = context.register(context.obj({ Type: "StructElem", S: "Document", P: rootRef, K: context.obj([]) }));
      root.set(PDFName.of("K"), context.obj([documentRef]));
    }
    this.documentRef = documentRef;
    const element = context.lookup(documentRef, PDFDict);
    const existingKids = element.get(PDFName.of("K"));
    let documentKids = element.lookupMaybe(PDFName.of("K"), PDFArray);
    if (!documentKids) {
      // One kid (a ref, a dictionary, or a bare MCID) becomes a list of one, which means the same.
      documentKids = context.obj(existingKids ? [existingKids] : []);
      element.set(PDFName.of("K"), documentKids);
    }
    this.documentKids = documentKids;
    let tree = parentTree;
    if (!tree) {
      tree = context.obj({});
      root.set(PDFName.of("ParentTree"), context.register(tree));
    }
    let nums = tree.lookupMaybe(PDFName.of("Nums"), PDFArray);
    if (!nums) {
      nums = context.obj([]);
      tree.set(PDFName.of("Nums"), nums);
    }
    this.nums = nums;
    let maxKey = -1;
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const key = nums.get(i);
      if (key instanceof PDFNumber) {
        maxKey = Math.max(maxKey, key.asNumber());
      }
    }
    const declared = root.lookupMaybe(PDFName.of("ParentTreeNextKey"), PDFNumber)?.asNumber() ?? 0;
    this.nextKey = Math.max(declared, maxKey + 1);
  }

  /** The parent-tree entry a key maps to, and where it sits. */
  private numsEntry(key: number): { index: number; value: PDFObject | undefined } | undefined {
    const nums = this.nums!;
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const at = nums.get(i);
      if (at instanceof PDFNumber && at.asNumber() === key) {
        return { index: i, value: nums.get(i + 1) };
      }
    }
    return undefined;
  }

  /** Adds `[key, value]` to the parent tree where key order puts it. */
  private insertNums(key: number, value: PDFObject): void {
    const nums = this.nums!;
    let at = nums.size();
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const existing = nums.get(i);
      if (existing instanceof PDFNumber && existing.asNumber() > key) {
        at = i;
        break;
      }
    }
    nums.insert(at, value);
    nums.insert(at, PDFNumber.of(key));
  }

  /** The page's parent-tree array, found through its `StructParents` or made under a new key. */
  private parentsOf(page: PDFPage): PageParents {
    const known = this.pages.get(page.ref.toString());
    if (known) {
      return known;
    }
    const context = this.pdf.context;
    const declared = page.node.lookupMaybe(PDFName.of("StructParents"), PDFNumber)?.asNumber();
    let parents: PageParents | undefined;
    if (declared !== undefined) {
      const entry = this.numsEntry(declared);
      const array = entry?.value instanceof PDFRef ? context.lookupMaybe(entry.value, PDFArray) : entry?.value instanceof PDFArray ? entry.value : undefined;
      if (array) {
        parents = { key: declared, array };
      } else if (entry) {
        // A key the page names that maps to something that is not a page's array: replaced by one.
        const fresh = context.obj([]);
        this.nums!.set(entry.index + 1, context.register(fresh));
        parents = { key: declared, array: fresh };
      } else {
        const fresh = context.obj([]);
        this.insertNums(declared, context.register(fresh));
        parents = { key: declared, array: fresh };
      }
    } else {
      const key = this.nextKey;
      this.nextKey += 1;
      const fresh = context.obj([]);
      this.insertNums(key, context.register(fresh));
      page.node.set(PDFName.of("StructParents"), PDFNumber.of(key));
      parents = { key, array: fresh };
    }
    this.pages.set(page.ref.toString(), parents);
    return parents;
  }

  /** A new element under the document element, with the given kids. */
  private addElement(role: string, page: PDFPage, kids: PDFObject[]): PDFRef {
    const context = this.pdf.context;
    const ref = context.register(context.obj({ Type: "StructElem", S: role, P: this.documentRef!, Pg: page.ref, K: context.obj(kids) }));
    this.documentKids!.push(ref);
    return ref;
  }

  /** Opens a marked-content sequence for a new element of `role` on the page; the content follows. */
  public markContent(page: PDFPage, role: string): void {
    this.closeContent();
    const parents = this.parentsOf(page);
    const mcid = parents.array.size();
    const ref = this.addElement(role, page, [this.pdf.context.obj({ Type: "MCR", Pg: page.ref, MCID: mcid })]);
    parents.array.push(ref);
    const properties = this.pdf.context.obj({ MCID: mcid }) as unknown as PDFName;
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(role), properties]));
    this.open = page;
  }

  public closeContent(): void {
    if (!this.open) {
      return;
    }
    this.open.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
    this.open = undefined;
  }

  /** Hangs a widget the fill made off a new `Form` element. */
  public attachWidget(page: PDFPage, widgetDict: PDFDict, widgetRef: PDFRef): void {
    const key = this.nextKey;
    this.nextKey += 1;
    const ref = this.addElement("Form", page, [this.pdf.context.obj({ Type: "OBJR", Obj: widgetRef, Pg: page.ref })]);
    widgetDict.set(PDFName.of("StructParent"), PDFNumber.of(key));
    this.insertNums(key, ref);
  }

  /** Closes what is open and brings the root's bookkeeping up to date. */
  public finish(): void {
    this.closeContent();
    if (!this.root) {
      return;
    }
    this.root.set(PDFName.of("ParentTreeNextKey"), PDFNumber.of(this.nextKey));
    const markInfo = this.pdf.catalog.lookupMaybe(PDFName.of("MarkInfo"), PDFDict);
    if (markInfo) {
      markInfo.set(PDFName.of("Marked"), this.pdf.context.obj(true));
    } else {
      this.pdf.catalog.set(PDFName.of("MarkInfo"), this.pdf.context.obj({ Marked: true }));
    }
  }
}
