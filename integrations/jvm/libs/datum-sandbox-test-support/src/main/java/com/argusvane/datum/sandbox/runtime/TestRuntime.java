package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * A runtime that plays both programs with canned answers (after datum-forms' FakeGuestRuntime, which handles
 * only the inspect ops): the sandbox ABI probe, the smoke run, validation runs (answered by {@link #outcome},
 * the kernel's accepting answer by default) and the PDF capabilities probe. It can refuse the probes, hold
 * runs until released (or until interrupted), and end runs with a termination instead of an answer.
 *
 * <p>It reports an {@link EngineInfo} whose mode is {@link #mode} ({@code jffi} by default; {@code bytecode} rules the PDF
 * program out, as Endive's bytecode fallback does).
 */
public final class TestRuntime implements GuestRuntime {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** A strict-JSON object, for the tests that build a run context. */
    public static ObjectNode json(String text) {
        try {
            return (ObjectNode) StrictJson.decode(text);
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
    }

    private final List<ObjectNode> contexts = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger validations = new AtomicInteger();
    private final AtomicInteger smokes = new AtomicInteger();
    private final AtomicInteger pdfProbes = new AtomicInteger();
    private final AtomicInteger sandboxProbes = new AtomicInteger();

    /** The budget of every run so far, in order (probes, smokes and validations alike). */
    public final List<Budget> budgets = Collections.synchronizedList(new ArrayList<>());
    /** When above zero, a run whose budget is shorter than this many seconds ends BUDGET: a slow, enforcing engine. */
    public volatile int costSeconds;

    public volatile Function<ObjectNode, ObjectNode> outcome = TestRuntime::accepting;
    public volatile boolean sandboxProbeFails;
    public volatile boolean pdfProbeFails;
    /** The ABI the PDF program's capabilities answer names: an older one is a stale program the gate refuses. */
    public volatile String pdfAbi = "1.0.0";
    public volatile boolean smokeWrong;
    public volatile String mode = "jffi";
    /** When set, validation runs (not probes or smokes) end with this termination instead of an answer. */
    public volatile Termination terminate;
    /** When set, validation runs (not probes or smokes) throw it: a run that cannot start (a {@code GuestUnavailableException}). */
    public volatile RuntimeException failValidations;
    /** When set, validation runs wait for it (and answer INTERRUPTED if interrupted while waiting). */
    public volatile CountDownLatch hold;
    /** Counted down when a held run starts waiting. */
    public volatile CountDownLatch holding = new CountDownLatch(0);

    @Override
    public EngineInfo engineInfo() {
        boolean bytecode = EngineInfo.BYTECODE.equals(mode);
        return new EngineInfo(TestRuntime.class.getName(), "test", mode,
            bytecode ? "QuickJS runs as JVM bytecode in this test runtime." : "A scripted test runtime.");
    }

    /** A sandbox service over this runtime, with default limits and host options. */
    public SandboxService service() {
        return SandboxService.create(ProgramRunner.on(this), Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8)),
            new RunScript("/* freeze */"), ProgramLimits.defaults(), HostOptions.defaults());
    }

    /** The validation contexts so far (smokes excluded), as the program read them. */
    public List<ObjectNode> contexts() {
        synchronized (contexts) {
            return List.copyOf(contexts);
        }
    }

    public int validations() {
        return validations.get();
    }

    public int smokes() {
        return smokes.get();
    }

    public int pdfProbes() {
        return pdfProbes.get();
    }

    public int sandboxProbes() {
        return sandboxProbes.get();
    }

    /** The kernel's answer to answers it accepts: no errors, the values kept, the document's text and digest. */
    public static ObjectNode accepting(ObjectNode context) {
        ObjectNode outcome = NODES.objectNode();
        outcome.putArray("errors");
        outcome.set("values", context.path("values").deepCopy());
        described(outcome, context);
        outcome.putArray("index");
        return outcome;
    }

    /** Adds canonical and digest of the context's document, as the program answers. */
    public static ObjectNode described(ObjectNode outcome, ObjectNode context) {
        JsonNode document = context.get("document");
        if (document != null) {
            String canonical = CanonicalJson.serialize(document);
            outcome.put("canonical", canonical);
            outcome.put("digest", CanonicalJson.sha256Hex(canonical));
        } else {
            outcome.put("canonical", "{}");
            outcome.put("digest", CanonicalJson.sha256Hex("{}"));
        }
        return outcome;
    }

    @Override
    public RunOutput run(GuestRun run) {
        Budget budget = run.budget();
        byte[] stdin = run.stdinBytes();
        budgets.add(budget);
        if (costSeconds > budget.seconds()) {
            return new RunOutput(Termination.BUDGET, -1, null, null, null);
        }
        String text = new String(stdin, StandardCharsets.UTF_8);
        if (Program.Kind.of(run) == Program.Kind.PDF) {
            pdfProbes.incrementAndGet();
            String answer = pdfProbeFails ? "{\"ok\":false,\"error\":{\"code\":\"abi_mismatch\",\"message\":\"old\"}}"
                : "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"" + pdfAbi + "\",\"kernelVersion\":\"0.1.0\"}";
            return RunOutput.exited(0, answer.getBytes(StandardCharsets.UTF_8), null);
        }
        String nonce = text.substring(0, 32);
        ObjectNode body;
        try {
            body = (ObjectNode) StrictJson.decode(text.substring(33));
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
        String answer;
        if ("datum-abi-probe".equals(body.path("definition").path("id").asString(""))) {
            sandboxProbes.incrementAndGet();
            answer = sandboxProbeFails ? "{\"ok\":false,\"error\":{\"code\":\"abi_mismatch\",\"message\":\"old\"}}"
                : "{\"ok\":true,\"op\":\"inspect\",\"rules\":[],\"functionsUsed\":[],\"pluginsNeeded\":[],\"paths\":[]}";
        } else if ("datum-smoke".equals(body.path("formId").asString(""))) {
            smokes.incrementAndGet();
            answer = smokeWrong ? "{\"errors\":[]}" : "{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}";
        } else if (body.has("op")) {
            throw new AssertionError("The test runtime has no answer for op " + body.path("op").asString(""));
        } else {
            RuntimeException failure = failValidations;
            if (failure != null) {
                throw failure;
            }
            validations.incrementAndGet();
            contexts.add(body.deepCopy());
            CountDownLatch gate = hold;
            if (gate != null) {
                holding.countDown();
                try {
                    gate.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return new RunOutput(Termination.INTERRUPTED, -1, null, null, null);
                }
            }
            Termination ending = terminate;
            if (ending != null) {
                String started = Frame.marker(nonce, "started") + "\n";
                return new RunOutput(ending, -1, started.getBytes(StandardCharsets.UTF_8), null, null);
            }
            answer = StrictJson.encode(outcome.apply(body));
        }
        String framed = Frame.marker(nonce, "started") + "\n" + Frame.marker(nonce, "begin") + "\n" + answer + "\n"
            + Frame.marker(nonce, "end") + "\n";
        return RunOutput.exited(0, framed.getBytes(StandardCharsets.UTF_8), null);
    }
}
