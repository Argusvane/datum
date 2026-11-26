package com.argusvane.datum.forms.translation;

import tools.jackson.databind.node.ObjectNode;

/** A form's catalog (the nested locale, kind, owner, tree shape) with its etag (the SHA-256 of the catalog's canonical JSON), for {@code If-Match}. */
public record StoredCatalog(ObjectNode catalog, String etag) {
}
