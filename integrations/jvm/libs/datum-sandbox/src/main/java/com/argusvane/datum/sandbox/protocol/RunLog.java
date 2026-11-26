package com.argusvane.datum.sandbox.protocol;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * Where a run's log goes: the outcome's {@code logs}, entry by entry, after the run.
 *
 * <p>The default writes each entry to the SLF4J logger {@code datum.sandbox} at the entry's level. The text is
 * the guest's (rule modules call {@code context.log}), capped by the kernel at 200 entries of 8 KiB each (ABI
 * 2.12), so every control character in it is escaped ({@link #oneLine}): one entry is one log line, cannot
 * forge another, and cannot move a terminal's cursor.
 */
@FunctionalInterface
public interface RunLog {

    /** The logger the default writes to. */
    String LOGGER = "datum.sandbox";

    /**
     * One entry.
     *
     * @param formId the context's {@code formId}, or null
     * @param level "debug", "info", "warn" or "error" as the kernel wrote it (anything else is logged at info)
     * @param message the entry's message, may be empty
     * @param data the entry's plain data, or null
     */
    void entry(@Nullable String formId, @Nullable String level, String message, @Nullable JsonNode data);

    /** The SLF4J forwarder. */
    static RunLog slf4j() {
        Logger log = LoggerFactory.getLogger(LOGGER);
        return (formId, level, message, data) -> {
            String text = "[" + oneLine(formId == null ? "-" : formId) + "] " + oneLine(message == null ? "" : message)
                + (data == null || data.isNull() || data.isMissingNode() ? "" : " " + oneLine(StrictJson.mapper().writeValueAsString(data)));
            org.slf4j.event.Level at = switch (level == null ? "" : level) {
                case "debug" -> org.slf4j.event.Level.DEBUG;
                case "warn" -> org.slf4j.event.Level.WARN;
                case "error" -> org.slf4j.event.Level.ERROR;
                default -> org.slf4j.event.Level.INFO;
            };
            // The form id is a field too: under a structured log format an operator filters guest lines by form. The
            // message keeps the [formId] prefix and the oneLine escaping, so pattern logs read the same.
            log.atLevel(at).addKeyValue("formId", oneLine(formId == null ? "-" : formId)).log("{}", text);
        };
    }

    /**
     * A text that stays on one log line: the backslash doubled, CR and LF as {@code \\r} and {@code \\n}, and
     * every other control character as a backslash-u escape. That is each C0 and C1 control (ESC starts an
     * ANSI sequence that rewrites a terminal line; NEL U+0085, VT and FF break lines for some log shippers;
     * NUL ends a C string) and the line and paragraph separators U+2028 and U+2029.
     */
    static String oneLine(String text) {
        StringBuilder out = null;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            String escaped = switch (c) {
                case '\\' -> "\\\\";
                case '\r' -> "\\r";
                case '\n' -> "\\n";
                default -> Character.isISOControl(c) || c == '\u2028' || c == '\u2029' ? String.format("\\u%04x", (int) c) : null;
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
}
