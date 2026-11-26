package com.argusvane.datum.pdf.api;

import tools.jackson.databind.node.ObjectNode;

/**
 * Where a template layout's PDF comes from (SPI): the layout's {@code source} names a storage the server resolves,
 * not bytes in the definition (the Java fill sample reads it from the server's disk). A template the host resolves
 * is the server's own and is sealed as any issued PDF; one the caller posts is not.
 */
@FunctionalInterface
public interface PdfTemplateSource {

    /** No templates of the host's own: a fill uses an inline source or the template the caller posts. */
    PdfTemplateSource NONE = (formKey, layoutId, layout) -> null;

    /**
     * The template's bytes, or null when the host has none for this layout.
     *
     * @param layout the template layout as the definition declares it
     */
    byte[] template(String formKey, String layoutId, ObjectNode layout);
}
