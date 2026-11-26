package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The ABI gates: the program is asked, once per program file, whether it answers for the floor the host
 * needs.
 *
 * <p>Sandbox: a manifest's ABI is a string from the build that
 * wrote it, so the program itself is asked instead: {@code __datum_inspect} refuses ({@code abi_mismatch}) a
 * request that names an ABI newer than its own, so an older program file (assets not rebuilt, a partial
 * update, a restore) fails here and no submission is judged by it. The proof is
 * kept against the program's sha256 and the floor it was proved for ({@link #key}), so it costs one extra run
 * per program.
 *
 * <p>PDF: the {@code capabilities} op answers the program's ABI and features; the host needs the same major version
 * as {@link PdfAbi#MIN} and at least it. The program's own answer is the gate, as for the sandbox, and a program
 * that does not answer is unavailable (a manifest's string is never trusted for it).
 *
 * <p>A PDF program that failed its capabilities answer is remembered for {@link #PDF_FAILURE_MEMORY}: a stale or
 * hanging program does not cost every PDF request a full capabilities run (up to the 15 s budget) before it is
 * refused. A failed sandbox proof is not remembered (a refusal is never cached), so the
 * next submission proves a repaired program at once.
 */
public final class AbiProbe {

    /** How long a failed PDF capabilities answer is remembered: a minute, short enough for a redeploy to be seen. */
    public static final Duration PDF_FAILURE_MEMORY = Duration.ofSeconds(60);

    private final Clock clock;
    private final Set<String> provedSandbox = ConcurrentHashMap.newKeySet();
    private final Map<String, List<String>> pdfFeatures = new ConcurrentHashMap<>();
    private final Map<String, PdfFailure> pdfFailures = new ConcurrentHashMap<>();

    /** A failed capabilities answer: until when it stands, and the host's message to refuse with. */
    private record PdfFailure(Instant until, String message) {
    }

    /** A gate on the system clock. */
    public AbiProbe() {
        this(Clock.systemUTC());
    }

    /** A gate on this clock (the PDF failure memory's). */
    public AbiProbe(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** The cache key of a proof: the program's sha256 and the floor. */
    public static String key(Program program, String min) {
        return program.sha256() + "|" + min;
    }

    /** Whether the sandbox program has been proved for {@link SandboxAbi#MIN}. */
    public boolean sandboxProved(Program program) {
        return provedSandbox.contains(key(program, SandboxAbi.MIN));
    }

    void rememberSandbox(Program program) {
        provedSandbox.add(key(program, SandboxAbi.MIN));
    }

    /** The PDF program's features, when its capabilities answer has been proved. */
    public Optional<List<String>> pdfFeatures(Program program) {
        return Optional.ofNullable(pdfFeatures.get(key(program, PdfAbi.MIN)));
    }

    void rememberPdf(Program program, List<String> features) {
        pdfFailures.remove(key(program, PdfAbi.MIN));
        pdfFeatures.put(key(program, PdfAbi.MIN), List.copyOf(features));
    }

    /**
     * The message a PDF program's capabilities failure was refused with, while it is remembered
     * ({@link #PDF_FAILURE_MEMORY}); empty when there is none or it has run out.
     */
    public Optional<String> pdfFailure(Program program) {
        String key = key(program, PdfAbi.MIN);
        PdfFailure failure = pdfFailures.get(key);
        if (failure == null) {
            return Optional.empty();
        }
        if (!clock.instant().isBefore(failure.until())) {
            pdfFailures.remove(key, failure);
            return Optional.empty();
        }
        return Optional.of(failure.message());
    }

    void rememberPdfFailure(Program program, String message) {
        pdfFailures.put(key(program, PdfAbi.MIN), new PdfFailure(clock.instant().plus(PDF_FAILURE_MEMORY), message));
    }

    /**
     * The probe request: {@code {abi: MIN, op: "inspect", definition}} over a one-component form, the request the
     * conformance suite's ABI-01 sends at its floor.
     */
    public static ObjectNode sandboxRequest() {
        JsonNodeFactory f = JsonNodeFactory.instance;
        ObjectNode root = f.objectNode();
        root.put("id", "root");
        root.put("type", "form");
        root.set("configuration", f.objectNode());
        ObjectNode children = f.objectNode();
        children.set("content", f.arrayNode());
        root.set("children", children);
        ObjectNode definition = f.objectNode();
        definition.put("id", "datum-abi-probe");
        definition.set("root", root);
        ObjectNode request = f.objectNode();
        request.put("abi", SandboxAbi.MIN);
        request.put("op", "inspect");
        request.set("definition", definition);
        return request;
    }

    /**
     * Reads the probe's framed answer: it must be a JSON object with {@code ok: true}.
     *
     * @throws ProgramUnavailableException naming the program's error code ("unknown" when it gave none)
     */
    public static void requireSandboxAnswer(byte[] answer) {
        JsonNode parsed;
        try {
            parsed = StrictJson.decode(answer);
        } catch (StrictJson.NotJsonException e) {
            parsed = null;
        }
        if (parsed == null || !parsed.isObject() || !parsed.path("ok").isBoolean() || !parsed.path("ok").booleanValue()) {
            JsonNode code = parsed != null && parsed.isObject() ? parsed.path("error").path("code") : null;
            throw new ProgramUnavailableException("The sandbox program does not answer for ABI " + SandboxAbi.MIN + " ("
                + (code != null && code.isString() ? code.stringValue() : "unknown")
                + "). Rebuild the program assets (npm run jvm:assets) or use a datum-programs release that ships them.");
        }
    }

    /** The PDF probe request: {@code {abi: MIN, op: "capabilities"}}. */
    public static ObjectNode pdfRequest() {
        ObjectNode request = JsonNodeFactory.instance.objectNode();
        request.put("abi", PdfAbi.MIN);
        request.put("op", "capabilities");
        return request;
    }

    /**
     * Reads a capabilities answer: {@code ok: true}, an ABI the host speaks ({@link PdfAbi#speaks}), and the
     * feature names (the string entries only; anything else in the list is ignored).
     *
     * @throws ProgramUnavailableException when the program does not answer for {@link PdfAbi#MIN}
     */
    public static List<String> requirePdfCapabilities(JsonNode answer) {
        if (answer == null || !answer.isObject() || !answer.path("ok").isBoolean() || !answer.path("ok").booleanValue()) {
            JsonNode code = answer != null && answer.isObject() ? answer.path("error").path("code") : null;
            throw new ProgramUnavailableException("The PDF program does not answer for ABI " + PdfAbi.MIN + " ("
                + (code != null && code.isString() ? code.stringValue() : "unknown") + "). Rebuild the program assets (npm run jvm:assets).");
        }
        JsonNode abi = answer.path("abi");
        String reported = abi.isString() ? abi.stringValue() : null;
        if (!PdfAbi.speaks(reported)) {
            throw new ProgramUnavailableException("The PDF program speaks ABI " + (reported == null ? "(none)" : reported)
                + "; the host needs " + PdfAbi.MIN + " or a later " + PdfAbi.MIN.substring(0, PdfAbi.MIN.indexOf('.')) + ".x.");
        }
        List<String> features = new ArrayList<>();
        for (JsonNode feature : answer.path("features").isArray() ? answer.path("features").values() : List.<JsonNode>of()) {
            if (feature.isString()) {
                features.add(feature.stringValue());
            }
        }
        return features;
    }
}
