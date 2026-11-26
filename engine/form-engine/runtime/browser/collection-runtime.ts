import type { CollectionCapability, RowContext } from "../../core/schema/collection.js";

export class CollectionRuntime {
  private readonly rows = new Map<string, Record<string, unknown>[]>();
  /**
   * One key per entry, parallel to `rows`: an entry keeps its key while it is added, moved or
   * left in place by the rows around it, so a renderer can tell "this row moved" from "this
   * row's contents changed". Held beside the rows, never inside them, so it is not an answer.
   */
  private readonly keys = new Map<string, string[]>();
  private nextKey = 1;

  private freshKey(): string {
    const key = `row-${this.nextKey}`;
    this.nextKey += 1;
    return key;
  }

  /** The entries' stable keys, in row order (one per row; a copy). */
  public rowKeys(collectionPath: string): string[] {
    return [...(this.keys.get(collectionPath) ?? [])];
  }

  private keysOf(collectionPath: string): string[] {
    let current = this.keys.get(collectionPath);
    if (!current) {
      current = [];
      this.keys.set(collectionPath, current);
    }
    return current;
  }

  public initialize(capability: CollectionCapability): void {
    if (!this.rows.has(capability.collectionPath)) {
      this.rows.set(capability.collectionPath, []);
    }
  }

  public list(collectionPath: string): Record<string, unknown>[] {
    return [...(this.rows.get(collectionPath) ?? [])];
  }

  public count(collectionPath: string): number {
    return this.rows.get(collectionPath)?.length ?? 0;
  }

  /**
   * Replaces a collection's rows wholesale (a draft put back); each row is copied.
   * The entries keep their keys by position (the rows were rewritten in place: their values
   * refreshed from the answers, a row grown by a write past the end) unless `freshKeys` says
   * the rows are new ones (a draft or a whole list put in), which are all keyed again.
   */
  public setRows(collectionPath: string, rows: ReadonlyArray<Record<string, unknown>>, options: { freshKeys?: boolean } = {}): void {
    this.rows.set(
      collectionPath,
      rows.map((row) => structuredClone(row))
    );
    const previous = options.freshKeys === true ? [] : (this.keys.get(collectionPath) ?? []);
    this.keys.set(
      collectionPath,
      rows.map((_row, index) => previous[index] ?? this.freshKey())
    );
  }

  /** Sets a single field on a row, growing the collection with empty rows if needed. */
  public setRowField(
    collectionPath: string,
    rowIndex: number,
    fieldId: string,
    value: unknown
  ): void {
    const current = this.rows.get(collectionPath) ?? [];
    const keys = this.keysOf(collectionPath);
    while (current.length <= rowIndex) {
      current.push({});
      keys.push(this.freshKey());
    }
    const row = current[rowIndex];
    if (row) {
      row[fieldId] = value;
    }
    this.rows.set(collectionPath, current);
  }

  public addRow(collectionPath: string, row: Record<string, unknown>): void {
    const current = this.rows.get(collectionPath) ?? [];
    current.push(structuredClone(row));
    this.rows.set(collectionPath, current);
    this.keysOf(collectionPath).push(this.freshKey());
  }

  public removeRow(collectionPath: string, rowIndex: number): void {
    const current = this.rows.get(collectionPath) ?? [];
    if (rowIndex < 0 || rowIndex >= current.length) {
      throw new Error(`Row index out of bounds: ${rowIndex}`);
    }

    current.splice(rowIndex, 1);
    this.rows.set(collectionPath, current);
    this.keysOf(collectionPath).splice(rowIndex, 1);
  }

  public reorderRow(collectionPath: string, fromIndex: number, toIndex: number): void {
    const current = this.rows.get(collectionPath) ?? [];
    if (
      fromIndex < 0 ||
      fromIndex >= current.length ||
      toIndex < 0 ||
      toIndex >= current.length
    ) {
      throw new Error(`Row reorder indexes out of bounds: ${fromIndex} -> ${toIndex}`);
    }

    const [row] = current.splice(fromIndex, 1);
    if (!row) {
      throw new Error(`Row missing at index: ${fromIndex}`);
    }
    current.splice(toIndex, 0, row);
    this.rows.set(collectionPath, current);
    const keys = this.keysOf(collectionPath);
    const [key] = keys.splice(fromIndex, 1);
    if (key !== undefined) {
      keys.splice(toIndex, 0, key);
    }
  }

  public rowContext(collectionPath: string, rowIndex: number): RowContext {
    const current = this.rows.get(collectionPath) ?? [];
    const row = current[rowIndex];
    if (rowIndex < 0 || rowIndex >= current.length || row === undefined) {
      throw new Error(`Row index out of bounds: ${rowIndex}`);
    }

    return {
      rowIndex,
      rowData: structuredClone(row),
      collectionPath
    };
  }

  public static buildItemPath(
    collectionPath: string,
    rowIndex: number,
    fieldId: string
  ): string {
    return `${collectionPath}[${rowIndex}].${fieldId}`;
  }
}
