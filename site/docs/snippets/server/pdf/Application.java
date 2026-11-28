// Application.java — the endpoint the page delivers to: the submission validated, then rendered as a PDF.
//   pom.xml beside it: Spring Boot, and Endive with its Maven plugin, which compiles the engine in.
//   curl -Lo src/main/resources/qjs-wasi.wasm https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   mvn spring-boot:run
//
// Two programs from beside the bundles, each run in a QuickJS of this process's own — QuickJS-ng's
// WebAssembly build, under Endive. datum-sandbox-program.js re-validates the envelope (see
// Validate on the server), and datum-pdf-program.js is the PDF kernel behind the browser's PDF
// button: the form's PDF layout laid out over the answers, the fonts embedded, the bytes written.
// The same program on any host, so the server's PDF is the browser's, byte for byte.
package datum;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.google.common.jimfs.Configuration;
import com.google.common.jimfs.Jimfs;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
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
import tools.jackson.databind.node.ObjectNode;

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

    // What a run can reach: one in-memory directory holding the two programs, and nothing else — not this
    // directory, not the disk. Endive mounts any java.nio path, and Jimfs makes one.
    static final Path APP = programs();

    static Path programs() {
        try {
            var app = Files.createDirectories(Jimfs.newFileSystem(Configuration.unix()).getPath("/app"));
            for (var name : List.of("datum-sandbox-program.js", "datum-pdf-program.js")) {
                Files.copy(Path.of(name), app.resolve(name));
            }
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
        // One run: the programs mounted as /app, the request on stdin, the answer on stdout — all the run can
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

    // Validation first, so the PDF prints the sanitized values: what the form defines, nothing else.
    // Rules of the page's own register into this program too (see Validate on the server).
    static final List<String> VALIDATE = List.of("-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));");

    // The PDF program, under the document profile: a PDF takes seconds and real memory. __datum_pdf
    // answers with a promise; qjs runs the pending jobs once the script has run (the program's only
    // timers are microtasks), so the answer is printed before it exits.
    static final List<String> RENDER = List.of("-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));");

    // The fonts to embed, read from beside the bundles: the program has no file system. DejaVu Sans
    // covers Latin, Greek, Cyrillic, Arabic and Hebrew; with no fonts, the standard 14 stand in.
    static Map<String, Object> font(String id, String family, int weight, String file) {
        return Map.of("id", id, "family", family, "weight", weight, "style", "normal", "data", base64("fonts/" + file));
    }

    static final List<Map<String, Object>> FONTS = List.of(font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf"));

    // What the Country select shows, resolved here: the program never fetches a data source.
    static final List<Map<String, String>> COUNTRIES = List.of(
            Map.of("value", "CA", "label", "Canada"), Map.of("value", "US", "label", "United States"), Map.of("value", "MX", "label", "Mexico"));

    // The instant as the program takes it, to the second: the same request gives the same bytes.
    static final DateTimeFormatter CREATED_AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'.000Z'").withZone(ZoneOffset.UTC);

    static final String LOCALE = null;  // null renders in the submission's language; "en" or "fr-CA" picks one
    static final boolean COMPACT = false;  // object streams and a compressed cross-reference: smaller, slower to write

    // Which of the form's PDF layouts prints. A form designed in the builder's PDF mode may
    // carry several under FORM's "pdf" block — an applicant copy, an internal summary, a government
    // template to fill — each with an id. Name one here, e.g. "applicant-copy", and the request asks
    // for it by id ("layoutId" below), whatever the answers. null leaves the choice to the form: the
    // first layout, in its list's order, whose "when" holds on these validated values — the layout
    // the person's own download printed — else its "defaultLayoutId", the one marked default in the
    // builder, else the first layout declared; a form with no layouts at all gets one derived from
    // its tree, as this sample does. The response names the layout that printed ("layoutId"). An id the form lacks derives one too, with a "layout.notFound" warning in the response.
    // A template layout whose PDF this server keeps needs its bytes in the request, and the answers
    // may choose another template than the default: ask the "build" op first and send its "layoutId"
    // back with that layout's bytes. One submission, several PDFs: render once per id. A request may
    // instead carry a whole layout object under "layout" — one kept outside the form — which then
    // prints whatever the form declares, and whatever the answers.
    static final String LAYOUT_ID = null;

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    record FieldError(String field, String code) {}

    @PostMapping("/api/submissions/pdf")
    public ResponseEntity<?> submit(@RequestBody JsonNode envelope) throws SandboxException {
        var submission = envelope.path("submission");
        var locale = submission.path("locale").asString("en");
        var context = JSON.createObjectNode()
                .put("formId", FORM.path("id").asString())
                .set("form", FORM.path("root"))
                .set("values", submission.path("values"))
                .put("locale", locale)
                .set("optionSnapshot", JSON.valueToTree(Map.of("countries", COUNTRIES)))  // the lists a choice's data source holds, by source id
                .set("journey", journeyOf(submission));  // the path, worked out again from the values (see journeyOf)
        var outcome = JSON.readTree(qjs(VALIDATE, JSON.writeValueAsString(context), 5, 32 * 1024 * 1024));
        if (!outcome.path("errors").isEmpty()) {  // 422 with codes and fields, never text; the page's messages word them
            var errors = new ArrayList<FieldError>();
            for (JsonNode e : outcome.path("errors")) {
                errors.add(new FieldError(e.path("componentId").asString(null), e.path("code").asString()));
            }
            return ResponseEntity.status(422).body(Map.of("errors", errors));
        }
        var request = JSON.createObjectNode()
                .put("abi", "1.0.0")
                .put("op", "document")
                .set("form", FORM.path("root"))
                .set("pdf", FORM.get("pdf"))  // the form's PDF layouts, as designed in the builder's PDF mode
                .set("values", outcome.path("values"))
                .put("locale", LOCALE != null ? LOCALE : locale)
                .set("optionSnapshot", JSON.valueToTree(Map.of("country", COUNTRIES)))
                .set("fonts", JSON.valueToTree(FONTS))
                .set("options", JSON.valueToTree(Map.of("compact", COMPACT)))
                // The only time and identity the program ever sees: the same request gives the same bytes.
                .set("env", JSON.valueToTree(Map.of("createdAt", CREATED_AT.format(Instant.now()), "documentId", UUID.randomUUID().toString())));
        if (LAYOUT_ID != null) {  // a specific layout by id, whatever the answers; left out, the answers choose (see LAYOUT_ID)
            request.put("layoutId", LAYOUT_ID);
        }
        var response = render(request);
        if (!response.path("ok").asBoolean()) {  // {"code": "font" | "layout" | "template" | "internal", "message": ...}
            return ResponseEntity.status(500).body(Map.of("error", response.path("error")));
        }
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"customer-intake.pdf\"")
                .header("X-Page-Count", String.valueOf(response.path("pageCount").asInt()))
                .body(Base64.getDecoder().decode(response.path("bytes").asString()));
    }

    static JsonNode render(ObjectNode request) throws SandboxException {
        return JSON.readTree(qjs(RENDER, JSON.writeValueAsString(request), 15, 256 * 1024 * 1024));
    }

    static String base64(String file) {
        try {
            return Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(file)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
