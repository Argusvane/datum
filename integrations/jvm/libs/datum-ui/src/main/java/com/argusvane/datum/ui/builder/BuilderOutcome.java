package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.contracts.DefinitionProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the {@link BuilderService} answers: one record per way a builder write can end, with no status code,
 * header or media type in any of them. {@link BuilderApi} maps each to the wire (If-Match, ETag, the removed-locales
 * header, the 413, the statuses); another caller (an import job, a git sync) reads the record.
 *
 * <p>Not an outcome: what the repository, the catalog store or the snapshot store throws on its own beyond the cases named
 * here, and an {@link Error}; they reach the caller unchanged, as they reached the error mapper before.
 */
public sealed interface BuilderOutcome permits BuilderOutcome.Saved, BuilderOutcome.CatalogSaved, BuilderOutcome.Outdated,
    BuilderOutcome.CatalogOutdated, BuilderOutcome.Refused, BuilderOutcome.ReadOnly, BuilderOutcome.Exists, BuilderOutcome.NotFound,
    BuilderOutcome.Malformed, BuilderOutcome.TooLarge, BuilderOutcome.Unavailable, BuilderOutcome.Declined {

    /**
     * The definition is stored, its snapshot recorded and {@code FormDefinitionSavedEvent} published (or a warning says why
     * not).
     *
     * @param key the form
     * @param sha256 the hash of what the repository stored (the read endpoint's ETag)
     * @param version the stored definition's {@code version}, or "" when it has none
     * @param removedLocales the locales whose catalog entries this save dropped (empty when the catalog was not moved)
     * @param catalog the form's catalog after the save (locale, kind, owner, tree)
     * @param warnings the sentences the definition rides back with: the unknown types and the kernel's structure warnings
     *     in words, then the application's {@link BuilderSaveValidator} warnings (each its message, else its code), then
     *     what the save itself could not do (move the catalog, record the snapshot)
     * @param kernelWarnings the kernel's structure warnings, every one
     * @param created whether this was a create
     * @param savedAt when, to the second
     */
    record Saved(String key, String sha256, String version, Set<String> removedLocales, ObjectNode catalog,
                 List<String> warnings, List<DefinitionProblem> kernelWarnings, boolean created, Instant savedAt) implements BuilderOutcome {

        public Saved {
            Objects.requireNonNull(key, "key");
            Objects.requireNonNull(sha256, "sha256");
            // In the order the save found them: the removed-locales header lists them so.
            removedLocales = Collections.unmodifiableSet(new LinkedHashSet<>(removedLocales));
            warnings = List.copyOf(warnings);
            kernelWarnings = List.copyOf(kernelWarnings);
        }
    }

    /**
     * The form's host catalog is stored, normalized.
     *
     * @param key the form
     * @param etag the catalog's new etag
     * @param catalog what is stored
     * @param savedAt when, to the second
     */
    record CatalogSaved(String key, String etag, ObjectNode catalog, Instant savedAt) implements BuilderOutcome {

        public CatalogSaved {
            Objects.requireNonNull(etag, "etag");
        }
    }

    /**
     * The write builds on a definition that is no longer current (another author's save, another tab's).
     *
     * @param currentSha256 the current definition's hash
     * @param currentVersion its version, or null when it is not known (a create that raced another)
     */
    record Outdated(String currentSha256, String currentVersion) implements BuilderOutcome {
    }

    /**
     * The catalog changed since the write's caller read it.
     *
     * @param currentEtag the current catalog's etag
     */
    record CatalogOutdated(String currentEtag) implements BuilderOutcome {
    }

    /**
     * Refused for its content; nothing is stored.
     *
     * @param code {@code definition.refused} (the host's shape findings or the kernel's verdict, one entry each),
     *     {@code definition.tooDeep}, {@code definition.tooCostly} or {@code catalog.invalid}
     * @param errors the findings, each with its code, where it is and a sentence for the author
     * @param cause the kernel's exception behind a {@code definition.tooDeep} or {@code definition.tooCostly}, else null
     */
    record Refused(String code, List<DefinitionShape.Finding> errors, Throwable cause) implements BuilderOutcome {

        public Refused {
            Objects.requireNonNull(code, "code");
            errors = List.copyOf(errors);
        }
    }

    /**
     * The repository cannot save (the resource repository is read-only).
     *
     * @param cause what it threw
     */
    record ReadOnly(FormStoreReadOnlyException cause) implements BuilderOutcome {
    }

    /**
     * A create names a form that exists already.
     *
     * @param key the form
     * @param currentSha256 the existing definition's hash
     */
    record Exists(String key, String currentSha256) implements BuilderOutcome {
    }

    /**
     * No form has the key (a save or a catalog write), or no form could have it.
     *
     * @param key the key as named
     */
    record NotFound(String key) implements BuilderOutcome {
    }

    /**
     * Not a value this write takes: not strict JSON (an unpaired surrogate), a catalog nested too deep, language changes
     * that are not valid.
     *
     * @param reason the host's words
     */
    record Malformed(String reason) implements BuilderOutcome {
    }

    /**
     * The definition or the catalog takes more than the service's cap ({@code datum.builder.max-definition-size}) as JSON
     * text; nothing was checked or stored.
     *
     * @param maxBytes the cap, in bytes
     */
    record TooLarge(long maxBytes) implements BuilderOutcome {
    }

    /**
     * The kernel could not check the definition, so it was not saved (fail closed).
     *
     * @param code {@code server.unavailable}
     * @param reason the sentence for the author
     * @param cause what failed
     */
    record Unavailable(String code, String reason, Throwable cause) implements BuilderOutcome {
    }

    /**
     * An application's hook refused the write: a {@link BuilderSaveCustomizer} before the kernel's check, or
     * the {@link BuilderSaveValidator}s' errors after it; nothing is stored.
     *
     * @param refusal the refusal as the hook made it (its kind, code and problems); for the validators' errors, one
     *     {@code INVALID} refusal with every error in order
     */
    record Declined(HookRefusedException refusal) implements BuilderOutcome {

        public Declined {
            Objects.requireNonNull(refusal, "refusal");
        }
    }
}
