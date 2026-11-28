package com.argusvane.datum.sandbox.observation;

import com.argusvane.datum.core.contracts.PdfCapabilitiesResponse;
import com.argusvane.datum.core.observation.DatumObservation;
import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.PdfKernelDecorator;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.sandbox.protocol.SandboxResult;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Datum's own observation of every guest run: {@value DatumObservationNames#SANDBOX_RUN} around each sandbox
 * operation and {@value DatumObservationNames#PDF_RUN} around each PDF program call. A host's runtime applies them first,
 * directly around the protocol it built, so an application's decorators wrap Datum's observation and their own spans
 * enclose it. With {@link DatumObservations#none()} both answer what they are given: no wrapper at all.
 */
public final class GuestRunObservations {

    /** The ops a PDF request may name in a tag: Datum's own words, letters only; anything else is {@code other}. */
    private static final Pattern PDF_OP = Pattern.compile("^[a-z][A-Za-z]{0,31}$");

    private static final Set<String> INSPECT_OPS = Set.of("public", "check", "inspect");

    private GuestRunObservations() {
    }

    /**
     * Observes every call of the sandbox program's operations.
     *
     * @param engineMode the engine's mode, the {@value DatumObservationNames#ENGINE_MODE} key
     */
    public static SandboxDecorator sandbox(DatumObservations observations, String engineMode) {
        Objects.requireNonNull(observations, "observations");
        if (!observations.enabled()) {
            return sandbox -> sandbox;
        }
        String mode = engineMode == null || engineMode.isBlank() ? "unknown" : engineMode;
        return sandbox -> new ObservedSandbox(sandbox, observations, mode);
    }

    /** Observes every call of the PDF program. */
    public static PdfKernelDecorator pdfKernel(DatumObservations observations, String engineMode) {
        Objects.requireNonNull(observations, "observations");
        if (!observations.enabled()) {
            return kernel -> kernel;
        }
        String mode = engineMode == null || engineMode.isBlank() ? "unknown" : engineMode;
        return kernel -> new ObservedPdfKernel(kernel, observations, mode);
    }

    /** Runs {@code work} under one observation: {@code ok}, or the failure's outcome and the failure recorded, rethrown. */
    static <T> T observe(DatumObservations observations, String name, String op, String engineMode, Supplier<T> work) {
        DatumObservation observation = observations.start(name, name.replace('.', ' ') + " " + op,
            DatumObservationNames.OP, op, DatumObservationNames.ENGINE_MODE, engineMode);
        try {
            T answer = work.get();
            observation.lowCardinality(DatumObservationNames.OUTCOME, answer instanceof Sandbox.Smoke smoke && !smoke.ok() ? "failed" : "ok");
            return answer;
        } catch (RuntimeException | Error e) {
            observation.lowCardinality(DatumObservationNames.OUTCOME, DatumObservations.outcomeOf(e)).error(e);
            throw e;
        } finally {
            observation.close();
        }
    }

    /** The sandbox with each operation observed; delegates every call. */
    private record ObservedSandbox(Sandbox delegate, DatumObservations observations, String engineMode) implements Sandbox {

        private <T> T observed(String op, Supplier<T> work) {
            return observe(observations, DatumObservationNames.SANDBOX_RUN, op, engineMode, work);
        }

        @Override
        public Program program() {
            return delegate.program();
        }

        @Override
        public SandboxResult validate(ObjectNode context, List<RuleModule> rules, boolean real) {
            return observed("validate", () -> delegate.validate(context, rules, real));
        }

        @Override
        public ObjectNode inspect(String op, ObjectNode definition, String formulaErrors, Map<String, JsonNode> extra, List<RuleModule> rules) {
            return observed(op != null && INSPECT_OPS.contains(op) ? op : "inspect",
                () -> delegate.inspect(op, definition, formulaErrors, extra, rules));
        }

        @Override
        public ObjectNode inspect(String op, ObjectNode definition) {
            return observed(op != null && INSPECT_OPS.contains(op) ? op : "inspect", () -> delegate.inspect(op, definition));
        }

        @Override
        public ObjectNode check(ObjectNode definition, List<String> types, List<RuleModule> rules) {
            return observed("check", () -> delegate.check(definition, types, rules));
        }

        @Override
        public ObjectNode publicCopy(ObjectNode definition) {
            return observed("public", () -> delegate.publicCopy(definition));
        }

        @Override
        public Smoke smoke() {
            return observed("smoke", delegate::smoke);
        }

        @Override
        public void proveAbi() {
            observed("abi", () -> {
                delegate.proveAbi();
                return null;
            });
        }
    }

    /** The PDF program with each call observed; delegates every call. */
    private record ObservedPdfKernel(PdfKernel delegate, DatumObservations observations, String engineMode) implements PdfKernel {

        @Override
        public Program program() {
            return delegate.program();
        }

        @Override
        public PdfCapabilitiesResponse capabilities() {
            return observe(observations, DatumObservationNames.PDF_RUN, "capabilities", engineMode, delegate::capabilities);
        }

        @Override
        public ObjectNode call(ObjectNode request) {
            JsonNode op = request == null ? null : request.get("op");
            String word = op != null && op.isString() && PDF_OP.matcher(op.stringValue()).matches() ? op.stringValue() : "other";
            return observe(observations, DatumObservationNames.PDF_RUN, word, engineMode, () -> delegate.call(request));
        }
    }
}
