import "../src/builder.js";
import { BUILDER_DRAG_MIME_TYPE, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { until } from "./helpers.js";

/*
 * What the builder tests ported from the retired demo app share: a form mounted in
 * `<datum-form-builder>` (the standard component definitions, as a host gets them), the
 * panels' shadow roots, and a synthetic drag. Not a test file.
 */

/** A bare form with `content` as its one slot. */
export function formOf(content: ComponentNode[], configuration: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "ported-form",
    version: "1.0.0",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration, children: { content } }
  };
}

export const textNode = (id: string, label = id): ComponentNode => ({ id, type: "text", configuration: { label } });

export async function mountBuilder(definition: FormDefinition): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await until(() => previewOf(element)?.querySelector("form"));
  return element;
}

export const shellOf = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
export const canvasElOf = (element: DatumFormBuilderElement) =>
  shellOf(element).querySelector("datum-builder-canvas")! as HTMLElement & { previewing: boolean; previewRoot(): ShadowRoot | undefined };
export const canvasPanelOf = (element: DatumFormBuilderElement): ShadowRoot => canvasElOf(element).shadowRoot!;
/** The previewed form's own shadow root: the fields and the builder's chrome around them. */
export const previewOf = (element: DatumFormBuilderElement): ShadowRoot | undefined => canvasElOf(element)?.previewRoot();
export const propsEl = (element: DatumFormBuilderElement) =>
  shellOf(element).querySelector("datum-builder-properties")! as HTMLElement & { collapsed: boolean };
export const propsOf = (element: DatumFormBuilderElement): ShadowRoot => propsEl(element).shadowRoot!;
export const toolbarOf = (element: DatumFormBuilderElement): ShadowRoot => shellOf(element).querySelector("datum-builder-toolbar")!.shadowRoot!;

/** The root's top-level component ids, in order. */
export const idsOf = (element: DatumFormBuilderElement): string[] =>
  (element.builder!.controller.snapshot().children?.content ?? []).map((node: ComponentNode) => node.id);

/**
 * A synthetic builder drag for jsdom, which cannot construct a `DragEvent`: a plain `Event`,
 * `composed` so it crosses the preview's shadow boundary the way a real drag does, carrying a
 * `dataTransfer` whose `types` and `effectAllowed` are readable in flight (all the canvas reads
 * during `dragover`; `getData` is for the drop). Both coordinates are the one position, so a
 * zone on either axis reads the same place.
 */
export function builderDrag(type: string, payload: unknown, options: { position?: number; effectAllowed?: string } = {}): DragEvent {
  const store = new Map<string, string>([[BUILDER_DRAG_MIME_TYPE, JSON.stringify(payload)]]);
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true }) as DragEvent;
  const position = options.position ?? 0;
  Object.defineProperty(event, "clientY", { value: position });
  Object.defineProperty(event, "clientX", { value: position });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      setData: (key: string, value: string) => store.set(key, value),
      getData: (key: string) => store.get(key) ?? "",
      setDragImage: () => {},
      get types() {
        return [...store.keys()];
      },
      dropEffect: "",
      effectAllowed: options.effectAllowed ?? "move"
    }
  });
  Object.defineProperty(event, "relatedTarget", { value: null });
  return event;
}

/** A palette template as it travels in a drag: a text field to be added. */
export const templateText = (id = "dragged"): unknown => ({
  kind: "template-component",
  component: { id, type: "text", configuration: { label: id } }
});

/** Lays a column of `height`-tall boxes over `nodes`, since jsdom lays nothing out. */
export function stackRects(nodes: HTMLElement[], height = 20): void {
  nodes.forEach((node, i) =>
    Object.defineProperty(node, "getBoundingClientRect", {
      value: () => ({ top: i * height, height, bottom: i * height + height, left: 0, right: 100, width: 100, x: 0, y: i * height, toJSON: () => ({}) }),
      configurable: true
    })
  );
}

export function keystroke(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** Picks an option in a `<select>` the way a browser reports it. */
export function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

export function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }));
}

export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
