/**
 * The component types, slots and palette group of a populated form's layout tree,
 * apart from `pdf-template-components.ts` so a module that only needs the names (the layout
 * conditions, the shell's eager graph) does not load the designer's component table. Imports nothing.
 */

export const PDF_TEMPLATE_COMPONENT_TYPE = "pdf-template";
export const PDF_WIDGET_COMPONENT_TYPE = "pdf-widget";
export const PDF_AREA_COMPONENT_TYPE = "pdf-area";
/** The root's slots: the PDF's own fields, then the areas the author draws. */
export const PDF_TEMPLATE_WIDGETS_SLOT = "widgets";
export const PDF_TEMPLATE_AREAS_SLOT = "areas";
export const PDF_TEMPLATE_PALETTE_GROUP = "PDF areas";
/** What the root's PDF picker offers: PDF files, by type and by extension. */
export const PDF_TEMPLATE_ACCEPT = "application/pdf,.pdf";
