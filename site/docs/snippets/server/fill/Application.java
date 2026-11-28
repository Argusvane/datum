// Application.java — the endpoint the page delivers to: the submission validated, then written into an existing PDF form.
//   pom.xml beside it: Spring Boot, and Endive with its Maven plugin, which compiles the engine in.
//   curl -Lo src/main/resources/qjs-wasi.wasm https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   mvn spring-boot:run
//
// The PDF is one this server already has (templates/customer-intake.pdf): an AcroForm whose fields the
// form's template layout maps to the answers. datum-sandbox-program.js re-validates the envelope
// (see Validate on the server) and datum-pdf-program.js fills the PDF — the kernel behind the
// browser's PDF button, in a QuickJS of this process's own: QuickJS-ng's WebAssembly build, under
// Endive. Nothing about PDFs is written here.
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

    // The template layout, as the builder's PDF mode authored it: the PDF's fields and
    // what fills each — a component's answer, an option's label through template text, a literal.
    static final ObjectNode LAYOUT = layout("intake-template");

    static ObjectNode layout(String id) {
        for (JsonNode layout : FORM.path("pdf").path("layouts")) {
            if (id.equals(layout.path("id").asString())) {
                return (ObjectNode) layout;
            }
        }
        throw new IllegalStateException("the form has no layout " + id);
    }

    // The PDF itself, from this server's disk. The layout's template source names it (a storage this
    // server resolves, not bytes in the definition), and the bytes ride with each request, base64.
    static final String TEMPLATE = base64("templates/customer-intake.pdf");

    // Validation first, so the PDF is filled with the sanitized values: what the form defines, nothing else.
    static final List<String> VALIDATE = List.of("-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));");

    // The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
    static final List<String> RENDER = List.of("-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));");

    // The fonts the kernel draws the filled fields with when the standard 14 cannot show an answer.
    static Map<String, Object> font(String id, String family, int weight, String file) {
        return Map.of("id", id, "family", family, "weight", weight, "style", "normal", "data", base64("fonts/" + file));
    }

    static final List<Map<String, Object>> FONTS = List.of(font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf"));

    // What the Country select shows, resolved here: the layout's "{{country}}" writes the option's label.
    static final List<Map<String, String>> COUNTRIES = List.of(
            Map.of("value", "CA", "label", "Canada"), Map.of("value", "US", "label", "United States"), Map.of("value", "MX", "label", "Mexico"));

    // The instant as the program takes it, to the second: the same request gives the same bytes.
    static final DateTimeFormatter CREATED_AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'.000Z'").withZone(ZoneOffset.UTC);

    // What becomes of the filled fields. "editable" leaves them fields a reader may still change;
    // "readonly" locks each one the fill touched; "flatten" burns the values into the page and drops
    // the fields — an archive copy. The layout's own options are set here, per server.
    static final String FIELDS = "editable";

    static final Logger log = LoggerFactory.getLogger("datum.fill");

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    record FieldError(String field, String code) {}

    @PostMapping("/api/submissions/fill")
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
        // The template layout, inline, with this server's fill options: this server's choice, so no
        // layout's "when" is tried, and the bytes below are that layout's.
        var layout = LAYOUT.deepCopy();
        layout.set("options", JSON.valueToTree(Map.of("flatten", FIELDS.equals("flatten"), "readOnly", FIELDS.equals("readonly"), "appearances", "regenerate")));
        var response = render(JSON.createObjectNode()
                .put("abi", "1.0.0")
                .put("op", "document")
                .set("form", FORM.path("root"))
                .set("layout", layout)
                // The PDF to fill: the bytes the layout's source names, resolved by this server.
                .set("template", JSON.valueToTree(Map.of("data", TEMPLATE)))
                .set("values", outcome.path("values"))
                .put("locale", locale)  // the language template texts resolve in: the country's name, here
                .set("optionSnapshot", JSON.valueToTree(Map.of("country", COUNTRIES)))
                .set("fonts", JSON.valueToTree(FONTS))
                // The only time and identity the program ever sees: the same request gives the same bytes.
                .set("env", JSON.valueToTree(Map.of("createdAt", CREATED_AT.format(Instant.now()), "documentId", UUID.randomUUID().toString()))));
        if (!response.path("ok").asBoolean()) {  // {"code": "template" | "font" | "internal", "message": ...}
            return ResponseEntity.status(500).body(Map.of("error", response.path("error")));
        }
        // The fill report, one entry per mapped field: filled; cleared (no answer, or one a rule hid);
        // missing (the PDF has no field of that name); unsupported (a kind the kernel cannot fill).
        for (JsonNode field : response.path("fields")) {
            log.info("{} {} ({})", field.path("status").asString(), field.path("pdfField").asString(), field.path("kind").asString("-"));
        }
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"customer-intake-filled.pdf\"")
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
