package com.argusvane.datum.forms;

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
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A runtime that plays the sandbox program with canned answers, so the services can be tested without a
 * WebAssembly engine. It lives in datum-forms-test-support (never published) because datum-sandbox's own
 * FakeRuntime is package-private.
 *
 * <p>It reads the nonce from stdin as run.js does and frames each answer with the run's markers. The ABI probe
 * (an inspect of the definition "datum-abi-probe") is always answered ok. Every other inspect request is
 * answered by the handler registered for its {@code op} ({@code public}, {@code check}); the defaults mimic the
 * kernel: {@code public} removes every rule whose {@code run} is {@code server-secret}, and {@code check} says
 * "ok" with no findings.
 */
public final class FakeGuestRuntime implements GuestRuntime {

    private static final String PROBE_OK = "{\"ok\":true,\"op\":\"inspect\",\"rules\":[],\"functionsUsed\":[],\"pluginsNeeded\":[],\"paths\":[]}";

    /** One work request the runtime received (probes excluded). */
    public record Request(String op, ObjectNode body) {
    }

    private final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, Function<ObjectNode, String>> handlers = new HashMap<>();

    public FakeGuestRuntime() {
        handlers.put("public", body -> "{\"ok\":true,\"op\":\"public\",\"definition\":" + StrictJson.encode(stripSecretRules(body.path("definition").deepCopy())) + "}");
        handlers.put("check", body -> "{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[],\"policy\":\"fail\",\"structure\":[],\"structureWarnings\":[],\"verdict\":\"ok\"}");
    }

    /** Answers the op's requests with the JSON text the function returns. */
    public FakeGuestRuntime on(String op, Function<ObjectNode, String> answer) {
        handlers.put(op, answer);
        return this;
    }

    /** A sandbox service over this runtime (a placeholder program, default budgets). */
    public SandboxService service() {
        return SandboxService.create(ProgramRunner.on(this), Program.of(Program.Kind.SANDBOX, "/* program */".getBytes(StandardCharsets.UTF_8)),
            new RunScript("/* freeze */"), ProgramLimits.defaults(), HostOptions.defaults());
    }

    /** The work requests so far, in order. */
    public List<Request> requests() {
        synchronized (requests) {
            return List.copyOf(requests);
        }
    }

    /** How many work requests asked for {@code op}. */
    public long count(String op) {
        return requests().stream().filter(r -> r.op().equals(op)).count();
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
        String answer;
        if ("datum-abi-probe".equals(body.path("definition").path("id").asString(""))) {
            answer = PROBE_OK;
        } else {
            String op = body.path("op").asString("");
            requests.add(new Request(op, body));
            Function<ObjectNode, String> handler = handlers.get(op);
            if (handler == null) {
                throw new AssertionError("The fake runtime has no answer for op " + op);
            }
            answer = handler.apply(body);
        }
        String framed = Frame.marker(nonce, "started") + "\n" + Frame.marker(nonce, "begin") + "\n" + answer + "\n" + Frame.marker(nonce, "end") + "\n";
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
