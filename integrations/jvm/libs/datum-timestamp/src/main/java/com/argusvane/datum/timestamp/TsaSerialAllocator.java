package com.argusvane.datum.timestamp;

/**
 * Takes the serial number of a token about to be signed (SPI): a database store takes the log row's id as the
 * serial.
 *
 * <p>The row is written before the token is signed, so a serial is never handed out twice, even when signing
 * fails after it was taken; serials are unique and increasing for as long as the store lives. A failure here is a
 * systemFailure refusal ("The timestamp server cannot issue tokens now."), its reason logged. Implementations:
 * {@link InMemoryTsaLog} (tests and a single process; serials seeded from the clock), the Spring host's JDBC allocator.
 */
@FunctionalInterface
public interface TsaSerialAllocator {

    /**
     * Records the token and returns its serial number: positive, never returned before.
     *
     * @throws RuntimeException when no serial can be taken
     */
    long allocate(TsaLogEntry entry);
}
