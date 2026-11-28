package com.argusvane.datum.sandbox.protocol;

/**
 * Words a run wrote (its stderr, a program's message, a rule module's log entry) made fit for a host log line. They can
 * quote a submitted value or a posted file, so they are escaped before any logger sees them: one text is one log line,
 * cannot forge another and cannot move a terminal's cursor.
 */
public final class LogText {

    /** The most characters of a run's words a summary keeps: enough for an error's first line, not for a submission's values. */
    public static final int SUMMARY_CHARS = 200;

    private LogText() {
    }

    /**
     * A text that stays on one log line: the backslash doubled, CR and LF as {@code \\r} and {@code \\n}, and
     * every other control character as a backslash-u escape. That is each C0 and C1 control (ESC starts an
     * ANSI sequence that rewrites a terminal line; NEL U+0085, VT and FF break lines for some log shippers;
     * NUL ends a C string) and the line and paragraph separators U+2028 and U+2029.
     */
    public static String oneLine(String text) {
        StringBuilder out = null;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            String escaped = switch (c) {
                case '\\' -> "\\\\";
                case '\r' -> "\\r";
                case '\n' -> "\\n";
                default -> Character.isISOControl(c) || c == ' ' || c == ' ' ? String.format("\\u%04x", (int) c) : null;
            };
            if (escaped != null && out == null) {
                out = new StringBuilder(text.length() + 16).append(text, 0, i);
            }
            if (out != null) {
                if (escaped != null) {
                    out.append(escaped);
                } else {
                    out.append(c);
                }
            }
        }
        return out == null ? text : out.toString();
    }

    /**
     * The first {@link #SUMMARY_CHARS} characters of a text on one line ({@link #oneLine}), followed, when there was more,
     * by how many characters were left out. The cut is made before the escaping, so no escape is split, and never between
     * the two halves of a surrogate pair.
     */
    public static String summary(String text) {
        if (text.length() <= SUMMARY_CHARS) {
            return oneLine(text);
        }
        int cut = SUMMARY_CHARS;
        if (Character.isHighSurrogate(text.charAt(cut - 1)) && Character.isLowSurrogate(text.charAt(cut))) {
            cut--;
        }
        return oneLine(text.substring(0, cut)) + " ... (" + (text.length() - cut) + " more characters)";
    }
}
