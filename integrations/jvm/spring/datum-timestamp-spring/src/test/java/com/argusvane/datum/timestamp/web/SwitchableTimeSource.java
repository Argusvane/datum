package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.timestamp.TsaTimeSource;
import java.util.concurrent.atomic.AtomicReference;

/** A {@link TsaTimeSource} bean a test flips between available and unavailable. */
public class SwitchableTimeSource implements TsaTimeSource {

    private final AtomicReference<Reading> reading = new AtomicReference<>();

    @Override
    public Reading read() {
        Reading now = reading.get();
        return now != null ? now : Reading.available(java.time.Instant.now());
    }

    void unavailable(String reason) {
        reading.set(Reading.unavailable(reason));
    }

    void available() {
        reading.set(null);
    }
}
