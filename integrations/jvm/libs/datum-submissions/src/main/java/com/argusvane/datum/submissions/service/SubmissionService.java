package com.argusvane.datum.submissions.service;

import com.argusvane.datum.core.CountedAddress;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.observation.DatumObservation;
import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import com.argusvane.datum.sandbox.protocol.JsonSize;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxResult;
import com.argusvane.datum.forms.CurrentDefinition;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.StoredCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.submissions.events.JourneyCheckedEvent;
import com.argusvane.datum.submissions.events.SubmissionRedeliveredEvent;
import com.argusvane.datum.submissions.events.SubmissionRejectedEvent;
import com.argusvane.datum.submissions.events.SubmissionThrottledEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Accepted;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Checked;
import com.argusvane.datum.submissions.service.SubmissionOutcome.DryRun;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Malformed;
import com.argusvane.datum.submissions.service.SubmissionOutcome.NotFound;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Outdated;
import com.argusvane.datum.submissions.service.SubmissionOutcome.KeyConflict;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Redelivered;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Refused;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Rejected;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Throttled;
import com.argusvane.datum.submissions.service.SubmissionOutcome.TooLarge;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Unavailable;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.ContextBuilder;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.HostContextRequest;
import com.argusvane.datum.submissions.spi.HostOptionsCustomizer;
import com.argusvane.datum.submissions.spi.IncomingSubmission;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.sandbox.protocol.RunSettings;
import com.argusvane.datum.submissions.spi.SandboxContextContributor;
import com.argusvane.datum.submissions.spi.SandboxRulesProvider;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.SubmissionValidator;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.submissions.spi.ValidationScope;
import com.argusvane.datum.submissions.spi.ValidatorResult;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Map.Entry;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The submission pipeline with no transport in it: a delivery, a journey's check or a
 * dry run of one document, judged for any caller (the HTTP routes through {@code SubmissionReceiver}, a queue consumer, a
 * JDBC batch, a syncing device, a re-validation of stored records on the form's current version) and answered as a
 * {@link SubmissionOutcome}. Nothing here
 * names a status code, a header or a media type; the receiver maps the outcome to the wire (the endpoint
 * catalog).
 *
 * <p>The steps, in order, each refusal before anything costlier, the same for every caller:
 * <ol>
 *   <li>the size cap ({@link Builder#maxDocumentBytes}, the binding's {@code datum.web.api.max-body-size}): a document
 *       whose JSON text takes more ({@link JsonSize}, the fewest bytes any text of the tree can take) is {@link TooLarge}
 *       before anything else walks it. A route has refused the bytes past the same cap before, so a body it read never
 *       meets this; a caller with no bytes (a tree built or read elsewhere) is held to the cap here;</li>
 *   <li>the document's rules: what strict JSON refuses (an unpaired UTF-16 surrogate in a string or a key), the nesting
 *       ({@value #DOCUMENT_DEPTH}), a number outside the range of a double, an object, no check members on a delivery, a
 *       signed wrapper of exactly format, payload and signatures, the form it names (a key no form can have is not found,
 *       never echoed; a {@link FormRef} that names another form is malformed), the values object, a check's journey id,
 *       the locale ({@link Malformed}, {@link NotFound}); a delivery's submission key, which its context must carry
 *       ({@link SubmissionContext#withSubmissionKey}; {@link Malformed} without one);</li>
 *   <li>the per-form throttle, kind by mode, under the context's throttle key ({@link Throttled}; the attempt is recorded
 *       once allowed; a context with no key, and the check behind a PDF, is not counted here). The address limit is not a
 *       step here: a route asks {@link #admitAddress} before it reads the body, so it has counted the request before any
 *       of these steps;</li>
 *   <li>the pre-check hooks, which see the {@link SubmissionContext} ({@link Refused});</li>
 *   <li>the definition, through datum-forms' {@link DefinitionService} (which snapshots each version the first time it is
 *       seen, so an accepted record's {@code definitionSha256} always resolves later): the form must exist
 *       ({@link NotFound}) and the document's {@code versionContext.form.version} must be the current definition's
 *       {@code version} ({@link Outdated});</li>
 *   <li>for a delivery, a submit attempt the {@link SubmissionIdempotencyStore} already knows (same form, version and
 *       submission key, whichever channel brought it first) is answered before the document is judged: {@link Redelivered}
 *       with its first receipt, no run and no handler, and {@link SubmissionRedeliveredEvent} when the digest (the host's
 *       canonical digest of the document) is the same, and {@link KeyConflict} when it is not, whatever the other document
 *       holds. The store is asked here and told after the handler, with no lock between: two deliveries of one attempt
 *       in flight at once (a device's sync beside a browser's retry) can both reach the handler, so a handler keeps a
 *       unique key on the form key and {@link AcceptedSubmission#submissionKey()} (the routes have always had this
 *       race);</li>
 *   <li>the journey the answers were given through ({@code journey.unknown} / {@code journey.required}: a delivery's
 *       {@link Rejected} at stage {@code journey}; a check answers them in its {@link Checked} verdict);</li>
 *   <li>the option snapshot of the form's data sources (a source that cannot answer is {@code server.unavailable},
 *       whatever it threw);</li>
 *   <li>the sandbox over the server's own definition, with the rule modules, the host options customizers, the
 *       contributors, the {@link HostContextProvider}'s {@code hostContext} (asked once, after the contributors, never read
 *       from the document; a provider that fails is {@code server.unavailable}) and the delivered document; a run that
 *       gives no verdict is {@link Unavailable} with its own code; an
 *       outcome without the canonical document, digest and index, or whose digest is not the host's, is
 *       {@code validator_unavailable}; a blocking error is a refusal at stage {@code sandbox};</li>
 *   <li>the signature check, when a {@link SubmissionSignatureCheck} exists (stage {@code signature});</li>
 *   <li>the validators, in order (stage {@code server}; a validator that throws is {@code validator_unavailable};
 *       warnings never block);</li>
 *   <li>for a delivery: the signature's {@code recordUse}, the {@link SubmissionHandler} (a handler that fails after the
 *       use was recorded has it released, {@code releaseUse}), the idempotency store told, the signature's {@code stored}
 *       with the receipt, then {@link SubmissionValidatedEvent} ({@link Accepted}).</li>
 * </ol>
 * A delivery refused at the journey, sandbox, signature or server stage publishes {@link SubmissionRejectedEvent}; a
 * throttled delivery or check {@link SubmissionThrottledEvent}; a check {@link JourneyCheckedEvent} with its verdict.
 * Every event carries the context's channel. A dry run publishes nothing (not even when throttled), calls no handler and
 * records no signature use; its run log is not relayed. A hook (contributor, customizer, rule provider, signature check,
 * validator) that fails with an {@link Exception} is {@link Unavailable}; one that throws a {@link DatumException} of its
 * own where the hook may refuse (customizer, contributor, rule provider, signature check), and every {@link Error}, reach
 * the caller as thrown, and nothing is handled. Through the host's default publisher ({@link DatumEventPublisher#guarded}) a listener that throws is logged and never changes the outcome; an application's own publisher is used as given, and
 * one that throws reaches the caller after the effect.
 *
 * <p>Who may submit is never asked here: on the routes it is the application's security in front of them,
 * for another caller the code that calls the service. A rule that depends on the form is a {@link SubmissionPreCheck}.
 */
public final class SubmissionService {

    private static final Logger LOG = LoggerFactory.getLogger(SubmissionService.class);

    /** The deepest document accepted (security suite REC-04). */
    public static final int DOCUMENT_DEPTH = 64;

    /** The code of a verdict that could not be reached for a reason that is not the answers'. */
    public static final String VALIDATOR_UNAVAILABLE = "validator_unavailable";

    /** A locale is a language tag of letters, digits and hyphens. */
    static final Pattern LOCALE = Pattern.compile("^[A-Za-z0-9-]{1,32}$");

    /** The members of a signed wrapper (placement "wrapper"). */
    private static final Set<String> WRAPPER_MEMBERS = Set.of("format", "payload", "signatures");

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private final Supplier<? extends Sandbox> sandbox;
    private final DefinitionService definitions;
    private final DataSourceOptions dataSources;
    // Null: the host keeps no translation catalog, so a run carries the definition's map alone.
    private final TranslationCatalogStore catalogs;
    private final String unknownFields;
    private final String logLevel;
    private final SubmissionHandler handler;
    private final SubmissionThrottle throttle;
    private final List<SubmissionPreCheck> preChecks;
    private final List<SubmissionValidator> validators;
    private final List<SandboxRulesProvider> rulesProviders;
    private final List<SandboxContextContributor> contributors;
    private final List<HostOptionsCustomizer> customizers;
    // Null: no provider, so no run carries a host context (the lenient reading).
    private final HostContextProvider hostContext;
    private final SubmissionSignatureCheck signatureCheck;
    private final SubmissionIdempotencyStore idempotency;
    private final DatumEventPublisher events;
    private final DatumObservations observations;
    private final long maxDocumentBytes;

    private SubmissionService(Builder b) {
        this.sandbox = Objects.requireNonNull(b.sandbox, "sandbox");
        this.definitions = Objects.requireNonNull(b.definitions, "definitions");
        this.dataSources = Objects.requireNonNull(b.dataSources, "dataSources");
        this.catalogs = b.catalogs;
        // The two words are checked here, at build, not first on a run: a service wired with a word the program does
        // not read would otherwise answer every submission with an error (RunSettings refuses it either way).
        RunSettings configured = new RunSettings(b.unknownFields, b.logLevel);
        this.unknownFields = configured.getUnknownFields();
        this.logLevel = configured.getLogLevel();
        this.handler = Objects.requireNonNull(b.handler, "handler");
        this.throttle = b.throttle;
        this.preChecks = List.copyOf(b.preChecks);
        this.validators = List.copyOf(b.validators);
        this.rulesProviders = List.copyOf(b.rulesProviders);
        this.contributors = List.copyOf(b.contributors);
        this.customizers = List.copyOf(b.customizers);
        this.hostContext = b.hostContext;
        this.signatureCheck = b.signatureCheck;
        this.idempotency = b.idempotency;
        // As given: the host's default publisher is the guarded one (a listener's failure is logged and never the
        // outcome); an application's own publisher owns its failures, and one that throws reaches the caller.
        this.events = Objects.requireNonNull(b.events, "events");
        this.observations = Objects.requireNonNull(b.observations, "observations");
        this.maxDocumentBytes = b.maxDocumentBytes;
    }

    /** A builder; every collaborator but the optional hooks is required. */
    public static Builder builder() {
        return new Builder();
    }

    /** The size cap a document is held to, in bytes of its JSON text ({@link Builder#maxDocumentBytes}). */
    public long maxDocumentBytes() {
        return maxDocumentBytes;
    }

    /**
     * A delivery: judged, handed to the {@link SubmissionHandler} once, events published.
     *
     * @param form the form ({@link FormRef#fromDocument()} for the one the document names)
     * @param document the delivered document: the envelope, or a signed wrapper of it
     * @param context who sent it and through what
     * @return {@link Accepted}, {@link Redelivered}, {@link Rejected}, or a refusal before the verdict
     */
    public SubmissionOutcome submit(FormRef form, JsonNode document, SubmissionContext context) {
        return run(SubmissionMode.SUBMIT, form, document, null, null, context);
    }

    /** {@link #validate(FormRef, JsonNode, JourneyCheck, SubmissionContext)} of the whole journey. */
    public SubmissionOutcome validate(FormRef form, JsonNode document, SubmissionContext context) {
        return validate(form, document, JourneyCheck.journey(), context);
    }

    /**
     * A journey's check: a page or the whole journey judged, nothing kept.
     *
     * @return {@link Checked}, or a refusal before the verdict
     */
    public SubmissionOutcome validate(FormRef form, JsonNode document, JourneyCheck check, SubmissionContext context) {
        Objects.requireNonNull(check, "check");
        return run(SubmissionMode.VALIDATE, form, document, check, null, context);
    }

    /** {@link #test(FormRef, JsonNode, String, SubmissionContext)} at the form's own log level. */
    public SubmissionOutcome test(FormRef form, JsonNode document, SubmissionContext context) {
        return test(form, document, null, context);
    }

    /**
     * A dry run: every check of a delivery, reported, and nothing kept, handed on or published.
     *
     * @param logLevel the run's own log level over the form's ({@link RunSettings#LOG_LEVELS}), or null; another word is
     *     ignored, as the dry-run route ignores it
     * @return {@link DryRun}, or a refusal before the verdict
     */
    public SubmissionOutcome test(FormRef form, JsonNode document, String logLevel, SubmissionContext context) {
        String level = logLevel != null && RunSettings.LOG_LEVELS.contains(logLevel) ? logLevel : null;
        return run(SubmissionMode.TEST, form, document, null, level, context);
    }

    /**
     * The answers behind a PDF request ({@link SubmissionMode#PDF}): judged exactly as a dry run and not counted by the
     * throttle, which the PDF facade asked once under kind {@code pdf} before it came here.
     *
     * @return {@link DryRun}, or a refusal before the verdict
     */
    public SubmissionOutcome pdfCheck(FormRef form, JsonNode document, SubmissionContext context) {
        return run(SubmissionMode.PDF, form, document, null, null, context);
    }

    /**
     * One call, observed: {@value DatumObservationNames#SUBMISSION} with the mode and the channel from the
     * start, the outcome and the stage at the end, and the form's key (high-cardinality) once the form was found, so a key
     * no form has never reaches a trace. The sandbox run, the data sources and the hooks it calls are its children.
     */
    private SubmissionOutcome run(SubmissionMode mode, FormRef form, JsonNode document, JourneyCheck check, String level,
                                  SubmissionContext context) {
        Objects.requireNonNull(form, "form");
        Objects.requireNonNull(document, "document");
        Objects.requireNonNull(context, "context");
        String modeWord = mode.name().toLowerCase(Locale.ROOT);
        DatumObservation observation = observations.start(DatumObservationNames.SUBMISSION, "datum submission " + modeWord,
            DatumObservationNames.MODE, modeWord, DatumObservationNames.CHANNEL, context.channel());
        try {
            SubmissionOutcome outcome = judged(mode, form, document, check, level, context, observation);
            observation.lowCardinality(DatumObservationNames.OUTCOME, outcomeWord(outcome))
                .lowCardinality(DatumObservationNames.STAGE, stageOf(outcome));
            return outcome;
        } catch (RuntimeException | Error e) {
            observation.lowCardinality(DatumObservationNames.OUTCOME, DatumObservations.outcomeOf(e))
                .lowCardinality(DatumObservationNames.STAGE, DatumObservationNames.NONE).error(e);
            throw e;
        } finally {
            observation.close();
        }
    }

    /** An outcome as one fixed word, for the observation. */
    static String outcomeWord(SubmissionOutcome outcome) {
        if (outcome instanceof Accepted) {
            return "accepted";
        } else if (outcome instanceof Redelivered) {
            return "redelivered";
        } else if (outcome instanceof Rejected) {
            return "rejected";
        } else if (outcome instanceof Checked) {
            return "checked";
        } else if (outcome instanceof DryRun) {
            return "dry_run";
        } else if (outcome instanceof Outdated) {
            return "outdated";
        } else if (outcome instanceof NotFound) {
            return "not_found";
        } else if (outcome instanceof Malformed) {
            return "malformed";
        } else if (outcome instanceof KeyConflict) {
            return "key_conflict";
        } else if (outcome instanceof TooLarge) {
            return "too_large";
        } else if (outcome instanceof Refused) {
            return "refused";
        } else if (outcome instanceof Throttled) {
            return "throttled";
        }
        return "unavailable";
    }

    /** Where a delivery or a dry run was refused ({@code journey}, {@code sandbox}, {@code signature}, {@code server}), else none. */
    static String stageOf(SubmissionOutcome outcome) {
        if (outcome instanceof Rejected rejected) {
            return rejected.stage();
        }
        if (outcome instanceof DryRun dryRun && dryRun.stage() != null) {
            return dryRun.stage();
        }
        return DatumObservationNames.NONE;
    }

    private SubmissionOutcome judged(SubmissionMode mode, FormRef form, JsonNode document, JourneyCheck check, String level,
                                     SubmissionContext context, DatumObservation observation) {
        try {
            Read read = read(form, document, mode, check, level);
            // A delivery belongs to a submit attempt: without its key a retry could not be told from another person's
            // identical answers, so it is never received.
            if (mode == SubmissionMode.SUBMIT && context.submissionKey() == null) {
                return new Malformed("A delivery carries the submission key of its submit attempt (submissionKey).");
            }

            // The throttle: a refused request costs no run. A PDF request was counted once, under kind pdf, by the facade.
            if (mode != SubmissionMode.PDF) {
                throttle(read.formKey(), context, mode);
            }

            preCheck(read.formKey(), context, mode);

            // The definition and its version. DefinitionService snapshots the version the first time its hash is seen,
            // so the sha256 an accepted record carries resolves later (re-validation, amendment, export) even for a
            // repository that never saves; the repository itself would not.
            CurrentDefinition current;
            try {
                current = definitions.current(read.formKey());
            } catch (FormNotFoundException e) {
                return new NotFound(read.formKey());
            }
            // Found: the key names a form of this host, so it may be a (high-cardinality) key of the observation.
            observation.highCardinality(DatumObservationNames.FORM, read.formKey());
            String version = versionOf(current.definition());
            JsonNode posted = read.envelope().path("versionContext").path("form").path("version");
            if (!posted.isString() || !posted.stringValue().equals(version)) {
                return new Outdated(version, current.sha256());
            }

            return mode == SubmissionMode.VALIDATE ? check(read, current, version, context) : deliver(read, current, context, mode);
        } catch (Stop stop) {
            return stop.outcome;
        }
    }

    // ------------------------------------------------------------------------------------------ reading

    /** A document read: the form, the document and its envelope, the answers, the locale, a check's scope. */
    private record Read(String formKey, ObjectNode document, ObjectNode envelope, ObjectNode values, String locale,
                        String scope, String pageId, JsonNode journeyId, String logLevel) {
    }

    /**
     * The document's rules. The HTTP receiver has checked the body around the document before (its JSON, its wrapper's
     * members), so for a request on the routes the first four rules here hold already; another caller meets them here.
     */
    private Read read(FormRef form, JsonNode document, SubmissionMode mode, JourneyCheck check, String level) {
        // First: every rule below walks the whole tree, and a caller with no bytes has had no cap applied to it. The
        // measure never exceeds the bytes of a text that reads as the tree, so a body a route took is never refused here.
        if (JsonSize.exceeds(document, maxDocumentBytes)) {
            throw new Stop(new TooLarge(maxDocumentBytes));
        }
        if (holdsUnpairedSurrogate(document)) {
            throw malformed("The submission is not JSON.");
        }
        if (DefinitionDepth.jsonDepth(document) > DOCUMENT_DEPTH) {
            throw malformed("The submission nests more than " + DOCUMENT_DEPTH + " levels deep.");
        }
        // 1e999 and an integer too long for a double could not be written into the run's context:
        // Jackson reads the first as an infinite double, the second as a BigInteger the kernel's JSON.parse would
        // turn into Infinity.
        if (hasNonFiniteNumber(document)) {
            throw malformed("The submission holds a number outside the range of a number.");
        }
        if (!document.isObject()) {
            throw malformed("The submission is not a JSON object.");
        }
        ObjectNode doc = (ObjectNode) document;
        // A journey's check sent as a delivery by mistake: checks are their own call, which keeps nothing.
        if (mode != SubmissionMode.VALIDATE && (isSet(doc, "scope") || isSet(doc, "pageId"))) {
            throw malformed("This is a check, not a submission.");
        }

        // A signed wrapper (placement "wrapper") carries the envelope as its payload and is exactly format,
        // payload and signatures: a member beside them would be kept but never judged. Any payload member makes a document a wrapper.
        ObjectNode envelope = doc;
        if (doc.has("payload")) {
            for (String name : doc.propertyNames()) {
                if (!WRAPPER_MEMBERS.contains(name)) {
                    throw malformed("A signed document holds only format, payload and signatures.");
                }
            }
            if (!doc.path("signatures").isArray() || !doc.path("format").isObject() || !doc.get("payload").isObject()) {
                throw malformed("A signed document needs a signing format, a payload object and a list of signatures.");
            }
            envelope = (ObjectNode) doc.get("payload");
        }

        JsonNode formId = envelope.path("versionContext").path("form").path("id");
        if (!formId.isString()) {
            throw malformed("The submission names no form.");
        }
        if (!FormKeys.isValid(formId.stringValue())) {
            // No form can have such a key: answered as unknown without asking a repository, and never echoed.
            throw new Stop(new NotFound(formId.stringValue()));
        }
        if (form.key() != null && !form.key().equals(formId.stringValue())) {
            // The caller said which form this is and the document names another: judging it against either would be
            // judging what the caller did not mean.
            throw malformed("The submission names another form.");
        }
        JsonNode values = envelope.path("submission").path("values");
        if (!values.isObject()) {
            throw malformed("The submission has no values object.");
        }

        JsonNode journeyId = null;
        if (mode == SubmissionMode.VALIDATE) {
            // A check's journey id is a string or none; a non-string is a malformed check.
            JsonNode named = envelope.path("submission").get("journey");
            JsonNode id = named == null ? null : (named.isObject() ? named.get("id") : named);
            if (id != null && !id.isNull() && !id.isString()) {
                throw malformed("A check names its journey by a string id.");
            }
            journeyId = id == null || id.isNull() ? null : id;
        }

        JsonNode localeNode = envelope.path("submission").get("locale");
        String locale;
        if (localeNode == null || localeNode.isNull()) {
            locale = "en";
        } else if (localeNode.isString() && LOCALE.matcher(localeNode.stringValue()).matches()) {
            locale = localeNode.stringValue();
        } else if (mode == SubmissionMode.VALIDATE) {
            // A check reads a locale that is not a tag as "en" (it keeps nothing); a delivery is refused for it.
            locale = "en";
        } else {
            throw malformed("The submission locale is not a language tag.");
        }
        String scope = check == null ? null : check.scope();
        String pageId = check == null ? null : check.pageId();
        return new Read(formId.stringValue(), doc, envelope, (ObjectNode) values, locale, scope, pageId, journeyId, level);
    }

    /** Present and not null. */
    private static boolean isSet(ObjectNode node, String name) {
        JsonNode value = node.get(name);
        return value != null && !value.isNull();
    }

    /**
     * Whether a parsed value holds a number JSON cannot write back: any number whose double is not finite, so a
     * BigInteger or BigDecimal past the range of a double counts as an infinity. Iterative; the nesting is bounded by the
     * mapper's limit or by the caller's tree.
     */
    public static boolean hasNonFiniteNumber(JsonNode value) {
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(value);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            if (node.isContainer()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            } else if (node.isNumber() && !Double.isFinite(asDouble(node))) {
                return true;
            }
        }
        return false;
    }

    /**
     * A number as a double, with a BigInteger or BigDecimal past the range of one as an infinity (Jackson 3's own
     * {@code doubleValue()} throws for those rather than answering).
     */
    private static double asDouble(JsonNode number) {
        if (number.isBigInteger()) {
            return number.bigIntegerValue().doubleValue();
        }
        if (number.isBigDecimal()) {
            return number.decimalValue().doubleValue();
        }
        return number.doubleValue();
    }

    /**
     * Whether a parsed value holds what strict JSON refuses but Jackson reads: an unpaired UTF-16 surrogate escape in a
     * string or a key (the conformance suite's lone-surrogate row, REC-02). The same reading as datum-core's
     * {@code StrictJson} (a key starting with NUL is read: the suite's CAN-07 row for it is advisory). Iterative.
     */
    public static boolean holdsUnpairedSurrogate(JsonNode value) {
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(value);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            if (node.isString() && unpaired(node.stringValue())) {
                return true;
            }
            if (node.isObject()) {
                for (Entry<String, JsonNode> entry : node.properties()) {
                    if (unpaired(entry.getKey())) {
                        return true;
                    }
                    stack.push(entry.getValue());
                }
            } else if (node.isArray()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            }
        }
        return false;
    }

    /** Whether a text holds a UTF-16 surrogate that is not half of a pair. */
    static boolean unpaired(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++;
                    continue;
                }
                return true;
            }
            if (Character.isLowSurrogate(c)) {
                return true;
            }
        }
        return false;
    }

    /** The definition's version: a string, else "". */
    private static String versionOf(JsonNode definition) {
        JsonNode version = definition.path("version");
        return version.isString() ? version.stringValue() : "";
    }

    // ------------------------------------------------------------------------------------------ throttle, pre-check

    /**
     * The address limit, which a route asks before it reads the body ({@link SubmissionThrottle#admitAddress}): one request
     * from the client address counted, whatever the body turns out to hold. The per-form throttle in the steps above
     * needs the form the document names, so a body that never parses would never reach it; this count does not wait for
     * the body. A refusal is the per-form throttle's own: {@link Throttled} with the throttle's wait, and for every mode but
     * a dry run the same {@link SubmissionThrottledEvent}, its key naming only the counted address and the route's kind.
     * Only callers that read a body from a client ask this: a queue or a batch has no address to count.
     *
     * @param remoteAddress the client address as the request gives it, or null (not counted)
     * @param mode which route
     * @param channel how the request came in ({@code http} for the routes)
     * @return the refusal, or null when the request may go on (and was counted)
     */
    public @Nullable Throttled admitAddress(@Nullable String remoteAddress, SubmissionMode mode, String channel) {
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(channel, "channel");
        ThrottleDecision.Deny deny = SubmissionThrottle.admitAddress(throttle, remoteAddress);
        if (deny == null) {
            return null;
        }
        ThrottleKey key = new ThrottleKey(CountedAddress.of(remoteAddress), null, null, ThrottleKey.kindOf(mode), channel);
        // As the per-form refusal: a dry run publishes nothing, not even its throttling.
        if (!mode.dryRun()) {
            publish(new SubmissionThrottledEvent(key, key.kind(), deny.retryAfter(), channel));
        }
        // The refusal is observed as the per-form one is, dry run included, so the refused count of a flood shows in the
        // metrics: the refusal ends the call before a form is read, so the observation has no form key.
        observations.start(DatumObservationNames.SUBMISSION, "datum submission " + mode.name().toLowerCase(Locale.ROOT),
                DatumObservationNames.MODE, mode.name().toLowerCase(Locale.ROOT), DatumObservationNames.CHANNEL, channel)
            .lowCardinality(DatumObservationNames.OUTCOME, "throttled")
            .lowCardinality(DatumObservationNames.STAGE, DatumObservationNames.NONE)
            .close();
        return new Throttled(deny.retryAfter(), key);
    }

    private void throttle(String formKey, SubmissionContext context, SubmissionMode mode) {
        ThrottleKey.Caller caller = context.throttleKey();
        if (throttle == null || caller == null) {
            return;
        }
        // The throttle sees the address it counts (CountedAddress: an IPv6 client by its /64), so a replacement throttle keys alike.
        ThrottleKey key = new ThrottleKey(CountedAddress.of(caller.ip()), formKey, caller.principal(), ThrottleKey.kindOf(mode), context.channel());
        ThrottleDecision decision = throttle.check(key);
        if (decision instanceof ThrottleDecision.Deny deny) {
            // A dry run (testSubmission) publishes nothing, not even its throttling: a form's author testing it is not abuse.
            if (!mode.dryRun()) {
                publish(new SubmissionThrottledEvent(key, key.kind(), deny.retryAfter(), context.channel()));
            }
            throw new Stop(new Throttled(deny.retryAfter(), key));
        }
        // Counted before any later check may refuse it: a refusal counts like any other attempt.
        throttle.record(key);
    }

    private void preCheck(String formKey, SubmissionContext context, SubmissionMode mode) {
        if (preChecks.isEmpty()) {
            return;
        }
        IncomingSubmission incoming = new IncomingSubmission(formKey, mode, context);
        for (SubmissionPreCheck check : preChecks) {
            PreCheckDecision decision = check.check(incoming);
            if (decision instanceof PreCheckDecision.Reject reject) {
                LOG.info("Submission to {} refused by a pre-check ({}).", formKey, reject.code());
                throw new Stop(new Refused(reject));
            }
        }
    }

    // ------------------------------------------------------------------------------------------ a delivery or a dry run

    /** What a delivery's judgement gathered, for the dry run's report. */
    private static final class Judgement {
        ObjectNode context;
        List<String> ruleIds = List.of();
        SandboxResult result;
        ObjectNode sanitized;
        String canonical;
        String digest;
        SignatureVerdict signature;
    }

    private SubmissionOutcome deliver(Read read, CurrentDefinition current, SubmissionContext context, SubmissionMode mode) {
        boolean real = mode == SubmissionMode.SUBMIT;
        ObjectNode definition = current.definition();
        Judgement judged = new Judgement();
        String formVersion = versionOf(definition);

        // A submission is its attempt's key, not its answers, so the key is asked first, before the document is judged:
        // the key this form accepted before, on any channel, with the same digest is a retry, answered with the first
        // receipt and handled: true, with no run, signature check, validator or handler (they judged it the first time
        // and the digest covers every byte, version context included). The same key with another document is refused,
        // whatever that document holds, and never answered with the first receipt, so a guessed key reads nothing and
        // every host answers it alike. Only a real delivery asks: a dry run and a check store nothing.
        if (real && idempotency != null) {
            String digest = CanonicalJson.digest(read.document());
            SubmissionIdempotencyStore.Remembered first;
            try {
                first = idempotency.find(read.formKey(), formVersion, context.submissionKey()).orElse(null);
            } catch (Exception e) {
                LOG.error("The idempotency store for {} failed: {}", read.formKey(), e.getMessage(), e);
                throw validatorUnavailable("The idempotency store could not answer.", e);
            }
            if (first != null) {
                if (!MessageDigest.isEqual(first.digest().getBytes(StandardCharsets.US_ASCII), digest.getBytes(StandardCharsets.US_ASCII))) {
                    return new KeyConflict(digest);
                }
                publish(new SubmissionRedeliveredEvent(read.formKey(), digest, first.receipt(), context.channel()));
                return new Redelivered(first.receipt(), digest);
            }
        }

        // The journey the answers were given through, taken from the server's definition. One that names none
        // is judged by the form's default journey, or refused when a form with journeys has none: leaving the journey out
        // must not leave out its exit page.
        JsonNode named = read.envelope().path("submission").get("journey");
        JsonNode id = named == null ? null : (named.isObject() ? named.get("id") : named);
        ObjectNode journey = null;
        if (id != null && !id.isNull()) {
            journey = id.isString() ? Journeys.journey(definition, id.stringValue()) : null;
            if (journey == null) {
                return rejected(mode, read, context, "journey", List.of(SubmissionError.error(null, "journey.unknown", null)), judged);
            }
        } else if (Journeys.required(definition)) {
            journey = Journeys.defaultJourney(definition);
            if (journey == null) {
                return rejected(mode, read, context, "journey", List.of(SubmissionError.error(null, "journey.required", null)), judged);
            }
        }
        String journeyId = journey == null ? null : journey.path("id").stringValue();

        // The runtime first: a runtime that is down answers before any data source is asked.
        Sandbox service = sandboxNow();
        Built built = build(read, definition, journey, null, read.document(), context, mode);
        judged.context = built.context();
        judged.ruleIds = built.rules().stream().map(RuleModule::id).toList();

        SandboxResult result;
        try {
            result = service.validate(built.context(), built.rules(), real);
        } catch (SandboxException e) {
            logRunFailure(read.formKey(), e, real);
            throw unavailable(e);
        } catch (DefinitionTooDeepException e) {
            // The registered form is the one too deep (the document's own depth was refused before, a 400): the server's
            // fault, so its 503, never a 422 that reads as a judgement of the answers.
            if (real) {
                LOG.error("Sandbox run for {} failed: {}", read.formKey(), e.getMessage());
            }
            throw unavailable(DefinitionTooDeepException.registered(e));
        } catch (ProgramUnavailableException e) {
            if (real) {
                LOG.error("Sandbox run for {} failed: {}", read.formKey(), e.getMessage());
            }
            throw unavailable(e);
        }
        judged.result = result;
        ObjectNode outcome = result.outcome();

        List<SubmissionError> errors = plainErrors(outcome.path("errors"));
        ObjectNode sanitized = outcome.path("values").isObject() ? (ObjectNode) outcome.get("values") : null;
        Described described = described(outcome, sanitized != null);
        if (described.problem() != null) {
            if (real) {
                LOG.error("Sandbox run for {} failed: {}", read.formKey(), described.problem());
            }
            throw validatorUnavailable(described.problem(), null);
        }
        // Defence in depth: the host's own canonical form of the same document must give the same digest, or the program
        // and the host disagree on the bytes a record is stored and signed under.
        String hostDigest = CanonicalJson.digest(read.document());
        if (!MessageDigest.isEqual(hostDigest.getBytes(StandardCharsets.US_ASCII), described.digest().getBytes(StandardCharsets.US_ASCII))) {
            if (real) {
                LOG.error("Sandbox run for {} refused: the program and the host disagree on the document digest (program {}, host {}).",
                    read.formKey(), described.digest(), hostDigest);
            }
            throw validatorUnavailable("The sandbox program digested the document as " + described.digest()
                + "; the host digests it as " + hostDigest + ".", null);
        }
        judged.sanitized = sanitized;
        judged.canonical = described.canonical();
        judged.digest = described.digest();

        if (blocks(errors) || sanitized == null) {
            return rejected(mode, read, context, "sandbox", errors, judged);
        }

        ValidationScope scope = new ValidationScope("submission", journeyId, null, null, !real);
        CandidateSubmission candidate = new CandidateSubmission(read.formKey(), mode, definition.deepCopy(), current.sha256(),
            read.document().deepCopy(), read.envelope().deepCopy(), sanitized.deepCopy(), read.locale(), scope, built.context().deepCopy(),
            context);

        // The signature seam, when the webauthn module (or the application) provides it.
        if (signatureCheck != null) {
            SignatureVerdict verdict;
            try {
                verdict = signatureCheck.check(candidate);
            } catch (DatumException e) {
                throw e;
            } catch (Exception e) {
                if (real) {
                    LOG.error("The signature check for {} threw: {}", read.formKey(), e.getMessage(), e);
                }
                throw validatorUnavailable("The signature check threw.", e);
            }
            if (verdict == null) {
                throw validatorUnavailable("The signature check gave no verdict.", null);
            }
            judged.signature = verdict;
            if (verdict.refuses()) {
                // An INVALID verdict refuses even when its check gave no errors (fail closed).
                return rejected(mode, read, context, "signature", verdict.refusalErrors(), judged);
            }
        }

        // The server stage: every validator, in order, over the values the sandbox judged.
        List<SubmissionError> all = new ArrayList<>(errors);
        all.addAll(serverStage(candidate, real, read.formKey()));
        if (blocks(all)) {
            return rejected(mode, read, context, "server", all, judged);
        }

        if (mode.dryRun()) {
            return new DryRun(true, null, all, judged.sanitized.deepCopy(), report(read, judged, "accepted", null, all));
        }

        AcceptedSubmission accepted = new AcceptedSubmission(read.formKey(), current.sha256(), described.digest(), described.canonical(),
            sanitized.deepCopy(), all, logsOf(outcome), ids(outcome, "clockDependent"), ids(outcome, "serverRules"),
            ids(outcome, "visibilitySkipped"), ids(outcome, "clientDerived"), context.remoteAddress(), context.userAgent(),
            judged.signature, read.locale(), journeyId, described.index(), context.principal(), context.channel(),
            Objects.requireNonNull(context.submissionKey(), "submissionKey"));
        // The store is the application's handler, not a transaction of Datum's: a use recorded for a record that was then
        // not stored is released, or the person could never send the same signed document again (a replay refusal for a
        // record that does not exist).
        boolean used = false;
        SubmissionReceipt receipt;
        try {
            if (signatureCheck != null) {
                signatureCheck.recordUse(accepted);
                used = true;
            }
            receipt = handler.handle(accepted);
            if (receipt == null) {
                throw new IllegalStateException("The SubmissionHandler " + handler.getClass().getName() + " returned no receipt.");
            }
        } catch (Exception | Error e) {
            // An Error from the handler (a linkage error, a failed assertion) stored no record either: the release does
            // not depend on the throwable's type, or the signed document would be refused as a replay.
            if (used) {
                releaseUse(accepted, e);
            }
            throw e;
        }
        if (idempotency != null) {
            try {
                idempotency.remember(read.formKey(), formVersion, context.submissionKey(), described.digest(), receipt);
            } catch (Exception | LinkageError | AssertionError | StackOverflowError e) {
                // The record is stored: the answer stands. A later retry of this attempt may be stored again.
                LOG.error("The idempotency store for {} could not remember {}: {}", read.formKey(), described.digest(), e.getMessage(), e);
            }
        }
        if (used) {
            stored(accepted, receipt);
        }
        publish(new SubmissionValidatedEvent(accepted, receipt));
        return new Accepted(receipt, accepted, all);
    }

    /** A verdict that refuses: {@link Rejected} (with its event) for a delivery, the report for a dry run. */
    private SubmissionOutcome rejected(SubmissionMode mode, Read read, SubmissionContext context, String stage, List<SubmissionError> errors,
                                       Judgement judged) {
        if (mode.dryRun()) {
            return new DryRun(false, stage, errors, judged.sanitized == null ? null : judged.sanitized.deepCopy(),
                report(read, judged, "rejected", stage, errors));
        }
        publish(new SubmissionRejectedEvent(read.formKey(), errors, stage, context.remoteAddress(), context.channel()));
        return new Rejected(errors, stage);
    }

    /** The dry run's report: what the dry-run route answers, reduced to what this host knows. */
    private static ObjectNode report(Read read, Judgement judged, String outcome, String stage, List<SubmissionError> errors) {
        ObjectNode report = NODES.objectNode();
        report.put("outcome", outcome);
        report.put("stage", stage);
        ArrayNode list = report.putArray("errors");
        for (SubmissionError error : errors) {
            ObjectNode entry = list.addObject();
            entry.put("field", error.field());
            entry.put("code", error.code());
            entry.put("message", error.message());
            entry.put("severity", error.severity() == null ? "error" : error.severity());
            entry.put("stage", error.stage());
            entry.put("source", error.source());
        }
        report.set("sent", read.values().deepCopy());
        ObjectNode outcomeNode = judged.result == null ? null : judged.result.outcome();
        report.set("values", judged.sanitized == null ? NODES.nullNode() : judged.sanitized.deepCopy());
        for (String key : List.of("clientDerived", "clockDependent", "serverRules", "visibilitySkipped")) {
            ArrayNode ids = report.putArray(key);
            if (outcomeNode != null) {
                ids(outcomeNode, key).forEach(ids::add);
            }
        }
        report.put("document", judged.canonical);
        report.put("digest", judged.digest);
        report.set("logs", outcomeNode == null ? NODES.arrayNode() : logsOf(outcomeNode));
        if (judged.context != null) {
            ObjectNode run = report.putObject("sandbox");
            if (judged.result != null) {
                run.put("elapsedMs", Math.round(judged.result.elapsedMs() * 10.0) / 10.0);
            }
            ArrayNode rules = run.putArray("rules");
            judged.ruleIds.forEach(rules::add);
            run.set("unknownFields", judged.context.path("unknownFields").isString() ? judged.context.get("unknownFields") : NODES.nullNode());
            run.set("logLevel", judged.context.path("logLevel").isString() ? judged.context.get("logLevel") : NODES.nullNode());
        } else {
            report.putNull("sandbox");
        }
        if (judged.signature != null) {
            ObjectNode signature = report.putObject("signature");
            signature.put("status", judged.signature.status().wire());
            ArrayNode found = signature.putArray("errors");
            for (SubmissionError error : judged.signature.errors()) {
                ObjectNode entry = found.addObject();
                entry.put("field", error.field());
                entry.put("code", error.code());
                if (error.message() != null) {
                    entry.put("message", error.message());
                }
            }
        } else {
            report.putNull("signature");
        }
        return report;
    }

    // ------------------------------------------------------------------------------------------ a journey's check

    /** A page or a whole journey judged, nothing kept, answered {@link Checked}. */
    private SubmissionOutcome check(Read read, CurrentDefinition current, String version, SubmissionContext context) {
        ObjectNode definition = current.definition();
        String named = read.journeyId() == null ? null : read.journeyId().stringValue();

        // A check that names no journey is judged as a submission is: by the default journey, or answered
        // journey.required when a form with journeys has none.
        ObjectNode journey;
        if (named == null && Journeys.required(definition)) {
            journey = Journeys.defaultJourney(definition);
            if (journey == null) {
                return checked(read.formKey(), null, null, false, List.of(SubmissionError.error(null, "journey.required", null)), List.of(), context);
            }
        } else {
            journey = named != null ? Journeys.journey(definition, named) : null;
        }
        if (journey == null) {
            return checked(read.formKey(), null, null, false, List.of(SubmissionError.error(null, "journey.unknown", null)), List.of(), context);
        }
        String journeyId = journey.path("id").stringValue();
        ObjectNode page = null;
        if (JourneyCheck.PAGE.equals(read.scope())) {
            page = Journeys.page(journey, read.pageId());
            if (page == null) {
                throw malformed("The check names no page of the journey.");
            }
        }
        String pageId = page == null ? null : page.path("id").stringValue();

        Sandbox service = sandboxNow();
        // A check has no delivered document, and asks for the judged values of a run that blocked elsewhere (reportFold):
        // the server stage is never handed the raw answers.
        Built built = build(read, definition, journey, pageId, null, context, SubmissionMode.VALIDATE);
        ObjectNode outcome;
        try {
            outcome = service.validate(built.context(), built.rules(), false).outcome();
        } catch (SandboxException e) {
            // A run that failed is no verdict, whatever it failed on: the check answers it as a delivery does (the run's own
            // 503, never a 200 that reads as an answer about the person's page).
            logRunFailure(read.formKey(), e, true);
            throw unavailable(e);
        } catch (DefinitionTooDeepException e) {
            // The registered form is the one too deep: the host's fault, not a finding about the answers (503).
            LOG.error("Sandbox check for {} failed: {}", read.formKey(), e.getMessage());
            throw unavailable(DefinitionTooDeepException.registered(e));
        } catch (ProgramUnavailableException e) {
            LOG.error("Sandbox check for {} failed: {}", read.formKey(), e.getMessage());
            throw unavailable(e);
        }

        List<String> members = null;
        if (page != null) {
            members = pageMembers(outcome);
            if (members == null) {
                // The run named no components for the page (a contributor took the journey or the page out of the context):
                // fail closed rather than guess a set.
                LOG.error("Sandbox check for {} named no components for page {}: the context lost its journey or page.", read.formKey(), pageId);
                throw validatorUnavailable("The sandbox named no components for the page.", null);
            }
        }
        List<SubmissionError> errors = inScope(plainErrors(outcome.path("errors")), members);
        List<SubmissionError> notes = new ArrayList<>();
        ObjectNode values = null;
        if (!blocks(errors)) {
            // The values the sandbox judged: its sanitized values, else (a run that blocked on another page) its
            // submittable. With neither, the server stage is skipped and says so.
            if (outcome.path("values").isObject()) {
                values = (ObjectNode) outcome.get("values");
            } else if (outcome.path("submittable").isObject()) {
                values = (ObjectNode) outcome.get("submittable");
            } else {
                notes.add(new SubmissionError(null, "server.skipped", null, "info", null, null));
            }
        }
        if (values != null) {
            ObjectNode envelope = NODES.objectNode();
            ObjectNode form = envelope.putObject("versionContext").putObject("form");
            form.put("id", read.formKey());
            form.put("version", version);
            ObjectNode submission = envelope.putObject("submission");
            submission.put("locale", read.locale());
            submission.set("values", values.deepCopy());
            submission.putObject("journey").put("id", journeyId);
            ValidationScope scope = new ValidationScope(read.scope(), journeyId, members != null ? pageId : null, members, false);
            CandidateSubmission candidate = new CandidateSubmission(read.formKey(), SubmissionMode.VALIDATE, definition.deepCopy(),
                current.sha256(), null, envelope, values.deepCopy(), read.locale(), scope, built.context().deepCopy(), context);
            List<SubmissionError> server = inScope(serverStage(candidate, true, read.formKey()), members);
            errors = new ArrayList<>(errors);
            errors.addAll(server);
        }
        // Findings that block are the verdict's errors; the rest (warnings, info) ride along as notes, in the order given.
        boolean accepted = !blocks(errors);
        List<SubmissionError> blocking = new ArrayList<>();
        List<SubmissionError> riders = new ArrayList<>();
        for (SubmissionError error : errors) {
            (error.blocks() ? blocking : riders).add(error);
        }
        riders.addAll(notes);
        return checked(read.formKey(), journeyId, pageId, accepted, blocking, riders, context);
    }

    private SubmissionOutcome checked(String formKey, String journeyId, String pageId, boolean accepted, List<SubmissionError> errors,
                                      List<SubmissionError> notes, SubmissionContext context) {
        publish(new JourneyCheckedEvent(formKey, journeyId, pageId, accepted, context.channel()));
        return new Checked(accepted, errors, notes, journeyId, pageId);
    }

    /** The components a page check answers for: the outcome's pageComponentIds, or null. */
    private static List<String> pageMembers(JsonNode outcome) {
        JsonNode ids = outcome.path("pageComponentIds");
        if (!ids.isArray()) {
            return null;
        }
        List<String> out = new ArrayList<>();
        for (JsonNode id : ids) {
            if (id.isString()) {
                out.add(id.stringValue());
            }
        }
        return out;
    }

    /** The errors a page check keeps: its components' and form-level ones, without journey.exit. */
    private static List<SubmissionError> inScope(List<SubmissionError> errors, List<String> members) {
        if (members == null) {
            return errors;
        }
        return errors.stream()
            .filter(error -> !"journey.exit".equals(error.code()) && (error.field() == null || members.contains(error.field())))
            .toList();
    }

    // ------------------------------------------------------------------------------------------ the context

    private record Built(ObjectNode context, List<RuleModule> rules) {
    }

    /**
     * The run's context from the server's copy of the form, the option snapshot, the rule modules, the contributors, then
     * the delivered document (after them, so the canonical text and digest are of the document as received).
     */
    private Built build(Read read, ObjectNode definition, ObjectNode journey, String pageId, ObjectNode document,
                        SubmissionContext submission, SubmissionMode mode) {
        ObjectNode context = NODES.objectNode();
        JsonNode id = definition.get("id");
        context.put("formId", id == null || id.isNull() || id.isContainer() ? "" : id.asString());
        // A source set to not validate answers is marked answersFree on its choices rather than left out of the snapshot;
        // an answersFree the author wrote is removed.
        JsonNode root = dataSources.withAnswersFree(definition).get("root");
        context.set("form", root == null ? NODES.nullNode() : root.deepCopy());
        // The definition's translations ride in the run context: the kernel reads the context, not the
        // definition, so a pattern message or a validation message answers in the filler's language.
        JsonNode translations = definition.get("translations");
        if (translations != null && translations.isObject() && !translations.isEmpty()) {
            context.set("translations", translations.deepCopy());
        }
        // The host's catalog rides beside the map, and the kernel reads it before the map
        // under the same locale tag, as the browser does, so a server-worded message matches one a catalog overrides. Left out
        // when the host keeps none or the form's is empty.
        // A store that throws is no verdict, as a customizer or the repository that throws is none (a missing catalog is not an
        // error: a null stored catalog or a null catalog is "no catalog", and the run goes on with the map alone).
        ObjectNode catalog = null;
        if (catalogs != null) {
            try {
                StoredCatalog stored = catalogs.read(read.formKey());
                catalog = stored == null ? null : stored.catalog();
            } catch (DatumException e) {
                throw e;
            } catch (Exception e) {
                LOG.error("The translation catalog store for {} threw: {}", read.formKey(), e.getMessage(), e);
                throw validatorUnavailable("The translation catalog store threw.", e);
            }
        }
        if (catalog != null && !catalog.isEmpty()) {
            context.set("catalog", catalog.deepCopy());
        }
        // A copy: a contributor that edits the context's values must not edit the delivered document.
        context.set("values", read.values().deepCopy());
        context.put("locale", read.locale());
        RunSettings settings = new RunSettings(unknownFields, logLevel);
        for (HostOptionsCustomizer customizer : customizers) {
            try {
                customizer.customize(read.formKey(), definition.deepCopy(), settings, submission);
            } catch (DatumException e) {
                throw e;
            } catch (Exception e) {
                LOG.error("A host options customizer for {} threw: {}", read.formKey(), e.getMessage(), e);
                throw validatorUnavailable("A host options customizer threw.", e);
            }
        }
        context.put("unknownFields", settings.unknownFieldsOrDefault());
        context.put("logLevel", settings.logLevelOrDefault());
        if (journey != null) {
            // The journey the answers were given through; its pages may name free-answer sources too.
            ObjectNode wrapper = NODES.objectNode();
            wrapper.set("journey", journey.deepCopy());
            context.set("journey", dataSources.withAnswersFree(wrapper).get("journey").deepCopy());
            if (pageId != null) {
                // The page a check judges: the kernel answers with the components in scope for it.
                context.put("page", pageId);
            }
        }

        // The options of the data sources the definition names, which the kernel holds choice answers to, as the person
        // submitting may see them. A source that cannot answer refuses the request with server.unavailable,
        // whatever it threw: the suite allows no other code on a submission's 503, and a provider's own 403 or 404 would
        // tell a filler about the source rather than the form.
        ObjectNode snapshot;
        try {
            snapshot = dataSources.snapshotFor(definition, submission.principal(), true, read.values(), read.locale());
        } catch (ProgramUnavailableException e) {
            throw unavailable(e);
        } catch (Exception e) {
            throw unavailable(new ProgramUnavailableException("A data source of the form could not be asked about the answers, so the submission "
                + "was not checked: " + e.getMessage(), e));
        }
        if (snapshot != null && !snapshot.isEmpty()) {
            context.set("optionSnapshot", snapshot);
        }

        List<RuleModule> rules = new ArrayList<>();
        for (SandboxRulesProvider provider : rulesProviders) {
            List<RuleModule> provided;
            try {
                provided = provider.rules(read.formKey(), definition.deepCopy(), submission);
            } catch (DatumException e) {
                throw e;
            } catch (Exception e) {
                throw unavailable(new ProgramUnavailableException("A rule module of the form could not be read, so the submission was not checked.", e));
            }
            if (provided != null) {
                rules.addAll(provided);
            }
        }

        ContextBuilder builder = new ContextBuilder(read.formKey(), mode, definition.deepCopy(), context, rules);
        for (SandboxContextContributor contributor : contributors) {
            try {
                contributor.contribute(builder, submission);
            } catch (DatumException e) {
                throw e;
            } catch (Exception e) {
                LOG.error("A sandbox context contributor for {} threw: {}", read.formKey(), e.getMessage(), e);
                throw validatorUnavailable("A sandbox context contributor threw.", e);
            }
        }

        // The host context is the provider's alone: worked out by the server from the request,
        // set after every contributor so none can replace it, and never read from the document or the body, which a client
        // writes. With no provider, or one that supplies none, the key is left out and the kernel judges a rule reading
        // host. leniently. A provider that fails is the host's fault, so the call is refused rather than
        // judged more leniently than the application meant.
        ObjectNode host;
        try {
            host = HostContexts.ask(hostContext, new HostContextRequest(read.formKey(), versionOf(definition), mode, submission));
        } catch (HostContexts.Failed e) {
            LOG.error("{}", e.getMessage(), e.getCause());
            // The host's own fault: 503 server.unavailable, like a rule module or a data source that could not answer.
            throw unavailable(new ProgramUnavailableException("The host context provider failed.", e));
        }
        if (host != null) {
            context.set("hostContext", host);
        } else {
            context.remove("hostContext");
        }
        if (document != null) {
            context.set("document", document.deepCopy());
        } else {
            context.remove("document");
        }
        if (read.logLevel() != null) {
            // A dry run's own level, over the form's.
            context.put("logLevel", read.logLevel());
        }
        if (mode == SubmissionMode.VALIDATE) {
            context.put("reportFold", true);
        }
        return new Built(context, List.copyOf(rules));
    }

    // ------------------------------------------------------------------------------------------ the server stage

    /**
     * Every validator in order: errors as blocking, warnings as warnings, each marked as the server's. A validator that
     * throws (anything short of the JVM failing) stops the call with {@code validator_unavailable}.
     */
    private List<SubmissionError> serverStage(CandidateSubmission candidate, boolean logFailures, String formKey) {
        List<SubmissionError> found = new ArrayList<>();
        for (SubmissionValidator validator : validators) {
            ValidatorResult result;
            try {
                result = validator.validate(candidate);
            } catch (Exception e) {
                // An exception is validator_unavailable; an Error is not caught and reaches the caller.
                if (logFailures) {
                    LOG.error("The server stage for {} threw: {}", formKey, e.getMessage(), e);
                }
                throw validatorUnavailable("A server validator threw.", e);
            }
            if (result == null) {
                continue;
            }
            for (SubmissionError error : result.errors()) {
                found.add(new SubmissionError(error.field(), error.code(), error.message(), "error", error.stage(), error.source()).fromServer());
            }
            for (SubmissionError warning : result.warnings()) {
                SubmissionError marked = warning.withDefaultSeverity("warning");
                if (marked.blocks()) {
                    marked = new SubmissionError(marked.field(), marked.code(), marked.message(), "warning", marked.stage(), marked.source());
                }
                found.add(marked.fromServer());
            }
        }
        return found;
    }

    // ------------------------------------------------------------------------------------------ the outcome

    /** What an outcome says of the document and the values, or why it cannot be used. */
    private record Described(String canonical, String digest, ArrayNode index, String problem) {

        static Described problem(String why) {
            return new Described(null, null, null, why);
        }
    }

    /**
     * The canonical text of the document sent and its digest (the SHA-256 of that text), and, when the run kept values,
     * their index rows {@code {path, delta, value}}. What a record is stored, signed and printed under comes
     * from the program or not at all.
     */
    private static Described described(JsonNode outcome, boolean values) {
        JsonNode canonical = outcome.get("canonical");
        JsonNode digest = outcome.get("digest");
        if (canonical == null || !canonical.isString() || digest == null || !digest.isString()) {
            return Described.problem("The sandbox program returned no canonical document or digest.");
        }
        String text = canonical.stringValue();
        String sum = digest.stringValue();
        if (!SHA256.matcher(sum).matches()
            || !MessageDigest.isEqual(CanonicalJson.sha256Hex(text).getBytes(StandardCharsets.US_ASCII), sum.getBytes(StandardCharsets.US_ASCII))) {
            return Described.problem("The digest the sandbox program returned is not the SHA-256 of the canonical document it returned.");
        }
        ArrayNode index = null;
        if (values) {
            JsonNode rows = outcome.get("index");
            if (rows == null || !rows.isArray()) {
                return Described.problem("The sandbox program returned values without their index.");
            }
            index = NODES.arrayNode();
            for (JsonNode row : rows) {
                if (!row.isObject() || !row.path("path").isString() || !row.path("delta").isString() || !row.has("value")) {
                    return Described.problem("The value index the sandbox program returned has a row that is not {path, delta, value}.");
                }
                ObjectNode copy = index.addObject();
                copy.set("path", row.get("path"));
                copy.set("delta", row.get("delta"));
                copy.set("value", row.get("value").deepCopy());
            }
        }
        return new Described(text, sum, index, null);
    }

    /** The outcome's errors as findings. */
    static List<SubmissionError> plainErrors(JsonNode errors) {
        List<SubmissionError> out = new ArrayList<>();
        if (!errors.isArray()) {
            return out;
        }
        for (JsonNode error : errors) {
            if (!error.isObject()) {
                out.add(SubmissionError.error(null, "error", null));
                continue;
            }
            JsonNode component = error.get("componentId");
            String field = component == null || component.isNull() || component.isContainer() ? null : component.asString();
            JsonNode code = error.get("code");
            String codeText = code == null || code.isNull() || code.isContainer() ? "error" : code.asString();
            out.add(new SubmissionError(field, codeText, text(error, "message"), text(error, "severity"), text(error, "stage"), text(error, "source")));
        }
        return out;
    }

    private static String text(JsonNode object, String key) {
        JsonNode value = object.get(key);
        return value != null && value.isString() ? value.stringValue() : null;
    }

    /** Whether any finding blocks: severity {@code error}, which is what none means. */
    static boolean blocks(List<SubmissionError> errors) {
        for (SubmissionError error : errors) {
            if (error.blocks()) {
                return true;
            }
        }
        return false;
    }

    /** The outcome's id list under {@code key} (strings only, in the program's order); empty when absent. */
    private static List<String> ids(JsonNode outcome, String key) {
        JsonNode list = outcome.get(key);
        List<String> out = new ArrayList<>();
        if (list != null && list.isArray()) {
            for (JsonNode id : list) {
                if (id.isString()) {
                    out.add(id.stringValue());
                }
            }
        }
        return out;
    }

    private static ArrayNode logsOf(JsonNode outcome) {
        JsonNode logs = outcome.get("logs");
        return logs != null && logs.isArray() ? ((ArrayNode) logs).deepCopy() : NODES.arrayNode();
    }

    // ------------------------------------------------------------------------------------------ helpers

    /** The sandbox, asked once per call; a runtime that is down is {@link Unavailable} with its own refusal. */
    private Sandbox sandboxNow() {
        try {
            return sandbox.get();
        } catch (ProgramUnavailableException e) {
            throw unavailable(e);
        }
    }

    private static void logRunFailure(String formKey, SandboxException e, boolean real) {
        if (real) {
            logRunFailure(LOG, formKey, e);
        }
    }

    /**
     * A failed run, logged: a busy refusal at INFO (the limit working, not a fault), any other failure at ERROR with the
     * start of the run's stderr, and its whole kept stderr at DEBUG. The stderr is the guest's words, and a thrown message
     * can quote a submitted value: escaped onto one line always, and only its start at ERROR, so a run can neither forge
     * log lines nor pour its input into the error log.
     */
    static void logRunFailure(Logger log, String formKey, SandboxException e) {
        if (e.reason() == SandboxException.Reason.BUSY) {
            log.info("Sandbox run for {} failed ({}): {}", formKey, e.reason(), e.getMessage());
            return;
        }
        log.error("Sandbox run for {} failed ({}): {} {}", formKey, e.reason(), e.getMessage(), e.stderrSummary());
        if (log.isDebugEnabled() && !e.stderr().isEmpty()) {
            log.debug("Sandbox run for {} failed ({}): its stderr: {}", formKey, e.reason(), e.stderrLine());
        }
    }

    /** Releases a recorded signature use after the handler failed; a failure here is logged and suppressed. */
    private void releaseUse(AcceptedSubmission accepted, Throwable failure) {
        try {
            signatureCheck.releaseUse(accepted);
        } catch (Exception e) {
            LOG.error("Releasing the signature use of a submission to {} that was not stored failed.", accepted.formKey(), e);
            failure.addSuppressed(e);
        }
    }

    /**
     * Tells the signature check that the handler stored the document. The record is stored by now: a
     * failure is logged like the idempotency store's, and the answer, the record and the claimed use all stand.
     */
    private void stored(AcceptedSubmission accepted, SubmissionReceipt receipt) {
        try {
            signatureCheck.stored(accepted, receipt);
        } catch (Exception | LinkageError | AssertionError | StackOverflowError e) {
            LOG.error("The signature check's stored step for a submission to {} failed; the submission is stored.", accepted.formKey(), e);
        }
    }

    /** Publishes an event through the publisher as given (the host guards its default, {@link DatumEventPublisher#guarded}). */
    private void publish(Object event) {
        events.publish(event);
    }

    private static Stop malformed(String reason) {
        return new Stop(new Malformed(reason));
    }

    /** No verdict for a reason the run (or the runtime, a data source, a rule module) gave: its own code and exception. */
    private static Stop unavailable(DatumException cause) {
        return new Stop(new Unavailable(cause.code(), cause.getMessage() == null ? cause.code() : cause.getMessage(), cause));
    }

    /** No verdict because a hook failed or the outcome lacks what a record is stored under. */
    private static Stop validatorUnavailable(String reason, Throwable cause) {
        return new Stop(new Unavailable(VALIDATOR_UNAVAILABLE, reason, cause));
    }

    /**
     * How a step deep in the pipeline ends the call with an outcome: thrown only by this class's own code, never inside a
     * hook's try block, and caught once in {@code run}. No stack trace: it is control flow, not a failure.
     */
    private static final class Stop extends RuntimeException {

        private static final long serialVersionUID = 1L;

        private final transient SubmissionOutcome outcome;

        Stop(SubmissionOutcome outcome) {
            super(null, null, false, false);
            this.outcome = outcome;
        }
    }

    /** Builds a service. */
    public static final class Builder {

        private Supplier<? extends Sandbox> sandbox;
        private DefinitionService definitions;
        private DataSourceOptions dataSources;
        private TranslationCatalogStore catalogs;
        // Unset: RunSettings carries the kernel's own defaults (strip, warn), the one place they are written.
        private String unknownFields;
        private String logLevel;
        private SubmissionHandler handler;
        private SubmissionThrottle throttle;
        private List<SubmissionPreCheck> preChecks = List.of();
        private List<SubmissionValidator> validators = List.of();
        private List<SandboxRulesProvider> rulesProviders = List.of();
        private List<SandboxContextContributor> contributors = List.of();
        private List<HostOptionsCustomizer> customizers = List.of();
        private HostContextProvider hostContext;
        private SubmissionSignatureCheck signatureCheck;
        private SubmissionIdempotencyStore idempotency;
        private DatumEventPublisher events;
        private DatumObservations observations = DatumObservations.none();
        private long maxDocumentBytes = ProgramLimits.BODY_BYTES.defaultValue();

        private Builder() {
        }

        /** The sandbox, asked once per call (it throws {@code ProgramUnavailableException} while the runtime is down). */
        public Builder sandbox(Supplier<? extends Sandbox> sandbox) { this.sandbox = sandbox; return this; }
        /**
         * Where the current definition comes from: datum-forms' service, never the repository itself, so every version a
         * record names is snapshotted when first seen.
         */
        public Builder definitions(DefinitionService definitions) { this.definitions = definitions; return this; }
        public Builder dataSources(DataSourceOptions dataSources) { this.dataSources = dataSources; return this; }
        /** The host's translation catalogs, read per run into the context's {@code catalog}; null (the default) when the host keeps none. */
        public Builder catalogs(TranslationCatalogStore catalogs) { this.catalogs = catalogs; return this; }
        /** {@code datum.host.unknown-fields}: one of {@link RunSettings#UNKNOWN_FIELDS}, or null for the kernel's default. */
        public Builder unknownFields(String unknownFields) { this.unknownFields = unknownFields; return this; }
        /** {@code datum.host.log-level}: one of {@link RunSettings#LOG_LEVELS}, or null for the kernel's default. */
        public Builder logLevel(String logLevel) { this.logLevel = logLevel; return this; }
        public Builder handler(SubmissionHandler handler) { this.handler = handler; return this; }
        /** The throttle, or null for none. */
        public Builder throttle(SubmissionThrottle throttle) { this.throttle = throttle; return this; }
        public Builder preChecks(List<SubmissionPreCheck> preChecks) { this.preChecks = Objects.requireNonNull(preChecks); return this; }
        public Builder validators(List<SubmissionValidator> validators) { this.validators = Objects.requireNonNull(validators); return this; }
        public Builder rulesProviders(List<SandboxRulesProvider> rulesProviders) { this.rulesProviders = Objects.requireNonNull(rulesProviders); return this; }
        public Builder contributors(List<SandboxContextContributor> contributors) { this.contributors = Objects.requireNonNull(contributors); return this; }
        public Builder customizers(List<HostOptionsCustomizer> customizers) { this.customizers = Objects.requireNonNull(customizers); return this; }
        /**
         * Where each run's {@code hostContext} comes from ({@link HostContextProvider}), or null (the default) for none: no
         * run then carries one, and the kernel leaves every rule reading {@code host.} unjudged.
         */
        public Builder hostContext(HostContextProvider hostContext) { this.hostContext = hostContext; return this; }
        /** The signature check, or null for none. */
        public Builder signatureCheck(SubmissionSignatureCheck signatureCheck) { this.signatureCheck = signatureCheck; return this; }
        /** The store of accepted documents; null (the default here) answers every delivery as a first one. */
        public Builder idempotency(SubmissionIdempotencyStore idempotency) { this.idempotency = idempotency; return this; }
        /** Where the events go, used as given: the host's default publisher is the guarded one ({@link DatumEventPublisher#guarded}). */
        public Builder events(DatumEventPublisher events) { this.events = events; return this; }
        /** Where the {@value DatumObservationNames#SUBMISSION} observations go ({@link DatumObservations#none()} by default). */
        public Builder observations(DatumObservations observations) { this.observations = Objects.requireNonNull(observations); return this; }

        /**
         * The largest document judged, in bytes of its JSON text: the binding passes {@code ProgramLimits.maxBodyBytes()}
         * ({@code datum.web.api.max-body-size}, the routes' body cap), so every caller meets one cap; the default is that
         * property's default.
         */
        public Builder maxDocumentBytes(long maxDocumentBytes) {
            if (maxDocumentBytes < 1) {
                throw new IllegalArgumentException("The document cap is at least one byte.");
            }
            this.maxDocumentBytes = maxDocumentBytes;
            return this;
        }

        public SubmissionService build() {
            return new SubmissionService(this);
        }
    }
}
