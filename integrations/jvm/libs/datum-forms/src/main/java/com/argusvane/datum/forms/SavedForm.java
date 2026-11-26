package com.argusvane.datum.forms;

/** What a save answers: the key the form is stored under and the hash of the stored definition. */
public record SavedForm(String key, String sha256) {
}
