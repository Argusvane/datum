package com.argusvane.datum.core;

import java.util.Objects;

/**
 * A setting that cannot work, refused when the host starts. It says which
 * setting is wrong, what is wrong with it and what to do, as three separate statements, so a host can print them as
 * they are: Spring Boot's {@code FailureAnalyzer} prints "Description" and "Action" from them instead of a nested stack
 * trace, and another host may log or show them its own way. It carries no framework type.
 *
 * <p>An {@link IllegalArgumentException}, so a caller that catches that catches this, and
 * {@link #getMessage()} is the problem in full (it names the setting), so a log line or a
 * test that reads the message gets the whole problem. The problem and the action never carry a secret: they name a
 * setting and the rule it broke, not the value of a key, a password or a token.
 */
public class DatumConfigurationException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    private final String property;
    private final String action;

    /**
     * @param property the setting at fault, in the dotted form of a configuration property ({@code datum.web.api.max-body-size}),
     *     or null when no single setting is
     * @param problem  what is wrong with it, a sentence that names the setting and the rule it broke
     * @param action   what to do about it, a sentence (or two) naming the fix; null for the general advice
     */
    public DatumConfigurationException(String property, String problem, String action) {
        this(property, problem, action, null);
    }

    /** A refusal with the general advice: correct the setting and start again. */
    public DatumConfigurationException(String property, String problem) {
        this(property, problem, (String) null, null);
    }

    /** A refusal with the general advice, and the failure that caused it (a key store that cannot be opened, a time zone id). */
    public DatumConfigurationException(String property, String problem, Throwable cause) {
        this(property, problem, null, cause);
    }

    public DatumConfigurationException(String property, String problem, String action, Throwable cause) {
        super(Objects.requireNonNull(problem, "problem"), cause);
        this.property = property;
        this.action = action;
    }

    /** The setting at fault, or null. */
    public String property() {
        return property;
    }

    /** What is wrong, as {@link #getMessage()} says it. */
    public String problem() {
        return getMessage();
    }

    /** What to do about it: the stated action, or the general advice (correct the setting) when none was given. */
    public String action() {
        if (action != null) {
            return action;
        }
        return property == null ? "Correct the configuration named above, then start again."
            : "Correct " + property + " in your configuration, then start again.";
    }
}
