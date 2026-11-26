package com.argusvane.datum.core;

/**
 * The publisher for a library used without an event bus: every event is dropped. Package-private:
 * {@link DatumEventPublisher#noop()} is the one spelling.
 */
final class NoopEventPublisher implements DatumEventPublisher {

    /** The one instance. */
    static final NoopEventPublisher INSTANCE = new NoopEventPublisher();

    private NoopEventPublisher() {
    }

    @Override
    public void publish(Object event) {
        // Nobody listens.
    }
}
