package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.DatumConfigurationException;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the host tells the program about how to run formulas and patterns: the host-decided keys of a validation
 * context.
 *
 * <ul>
 *   <li>{@code formulaErrors}: {@code warn} or {@code fail}, default {@code fail}: a formula that cannot be evaluated is never judged as if it passed.</li>
 *   <li>{@code riskyPatterns}: {@code refuse} (default) or {@code allow}, for a regular expression that
 *       repeats a repeat.</li>
 *   <li>{@code today}: the host's date in its time zone ({@code datum.host.time-zone}), {@code YYYY-MM-DD}, for
 *       the clock functions. A zone id that does not exist is refused, as {@code datum.host.time-zone} is.</li>
 * </ul>
 * The element attributes and features a page is drawn with are the web layer's, not the sandbox's.
 */
public final class HostOptions {

    /** The formula policies a program reads. */
    public static final List<String> FORMULA_ERRORS = List.of("warn", "fail");

    /** The regular expression policies a program reads. */
    public static final List<String> RISKY_PATTERNS = List.of("refuse", "allow");

    /**
     * What a formula that cannot be evaluated does: the typed form of the policy words. {@link #wire()} is the
     * lower-case word the program reads and a configuration file carries.
     */
    public enum FormulaErrors {
        WARN("warn"), FAIL("fail");

        private final String wire;

        FormulaErrors(String wire) {
            this.wire = wire;
        }

        /** The word the program reads. */
        public String wire() {
            return wire;
        }

        /**
         * The policy a word names; null is the default {@link #FAIL}.
         *
         * @throws DatumConfigurationException for any other word (it was the default before; a typo is not a policy)
         */
        public static FormulaErrors of(@Nullable String word) {
            if (word == null) {
                return FAIL;
            }
            return switch (word) {
                case "warn" -> WARN;
                case "fail" -> FAIL;
                default -> throw unknown("datum.host.formula-errors", word, FORMULA_ERRORS);
            };
        }
    }

    /** What a regular expression that repeats a repeat does: the typed form of the pattern policy words. */
    public enum RiskyPatterns {
        REFUSE("refuse"), ALLOW("allow");

        private final String wire;

        RiskyPatterns(String wire) {
            this.wire = wire;
        }

        /** The word the program reads. */
        public String wire() {
            return wire;
        }

        /**
         * The policy a word names; null is the default {@link #REFUSE}.
         *
         * @throws DatumConfigurationException for any other word
         */
        public static RiskyPatterns of(@Nullable String word) {
            if (word == null) {
                return REFUSE;
            }
            return switch (word) {
                case "refuse" -> REFUSE;
                case "allow" -> ALLOW;
                default -> throw unknown("datum.host.risky-patterns", word, RISKY_PATTERNS);
            };
        }
    }

    private final String formulaErrors;
    private final String riskyPatterns;
    private final ZoneId zone;
    private final Clock clock;

    /**
     * Options from raw settings: an unset value (null) is the default, and a word the program does not read stops the
     * caller, so an application's own {@code HostOptions} bean with a
     * typo never runs with a policy it did not choose. Prefer the typed constructor.
     *
     * @param formulaErrors the formula policy as set ({@code warn}, {@code fail}), or null
     * @param riskyPatterns the pattern policy as set ({@code refuse}, {@code allow}), or null
     * @param timeZone the host's time zone id as set, or null for the JVM's default
     * @param clock the clock {@code today} reads
     * @throws DatumConfigurationException when a policy word is not one the program reads
     * @throws IllegalArgumentException when {@code timeZone} is not a time zone id
     */
    public HostOptions(@Nullable String formulaErrors, @Nullable String riskyPatterns, @Nullable String timeZone, Clock clock) {
        this(FormulaErrors.of(formulaErrors), RiskyPatterns.of(riskyPatterns), timeZone, clock, null);
    }

    /** Options from typed policies; null is the default of each. (A factory, not a constructor, so literal nulls stay unambiguous.) */
    public static HostOptions of(@Nullable FormulaErrors formulaErrors, @Nullable RiskyPatterns riskyPatterns, @Nullable String timeZone, Clock clock) {
        return new HostOptions(formulaErrors == null ? FormulaErrors.FAIL : formulaErrors,
            riskyPatterns == null ? RiskyPatterns.REFUSE : riskyPatterns, timeZone, clock, null);
    }

    /** The one place the fields are set; the trailing parameter only tells it apart from the String constructor. */
    private HostOptions(FormulaErrors formulaErrors, RiskyPatterns riskyPatterns, @Nullable String timeZone, Clock clock, @Nullable Void typed) {
        this.formulaErrors = formulaErrors.wire();
        this.riskyPatterns = riskyPatterns.wire();
        this.zone = zoneOf(timeZone);
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    private static DatumConfigurationException unknown(String property, String word, List<String> allowed) {
        return new DatumConfigurationException(property, property + " is '" + word + "', which is not one of " + allowed + ".",
            "Set " + property + " to one of " + allowed + ", or leave it unset for the default.");
    }

    /** The defaults: fail, refuse, the JVM's time zone, the system clock. */
    public static HostOptions defaults() {
        return new HostOptions(null, null, null, Clock.systemUTC());
    }

    /** The formula error policy: warn or fail. */
    public String formulaErrors() {
        return formulaErrors;
    }

    /** Whether a regular expression that repeats a repeat is refused or allowed. */
    public String riskyPatterns() {
        return riskyPatterns;
    }

    /** The time zone {@link #today()} is read in. */
    public ZoneId zone() {
        return zone;
    }

    /** Today's date in the host's time zone, as {@code YYYY-MM-DD}. */
    public String today() {
        return LocalDate.ofInstant(clock.instant(), zone).toString();
    }

    /**
     * The context keys the host decides.
     *
     * @return {@code today}, {@code formulaErrors}, {@code riskyPatterns}, in that order
     */
    public Map<String, String> contextKeys() {
        Map<String, String> keys = new LinkedHashMap<>();
        keys.put("today", today());
        keys.put("formulaErrors", formulaErrors);
        keys.put("riskyPatterns", riskyPatterns);
        return keys;
    }

    /**
     * Sets the keys on a validation context, over anything already there: the host decides them, never the
     * body, so a submitter cannot relax the formula or pattern policy by sending its own keys.
     */
    public void mergeInto(ObjectNode context) {
        contextKeys().forEach(context::put);
    }

    /**
     * Adds the keys a PDF request has not set, keeping a caller's {@code today} (the day a submission was judged, so a
     * document printed later shows the formulas as they were then).
     */
    public void addMissing(ObjectNode request) {
        contextKeys().forEach((key, value) -> {
            if (!request.has(key) || request.get(key).isNull()) {
                request.put(key, value);
            }
        });
    }

    /**
     * The policy an inspect request carries (the inspect op reads {@code warn} or {@code fail}): "warn" for warn,
     * "fail" for anything else, the stricter reading.
     */
    public static String policy(@Nullable String value) {
        return "warn".equals(value) ? "warn" : "fail";
    }

    private static ZoneId zoneOf(@Nullable String name) {
        if (name == null || name.isBlank()) {
            return ZoneId.systemDefault();
        }
        try {
            return ZoneId.of(name);
        } catch (DateTimeException e) {
            throw new IllegalArgumentException("'" + name + "' is not a time zone id.", e);
        }
    }
}
