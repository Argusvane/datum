import type { ChildrenDefinition, ComponentNode, SlotDefinition } from "../../core/schema/types.js";
import type { ComponentRegistry } from "../../registry/components/component-registry.js";

export interface ParentConstraints {
  children?: ChildrenDefinition | undefined;
  /**
   * What a slot the type does not declare takes — a grid's columns, the slots of a type known
   * only by name — when not anything: a presentation's own layout takes page-only fields and
   * the form's fields alone. Absent: anything goes there.
   */
  otherSlots?: Omit<SlotDefinition, "id"> | undefined;
}

/** The type of the form's root component. */
const ROOT_TYPE = "form";

export type ParentConstraintsResolver = (componentType: string) => ParentConstraints | undefined;

export function createParentConstraintsResolverFromRegistry(
  registry: ComponentRegistry
): ParentConstraintsResolver {
  return (componentType: string): ParentConstraints | undefined => {
    try {
      const component = registry.resolve(componentType);
      return {
        children: component.children
      };
    } catch {
      // Unknown component types are treated as unconstrained until registered.
      return undefined;
    }
  };
}

function resolveSlot(
  children: ChildrenDefinition | undefined,
  slotId: string
): SlotDefinition | undefined {
  return children?.slots.find((slot) => slot.id === slotId);
}

export function canAcceptInSlot(
  parent: ComponentNode,
  child: ComponentNode,
  slotId: string,
  existingCount: number,
  resolveParentConstraints?: ParentConstraintsResolver
): { ok: boolean; reason?: string } {
  // The form is the root, once: it is never a child (a second form root would be two forms in one).
  if (child.type === ROOT_TYPE) {
    return { ok: false, reason: "A form cannot be placed inside another component" };
  }
  const constraints = resolveParentConstraints?.(parent.type);
  const slot = resolveSlot(constraints?.children, slotId) ?? (constraints?.otherSlots && { ...constraints.otherSlots, id: slotId });

  if (!slot) {
    // A registered type that declares no children (every leaf: a text field, a button) takes none.
    // A type with a children definition keeps its undeclared slots open (a grid's columns), and a
    // type the registry does not know stays unconstrained until it is registered.
    if (constraints && !constraints.children && !constraints.otherSlots) {
      return { ok: false, reason: `A ${parent.type} component does not take children` };
    }
    return { ok: true };
  }

  if (!slot.multiple && existingCount > 0) {
    return { ok: false, reason: `Slot ${slotId} does not allow multiple children` };
  }

  if (slot.max !== undefined && existingCount >= slot.max) {
    return { ok: false, reason: `Slot ${slotId} reached max children ${slot.max}` };
  }

  if (slot.allowedTypes && slot.allowedTypes.length > 0 && !slot.allowedTypes.includes(child.type)) {
    return {
      ok: false,
      reason: `Child type ${child.type} is not allowed in slot ${slotId}`
    };
  }

  return { ok: true };
}
