package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.diagnostics.RunRecorder;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.OutputCapExceededException;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Runs the sandbox program: validation, and the inspect ops over a definition (the sandbox protocol),
 * runtime-agnostic: the runtime is a {@link ProgramRunner}.
 *
 * <p>Every run, in this order: the depth guard before any guest starts ({@link DefinitionDepth}: a tree past 32
 * component levels traps the guest where no catch reaches); a free slot ({@link RunSlots}); the ABI gate, once per program, so an older program never runs ({@link AbiProbe});
 * the input written as strict JSON; a fresh nonce ({@link Nonce}); the run; the classification of how it
 * ended ({@link RunClassifier}, the frame); then the answer read strictly ({@link StrictJson}). A validation's
 * outcome must be a JSON object with an {@code errors} list, and is refused past 8 MiB of UTF-16 code units;
 * its run log goes to {@link RunLog}.
 *
 * <p>{@link #validate} sets the host's context keys itself, so a caller cannot forget them; the raw JSON depth is
 * checked here as well as the component depth, because a definition may reach this service from any repository; a
 * refusal's message carries the program's error code but not its message, which is kept on the exception for the
 * log (messages never carry guest output). Every run a caller asks for takes one of the same slots: a validation, and
 * the inspect ops ({@link #inspect}, {@link #check}, {@link #publicCopy}), which a public definition read, a builder save
 * or an operator's inspection start with a definition of their choosing. All of them answer the same {@link Reason#BUSY}
 * when every slot stays taken, so the guests alive at once, and the threads and memory they hold, stay bounded by the
 * slots. The answer is read (and a validation's capped) while the run still holds its slot, so the heap a run's answer
 * may take stays bounded too (slots x 32 MiB). The ABI proof {@link #proveAbi} takes no slot of its own: inside a run it
 * runs in that run's slot, and on its own it is the runtime's one proof per program, which a caller cannot repeat.
 *
 * <p>With a {@link RunRecorder} (a host that traces or captures its runs), every run is handed to it
 * once the protocol has judged it, after the last check of the answer (for {@link #check} and {@link #publicCopy} that is their
 * own check of the inspect answer, so a missing {@code structure} or {@code definition} is the run's {@code no_outcome}), on the
 * run's own thread; without one nothing is done for it. It observes only: the checks above and their order are the same either
 * way.
 *
 * <p>Final, so the protocol cannot be changed by a subclass; a host observes every run by wrapping it through
 * {@link Sandbox} instead (a {@link SandboxDecorator}; the runtime builds this service and hands it to the decorators).
 */
public final class SandboxService implements Sandbox {

    private static final Logger LOG = LoggerFactory.getLogger(SandboxService.class);

    /**
     * The longest outcome a validation may answer, in UTF-16 code units: 8 MiB, the TypeScript hosts'
     * {@code maxResultLength} of the validation profile. An inspect answer is not capped by it.
     */
    public static final int MAX_OUTCOME_LENGTH = 8 * 1024 * 1024;

    private final ProgramRunner runtime;
    private final Program program;
    private final RunScript scripts;
    private final ProgramLimits limits;
    private final HostOptions hostOptions;
    private final RunSlots slots;
    private final AbiProbe probe;
    private final RunLog runLog;
    private final @Nullable RunRecorder recorder;

    /**
     * @param runtime what runs the program ({@link ProgramRunner#on} over an engine)
     * @param program the sandbox program ({@link Program.Kind#SANDBOX})
     * @param scripts the run.js builder (over the freeze snippet)
     * @param limits the budgets
     * @param hostOptions the context keys the host decides
     * @param slots the validation slots
     * @param probe the ABI gate's memory (share one per program store)
     * @param runLog where a run's log goes
     * @param recorder told of every judged run ({@link RunRecorder}), or null for none
     */
    public SandboxService(ProgramRunner runtime, Program program, RunScript scripts, ProgramLimits limits,
                          HostOptions hostOptions, RunSlots slots, AbiProbe probe, RunLog runLog, @Nullable RunRecorder recorder) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.program = Objects.requireNonNull(program, "program");
        if (program.kind() != Program.Kind.SANDBOX) {
            throw new IllegalArgumentException("The sandbox service runs the sandbox program, not " + program.kind().fileName() + ".");
        }
        this.scripts = Objects.requireNonNull(scripts, "scripts");
        this.limits = Objects.requireNonNull(limits, "limits");
        this.hostOptions = Objects.requireNonNull(hostOptions, "hostOptions");
        this.slots = Objects.requireNonNull(slots, "slots");
        this.probe = Objects.requireNonNull(probe, "probe");
        this.runLog = Objects.requireNonNull(runLog, "runLog");
        this.recorder = recorder;
    }

    /** A service with validation slots from the limits, a fresh ABI gate and the SLF4J run log. */
    public static SandboxService create(ProgramRunner runtime, Program program, RunScript scripts, ProgramLimits limits, HostOptions hostOptions) {
        return new SandboxService(runtime, program, scripts, limits, hostOptions, RunSlots.validation(limits), new AbiProbe(), RunLog.slf4j(), null);
    }

    /** The program this service runs. */
    @Override
    public Program program() {
        return program;
    }

    /** The validation slots. */
    public RunSlots slots() {
        return slots;
    }

    /** The recorder its runs are handed to, or null: the diagnostics' tests read it. */
    @Nullable RunRecorder recorder() {
        return recorder;
    }

    /** The context keys the host decides ({@link HostOptions#contextKeys()}). */
    public Map<String, String> contextKeys() {
        return hostOptions.contextKeys();
    }

    /**
     * Runs one validation.
     *
     * @param context the WasmSubmissionContext: formId, form, values, locale, unknownFields, logLevel,
     *     externalData, journey, page; document and optionSnapshot. Not changed: the run reads a
     *     copy with the host's {@code today}, {@code formulaErrors} and {@code riskyPatterns} set over it.
     * @param rules rule modules, registered in this order before the run
     * @param real whether this is a real submission, whose run log is relayed to {@link RunLog}.
     *     False for a dry run ({@code /api/submissions/test}), a smoke or warm-up run: their log is dropped,
     *     because a rule module's entries may carry submitted values and a dry run has no side effects. No default: every caller decides.
     * @throws com.argusvane.datum.core.DefinitionTooDeepException before any guest starts
     * @throws SandboxException when the run gave no verdict ({@link Reason#BUSY} when every slot stayed taken)
     * @throws ProgramUnavailableException when the program or the runtime cannot be used
     */
    @Override
    public SandboxResult validate(ObjectNode context, List<RuleModule> rules, boolean real) {
        Objects.requireNonNull(context, "context");
        ObjectNode input = context.deepCopy();
        hostOptions.mergeInto(input);
        assertShallow(input);
        Executed run;
        ObjectNode outcome;
        try (RunSlots.Permit ignored = slots.acquire()) {
            run = execute(scripts.sandbox(rules, RunScript.Entry.RUN), input, true, "validate");
            // Read and capped inside the slot: the answer's bytes, and the text read from them, count against
            // this slot's share of the heap, not the next run's.
            try {
                outcome = outcome(run);
            } catch (RuntimeException e) {
                run.end(e);
                throw e;
            }
            run.end(RunWatch.VERDICT);
        }
        if (real) {
            forwardLog(input, outcome);
        }
        return new SandboxResult(outcome, run.elapsedMs());
    }

    /**
     * Asks the program about a definition: {@code __datum_inspect}.
     *
     * <p>The request is {@code {abi, op, definition, formulaErrors?}} with the host's floor
     * ({@link SandboxAbi#MIN}), so a program too old to answer refuses it ({@code abi_mismatch}); the members
     * of {@code extra} are set over it ({@code types}, {@code riskyPatterns} for a check).
     *
     * @param op "public", "check" or "inspect"
     * @param definition the form definition
     * @param formulaErrors the policy a check reports under, or null for the program's own default
     * @param extra more request members, or null
     * @param rules rule modules to register first (a check of a form that calls a plugin's function needs them)
     * @return the answer, {@code {ok: true, op, ...}}
     * @throws SandboxException when the run gave no answer ({@link Reason#BUSY} when every slot stayed taken), or
     *     {@link Reason#REFUSED} with the program's code
     */
    @Override
    public ObjectNode inspect(String op, ObjectNode definition, @Nullable String formulaErrors, @Nullable Map<String, JsonNode> extra, List<RuleModule> rules) {
        return inspect(op, definition, formulaErrors, extra, rules, null);
    }

    /**
     * {@link #inspect(String, ObjectNode, String, Map, List)} with the caller's own last check of an {@code ok: true} answer,
     * made before the run is judged a verdict: it answers the failure to throw (and the run ends with it), or null.
     */
    private ObjectNode inspect(String op, ObjectNode definition, @Nullable String formulaErrors, @Nullable Map<String, JsonNode> extra,
                               List<RuleModule> rules, @Nullable Function<JsonNode, @Nullable SandboxException> lastCheck) {
        Objects.requireNonNull(op, "op");
        Objects.requireNonNull(definition, "definition");
        DefinitionDepth.assertShallow(definition);
        ObjectNode request = JsonNodeFactory.instance.objectNode();
        request.put("abi", SandboxAbi.MIN);
        request.put("op", op);
        request.set("definition", definition);
        if (formulaErrors != null) {
            request.put("formulaErrors", HostOptions.policy(formulaErrors));
        }
        if (extra != null) {
            extra.forEach(request::set);
        }
        // The slot is taken after the depth guard and held until the answer is judged, as a validation's is.
        try (RunSlots.Permit ignored = slots.acquire()) {
            return judgeInspect(op, execute(scripts.sandbox(rules, RunScript.Entry.INSPECT), request, true, op), lastCheck);
        }
    }

    /** An inspect run's answer read strictly and judged, inside the run's slot. */
    private static ObjectNode judgeInspect(String op, Executed run, @Nullable Function<JsonNode, @Nullable SandboxException> lastCheck) {
        JsonNode answer;
        try {
            answer = StrictJson.decode(run.answer());
        } catch (StrictJson.NotJsonException e) {
            throw run.ended(new SandboxException(Reason.NOT_JSON, "The sandbox printed something that is not JSON.", run.stderr()));
        }
        if (!answer.isObject() || !answer.path("ok").isBoolean()) {
            throw run.ended(new SandboxException(Reason.NO_OUTCOME, "The sandbox printed no inspect answer.", run.stderr()));
        }
        if (!answer.path("ok").booleanValue()) {
            JsonNode code = answer.path("error").path("code");
            JsonNode message = answer.path("error").path("message");
            String programCode = code.isString() ? code.stringValue() : "unknown";
            throw run.ended(new SandboxException(Reason.REFUSED, "The sandbox refused the " + op + " request (" + programCode + ").",
                run.stderr(), false, null, programCode, message.isString() ? message.stringValue() : "", null));
        }
        if (lastCheck != null) {
            SandboxException refused = lastCheck.apply(answer);
            if (refused != null) {
                throw run.ended(refused);
            }
        }
        run.end(RunWatch.VERDICT);
        return (ObjectNode) answer;
    }

    /** {@link #inspect(String, ObjectNode, String, Map, List)} with no policy, no extra members and no rules. */
    @Override
    public ObjectNode inspect(String op, ObjectNode definition) {
        return inspect(op, definition, null, null, List.of());
    }

    /**
     * Asks the program whether a definition may be saved: the {@code check} op; a cache of its
     * answers is the caller's.
     *
     * <p>A check that gave no verdict is never read as "no problems" and never blamed on the definition unless
     * the definition caused it: the builder's save routes (endpoint catalog {@code saveForm}, {@code createForm})
     * answer {@code definition.tooDeep} and {@code definition.tooCostly} with a 422 and every other failure with 503
     * {@code server.unavailable}, so a runtime outage refuses the save rather than letting an unchecked form be
     * stored ("a save is checked by the sandbox kernel"; BLD-04). The mapping is made here,
     * not in a controller, because the error mapper answers by the exception's own code; the original failure is
     * the {@link ProgramUnavailableException}'s cause, for the log.
     *
     * @param definition the definition as it would be saved
     * @param types the component types this host can draw (sorted here), always sent so the program reports
     *     {@code component.type.unknown}; an empty list only when the host deliberately has none
     * @param rules the rule modules of the extensions the form uses
     * @return the answer: problems, warnings, policy, verdict, structure, structureWarnings, limits
     * @throws com.argusvane.datum.core.DefinitionTooDeepException before any guest starts
     * @throws SandboxException {@code definition.tooCostly} (422), when the check ran into its own time or
     *     memory limit after the program started; {@link Reason#BUSY} (503 {@code server.busy}) when every slot stayed taken
     * @throws ProgramUnavailableException (503 {@code server.unavailable}) for every other failure, the answer
     *     listing no structure included (fail closed)
     */
    @Override
    public ObjectNode check(ObjectNode definition, List<String> types, List<RuleModule> rules) {
        Objects.requireNonNull(types, "types");
        Map<String, String> keys = hostOptions.contextKeys();
        Map<String, JsonNode> extra = new LinkedHashMap<>();
        ArrayNode sorted = JsonNodeFactory.instance.arrayNode();
        List<String> ordered = new ArrayList<>(types);
        Collections.sort(ordered);
        ordered.forEach(sorted::add);
        extra.put("types", sorted);
        extra.put("riskyPatterns", JsonNodeFactory.instance.stringNode(keys.get("riskyPatterns")));
        ObjectNode answer;
        try {
            // The structure is checked inside the watched run, so a run that listed none is traced as no outcome.
            answer = inspect("check", definition, keys.get("formulaErrors"), extra, rules, SandboxService::listsNoStructure);
        } catch (SandboxException e) {
            if (e.reason() == Reason.BUSY) {
                // Every slot was taken: the same busy answer as any other run, which a retry may pass; never the
                // definition's fault, and still no verdict, so nothing is saved.
                throw e;
            }
            SandboxException classified = classifyCheck(e);
            if (classified.typedCode() != null) {
                throw classified;
            }
            throw checkUnavailable(classified);
        }
        return answer;
    }

    /** A check answer that lists no structure: the gate proves the ABI, so this is a program that lied or a broken answer. */
    private static @Nullable SandboxException listsNoStructure(JsonNode answer) {
        if (!answer.path("structure").isArray() || !answer.path("structureWarnings").isArray()) {
            return new SandboxException(Reason.NO_OUTCOME, "The sandbox program listed no structure for the definition.");
        }
        return null;
    }

    /** A check that gave no verdict for a reason that is not the definition's: the save route's 503. */
    private static ProgramUnavailableException checkUnavailable(SandboxException cause) {
        return new ProgramUnavailableException("The form could not be checked because the server runtime is not available ("
            + cause.reason() + "), so it was not saved. Try again later.", cause);
    }

    /**
     * A check's failure as the author or the runtime owns it. A
     * time or memory stop the guest itself ran into is the definition's doing ({@code definition.tooCostly},
     * 422); the host's clock, the output cap and every other failure are the runtime's, not the definition's, and {@link #check} answers them as the runtime's (503).
     */
    public static SandboxException classifyCheck(SandboxException e) {
        if ((e.reason() == Reason.BUDGET || e.reason() == Reason.MEMORY) && e.typedCode() == null && e.guestStopped()) {
            return SandboxException.checkTooCostly(e);
        }
        return e;
    }

    /**
     * The definition a browser may be served: the form without its {@code server-secret} rules, the
     * {@code public} op. A definition with no "server-secret" anywhere in it is its own public copy and costs no
     * run (the op only removes server-secret rules, so there is nothing for it to do).
     *
     * @throws SandboxException when the program gave no public copy ({@link Reason#BUSY} when every slot stayed taken)
     */
    @Override
    public ObjectNode publicCopy(ObjectNode definition) {
        if (!StrictJson.encode(definition).contains("server-secret")) {
            return definition.deepCopy();
        }
        ObjectNode answer = inspect("public", definition, null, null, List.of(), reply -> {
            JsonNode copy = reply.get("definition");
            return copy == null || !copy.isObject() ? new SandboxException(Reason.NO_OUTCOME, "The sandbox answered the public request with no definition.")
                : null;
        });
        return (ObjectNode) answer.get("definition");
    }

    /**
     * A tiny run proving the runtime works: one required field left empty must give exactly one
     * {@code required} error for it; the warm-up runs it.
     */
    @Override
    public Smoke smoke() {
        ObjectNode context;
        try {
            context = (ObjectNode) StrictJson.decode("{\"formId\":\"datum-smoke\",\"form\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
                + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\",\"required\":true}}]}},"
                + "\"values\":{},\"locale\":\"en\"}");
        } catch (StrictJson.NotJsonException e) {
            throw new IllegalStateException(e);
        }
        try {
            // Not a submission: its log is not relayed.
            SandboxResult result = validate(context, List.of(), false);
            JsonNode errors = result.outcome().path("errors");
            boolean ok = errors.size() == 1 && "required".equals(errors.get(0).path("code").asString(""))
                && "name".equals(errors.get(0).path("componentId").asString(""));
            return new Smoke(ok, result.elapsedMs(), ok ? "The sandbox answered as expected." : "The sandbox answered, but not with the expected verdict.");
        } catch (SandboxException | ProgramUnavailableException e) {
            return new Smoke(false, 0.0, e.getMessage());
        }
    }

    /**
     * Proves the program answers for {@link SandboxAbi#MIN}, once per program (sha256) and floor.
     *
     * @throws ProgramUnavailableException when it does not
     */
    @Override
    public void proveAbi() {
        if (probe.sandboxProved(program)) {
            return;
        }
        Executed run = execute(scripts.sandbox(List.of(), RunScript.Entry.INSPECT), AbiProbe.sandboxRequest(), false, "abi");
        try {
            AbiProbe.requireSandboxAnswer(run.answer());
        } catch (RuntimeException e) {
            run.end(RunWatch.probeOutcome(run.answer()));
            throw e;
        }
        run.end(RunWatch.VERDICT);
        probe.rememberSandbox(program);
    }

    /**
     * One run's framed answer, its stderr (for the log) and its wall time; and its watch, which the caller ends once it has
     * judged the answer (null without a recorder, and then ending it does nothing).
     */
    private record Executed(byte[] answer, String stderr, double elapsedMs, @Nullable RunWatch watch) {

        void end(String outcome) {
            if (watch != null) {
                watch.end(outcome);
            }
        }

        void end(Throwable failure) {
            if (watch != null) {
                watch.end(failure);
            }
        }

        /** Ends the run with this failure and hands it back to be thrown. */
        <E extends RuntimeException> E ended(E failure) {
            end(failure);
            return failure;
        }
    }

    /** One guest run: the gate, the input, the nonce, the run, the classification. */
    private Executed execute(String script, ObjectNode input, boolean gate, String op) {
        if (gate) {
            proveAbi();
        }
        String json;
        try {
            json = StrictJson.encode(input);
        } catch (IllegalArgumentException e) {
            // A number or text JSON cannot write: the receiver refuses those bodies
            // first, this is the backstop.
            throw new SandboxException(Reason.INPUT, "The run context could not be written as JSON: " + e.getMessage());
        }
        // A fresh nonce per run, sent on stdin: the guest has no file to read it from, and cannot print the
        // markers without it.
        String nonce = Nonce.generate();
        Budget budget = limits.validationBudget();
        byte[] stdin = Nonce.stdin(nonce, json);
        RunWatch watch = RunWatch.start(recorder, program, op, script, stdin);
        long started = System.nanoTime();
        RunOutput output;
        try {
            output = runtime.run(program, script, RunScript.argv(Program.Kind.SANDBOX), stdin, budget);
        } catch (OutputCapExceededException e) {
            // A runtime that let the cap's exception out: still a stopped run, never an answer.
            output = new RunOutput(Termination.OUTPUT_CAP, -1, null, null, null);
        } catch (RuntimeException e) {
            if (watch != null) {
                watch.end(e);
            }
            throw e;
        }
        double elapsed = (System.nanoTime() - started) / 1e6;
        if (output == null) {
            ProgramUnavailableException none = new ProgramUnavailableException("The runtime returned no run.");
            if (watch != null) {
                watch.end(none);
            }
            throw none;
        }
        if (watch != null) {
            watch.ran(output);
        }
        byte[] answer;
        try {
            answer = RunClassifier.sandboxAnswer(output, nonce, budget);
        } catch (RuntimeException e) {
            if (watch != null) {
                watch.end(e);
            }
            throw e;
        }
        return new Executed(answer, RunClassifier.stderrText(output), elapsed, watch);
    }

    /**
     * The outcome a validation printed, with the TypeScript hosts' 8 MiB cap first (nothing of a longer answer is
     * parsed).
     *
     * <p>The cap is in UTF-16 code units, which never outnumber the UTF-8 bytes, so an answer of at most
     * {@link #MAX_OUTCOME_LENGTH} bytes is under it without counting. A longer one is measured from its bytes
     * in fixed-size chunks before any text is built, so a refused answer never costs a string of up to 64 MiB.
     * Malformed UTF-8 is still "not JSON" before the length is judged, whether or not the answer is decoded whole.
     */
    static ObjectNode outcome(byte[] answer, String stderr) {
        if (answer.length > MAX_OUTCOME_LENGTH) {
            long length = utf16Length(answer, stderr);
            if (length > MAX_OUTCOME_LENGTH) {
                throw new SandboxException(Reason.OUTCOME_TOO_LARGE, "outcome.tooLarge: the sandbox answered with " + length
                    + " characters; a run's outcome is at most " + MAX_OUTCOME_LENGTH + ".", stderr);
            }
        }
        String text;
        try {
            text = strictUtf8().decode(ByteBuffer.wrap(answer)).toString();
        } catch (CharacterCodingException e) {
            throw new SandboxException(Reason.NOT_JSON, "The sandbox printed something that is not JSON.", stderr);
        }
        JsonNode outcome;
        try {
            outcome = StrictJson.decode(text);
        } catch (StrictJson.NotJsonException e) {
            throw new SandboxException(Reason.NOT_JSON, "The sandbox printed something that is not JSON.", stderr);
        }
        if (!outcome.isObject() || !outcome.path("errors").isArray()) {
            throw new SandboxException(Reason.NO_OUTCOME, "The sandbox printed no outcome.", stderr);
        }
        return (ObjectNode) outcome;
    }

    private static ObjectNode outcome(Executed run) {
        return outcome(run.answer(), run.stderr());
    }

    private static CharsetDecoder strictUtf8() {
        return StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
    }

    /**
     * The UTF-16 length of strict UTF-8 bytes, decoded through a fixed 8 Ki-char buffer that is counted and
     * reused, so no text of the answer's size is built.
     *
     * @throws SandboxException {@link Reason#NOT_JSON} when the bytes are not UTF-8
     */
    static long utf16Length(byte[] utf8, String stderr) {
        CharsetDecoder decoder = strictUtf8();
        ByteBuffer in = ByteBuffer.wrap(utf8);
        CharBuffer out = CharBuffer.allocate(8192);
        long length = 0;
        CoderResult result;
        do {
            // End of input is declared, so a sequence cut short at the end is an error, not left over.
            result = decoder.decode(in, out, true);
            if (result.isError()) {
                throw new SandboxException(Reason.NOT_JSON, "The sandbox printed something that is not JSON.", stderr);
            }
            length += out.position();
            out.clear();
        } while (result.isOverflow());
        do {
            result = decoder.flush(out);
            length += out.position();
            out.clear();
        } while (result.isOverflow());
        return length;
    }

    /**
     * The depth guard over a validation context: the context's form as the definition's root, and its journey as
     * the one journey, measured before the guest starts.
     */
    static void assertShallow(ObjectNode context) {
        ObjectNode definition = JsonNodeFactory.instance.objectNode();
        JsonNode form = context.get("form");
        if (form != null && form.isObject()) {
            DefinitionDepth.assertRawDepth(form, "form");
            definition.set("root", form);
        }
        JsonNode journey = context.get("journey");
        if (journey != null && journey.isObject()) {
            DefinitionDepth.assertRawDepth(journey, "journey");
            ObjectNode journeys = JsonNodeFactory.instance.objectNode();
            journeys.set("journeys", JsonNodeFactory.instance.arrayNode().add(journey));
            definition.set("journey", journeys);
        }
        DefinitionDepth.assertComponentDepth(definition);
    }

    private void forwardLog(ObjectNode context, ObjectNode outcome) {
        JsonNode logs = outcome.get("logs");
        if (logs == null || !logs.isArray()) {
            return;
        }
        JsonNode formId = context.get("formId");
        String form = formId != null && formId.isString() ? formId.stringValue() : null;
        // The log is an observer: the kernel has judged the submission before it is read, so a sink that throws (an
        // application's RunLog on an audit table or a log shipper that is down) must never turn that verdict
        // into a refusal. Every entry is still offered; one WARN per run names the exception's class only, never its
        // message, which may carry the guest's text.
        RuntimeException failed = null;
        int failures = 0;
        for (JsonNode entry : logs.values()) {
            if (!entry.isObject()) {
                continue;
            }
            JsonNode level = entry.get("level");
            JsonNode message = entry.get("message");
            try {
                runLog.entry(form, level != null && level.isString() ? level.stringValue() : null,
                    message != null && message.isString() ? message.stringValue() : "", entry.get("data"));
            } catch (RuntimeException e) {
                failed = failed == null ? e : failed;
                failures++;
            }
        }
        if (failed != null) {
            LOG.warn("Datum: the run log refused {} of this run's entries ({}); the submission's verdict stands.", failures,
                failed.getClass().getName());
        }
    }
}
