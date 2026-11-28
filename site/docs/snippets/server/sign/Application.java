// Application.java — the endpoint the page delivers to: the submission validated, rendered as a PDF, and signed.
//   pom.xml beside it: Spring Boot, and Endive with its Maven plugin, which compiles the engine in.
//   curl -Lo src/main/resources/qjs-wasi.wasm https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   mvn spring-boot:run
//
//   the signing key, a self-signed certificate to try with (production uses the organisation's):
//   mkdir -p keys
//   openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -subj "/CN=Intake service/O=Datum" \
//       -keyout keys/signer.key.pem -out keys/signer.cert.pem
// The PDF is signed the way ISO 32000 and PAdES ask — a signature field, /ByteRange, a CMS
// SignedData — by datum-pdf-program.js, the kernel behind the browser's PDF button, in a QuickJS of
// this process's own. The kernel never sees the key: it prepares the bytes to sign, this process
// signs them with java.security, the kernel embeds the value. Any viewer validates the result;
// the verify endpoint below is how this server tells its own sealed records apart.
package datum;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
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
    static final List<String> VALIDATE = List.of("-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));");

    // The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
    static final List<String> RENDER = List.of("-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));");

    // The fonts to embed: the signature's appearance is drawn with the first of them.
    static Map<String, Object> font(String id, String family, int weight, String file) {
        return Map.of("id", id, "family", family, "weight", weight, "style", "normal", "data", base64("fonts/" + file));
    }

    static final List<Map<String, Object>> FONTS = List.of(font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf"));

    // What the Country select shows, resolved here: the program never fetches a data source.
    static final List<Map<String, String>> COUNTRIES = List.of(
            Map.of("value", "CA", "label", "Canada"), Map.of("value", "US", "label", "United States"), Map.of("value", "MX", "label", "Mexico"));

    // The instant as the program takes it, to the second: the same request gives the same bytes.
    static final DateTimeFormatter CREATED_AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'.000Z'").withZone(ZoneOffset.UTC);

    // The server's key and certificate chain. The key stays in this process; the chain rides with the
    // request (DER, base64, the signer's certificate first) and ends up in the PDF for any viewer to check.
    static final PrivateKey KEY = privateKey("keys/signer.key.pem");
    static final List<X509Certificate> CHAIN = certificates("keys/signer.cert.pem");
    static final List<String> CERTIFICATES = CHAIN.stream().map(Application::encoded).toList();

    // The layout says how the record is sealed — which signature block, certified or not, the reason —
    // and the request may override any of it. Null keeps the layout's say (certify, no changes).
    static final Object CERTIFY = null;

    // A timestamp authority (RFC 3161), for a signature that proves when it was made by a third party's
    // clock (PAdES-B-T). Empty: none. With a URL, the kernel builds the request, this process posts it,
    // and the token goes into the signature; give the layout "timestamp": true so the placeholder has room.
    static final String TSA_URL = "";

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    record FieldError(String field, String code) {}

    @PostMapping("/api/submissions/sign")
    public ResponseEntity<?> submit(@RequestBody JsonNode envelope) throws Exception {
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
        // The record, rendered and prepared for signing in one call: the layout's signature settings
        // plus these certificates. The answer's "bytes" carry the placeholder; "signing" says what to sign.
        var signature = new LinkedHashMap<String, Object>();
        signature.put("certificates", CERTIFICATES);
        if (CERTIFY != null) {
            signature.put("certify", CERTIFY);
        }
        var prepared = render(JSON.createObjectNode()
                .put("abi", "1.0.0")
                .put("op", "document")
                .set("form", FORM.path("root"))
                .set("pdf", FORM.path("pdf"))  // the sealed layout, as designed in the builder's PDF mode
                .set("values", outcome.path("values"))
                .put("locale", locale)
                .set("optionSnapshot", JSON.valueToTree(Map.of("country", COUNTRIES)))
                .set("fonts", JSON.valueToTree(FONTS))
                .set("signature", JSON.valueToTree(signature))
                // The only time and identity the program ever sees; the signature's /M is this instant.
                .set("env", JSON.valueToTree(Map.of("createdAt", CREATED_AT.format(Instant.now()), "documentId", UUID.randomUUID().toString()))));
        if (!prepared.path("ok").asBoolean()) {  // {"code": "signature" | "font" | "layout" | "internal", "message": ...}
            return ResponseEntity.status(500).body(Map.of("error", prepared.path("error")));
        }
        var handoff = prepared.path("signing");
        var value = signBytes(Base64.getDecoder().decode(handoff.path("toBeSigned").asString()));
        var signing = JSON.createObjectNode()
                .set("certificates", JSON.valueToTree(CERTIFICATES))
                .put("value", Base64.getEncoder().encodeToString(value))
                .put("toBeSignedDigest", handoff.path("toBeSignedDigest").asString());
        if (!TSA_URL.isEmpty()) {
            signing.set("timestamp", JSON.valueToTree(Map.of("token", timestamp(value))));
        }
        var completed = render(JSON.createObjectNode()
                .put("abi", "1.0.0")
                .put("op", "complete")
                .set("pdf", JSON.valueToTree(Map.of("data", prepared.path("bytes").asString())))
                .set("signing", signing));
        if (!completed.path("ok").asBoolean()) {
            return ResponseEntity.status(500).body(Map.of("error", completed.path("error")));
        }
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"customer-intake-signed.pdf\"")
                .header("X-Page-Count", String.valueOf(prepared.path("pageCount").asInt()))
                .header("X-Signed-By", CHAIN.get(0).getSubjectX500Principal().getName())
                .header("X-Signature-Field", completed.path("field").asString())
                .header("X-Timestamped", String.valueOf(completed.path("timestamped").asBoolean()))
                .body(Base64.getDecoder().decode(completed.path("bytes").asString()));
    }

    // A signed PDF back for a verdict: which signatures it carries, whether each still matches the
    // bytes, whether the value checks out under the signer's key, and whether the signer is this server.
    @PostMapping(value = "/api/submissions/verify", consumes = MediaType.APPLICATION_PDF_VALUE)
    public ResponseEntity<?> verify(@RequestBody byte[] pdf) throws Exception {
        var report = render(JSON.createObjectNode()
                .put("abi", "1.0.0")
                .put("op", "verify")
                .set("pdf", JSON.valueToTree(Map.of("data", Base64.getEncoder().encodeToString(pdf)))));
        if (!report.path("ok").asBoolean()) {
            return ResponseEntity.status(400).body(Map.of("error", report.path("error")));
        }
        var verdicts = new ArrayList<Map<String, Object>>();
        for (JsonNode sig : report.path("signatures")) {
            var signer = sig.path("signer");
            var known = !signer.isNull() && !signer.isMissingNode();
            var decoder = Base64.getDecoder();
            var valid = known && verifyBytes(decoder.decode(signer.path("publicKey").asString()), decoder.decode(sig.path("toBeVerified").asString()), decoder.decode(sig.path("signature").asString()));
            var verdict = new LinkedHashMap<String, Object>();
            verdict.put("field", sig.path("field").asString());
            verdict.put("signer", known ? signer.path("subject").asString() : null);
            verdict.put("signingTime", sig.path("signingTime").asString(null));
            verdict.put("digestMatches", sig.path("digestMatches").asBoolean());  // the file still hashes to what was signed
            verdict.put("certificateMatches", sig.path("certificateMatches").asBoolean());  // the signed attributes name this certificate
            verdict.put("signatureValid", valid);  // the value checks out under the signer's public key
            verdict.put("coversDocument", sig.path("coversDocument").asBoolean());  // nothing was appended after this signature
            verdict.put("trusted", known && CERTIFICATES.get(0).equals(signer.path("certificate").asString()));  // the signer is this server
            verdict.put("certification", sig.path("certification"));
            verdict.put("timestamp", sig.path("timestamp"));
            verdicts.add(verdict);
        }
        // The files the signature sealed, by digest: what a record's JSON must hash to.
        return ResponseEntity.ok(Map.of("signatures", verdicts, "attachments", report.path("attachments")));
    }

    // The one cryptographic step this server keeps for itself: the DER attributes the kernel prepared,
    // signed with the key. An HSM or a cloud KMS signs the same bytes (or "toBeSignedDigest", their SHA-256).
    static byte[] signBytes(byte[] data) throws Exception {
        var signature = Signature.getInstance(KEY.getAlgorithm().equals("EC") ? "SHA256withECDSA" : "SHA256withRSA");
        signature.initSign(KEY);
        signature.update(data);
        return signature.sign();
    }

    static boolean verifyBytes(byte[] spki, byte[] data, byte[] value) throws Exception {
        PublicKey key;
        try {
            key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(spki));
        } catch (Exception notRsa) {
            key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
        }
        var signature = Signature.getInstance(key.getAlgorithm().equals("EC") ? "SHA256withECDSA" : "SHA256withRSA");
        signature.initVerify(key);
        signature.update(data);
        return signature.verify(value);
    }

    static String timestamp(byte[] value) throws Exception {
        var tsq = render(JSON.createObjectNode().put("abi", "1.0.0").put("op", "timestampRequest").put("signature", Base64.getEncoder().encodeToString(value)));
        var request = HttpRequest.newBuilder(URI.create(TSA_URL))
                .header("Content-Type", "application/timestamp-query")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Base64.getDecoder().decode(tsq.path("request").asString())))
                .build();
        var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofByteArray());
        return Base64.getEncoder().encodeToString(response.body());
    }

    static PrivateKey privateKey(String file) {
        var pem = text(file).replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        var spec = new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem));
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(spec);
        } catch (Exception notRsa) {
            try {
                return KeyFactory.getInstance("EC").generatePrivate(spec);
            } catch (Exception e) {
                throw new IllegalStateException("the signing key is neither RSA nor EC", e);
            }
        }
    }

    static List<X509Certificate> certificates(String file) {
        try {
            var factory = CertificateFactory.getInstance("X.509");
            return factory.generateCertificates(new ByteArrayInputStream(Files.readAllBytes(Path.of(file)))).stream().map(X509Certificate.class::cast).toList();
        } catch (Exception e) {
            throw new IllegalStateException("the certificate chain could not be read", e);
        }
    }

    static String encoded(X509Certificate certificate) {
        try {
            return Base64.getEncoder().encodeToString(certificate.getEncoded());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
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
