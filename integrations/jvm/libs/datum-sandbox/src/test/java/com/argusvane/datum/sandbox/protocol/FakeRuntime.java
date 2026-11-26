package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;

/**
 * A runtime that plays the guest: it reads the nonce from stdin as run.js does, and answers through a
 * function of the call. It records every call.
 */
final class FakeRuntime implements ProgramRunner {

    /** One call as the runtime received it. */
    record Call(Program program, String script, List<String> argv, String stdin, Budget budget) {

        boolean inspect() {
            return script.contains("var entry = globalThis.__datum_inspect;");
        }

        /** The nonce run.js would read, or null when stdin has none (a PDF run). */
        String nonce() {
            return stdin.length() > 32 && stdin.charAt(32) == '\n' && Nonce.isValid(stdin.substring(0, 32)) ? stdin.substring(0, 32) : null;
        }

        /** What the entry point reads. */
        JsonNode input() {
            try {
                return StrictJson.decode(nonce() != null ? stdin.substring(33) : stdin);
            } catch (StrictJson.NotJsonException e) {
                throw new AssertionError(e);
            }
        }

        /** A run that answered {@code answer} inside this call's frame. */
        RunOutput framed(String answer) {
            return RunOutput.exited(0, Fixtures.frame(nonce(), answer).getBytes(StandardCharsets.UTF_8), null);
        }
    }

    static final String PROBE_OK = "{\"ok\":true,\"op\":\"inspect\",\"rules\":[],\"functionsUsed\":[],\"pluginsNeeded\":[],\"paths\":[]}";

    final List<Call> calls = new ArrayList<>();
    private final Function<Call, RunOutput> guest;

    FakeRuntime(Function<Call, RunOutput> guest) {
        this.guest = guest;
    }

    /** A guest whose ABI probe passes and whose other runs answer {@code answer} framed. */
    static FakeRuntime answering(String answer) {
        return new FakeRuntime(call -> isProbe(call) ? call.framed(PROBE_OK) : call.framed(answer));
    }

    static boolean isProbe(Call call) {
        return call.nonce() != null && call.inspect() && "datum-abi-probe".equals(call.input().path("definition").path("id").asString(""));
    }

    @Override
    public synchronized RunOutput run(Program program, String runScript, List<String> argv, byte[] stdin, Budget budget) {
        Call call = new Call(program, runScript, argv, new String(stdin, StandardCharsets.UTF_8), budget);
        calls.add(call);
        return guest.apply(call);
    }

    List<Call> work() {
        return calls.stream().filter(c -> !isProbe(c)).toList();
    }

    long probes() {
        return calls.stream().filter(FakeRuntime::isProbe).count();
    }
}
