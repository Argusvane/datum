/**
 * The `pdf` render mode's adapter: registered with the orchestrator by the
 * PDF pipeline rather than imported by it, so an HTML renderer that never produces a PDF never
 * carries the PDF model builder. `renderFormPdf` registers it on first use; a host building
 * `mode: "pdf"` output itself (through `buildRuntimeRenderOutput`) calls
 * {@link registerPdfRenderMode} first.
 */
import { hasRenderModeAdapter, registerRenderModeAdapter } from "../core/render-orchestrator.js";
import { buildPdfRenderModel } from "./pdf-render-model.js";

/** Makes `mode: "pdf"` renderable. Idempotent. */
export function registerPdfRenderMode(): void {
  if (hasRenderModeAdapter("pdf")) {
    return;
  }
  // Everything the PDF reads travels in `request.pdf`: the host's default theme (`pdf.theme`),
  // the call's `themeId`, the lookup (`pdf.resolveTheme`) and the binding's suggestion
  // (`pdf.binding`), and the definition's `kinds` map (`pdf.kinds`). The request's own `theme`
  // is the form's look, which paper never reads.
  registerRenderModeAdapter("pdf", async (request, modelContext) => buildPdfRenderModel(request.root, request.state, request.resolver, modelContext, { ...request.pdf }));
}
