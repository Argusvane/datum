package com.argusvane.datum.forms;

import tools.jackson.databind.node.ObjectNode;

/** A form's definition with its canonical SHA-256, the version a submission names ({@code definitionSha256}). */
public record CurrentDefinition(ObjectNode definition, String sha256) {
}
