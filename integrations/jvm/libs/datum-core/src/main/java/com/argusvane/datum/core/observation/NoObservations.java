package com.argusvane.datum.core.observation;

/** {@link DatumObservations#none()}: one shared observation that records nothing. */
final class NoObservations implements DatumObservations, DatumObservation {

    static final NoObservations INSTANCE = new NoObservations();

    private NoObservations() {
    }

    @Override
    public DatumObservation start(String name, String contextualName, String... lowCardinality) {
        return this;
    }

    @Override
    public boolean enabled() {
        return false;
    }

    @Override
    public DatumObservation lowCardinality(String key, String value) {
        return this;
    }

    @Override
    public DatumObservation highCardinality(String key, String value) {
        return this;
    }

    @Override
    public DatumObservation error(Throwable failure) {
        return this;
    }

    @Override
    public void close() {
    }

    @Override
    public String toString() {
        return "DatumObservations.none()";
    }
}
