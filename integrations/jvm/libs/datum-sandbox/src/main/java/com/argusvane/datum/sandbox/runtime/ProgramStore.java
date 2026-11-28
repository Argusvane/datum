package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.io.ResourceHandle;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.RunScript;
import com.argusvane.datum.sandbox.protocol.SandboxAbi;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;

/**
 * Where the two programs come from: datum-programs' {@code META-INF/datum/programs/} (described by its
 * {@code programs.json}: ABIs and sha256s), or a {@code datum.runtime.programs.*} resource override.
 *
 * <p>Every packaged file read here is held to two sha256s, or the start is refused: the one datum-programs'
 * {@code programs.json} lists for it, and the one this datum-sandbox was built with ({@link #PINS}, a copy of the same
 * generation's {@code programs.json} that the build puts in datum-sandbox's own jar, as datum-sandbox-endive's build
 * holds {@code qjs-wasi.wasm} to {@code qjs.sha256}). A packaged file that {@code programs.json} does not list, a
 * missing {@code programs.json} and a datum-sandbox without its pins are refused too, never passed unchecked: the jar
 * is damaged, it is not one this build made, or two releases are mixed on the classpath. The pins are what makes the
 * check more than the jar describing itself: a datum-programs jar rewritten with a new {@code programs.json} to match
 * still fails them.
 *
 * <p>The freeze snippet, which every sandbox run evaluates ({@link RunScript}), is always packaged and always checked,
 * override or not, because it is generated from the same TypeScript as the kernel's globals. An override is read as it
 * is (its hash is computed, and it is listed nowhere by design) and is still proved by the ABI probe before any run.
 * Nothing here trusts the ABI strings beyond reporting them: the probe asks the program itself.
 *
 * <p>A missing PDF program is not an error here: the PDF path is then unavailable (typed 503 in datum-pdf),
 * and submissions are unaffected.
 *
 * <p>Framework-free: an override is a {@link ResourceHandle} (the Spring binding wraps its
 * {@code Resource}), and {@link #verify} is the packaged files' check against {@code programs.json} and the pins as one
 * library call, made at start here (a Quarkus binding would make it at build).
 */
public final class ProgramStore {

    /** Where datum-programs puts the programs. */
    public static final String BASE = "META-INF/datum/programs/";

    /** The description datum-programs ships beside them. */
    public static final String MANIFEST = BASE + "programs.json";

    /**
     * The sha256s this datum-sandbox was built with: the build copies the {@code programs.json} that {@code npm run jvm:assets}
     * generated for datum-programs into datum-sandbox's jar under this name, so the two jars of one build agree and a
     * datum-programs from another build, or one whose files and description were changed together, does not.
     */
    public static final String PINS = "META-INF/datum/sandbox/programs.json";

    /** The freeze snippet every sandbox run evaluates, always packaged. */
    private static final String FREEZE = "freeze-intrinsics.js";

    /** What one load found. */
    public record Programs(Program sandbox, String freezeSnippet, String sandboxAbi, String sandboxSource,
                           Program pdf, String pdfAbi, String pdfSource, String pdfUnavailable) {

        /** Whether the PDF program is there. */
        public boolean hasPdf() {
            return pdf != null;
        }
    }

    /**
     * What {@link #verify} found: the ABIs {@code programs.json} names and the sha256 of each file it checked.
     *
     * @param sandboxAbi the sandbox program's ABI, or null when the description names none
     * @param pdfAbi     the PDF program's ABI, or null
     * @param checked    file name to sha256 for every file that was given: each one listed and pinned
     */
    public record Verified(String sandboxAbi, String pdfAbi, Map<String, String> checked) {

        public Verified {
            checked = Map.copyOf(checked);
        }
    }

    private final Function<String, InputStream> classpath;
    private final ResourceHandle sandboxOverride;
    private final ResourceHandle pdfOverride;

    /**
     * @param loader the class loader the packaged programs are read from
     * @param sandboxOverride {@code datum.runtime.programs.sandbox}, or null
     * @param pdfOverride {@code datum.runtime.programs.pdf}, or null
     */
    public ProgramStore(ClassLoader loader, ResourceHandle sandboxOverride, ResourceHandle pdfOverride) {
        this(name -> Objects.requireNonNull(loader, "loader").getResourceAsStream(name), sandboxOverride, pdfOverride);
    }

    /** A store over any lookup of classpath names (tests). */
    public ProgramStore(Function<String, InputStream> classpath, ResourceHandle sandboxOverride, ResourceHandle pdfOverride) {
        this.classpath = Objects.requireNonNull(classpath, "classpath");
        this.sandboxOverride = sandboxOverride;
        this.pdfOverride = pdfOverride;
    }

    /**
     * Reads both programs afresh (overrides included).
     *
     * @throws ProgramUnavailableException when the sandbox program or the freeze snippet is missing, or a
     *     packaged file is not listed in {@code programs.json} or does not have its sha256 there and in the pins
     */
    public Programs load() {
        byte[] manifestBytes = classpathBytes(MANIFEST);
        byte[] pinBytes = classpathBytes(PINS);

        // Presence first, in the order the operator fixes them: the freeze snippet (always packaged), then the
        // packaged sandbox program when there is no override. Then every packaged file read here goes through
        // verify() in one call, the same library check a Quarkus binding would make at build (integrations/jvm/README.md
        // "Libraries and bindings"), so the start and a build could not drift apart. An override is not listed in
        // programs.json and is never given to verify(); the ABI probe proves it before any run.
        byte[] freeze = classpathBytes(BASE + FREEZE);
        if (freeze == null) {
            throw new ProgramUnavailableException("The freeze snippet (" + BASE + FREEZE + ") is not on the classpath: add "
                + "datum-programs (the submissions starter brings it) or rebuild the program assets (npm run jvm:assets).");
        }
        byte[] sandboxPackaged = sandboxOverride != null ? null : classpathBytes(BASE + Program.Kind.SANDBOX.fileName());
        if (sandboxOverride == null && sandboxPackaged == null) {
            throw new ProgramUnavailableException("The sandbox program (" + BASE + Program.Kind.SANDBOX.fileName()
                + ") is not on the classpath: add datum-programs or set datum.runtime.programs.sandbox.");
        }
        byte[] pdfPackaged = pdfOverride != null ? null : classpathBytes(BASE + Program.Kind.PDF.fileName());

        Map<String, byte[]> packaged = new LinkedHashMap<>();
        packaged.put(FREEZE, freeze);
        if (sandboxPackaged != null) {
            packaged.put(Program.Kind.SANDBOX.fileName(), sandboxPackaged);
        }
        if (pdfPackaged != null) {
            packaged.put(Program.Kind.PDF.fileName(), pdfPackaged);
        }
        Verified verified = verify(packaged, manifestBytes, pinBytes);

        Program sandbox;
        String sandboxAbi;
        String sandboxSource;
        if (sandboxOverride != null) {
            sandbox = Program.of(Program.Kind.SANDBOX, resourceBytes(sandboxOverride, "datum.runtime.programs.sandbox"));
            sandboxAbi = SandboxAbi.MIN;
            sandboxSource = sandboxOverride.description();
        } else {
            sandbox = Program.of(Program.Kind.SANDBOX, sandboxPackaged);
            sandboxAbi = verified.sandboxAbi() != null ? verified.sandboxAbi() : SandboxAbi.MIN;
            sandboxSource = "classpath:" + BASE + Program.Kind.SANDBOX.fileName();
        }

        Program pdf = null;
        String pdfAbi = null;
        String pdfSource = null;
        String pdfUnavailable = null;
        if (pdfOverride != null) {
            pdf = Program.of(Program.Kind.PDF, resourceBytes(pdfOverride, "datum.runtime.programs.pdf"));
            pdfAbi = PdfAbi.MIN;
            pdfSource = pdfOverride.description();
        } else if (pdfPackaged == null) {
            pdfUnavailable = "The PDF program (" + BASE + Program.Kind.PDF.fileName() + ") is not on the classpath.";
        } else {
            pdf = Program.of(Program.Kind.PDF, pdfPackaged);
            pdfAbi = verified.pdfAbi() != null ? verified.pdfAbi() : PdfAbi.MIN;
            pdfSource = "classpath:" + BASE + Program.Kind.PDF.fileName();
        }
        return new Programs(sandbox, new String(freeze, StandardCharsets.UTF_8), sandboxAbi, sandboxSource, pdf, pdfAbi, pdfSource,
            pdfUnavailable);
    }

    /**
     * {@link #verify(Map, byte[], byte[])} against the pins this datum-sandbox carries ({@link #PINS}, read from its own
     * class loader): the check a build-time binding makes.
     */
    public static Verified verify(Map<String, byte[]> programs, byte[] programsJson) {
        byte[] pins;
        try (InputStream in = ProgramStore.class.getClassLoader().getResourceAsStream(PINS)) {
            pins = in == null ? null : in.readAllBytes();
        } catch (IOException e) {
            throw new ProgramUnavailableException(PINS + " could not be read from datum-sandbox.", e);
        }
        return verify(programs, programsJson, pins);
    }

    /**
     * Checks packaged program files against {@code programs.json} and the pins, without a class loader: each given file
     * must be listed in the description with its sha256, and have the sha256 the pins give it (the freeze snippet first,
     * then the sandbox and PDF programs, then the rest by name). Listed files not given are not checked; that a program
     * is there at all is {@link #load}'s question.
     *
     * @param programs     file name ({@code datum-sandbox-program.js}) to bytes, as under {@link #BASE}
     * @param programsJson the bytes of {@link #MANIFEST}; null (there is none) is refused
     * @param pins         the bytes of {@link #PINS}; null (this datum-sandbox carries none) is refused
     * @throws ProgramUnavailableException when the description or the pins are missing or not JSON, or a file is not
     *     listed, or does not have its sha256
     */
    public static Verified verify(Map<String, byte[]> programs, byte[] programsJson, byte[] pins) {
        if (programsJson == null) {
            throw new ProgramUnavailableException(MANIFEST + " is not on the classpath, so the packaged programs cannot be"
                + " checked: the datum-programs jar is damaged or was not built by Datum's build (npm run jvm:assets).");
        }
        if (pins == null) {
            throw new ProgramUnavailableException(PINS + " is not in datum-sandbox, so the packaged programs cannot be checked:"
                + " datum-sandbox was built without the program assets (npm run jvm:assets, then the reactor build).");
        }
        JsonNode manifest = manifest(programsJson, MANIFEST + " is not JSON: the datum-programs jar is damaged.");
        JsonNode files = manifest.path("files");
        JsonNode pinned = manifest(pins, PINS + " is not JSON: the datum-sandbox jar is damaged.").path("files");
        Map<String, byte[]> ordered = new LinkedHashMap<>();
        for (String first : new String[] {FREEZE, Program.Kind.SANDBOX.fileName(), Program.Kind.PDF.fileName()}) {
            if (programs.containsKey(first)) {
                ordered.put(first, programs.get(first));
            }
        }
        new java.util.TreeMap<>(programs).forEach(ordered::putIfAbsent);
        Map<String, String> checked = new LinkedHashMap<>();
        ordered.forEach((name, bytes) -> {
            String expected = expectedSha(files, name);
            if (expected == null) {
                throw new ProgramUnavailableException(BASE + name + " is not listed in " + MANIFEST
                    + ", so it cannot be checked: the datum-programs jar is damaged or was not built by Datum's build.");
            }
            String actual = Program.of(Program.Kind.SANDBOX, bytes).sha256();
            if (!expected.equalsIgnoreCase(actual)) {
                throw mismatch(name);
            }
            String pin = expectedSha(pinned, name);
            if (pin == null || !pin.equalsIgnoreCase(actual)) {
                throw new ProgramUnavailableException(BASE + name + " does not have the sha256 this datum-sandbox was built"
                    + " with (" + PINS + "): datum-programs and datum-sandbox come from different builds or releases, or the"
                    + " datum-programs jar was changed. Use the datum-programs of the same release (the BOM pins it).");
            }
            checked.put(name, actual);
        });
        return new Verified(text(manifest, "sandboxAbi", null), text(manifest, "pdfAbi", null), checked);
    }

    private static JsonNode manifest(byte[] bytes, String notJson) {
        try {
            return StrictJson.decode(bytes);
        } catch (StrictJson.NotJsonException e) {
            throw new ProgramUnavailableException(notJson);
        }
    }

    private static ProgramUnavailableException mismatch(String name) {
        return new ProgramUnavailableException(BASE + name + " does not have the sha256 " + MANIFEST
            + " gives it: the datum-programs jar is damaged, or two of its releases are on the classpath.");
    }

    private static String expectedSha(JsonNode files, String name) {
        if (files == null || !files.isObject()) {
            return null;
        }
        JsonNode sha = files.get(name);
        return sha != null && sha.isString() ? sha.stringValue() : null;
    }

    private static String text(JsonNode manifest, String key, String fallback) {
        if (manifest == null) {
            return fallback;
        }
        JsonNode value = manifest.get(key);
        return value != null && value.isString() ? value.stringValue() : fallback;
    }

    private byte[] classpathBytes(String name) {
        try (InputStream in = classpath.apply(name)) {
            return in == null ? null : in.readAllBytes();
        } catch (IOException e) {
            throw new ProgramUnavailableException(name + " could not be read from the classpath.", e);
        }
    }

    private static byte[] resourceBytes(ResourceHandle resource, String property) {
        if (!resource.exists()) {
            throw new ProgramUnavailableException(property + " names " + resource.description() + ", which does not exist.");
        }
        try (InputStream in = resource.open()) {
            return in.readAllBytes();
        } catch (IOException e) {
            throw new ProgramUnavailableException(property + " (" + resource.description() + ") could not be read.", e);
        }
    }
}
