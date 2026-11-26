package com.argusvane.datum.submissions.service;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * A test-only runtime that evaluates the real sandbox program in Node's {@code vm}, one {@code node} process per run
 * (after datum-pdf's NodeGuestRuntime, which does the same for the PDF program): the kernel's own answers without a
 * WebAssembly engine, so the host's half of a run is proved against the program the assets ship. The run script is the
 * one {@code RunScript.sandbox} writes for {@code qjs --std -I program run.js}: the program is evaluated first, then the
 * script with the {@code std} and {@code print} that QuickJS would give it. Not a sandbox and never shipped: the
 * production runtime is Endive's.
 */
final class NodeSandboxRuntime implements GuestRuntime {

    private static final String RUNNER = String.join("\n",
        "import { readFileSync } from \"node:fs\";",
        "import vm from \"node:vm\";",
        "const [programFile, scriptFile] = process.argv.slice(2);",
        "const stdin = readFileSync(0, \"utf8\");",
        "const out = [];",
        "const context = vm.createContext({});",
        "vm.runInContext(readFileSync(programFile, \"utf8\"), context);",
        "context.std = { in: { readAsString: () => stdin } };",
        "context.print = (text) => { out.push(String(text)); };",
        "vm.runInContext(readFileSync(scriptFile, \"utf8\"), context);",
        "process.stdout.write(out.join(\"\\n\") + \"\\n\");",
        "");

    private final Path dir;
    private final Path runner;
    private final List<String> answers = Collections.synchronizedList(new ArrayList<>());

    NodeSandboxRuntime() {
        try {
            dir = Files.createTempDirectory("datum-sandbox-node-");
            runner = dir.resolve("runner.mjs");
            Files.writeString(runner, RUNNER);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Whether a {@code node} of version 18 or later is on the PATH. */
    static boolean available() {
        try {
            Process process = new ProcessBuilder("node", "-e", "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)")
                .redirectErrorStream(true).start();
            return process.waitFor(20, TimeUnit.SECONDS) && process.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /** Node is no engine of Datum's: it reports itself as the test runtime it is. */
    @Override
    public EngineInfo engineInfo() {
        return new EngineInfo("node", EngineInfo.UNKNOWN, "node", "The sandbox program evaluated by Node (a test runtime).");
    }

    /** The framed answer of every run so far, in order (probes included). */
    List<String> answers() {
        synchronized (answers) {
            return List.copyOf(answers);
        }
    }

    @Override
    public RunOutput run(GuestRun run) {
        Budget budget = run.budget();
        byte[] stdin = run.stdinBytes();
        // The program and run.js the protocol put under /app (ProgramRunner.guestRun).
        Program program = Program.of(Program.Kind.SANDBOX, java.util.Objects.requireNonNull(run.file(Program.Kind.SANDBOX.fileName()),
            "a sandbox program run"));
        String runScript = new String(java.util.Objects.requireNonNull(run.file("run.js"), "run.js"), StandardCharsets.UTF_8);
        try {
            Path programFile = dir.resolve(program.sha256() + ".js");
            if (!Files.exists(programFile)) {
                Files.write(programFile, program.bytes());
            }
            Path script = Files.createTempFile(dir, "run-", ".js");
            Files.writeString(script, runScript, StandardCharsets.UTF_8);
            Path in = Files.createTempFile(dir, "in-", ".txt");
            Path out = Files.createTempFile(dir, "out-", ".txt");
            Path err = Files.createTempFile(dir, "err-", ".txt");
            Files.write(in, stdin);
            Process process = new ProcessBuilder("node", runner.toString(), programFile.toString(), script.toString())
                .redirectInput(in.toFile()).redirectOutput(out.toFile()).redirectError(err.toFile()).start();
            boolean done = process.waitFor(budget.seconds(), TimeUnit.SECONDS);
            if (!done) {
                process.destroyForcibly();
                return new RunOutput(Termination.BUDGET, -1, Files.readAllBytes(out), Files.readAllBytes(err), null);
            }
            byte[] stdout = Files.readAllBytes(out);
            byte[] stderr = Files.readAllBytes(err);
            String nonce = new String(stdin, StandardCharsets.UTF_8).substring(0, 32);
            String framed = Frame.framed(new String(stdout, StandardCharsets.UTF_8), nonce);
            if (framed != null) {
                answers.add(framed);
            }
            RunOutput output = RunOutput.exited(process.exitValue(), stdout, stderr);
            for (Path file : List.of(script, in, out, err)) {
                Files.deleteIfExists(file);
            }
            return output;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new RunOutput(Termination.INTERRUPTED, -1, null, null, null);
        }
    }
}
