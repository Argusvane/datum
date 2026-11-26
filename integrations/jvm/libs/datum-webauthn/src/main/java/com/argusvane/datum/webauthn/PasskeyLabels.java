package com.argusvane.datum.webauthn;

import org.jspecify.annotations.Nullable;

/**
 * Passkey names as given: one line, trimmed, clipped to 128
 * characters.
 */
public final class PasskeyLabels {

    /** The longest passkey name, in characters (code points). */
    public static final int LABEL_CHARACTERS = 128;

    private PasskeyLabels() {
    }

    /** The name cleaned; null when nothing is left. */
    public static @Nullable String clean(@Nullable String label) {
        if (label == null) {
            return null;
        }
        StringBuilder out = new StringBuilder();
        boolean inRun = false;
        for (int i = 0; i < label.length(); i++) {
            char c = label.charAt(i);
            // mb_scrub: what is not well-formed text becomes '?'.
            if (Character.isHighSurrogate(c) && i + 1 < label.length() && Character.isLowSurrogate(label.charAt(i + 1))) {
                out.append(c).append(label.charAt(++i));
                inRun = false;
                continue;
            }
            if (Character.isSurrogate(c)) {
                out.append('?');
                inRun = false;
                continue;
            }
            // A run of control characters is one space.
            if (c < 0x20 || c == 0x7f) {
                if (!inRun) {
                    out.append(' ');
                }
                inRun = true;
                continue;
            }
            inRun = false;
            out.append(c);
        }
        // String.trim() cuts every character up to U+0020 at either end; the control-character fold above has
        // already turned those into spaces, so it matches what the wire expects (strip() would also cut Unicode spaces).
        String trimmed = out.toString().trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        int end = trimmed.offsetByCodePoints(0, Math.min(LABEL_CHARACTERS, trimmed.codePointCount(0, trimmed.length())));
        return trimmed.substring(0, end);
    }
}
