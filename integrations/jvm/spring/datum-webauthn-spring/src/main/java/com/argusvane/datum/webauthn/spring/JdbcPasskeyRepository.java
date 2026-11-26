package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.webauthn.DuplicatePasskeyException;
import com.argusvane.datum.webauthn.PasskeyRecord;
import com.argusvane.datum.webauthn.PasskeyRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import javax.sql.DataSource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;

/**
 * {@link PasskeyRepository} over the shared SQL's {@code datum_passkey} table (
 * {@code META-INF/datum/db/migration/<dialect>/V400__datum_webauthn.sql}, shipped by datum-webauthn and kept in
 * integrations/shared; the application owns the schema, so this class never creates it). Rows change by targeted,
 * conditional updates only, as the SPI asks, so a revocation written meanwhile stands.
 *
 * <p>Both unique keys are the database's: {@code credential_sha256} and {@code public_key_sha256}, over
 * every row, revoked and removed ones included. {@link #create} turns the constraint's refusal into
 * {@link DuplicatePasskeyException}, so two registrations racing past the ceremony's look-ups meet there. Times
 * are stored as epoch milliseconds.
 *
 * <p>On Spring's JDBC: each call is a transaction of
 * its own ({@link DatumStoreJdbc}'s rule); a duplicate key is Spring's {@link DuplicateKeyException} and any other value
 * the database refuses is its {@link DataIntegrityViolationException}, which {@link #create} answers with the library's
 * {@link PasskeyRepository#unstorable()} 422.
 */
public final class JdbcPasskeyRepository implements PasskeyRepository {

    /** The table the migration scripts create. */
    public static final String TABLE = "datum_passkey";

    /**
     * The longest public key (SPKI) stored: the width of the {@code public_key} column on H2 and MySQL. PostgreSQL's
     * BYTEA has no limit, so it is checked here, to make every database answer the same.
     */
    static final int MAX_PUBLIC_KEY_BYTES = 16384;

    private static final String COLUMNS = "id, owner, credential_id, label, form_id, public_key, algorithm, transports, sign_count, "
        + "user_verified, backup_eligible, backed_up, user_handle, origin, made_on, aaguid, attestation, rp_id, web_origin, browser, "
        + "created, last_used, revoked, revoked_by, removed";

    private static final String INSERT = "INSERT INTO " + TABLE
        + " (owner, credential_id, credential_sha256, public_key_sha256, label, form_id, public_key, algorithm, transports, "
        + "sign_count, user_verified, backup_eligible, backed_up, user_handle, origin, made_on, aaguid, attestation, rp_id, "
        + "web_origin, browser, created, last_used, revoked, revoked_by, removed) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    private final DatumStoreJdbc jdbc;
    private final RowMapper<PasskeyRecord> rows = (rs, row) -> row(rs);

    public JdbcPasskeyRepository(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource));
    }

    public JdbcPasskeyRepository(DatumStoreJdbc jdbc) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
    }

    @Override
    public Optional<PasskeyRecord> find(String credentialId) {
        if (credentialId == null || credentialId.isEmpty() || credentialId.length() > 1400) {
            return Optional.empty();
        }
        // By the SHA-256 of the id: hex compares exactly whatever the collation; then the id itself, exactly.
        return jdbc.query("SELECT " + COLUMNS + " FROM " + TABLE + " WHERE credential_sha256 = ?", rows, sha256Hex(credentialId.getBytes(StandardCharsets.UTF_8)))
            .stream().filter(found -> found.credentialId().equals(credentialId)).findFirst();
    }

    @Override
    public Optional<PasskeyRecord> findById(long id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM " + TABLE + " WHERE id = ?", rows, id).stream().findFirst();
    }

    @Override
    public boolean keyRegistered(String publicKeyHash) {
        return jdbc.number("SELECT COUNT(*) FROM " + TABLE + " WHERE public_key_sha256 = ?", publicKeyHash) > 0;
    }

    @Override
    public Optional<PasskeyRecord> firstOf(String owner, String formId) {
        return jdbc.query("SELECT " + COLUMNS + " FROM " + TABLE + " WHERE owner = ? AND form_id = ? ORDER BY id LIMIT 1", rows,
            owner, formId == null ? "" : formId).stream().findFirst();
    }

    @Override
    public List<PasskeyRecord> ownActive(String owner, String formId) {
        if (formId == null) {
            return jdbc.query("SELECT " + COLUMNS + " FROM " + TABLE + " WHERE owner = ? AND revoked IS NULL ORDER BY id", rows, owner);
        }
        return jdbc.query("SELECT " + COLUMNS + " FROM " + TABLE + " WHERE owner = ? AND revoked IS NULL AND (form_id = '' OR form_id = ?) ORDER BY id",
            rows, owner, formId);
    }

    @Override
    public List<PasskeyRecord> ofOwner(String owner) {
        return jdbc.query("SELECT " + COLUMNS + " FROM " + TABLE + " WHERE owner = ? AND removed IS NULL ORDER BY id", rows, owner);
    }

    @Override
    public PasskeyRecord create(PasskeyRecord passkey) {
        if (passkey.publicKey().length > MAX_PUBLIC_KEY_BYTES) {
            throw PasskeyRepository.unstorable();
        }
        Object generated;
        try {
            generated = jdbc.inTransaction(status -> {
                // Typed where the plain-JDBC store used typed setters: the key as bytes, the nullable times as BIGINT and
                // the revoker as VARCHAR, so a NULL binds the same on every driver.
                JdbcClient.StatementSpec insert = jdbc.client().sql(INSERT)
                    .param(1, passkey.owner())
                    .param(2, passkey.credentialId())
                    .param(3, passkey.credentialSha256())
                    .param(4, passkey.publicKeyHash())
                    .param(5, passkey.label())
                    .param(6, passkey.formId())
                    .param(7, passkey.publicKey(), Types.VARBINARY)
                    .param(8, passkey.algorithm())
                    .param(9, String.join(",", passkey.transports()))
                    .param(10, passkey.signCount())
                    .param(11, passkey.userVerified())
                    .param(12, passkey.backupEligible())
                    .param(13, passkey.backedUp())
                    .param(14, passkey.userHandle())
                    .param(15, passkey.origin())
                    .param(16, passkey.madeOn())
                    .param(17, passkey.aaguid())
                    .param(18, passkey.attestation())
                    .param(19, passkey.rpId())
                    .param(20, passkey.webOrigin())
                    .param(21, passkey.browser())
                    .param(22, passkey.created().toEpochMilli())
                    .param(23, millis(passkey.lastUsed()), Types.BIGINT)
                    .param(24, millis(passkey.revoked()), Types.BIGINT)
                    .param(25, passkey.revokedBy(), Types.VARCHAR)
                    .param(26, millis(passkey.removed()), Types.BIGINT);
                KeyHolder keys = new GeneratedKeyHolder();
                insert.update(keys);
                return DatumStoreJdbc.firstKey(keys);
            });
        } catch (DuplicateKeyException e) {
            throw new DuplicatePasskeyException("A passkey with this credential id or public key is stored already.", e);
        } catch (DataIntegrityViolationException e) {
            // A value wider than its column (a very long principal name, say) is the person's registration being
            // refused, not a server fault: a 4xx, never a 500 (SEC-05).
            throw PasskeyRepository.unstorable();
        }
        if (!(generated instanceof Number id)) {
            throw new IllegalStateException("The database returned no generated id for the passkey row.");
        }
        return passkey.toBuilder().id(id.longValue()).build();
    }

    @Override
    public boolean revoke(long id, String by, Instant at) {
        return jdbc.update("UPDATE " + TABLE + " SET revoked = ?, revoked_by = ? WHERE id = ? AND revoked IS NULL",
            at.toEpochMilli(), by == null ? "" : by, id) > 0;
    }

    @Override
    public boolean markRemoved(long id, Instant at) {
        return jdbc.update("UPDATE " + TABLE + " SET removed = ?, label = '' WHERE id = ? AND removed IS NULL", at.toEpochMilli(), id) > 0;
    }

    @Override
    public boolean delete(long id) {
        // Never a passkey a stored use names: the guard is in the statement, not in the caller's earlier look-up.
        return jdbc.update("DELETE FROM " + TABLE + " WHERE id = ? AND NOT EXISTS (SELECT 1 FROM " + JdbcPasskeyUseStore.TABLE
            + " u WHERE u.passkey_id = ?)", id, id) > 0;
    }

    @Override
    public boolean touch(long id, long signCount, Instant at) {
        // The counter only goes up (a counting authenticator) or stays 0 (one that keeps none).
        return jdbc.update("UPDATE " + TABLE + " SET last_used = ?, sign_count = CASE WHEN sign_count < ? THEN ? ELSE sign_count END WHERE id = ?",
            at.toEpochMilli(), signCount, signCount, id) > 0;
    }

    @Override
    public int purgeAnonymous(Instant before, int limit) {
        List<Long> ids = jdbc.query("SELECT id FROM " + TABLE + " WHERE owner = '' AND origin <> 'invitation' AND created < ? AND NOT EXISTS "
            + "(SELECT 1 FROM " + JdbcPasskeyUseStore.TABLE + " u WHERE u.passkey_id = " + TABLE + ".id) ORDER BY id LIMIT ?",
            (rs, row) -> rs.getLong(1), before.toEpochMilli(), Math.max(1, limit));
        int removed = 0;
        for (long id : ids) {
            // delete() repeats the "no stored use" guard in its own statement, so a use recorded since the look-up wins.
            if (delete(id)) {
                removed++;
            }
        }
        return removed;
    }

    private static Long millis(Instant at) {
        return at == null ? null : at.toEpochMilli();
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        long value = rs.getLong(column);
        return rs.wasNull() ? null : Instant.ofEpochMilli(value);
    }

    private static PasskeyRecord row(ResultSet rs) throws SQLException {
        String transports = rs.getString("transports");
        List<String> words = new ArrayList<>();
        if (transports != null && !transports.isEmpty()) {
            words.addAll(Arrays.asList(transports.split(",")));
        }
        return PasskeyRecord.builder()
            .id(rs.getLong("id"))
            .owner(rs.getString("owner"))
            .credentialId(rs.getString("credential_id"))
            .label(rs.getString("label"))
            .formId(rs.getString("form_id"))
            .publicKey(rs.getBytes("public_key"))
            .algorithm(rs.getInt("algorithm"))
            .transports(words)
            .signCount(rs.getLong("sign_count"))
            .userVerified(rs.getBoolean("user_verified"))
            .backupEligible(rs.getBoolean("backup_eligible"))
            .backedUp(rs.getBoolean("backed_up"))
            .userHandle(rs.getString("user_handle"))
            .origin(rs.getString("origin"))
            .madeOn(rs.getString("made_on"))
            .aaguid(rs.getString("aaguid"))
            .attestation(rs.getString("attestation"))
            .rpId(rs.getString("rp_id"))
            .webOrigin(rs.getString("web_origin"))
            .browser(rs.getString("browser"))
            .created(Instant.ofEpochMilli(rs.getLong("created")))
            .lastUsed(instant(rs, "last_used"))
            .revoked(instant(rs, "revoked"))
            .revokedBy(rs.getString("revoked_by"))
            .removed(instant(rs, "removed"))
            .build();
    }

    static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }
}
