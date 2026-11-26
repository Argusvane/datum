package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.diagnostics.RunRecorder;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.OutputCapExceededException;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * One call of the PDF program, gated by its ABI (PDF ABI, {@link PdfAbi}): the runtime-agnostic half of a PDF
 * request. Slots, fonts, the signing ops and the result types are datum-pdf's.
 *
 * <p>The request goes on stdin as it is and the answer is the whole of stdout: no rule module is registered
 * in a PDF run, so there is no untrusted code that could print and no nonce frame. The answer must be a JSON object,
 * with only JSON whitespace around it; {@code ok: false}
 * is the program refusing the request ({@link Reason#REFUSED}, its code on the exception).
 *
 * <p>It is the one {@link PdfKernel} that runs the protocol; a host observes its runs by wrapping it through a
 * {@link PdfKernelDecorator}, never by replacing it. With a {@link RunRecorder} every run is handed to it once
 * judged, as {@link SandboxService} does, after the last check the protocol makes of it: a
 * {@link #call} answer by its {@code ok} ({@code verdict} for true, {@code refused} for false, {@code no_outcome} when it is not
 * a boolean), a {@link #capabilities} answer after the ABI and features are read ({@code refused} when the program answered
 * an {@code ok} the gate did not take, as for the sandbox probe). The checks are the same either way.
 */
public final class PdfProgram implements PdfKernel {

    private final ProgramRunner runtime;
    private final Program program;
    private final ProgramLimits limits;
    private final AbiProbe probe;
    private final @Nullable RunRecorder recorder;

    public PdfProgram(ProgramRunner runtime, Program program, ProgramLimits limits, AbiProbe probe) {
        this(runtime, program, limits, probe, null);
    }

    /** The program with a recorder of its runs, or none (null). */
    public PdfProgram(ProgramRunner runtime, Program program, ProgramLimits limits, AbiProbe probe, @Nullable RunRecorder recorder) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.program = Objects.requireNonNull(program, "program");
        if (program.kind() != Program.Kind.PDF) {
            throw new IllegalArgumentException("A PDF call runs the PDF program, not " + program.kind().fileName() + ".");
        }
        this.limits = Objects.requireNonNull(limits, "limits");
        this.probe = Objects.requireNonNull(probe, "probe");
        this.recorder = recorder;
    }

    /** The program this runs. */
    @Override
    public Program program() {
        return program;
    }

    /**
     * The program's feature names, asked once per program (sha256) and floor, which also proves its ABI. A
     * failed answer is remembered for {@link AbiProbe#PDF_FAILURE_MEMORY} and refused again without a run. A run the
     * host cancelled ({@link Reason#INTERRUPTED}) says nothing about the program and is not remembered.
     *
     * @throws ProgramUnavailableException when the program does not answer for {@link PdfAbi#MIN}, or did not
     *     a moment ago
     */
    @Override
    public List<String> capabilities() {
        Optional<List<String>> known = probe.pdfFeatures(program);
        if (known.isPresent()) {
            return known.get();
        }
        Optional<String> failed = probe.pdfFailure(program);
        if (failed.isPresent()) {
            throw new ProgramUnavailableException(failed.get());
        }
        Answer answer;
        try {
            answer = run(AbiProbe.pdfRequest());
        } catch (SandboxException e) {
            ProgramUnavailableException unavailable = new ProgramUnavailableException(
                "The PDF program did not answer its capabilities (" + e.reason() + ").", e);
            if (e.reason() != Reason.INTERRUPTED) {
                probe.rememberPdfFailure(program, unavailable.getMessage());
            }
            throw unavailable;
        } catch (ProgramUnavailableException e) {
            probe.rememberPdfFailure(program, e.getMessage());
            throw e;
        }
        List<String> features;
        try {
            features = AbiProbe.requirePdfCapabilities(answer.json());
        } catch (ProgramUnavailableException e) {
            // The gate's refusal of what the program answered: its own stale answer (an ok the gate did not take) is
            // refused, like the sandbox probe's abi_mismatch; an answer with no ok is no outcome.
            answer.end(answer.json().path("ok").isBoolean() ? RunWatch.REFUSED : RunWatch.word(Reason.NO_OUTCOME));
            probe.rememberPdfFailure(program, e.getMessage());
            throw e;
        }
        answer.end(RunWatch.VERDICT);
        probe.rememberPdf(program, features);
        return features;
    }

    /**
     * Runs one request after the ABI gate and returns a successful answer. The request's {@code abi} and
     * {@code op} are the caller's to set ({@link PdfAbi#MIN} and the op).
     *
     * @throws SandboxException when the run gave no answer, or {@link Reason#REFUSED} when the program refused
     * @throws ProgramUnavailableException when the program does not speak the host's ABI
     */
    @Override
    public ObjectNode call(ObjectNode request) {
        capabilities();
        Answer run = run(request);
        JsonNode answer = run.json();
        JsonNode ok = answer.path("ok");
        // The run's word: the program's own refusal (ok false) is an answer; an answer with no boolean ok is none, though
        // the caller is answered with the same REFUSED either way (the wire is unchanged).
        run.end(!ok.isBoolean() ? RunWatch.word(Reason.NO_OUTCOME) : ok.booleanValue() ? RunWatch.VERDICT
            : RunWatch.REFUSED);
        if (!ok.isBoolean() || !ok.booleanValue()) {
            JsonNode code = answer.path("error").path("code");
            JsonNode message = answer.path("error").path("message");
            String programCode = code.isString() ? code.stringValue() : "internal";
            throw new SandboxException(Reason.REFUSED, "The PDF program refused the request (" + programCode + ").", "", false, null,
                programCode, message.isString() ? message.stringValue() : "The PDF program answered with an error.", null);
        }
        return (ObjectNode) answer;
    }

    /**
     * One run's JSON object and its watch, which the caller ends after its own last check of the answer (null without a
     * recorder, and then ending it does nothing).
     */
    private record Answer(JsonNode json, @Nullable RunWatch watch) {

        void end(String outcome) {
            if (watch != null) {
                watch.end(outcome);
            }
        }
    }

    /** The recorder its runs are handed to, or null: the diagnostics' tests read it. */
    @Nullable RunRecorder recorder() {
        return recorder;
    }

    /** One run of the PDF program, up to a JSON object; the slot is the caller's (datum-pdf). The watch is the caller's to end. */
    private Answer run(ObjectNode request) {
        String json;
        try {
            json = StrictJson.encode(request);
        } catch (IllegalArgumentException e) {
            throw new SandboxException(Reason.INPUT, "The PDF request could not be written as JSON: " + e.getMessage());
        }
        Budget budget = limits.pdfBudget();
        byte[] stdin = json.getBytes(StandardCharsets.UTF_8);
        RunWatch watch = recorder == null ? null : RunWatch.start(recorder, program, request.path("op").asString(""), RunScript.PDF, stdin);
        RunOutput output;
        try {
            output = runtime.run(program, RunScript.PDF, RunScript.argv(Program.Kind.PDF), stdin, budget);
        } catch (OutputCapExceededException e) {
            output = new RunOutput(Termination.OUTPUT_CAP, -1, null, null, null);
        } catch (RuntimeException e) {
            throw ended(watch, e);
        }
        if (output == null) {
            throw ended(watch, new ProgramUnavailableException("The runtime returned no run."));
        }
        if (watch != null) {
            watch.ran(output);
        }
        byte[] stdout;
        try {
            stdout = RunClassifier.pdfAnswer(output, budget);
        } catch (RuntimeException e) {
            throw ended(watch, e);
        }
        String stderr = RunClassifier.stderrText(output);
        JsonNode answer;
        try {
            answer = StrictJson.decode(stdout);
        } catch (StrictJson.NotJsonException e) {
            throw ended(watch, new SandboxException(Reason.NOT_JSON, "The PDF program printed something that is not JSON.", stderr));
        }
        if (!answer.isObject()) {
            throw ended(watch, new SandboxException(Reason.NO_OUTCOME, "The PDF program printed no answer.", stderr));
        }
        return new Answer(answer, watch);
    }

    private static <E extends RuntimeException> E ended(@Nullable RunWatch watch, E failure) {
        if (watch != null) {
            watch.end(failure);
        }
        return failure;
    }
}
