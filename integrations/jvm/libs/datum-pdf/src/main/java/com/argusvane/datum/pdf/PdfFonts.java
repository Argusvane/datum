package com.argusvane.datum.pdf;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The DejaVu fonts a PDF request carries, base64, read once from datum-programs ({@code META-INF/datum/programs/fonts/}):
 * the PDF program has no file system, so every request that draws text brings its fonts.
 *
 * <p>Three packs. {@link Pack#DEFAULT} is DejaVu Sans and Sans Bold (the default theme's body and headings,
 * about 1.9 MB of base64 per request). {@link Pack#STANDARD} is five faces: sans, bold, oblique, mono and mono bold.
 * {@link Pack#ALL} is all seven faces in the order of the kernel's font loader, which the ABI 3.8 parity hashes were
 * taken with ({@code PdfRenderIT}). The default sends two (the bytes of every request), so italic and
 * monospace text in the default pack falls back to the standard fonts (Western European text only) unless the caller
 * asks for {@code STANDARD} or {@code ALL}. Each entry carries its script coverage (the font entry's
 * {@code coverage}; it does not change the bytes of a Latin document: the documents-3.8 hashes are the same with and
 * without it, checked against the program).
 *
 * <p>A face the jar lacks is left out with a WARN, never a failed request: the program then falls back to the
 * standard fonts.
 */
public final class PdfFonts {

    private static final Logger LOG = LoggerFactory.getLogger(PdfFonts.class);

    /** Where datum-programs puts the fonts. */
    public static final String BASE = "META-INF/datum/programs/fonts/";

    /** Which faces a request carries. */
    public enum Pack {
        /** DejaVu Sans and Sans Bold. */
        DEFAULT,
        /** Five: sans, bold, oblique, mono, mono bold. */
        STANDARD,
        /** All seven, in the font loader's order (the parity order). */
        ALL;

        /** {@code default}, {@code standard} or {@code all}, case-insensitive; null for anything else. */
        public static Pack parse(String word) {
            if (word == null) {
                return null;
            }
            return switch (word.trim().toLowerCase(java.util.Locale.ROOT)) {
                case "default" -> DEFAULT;
                case "standard" -> STANDARD;
                case "all" -> ALL;
                default -> null;
            };
        }
    }

    /** One face: the resource's id, family, weight, style, file and script coverage. */
    record Face(String id, String family, int weight, String style, String file, List<String> coverage) {
    }

    /** The scripts DejaVu Sans covers. */
    private static final List<String> WIDE = List.of("Latn", "Grek", "Cyrl", "Arab", "Hebr");

    /** The scripts its oblique, serif and mono faces cover. */
    private static final List<String> NARROW = List.of("Latn", "Grek", "Cyrl");

    static final Face SANS = new Face("dejavu-sans", "sans-serif", 400, "normal", "DejaVuSans.ttf", WIDE);
    static final Face SANS_BOLD = new Face("dejavu-sans-bold", "sans-serif", 700, "normal", "DejaVuSans-Bold.ttf", WIDE);
    static final Face SANS_OBLIQUE = new Face("dejavu-sans-oblique", "sans-serif", 400, "italic", "DejaVuSans-Oblique.ttf", NARROW);
    static final Face SERIF = new Face("dejavu-serif", "serif", 400, "normal", "DejaVuSerif.ttf", NARROW);
    static final Face SERIF_BOLD = new Face("dejavu-serif-bold", "serif", 700, "normal", "DejaVuSerif-Bold.ttf", NARROW);
    static final Face MONO = new Face("dejavu-mono", "monospace", 400, "normal", "DejaVuSansMono.ttf", NARROW);
    static final Face MONO_BOLD = new Face("dejavu-mono-bold", "monospace", 700, "normal", "DejaVuSansMono-Bold.ttf", NARROW);

    /** The faces of each pack, in the order the request lists them. */
    static List<Face> faces(Pack pack) {
        return switch (pack) {
            case DEFAULT -> List.of(SANS, SANS_BOLD);
            case STANDARD -> List.of(SANS, SANS_BOLD, SANS_OBLIQUE, MONO, MONO_BOLD);
            case ALL -> List.of(SANS, SANS_BOLD, SANS_OBLIQUE, SERIF, SERIF_BOLD, MONO, MONO_BOLD);
        };
    }

    private final Map<String, String> data = new LinkedHashMap<>();
    private final List<String> missing = new ArrayList<>();

    /**
     * Reads every face through a lookup of resource names.
     *
     * @param resources a resource name to its stream, or null when absent
     */
    public PdfFonts(Function<String, InputStream> resources) {
        Objects.requireNonNull(resources, "resources");
        for (Face face : faces(Pack.ALL)) {
            try (InputStream in = resources.apply(BASE + face.file())) {
                if (in == null) {
                    missing.add(face.file());
                    continue;
                }
                data.put(face.file(), Base64.getEncoder().encodeToString(in.readAllBytes()));
            } catch (IOException e) {
                missing.add(face.file());
            }
        }
        if (!missing.isEmpty()) {
            LOG.warn("Datum PDF: datum-programs lacks the font file(s) {}; text in those faces falls back to the standard PDF fonts "
                + "(Western European only). Rebuild the program assets (npm run jvm:assets).", missing);
        }
    }

    /** The fonts datum-programs ships, read through this class loader. */
    public static PdfFonts fromClasspath(ClassLoader loader) {
        ClassLoader from = loader != null ? loader : PdfFonts.class.getClassLoader();
        return new PdfFonts(from::getResourceAsStream);
    }

    /** The font files of the full set that were not found. */
    public List<String> missing() {
        return List.copyOf(missing);
    }

    /** A fresh array of {@code PdfFontResource} entries for a pack (a fresh copy: customizers may change it). */
    public ArrayNode pack(Pack pack) {
        ArrayNode fonts = JsonNodeFactory.instance.arrayNode();
        for (Face face : faces(Objects.requireNonNull(pack, "pack"))) {
            String base64 = data.get(face.file());
            if (base64 == null) {
                continue;
            }
            ObjectNode entry = fonts.addObject();
            entry.put("id", face.id());
            entry.put("family", face.family());
            entry.put("weight", face.weight());
            entry.put("style", face.style());
            ArrayNode coverage = entry.putArray("coverage");
            face.coverage().forEach(coverage::add);
            entry.put("data", base64);
        }
        return fonts;
    }
}
