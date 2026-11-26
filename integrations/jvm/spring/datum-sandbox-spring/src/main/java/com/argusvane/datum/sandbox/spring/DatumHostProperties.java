package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.sandbox.runtime.SandboxSettings;
import java.util.Locale;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code datum.host.*}: the sandbox-side host options, the keys the host sets on every validation context.
 * Element attributes (theme, features, locale) are the application's, not these.
 *
 * <p>The Spring binding of {@link SandboxSettings.Host}, which {@link #applyTo} sets on the settings builder. Every word is an enum, so a value
 * the program does not read stops the start with Spring's own binding failure naming the property; the zone stays
 * a string, read by {@link SandboxSettings.Host} (which names {@code datum.host.time-zone}), so an empty value is the JVM's zone as the library documents (framework-first). The enums bind relaxed, as any Boot enum:
 * {@code Reject}, {@code REJECT} and {@code reject} are one word.
 */
@ConfigurationProperties(prefix = "datum.host")
public class DatumHostProperties {

    /** What a formula that cannot be evaluated does. */
    public enum FormulaErrors {
        /** The default: the run fails. */
        FAIL,
        /** The formula's value is empty and the run goes on. */
        WARN
    }

    /** What a regular expression that repeats a repeat does. */
    public enum RiskyPatterns {
        /** The default: the pattern is refused. */
        REFUSE,
        /** The pattern runs. */
        ALLOW
    }

    /** What an answer the form has no component for does. */
    public enum UnknownFields {
        /** The default: the answer is dropped. */
        STRIP,
        /** The answer is kept. */
        KEEP,
        /** The submission is refused. */
        REJECT
    }

    /** How much of a run's log the program keeps. */
    public enum LogLevel {
        OFF,
        ERROR,
        WARN,
        INFO,
        DEBUG
    }

    /** What a formula that cannot be evaluated does: {@code fail} (the default) or {@code warn}. */
    private FormulaErrors formulaErrors = FormulaErrors.FAIL;

    /** A regular expression that repeats a repeat: {@code refuse} (the default) or {@code allow}. */
    private RiskyPatterns riskyPatterns = RiskyPatterns.REFUSE;

    /** The time zone {@code today()} and the clock-dependent rules read, a zone id such as America/Toronto; unset is the JVM's default. */
    private String timeZone;

    /** An answer the form has no component for: {@code strip} (the default), {@code keep} or {@code reject}. */
    private UnknownFields unknownFields = UnknownFields.STRIP;

    /** How much of a run's log the program keeps and the host relays: off, error, warn, info, debug. */
    private LogLevel logLevel = LogLevel.WARN;

    /** These properties set on the settings builder, which names a word it does not read. */
    public SandboxSettings.Builder applyTo(SandboxSettings.Builder settings) {
        return settings.formulaErrors(word(formulaErrors)).riskyPatterns(word(riskyPatterns)).timeZone(timeZone)
            .unknownFields(word(unknownFields)).logLevel(word(logLevel));
    }

    private static String word(Enum<?> value) {
        return value == null ? null : value.name().toLowerCase(Locale.ROOT);
    }

    public FormulaErrors getFormulaErrors() {
        return formulaErrors;
    }

    public void setFormulaErrors(FormulaErrors formulaErrors) {
        this.formulaErrors = formulaErrors;
    }

    public RiskyPatterns getRiskyPatterns() {
        return riskyPatterns;
    }

    public void setRiskyPatterns(RiskyPatterns riskyPatterns) {
        this.riskyPatterns = riskyPatterns;
    }

    public String getTimeZone() {
        return timeZone;
    }

    public void setTimeZone(String timeZone) {
        this.timeZone = timeZone;
    }

    public UnknownFields getUnknownFields() {
        return unknownFields;
    }

    public void setUnknownFields(UnknownFields unknownFields) {
        this.unknownFields = unknownFields;
    }

    public LogLevel getLogLevel() {
        return logLevel;
    }

    public void setLogLevel(LogLevel logLevel) {
        this.logLevel = logLevel;
    }
}
