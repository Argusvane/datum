import type { FormError } from "../../core/errors/form-error.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import { resolveErrorNavigationTarget } from "../../core/errors/error-navigation.js";

export interface ContainerErrorCount {
  own: number;
  descendants: number;
}

export interface StepErrorSummary {
  errorCount: number;
  componentIds: string[];
}

/** Two places in the form, compared: the tree's order first, then row by row. */
function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const step = (a[index] as number) - (b[index] as number);
    if (step !== 0) {
      return step;
    }
  }
  return 0;
}

export class ErrorStore {
  private errors: FormError[] = [];
  private tree: ComponentTree | undefined;

  /** Attaches a component tree so subtree / container aggregation can resolve ancestry. */
  public setTree(tree: ComponentTree): void {
    this.tree = tree;
  }

  public setAll(errors: FormError[]): void {
    this.errors = [...errors];
  }

  /**
   * Replaces the errors `owned` picks out with `errors`, keeping every other one in its place.
   * `errors` are appended whatever they name. The one primitive behind a partial replacement:
   * a journey page's validation, whose run owns the page's errors bar those a server reported
   * on answers not changed since, and a server's check of the page, which owns what
   * the server said before.
   */
  public replaceWhere(owned: (error: FormError) => boolean, errors: FormError[]): void {
    this.errors = [...this.errors.filter((error) => !owned(error)), ...errors];
  }

  /**
   * Replaces the errors `owned` picks out with `errors`, keeping the list in form order: the
   * errors take the place of the first one they replace, so a field checked again on its own
   * (`FormRuntime.validatePath`) keeps its place in the summary. With nothing replaced, they go
   * where the tree puts their component ({@link placeInFormOrder}).
   */
  public replaceInPlace(owned: (error: FormError) => boolean, errors: FormError[]): void {
    const at = this.errors.findIndex(owned);
    if (at === -1) {
      this.errors = this.placeInFormOrder(this.errors, errors);
      return;
    }
    const before = this.errors.slice(0, at).filter((error) => !owned(error));
    const after = this.errors.slice(at).filter((error) => !owned(error));
    this.errors = [...before, ...errors, ...after];
  }

  /**
   * Replaces the errors `owned` picks out with `errors` (a whole run's, in the run's order) and
   * puts each error kept back among them where form order places it, rather than ahead of them:
   * a check of one field that finished while the run was out keeps its field's place.
   */
  public replaceAround(owned: (error: FormError) => boolean, errors: FormError[]): void {
    this.errors = this.placeInFormOrder(errors, this.errors.filter((error) => !owned(error)));
  }

  /**
   * `base` in its own order, with each of `additions` (in theirs) placed before the first error
   * of `base` its component comes before in the tree, or before a later row of the same
   * component. An error the tree cannot place (no component, one the tree does not hold, no
   * tree attached) goes at the end.
   */
  private placeInFormOrder(base: readonly FormError[], additions: readonly FormError[]): FormError[] {
    if (additions.length === 0) {
      return [...base];
    }
    const rank = this.formRanks();
    const out = [...base];
    const unplaced: FormError[] = [];
    let from = 0;
    for (const addition of additions) {
      const own = rank(addition);
      if (own === undefined) {
        unplaced.push(addition);
        continue;
      }
      let at = out.length;
      for (let index = from; index < out.length; index += 1) {
        const other = rank(out[index] as FormError);
        if (other !== undefined && compareRanks(own, other) < 0) {
          at = index;
          break;
        }
      }
      out.splice(at, 0, addition);
      // The additions keep their own order: the next one goes after this one.
      from = at + 1;
    }
    return [...out, ...unplaced];
  }

  /** Where an error stands in the form: its component's place in the tree, then its row indices. */
  private formRanks(): (error: FormError) => readonly number[] | undefined {
    const tree = this.tree;
    if (!tree) {
      return () => undefined;
    }
    const order = new Map<string, number>();
    const rootId = tree.rootId();
    order.set(rootId, 0);
    for (const node of tree.descendantsOf(rootId)) {
      if (!order.has(node.id)) {
        order.set(node.id, order.size);
      }
    }
    return (error) => {
      const place = error.componentId !== undefined ? order.get(error.componentId) : undefined;
      if (place === undefined) {
        return undefined;
      }
      const rows = (error.path?.segments ?? []).flatMap((segment) => (segment.index !== undefined ? [segment.index] : []));
      return [place, ...rows];
    };
  }

  /**
   * Replaces the errors on `componentIds` with `errors`, keeping every other error — what a
   * journey page's Continue does: the page's own errors are found again, and the
   * ones earlier pages left stand. `errors` are appended whatever they name.
   */
  public replaceWithin(componentIds: Iterable<string>, errors: FormError[]): void {
    const within = new Set(componentIds);
    this.replaceWhere((error) => error.componentId !== undefined && within.has(error.componentId), errors);
  }

  /** Drops every error `predicate` picks out. */
  public removeWhere(predicate: (error: FormError) => boolean): void {
    this.errors = this.errors.filter((error) => !predicate(error));
  }

  public add(error: FormError): void {
    this.errors.push(error);
  }

  public clear(): void {
    this.errors = [];
  }

  public listAll(): FormError[] {
    return [...this.errors];
  }

  public forComponent(componentId: string): FormError[] {
    return this.errors.filter((error) => error.componentId === componentId);
  }

  /** Errors on `componentId` or any of its descendants (requires {@link setTree}). */
  public forSubtree(componentId: string): FormError[] {
    if (!this.tree) {
      return this.forComponent(componentId);
    }
    const ids = new Set<string>([componentId]);
    for (const descendant of this.tree.descendantsOf(componentId)) {
      ids.add(descendant.id);
    }
    return this.errors.filter((error) => error.componentId !== undefined && ids.has(error.componentId));
  }

  public aggregateByComponent(): Map<string, number> {
    const aggregate = new Map<string, number>();
    for (const error of this.errors) {
      if (!error.componentId) {
        continue;
      }
      aggregate.set(error.componentId, (aggregate.get(error.componentId) ?? 0) + 1);
    }
    return aggregate;
  }

  /**
   * For every component that owns errors or contains descendants that do, the count of
   * errors directly on it (`own`) and within its subtree (`descendants`). Requires
   * {@link setTree}; without a tree only `own` counts are produced.
   */
  public aggregateByContainer(): Map<string, ContainerErrorCount> {
    const aggregate = new Map<string, ContainerErrorCount>();
    const bump = (id: string, key: keyof ContainerErrorCount): void => {
      const entry = aggregate.get(id) ?? { own: 0, descendants: 0 };
      entry[key] += 1;
      aggregate.set(id, entry);
    };

    for (const error of this.errors) {
      if (!error.componentId) {
        continue;
      }
      bump(error.componentId, "own");
      if (this.tree) {
        const target = resolveErrorNavigationTarget(error, this.tree);
        for (const ancestorId of target.ancestorIds) {
          bump(ancestorId, "descendants");
        }
      }
    }

    return aggregate;
  }

  /** Error summary for a wizard step / tab subtree. */
  public summaryForStep(stepId: string): StepErrorSummary {
    const errors = this.forSubtree(stepId);
    const componentIds = [
      ...new Set(
        errors
          .map((error) => error.componentId)
          .filter((id): id is string => id !== undefined)
      )
    ];
    return { errorCount: errors.length, componentIds };
  }
}
