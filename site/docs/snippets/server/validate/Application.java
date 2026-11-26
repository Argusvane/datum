// Application.java — the endpoint the page delivers to.
//   pom.xml beside it: Spring Boot, and Endive with its Maven plugin, which compiles the engine in.
//   curl -Lo src/main/resources/qjs-wasi.wasm https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   mvn spring-boot:run
//
// The submission is re-validated in the very program the browser's sandbox runs
// (datum-sandbox-program.js, written beside the bundles), in a QuickJS of this process's own —
// QuickJS-ng's WebAssembly build, run by Endive: the same kernel over the same schema, the
// same rules, so the same verdict — codes and fields, never text — and the same sanitized
// values. Nothing is re-implemented here; nothing the page did is trusted either.
package datum;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.google.common.jimfs.Configuration;
import com.google.common.jimfs.Jimfs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.event.Level;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import run.endive.runtime.ImportValues;
import run.endive.wasi.WasiExitException;
import run.endive.wasi.WasiOptions;
import run.endive.wasi.WasiPreview1;
import run.endive.wasm.types.MemoryLimits;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootApplication
@RestController
public class Application {

    static final JsonMapper JSON = JsonMapper.shared();
    static final JsonNode FORM = JSON.readTree(text("forms/customer-intake.json"));

    // The journey the answers were given through, from this server's own copy of the form: the
    // envelope names it (submission.journey.id) and nothing more. Handed to the sandbox, it has the
    // kernel work the path out again from the values, as the browser did: an answer on a page the
    // path skipped is judged hidden, and a form field one of the journey's own fields fills or works
    // out counts as asked on that page. None named, or one the form does not have: null, and the
    // answers are judged as the whole form, which asks for every required field.
    static JsonNode journeyOf(JsonNode submission) {
        for (JsonNode journey : FORM.path("journey").path("journeys")) {
            if (journey.path("id").equals(submission.path("journey").path("id"))) {
                return journey;
            }
        }
        return null;  // set as JSON null: no journey
    }

    // The engine: qjs-wasi.wasm, QuickJS-ng's own WebAssembly build from its release page, compiled once,
    // at build time, by Endive's plugin (see pom.xml) into the class Qjs — native code where the platform
    // has it, JVM bytecode where not. Every request runs it afresh in an instance of its own, so requests
    // need no lock. The module's own initial memory, which a limit must keep.
    static final int QJS_PAGES = Qjs.load().memorySection().get().getMemory(0).limits().initialPages();

    // What a run can reach: one in-memory directory holding the program, and nothing else — not this
    // directory, not the disk. Endive mounts any java.nio path, and Jimfs makes one.
    static final Path APP = programs();

    static Path programs() {
        try {
            var app = Files.createDirectories(Jimfs.newFileSystem(Configuration.unix()).getPath("/app"));
            Files.copy(Path.of("datum-sandbox-program.js"), app.resolve("datum-sandbox-program.js"));
            return app;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static {
        // A JVM's first runs are slow until its JIT has compiled the runner's own setup, several times
        // over what they settle to: pay for that at start, not on the first requests.
        for (int i = 0; i < 3; i++) {
            try {
                qjs(List.of("-e", "0"), "", 30, 32 * 1024 * 1024);
            } catch (SandboxException ignored) {
                // the budget is wide; a failure here shows on the first request instead
            }
        }
    }

    /** A run that ended without an outcome: a limit cut it off, or a program or rule module would not load. */
    static class SandboxException extends Exception {
        SandboxException(String message) {
            super(message);
        }
    }

    static String qjs(List<String> argv, String request, double seconds, int memory) throws SandboxException {
        // One run: the program mounted as /app, the request on stdin, the answer on stdout — all the run can
        // reach; Endive hands it nothing else. The limits are Endive's, at the browser's profile: the budget in
        // seconds — past it the run is interrupted, native or bytecode — and the memory in bytes. The budget
        // is this run's alone, a Future of its own cancelled at the timeout, so a run past it interrupts no
        // other: there is no engine-wide clock here, as there is under wasmtime (see main.py). Runaway
        // recursion exhausts the instance's own stack and traps, which ends the run too.
        var out = new ByteArrayOutputStream();
        var err = new ByteArrayOutputStream();
        var args = new ArrayList<>(List.of("qjs", "--std"));  // --std: the std module, which reads stdin
        args.addAll(argv);
        var options = WasiOptions.builder()
                .withArguments(args)
                .withDirectory("/app", APP)
                .withStdin(new ByteArrayInputStream(request.getBytes(StandardCharsets.UTF_8)))
                .withStdout(out)
                .withStderr(err)
                .build();
        var worker = Executors.newSingleThreadExecutor();
        try (var wasi = WasiPreview1.builder().withOptions(options).build()) {
            var imports = ImportValues.builder().addFunction(wasi.toHostFunctions()).build();
            var run = worker.submit(() -> {
                // Building the instance runs _start: qjs's main, through to its exit.
                try (var instance = Qjs.builder()
                        .withImportValues(imports)
                        .withMemoryLimits(new MemoryLimits(QJS_PAGES, memory / 65536))
                        .build()) {
                    return null;
                }
            });
            try {
                run.get((long) (seconds * 1000), TimeUnit.MILLISECONDS);
            } catch (TimeoutException budget) {
                run.cancel(true);  // the interrupt that ends the run
                throw new SandboxException("interrupt");
            }
        } catch (ExecutionException failed) {
            var cause = failed.getCause();
            if (cause instanceof WasiExitException exit) {  // a throw: qjs printed it to stderr and exited 1
                if (exit.exitCode() != 0) {
                    throw new SandboxException(err.toString(StandardCharsets.UTF_8).strip());
                }
            } else {  // a trap: "call stack exhausted", "out of bounds memory access"
                throw new SandboxException(cause.getMessage());
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new SandboxException("interrupted");
        } finally {
            worker.shutdownNow();
        }
        return out.toString(StandardCharsets.UTF_8).stripTrailing();
    }

    static String text(String file) {
        try {
            return Files.readString(Path.of(file));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // What one run evaluates: the program, the page's rules registered into it, then the call — the
    // context from stdin, the outcome to stdout. The program itself disables Date and Math.random.
    static final String RULES = text("rules/intake-rules.js");
    static final List<String> VALIDATE = List.of("-I", "/app/datum-sandbox-program.js", "-e", "__datum_register(" + RULES + "); print(__datum_run(std.in.readAsString()));");

    // What the rules read beside the values. The page injected a copy of its own; the server has the say.
    static final List<String> PHONE_COUNTRIES = List.of("CA", "US");

    // What the Country select shows, resolved here: the program never fetches a data source. An answer to a
    // choice whose source is missing from the optionSnapshot below is refused (option.sourceUnavailable).
    static final List<Map<String, String>> COUNTRIES = List.of(
            Map.of("value", "CA", "label", "Canada"), Map.of("value", "US", "label", "United States"), Map.of("value", "MX", "label", "Mexico"));

    // The run log comes back with the outcome — the sandbox has no console — and goes to this
    // process's logger: what the kernel did, step by step, and what the rules said, at LOG_LEVEL.
    static final String LOG_LEVEL = "debug";  // "off", "error", "warn" (the kernel's default), "info" or "debug"
    static final Map<String, Level> LEVELS = Map.of("debug", Level.DEBUG, "info", Level.INFO, "warn", Level.WARN, "error", Level.ERROR);
    static final Logger log = LoggerFactory.getLogger("datum.sandbox");

    public static void main(String[] args) {
        var app = new SpringApplication(Application.class);
        app.setDefaultProperties(Map.of("logging.level.datum", "debug"));  // so the forwarded entries reach the console
        app.run(args);
    }

    record FieldError(String field, String code) {}

    @PostMapping("/api/submissions")
    public ResponseEntity<?> submit(@RequestBody JsonNode body) {
        var key = body.path("submissionKey").asString(null);  // one per attempt: the same key again is the same submission
        if (key == null || key.isBlank()) {  // without it a retry could not be told from a new submission
            return ResponseEntity.status(400).body(Map.of("errors", List.of(new FieldError(null, "bad_document"))));
        }
        var submission = body.path("document").path("submission");
        var context = JSON.createObjectNode()
                .put("formId", FORM.path("id").asString())
                .set("form", FORM.path("root"))  // the schema: field constraints and sanitization come from it
                .set("values", submission.path("values"))
                .put("locale", submission.path("locale").asString("en"))
                .set("externalData", JSON.valueToTree(Map.of("phoneCountries", PHONE_COUNTRIES)))
                .set("optionSnapshot", JSON.valueToTree(Map.of("countries", COUNTRIES)))  // the lists a choice's data source holds, by source id
                .set("journey", journeyOf(submission))  // the path, worked out again from the values (see journeyOf)
                .put("logLevel", LOG_LEVEL);
        JsonNode outcome;
        try {
            outcome = JSON.readTree(qjs(VALIDATE, JSON.writeValueAsString(context), 5, 32 * 1024 * 1024));
        } catch (SandboxException failure) {  // a limit cut the run off, or a rule module would not load: fail closed, as the browser does
            log.error("sandbox failed for {}", FORM.path("id").asString(), failure);
            return ResponseEntity.status(503).body(Map.of("errors", List.of(new FieldError(null, "wasm.execution_error"))));
        }
        for (JsonNode entry : outcome.path("logs")) {
            log.atLevel(LEVELS.get(entry.path("level").asString())).log("{} {}", entry.path("message").asString(), entry.path("data"));
        }
        if (!outcome.path("errors").isEmpty()) {
            // 422 with the error contract, as the browser would have seen it; the page's messages word it.
            var errors = new ArrayList<FieldError>();
            for (JsonNode e : outcome.path("errors")) {
                errors.add(new FieldError(e.path("componentId").asString(null), e.path("code").asString()));
            }
            return ResponseEntity.status(422).body(Map.of("errors", errors));
        }
        store(key, outcome.path("values"));  // the sanitized values: what the form defines, nothing else
        return ResponseEntity.ok(Map.of("ok", true));
    }

    static void store(String key, JsonNode values) {
        // wherever submissions go: one record per key: the same key with the same values is that record again; the same key with other values is refused (409 submission.keyConflict)
    }
}
