package com.argusvane.datum.pdf;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * A test-only runtime that evaluates the real PDF program in Node's {@code vm} (one {@code node} process per run): the
 * kernel's own answers without a WebAssembly engine, so the host's half of the signing flow is proved against the real
 * program while datum-sandbox-endive is not installed. Not a sandbox and never shipped: the production runtime is
 * Endive's ({@code PdfRealRuntimeIT}). The run script is the PDF {@code run.js} contract ({@code __datum_pdf(stdin)}
 * then print), the program evaluated first as {@code qjs -I} does.
 */
final class NodeGuestRuntime implements GuestRuntime {

    /** Node is no engine of Datum's: it reports itself as the test runtime it is, able to run the PDF program. */
    @Override
    public EngineInfo engineInfo() {
        return new EngineInfo("node", EngineInfo.UNKNOWN, "node", "The PDF program evaluated by Node (a test runtime).");
    }

    private static final String RUNNER = String.join("\n",
        "import { readFileSync } from \"node:fs\";",
        "import vm from \"node:vm\";",
        "const log = (...a) => process.stderr.write(a.join(\" \") + \"\\n\");",
        "const context = vm.createContext({ console: { log, warn: log, error: log, info: log, debug: log } });",
        "vm.runInContext(readFileSync(process.argv[2], \"utf8\"), context);",
        "const answer = await context.__datum_pdf(readFileSync(0, \"utf8\"));",
        "process.stdout.write(answer + \"\\n\");",
        "");

    private final Path dir;
    private final Path runner;

    NodeGuestRuntime() {
        try {
            dir = Files.createTempDirectory("datum-pdf-node-");
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

    @Override
    public RunOutput run(GuestRun run) {
        Budget budget = run.budget();
        byte[] stdin = run.stdinBytes();
        // The program the protocol put under /app (ProgramRunner.guestRun), written once per content.
        Program program = Program.of(Program.Kind.PDF, java.util.Objects.requireNonNull(run.file(Program.Kind.PDF.fileName()),
            "a PDF program run"));
        try {
            Path programFile = dir.resolve(program.sha256() + ".js");
            if (!Files.exists(programFile)) {
                Files.write(programFile, program.bytes());
            }
            Path in = Files.createTempFile(dir, "in-", ".json");
            Path out = Files.createTempFile(dir, "out-", ".txt");
            Path err = Files.createTempFile(dir, "err-", ".txt");
            Files.write(in, stdin);
            Process process = new ProcessBuilder("node", runner.toString(), programFile.toString())
                .redirectInput(in.toFile()).redirectOutput(out.toFile()).redirectError(err.toFile()).start();
            boolean done = process.waitFor(budget.seconds(), TimeUnit.SECONDS);
            if (!done) {
                process.destroyForcibly();
                return new RunOutput(Termination.BUDGET, -1, Files.readAllBytes(out), Files.readAllBytes(err), null);
            }
            RunOutput output = RunOutput.exited(process.exitValue(), Files.readAllBytes(out), Files.readAllBytes(err));
            Files.deleteIfExists(in);
            Files.deleteIfExists(out);
            Files.deleteIfExists(err);
            return output;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new RunOutput(Termination.INTERRUPTED, -1, null, null, null);
        }
    }
}
