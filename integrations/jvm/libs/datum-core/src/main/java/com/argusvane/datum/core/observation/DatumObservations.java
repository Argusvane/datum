package com.argusvane.datum.core.observation;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.hooks.HookRefusedException;
import java.util.Locale;

/**
 * Where the libraries report the units of work an operator wants in a trace:
 * a guest run of either program, a submission, a PDF operation and a token the in-process timestamp authority issues,
 * under the names {@link DatumObservationNames} documents.
 *
 * <p>Micrometer's Observation API is what reports them ({@link MicrometerObservations}, over an {@code ObservationRegistry}),
 * and it stays an optional dependency of the libraries: this interface and {@link #none()} name no Micrometer type, so a
 * library that observes compiles and runs with {@code micrometer-observation} absent, and only a host that has an
 * {@code ObservationRegistry} builds the Micrometer one. A host binding without a registry hands {@link #none()}, which
 * changes nothing: no observation, no meter, no wrapper (the libraries skip their observing decorators when
 * {@link #enabled()} is false).
 *
 * <p>The observations are not Datum's metrics: the {@code datum.runs*}, {@code datum.submissions} and
 * {@code datum.throttled} meters stay as they are, and the observation names are distinct from them, so a meter
 * registry that turns observations into timers ({@code <name>} and {@code <name>.active}) never meets a name it already
 * holds.
 */
public interface DatumObservations {

    /**
     * Starts an observation with its scope open on this thread.
     *
     * @param name one of {@link DatumObservationNames}' names
     * @param contextualName the span's name
     * @param lowCardinality key, value, key, value...: the low-cardinality keys known at the start, so every meter made
     *     from the observation (the long task timer at the start, the timer at the stop) carries the same keys
     */
    DatumObservation start(String name, String contextualName, String... lowCardinality);

    /** Whether anything is observed: false for {@link #none()}, so a caller can leave its observing wrapper out. */
    default boolean enabled() {
        return true;
    }

    /** Observes nothing (no registry): every observation is a no-op and {@link #enabled()} is false. */
    static DatumObservations none() {
        return NoObservations.INSTANCE;
    }

    /**
     * The {@code outcome} word for a failure: a sandbox refusal's reason ({@code busy}, {@code budget}, {@code refused},
     * ...), {@code unavailable}, {@code too_deep}, a hook's refusal kind ({@code forbidden}, {@code conflict},
     * {@code invalid}), {@code refused} for another of Datum's typed refusals, {@code error} for anything else. A fixed
     * set, so the key stays low-cardinality whatever the failure's message says.
     */
    static String outcomeOf(Throwable failure) {
        if (failure instanceof ProgramUnavailableException) {
            return "unavailable";
        }
        if (failure instanceof DefinitionTooDeepException) {
            return "too_deep";
        }
        if (failure instanceof HookRefusedException e) {
            return e.kind().name().toLowerCase(Locale.ROOT);
        }
        if (failure instanceof DatumException e) {
            String outcome = e.observationOutcome();
            return outcome == null ? "refused" : outcome;
        }
        return "error";
    }
}
