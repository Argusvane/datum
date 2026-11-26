/**
 * What the PDF mode takes from the designer, as one module to load (`pdf-designer-loader.ts`):
 * the custom layout's designer, the populated form's designer, the page viewer, the Preview
 * dialog and the Add popover, with the template planners they read. The mode (`pdf-builder-mode.ts`)
 * stays a thin shell on the page; this is the chunk behind it, so a builder opened on the form
 * alone never carries any of it.
 */
export { bindableComponents, createPdfDesigner } from "./pdf-designer.js";
export { createPdfTemplateDesigner, followRenameInTemplateTree, mappingSummary, noFillableFieldsText } from "./pdf-template-designer.js";
export { createAddPopover, createPreviewDialog } from "./pdf-designer-panels.js";
export { pdfFieldOwnName, planTemplateFormFields, suggestFieldMappings } from "./template-mode.js";
export { createTemplatePageViewer } from "./template-pages.js";
// The area type and slot the page viewer draws into, read here so the shell never imports the designer's component table.
export { PDF_AREA_COMPONENT_TYPE, PDF_TEMPLATE_AREAS_SLOT } from "../../render/pdf/pdf-template-components.js";
