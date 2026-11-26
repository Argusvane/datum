package com.argusvane.datum.pdf.api;

import java.security.Principal;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * What a submission's PDF request carries beside the definition and the answers (SPI): the form's translation
 * catalog, and the data-sourced choices' labels resolved into {@code optionSnapshot} (the program never fetches).
 * The defaults give neither: the PDF then prints a
 * data-sourced choice by its value and every text in the definition's own words. A binding wires datum-forms'
 * {@code TranslationCatalogStore} and {@code DataSourceOptions.snapshotFor} here.
 */
public interface PdfDocumentSources {

    /** No catalog and no option lists. */
    PdfDocumentSources NONE = new PdfDocumentSources() {
    };

    /** The form's host translation catalog (locale, kind, owner, tree), or null. */
    default JsonNode translations(String formKey) {
        return null;
    }

    /**
     * The resolved options of the data-sourced choices the answers use, by component id, or null.
     *
     * @param values the sanitized values the PDF prints
     */
    default ObjectNode optionSnapshot(String formKey, ObjectNode definition, ObjectNode values, String locale, Principal principal) {
        return null;
    }
}
