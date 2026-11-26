package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import java.time.Clock;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import javax.sql.DataSource;
import org.springframework.dao.DuplicateKeyException;
import tools.jackson.databind.JsonNode;

/**
 * Receipts in a table the application owns, {@code datum_submission_digest}. The store never creates it: the
 * plain-SQL scripts under {@code META-INF/datum/db/migration/{h2,postgresql,mysql}/V200__datum_submissions.sql}
 * (shipped by datum-submissions, kept in integrations/shared) are for Flyway or Liquibase (or a hand-run psql), so
 * schema changes stay the application's decision.
 *
 * <p>The primary key is (form, version, submission key), with the digest the attempt was accepted with beside the
 * receipt, so two instances racing the same attempt cannot both remember it: the loser's insert is a duplicate key and
 * is ignored (the first receipt wins, and every retry with the same digest is answered with it, {@code handled: true}). A version longer than 255 characters is kept as {@code sha256:<hex>} of
 * itself so the key stays bounded and exact. Only standard SQL is used, so the same statements run on all three
 * databases.
 *
 * <p>On Spring's JDBC: each call is a transaction of
 * its own ({@link DatumStoreJdbc}'s rule, so a receipt is remembered whatever the handler's transaction does), and the
 * duplicate key is Spring's {@link DuplicateKeyException}.
 */
public final class JdbcSubmissionIdempotencyStore implements SubmissionIdempotencyStore {

    /** The table name the migration scripts create. */
    public static final String TABLE = "datum_submission_digest";

    private static final int MAX_VERSION = 255;

    private final DatumStoreJdbc jdbc;
    private final Clock clock;

    public JdbcSubmissionIdempotencyStore(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource), Clock.systemUTC());
    }

    public JdbcSubmissionIdempotencyStore(DataSource dataSource, Clock clock) {
        this(DatumStoreJdbc.of(dataSource), clock);
    }

    public JdbcSubmissionIdempotencyStore(DatumStoreJdbc jdbc, Clock clock) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * Whether the table is there: one statement that reads no row. A missing table (the application upgraded
     * Datum without running {@code V200__datum_submissions.sql}) is a failure the binding turns into the in-memory
     * fallback with a WARN.
     *
     * @throws org.springframework.dao.DataAccessException when the table cannot be read
     */
    public void probe() {
        jdbc.query("SELECT 1 FROM " + TABLE + " WHERE 1 = 0", (rows, row) -> 1);
    }

    @Override
    public Optional<Remembered> find(String formKey, String version, String submissionKey) {
        List<Remembered> rows = jdbc.query("SELECT digest, receipt_id, reference, receipt FROM " + TABLE
            + " WHERE form_key = ? AND version = ? AND submission_key = ?", (rs, row) -> {
                String json = rs.getString(4);
                JsonNode receipt = json == null ? null : DatumJson.mapper().readTree(json);
                return new Remembered(rs.getString(1).trim(), new SubmissionReceipt(rs.getString(2), rs.getString(3), receipt));
            }, formKey, versionKey(version), submissionKey);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public void remember(String formKey, String version, String submissionKey, String digest, SubmissionReceipt receipt) {
        JsonNode notice = receipt.receipt();
        try {
            jdbc.update("INSERT INTO " + TABLE + " (form_key, version, submission_key, digest, receipt_id, reference, receipt, created)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                formKey, versionKey(version), submissionKey, digest, receipt.id(), receipt.reference(),
                notice == null || notice.isNull() ? null : CanonicalJson.serialize(notice), clock.millis());
        } catch (DuplicateKeyException raced) {
            // Another delivery (or node) remembered the same attempt first: its receipt is the one kept.
        }
    }

    static String versionKey(String version) {
        return version.length() <= MAX_VERSION ? version : "sha256:" + CanonicalJson.sha256Hex(version);
    }
}
