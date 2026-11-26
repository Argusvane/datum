package com.argusvane.datum.timestamp;

import java.util.List;

/**
 * The timestamp server's log, read (SPI): one record per token issued, newest first. Written through
 * {@link TsaSerialAllocator}; a store usually implements both, as {@link InMemoryTsaLog} does.
 */
public interface TsaLog {

    /** The latest tokens, newest first. */
    List<TsaLogRecord> recent(int limit);

    /** How many tokens were issued. */
    long count();
}
