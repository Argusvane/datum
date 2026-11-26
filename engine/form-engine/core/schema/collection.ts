import type { ComponentNode } from "./types.js";

export interface CollectionOperations {
  add?: boolean;
  remove?: boolean;
  reorder?: boolean;
}

export interface CollectionCapability {
  collectionPath: string;
  itemSchema: ComponentNode;
  operations: CollectionOperations;
}

/**
 * Lightweight collection attachment on a {@link ComponentNode} (repeating section /
 * data grid). Row values live in form state under `collectionPath[i].fieldId`. A data grid's
 * own settings (layout, row operations, bounds) are in its configuration, `data-grid.ts`;
 * its `operations` here are derived, never authored (`rowOperationsOf`).
 */
export interface CollectionBinding {
  /** Defaults to the component id. */
  collectionPath?: string;
  /** Field ids present in each row (used for state sync and rule/validation targeting). */
  itemFields?: string[];
  operations?: CollectionOperations;
}

export interface RowContext {
  rowIndex: number;
  rowData: Record<string, unknown>;
  collectionPath: string;
}
