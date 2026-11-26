package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.timestamp.TsaCertificateRules;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyException;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.TsaTimeSource;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The {@code datum-tsa} health check: UP when the server has a key, its certificate is within its validity and
 * its extended key usage is a timestamp server's ({@link TsaCertificateRules}, the rules the authority holds the
 * key to on every token); DOWN names the reason, never the key. The detail says where serials come from
 * ({@code serialAllocator}: {@code memory}, {@code jdbc} or {@code custom}), which a host that keeps its tokens
 * should read, and {@code serials} says it plainly: {@code jdbc}, or {@code memory (acknowledged)} for a host that set
 * {@code datum.tsa.allow-memory-stores=true} (without it the in-memory allocator is refused at start). The detail
 * {@code time} is {@code available} or {@code unavailable (reason)} from the {@link TsaTimeSource}; while it is
 * unavailable the check is DOWN, because the server refuses every request with {@code timeNotAvailable}.
 */
public final class TsaHealth {

    /** The name under which the check is registered. */
    public static final String NAME = "datum-tsa";

    private final TsaKeyMaterial keys;
    private final TsaTimeSource time;
    private final String serialAllocator;
    private final String access;

    public TsaHealth(TsaKeyMaterial keys, Clock clock, String serialAllocator, String access) {
        this(keys, TsaTimeSource.of(clock), serialAllocator, access);
    }

    public TsaHealth(TsaKeyMaterial keys, TsaTimeSource time, String serialAllocator, String access) {
        this.keys = keys;
        this.time = time;
        this.serialAllocator = serialAllocator;
        this.access = access;
    }

    /** The check's state now. */
    public DatumHealthContributors.Status status() {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("serialAllocator", serialAllocator);
        details.put("serials", "memory".equals(serialAllocator) ? "memory (acknowledged)" : serialAllocator);
        details.put("access", access);
        // The time source first: an unavailable one is an outage (the server refuses every request with
        // timeNotAvailable), not a platform fact, so it is DOWN with its reason like a missing key.
        TsaTimeSource.Reading reading;
        try {
            reading = time.read();
        } catch (RuntimeException e) {
            reading = TsaTimeSource.Reading.unavailable("the time source failed");
        }
        Instant now;
        if (reading instanceof TsaTimeSource.Available available) {
            details.put("time", "available");
            now = available.now();
        } else {
            String reason = reading instanceof TsaTimeSource.Unavailable unavailable ? unavailable.reason() : "no reading";
            details.put("time", "unavailable (" + reason + ")");
            return down(details, "The time source is not available: " + reason + ".");
        }
        try {
            TsaKey key = keys.load();
            if (key == null) {
                return down(details, "The server has no certificate.");
            }
            Optional<String> problem = TsaCertificateRules.problem(key.leaf(), now);
            details.put("certificate", TsaCertificateRules.subjectText(key.leaf()));
            details.put("notAfter", key.leaf().getNotAfter().toInstant().toString());
            if (problem.isPresent()) {
                return down(details, problem.get());
            }
            details.put("key", "present");
            return DatumHealthContributors.Status.up(details);
        } catch (TsaKeyException e) {
            return down(details, e.getMessage());
        }
    }

    private static DatumHealthContributors.Status down(Map<String, Object> details, String reason) {
        details.put("reason", reason);
        return new DatumHealthContributors.Status(false, details);
    }
}
