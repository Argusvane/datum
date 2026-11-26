package com.argusvane.datum.pdf.web;

import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.pdf.api.PdfDocumentSources;
import java.security.Principal;
import java.util.Objects;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The default {@link PdfDocumentSources}: datum-forms' translation catalog and data-source options. The catalog is
 * the form's host catalog as the browser reads it (the nested locale, kind, owner, tree shape; it rides as the request's
 * {@code translations}, beside the definition's own {@code formTranslations});
 * the option snapshot lists every source that loads in the PDF's locale (a source that fails is left out, the
 * answer then prints as stored). {@code snapshotFor} blocks while providers answer; the callers run on a thread
 * that may block (the WebFlux handlers use {@code boundedElastic}).
 */
public final class FormsPdfDocumentSources implements PdfDocumentSources {

    private final TranslationCatalogStore catalogs;
    private final DataSourceOptions options;

    public FormsPdfDocumentSources(TranslationCatalogStore catalogs, DataSourceOptions options) {
        this.catalogs = Objects.requireNonNull(catalogs, "catalogs");
        this.options = Objects.requireNonNull(options, "options");
    }

    @Override
    public JsonNode translations(String formKey) {
        ObjectNode catalog = catalogs.read(formKey).catalog();
        return catalog == null || catalog.isEmpty() ? null : catalog;
    }

    @Override
    public ObjectNode optionSnapshot(String formKey, ObjectNode definition, ObjectNode values, String locale, Principal principal) {
        // Item labels are host data resolved by locale alone, never through the catalog.
        ObjectNode snapshot = options.snapshotFor(definition, principal, false, null, locale);
        return snapshot == null || snapshot.isEmpty() ? null : snapshot;
    }
}
