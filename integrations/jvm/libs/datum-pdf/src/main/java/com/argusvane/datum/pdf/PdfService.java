package com.argusvane.datum.pdf;

import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.assets.HostBindings;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.core.contracts.PdfSigningHandoff;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.core.hooks.HookFindings;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.core.observation.DatumObservation;
import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.pdf.verify.PdfTrust;
import com.argusvane.datum.pdf.verify.PdfTrustPolicy;
import com.argusvane.datum.pdf.verify.PdfVerification;
import com.argusvane.datum.pdf.verify.PdfVerifier;
import com.argusvane.datum.timestamp.Timestamper;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;
import org.bouncycastle.asn1.ASN1EncodableVector;
import org.bouncycastle.asn1.ASN1Encoding;
import org.bouncycastle.asn1.ASN1Integer;
import org.bouncycastle.asn1.ASN1OctetString;
import org.bouncycastle.asn1.ASN1Primitive;
import org.bouncycastle.asn1.ASN1Sequence;
import org.bouncycastle.asn1.ASN1Set;
import org.bouncycastle.asn1.cms.Attribute;
import org.bouncycastle.asn1.cms.AttributeTable;
import org.bouncycastle.asn1.cms.CMSAttributes;

/**
 * The PDF program's ops for a server host, framework-free: request assembly (fonts, the
 * formula inputs, the slot, the answer), the seal (prepare, sign with the server's key, timestamp, complete) and a
 * submission's {@code document} request, with the host-side half of verifying in {@link PdfVerifier} (PDF ABI {@link PdfAbi}).
 *
 * <p>Every request names {@link PdfAbi#MIN} as its {@code abi} (the program answers any request of its major line,
 * {@code pdfAbiCompatible}; the ABI gate has proved the program is at least that version) and its op; neither can be
 * changed by a caller or a {@link PdfRequestCustomizer}. Each run takes a PDF slot of {@link PdfRuntime#slots()}:
 * at once or within {@code datum.runtime.pdf.wait}, else 503 {@code server.busy} (a page render is not worth a long
 * wait); the second half of a seal ({@code complete}) and a {@code timestampRequest} wait for a slot as long as one
 * render may take, so a seal half done is not thrown away.
 * A runtime that runs QuickJS as JVM bytecode cannot run the PDF program: every op is a
 * {@link PdfUnavailableException} (503) before any slot is taken.
 *
 * <p>What a refusal is: the program's own ({@code ok: false}) is a {@link PdfException} with the kernel's code
 * (500, the endpoint catalog's PDF routes); a run that gave no answer stays datum-core's {@link SandboxException}
 * (time, memory, a throw: 503 {@code wasm.execution_error}; busy: 503 {@code server.busy}), the same answers as a validation run; a
 * program that cannot be used is a {@link PdfUnavailableException}.
 *
 * <p>Which PDFs are sealed ({@link SealPreset}, the host's sealing preset): the PDFs this service issues
 * from a definition, {@link #renderSubmission} and {@link #document} (a {@code document} request without a
 * {@code signature} of its own), are planned per printed layout, the layout chosen by the answers re-rendered under
 * its own plan. The building-block ops ({@link #render}, {@link #fill},
 * {@link #build}, {@link #layout}) never seal: they make parts of a document, not an issued PDF.
 * Answers that were never submitted (a caller's posted answers, judged only by the receiver's dry run) are sealed,
 * when their plan says so, with a throwaway {@link TestSeal} certificate and never the server's key
 * ({@link SealMode#TEST}, the builder's test of a form), unless the application says otherwise.
 *
 * <p>Before the server's key signs anything, the handoff is tied to the prepared bytes (the sandboxed program's
 * handoff is never signed on its word): the digest is the SHA-256 over the byte range of those bytes, the
 * {@code toBeSigned} is a DER SET whose one {@code messageDigest} attribute is that digest, and
 * {@code toBeSignedDigest} is its SHA-256. So the key signs only signed attributes over the file this server
 * delivers, whatever the sandboxed program answered.
 */
public final class PdfService {

    private static final Logger LOG = LoggerFactory.getLogger(PdfService.class);

    /** The ABI every request names. */
    public static final String ABI = PdfAbi.MIN;

    /** The layout id that names none unless the definition declares one by it: the program then chooses. */
    public static final String DEFAULT_LAYOUT = "default";

    /** {@code env.producer} of a submission's PDF: this host's name. */
    public static final String PRODUCER = "Datum for Spring Boot";

    /** Warning codes the log is told of, the ones an operator should see: a template's scripts, an overflow, a collection mapping. */
    public static final Set<String> LOGGED_WARNINGS = Set.of("template.javascript_open_action", "template.javascript_additional_actions",
        "template.javascript_names", "field.overflow", "mapping.collection");

    /** The keys of a layout's {@code signature} block that win over the preset's (a {@code PdfSignatureSettings} subset). */
    static final List<String> LAYOUT_KEYS = List.of("subFilter", "certify", "field", "name", "reason", "location", "contactInfo",
        "appearance", "placeholderBytes", "commitment");

    /** The settings a caller may give {@link #signWithServerKey(byte[], ObjectNode, PdfOptions)} (a {@code PdfSignatureSettings}). */
    static final Set<String> SETTINGS_KEYS = Set.of("subFilter", "digestAlgorithm", "certify", "field", "name", "reason", "location",
        "contactInfo", "appearance", "timestamp", "required", "placeholderBytes", "commitment");

    private static final DateTimeFormatter CREATED_AT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss'.000Z'").withZone(ZoneOffset.UTC);

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** How sealing applies to one issued PDF: the preset, forced, never, or with a throwaway test key. */
    public enum SealMode {
        /** The preset decides (and a layout's own block), with the server's key: a stored submission's PDF. */
        PRESET,
        /** Sealed with the server's key whatever the preset says: an explicit sign request for a stored submission. */
        FORCE,
        /** Never with the server's key: a template the caller posted (its pages are the caller's). */
        NEVER,
        /**
         * As {@link #PRESET}, but with a throwaway {@link TestSeal} certificate made for the call, never the server's
         * key: answers that were never submitted (the dry run's). No timestamp is asked for, the
         * reason is {@value TestSeal#REASON}, and the result's {@link PdfSeal#test()} is true.
         */
        TEST,
        /** As {@link #FORCE}, with a throwaway {@link TestSeal} certificate as {@link #TEST}. */
        TEST_FORCE;

        boolean forced() {
            return this == FORCE || this == TEST_FORCE;
        }

        boolean test() {
            return this == TEST || this == TEST_FORCE;
        }
    }

    /** The features one program file answered, remembered here so a cached answer takes no PDF slot. */
    private record Features(String sha256, List<String> names) {
    }

    private final PdfRuntime runtime;
    private final PdfFonts fonts;
    private final PdfFonts.Pack defaultPack;
    private final List<PdfRequestCustomizer> customizers;
    private final List<PdfResultValidator> validators;
    private final HostBindings bindings;
    private final PdfSigner signer;
    private final Timestamper timestamper;
    private final String timestampSource;
    private final SealPreset seal;
    private final PdfTrust trust;
    private final PdfVerifier verifier;
    private final long verifyMaxBytes;
    private final DatumEventPublisher events;
    private final DatumObservations observations;
    /** Set while an observed operation runs on this thread, so an operation it calls is part of it. */
    private final ThreadLocal<Boolean> observing = new ThreadLocal<>();
    private final Clock clock;
    private final JsonMapper json = DatumJson.mapper();
    private final SecureRandom random = new SecureRandom();
    private volatile Features features;

    private PdfService(Builder b) {
        this.runtime = Objects.requireNonNull(b.runtime, "runtime");
        this.fonts = b.fonts != null ? b.fonts : PdfFonts.fromClasspath(PdfService.class.getClassLoader());
        this.defaultPack = b.defaultPack == null ? PdfFonts.Pack.DEFAULT : b.defaultPack;
        this.customizers = List.copyOf(b.customizers);
        this.validators = List.copyOf(b.validators);
        this.bindings = b.bindings;
        this.signer = b.signer;
        this.timestamper = b.timestamper;
        this.timestampSource = b.timestamper == null ? "" : (b.timestampSource == null ? "" : b.timestampSource);
        this.seal = b.seal == null ? SealPreset.OFF : b.seal;
        this.clock = b.clock == null ? Clock.systemUTC() : b.clock;
        if (b.verifier != null) {
            // The host's own verifier: its trust and policy are what verification uses, as given.
            if (b.trust != null || b.trustPolicy != null) {
                throw new IllegalArgumentException("Give the PDF service a verifier or a trust and a trust policy, not both: the verifier carries its own.");
            }
            this.verifier = b.verifier;
            this.trust = b.verifier.trust();
            if (signer != null && !holds(this.trust.siteSigners().get(), signer.leaf())) {
                LOG.warn("Datum PDF: the verifier's trust does not list the server's signing certificate as a site signer, so this server's own "
                    + "seals verify as self-signed or unknown. Build its trust with PdfTrust.withSiteSigner(signer.leaf()).");
            }
        } else {
            PdfTrust given = b.trust == null ? PdfTrust.none(this.clock) : b.trust;
            // The current signer is always "site": a configured trust that forgot it would call the server's own seal unknown.
            this.trust = signer == null ? given : given.withSiteSigner(signer.leaf());
            this.verifier = new PdfVerifier(this.trust, b.trustPolicy == null ? PdfTrustPolicy.standard() : b.trustPolicy, json);
        }
        this.verifyMaxBytes = b.verifyMaxBytes > 0 ? b.verifyMaxBytes : 20L * 1024 * 1024;
        // As given: through the host's guarded default a listener's failure is logged and the PDF or the report is
        // answered all the same; an application's own publisher that throws reaches the caller.
        this.events = b.events == null ? DatumEventPublisher.noop() : b.events;
        this.observations = b.observations == null ? DatumObservations.none() : b.observations;
        if (this.seal.enabled() && signer == null) {
            LOG.warn("Datum PDF: datum.pdf.seal.enabled is set and there is no signing key (datum.pdf.signing.*): issued PDFs go out "
                + "unsealed, each with a sealing.unavailable warning, and a layout that requires a seal fails to render.");
        }
    }

    /** Whether a list holds the certificate (by its encoding). */
    private static boolean holds(List<X509Certificate> certificates, X509Certificate certificate) {
        return certificates != null && certificates.stream().anyMatch(certificate::equals);
    }

    /** The verifier that completes {@link #verify}: its trust and its trust policy. */
    public PdfVerifier verifier() {
        return verifier;
    }

    /** A builder; the runtime is required, everything else optional. */
    public static Builder builder() {
        return new Builder();
    }

    // ------------------------------------------------------------------------------------------------- what is set

    /** The server's signer, or null when none is configured. */
    public PdfSigner signer() {
        return signer;
    }

    /** The seal preset. */
    public SealPreset sealPreset() {
        return seal;
    }

    /**
     * Where sealing's timestamps come from: a URL, {@code site} (the in-process authority), {@code custom} (an application's
     * own {@link Timestamper}), or "" for none.
     */
    public String timestampSource() {
        return timestampSource;
    }

    /** Whether a seal can carry a timestamp. */
    public boolean timestampAvailable() {
        return timestamper != null;
    }

    /** The largest file {@link #verify} reads. */
    public long verifyMaxBytes() {
        return verifyMaxBytes;
    }

    /** What verification places signers against. */
    public PdfTrust trust() {
        return trust;
    }

    // ------------------------------------------------------------------------------------------------- the ops

    /**
     * The program's feature names ({@code capabilities}), asked once per program file and remembered by the ABI
     * gate (a failed answer for 60 s). Takes a slot only when the program must be asked: a known answer is
     * remembered here by the program's SHA-256 and returned before any slot is asked for, so a health or info probe
     * is never answered busy while every PDF slot renders.
     *
     * @throws PdfUnavailableException when the program cannot be used
     */
    public List<String> capabilities() {
        return observed("capabilities", null, this::capabilitiesObserved);
    }

    private List<String> capabilitiesObserved() {
        PdfKernel program = program();
        List<String> known = knownFeatures(program);
        if (known != null) {
            return known;
        }
        try (RunSlots.Permit ignored = acquire(false)) {
            return features(program);
        } catch (ProgramUnavailableException e) {
            throw unavailable(e);
        }
    }

    /**
     * Whether PDFs can be made now, without a run: not on a bytecode runner, and the runtime holds a PDF program
     * (refused before the work, never after a run). The endpoints ask this before the receiver's
     * dry run, so a server that cannot print spends no sandbox run on the request.
     *
     * @throws PdfUnavailableException when it cannot
     */
    public void requireAvailable() {
        program();
    }

    /** The features remembered for this program file, or null. */
    private List<String> knownFeatures(PdfKernel program) {
        Features remembered = features;
        return remembered != null && remembered.sha256().equals(program.program().sha256()) ? remembered.names() : null;
    }

    /** The program's features, asked of the ABI gate (a run on its first call) and remembered; the caller holds a slot. */
    private List<String> features(PdfKernel program) {
        List<String> known = knownFeatures(program);
        if (known != null) {
            return known;
        }
        List<String> names = List.copyOf(program.capabilities());
        features = new Features(program.program().sha256(), names);
        return names;
    }

    /**
     * A {@code document} request: the form, layout and answers built and drawn (or a template filled) in one call.
     * With a {@code signature} of its own the request is an explicit prepare: the result's bytes are the prepared
     * file and its {@link PdfResult#signing()} the handoff ({@link #complete}). Without one, the PDF is issued:
     * sealed when the preset or the printed layout says so. A request that carries a {@code template} is taken as
     * the caller's pages and never sealed with the server's key (as {@link #fillSubmission} with
     * {@code callerTemplate}); {@link #document(ObjectNode, PdfOptions, boolean)} says otherwise for a host template.
     *
     * @param request {@code PdfDocumentRequest} without abi and op: form, layout?, pdf?, layoutId?, values, locale,
     *     translations?, formTranslations?, optionSnapshot?, theme?, title?, hostContext?, unknownComponents?, attachments?, template?,
     *     fonts?, env?, options?, today?, formulaErrors?, riskyPatterns?
     */
    public PdfResult document(ObjectNode request, PdfOptions options) {
        return document(request, options, false);
    }

    /**
     * {@link #document(ObjectNode, PdfOptions)}, saying whose a {@code template} in the request is.
     *
     * @param hostTemplate whether a {@code template} the request carries is the host's own (sealed as any issued PDF)
     *     rather than one a caller supplied (never sealed with the server's key)
     */
    public PdfResult document(ObjectNode request, PdfOptions options, boolean hostTemplate) {
        return observed("document", formKeyOf(options), () -> documentObserved(request, options, hostTemplate));
    }

    private PdfResult documentObserved(ObjectNode request, PdfOptions options, boolean hostTemplate) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode copy = prepareDocument(request, given);
        if (copy.has("signature")) {
            return validated(prepareSignature(copy), "document", given.formKey(), false);
        }
        ObjectNode definition = NODES.objectNode();
        definition.set("root", copy.get("form"));
        if (copy.path("pdf").isObject()) {
            definition.set("pdf", copy.get("pdf"));
        }
        return issue(copy, definition, given, copy.has("template") && !hostTemplate ? SealMode.NEVER : SealMode.PRESET);
    }

    /**
     * A submission's PDF: its {@code document} request, issued and sealed as planned. The answers are
     * the sandbox's sanitized values (what the form defines, nothing else).
     *
     * @param definition the form definition the answers were validated against
     * @param values the sanitized values
     * @param locale the locale texts resolve in ("en" when null)
     * @param layoutId a layout of the definition, or null (also "" or {@value #DEFAULT_LAYOUT} unless a layout has
     *     that id) for the one the answers choose
     * @param options fonts, render options, form key, translations, option snapshot, document id and time
     * @throws PdfException {@code layout.notFound} (404) for a layout the definition does not declare; the kernel's
     *     codes; {@code signature} when a layout requires a seal the server cannot make
     */
    public PdfResult renderSubmission(ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options) {
        return renderSubmission(definition, values, locale, layoutId, options, SealMode.PRESET);
    }

    /**
     * A submission's answers written into a template layout's PDF: {@link #renderSubmission} with the template's
     * bytes the layout's source names, resolved by the host (the Java fill sample).
     *
     * @param layoutId a template layout of the definition (required)
     * @param template the template PDF, or null when the layout's source is inline in the definition
     * @param callerTemplate whether the caller supplied the template: such a PDF is never sealed with the server's key
     *     (a seal says "this server issued this", and the pages are the caller's), and a layout that requires a seal
     *     is refused for it
     * @throws PdfException {@code layout.notFound} (404) for a layout the definition does not declare,
     *     {@code layout.notTemplate} (400) for one whose kind is not {@code template} (the program would print that
     *     layout and leave the template unused, so a caller's template must not decide how its PDF is sealed)
     */
    public PdfResult fillSubmission(ObjectNode definition, ObjectNode values, String locale, String layoutId, byte[] template,
                                    boolean callerTemplate, PdfOptions options) {
        return fillSubmission(definition, values, locale, layoutId, template, callerTemplate, options, SealMode.PRESET);
    }

    /**
     * {@link #fillSubmission(ObjectNode, ObjectNode, String, String, byte[], boolean, PdfOptions)} with the seal mode
     * of a host template ({@link SealMode#TEST} for answers that were never submitted); a caller's template is
     * {@link SealMode#NEVER} whatever the mode.
     */
    public PdfResult fillSubmission(ObjectNode definition, ObjectNode values, String locale, String layoutId, byte[] template,
                                    boolean callerTemplate, PdfOptions options, SealMode mode) {
        return observed("fill_submission", formKeyOf(options),
            () -> fillSubmissionObserved(definition, values, locale, layoutId, template, callerTemplate, options, mode));
    }

    private PdfResult fillSubmissionObserved(ObjectNode definition, ObjectNode values, String locale, String layoutId, byte[] template,
                                             boolean callerTemplate, PdfOptions options, SealMode mode) {
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(mode, "mode");
        if (layoutId == null || layoutId.isEmpty() || !declares(definition, layoutId)) {
            throw PdfException.layoutNotFound();
        }
        if (!isTemplateLayout(definition, layoutId)) {
            throw PdfException.layoutNotTemplate();
        }
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode request = submissionRequest(definition, values, locale, layoutId, given);
        if (template != null) {
            request.putObject("template").put("data", Base64.getEncoder().encodeToString(template));
        }
        return issue(prepareDocument(request, given), definition, given, template != null && callerTemplate ? SealMode.NEVER : mode);
    }

    /**
     * A submission's PDF sealed with the server's key whatever the preset says (the Java sign sample's endpoint):
     * the preset's certification, reason, location and timestamp, the printed layout's own block winning key by key.
     *
     * @throws PdfUnavailableException when the server has no signing key
     */
    public PdfResult signSubmission(ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options) {
        return observed("sign_submission", formKeyOf(options), () -> signSubmissionObserved(definition, values, locale, layoutId, options));
    }

    private PdfResult signSubmissionObserved(ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options) {
        if (signer == null) {
            throw new PdfUnavailableException("This server has no PDF signing key (datum.pdf.signing.*).");
        }
        return renderSubmission(definition, values, locale, layoutId, options, SealMode.FORCE);
    }

    /**
     * {@link #renderSubmission(ObjectNode, ObjectNode, String, String, PdfOptions)} under a seal mode: {@link SealMode#TEST}
     * (or {@link SealMode#TEST_FORCE}) for answers that were never submitted, which a throwaway {@link TestSeal}
     * certificate seals and never the server's key; {@link SealMode#FORCE} is {@link #signSubmission}.
     */
    public PdfResult renderSubmission(ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options, SealMode mode) {
        return observed("render_submission", formKeyOf(options), () -> renderSubmissionObserved(definition, values, locale, layoutId, options, mode));
    }

    private PdfResult renderSubmissionObserved(ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options, SealMode mode) {
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(mode, "mode");
        if (mode.forced() && signer == null) {
            // A forced seal is an explicit sign request: refused at once on a server that signs no PDFs, as
            // signSubmission, rather than delivered unsealed.
            throw new PdfUnavailableException("This server has no PDF signing key (datum.pdf.signing.*).");
        }
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode request = submissionRequest(definition, values, locale, layoutId, given);
        ObjectNode prepared = prepareDocument(request, given);
        return issue(prepared, definition, given, mode);
    }

    /**
     * The {@code document} request for some answers (PDF ABI {@code document} op).
     *
     * @throws PdfException {@code layout.notFound} when the layout is not the definition's
     */
    ObjectNode submissionRequest(ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options) {
        JsonNode root = definition.get("root");
        if (root == null || !root.isObject()) {
            throw new PdfException("definition.invalid", 422, "The definition has no root component to print.", null, null, null);
        }
        ObjectNode request = NODES.objectNode();
        request.set("form", root.deepCopy());
        if (definition.path("pdf").isObject()) {
            request.set("pdf", definition.get("pdf").deepCopy());
        }
        request.set("values", values == null ? NODES.objectNode() : values.deepCopy());
        request.put("locale", locale == null || locale.isBlank() ? "en" : locale);
        // DEFAULT_LAYOUT names no layout unless the form has one by that id: the program then chooses, by the
        // layouts' conditions and the default, on a form with layouts as on one without (where it derives one).
        boolean chosen = layoutId == null || layoutId.isEmpty() || (layoutId.equals(DEFAULT_LAYOUT) && !declares(definition, layoutId));
        if (!chosen) {
            if (!declares(definition, layoutId)) {
                throw PdfException.layoutNotFound();
            }
            request.put("layoutId", layoutId);
        }
        // The definition's own map goes with its root, beside the host catalog: the program resolves a
        // text from the catalog first, then the map, as the browser does.
        JsonNode formTranslations = definition.get("translations");
        if (formTranslations != null && formTranslations.isObject() && !formTranslations.isEmpty()) {
            request.set("formTranslations", formTranslations.deepCopy());
        }
        if (options.translations() != null && options.translations().isObject() && !options.translations().isEmpty()) {
            request.set("translations", options.translations().deepCopy());
        }
        if (options.optionSnapshot() != null && !options.optionSnapshot().isEmpty()) {
            request.set("optionSnapshot", options.optionSnapshot().deepCopy());
        }
        // The server's host context, the one the answers were judged under, so a layout's condition and a
        // field's visibility that read host. print as the verdict saw them. Set before the customizers, which may adjust it.
        if (options.hostContext() != null) {
            request.set("hostContext", options.hostContext().deepCopy());
        }
        ObjectNode env = request.putObject("env");
        env.put("createdAt", CREATED_AT.format(options.createdAt() != null ? options.createdAt() : clock.instant()));
        env.put("documentId", options.documentId() != null && !options.documentId().isEmpty() ? options.documentId() : randomId());
        env.put("producer", PRODUCER);
        return request;
    }

    /** {@code build}: the layout chosen and the document (or fill plan) built, nothing drawn. */
    public ObjectNode build(ObjectNode request, PdfOptions options) {
        return observed("build", formKeyOf(options), () -> buildObserved(request, options));
    }

    private ObjectNode buildObserved(ObjectNode request, PdfOptions options) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode copy = Objects.requireNonNull(request, "request").deepCopy();
        foldTheme(copy, given);
        stamp(copy, "build");
        customize(copy, "build", given);
        stamp(copy, "build");
        return answer(copy, false, true).answer();
    }

    /**
     * {@code render}: a built document drawn. Never sealed and never prepared for a signature: the program takes
     * certificates only from the request, so a document whose own {@code signature} block says {@code required} is
     * refused ({@code signature}). {@link #render(JsonNode, ObjectNode, PdfOptions)} prepares one.
     *
     * @param document a {@code PdfDocument} (what {@link #build} answers)
     */
    public PdfResult render(JsonNode document, PdfOptions options) {
        return render(document, null, options);
    }

    /**
     * {@code render} with a {@code signature} ({@code PdfRenderRequest.signature}): with the caller's certificates the
     * result is the prepared file and its {@link PdfResult#signing()} handoff, for the caller to sign and
     * {@link #complete}; the server's key is never used here ({@link #signWithServerKey} is that).
     *
     * @param document a {@code PdfDocument} (what {@link #build} answers)
     * @param signature a {@code PdfSignatureSpec}, or null for none
     */
    public PdfResult render(JsonNode document, ObjectNode signature, PdfOptions options) {
        return observed("render", formKeyOf(options), () -> renderObserved(document, signature, options));
    }

    private PdfResult renderObserved(JsonNode document, ObjectNode signature, PdfOptions options) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode request = NODES.objectNode();
        request.set("document", Objects.requireNonNull(document, "document").deepCopy());
        if (signature != null) {
            request.set("signature", signature.deepCopy());
        }
        request.set("fonts", fonts.pack(packOf(given)));
        request.set("env", defaultEnv(given));
        mergeOptions(request, given);
        stamp(request, "render");
        customize(request, "render", given);
        defaults(request, "render", given);
        Answered answered = answer(request, false, false);
        PdfResult result = validated(produced(answered, "render"), "render", given.formKey(), false);
        if (result.signing() == null) {
            publish(new PdfRenderedEvent(given.formKey(), "render", result.bytes(), "", false, false));
        }
        return result;
    }

    /** {@code layout}: a built document measured, page by page. */
    public ObjectNode layout(JsonNode document, PdfOptions options) {
        return observed("layout", formKeyOf(options), () -> layoutObserved(document, options));
    }

    private ObjectNode layoutObserved(JsonNode document, PdfOptions options) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode request = NODES.objectNode();
        request.set("document", Objects.requireNonNull(document, "document").deepCopy());
        request.set("fonts", fonts.pack(packOf(given)));
        request.set("env", defaultEnv(given));
        stamp(request, "layout");
        customize(request, "layout", given);
        defaults(request, "layout", given);
        return answer(request, false, false).answer();
    }

    /**
     * {@code fill}: a template's fields and areas filled from a fill plan. Never sealed; with a {@code signature} the
     * result is a prepared file and its handoff.
     *
     * @param request {@code PdfFillRequest} without abi and op: template, values, areas?, options, conformance?,
     *     attachments?, signature?, typography?, colors?, fonts?, env?
     */
    public PdfResult fill(ObjectNode request, PdfOptions options) {
        return observed("fill", formKeyOf(options), () -> fillObserved(request, options));
    }

    private PdfResult fillObserved(ObjectNode request, PdfOptions options) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode copy = Objects.requireNonNull(request, "request").deepCopy();
        if (!copy.has("fonts")) {
            copy.set("fonts", fonts.pack(packOf(given)));
        }
        if (!copy.path("env").isObject()) {
            copy.set("env", defaultEnv(given));
        }
        stamp(copy, "fill");
        customize(copy, "fill", given);
        defaults(copy, "fill", given);
        PdfResult result = validated(produced(answer(copy, false, false), "fill"), "fill", given.formKey(), false);
        if (result.signing() == null) {
            publish(new PdfRenderedEvent(given.formKey(), "fill", result.bytes(), "", false, false));
        }
        return result;
    }

    /**
     * {@code inspect}: what a PDF holds (pages, fields, permissions, signatures, embedded files).
     *
     * @param attachments {@code none}, {@code digest}, {@code data}, or null for the program's default
     * @return the program's {@code info}
     */
    public ObjectNode inspect(byte[] template, String attachments) {
        return observed("inspect", null, () -> inspectObserved(template, attachments));
    }

    private ObjectNode inspectObserved(byte[] template, String attachments) {
        Objects.requireNonNull(template, "template");
        if (attachments != null && !Set.of("none", "digest", "data").contains(attachments)) {
            throw new IllegalArgumentException("attachments is none, digest or data.");
        }
        ObjectNode request = NODES.objectNode();
        request.putObject("template").put("data", Base64.getEncoder().encodeToString(template));
        if (attachments != null) {
            request.put("attachments", attachments);
        }
        stamp(request, "inspect");
        JsonNode info = answer(request, false, false).answer().get("info");
        if (info == null || !info.isObject()) {
            throw PdfException.noPdf("The PDF program answered the inspect request without info.");
        }
        return (ObjectNode) info;
    }

    /**
     * {@code sign}, the first call of the two-call protocol: a signature field and placeholder added to any PDF, and
     * the handoff (the DER signed attributes the host signs, their digest, the algorithm).
     *
     * @param pdf the PDF
     * @param signature a {@code PdfSignatureSpec}: the settings and the certificates (DER base64, signer first)
     * @return the prepared file and its {@link PdfResult#signing()}
     */
    public PdfResult sign(byte[] pdf, ObjectNode signature, PdfOptions options) {
        return observed("sign", formKeyOf(options), () -> signObserved(pdf, signature, options));
    }

    private PdfResult signObserved(byte[] pdf, ObjectNode signature, PdfOptions options) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        ObjectNode request = NODES.objectNode();
        request.putObject("pdf").put("data", Base64.getEncoder().encodeToString(Objects.requireNonNull(pdf, "pdf")));
        request.set("signature", Objects.requireNonNull(signature, "signature").deepCopy());
        request.set("fonts", fonts.pack(packOf(given)));
        request.set("env", defaultEnv(given));
        stamp(request, "sign");
        customize(request, "sign", given);
        defaults(request, "sign", given);
        PdfResult result = produced(answer(request, false, false), "sign");
        if (result.signing() == null) {
            throw PdfException.noPdf("The PDF program prepared no signature.");
        }
        return validated(result, "sign", given.formKey(), false);
    }

    /** What {@code complete} answers: the signed file, its field, the CMS and whether a token is in. */
    public record Completed(byte[] bytes, String field, byte[] cms, boolean timestamped) {

        public Completed {
            bytes = bytes.clone();
            cms = cms.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }

        @Override
        public byte[] cms() {
            return cms.clone();
        }
    }

    /**
     * {@code complete}, the second call: the host's signature value (and a timestamp token) embedded in a prepared
     * PDF. Waits for a slot as long as one render may take (a seal half done is not answered busy).
     *
     * @param prepared the prepared PDF
     * @param completion a {@code PdfSignatureCompletion}: value (base64; ECDSA in DER), the same certificates (and
     *     commitment) the prepare had, toBeSignedDigest, and {@code timestamp.token} (a TimeStampToken or the whole
     *     TimeStampResp, base64) when there is one
     */
    public Completed complete(byte[] prepared, ObjectNode completion, String formKey) {
        return observed("complete", formKey, () -> completeObserved(prepared, completion, formKey));
    }

    private Completed completeObserved(byte[] prepared, ObjectNode completion, String formKey) {
        ObjectNode request = NODES.objectNode();
        request.putObject("pdf").put("data", Base64.getEncoder().encodeToString(Objects.requireNonNull(prepared, "prepared")));
        request.set("signing", Objects.requireNonNull(completion, "completion").deepCopy());
        stamp(request, "complete");
        ObjectNode answer = answer(request, true, false).answer();
        byte[] bytes = pdf(answer.get("bytes"));
        byte[] cms = Base64Strict.decode(answer.get("cms"));
        Completed completed = new Completed(bytes, answer.path("field").isString() ? answer.path("field").stringValue() : "",
            cms == null ? new byte[0] : cms, answer.path("timestamped").isBoolean() && answer.path("timestamped").booleanValue());
        publish(new PdfRenderedEvent(formKey, "complete", bytes, "", true, completed.timestamped()));
        return completed;
    }

    /**
     * {@code timestampRequest}: the RFC 3161 TimeStampReq the program builds over a signature value (SHA-256 imprint,
     * certReq), for a host that posts it to a timestamp server itself.
     *
     * @return the request, DER ({@code application/timestamp-query})
     */
    public byte[] timestampRequest(byte[] signatureValue) {
        return observed("timestamp_request", null, () -> timestampRequestObserved(signatureValue));
    }

    private byte[] timestampRequestObserved(byte[] signatureValue) {
        ObjectNode request = NODES.objectNode();
        request.put("signature", Base64.getEncoder().encodeToString(Objects.requireNonNull(signatureValue, "signatureValue")));
        stamp(request, "timestampRequest");
        byte[] der = Base64Strict.decode(answer(request, true, false).answer().get("request"));
        if (der == null || der.length == 0) {
            throw PdfException.noPdf("The PDF program answered without a timestamp request.");
        }
        return der;
    }

    /**
     * Seals any PDF with the server's key: {@code sign} with the server's certificates, the value signed here,
     * optionally timestamped, {@code complete}d.
     *
     * @param settings {@code PdfSignatureSettings} (certify, reason, field, appearance, timestamp, commitment, ...):
     *     only those keys are read; the certificates are always the server's
     * @throws PdfUnavailableException when the server has no signing key
     */
    public PdfResult signWithServerKey(byte[] pdf, ObjectNode settings, PdfOptions options) {
        return observed("sign_with_server_key", formKeyOf(options), () -> signWithServerKeyObserved(pdf, settings, options));
    }

    private PdfResult signWithServerKeyObserved(byte[] pdf, ObjectNode settings, PdfOptions options) {
        PdfOptions given = options == null ? PdfOptions.defaults() : options;
        if (signer == null) {
            throw new PdfUnavailableException("This server has no PDF signing key (datum.pdf.signing.*).");
        }
        ObjectNode spec = NODES.objectNode();
        if (settings != null) {
            settings.properties().forEach(entry -> {
                if (SETTINGS_KEYS.contains(entry.getKey())) {
                    spec.set(entry.getKey(), entry.getValue().deepCopy());
                }
            });
        }
        boolean timestamp = spec.path("timestamp").isBoolean() && spec.path("timestamp").booleanValue() && timestamper != null;
        spec.put("timestamp", timestamp);
        ArrayNode certificates = spec.putArray("certificates");
        signer.certificatesBase64().forEach(certificates::add);
        PdfResult prepared = sign(pdf, spec, given);
        Plan plan = new Plan(spec, signer, timestamp, commitmentOf(spec), null, null, false);
        return sealPrepared(prepared, plan, new ArrayList<>(prepared.warnings()), given.formKey());
    }

    /**
     * Checks a PDF: the program's {@code verify} completed host-side (the signature values, the signers placed, each
     * timestamp token checked whole; PDF ABI 3.14.0, the verify detail).
     *
     * @throws RequestTooLargeException (413) past {@link #verifyMaxBytes()}
     * @throws PdfException {@code pdf.notAPdf} (400) for a file that is not a PDF; {@code pdf.unreadable} (400) for
     *     one the program refuses to read (encrypted, unparseable, too many signatures), the kernel's code and message
     *     on {@link PdfException#kernelCode()} and {@link PdfException#kernelMessage()}; the file is the caller's, so
     *     a refusal to read it is a 400, where other kernel refusals are 500
     */
    public PdfVerification verify(byte[] pdf) {
        return observed("verify", null, () -> verifyObserved(pdf));
    }

    private PdfVerification verifyObserved(byte[] pdf) {
        Objects.requireNonNull(pdf, "pdf");
        if (pdf.length > verifyMaxBytes) {
            throw new RequestTooLargeException(verifyMaxBytes, "The file is over " + (verifyMaxBytes / (1024 * 1024)) + " MiB.");
        }
        if (!looksLikePdf(pdf)) {
            throw PdfException.notAPdf();
        }
        String sha256 = sha256(pdf);
        ObjectNode answer;
        try {
            answer = verifyRaw(pdf);
        } catch (PdfException e) {
            // The program refused the caller's file (encrypted, unparseable, too many signatures): a client mistake,
            // never a 500 that pages the operator. The host's own request is fixed and capped (knownCertificates),
            // so only an ABI mismatch stays the server's fault.
            if (e.kernelCode() == null || "abi_mismatch".equals(e.kernelCode())) {
                throw e;
            }
            LOG.info("Datum PDF verify: the program refused a posted file (SHA-256 {}): {} {}", sha256, e.kernelCode(), e.kernelMessage());
            throw PdfException.unreadable(e);
        }
        PdfVerification verification = verifier.complete(sha256, pdf.length, answer);
        // What the verifier answered (an application's own subclass included), never the file.
        events.publish(new PdfVerifiedEvent(verification.sha256(), verification.bytes(), verification.documentId(),
            verification.signatures(), verification.trustPolicy()));
        return verification;
    }

    /** The program's own {@code verify} answer for a PDF, with the certificates the server knows. */
    public ObjectNode verifyRaw(byte[] pdf) {
        return observed("verify_raw", null, () -> verifyRawObserved(pdf));
    }

    private ObjectNode verifyRawObserved(byte[] pdf) {
        ObjectNode request = NODES.objectNode();
        request.putObject("pdf").put("data", Base64.getEncoder().encodeToString(Objects.requireNonNull(pdf, "pdf")));
        List<String> known = verifier.knownCertificates();
        if (!known.isEmpty()) {
            ArrayNode list = request.putArray("knownCertificates");
            known.forEach(list::add);
        }
        stamp(request, "verify");
        return answer(request, false, false).answer();
    }

    /**
     * Whether the first kilobyte starts with {@code %PDF-} after leading whitespace (space, tab, line ends, NUL, VT):
     * readers find a header there, so a file with a few bytes in front is still read; anything else is refused 400
     * before a run.
     */
    static boolean looksLikePdf(byte[] bytes) {
        int at = 0;
        int end = Math.min(bytes.length, 1024);
        while (at < end && (bytes[at] == ' ' || bytes[at] == '\t' || bytes[at] == '\n' || bytes[at] == '\r' || bytes[at] == 0 || bytes[at] == 0x0b)) {
            at++;
        }
        byte[] magic = {'%', 'P', 'D', 'F', '-'};
        if (end - at < magic.length) {
            return false;
        }
        for (int i = 0; i < magic.length; i++) {
            if (bytes[at + i] != magic[i]) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------------------------------------- issuing

    /** A seal plan: what to prepare and with which key, and whether that key is a throwaway {@link TestSeal} one. */
    record Plan(ObjectNode spec, PdfSigner signer, boolean timestamp, JsonNode commitment, String refuse, String warn, boolean test) {

        static final Plan NONE = new Plan(null, null, false, null, null, null, false);

        static Plan refuse(String why) {
            return new Plan(null, null, false, null, why, null, false);
        }

        static Plan warn(String why) {
            return new Plan(null, null, false, null, null, why, false);
        }

        /** Whether two plans differ in anything but their keys (the JSON compared as values). */
        boolean differs(Plan other) {
            return !Objects.equals(spec, other.spec) || timestamp != other.timestamp || !Objects.equals(commitment, other.commitment)
                || !Objects.equals(refuse, other.refuse) || !Objects.equals(warn, other.warn) || test != other.test;
        }
    }

    /**
     * The throwaway key of one issue, made when first needed, one per request, so a plan made twice (the answers
     * choosing the layout) does not differ by its certificate alone.
     */
    static final class TestKey {

        private final Clock clock;
        private PdfSigner key;
        private RuntimeException failure;

        TestKey(Clock clock) {
            this.clock = clock;
        }

        PdfSigner get() {
            if (key == null && failure == null) {
                try {
                    key = TestSeal.key(clock);
                } catch (RuntimeException e) {
                    failure = e;
                }
            }
            if (failure != null) {
                throw failure;
            }
            return key;
        }
    }

    /**
     * Issues a {@code document} request, sealed as planned. A guess that would
     * be refused is not refused yet: the answers may choose another layout, so it renders unsealed first to find out
     * which; when the layout printed is not the one guessed, it renders again by id under that layout's own plan.
     */
    PdfResult issue(ObjectNode request, ObjectNode definition, PdfOptions options, SealMode mode) {
        TestKey testKey = new TestKey(clock);
        String asked = request.path("layoutId").isString() ? request.path("layoutId").stringValue() : null;
        String guess = asked != null ? asked : guess(definition);
        Plan plan = plan(guess, definition, mode, testKey);
        boolean probe = asked == null && plan.refuse() != null;
        Plan rendered = probe ? Plan.NONE : plan;
        PdfResult result = attempt(request.deepCopy(), rendered);
        String printed = !result.layoutId().isEmpty() ? result.layoutId() : guess;
        if (asked == null && (probe || !printed.equals(guess))) {
            // The answers chose: render the layout they chose by id, under its own plan, when that differs
            // from what was rendered.
            Plan actual = printed.equals(guess) ? plan : plan(printed, definition, mode, testKey);
            if (rendered.differs(actual)) {
                request.put("layoutId", printed);
                result = attempt(request.deepCopy(), actual);
            }
            plan = actual;
        }
        // The application's validators judge the PDF the answers chose, before any seal: a refused PDF costs no signature.
        result = validated(result, "document", options.formKey(), result.signing() != null && plan.signer() != null);
        List<ObjectNode> warnings = new ArrayList<>(result.warnings());
        if (plan.warn() != null) {
            warnings.add(warning("sealing.unavailable", plan.warn()));
            LOG.warn("Datum PDF: a PDF of {} was delivered unsealed: {}", options.formKey() == null ? "a form" : options.formKey(), plan.warn());
        }
        if (result.signing() == null || plan.signer() == null) {
            PdfResult plain = warnings.size() == result.warnings().size() ? result : result.withWarnings(warnings);
            publish(new PdfRenderedEvent(options.formKey(), "document", plain.bytes(), plain.layoutId(), false, false));
            return plain;
        }
        return sealPrepared(result, plan, warnings, options.formKey());
    }

    /** Renders once under a plan. */
    private PdfResult attempt(ObjectNode request, Plan plan) {
        if (plan.refuse() != null) {
            throw PdfException.signature(plan.refuse());
        }
        if (plan.spec() == null) {
            request.remove("signature");
            return produced(answer(request, false, false), "document");
        }
        request.set("signature", plan.spec().deepCopy());
        return prepareSignature(request);
    }

    /** A {@code document} request with a {@code signature}: the prepare half of a seal. */
    private PdfResult prepareSignature(ObjectNode request) {
        JsonNode signature = request.get("signature");
        if (signature == null || !signature.isObject()) {
            throw PdfException.noPdf("A signature is prepared only for a request that carries one.");
        }
        PdfResult result = produced(answer(request, false, false), "document");
        if (result.signing() == null) {
            throw PdfException.noPdf("The PDF program prepared no signature.");
        }
        return result;
    }

    /** {@link #plan(String, ObjectNode, SealMode, TestKey)} with a key of its own (one plan, tests). */
    Plan plan(String layout, ObjectNode definition, SealMode mode) {
        return plan(layout, definition, mode, new TestKey(clock));
    }

    /**
     * What sealing one layout takes. The signature to prepare (settings and certificates) and
     * the key, or none; whether to timestamp; the commitment complete must repeat; why the render must fail, or why
     * it goes out unsealed.
     *
     * <p>A test mode ({@link SealMode#TEST}, {@link SealMode#TEST_FORCE}) is planned as a real issue, so a layout that
     * requires a seal fails there too while the server has no key, but the key is the issue's throwaway
     * {@link TestSeal} certificate, never the server's: the reason is {@value TestSeal#REASON} and no timestamp is
     * asked for. Whether a test seal is made at all is whether the server has a signing key (a server that signs
     * nothing makes no test seal either).
     */
    Plan plan(String layout, ObjectNode definition, SealMode mode, TestKey testKey) {
        ObjectNode declared = layoutSignature(definition, layout);
        // NEVER still asks the preset, so a PDF the preset would have sealed says why it was not.
        boolean formSeals = mode.forced() || seal.seals(layout);
        if (!formSeals && declared == null) {
            return Plan.NONE;
        }
        boolean required = declared != null && declared.path("required").isBoolean() && declared.path("required").booleanValue();
        boolean test = mode.test();
        PdfSigner key = null;
        String why = null;
        if (mode == SealMode.NEVER) {
            why = "a template the caller posted is never sealed with the server's key.";
        } else if (signer == null) {
            why = "the server has no PDF signing key (datum.pdf.signing.*).";
        } else if (test) {
            try {
                key = testKey.get();
            } catch (RuntimeException e) {
                why = "no test certificate could be made: " + e.getMessage();
            }
        } else {
            key = signer;
        }
        if (key == null) {
            if (required) {
                return Plan.refuse(String.format("The PDF layout \"%s\" requires a sealed PDF, and %s", layout, why));
            }
            if (test) {
                return Plan.warn("The test PDF is not sealed: " + why);
            }
            // A layout's own non-required block already warns through the program (signature.noCertificates); the
            // host's own wish warns here.
            return formSeals ? Plan.warn("The server seals its PDFs, and " + why) : Plan.NONE;
        }
        ObjectNode spec = NODES.objectNode();
        if (formSeals) {
            String certify = seal.certify().kernelWord();
            if (certify == null) {
                spec.put("certify", false);
            } else {
                spec.put("certify", certify);
            }
            putText(spec, "reason", seal.reason());
            putText(spec, "location", seal.location());
            if (Boolean.FALSE.equals(seal.visible())) {
                spec.put("appearance", false);
            }
        }
        // The layout's own keys win: the program merges the request's over them, so the preset's are left out where
        // the layout has its own.
        for (String name : LAYOUT_KEYS) {
            if (declared != null && declared.has(name)) {
                spec.remove(name);
            }
        }
        if (test) {
            spec.put("reason", TestSeal.REASON);
        }
        boolean wantsTimestamp = (formSeals && seal.timestamp())
            || (declared != null && declared.path("timestamp").isBoolean() && declared.path("timestamp").booleanValue());
        // A test seal asks no timestamp server: nothing about it is evidence.
        boolean timestamp = !test && wantsTimestamp && timestamper != null;
        spec.put("timestamp", timestamp);
        ArrayNode certificates = spec.putArray("certificates");
        key.certificatesBase64().forEach(certificates::add);
        return new Plan(spec, key, timestamp, commitmentOf(declared), null, null, test);
    }

    /** A reason or location: trimmed, at most 500 characters (code points, so a cut never splits a pair). */
    private static void putText(ObjectNode spec, String name, String text) {
        if (text == null) {
            return;
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return;
        }
        int count = trimmed.codePointCount(0, trimmed.length());
        spec.put(name, count <= 500 ? trimmed : trimmed.substring(0, trimmed.offsetByCodePoints(0, 500)));
    }

    /**
     * The commitment {@code complete} must repeat: the block's {@code commitment} exactly as the prepare had it (the
     * program merges the request's settings over the layout's, and the host never sends one of its own), or null
     * when there is none (absent, or JSON null, which the program reads as none).
     *
     * <p>Not normalised here: a host that dropped a whitespace-only statement (or the whole commitment for an unknown
     * type) would hand {@code complete} another commitment than the program's {@code commitmentOf} kept (it keeps every
     * statement but ""), so {@code complete} would rebuild other signed attributes than {@code sign} handed out and
     * refuse them, and a layout whose statement was blank could never be sealed. The program reads only the
     * type and the statement, the same way on both calls, and refuses a bad one at the prepare, before any value
     * is made.
     */
    static JsonNode commitmentOf(ObjectNode block) {
        JsonNode commitment = block == null ? null : block.get("commitment");
        return commitment == null || commitment.isNull() ? null : commitment.deepCopy();
    }

    /** The layout the program is likeliest to print when none is asked for: the declared default, else the first. */
    static String guess(ObjectNode definition) {
        JsonNode pdf = definition.path("pdf");
        JsonNode chosen = pdf.get("defaultLayoutId");
        if (chosen != null && chosen.isString() && !chosen.stringValue().isEmpty()) {
            return chosen.stringValue();
        }
        for (JsonNode layout : pdf.path("layouts").isArray() ? pdf.path("layouts").values() : List.<JsonNode>of()) {
            JsonNode id = layout.get("id");
            if (id != null && id.isString() && !id.stringValue().isEmpty()) {
                return id.stringValue();
            }
        }
        return DEFAULT_LAYOUT;
    }

    /** A layout's own {@code signature} block, when it declares one. */
    public static ObjectNode layoutSignature(ObjectNode definition, String layout) {
        JsonNode layouts = definition.path("pdf").path("layouts");
        for (JsonNode candidate : layouts.isArray() ? layouts.values() : List.<JsonNode>of()) {
            JsonNode id = candidate.get("id");
            if (id != null && id.isString() && id.stringValue().equals(layout)) {
                JsonNode signature = candidate.get("signature");
                return signature != null && signature.isObject() ? (ObjectNode) signature : null;
            }
        }
        return null;
    }

    /** Whether the definition declares a layout by this id. */
    static boolean declares(ObjectNode definition, String id) {
        JsonNode layouts = definition.path("pdf").path("layouts");
        for (JsonNode layout : layouts.isArray() ? layouts.values() : List.<JsonNode>of()) {
            JsonNode candidate = layout.get("id");
            if (candidate != null && candidate.isString() && candidate.stringValue().equals(id)) {
                return true;
            }
        }
        return false;
    }

    /** Whether the definition's layout by this id is a template layout ({@code kind: "template"}). */
    public static boolean isTemplateLayout(ObjectNode definition, String id) {
        JsonNode layouts = definition.path("pdf").path("layouts");
        for (JsonNode layout : layouts.isArray() ? layouts.values() : List.<JsonNode>of()) {
            JsonNode candidate = layout.get("id");
            if (candidate != null && candidate.isString() && candidate.stringValue().equals(id)) {
                return layout.path("kind").isString() && layout.path("kind").stringValue().equals("template");
            }
        }
        return false;
    }

    /**
     * Signs a prepared PDF, timestamps the signature, completes it (the two-call sign and complete). A token the
     * program refuses (it vouches for something else) costs the timestamp, not the seal.
     */
    private PdfResult sealPrepared(PdfResult prepared, Plan plan, List<ObjectNode> warnings, String formKey) {
        PdfSigner key = plan.signer();
        PdfSigningHandoff signing = prepared.signing();
        byte[] toBeSigned = Base64Strict.decode(signing.toBeSigned());
        if (toBeSigned == null || toBeSigned.length == 0) {
            throw PdfException.noPdf("The PDF program handed out nothing to sign.");
        }
        byte[] preparedBytes = prepared.bytes();
        requireHandoffOver(preparedBytes, signing, toBeSigned);
        long started = System.nanoTime();
        byte[] value;
        try {
            value = key.sign(toBeSigned, signing.signatureAlgorithm());
        } catch (PdfException e) {
            throw e;
        } catch (RuntimeException e) {
            throw PdfException.signature("The server's key could not sign the PDF.", e);
        }
        requireUsableValue(value, toBeSigned, signing.signatureAlgorithm(), key.leaf());
        ObjectNode completion = NODES.objectNode();
        completion.put("value", Base64.getEncoder().encodeToString(value));
        ArrayNode certificates = completion.putArray("certificates");
        key.certificatesBase64().forEach(certificates::add);
        completion.put("toBeSignedDigest", signing.toBeSignedDigest() == null ? "" : signing.toBeSignedDigest());
        completion.put("field", signing.field() == null ? "" : signing.field());
        if (plan.commitment() != null) {
            completion.set("commitment", plan.commitment().deepCopy());
        }
        if (plan.timestamp()) {
            byte[] token = timestamp(value, warnings);
            if (token != null) {
                completion.putObject("timestamp").put("token", Base64.getEncoder().encodeToString(token));
            }
        }
        Completed completed;
        try {
            completed = completeQuietly(preparedBytes, completion);
        } catch (PdfException e) {
            if (!completion.has("timestamp")) {
                throw e;
            }
            String said = e.kernelMessage() != null ? e.kernelMessage() : e.getMessage();
            warnings.add(warning("sealing.timestamp", "The timestamp server’s token was refused: " + said));
            LOG.warn("Datum PDF: the timestamp token for a PDF of {} was refused, and the PDF was sealed without it: {}",
                formKey == null ? "a form" : formKey, said);
            completion.remove("timestamp");
            completed = completeQuietly(preparedBytes, completion);
        }
        byte[] bytes = completed.bytes();
        // Timestamped only when a token was handed over AND the program says it embedded one (its complete answer's
        // `timestamped`): the reply's X-Timestamped and the event must not claim a token the file lacks.
        boolean handedOver = completion.has("timestamp");
        boolean timestamped = handedOver && completed.timestamped();
        if (handedOver && !completed.timestamped()) {
            warnings.add(warning("sealing.timestamp", "The PDF program did not embed the timestamp token. The PDF is sealed without one."));
            LOG.warn("Datum PDF: the PDF program did not embed the timestamp token for a PDF of {}; the PDF is sealed without one.",
                formKey == null ? "a form" : formKey);
        }
        PdfSeal sealed = new PdfSeal(com.argusvane.datum.pdf.verify.Certificates.fingerprint(key.leaf()),
            com.argusvane.datum.pdf.verify.Certificates.subject(key.leaf()), timestamped,
            signing.field() == null ? "" : signing.field(), sha256(bytes), plan.test());
        double elapsed = prepared.elapsedMs() + (System.nanoTime() - started) / 1e6;
        PdfResult result = prepared.withSeal(bytes, warnings, elapsed, sealed);
        // A test seal is not the server's: the event says unsigned, so a listener recording issued PDFs leaves it out.
        publish(new PdfRenderedEvent(formKey, "document", bytes, result.layoutId(), !plan.test(), timestamped));
        return result;
    }

    /** {@code complete} without the event (the seal publishes its own, as "document"). */
    private Completed completeQuietly(byte[] prepared, ObjectNode completion) {
        ObjectNode request = NODES.objectNode();
        request.putObject("pdf").put("data", Base64.getEncoder().encodeToString(prepared));
        request.set("signing", completion.deepCopy());
        stamp(request, "complete");
        ObjectNode answer = answer(request, true, false).answer();
        byte[] bytes = pdf(answer.get("bytes"));
        byte[] cms = Base64Strict.decode(answer.get("cms"));
        return new Completed(bytes, answer.path("field").isString() ? answer.path("field").stringValue() : "",
            cms == null ? new byte[0] : cms, answer.path("timestamped").isBoolean() && answer.path("timestamped").booleanValue());
    }

    /**
     * The handoff is over the prepared bytes, checked before the server's key signs anything ({@code complete}
     * re-derives it all from the bytes, but only after the key has made a value, so the key would otherwise sign what
     * the sandboxed program handed out): the byte range is {@code [0, a, b, c]} with {@code a < b} and {@code b + c} the
     * file's length (one gap, reaching the end, as {@code complete} requires); {@code digest} is the SHA-256 over
     * those ranges; {@code toBeSignedDigest} is the SHA-256 of {@code toBeSigned}; and {@code toBeSigned} is a DER
     * SET of attributes holding exactly one {@code messageDigest} whose one value is that digest. So a program answer
     * shaped otherwise (a bug reachable from answer values or a template) cannot make the key sign attributes of
     * anything but the file this server delivers.
     */
    static void requireHandoffOver(byte[] prepared, PdfSigningHandoff signing, byte[] toBeSigned) {
        List<Long> range = signing.byteRange();
        if (range == null || range.size() != 4 || range.stream().anyMatch(n -> n == null || n < 0)) {
            throw PdfException.signature("The PDF program's signing handoff has no byte range of four offsets.");
        }
        long a = range.get(1);
        long b = range.get(2);
        long c = range.get(3);
        if (range.get(0) != 0 || a >= b || b + c != prepared.length) {
            throw PdfException.signature("The PDF program's byte range does not cover the prepared file but for one gap.");
        }
        MessageDigest sha256 = sha256Digest();
        sha256.update(prepared, 0, (int) a);
        sha256.update(prepared, (int) b, (int) c);
        byte[] digest = sha256.digest();
        byte[] said = Base64Strict.decode(signing.digest());
        if (said == null || !MessageDigest.isEqual(digest, said)) {
            throw PdfException.signature("The PDF program's digest is not the digest of the prepared file.");
        }
        byte[] toBeSignedDigest = Base64Strict.decode(signing.toBeSignedDigest());
        if (toBeSignedDigest == null || !MessageDigest.isEqual(sha256Digest().digest(toBeSigned), toBeSignedDigest)) {
            throw PdfException.signature("The PDF program's toBeSignedDigest is not the digest of what it handed out to sign.");
        }
        byte[] inAttributes = Der.messageDigest(toBeSigned);
        if (inAttributes == null || !MessageDigest.isEqual(digest, inAttributes)) {
            throw PdfException.signature("The signed attributes the PDF program handed out are not over the prepared file.");
        }
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }

    /**
     * The value a signer handed back is one {@code complete} may embed, checked before it is (a stricter host check:
     * an ECDSA signer must hand over
     * DER, never P1363, or complete refuses): an ECDSA value is a DER {@code SEQUENCE} of two {@code INTEGER}s, and
     * every value verifies over {@code toBeSigned} with the leaf certificate's key.
     */
    static void requireUsableValue(byte[] value, byte[] toBeSigned, String algorithm, X509Certificate leaf) {
        if (value == null || value.length == 0) {
            throw PdfException.signature("The server's key gave no signature value.");
        }
        String jca;
        if ("RSASSA-PKCS1-v1_5-SHA256".equals(algorithm)) {
            jca = "SHA256withRSA";
        } else if ("ECDSA-P256-SHA256".equals(algorithm) || "ECDSA-P384-SHA256".equals(algorithm)) {
            if (!Der.isEcdsaSignature(value)) {
                throw PdfException.signature("The server's key gave an ECDSA value that is not DER (a P1363 r||s value?): the signer must "
                    + "use SHA256withECDSA.");
            }
            jca = "SHA256withECDSA";
        } else {
            throw PdfException.signature("The PDF asks for a signature algorithm this server does not make: " + algorithm + ".");
        }
        try {
            Signature verifier = Signature.getInstance(jca);
            verifier.initVerify(leaf.getPublicKey());
            verifier.update(toBeSigned);
            if (!verifier.verify(value)) {
                throw PdfException.signature("The server's signature value does not verify with its own certificate.");
            }
        } catch (java.security.GeneralSecurityException e) {
            throw PdfException.signature("The server's signature value does not verify with its own certificate.", e);
        }
    }

    /**
     * An RFC 3161 token over a signature value: from the timestamp server the host names, or its own authority.
     * None is a warning, never a failed seal: a timestamper that throws,
     * or one that answers nothing.
     *
     * @return the TimeStampResp (DER), or null
     */
    private byte[] timestamp(byte[] signature, List<ObjectNode> warnings) {
        byte[] token;
        try {
            token = timestamper.stamp(signature, "sealing");
        } catch (RuntimeException e) {
            String problem = e.getMessage() == null ? "The timestamp server gave no token." : e.getMessage();
            warnings.add(warning("sealing.timestamp", problem + " The PDF is sealed without one."));
            LOG.warn("Datum PDF: {} The PDF was sealed without a timestamp.", problem);
            return null;
        }
        if (token == null || token.length == 0) {
            warnings.add(warning("sealing.timestamp", "The timestamp server gave no token. The PDF is sealed without one."));
            LOG.warn("Datum PDF: the timestamp server gave no token. The PDF was sealed without a timestamp.");
            return null;
        }
        return token;
    }

    // ------------------------------------------------------------------------------------------------- one run

    /** One answered run: the program's reply and the run's wall time. */
    record Answered(ObjectNode answer, double elapsedMs) {
    }

    /**
     * Runs one request in a PDF slot and returns a successful answer.
     *
     * @param patient whether to wait for a slot as long as one render may take
     * @param formulas whether to add the host's formula inputs (a program with the {@code formulas} feature)
     */
    /**
     * One operation of this service, observed: {@value DatumObservationNames#PDF} with its op from the
     * start and, at the end, the outcome, how the PDF was sealed and where its timestamp came from (never a byte, a digest or
     * an answer), the form's key (high-cardinality) when it is a well-formed key. Every program run, slot wait, seal and
     * timestamp of the operation is inside it. An operation another one calls (a signed submission renders one) is part of
     * the outer observation, not one of its own. Without observations the work runs as it is.
     */
    private <T> T observed(String op, String formKey, Supplier<T> work) {
        if (!observations.enabled() || observing.get() != null) {
            return work.get();
        }
        // Started before the flag is set, and the flag set only inside the try whose finally clears it: a handler, filter or
        // convention that throws in start (Micrometer does not catch them) must not leave the flag on this pooled thread, or
        // every later operation on it would go unobserved without a word.
        DatumObservation observation = observations.start(DatumObservationNames.PDF, "datum pdf " + op, DatumObservationNames.OP, op);
        try {
            observing.set(Boolean.TRUE);
            if (formKey != null && FormKeys.isValid(formKey)) {
                observation.highCardinality(DatumObservationNames.FORM, formKey);
            }
            T answer = work.get();
            observation.lowCardinality(DatumObservationNames.OUTCOME, "ok").lowCardinality(DatumObservationNames.SEAL, sealOf(answer))
                .lowCardinality(DatumObservationNames.TIMESTAMP, timestampOf(answer));
            return answer;
        } catch (RuntimeException | Error e) {
            observation.lowCardinality(DatumObservationNames.OUTCOME, DatumObservations.outcomeOf(e))
                .lowCardinality(DatumObservationNames.SEAL, DatumObservationNames.NONE)
                .lowCardinality(DatumObservationNames.TIMESTAMP, DatumObservationNames.NONE).error(e);
            throw e;
        } finally {
            observation.close();
            observing.remove();
        }
    }

    private static String formKeyOf(PdfOptions options) {
        return options == null ? null : options.formKey();
    }

    /** {@code server}, {@code test} or {@code none}: how an operation's PDF was sealed. */
    private static String sealOf(Object answer) {
        if (answer instanceof PdfResult result && result.seal() != null) {
            return result.seal().test() ? "test" : "server";
        }
        return DatumObservationNames.NONE;
    }

    /** Where a sealed PDF's timestamp came from: the source word ({@code site}, {@code custom}, {@code server}), or none. */
    private String timestampOf(Object answer) {
        boolean timestamped = answer instanceof PdfResult result ? result.timestamped() : answer instanceof Completed completed && completed.timestamped();
        if (!timestamped) {
            return DatumObservationNames.NONE;
        }
        return switch (timestampSource) {
            case "" -> DatumObservationNames.NONE;
            case "site", "custom" -> timestampSource;
            default -> "server";
        };
    }

    private Answered answer(ObjectNode request, boolean patient, boolean formulas) {
        PdfKernel program = program();
        try (RunSlots.Permit ignored = acquire(patient)) {
            if (formulas || "document".equals(request.path("op").asString(""))) {
                addFormulaInputs(request, program);
            }
            long started = System.nanoTime();
            ObjectNode answer = program.call(request);
            return new Answered(answer, (System.nanoTime() - started) / 1e6);
        } catch (SandboxException e) {
            if (e.reason() == SandboxException.Reason.REFUSED) {
                throw PdfException.kernel(e.programCode(), e.programMessage());
            }
            throw e;
        } catch (ProgramUnavailableException e) {
            throw unavailable(e);
        }
    }

    /**
     * Adds the keys the host decides to a request that has not set them: {@code today}, {@code formulaErrors},
     * {@code riskyPatterns}, only for a program with the {@code formulas} feature. A caller's {@code today} (the day a
     * submission was judged) is kept.
     */
    private void addFormulaInputs(ObjectNode request, PdfKernel program) {
        if (!features(program).contains("formulas")) {
            return;
        }
        for (Map.Entry<String, String> key : runtime.contextKeys().entrySet()) {
            JsonNode present = request.get(key.getKey());
            if (present == null || present.isNull()) {
                request.put(key.getKey(), key.getValue());
            }
        }
    }

    /**
     * The PDF program, or why not: an engine that cannot run it here first (the runtime's decision from the
     * engine's mode, {@code ProgramRunner.canRunPdf}, false on Endive's bytecode fallback), then the runtime's own answer.
     */
    private PdfKernel program() {
        EngineInfo engine = runtime.engine();
        if (!ProgramRunner.canRunPdf(engine)) {
            throw new PdfUnavailableException("PDFs cannot be made on this server: " + (engine.isBytecode()
                ? "the " + engine.id() + " engine runs QuickJS as JVM bytecode here, and the PDF program needs a native mode"
                : "the " + engine.id() + " engine cannot run the PDF program here (mode " + engine.mode() + ")")
                + (engine.notes().isEmpty() ? "." : ". " + engine.notes()));
        }
        try {
            return runtime.program();
        } catch (ProgramUnavailableException e) {
            throw unavailable(e);
        }
    }

    private static PdfUnavailableException unavailable(ProgramUnavailableException e) {
        return e instanceof PdfUnavailableException pdf ? pdf : new PdfUnavailableException(e.getMessage(), e);
    }

    /**
     * Takes a PDF slot. Impatient: within the slots' own wait, else busy. Patient: within the longer of that wait and
     * one render's budget, one timed wait on the fair slots ({@link RunSlots#acquire(Duration)}), so a seal half done is
     * not thrown away while another render runs.
     */
    private RunSlots.Permit acquire(boolean patient) {
        RunSlots slots = runtime.slots();
        return patient ? slots.acquire(Duration.ofSeconds(Math.max(1, runtime.pdfSeconds()))) : slots.acquire();
    }

    // ------------------------------------------------------------------------------------------------- requests

    /** A {@code document} request made ready: abi and op, the customizers, then the host's defaults. */
    private ObjectNode prepareDocument(ObjectNode request, PdfOptions options) {
        ObjectNode copy = Objects.requireNonNull(request, "request").deepCopy();
        if (!copy.path("fonts").isArray()) {
            copy.set("fonts", fonts.pack(packOf(options)));
        }
        if (!copy.path("env").isObject()) {
            copy.set("env", defaultEnv(options));
        }
        mergeOptions(copy, options);
        foldTheme(copy, options);
        stamp(copy, "document");
        customize(copy, "document", options);
        defaults(copy, "document", options);
        return copy;
    }

    /**
     * The host rung of the PDF ladder: the theme object of the form's binding's PDF theme, when the request names no
     * theme of its own. Nothing is written into the layout, and a request that carries a theme keeps it.
     */
    private void foldTheme(ObjectNode request, PdfOptions options) {
        if (bindings == null || options.formKey() == null || request.has("theme")) {
            return;
        }
        JsonNode theme = bindings.pdfTheme(options.formKey());
        if (theme != null) {
            request.set("theme", theme.deepCopy());
        }
    }

    /** The id of the PDF theme a form's binding suggests, or null: what the reply names ({@code X-Datum-Pdf-Theme}). */
    public String pdfThemeId(String formKey) {
        return bindings == null ? null : bindings.pdfThemeId(formKey);
    }

    /** Sets the ABI and the op, over whatever the request said. */
    private static void stamp(ObjectNode request, String op) {
        request.put("abi", ABI);
        request.put("op", op);
    }

    /** The customizers, in order, over the members the op lets them touch; abi and op are set again after. */
    private void customize(ObjectNode request, String op, PdfOptions options) {
        if (customizers.isEmpty() || !PdfRequestDraft.customizable(op)) {
            return;
        }
        for (PdfRequestCustomizer customizer : customizers) {
            PdfRequestDraft draft = new PdfRequestDraft(op, options.formKey(), request);
            customizer.customize(draft);
            draft.applyTo(request);
        }
        stamp(request, op);
    }

    /**
     * What the renderer adds when the request has none (fonts and env, only when it has none),
     * after the customizers, so a customizer that drops them still sends a valid request.
     */
    private void defaults(ObjectNode request, String op, PdfOptions options) {
        Set<String> members = PdfRequestDraft.MEMBERS.getOrDefault(op, Set.of());
        if (members.contains("fonts") && !request.path("fonts").isArray()) {
            request.set("fonts", fonts.pack(packOf(options)));
        }
        if (members.contains("env") && !request.path("env").isObject()) {
            request.set("env", defaultEnv(options));
        }
    }

    /** {@code options}: the request's own, with the caller's compact, tagged and pdfa over them. */
    private static void mergeOptions(ObjectNode request, PdfOptions options) {
        if (!options.hasRenderOptions()) {
            return;
        }
        ObjectNode merged = request.path("options").isObject() ? (ObjectNode) request.get("options") : request.putObject("options");
        if (options.compact() != null) {
            merged.put("compact", options.compact());
        }
        if (options.tagged() != null) {
            merged.put("tagged", options.tagged());
        }
        if (options.pdfa() != null) {
            merged.set("pdfa", options.pdfa().deepCopy());
        }
    }

    /** The default env: now, at whole seconds with ".000", and 16 random bytes in hex as the document id. */
    private ObjectNode defaultEnv(PdfOptions options) {
        ObjectNode env = NODES.objectNode();
        env.put("createdAt", CREATED_AT.format(options.createdAt() != null ? options.createdAt() : clock.instant()));
        env.put("documentId", options.documentId() != null && !options.documentId().isEmpty() ? options.documentId() : randomId());
        return env;
    }

    /** The caller's pack, else the host's ({@code datum.pdf.fonts}). */
    private PdfFonts.Pack packOf(PdfOptions options) {
        return options.fonts() != null ? options.fonts() : defaultPack;
    }

    private String randomId() {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    /**
     * A produced PDF through the application's {@link PdfResultValidator}s: every one, in order; their errors
     * refuse ({@code HookRefusedException} INVALID, the first error's code), their warnings are added after the program's.
     * With no validator the result is returned as it is.
     */
    private PdfResult validated(PdfResult result, String op, String formKey, boolean toBeSealed) {
        if (validators.isEmpty()) {
            return result;
        }
        PdfResultCandidate candidate = new PdfResultCandidate(op, formKey, result, toBeSealed);
        List<HookProblem> errors = new ArrayList<>();
        List<HookProblem> found = new ArrayList<>();
        for (PdfResultValidator validator : validators) {
            HookFindings findings = validator.validate(candidate);
            if (findings == null) {
                throw new IllegalStateException("A PdfResultValidator answered null; answer HookFindings.NONE to let the PDF go.");
            }
            errors.addAll(findings.errors());
            found.addAll(findings.warnings());
        }
        if (!errors.isEmpty()) {
            LOG.info("Datum PDF: a {} PDF of {} was refused by the application's validators ({}).", op, formKey == null ? "a form" : formKey,
                errors.get(0).code());
            throw HookRefusedException.invalid(errors);
        }
        if (found.isEmpty()) {
            return result;
        }
        List<ObjectNode> warnings = new ArrayList<>(result.warnings());
        for (HookProblem problem : found) {
            ObjectNode warning = warning(problem.code(), problem.message() == null ? "" : problem.message());
            if (problem.field() != null) {
                warning.put("field", problem.field());
            }
            warnings.add(warning);
        }
        return result.withWarnings(warnings);
    }

    /** A produced reply ({@code document}, {@code render}, {@code fill}, {@code sign}) read. */
    private PdfResult produced(Answered answered, String op) {
        ObjectNode answer = answered.answer();
        byte[] bytes = pdf(answer.get("bytes"));
        List<ObjectNode> warnings = new ArrayList<>();
        for (JsonNode warning : answer.path("warnings").isArray() ? answer.path("warnings").values() : List.<JsonNode>of()) {
            if (warning.isObject()) {
                ObjectNode entry = (ObjectNode) warning.deepCopy();
                warnings.add(entry);
                String code = warning.path("code").asString("");
                if (LOGGED_WARNINGS.contains(code)) {
                    LOG.warn("Datum PDF warning {}: {}", code, warning.path("message").asString(""));
                }
            }
        }
        PdfSigningHandoff signing = null;
        JsonNode handoff = answer.get("signing");
        if (handoff != null && handoff.isObject()) {
            try {
                signing = json.treeToValue(handoff, PdfSigningHandoff.class);
            } catch (RuntimeException e) {
                throw PdfException.noPdf("The PDF program answered with a signing handoff this host cannot read.");
            }
        }
        ObjectNode rest = answer.deepCopy();
        rest.remove("bytes");
        JsonNode pageCount = answer.get("pageCount");
        JsonNode layoutKind = answer.get("layoutKind");
        return new PdfResult(bytes, pageCount != null && pageCount.canConvertToInt() ? pageCount.intValue() : 0,
            answer.path("layoutId").isString() ? answer.path("layoutId").stringValue() : "",
            layoutKind != null && layoutKind.isString() ? layoutKind.stringValue() : null, answer.get("layoutChoice"),
            warnings, answered.elapsedMs(), signing, null, rest);
    }

    /** The PDF in an answer's base64 bytes; anything that is not a PDF is no answer. */
    static byte[] pdf(JsonNode base64) {
        byte[] bytes = Base64Strict.decode(base64);
        if (bytes == null || bytes.length < 5 || bytes[0] != '%' || bytes[1] != 'P' || bytes[2] != 'D' || bytes[3] != 'F' || bytes[4] != '-') {
            throw PdfException.noPdf("The PDF program answered without a PDF.");
        }
        return bytes;
    }

    private static ObjectNode warning(String code, String message) {
        ObjectNode warning = NODES.objectNode();
        warning.put("code", code);
        warning.put("message", message);
        return warning;
    }

    private void publish(PdfRenderedEvent event) {
        events.publish(event);
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }

    /** Base64 of a JSON string by the JDK's basic decoder (the standard alphabet, no line breaks): null for anything else. */
    static final class Base64Strict {

        private Base64Strict() {
        }

        static byte[] decode(JsonNode node) {
            return node != null && node.isString() ? decode(node.stringValue()) : null;
        }

        static byte[] decode(String text) {
            if (text == null) {
                return null;
            }
            try {
                return Base64.getDecoder().decode(text);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }

    /**
     * The DER readings the host makes of what the program and a signer hand over, on Bouncy Castle's ASN.1 types. A
     * value is read only when it is the DER encoding of what it says (re-encoding it as DER gives the same bytes),
     * so a BER length, an indefinite form or a mis-sorted SET is refused, as the hand reader this replaces did.
     */
    static final class Der {

        private Der() {
        }

        /** The DER shape of an ECDSA-Sig-Value: {@code SEQUENCE { INTEGER r, INTEGER s }}, nothing after it. */
        static boolean isEcdsaSignature(byte[] value) {
            try {
                ASN1Primitive parsed = ASN1Primitive.fromByteArray(value);
                return parsed instanceof ASN1Sequence sequence && sequence.size() == 2
                    && sequence.getObjectAt(0) instanceof ASN1Integer && sequence.getObjectAt(1) instanceof ASN1Integer
                    && Arrays.equals(parsed.getEncoded(ASN1Encoding.DER), value);
            } catch (IOException | RuntimeException e) {
                return false;
            }
        }

        /**
         * The value of the one {@code messageDigest} attribute of DER signed attributes ({@code SET OF Attribute}),
         * its one value an {@code OCTET STRING}; null when the bytes are not that shape (in DER, with the SET
         * sorted as CMS requires), when no attribute or more than one is a {@code messageDigest}, or when it has
         * other than one value.
         */
        static byte[] messageDigest(byte[] attributes) {
            try {
                ASN1Primitive parsed = ASN1Primitive.fromByteArray(attributes);
                if (!(parsed instanceof ASN1Set set) || !Arrays.equals(parsed.getEncoded(ASN1Encoding.DER), attributes)) {
                    return null;
                }
                // BC's Attribute does not check the sequence size: each one must be exactly SEQUENCE { OID, SET }.
                for (org.bouncycastle.asn1.ASN1Encodable each : set) {
                    if (!(each instanceof ASN1Sequence one) || one.size() != 2
                        || !(one.getObjectAt(0) instanceof org.bouncycastle.asn1.ASN1ObjectIdentifier)
                        || !(one.getObjectAt(1) instanceof ASN1Set)) {
                        return null;
                    }
                }
                ASN1EncodableVector found = new AttributeTable(set).getAll(CMSAttributes.messageDigest);
                if (found.size() != 1) {
                    return null;
                }
                ASN1Set values = Attribute.getInstance(found.get(0)).getAttrValues();
                if (values.size() != 1 || !(values.getObjectAt(0) instanceof ASN1OctetString octets)) {
                    return null;
                }
                return octets.getOctets();
            } catch (IOException | RuntimeException e) {
                return null;
            }
        }
    }

    // ------------------------------------------------------------------------------------------------- builder

    /** Builds a {@link PdfService}. */
    public static final class Builder {

        private PdfRuntime runtime;
        private PdfFonts fonts;
        private PdfFonts.Pack defaultPack;
        private List<PdfRequestCustomizer> customizers = List.of();
        private List<PdfResultValidator> validators = List.of();
        private HostBindings bindings;
        private PdfSigner signer;
        private Timestamper timestamper;
        private String timestampSource;
        private SealPreset seal;
        private PdfTrust trust;
        private PdfTrustPolicy trustPolicy;
        private PdfVerifier verifier;
        private long verifyMaxBytes;
        private DatumEventPublisher events;
        private DatumObservations observations;
        private Clock clock;

        private Builder() {
        }

        /** Where the program and the slots come from (required). */
        public Builder runtime(PdfRuntime runtime) {
            this.runtime = runtime;
            return this;
        }

        /** The fonts (datum-programs' through this class's loader when unset). */
        public Builder fonts(PdfFonts fonts) {
            this.fonts = fonts;
            return this;
        }

        /** The pack a request carries when the caller names none ({@code datum.pdf.fonts}; DEFAULT when unset). */
        public Builder defaultFonts(PdfFonts.Pack pack) {
            this.defaultPack = pack;
            return this;
        }

        /** The result validators, in their order. */
        public Builder validators(List<PdfResultValidator> validators) {
            this.validators = validators == null ? List.of() : validators;
            return this;
        }

        /**
         * Which binding each form route is drawn by and the PDF theme it suggests: a request for a form that
         * carries no {@code theme} of its own is sent the theme object of its binding's PDF theme, the host rung of the
         * engine's ladder. Unset: no request is given a theme.
         */
        public Builder bindings(HostBindings bindings) {
            this.bindings = bindings;
            return this;
        }

        /** The request customizers, in their order. */
        public Builder customizers(List<PdfRequestCustomizer> customizers) {
            this.customizers = customizers == null ? List.of() : customizers;
            return this;
        }

        /** The server's signing key, or null for none. */
        public Builder signer(PdfSigner signer) {
            this.signer = signer;
            return this;
        }

        /**
         * Where seals get their timestamps: datum-timestamp's {@code TimestampClient} for
         * {@code datum.pdf.signing.tsa.url}, or the in-process {@code TimestampAuthority}; null for none.
         *
         * @param source the URL, {@code site} for the in-process authority, {@code custom} for an application's own (for health
         *     and the headers)
         */
        public Builder timestamper(Timestamper timestamper, String source) {
            this.timestamper = timestamper;
            this.timestampSource = source;
            return this;
        }

        /** The seal preset ({@link SealPreset#OFF} when unset). */
        public Builder seal(SealPreset seal) {
            this.seal = seal;
            return this;
        }

        /** What verification places signers against. */
        public Builder trust(PdfTrust trust) {
            this.trust = trust;
            return this;
        }

        /** What makes a chain trusted ({@link PdfTrustPolicy#standard()} when unset); not with {@link #verifier}. */
        public Builder trustPolicy(PdfTrustPolicy trustPolicy) {
            this.trustPolicy = trustPolicy;
            return this;
        }

        /**
         * The host's own verifier, used as given: its trust (built with {@link PdfTrust#withSiteSigner}, so this
         * server's seals are the site's) and its policy. Not together with {@link #trust} or {@link #trustPolicy}.
         */
        public Builder verifier(PdfVerifier verifier) {
            this.verifier = verifier;
            return this;
        }

        /** The largest file {@link PdfService#verify} reads ({@code datum.runtime.verify-max-bytes}; 20 MiB when unset). */
        public Builder verifyMaxBytes(long verifyMaxBytes) {
            this.verifyMaxBytes = verifyMaxBytes;
            return this;
        }

        /**
         * Where {@link PdfRenderedEvent}s and {@link PdfVerifiedEvent}s go (the host's event bus), or null for
         * none; used as given (the host guards its default, {@link DatumEventPublisher#guarded}).
         */
        public Builder events(DatumEventPublisher events) {
            this.events = events;
            return this;
        }

        /** The clock of {@code env.createdAt} and of verification. */
        /** Where the {@value DatumObservationNames#PDF} observations go; none by default. */
        public Builder observations(DatumObservations observations) {
            this.observations = observations;
            return this;
        }

        public Builder clock(Clock clock) {
            this.clock = clock;
            return this;
        }

        public PdfService build() {
            return new PdfService(this);
        }
    }

}
