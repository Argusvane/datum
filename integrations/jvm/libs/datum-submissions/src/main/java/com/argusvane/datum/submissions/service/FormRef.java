package com.argusvane.datum.submissions.service;

/**
 * Which form a call to the {@link SubmissionService} is for.
 *
 * <p>The document always names its form ({@code versionContext.form.id}) and its version, and the service judges it
 * against the current definition of that form: the version check is never the caller's to skip. A caller that knows
 * the form from elsewhere (a queue per form, a batch over one form's records) names it with {@link #of(String)}, and a
 * document naming another form is then refused as malformed before anything is asked; the HTTP routes take the form
 * from the document ({@link #fromDocument()}), as the wire contract says.
 *
 * @param key the form's key, or null for the form the document names
 */
public record FormRef(String key) {

    private static final FormRef FROM_DOCUMENT = new FormRef(null);

    /** The form the document names: the HTTP routes' reading. */
    public static FormRef fromDocument() {
        return FROM_DOCUMENT;
    }

    /** This form: the document must name it. */
    public static FormRef of(String key) {
        if (key == null) {
            throw new IllegalArgumentException("Name the form, or use FormRef.fromDocument().");
        }
        return new FormRef(key);
    }
}
