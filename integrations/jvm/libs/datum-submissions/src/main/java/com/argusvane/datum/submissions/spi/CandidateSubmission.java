package com.argusvane.datum.submissions.spi;

import java.util.Objects;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A submission the sandbox has judged and not refused, as the signature check and the validators see it.
 *
 * <p>Every node is the receiver's own copy for this request; treat them as read-only (a validator that changed
 * {@code values} would change what the next validator reads, never what is stored).
 *
 * @param formKey the form
 * @param mode which route
 * @param definition the server's current definition the answers were judged against
 * @param definitionSha256 its canonical SHA-256
 * @param document the delivered document exactly as received (an envelope, or a signed wrapper); null for a
 *     journey check, which has none
 * @param envelope the envelope (the wrapper's payload); for a journey check, one built from the request as
 *     the envelope's shape ({@code versionContext.form{id, version}}, {@code submission{locale, values,
 *     journey{id}}})
 * @param values the values the sandbox judged: its sanitized values (or, for a check that blocked elsewhere,
 *     its {@code submittable}); never the raw answers
 * @param locale the locale the person answered in
 * @param scope what is judged
 * @param context the sandbox context the run read (a copy, the host's keys included)
 * @param submissionContext who sent it and through what (the transport-neutral context replaced the HTTP
 *     request view {@code request}; its principal, headers and client facts read as the request's did)
 */
public record CandidateSubmission(String formKey, SubmissionMode mode, ObjectNode definition, String definitionSha256,
                                  @Nullable JsonNode document, ObjectNode envelope, ObjectNode values, String locale,
                                  ValidationScope scope, ObjectNode context, SubmissionContext submissionContext) {

    public CandidateSubmission {
        Objects.requireNonNull(formKey, "formKey");
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(values, "values");
        Objects.requireNonNull(scope, "scope");
        Objects.requireNonNull(submissionContext, "submissionContext");
    }
}
