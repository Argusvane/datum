package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A sandbox runtime that answers the {@code check} op without a WebAssembly engine, framed as run.js frames it,
 * so the whole real {@link SandboxService} and {@code DefinitionService} path runs in the tests. Copied in spirit
 * from datum-forms-test-support's FakeGuestRuntime, which this module's tests do not depend on.
 *
 * <p>An answer registered for a definition is used only for that exact definition (by its canonical hash), so a
 * test cannot borrow a captured kernel answer for another input. Without one the check says "ok" with no
 * findings, unless the stub is told to fail: {@link Mode#UNAVAILABLE} ends the run as a trap (the runtime's
 * failure, 503) and {@link Mode#TOO_COSTLY} as a time-budget stop after the guest started (the definition's,
 * 422 {@code definition.tooCostly}).
 */
public final class KernelStub implements GuestRuntime {

    private static final String PROBE_OK = "{\"ok\":true,\"op\":\"inspect\",\"rules\":[],\"functionsUsed\":[],\"pluginsNeeded\":[],\"paths\":[]}";
    private static final String CHECK_OK = "{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[],\"policy\":\"fail\",\"structure\":[],\"structureWarnings\":[],\"verdict\":\"ok\"}";

    /** How the next checks end. */
    public enum Mode {
        ANSWER, UNAVAILABLE, TOO_COSTLY
    }

    /** One check request the runtime received. */
    public record Request(ObjectNode body) {

        public JsonNode definition() {
            return body.get("definition");
        }

        public List<String> types() {
            List<String> out = new ArrayList<>();
            body.path("types").values().forEach(t -> out.add(t.asString()));
            return out;
        }
    }

    private final List<Request> checks = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, String> answers = new ConcurrentHashMap<>();
    private volatile Mode mode = Mode.ANSWER;
    private volatile Consumer<Request> during = request -> { };

    /** Answers a check of exactly this definition with this JSON text (the kernel's answer object). */
    public KernelStub answer(JsonNode definition, String answer) {
        answers.put(CanonicalJson.digest(definition), answer);
        return this;
    }

    public KernelStub mode(Mode next) {
        this.mode = next;
        return this;
    }

    /** Runs while a check is in the kernel, before it answers (a racing save, a slow program). */
    public KernelStub during(Consumer<Request> hook) {
        this.during = hook == null ? request -> { } : hook;
        return this;
    }

    public KernelStub reset() {
        checks.clear();
        answers.clear();
        mode = Mode.ANSWER;
        during = request -> { };
        return this;
    }

    /** A sandbox service over this runtime (a placeholder program, default budgets and host options). */
    public SandboxService service() {
        return SandboxService.create(ProgramRunner.on(this), Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8)),
            new RunScript("/* freeze */"), ProgramLimits.defaults(), HostOptions.defaults());
    }

    /** The check requests so far. */
    public List<Request> checks() {
        synchronized (checks) {
            return List.copyOf(checks);
        }
    }

    @Override
    public RunOutput run(GuestRun run) {
        byte[] stdin = run.stdinBytes();
        String text = new String(stdin, StandardCharsets.UTF_8);
        String nonce = text.substring(0, 32);
        ObjectNode body;
        try {
            body = (ObjectNode) StrictJson.decode(text.substring(33));
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
        String started = Frame.marker(nonce, "started") + "\n";
        String answer;
        if ("datum-abi-probe".equals(body.path("definition").path("id").asString(""))) {
            answer = PROBE_OK;
        } else {
            if (!"check".equals(body.path("op").asString(""))) {
                throw new AssertionError("The kernel stub answers check requests only, not " + body.path("op").asString(""));
            }
            Request request = new Request(body);
            checks.add(request);
            during.accept(request);
            switch (mode) {
                case UNAVAILABLE -> {
                    return new RunOutput(Termination.TRAP, 0, started.getBytes(StandardCharsets.UTF_8), null, "unreachable");
                }
                case TOO_COSTLY -> {
                    return new RunOutput(Termination.BUDGET, 0, started.getBytes(StandardCharsets.UTF_8), null, null);
                }
                default -> answer = answers.getOrDefault(CanonicalJson.digest(body.get("definition")), CHECK_OK);
            }
        }
        String framed = started + Frame.marker(nonce, "begin") + "\n" + answer + "\n" + Frame.marker(nonce, "end") + "\n";
        return RunOutput.exited(0, framed.getBytes(StandardCharsets.UTF_8), null);
    }
}
