package com.argusvane.datum.pdf;

import com.argusvane.datum.core.DatumConfigurationException;
import java.util.List;
import java.util.Locale;

/**
 * The host-wide seal ({@code datum.pdf.seal.*}): every PDF the service issues is
 * signed with the server's certificate, certified (DocMDP) and timestamped as set here (enabled, layouts,
 * certify, reason, location, visible, timestamp), set for the host because this host stores no form settings.
 *
 * <p>A layout's own {@code signature} block still wins key by key, and a layout that declares one is sealed
 * whenever the server can, preset or not (the author asked for that layout's seal).
 *
 * @param enabled whether issued PDFs are sealed
 * @param layouts the layout ids sealed; empty for all
 * @param certify the DocMDP permissions of the certification
 * @param timestamp whether to ask a timestamp server for a token (PAdES-B-T) when one is available
 * @param reason the signature's reason, or null (trimmed, at most 500 characters)
 * @param location the signature's location, or null (trimmed, at most 500 characters)
 * @param visible false for an invisible signature ({@code appearance: false}); null or true keeps the kernel's default
 */
public record SealPreset(boolean enabled, List<String> layouts, Certify certify, boolean timestamp, String reason, String location,
                         Boolean visible) {

    /** Sealing off. */
    public static final SealPreset OFF = new SealPreset(false, List.of(), Certify.NO_CHANGES, true, null, null, null);

    public SealPreset {
        layouts = layouts == null ? List.of() : List.copyOf(layouts);
        certify = certify == null ? Certify.NO_CHANGES : certify;
    }

    /** Sealing on, certified with no changes allowed, timestamped when a timestamp server is available. */
    public static SealPreset on() {
        return new SealPreset(true, List.of(), Certify.NO_CHANGES, true, null, null, null);
    }

    /** Whether a layout is sealed by the preset. */
    public boolean seals(String layoutId) {
        return enabled && (layouts.isEmpty() || layouts.contains(layoutId));
    }

    public SealPreset withCertify(Certify level) {
        return new SealPreset(enabled, layouts, level, timestamp, reason, location, visible);
    }

    public SealPreset withTimestamp(boolean on) {
        return new SealPreset(enabled, layouts, certify, on, reason, location, visible);
    }

    /**
     * A certification's DocMDP permissions (ISO 32000-1 section 12.8.2.2): P=1 no changes, P=2 form filling and
     * signing, P=3 those and annotations; or none (an approval signature).
     *
     * <p>Naming: the host's property words are {@code noChanges|formFill|annotate}; the kernel's
     * ({@code PdfSignatureCertify}) are {@code noChanges|formFilling|annotations}.
     * {@link #parse} accepts both spellings, and the request always carries the kernel's word ({@link #kernelWord()}).
     */
    public enum Certify {
        /** An approval signature: no DocMDP. */
        NONE(null, 0),
        /** P=1. */
        NO_CHANGES("noChanges", 1),
        /** P=2. */
        FORM_FILL("formFilling", 2),
        /** P=3. */
        ANNOTATE("annotations", 3);

        private final String kernelWord;
        private final int permissions;

        Certify(String kernelWord, int permissions) {
            this.kernelWord = kernelWord;
            this.permissions = permissions;
        }

        /** The kernel's {@code certify} word, or null for {@link #NONE} (the request then says {@code false}). */
        public String kernelWord() {
            return kernelWord;
        }

        /** The DocMDP {@code /P} value, 0 for none. */
        public int permissions() {
            return permissions;
        }

        /**
         * {@code noChanges}, {@code formFill} or {@code formFilling}, {@code annotate} or {@code annotations}, {@code none}
         * or {@code false}; case-insensitive, hyphens and underscores ignored.
         *
         * @throws IllegalArgumentException for any other word
         */
        public static Certify parse(String word) {
            String plain = word == null ? "" : word.trim().toLowerCase(Locale.ROOT).replace("-", "").replace("_", "");
            return switch (plain) {
                case "nochanges", "1" -> NO_CHANGES;
                case "formfill", "formfilling", "2" -> FORM_FILL;
                case "annotate", "annotations", "3" -> ANNOTATE;
                case "none", "false", "approval", "0" -> NONE;
                default -> throw new DatumConfigurationException("datum.pdf.seal.certify", "datum.pdf.seal.certify is noChanges, formFill, annotate or none, not \"" + word + "\".");
            };
        }
    }
}
