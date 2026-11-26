package com.argusvane.datum.timestamp;

import java.time.Instant;
import java.util.Objects;

/**
 * A token the timestamp server issued, as its log holds it: the serial it was given and when, with its entry.
 *
 * @param serial the token's serial number
 * @param created when the serial was taken
 * @param entry what the log keeps of the token
 */
public record TsaLogRecord(long serial, Instant created, TsaLogEntry entry) {

    public TsaLogRecord {
        Objects.requireNonNull(created, "created");
        Objects.requireNonNull(entry, "entry");
    }
}
