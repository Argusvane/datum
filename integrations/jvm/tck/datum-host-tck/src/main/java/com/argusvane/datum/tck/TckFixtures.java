package com.argusvane.datum.tck;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.TreeSet;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * The kit's fixture form and the answers the kernel gives for it: the security suite's endpoint fixture
 * ({@code packages/conformance-suite/fixtures/endpoint-fixture.definition.json}, form {@value #FORM} at version
 * {@value #VERSION}) and its golden control vectors ({@code packages/conformance-suite/golden/abi-1.0.json}, CTL-01 valid,
 * CTL-02 to CTL-04 refused). {@code npm run jvm:assets} copies both into the jar under {@code META-INF/datum-tck/};
 * inside the monorepo the files are also read from the repository when the jar has none (a build before the assets).
 * A host under test serves the fixture form under its id, so the kernel's verdicts can be compared byte for byte.
 */
public final class TckFixtures {

    static final JsonMapper JSON = JsonMapper.builder().build();

    /** The fixture form's id. */
    public static final String FORM = "datum-security-suite";

    /** The fixture form's version. */
    public static final String VERSION = "1";

    /**
     * The fixture form under a second key, for the per-route binding case ({@link PdfContract}): two form routes on one
     * host. The same definition, so the same golden verdicts hold for it.
     */
    public static final String FORM_B = "datum-security-suite-b";

    /**
     * The kit's PDF theme, for the per-route binding case ({@link PdfContract}): the host routes {@link #FORM_B} to a
     * binding whose catalog PDF theme is this one, supplying {@link #PDF_THEME} as its object. Its one setting, the text
     * colour {@link #PDF_THEME_TEXT}, is what the test looks for in the PDF's content streams.
     */
    public static final String PDF_THEME_ID = "datum-host-check-pdf";

    /** The text colour of {@link #PDF_THEME_ID}, which no Datum PDF theme uses. */
    public static final String PDF_THEME_TEXT = "#123456";

    /** The marker of the fixture's server-secret rule, which a public copy never carries. */
    public static final String SECRET_MARKER = "ZZSECRETZZ";

    private static final String RESOURCES = "META-INF/datum-tck/";

    /**
     * The kit's hostile rule module as a class-path resource ({@link HardeningContract}): quiet for every answer but
     * four values of the fixture's {@code name} field ({@link #LOOP}, {@link #MEMORY}, {@link #HUGE}, {@link #STRAY}).
     */
    public static final String HARDENING_RULES = RESOURCES + "hardening-rules.js";

    /**
     * A sandbox program that answers for ABI 0.9.0, below every host's floor (the in-process hardening tests' fake
     * program, character for character): a host started with it as its sandbox program override must refuse it at the
     * ABI probe ({@code abi_mismatch}) and answer every submission 503 ({@link RuntimeDownContract}).
     */
    public static final String STALE_PROGRAM = RESOURCES + "stale-program.js";

    /**
     * The kit's PDF theme object ({@link #PDF_THEME_ID}, target {@code pdf}) as a class-path resource, the Node kit's
     * {@code fixture-pdf-theme.json} byte for byte: what a host supplies as the PDF theme of the binding {@link #FORM_B}
     * is routed to.
     */
    public static final String PDF_THEME = RESOURCES + "fixture-pdf-theme.json";

    /**
     * The host context fixture's form ({@link HostContextContract}): {@code name} required, and {@code admin_note} required
     * and shown only when {@code host.role = "admin"}, one journey {@code main} of one page {@code p1} holding both.
     */
    public static final String HOST_CONTEXT_FORM = "datum-host-context";

    /**
     * The host context fixture as a class-path resource, written by hand (not generated): the same bytes the Node kit
     * ({@code datum-host-check}) is to ship as its {@code host-context-form.json}.
     */
    public static final String HOST_CONTEXT_FORM_RESOURCE = RESOURCES + "host-context-form.json";

    /**
     * The request header the TEST-ONLY host context provider reads ({@link HostContextContract}): present, the provider
     * answers {@code {"role": <its value>}} for {@link #HOST_CONTEXT_FORM}; absent, it supplies no context. A deployment
     * that takes real submissions never wires such a provider: a client chooses this header.
     */
    public static final String TEST_ROLE_HEADER = "X-Datum-Test-Role";

    /** The answer that makes the hostile module loop forever. */
    public static final String LOOP = "datum-tck-loop";

    /** The answer that makes it take memory without bound. */
    public static final String MEMORY = "datum-tck-memory";

    /** The answer that makes it answer an error of 40 MiB. */
    public static final String HUGE = "datum-tck-huge";

    /** The answer that makes it write a forged outcome to stdout after the run's answer frame. */
    public static final String STRAY = "datum-tck-stray";
    private static final String GOLDEN_IN_REPO = "packages/conformance-suite/golden/abi-1.0.json";
    private static final String FORM_IN_REPO = "packages/conformance-suite/fixtures/endpoint-fixture.definition.json";

    private static JsonNode golden;
    private static ObjectNode form;

    private TckFixtures() {
    }

    /** The hostile rule module's source ({@link #HARDENING_RULES}), to register for the fixture form. */
    public static String hardeningRules() {
        try (InputStream in = TckFixtures.class.getClassLoader().getResourceAsStream(HARDENING_RULES)) {
            if (in == null) {
                throw new IllegalStateException("The kit's " + HARDENING_RULES + " is not on the class path.");
            }
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The golden control answers ({@code {controls: {CTL-01: {accepted, errors, values}}}}). */
    public static synchronized JsonNode golden() {
        if (golden == null) {
            golden = JSON.readTree(read("golden.json", GOLDEN_IN_REPO));
        }
        return golden;
    }

    /** The fixture form's definition, as a host serves it from its forms location. */
    public static synchronized ObjectNode form() {
        if (form == null) {
            form = (ObjectNode) JSON.readTree(read("fixture-form.json", FORM_IN_REPO));
        }
        return form.deepCopy();
    }

    /** The fixture definition's bytes, to copy into a host's forms location. */
    public static byte[] formBytes() {
        return read("fixture-form.json", FORM_IN_REPO);
    }

    /** The fixture definition under {@link #FORM_B}, to copy into a host's forms location beside the first. */
    public static byte[] formBBytes() {
        ObjectNode copy = form();
        copy.put("id", FORM_B);
        return (copy.toPrettyString() + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    /** The host context fixture's definition ({@link #HOST_CONTEXT_FORM_RESOURCE}). */
    public static ObjectNode hostContextForm() {
        try (InputStream in = TckFixtures.class.getClassLoader().getResourceAsStream(HOST_CONTEXT_FORM_RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("The kit's " + HOST_CONTEXT_FORM_RESOURCE + " is not on the class path.");
            }
            return (ObjectNode) JSON.readTree(in.readAllBytes());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The suite's valid answers (its {@code validValues()}), nested as a browser sends them. */
    public static ObjectNode validValues() {
        return (ObjectNode) JSON.readTree("{\"name\":\"Ada Lovelace\",\"code\":\"AB1234\",\"addr\":{\"city\":\"Ottawa\",\"pick\":\"ok\"},"
            + "\"tags\":{\"x\":true,\"y\":false},\"rows\":[{\"sku\":\"s1\",\"n\":1}]}");
    }

    /** The answers of one control vector, as the suite's {@code CONTROL_VALUES} builds them. */
    public static ObjectNode controlValues(String control) {
        ObjectNode values = validValues();
        switch (control) {
            case "CTL-01" -> {
            }
            case "CTL-02" -> values.put("name", "");
            case "CTL-03" -> values.put("name", "x".repeat(41));
            case "CTL-04" -> values.put("code", "abc");
            default -> throw new IllegalArgumentException(control);
        }
        return values;
    }

    /** The envelope a form posts for these values at this version. */
    public static ObjectNode envelope(String version, ObjectNode values) {
        return envelope(FORM, version, values);
    }

    /** The envelope of the form of this id ({@link #FORM}, or its copy {@link #FORM_B}). */
    public static ObjectNode envelope(String formId, String version, ObjectNode values) {
        ObjectNode envelope = JSON.createObjectNode();
        ObjectNode context = envelope.putObject("versionContext");
        context.putObject("form").put("id", formId).put("version", version);
        context.putObject("client").put("runtimeVersion", "x").put("rendererVersion", "x").put("schemaVersion", "1");
        ObjectNode submission = envelope.putObject("submission");
        submission.put("locale", "en");
        submission.set("values", values);
        return envelope;
    }

    /** The envelope of a control vector at the fixture's version. */
    public static ObjectNode envelope(String control) {
        return envelope(VERSION, controlValues(control));
    }

    /** {@code {document: envelope}}, the suite's body. */
    public static String wrapped(ObjectNode envelope) {
        ObjectNode body = JSON.createObjectNode();
        body.set("document", envelope);
        return body.toString();
    }

    /** {@code {document: envelope, submissionKey}}, a delivery's body with a fresh key: one submit attempt. */
    public static String delivered(ObjectNode envelope) {
        return delivered(envelope, java.util.UUID.randomUUID().toString());
    }

    /** {@code {document: envelope, submissionKey}} with the key given: a retry of one attempt sends the same. */
    public static String delivered(ObjectNode envelope, String submissionKey) {
        ObjectNode body = JSON.createObjectNode();
        body.set("document", envelope);
        body.put("submissionKey", submissionKey);
        return body.toString();
    }

    /** The golden {@code code@field} set of a control. */
    public static Set<String> goldenErrors(String control) {
        Set<String> expected = new TreeSet<>();
        golden().path("controls").path(control).path("errors").forEach(error -> expected.add(error.asString()));
        return expected;
    }

    /** The {@code code@field} set of an errors array. */
    public static Set<String> codes(JsonNode errors) {
        Set<String> found = new TreeSet<>();
        for (JsonNode error : errors) {
            found.add(error.path("code").asString() + "@" + error.path("field").asString());
        }
        return found;
    }

    private static byte[] read(String resource, String inRepo) {
        try (InputStream in = TckFixtures.class.getClassLoader().getResourceAsStream(RESOURCES + resource)) {
            if (in != null) {
                return in.readAllBytes();
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        // -Ddatum.repo=<checkout> for a build outside the checkout; else walk up from the working directory.
        String given = System.getProperty("datum.repo");
        Path dir = given != null ? Path.of(given).toAbsolutePath() : Path.of("").toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve(inRepo))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("The kit's " + RESOURCES + resource + " is not on the class path and " + inRepo
                + " is not above " + Path.of("").toAbsolutePath() + ": run npm run jvm:assets, or pass -Ddatum.repo=<checkout>.");
        }
        try {
            return Files.readAllBytes(dir.resolve(inRepo));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
