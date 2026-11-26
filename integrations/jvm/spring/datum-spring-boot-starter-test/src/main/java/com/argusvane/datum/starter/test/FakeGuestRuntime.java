package com.argusvane.datum.starter.test;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * A {@link GuestRuntime} that plays both programs with canned answers, so an application's context starts and its endpoints
 * answer without a WebAssembly engine (the fake is the one test double every module and
 * application shares). It merges what datum-forms' and datum-submissions' own test doubles did separately: the
 * sandbox ABI probe, the smoke run, the kernel's inspect ops ({@code public}, {@code check}), validation runs and
 * the PDF capabilities probe.
 *
 * <p>Validation runs are answered by {@link #outcome(Function)}; the default accepts every document and keeps its
 * values, with the canonical text and digest the ABI 2.9.0 answer carries. {@code public} removes every rule whose
 * {@code run} is {@code server-secret}, as the kernel does, and {@code check} says "ok" with no findings. Other
 * inspect ops are answered with {@link #on(String, Function)}; an op nobody answers is an {@link AssertionError},
 * so a test never passes on a silent default.
 *
 * <p>It answers by the program the protocol put under {@code /app} ({@link Program.Kind#of(GuestRun)}) and the request on
 * stdin. It reports an {@link EngineInfo} whose mode is {@link #nativeProvider()}: {@code jffi} by default, so
 * the PDF path counts as available; {@code bytecode} rules the PDF program out, as Endive's bytecode fallback does, and
 * like it does not start unless the test sets {@code datum.runtime.allow-bytecode=true} (the runtime reads the mode once,
 * when it is built, so set the mode before the context starts).
 */
public final class FakeGuestRuntime implements GuestRuntime {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private static final String PROBE_OK = "{\"ok\":true,\"op\":\"inspect\",\"rules\":[],\"functionsUsed\":[],\"pluginsNeeded\":[],\"paths\":[]}";
    private static final String PROBE_REFUSED = "{\"ok\":false,\"error\":{\"code\":\"abi_mismatch\",\"message\":\"old\"}}";
    private static final String PDF_PROBE_OK = "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"4.0.0\",\"features\":[\"formulas\"]}";

    /** One inspect request the runtime received (probes excluded). */
    public record Request(String op, ObjectNode body) {
    }

    private final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
    private final List<ObjectNode> contexts = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, Function<ObjectNode, String>> handlers = new ConcurrentHashMap<>();
    private volatile Function<ObjectNode, ObjectNode> outcome = FakeGuestRuntime::accepting;
    private volatile String nativeProvider = "jffi";
    private volatile boolean sandboxProbeFails;
    private volatile boolean pdfProbeFails;

    public FakeGuestRuntime() {
        installDefaultHandlers();
    }

    /** The kernel ops the fake always answers; reset() puts them back so a test's on() never leaks into the next. */
    private void installDefaultHandlers() {
        handlers.put("public", body -> "{\"ok\":true,\"op\":\"public\",\"definition\":"
            + StrictJson.encode(stripSecretRules(body.path("definition").deepCopy())) + "}");
        handlers.put("check", body -> "{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[],\"policy\":\"fail\","
            + "\"structure\":[],\"structureWarnings\":[],\"verdict\":\"ok\"}");
    }

    /** Answers the inspect op's requests with the JSON text the function returns. */
    public FakeGuestRuntime on(String op, Function<ObjectNode, String> answer) {
        handlers.put(op, answer);
        return this;
    }

    /** Answers validation runs: the function gets the context the program would read and returns the outcome. */
    public FakeGuestRuntime outcome(Function<ObjectNode, ObjectNode> answer) {
        this.outcome = answer;
        return this;
    }

    /** The mode the fake's engine reports ({@code jffi}, {@code panama} or {@code bytecode}). */
    public FakeGuestRuntime nativeProvider(String provider) {
        this.nativeProvider = provider;
        return this;
    }

    /** Makes the sandbox ABI probe answer a mismatch, so the runtime start is refused. */
    public FakeGuestRuntime sandboxProbeFails(boolean fails) {
        this.sandboxProbeFails = fails;
        return this;
    }

    /** Makes the PDF capabilities probe answer a mismatch, so the PDF path is unavailable. */
    public FakeGuestRuntime pdfProbeFails(boolean fails) {
        this.pdfProbeFails = fails;
        return this;
    }

    /** Back to the defaults and forgets the requests, between tests that share a context. */
    public FakeGuestRuntime reset() {
        requests.clear();
        contexts.clear();
        outcome = FakeGuestRuntime::accepting;
        handlers.clear();
        installDefaultHandlers();
        nativeProvider = "jffi";
        sandboxProbeFails = false;
        pdfProbeFails = false;
        return this;
    }

    /** The mode the fake's engine reports. */
    public String nativeProvider() {
        return nativeProvider;
    }

    /** What the runtime lifecycle, health and info report: the fake's class and its mode (the lifecycle runs PDF unless bytecode). */
    @Override
    public EngineInfo engineInfo() {
        String mode = nativeProvider;
        boolean bytecode = EngineInfo.BYTECODE.equals(mode);
        return new EngineInfo(FakeGuestRuntime.class.getName(), "test", mode,
            bytecode ? "The fake runtime stands for an engine on its JVM bytecode fallback." : "The test starter's fake runtime.");
    }

    /** A sandbox service over this runtime (a placeholder program, default budgets). */
    public SandboxService service() {
        return SandboxService.create(ProgramRunner.on(this), Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8)),
            new RunScript("/* freeze */"), ProgramLimits.defaults(), HostOptions.defaults());
    }

    /** The inspect requests so far, in order. */
    public List<Request> requests() {
        synchronized (requests) {
            return List.copyOf(requests);
        }
    }

    /** How many inspect requests asked for {@code op}. */
    public long count(String op) {
        return requests().stream().filter(r -> r.op().equals(op)).count();
    }

    /** The validation contexts so far (probes and smoke runs excluded), as the program read them. */
    public List<ObjectNode> contexts() {
        synchronized (contexts) {
            return List.copyOf(contexts);
        }
    }

    /** The kernel's answer to answers it accepts: no errors, the values kept, the document's text and digest. */
    public static ObjectNode accepting(ObjectNode context) {
        ObjectNode outcome = NODES.objectNode();
        outcome.putArray("errors");
        outcome.set("values", context.path("values").deepCopy());
        JsonNode document = context.get("document");
        String canonical = document == null ? "{}" : CanonicalJson.serialize(document);
        outcome.put("canonical", canonical);
        outcome.put("digest", CanonicalJson.sha256Hex(canonical));
        outcome.putArray("index");
        return outcome;
    }

    @Override
    public RunOutput run(GuestRun run) {
        byte[] stdin = run.stdinBytes();
        if (Program.Kind.of(run) == Program.Kind.PDF) {
            String answer = pdfProbeFails ? PROBE_REFUSED : PDF_PROBE_OK;
            return RunOutput.exited(0, answer.getBytes(StandardCharsets.UTF_8), null);
        }
        String text = new String(stdin, StandardCharsets.UTF_8);
        String nonce = text.substring(0, 32);
        ObjectNode body;
        try {
            body = (ObjectNode) StrictJson.decode(text.substring(33));
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
        String answer;
        if ("datum-abi-probe".equals(body.path("definition").path("id").asString(""))) {
            answer = sandboxProbeFails ? PROBE_REFUSED : PROBE_OK;
        } else if ("datum-smoke".equals(body.path("formId").asString(""))) {
            answer = "{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}";
        } else if (body.has("op")) {
            String op = body.path("op").asString("");
            requests.add(new Request(op, body));
            Function<ObjectNode, String> handler = handlers.get(op);
            if (handler == null) {
                throw new AssertionError("The fake runtime has no answer for op " + op);
            }
            answer = handler.apply(body);
        } else {
            contexts.add(body.deepCopy());
            answer = StrictJson.encode(outcome.apply(body));
        }
        String framed = Frame.marker(nonce, "started") + "\n" + Frame.marker(nonce, "begin") + "\n" + answer + "\n"
            + Frame.marker(nonce, "end") + "\n";
        return RunOutput.exited(0, framed.getBytes(StandardCharsets.UTF_8), null);
    }

    /** Removes every rule marked {@code run: "server-secret"}, as the kernel's public op does. */
    static JsonNode stripSecretRules(JsonNode node) {
        if (node.isObject()) {
            ObjectNode object = (ObjectNode) node;
            JsonNode rules = object.get("rules");
            if (rules != null && rules.isObject()) {
                ObjectNode ruleObject = (ObjectNode) rules;
                List<String> secret = new ArrayList<>();
                ruleObject.properties().forEach(e -> {
                    if ("server-secret".equals(e.getValue().path("run").asString(""))) {
                        secret.add(e.getKey());
                    }
                });
                ruleObject.remove(secret);
                if (ruleObject.isEmpty()) {
                    object.remove("rules");
                }
            }
            for (JsonNode child : new ArrayList<>(object.values())) {
                stripSecretRules(child);
            }
        } else if (node.isArray()) {
            for (JsonNode child : node) {
                stripSecretRules(child);
            }
        }
        return node;
    }
}
