package com.argusvane.datum.submissions.spi;

import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * What a {@link SubmissionPreCheck} sees: the request as read, before anything is judged.
 *
 * <p>The record's components are the form, the mode and the {@link SubmissionContext}; the accessors {@link #headers()},
 * {@link #remoteAddress()}, {@link #bodyDigest()}, {@link #principal()} and {@link #header(String)} read the context, so
 * a pre-check written against them is unchanged. A pre-check that must tell a web request from a queue's reads
 * {@link #channel()}.
 *
 * @param formKey the form the document names
 * @param mode which route
 * @param context who sent it and through what: the principal (the same caller the application's security admitted to
 *     the route, so a rule about who may use a given form, whose key is in the body where no request matcher sees it, is
 *     written here on either web stack; on WebFlux the receiver runs on the elastic
 *     scheduler, where no thread-bound security context exists: read it here), the client facts and headers (an
 *     anti-spam token, a source reference the glue's {@code submit(el, {headers})} sent), the body digest
 */
public record IncomingSubmission(String formKey, SubmissionMode mode, SubmissionContext context) {

    public IncomingSubmission {
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(context, "context");
    }

    /** The request headers, names compared case-insensitively; empty for a channel that has none. */
    public Map<String, List<String>> headers() {
        return context.headers();
    }

    /** The client address, or null. */
    public @Nullable String remoteAddress() {
        return context.remoteAddress();
    }

    /** SHA-256, lowercase hex, of the raw body bytes; null for a caller that handed the service a parsed document. */
    public @Nullable String bodyDigest() {
        return context.bodyDigest();
    }

    /** Who is asking, or null when anonymous. */
    public @Nullable Principal principal() {
        return context.principal();
    }

    /** How the document came in ({@code http} for the routes). */
    public String channel() {
        return context.channel();
    }

    /** The first value of a header, or null. */
    public @Nullable String header(String name) {
        return context.header(name);
    }
}
