package com.argusvane.datum.forms.translation;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.forms.FormOutdatedException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import tools.jackson.databind.node.ObjectNode;

/** The default store: catalogs in memory, lost on restart. Applications that edit translations provide their own bean. */
public final class InMemoryTranslationCatalogStore implements TranslationCatalogStore {

    private final Map<String, StoredCatalog> catalogs = new ConcurrentHashMap<>();

    /** The etag of a catalog. */
    public static String etag(ObjectNode catalog) {
        return CanonicalJson.digest(catalog);
    }

    @Override
    public StoredCatalog read(String formKey) {
        StoredCatalog stored = catalogs.get(formKey);
        if (stored == null) {
            return new StoredCatalog(TranslationCatalog.empty(), etag(TranslationCatalog.empty()));
        }
        return new StoredCatalog(stored.catalog().deepCopy(), stored.etag());
    }

    @Override
    public String write(String formKey, ObjectNode catalog, String ifMatch) {
        ObjectNode clean = TranslationCatalog.normalize(catalog);
        String etag = etag(clean);
        StoredCatalog[] outdated = new StoredCatalog[1];
        catalogs.compute(formKey, (key, current) -> {
            String currentEtag = current == null ? etag(TranslationCatalog.empty()) : current.etag();
            if (ifMatch != null && !ifMatch.equals(currentEtag)) {
                outdated[0] = new StoredCatalog(TranslationCatalog.empty(), currentEtag);
                return current;
            }
            return new StoredCatalog(clean, etag);
        });
        if (outdated[0] != null) {
            throw new FormOutdatedException(outdated[0].etag());
        }
        return etag;
    }
}
