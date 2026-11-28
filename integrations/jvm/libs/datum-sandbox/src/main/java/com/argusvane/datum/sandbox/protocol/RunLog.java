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

    /** A text that stays on one log line: {@link LogText#oneLine}. */
    static String oneLine(String text) {
        return LogText.oneLine(text);
    }
}
