package com.argusvane.datum.submissions.spi;

import java.security.Principal;
import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A submission every check accepted, as the {@link SubmissionHandler} stores it (rule-check fields and client facts; what the application keeps of them, the
 * address included, is its decision).
 *
 * <p>What a record is stored and signed under comes from the sandbox program: the canonical text
 * of the delivered document, its digest (checked against the host's own canonical form) and the value index.
 *
 * @param formKey the form
 * @param definitionSha256 the hash of the definition it was judged against; the snapshot store keeps that
 *     definition, so it resolves later for re-validation, amendment and export
 * @param digest SHA-256 of {@code canonicalDocument}, lowercase hex
 * @param canonicalDocument the delivered document (envelope or signed wrapper) as canonical JSON text
 * @param values the sanitized values the sandbox kept
 * @param warnings the findings that did not block, the sandbox's then the validators'
 * @param runLog the run's log entries, as the program gave them
 * @param clockDependent components whose rules read the day
 * @param serverRules components a server-only rule applied to
 * @param visibilitySkipped components whose own visibleWhen the server could not replay
 * @param clientDerived value paths of answers worked out in the browser and kept as sent
 * @param remoteAddress the client address, or null: always there for the HTTP routes (the address after the
 *     application's forwarded-header handling), optional for another channel
 * @param userAgent the User-Agent, or null: the HTTP request's header, optional for another channel
 * @param signature the signature verdict, or null when no {@link SubmissionSignatureCheck} is present
 * @param locale the locale the person answered in
 * @param journeyId the journey the answers were judged by, or null
 * @param index the value index rows {@code {path, delta, value}} of {@code values}
 * @param principal who submitted, or null when anonymous
 * @param channel how the document came in ({@link SubmissionContext#channel()}: {@code http} for the routes, the
 *     caller's word for a queue, a batch or a sync)
 * @param submissionKey the key of the submit attempt ({@link SubmissionContext#submissionKey()}): the same on every
 *     retry of one attempt and different for two attempts with the same answers, so a handler that must store an
 *     attempt once keeps a unique key on the form key and this key (the digest is no such key: two people
 *     who give the same answers share it)
 */
public record AcceptedSubmission(String formKey, String definitionSha256, String digest, String canonicalDocument,
                                 ObjectNode values, List<SubmissionError> warnings, ArrayNode runLog,
                                 List<String> clockDependent, List<String> serverRules, List<String> visibilitySkipped,
                                 List<String> clientDerived, @Nullable String remoteAddress, @Nullable String userAgent,
                                 @Nullable SignatureVerdict signature, String locale, @Nullable String journeyId, ArrayNode index,
                                 @Nullable Principal principal, String channel, String submissionKey) {

    public AcceptedSubmission {
        Objects.requireNonNull(formKey, "formKey");
        Objects.requireNonNull(definitionSha256, "definitionSha256");
        Objects.requireNonNull(digest, "digest");
        Objects.requireNonNull(canonicalDocument, "canonicalDocument");
        Objects.requireNonNull(values, "values");
        Objects.requireNonNull(channel, "channel");
        Objects.requireNonNull(submissionKey, "submissionKey");
        warnings = warnings == null ? List.of() : List.copyOf(warnings);
        clockDependent = clockDependent == null ? List.of() : List.copyOf(clockDependent);
        serverRules = serverRules == null ? List.of() : List.copyOf(serverRules);
        visibilitySkipped = visibilitySkipped == null ? List.of() : List.copyOf(visibilitySkipped);
        clientDerived = clientDerived == null ? List.of() : List.copyOf(clientDerived);
    }
}
