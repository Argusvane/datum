package com.argusvane.datum.timestamp.web;

/**
 * The timestamp endpoint's request counter (SPI): how many events an identifier made in a window. The Spring
 * binding supplies an in-memory counter as a development default (per process); behind several nodes an
 * application supplies a shared one (a database or Redis counter) as a bean of this type.
 */
public interface TsaFlood {

    /**
     * The prefix of the failed-key events ({@code datum.tsa_key_failed}): an implementation keeps them apart from the
     * rest, so traffic that fills the open counters cannot reset a lockout.
     */
    String KEY_EVENT = "datum.tsa_key";

    /** The prefix of the per-client events. */
    String CLIENT_EVENT = "datum.tsa_client";

    /** The event of the open (per-address) count. */
    String OPEN_EVENT = "datum.tsa";

    /** Whether {@code identifier} made fewer than {@code limit} events of this kind in the last {@code windowSeconds}. */
    boolean isAllowed(String event, int limit, long windowSeconds, String identifier);

    /** Counts one event for {@code identifier}, kept for {@code windowSeconds}. */
    void register(String event, long windowSeconds, String identifier);

    /**
     * Counts one event if the limit has room: the check and the count as one step, so a burst cannot all pass
     * the check before any is counted. Implementations that can should override it atomically.
     *
     * @return false when the limit was already reached (nothing was counted)
     */
    default boolean acquire(String event, int limit, long windowSeconds, String identifier) {
        if (!isAllowed(event, limit, windowSeconds, identifier)) {
            return false;
        }
        register(event, windowSeconds, identifier);
        return true;
    }
}
