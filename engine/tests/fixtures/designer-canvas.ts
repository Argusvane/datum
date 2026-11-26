/**
 * A designer's canvas the way `<datum-builder>` draws it: the controller's canvas copy
 * of the tree mounted through the live renderer under the controller's binding, with the
 * designer's faces (`canvasComponents`) laid over it, and, when asked, the builder's chrome (the
 * canvas hooks, the drop zones marked after the draw). For the PDF designer's and the Journeys
 * designer's face tests.
 */
import type { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import { BuilderPreviewRuntime } from "../../form-engine/builder/preview/builder-preview-runtime.js";
import { buildCanvasHooks } from "../../form-engine/builder/web-component/canvas-hooks.js";
import { declaredSlotsByComponent, markDropZones, slotEmptyHintsByComponent } from "../../form-engine/builder/web-component/builder-shared.js";
import { bindingById } from "../../form-engine/render/live/binding-registry.js";
import { extendBinding, type LiveBinding } from "../../form-engine/render/live/contract.js";
import { createDatumBinding, createDatumFeatures, mountLive, type LiveForm } from "../../form-engine/render/live/renderer.js";

let datum: LiveBinding | undefined;

/** The binding the canvas draws the controller's tree with: its own, the designer's faces over it. */
export function canvasBindingOf(controller: BuilderController): LiveBinding {
  datum ??= createDatumBinding();
  const chosen = controller.canvasBinding();
  const binding = typeof chosen === "string" ? (bindingById(chosen) ?? datum) : (chosen ?? datum);
  const faces = controller.canvasComponents();
  return faces ? extendBinding(binding, { components: faces }) : binding;
}

export interface DesignerCanvas {
  root: ShadowRoot;
  live: LiveForm;
  /** The drawing as markup: the root's elements but its stylesheets, lit's comment markers left out. */
  html(): string;
  unmount(): void;
}

export interface DesignerCanvasChrome {
  selectedId: string | undefined;
}

/** Mounts the controller's canvas copy, drawn; `chrome` adds the builder's hooks and marks the drop zones. */
export async function mountDesignerCanvas(controller: BuilderController, chrome?: DesignerCanvasChrome): Promise<DesignerCanvas> {
  datum ??= createDatumBinding();
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const runtime = new BuilderPreviewRuntime(controller.canvasSnapshot(), {});
  const view = controller.treeView();
  const live = mountLive(root, {
    runtime,
    binding: canvasBindingOf(controller),
    datum,
    mode: "readonly",
    features: createDatumFeatures(),
    includeHidden: true,
    ...(chrome
      ? {
          canvasHooks: buildCanvasHooks({
            selectedId: chrome.selectedId,
            rootId: view.id,
            declaredSlots: declaredSlotsByComponent(view),
            emptyHints: slotEmptyHintsByComponent(view)
          })
        }
      : {})
  });
  await live.ready;
  if (chrome) {
    markDropZones(root, view);
  }
  return {
    root,
    live,
    html: () =>
      [...root.children]
        .filter((element) => element.localName !== "style")
        .map((element) => element.outerHTML)
        .join("")
        .replace(/<!--[^]*?-->/g, ""),
    unmount: () => {
      live.unmount();
      host.remove();
    }
  };
}

/** The canvas's markup once drawn: mounted, read and taken down. */
export async function designerCanvasHtml(controller: BuilderController, chrome?: DesignerCanvasChrome): Promise<string> {
  const canvas = await mountDesignerCanvas(controller, chrome);
  try {
    return canvas.html();
  } finally {
    canvas.unmount();
  }
}
