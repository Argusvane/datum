package com.argusvane.datum.core.observation;

/**
 * One unit of Datum's work being observed: started by
 * {@link DatumObservations#start}, with its scope open on the starting thread, so the work it encloses (a guest run, an
 * outbound call, a nested Datum observation) is its child in a trace. Closing it ends the scope and stops it, on the
 * thread that started it.
 *
 * <p>The keys a caller sets are the ones in {@link DatumObservationNames}: low-cardinality values only from a small fixed
 * set (an op, an outcome, a channel word), a form key only as a high-cardinality value, and never answers, bytes or
 * digests. Every method answers quietly when the observation is off, so a caller writes one path for both.
 */
public interface DatumObservation extends AutoCloseable {

    /** Sets a low-cardinality key (a metric tag and a span tag); a later value for the key replaces it. */
    DatumObservation lowCardinality(String key, String value);

    /** Sets a high-cardinality key (a span tag only, never a metric tag). */
    DatumObservation highCardinality(String key, String value);

    /** Records what the work failed with; the caller rethrows it. */
    DatumObservation error(Throwable failure);

    /** Ends the scope and stops the observation; a second call does nothing. */
    @Override
    void close();
}
