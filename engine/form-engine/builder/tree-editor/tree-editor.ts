import type { ComponentNode, ComponentRules } from "../../core/schema/types.js";
import { ComponentTree } from "../../core/tree/component-tree.js";
import type { ComponentRegistry } from "../../registry/components/component-registry.js";
import { CommandHistory, type BuilderCommand } from "../history/command-history.js";
import {
  canAcceptInSlot,
  createParentConstraintsResolverFromRegistry,
  type ParentConstraintsResolver
} from "./slot-constraints.js";

const isObject = (value: unknown): boolean => typeof value === "object" && value !== null;

/** A private deep copy of a children map, so the tree's own edits never reach what a step puts back. */
function copyChildren(children: Record<string, ComponentNode[]> | undefined): Record<string, ComponentNode[]> | undefined {
  return children && structuredClone(children);
}

/** A command about one component, by its id, which is there before and after it runs. */
abstract class ComponentCommand {
  constructor(
    protected readonly tree: ComponentTree,
    protected readonly componentId: string
  ) {}
}

export class AddComponentCommand implements BuilderCommand {
  public readonly id = "ADD_COMPONENT";
  /** The command's own copy of the node it adds. */
  private readonly component: ComponentNode;

  constructor(
    private readonly tree: ComponentTree,
    component: ComponentNode,
    private readonly parentId: string,
    private readonly slotId: string,
    private readonly index?: number,
    private readonly resolveParentConstraints?: ParentConstraintsResolver
  ) {
    this.component = structuredClone(component);
  }

  public execute(): void {
    const parent = this.tree.find(this.parentId);
    if (!parent) {
      throw new Error(`Cannot add component: parent not found ${this.parentId}`);
    }

    const existingCount = this.tree.childrenOf(this.parentId, this.slotId).length;
    const acceptance = canAcceptInSlot(
      parent,
      this.component,
      this.slotId,
      existingCount,
      this.resolveParentConstraints
    );
    if (!acceptance.ok) {
      throw new Error(acceptance.reason);
    }

    // A copy: the tree's own edits never reach what a redo puts back.
    this.tree.insert(structuredClone(this.component), this.parentId, this.slotId, this.index);
  }

  public undo(): void {
    this.tree.remove(this.component.id);
  }
}

export class RemoveComponentCommand implements BuilderCommand {
  public readonly id = "REMOVE_COMPONENT";

  private snapshot?: {
    node: ComponentNode;
    slotId: string;
    index: number;
  };
  /** Where the node sat, read as it is removed. */
  private parentId = "";

  constructor(
    private readonly tree: ComponentTree,
    private readonly componentId: string
  ) {}

  public execute(): void {
    const location = this.tree.locate(this.componentId);
    if (!location?.parentId || location.slotId === undefined || location.index === undefined) {
      throw new Error(`Cannot remove component: ${this.componentId}`);
    }

    this.snapshot = {
      node: structuredClone(location.node),
      slotId: location.slotId,
      index: location.index
    };
    this.parentId = location.parentId;

    this.tree.remove(this.componentId);
  }

  /**
   * Puts the node back where it was, as it was — raw, past the checks an insert makes: a node the
   * tree would refuse to take (a hand-written id that repeats another or is outside the grammar,
   * a presentation's unusable own entry) is just what a removal fixes, and comes back.
   */
  public undo(): void {
    if (!this.snapshot) {
      return;
    }

    const { node, slotId, index } = this.snapshot;
    const parent = this.tree.find(this.parentId);
    if (!parent) {
      throw new Error(`Component not found: ${this.parentId}`);
    }
    const live = Object.entries(parent.children ?? {});
    const slot = [...(live.find(([id]) => id === slotId)?.[1] ?? [])];
    slot.splice(index, 0, structuredClone(node));
    // The slot keeps its place; one the node alone was in comes back last, as it always did.
    this.tree.replaceChildren(this.parentId, Object.fromEntries(live.some(([id]) => id === slotId) ? live.map(([id, group]) => [id, id === slotId ? slot : group]) : [...live, [slotId, slot]]));
  }
}

export class MoveComponentCommand implements BuilderCommand {
  public readonly id = "MOVE_COMPONENT";

  private previous?: {
    slotId: string;
    index: number;
  };
  /** Where the node sat, read as it moves. */
  private parentId = "";

  constructor(
    private readonly tree: ComponentTree,
    private readonly componentId: string,
    private readonly newParentId: string,
    private readonly newSlotId: string,
    private readonly newIndex: number,
    private readonly resolveParentConstraints?: ParentConstraintsResolver
  ) {}

  public execute(): void {
    const location = this.tree.locate(this.componentId);
    if (!location?.parentId || location.slotId === undefined || location.index === undefined) {
      throw new Error(`Cannot move component: ${this.componentId}`);
    }

    const movingNode = this.tree.find(this.componentId);
    const newParent = this.tree.find(this.newParentId);
    if (!movingNode || !newParent) {
      throw new Error(`Cannot move component: missing source or target`);
    }

    // A reorder within the node's own slot adds no child to it, so the node is not counted
    // against the slot's `max` (or its single child) as though it arrived from elsewhere.
    const sameSlot = location.parentId === this.newParentId && location.slotId === this.newSlotId;
    const existingCount = this.tree.childrenOf(this.newParentId, this.newSlotId).length - (sameSlot ? 1 : 0);
    const acceptance = canAcceptInSlot(
      newParent,
      movingNode,
      this.newSlotId,
      existingCount,
      this.resolveParentConstraints
    );
    if (!acceptance.ok) {
      throw new Error(acceptance.reason);
    }

    this.previous = {
      slotId: location.slotId,
      index: location.index
    };
    this.parentId = location.parentId;

    this.tree.move(this.componentId, this.newParentId, this.newSlotId, this.newIndex);
  }

  public undo(): void {
    if (!this.previous) {
      return;
    }

    this.tree.move(this.componentId, this.parentId, this.previous.slotId, this.previous.index);
  }
}

export class SetPropertyCommand extends ComponentCommand implements BuilderCommand {
  public readonly id = "SET_PROPERTY";

  /** What the command replaces, as it was: the value at its path, or above it (`undefined`: none). */
  private previous?: { path: string; value: unknown };
  private readonly nextValue: unknown;

  constructor(
    tree: ComponentTree,
    componentId: string,
    private readonly propertyPath: string,
    nextValue: unknown
  ) {
    super(tree, componentId);
    // Its own copies, of what it is given and what it replaces: an edit made later in place
    // never reaches what a redo or an undo puts back.
    this.nextValue = structuredClone(nextValue);
  }

  public execute(): void {
    // Setting a path makes an object at its first step that is not one, which an undo takes away again.
    const parts = this.propertyPath.split(".").filter(Boolean);
    let depth = 1;
    while (depth < parts.length && isObject(this.tree.getConfigurationValue(this.componentId, parts.slice(0, depth).join(".")))) {
      depth += 1;
    }
    const path = parts.slice(0, depth).join(".");
    this.previous = { path, value: structuredClone(this.tree.getConfigurationValue(this.componentId, path)) };
    this.tree.setConfigurationValue(this.componentId, this.propertyPath, structuredClone(this.nextValue));
  }

  public undo(): void {
    if (!this.previous) {
      return;
    }
    const { path, value } = this.previous;
    if (value === undefined) {
      this.tree.removeConfigurationValue(this.componentId, path);
    } else {
      this.tree.setConfigurationValue(this.componentId, path, structuredClone(value));
    }
  }
}

export class RemovePropertyCommand extends ComponentCommand implements BuilderCommand {
  public readonly id = "REMOVE_PROPERTY";

  private previousValue: unknown;
  private existed = false;
  /** The keys of the object the property sat in, in order: an undo puts the key back in its place. */
  private siblingKeys: string[] | undefined;

  constructor(
    tree: ComponentTree,
    componentId: string,
    private readonly propertyPath: string
  ) {
    super(tree, componentId);
  }

  public execute(): void {
    // A copy, not the tree's own value: an in-place edit later never reaches what an undo restores.
    const live = this.tree.getConfigurationValue(this.componentId, this.propertyPath);
    this.previousValue = structuredClone(live);
    this.existed = live !== undefined;
    const parent = this.tree.getConfigurationValue(this.componentId, parentPathOf(this.propertyPath));
    this.siblingKeys = isKeyedObject(parent) ? Object.keys(parent) : undefined;
    this.tree.removeConfigurationValue(this.componentId, this.propertyPath);
  }

  public undo(): void {
    if (!this.existed) {
      return;
    }

    this.tree.setConfigurationValue(this.componentId, this.propertyPath, structuredClone(this.previousValue));
    if (this.siblingKeys) {
      const parent = this.tree.getConfigurationValue(this.componentId, parentPathOf(this.propertyPath));
      if (isKeyedObject(parent)) {
        restoreKeyOrder(parent, this.siblingKeys);
      }
    }
  }
}

const isKeyedObject = (value: unknown): value is Record<string, unknown> => isObject(value) && !Array.isArray(value);

/** The path of the object `path` sits in (`""`: the configuration itself). */
function parentPathOf(path: string): string {
  return path.split(".").filter(Boolean).slice(0, -1).join(".");
}

/** Puts `target`'s keys in `order` (keys not named follow, as they were), in place. */
function restoreKeyOrder(target: Record<string, unknown>, order: readonly string[]): void {
  const present = new Set(Object.keys(target));
  const wanted = order.filter((key) => present.has(key));
  const named = new Set(wanted);
  const keys = [...wanted, ...Object.keys(target).filter((key) => !named.has(key))];
  const current = Object.keys(target);
  if (keys.every((key, index) => key === current[index])) {
    return;
  }
  const entries = keys.map((key) => [key, target[key]] as const);
  for (const key of current) {
    delete target[key];
  }
  for (const [key, value] of entries) {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }
}

export class ReplaceConfigurationCommand extends ComponentCommand implements BuilderCommand {
  public readonly id = "REPLACE_CONFIGURATION";

  private previousValue: unknown;
  private readonly nextConfiguration: unknown;

  constructor(
    tree: ComponentTree,
    componentId: string,
    nextConfiguration: unknown
  ) {
    super(tree, componentId);
    // Its own copy: a caller editing the object it passed never changes what a redo applies.
    this.nextConfiguration = structuredClone(nextConfiguration);
  }

  public execute(): void {
    this.previousValue = this.tree.getConfiguration(this.componentId);
    this.tree.replaceConfiguration(this.componentId, this.nextConfiguration);
  }

  public undo(): void {
    this.tree.replaceConfiguration(this.componentId, this.previousValue);
  }
}

export class SetRulesCommand extends ComponentCommand implements BuilderCommand {
  public readonly id = "SET_RULES";

  private previousValue: ComponentRules | undefined;
  private readonly nextRules: ComponentRules | undefined;

  constructor(
    tree: ComponentTree,
    componentId: string,
    nextRules: ComponentRules | undefined
  ) {
    super(tree, componentId);
    this.nextRules = structuredClone(nextRules);
  }

  public execute(): void {
    this.previousValue = this.tree.getRules(this.componentId);
    this.tree.setRules(this.componentId, this.nextRules);
  }

  public undo(): void {
    this.tree.setRules(this.componentId, this.previousValue);
  }
}

/**
 * Configuration and rules written together as one history entry. The properties panel edits
 * into a draft and commits on Save, so a session of typing has to undo as the single edit the
 * author perceives it to be — not one entry per keystroke.
 */
export class EditComponentCommand extends ComponentCommand implements BuilderCommand {
  public readonly id = "EDIT_COMPONENT";

  private previousConfiguration: unknown;
  private previousRules: ComponentRules | undefined;
  private readonly nextConfiguration: unknown;
  private readonly nextRules: ComponentRules | undefined;

  constructor(
    tree: ComponentTree,
    componentId: string,
    nextConfiguration: unknown,
    nextRules: ComponentRules | undefined
  ) {
    super(tree, componentId);
    this.nextConfiguration = structuredClone(nextConfiguration);
    this.nextRules = structuredClone(nextRules);
  }

  public execute(): void {
    this.previousConfiguration = this.tree.getConfiguration(this.componentId);
    this.previousRules = this.tree.getRules(this.componentId);
    this.tree.replaceConfiguration(this.componentId, this.nextConfiguration);
    this.tree.setRules(this.componentId, this.nextRules);
  }

  public undo(): void {
    this.tree.replaceConfiguration(this.componentId, this.previousConfiguration);
    this.tree.setRules(this.componentId, this.previousRules);
  }
}

/**
 * Replaces a container's whole children map. The builder uses it to re-file children when a
 * grid loses a column (see `foldGridChildrenIntoColumns`); every slot is replaced at once, so
 * one undo puts them all back. What it puts in the tree, and back, are its own deep copies.
 */
export class ReplaceChildrenCommand extends ComponentCommand implements BuilderCommand {
  public readonly id = "REPLACE_CHILDREN";

  private previous: Record<string, ComponentNode[]> | undefined;
  private readonly nextChildren: Record<string, ComponentNode[]> | undefined;

  constructor(tree: ComponentTree, componentId: string, nextChildren: Record<string, ComponentNode[]> | undefined) {
    super(tree, componentId);
    this.nextChildren = copyChildren(nextChildren);
  }

  public execute(): void {
    this.previous = copyChildren(this.tree.find(this.componentId)?.children);
    this.tree.replaceChildren(this.componentId, copyChildren(this.nextChildren));
  }

  public undo(): void {
    this.tree.replaceChildren(this.componentId, copyChildren(this.previous));
  }
}

/**
 * Several commands as one history entry, undone in reverse. A configuration edit that also
 * has to re-file children (a grid's column count) is one edit to the author and must be one
 * undo. `id` is whichever the caller names — normally the leading command's, so mutation
 * listeners see the edit they would have seen without the companion.
 *
 * Execution is all-or-nothing: a command that throws after earlier ones ran has those undone
 * before the error propagates, so a refused edit leaves the tree as it was. Undoing is too.
 */
export class CompositeCommand implements BuilderCommand {
  constructor(
    public readonly id: string,
    private readonly commands: readonly BuilderCommand[]
  ) {}

  public execute(): void {
    const done: BuilderCommand[] = [];
    try {
      for (const command of this.commands) {
        command.execute();
        done.push(command);
      }
    } catch (error) {
      for (const command of done.reverse()) {
        command.undo();
      }
      throw error;
    }
  }

  public undo(): void {
    const undone: BuilderCommand[] = [];
    try {
      for (const command of [...this.commands].reverse()) {
        command.undo();
        undone.push(command);
      }
    } catch (error) {
      for (const command of undone.reverse()) {
        command.execute();
      }
      throw error;
    }
  }
}

export interface BuilderMutationEvent {
  action: "execute" | "undo" | "redo";
  commandId: string;
}

type BuilderMutationListener = (event: BuilderMutationEvent) => void;

class BuilderMutationEventBus {
  private readonly listeners = new Set<BuilderMutationListener>();

  public subscribe(listener: BuilderMutationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public publish(event: BuilderMutationEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class TreeEditor {
  private readonly tree: ComponentTree;
  private readonly history = new CommandHistory();
  private readonly eventsBus = new BuilderMutationEventBus();

  constructor(root: ComponentNode) {
    this.tree = new ComponentTree(root);
  }

  public snapshot(): ComponentNode {
    return this.tree.getRoot();
  }

  public execute(command: BuilderCommand): void {
    this.history.execute(command);
    this.eventsBus.publish({ action: "execute", commandId: command.id });
  }

  /**
   * Runs `command` without an undo entry: a value a catalog keeps in step with the tree (a
   * journey's name), which an undo must not take back.
   */
  public executeUnrecorded(command: BuilderCommand): void {
    command.execute();
    this.eventsBus.publish({ action: "execute", commandId: command.id });
  }

  public undo(): void {
    const previous = this.history.peekUndo();
    this.history.undo();
    if (previous) {
      this.eventsBus.publish({ action: "undo", commandId: previous.id });
    }
  }

  public redo(): void {
    const previous = this.history.peekRedo();
    this.history.redo();
    if (previous) {
      this.eventsBus.publish({ action: "redo", commandId: previous.id });
    }
  }

  public canUndo(): boolean {
    return this.history.canUndo();
  }

  public canRedo(): boolean {
    return this.history.canRedo();
  }

  /** Ends the redo side with no entry made (see `BuilderController.dropRedo`). */
  public dropRedo(holding: (entry: object) => boolean): boolean {
    return this.history.dropRedo(holding);
  }

  /** The entry atop the undo side (opaque; compared by identity, see `BuilderController.undoMark`). */
  public undoMark(): object | undefined {
    return this.history.peekUndo();
  }

  /** The entry atop the redo side (opaque; compared by identity). */
  public redoMark(): object | undefined {
    return this.history.peekRedo();
  }

  public componentTree(): ComponentTree {
    return this.tree;
  }

  public events(): { subscribe: (listener: BuilderMutationListener) => () => void } {
    return {
      subscribe: (listener: BuilderMutationListener) => this.eventsBus.subscribe(listener)
    };
  }

  public setProperty(componentId: string, propertyPath: string, value: unknown): void {
    this.execute(new SetPropertyCommand(this.componentTree(), componentId, propertyPath, value));
  }

  public removeProperty(componentId: string, propertyPath: string): void {
    this.execute(new RemovePropertyCommand(this.componentTree(), componentId, propertyPath));
  }

  public replaceConfiguration(componentId: string, configuration: unknown): void {
    this.execute(
      new ReplaceConfigurationCommand(this.componentTree(), componentId, configuration)
    );
  }

  public setRules(componentId: string, rules: ComponentRules | undefined): void {
    this.execute(new SetRulesCommand(this.componentTree(), componentId, rules));
  }

  /** Configuration + rules in one undoable step. See {@link EditComponentCommand}. */
  public editComponent(
    componentId: string,
    configuration: unknown,
    rules: ComponentRules | undefined
  ): void {
    this.execute(
      new EditComponentCommand(this.componentTree(), componentId, configuration, rules)
    );
  }
}

export class RegistryBackedTreeEditor extends TreeEditor {
  private resolveParentConstraints: ParentConstraintsResolver;

  constructor(root: ComponentNode, registry: ComponentRegistry) {
    super(root);
    this.resolveParentConstraints = createParentConstraintsResolverFromRegistry(registry);
  }

  /** Reads slot constraints from another registry from now on; the tree and its history stay. */
  public useRegistry(registry: ComponentRegistry): void {
    this.resolveParentConstraints = createParentConstraintsResolverFromRegistry(registry);
  }

  /** The slot-constraint resolver derived from the component registry. */
  public constraintsResolver(): ParentConstraintsResolver {
    return this.resolveParentConstraints;
  }

  public add(
    component: ComponentNode,
    parentId: string,
    slotId: string,
    index?: number
  ): void {
    this.execute(
      new AddComponentCommand(
        this.componentTree(),
        component,
        parentId,
        slotId,
        index,
        this.resolveParentConstraints
      )
    );
  }

  public move(
    componentId: string,
    newParentId: string,
    newSlotId: string,
    newIndex: number
  ): void {
    this.execute(
      new MoveComponentCommand(
        this.componentTree(),
        componentId,
        newParentId,
        newSlotId,
        newIndex,
        this.resolveParentConstraints
      )
    );
  }
}
