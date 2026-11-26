package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.webauthn.ChallengeClaims;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.springframework.dao.DuplicateKeyException;

/**
 * {@link ChallengeClaims} over the shared SQL's {@code datum_passkey_challenge} table: the nonce is the primary key, so two requests (on any instance)
 * claiming one nonce see one true. An expired claim of the same nonce is removed first; expired claims of other
 * nonces are swept every 256th call, so the table holds about one challenge lifetime of nonces.
 *
 * <p>On Spring's JDBC: each statement is a
 * transaction of its own ({@link DatumStoreJdbc}'s rule), and the primary key's refusal is Spring's
 * {@link DuplicateKeyException}.
 */
public final class JdbcChallengeClaims implements ChallengeClaims {

    /** The table the migration scripts create. */
    public static final String TABLE = "datum_passkey_challenge";

    /** The column's width: a nonce is 22 characters; a longer one is not ours. */
    static final int NONCE_WIDTH = 64;

    private final DatumStoreJdbc jdbc;
    private final AtomicInteger sinceSweep = new AtomicInteger();

    public JdbcChallengeClaims(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource));
    }

    public JdbcChallengeClaims(DatumStoreJdbc jdbc) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
    }

    @Override
    public boolean claim(String nonce, Instant now, Duration ttl) {
        // The token's shape is checked but its MAC is not before the claim; a nonce wider than ours cannot be one we
        // issued, and must not reach the column.
        if (nonce == null || nonce.isEmpty() || nonce.length() > NONCE_WIDTH) {
            return false;
        }
        long nowMillis = now.toEpochMilli();
        if (sinceSweep.incrementAndGet() >= 256) {
            sinceSweep.set(0);
            jdbc.update("DELETE FROM " + TABLE + " WHERE expires <= ?", nowMillis);
        }
        jdbc.update("DELETE FROM " + TABLE + " WHERE nonce = ? AND expires <= ?", nonce, nowMillis);
        try {
            jdbc.update("INSERT INTO " + TABLE + " (nonce, expires) VALUES (?, ?)", nonce, now.plus(ttl).toEpochMilli());
            return true;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }
}
