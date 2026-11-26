package com.argusvane.datum.forms.translation;

import com.argusvane.datum.forms.FormOutdatedException;
import tools.jackson.databind.node.ObjectNode;

/**
 * Where a form's host translation catalog lives, apart from the definition. The browser reads it from
 * {@code GET /api/forms/{key}/translations}; the builder writes it
 * with {@code If-Match}.
 */
public interface TranslationCatalogStore {

    /** The catalog and its etag; an empty catalog (with the etag of an empty one) for a form without any. */
    StoredCatalog read(String formKey);

    /**
     * Replaces the catalog. The caller has already dropped the removed locales
     * ({@link TranslationCatalog#afterSave}); the store keeps what it is given, normalized.
     *
     * @param ifMatch the etag the caller read, or null for no precondition
     * @return the new etag
     * @throws FormOutdatedException when {@code ifMatch} is not the stored etag (409)
     */
    String write(String formKey, ObjectNode catalog, String ifMatch);
}
