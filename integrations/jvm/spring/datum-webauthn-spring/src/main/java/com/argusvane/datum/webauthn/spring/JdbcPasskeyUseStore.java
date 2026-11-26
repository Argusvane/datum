package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import java.util.List;
import java.util.Objects;
import javax.sql.DataSource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * {@link PasskeyUseStore} over the {@code datum_passkey_use} table: the replay guard and the counter move, one
 * atomic step across every process that accepts submissions (one database transaction).
 *
 * <p>{@link #record} runs in one transaction: it locks the passkey row ({@code SELECT ... FOR UPDATE}, which
 * serialises every use of one key, whatever process makes it), answers {@code REPLAY} when the key already signed
 * the digest, {@code REVOKED} when the passkey is revoked or gone, {@code COUNTER} when its counter does not
 * move, and otherwise inserts the claim <em>with the counter value it replaces</em> ({@code replaced_sign_count},
 * read and written under that lock) and moves the counter. The order is the replay guard's (claim, then the conditional
 * counter move; a failed move gives the claim back, here by never writing it). {@code UNIQUE (key_sha256, digest)}
 * is the second fence: its refusal (Spring's {@link DuplicateKeyException}) rolls the transaction back and answers
 * {@code REPLAY}.
 *
 * <p>{@link #release} locks the same row, removes only this use's claim (matched by key, digest, passkey, count and
 * time) and puts the replaced counter back with a conditional update ({@code WHERE sign_count = :count}), so a use
 * recorded in between keeps its counter: a copied authenticator can never sign again with a count already used.
 *
 * <p>On Spring's JDBC: {@link #record} and
 * {@link #release} each run in one {@link DatumStoreJdbc#inTransaction} call, a new transaction on one connection, so
 * the row lock is held from the look-up to the counter move whatever the pool's defaults. The store joins no
 * transaction of the application (the rule is {@link DatumStoreJdbc}'s); a use is recorded or not on its own.
 */
public final class JdbcPasskeyUseStore implements PasskeyUseStore {

    /** The table the migration scripts create. */
    public static final String TABLE = "datum_passkey_use";

    private final DatumStoreJdbc jdbc;

    public JdbcPasskeyUseStore(DataSource dataSource) {
        this(DatumStoreJdbc.of(dataSource));
    }

    public JdbcPasskeyUseStore(DatumStoreJdbc jdbc) {
        this.jdbc = Objects.requireNonNull(jdbc, "jdbc");
    }

    @Override
    public boolean used(String keySha256, String digest) {
        return jdbc.number("SELECT COUNT(*) FROM " + TABLE + " WHERE key_sha256 = ? AND digest = ?", keySha256, digest) > 0;
    }

    @Override
    public Outcome record(PasskeyUse use) {
        Outcome outcome = jdbc.inTransaction(status -> {
            JdbcClient client = jdbc.client();
            List<long[]> rows = client.sql("SELECT sign_count, revoked FROM " + JdbcPasskeyRepository.TABLE + " WHERE id = ? FOR UPDATE")
                .param(use.passkeyId())
                .query((rs, row) -> new long[] {rs.getLong("sign_count"), rs.getObject("revoked") == null ? 0 : 1}).list();
            // In the same transaction as the lock, as before: a use recorded meanwhile by another process is seen.
            Long claimed = client.sql("SELECT COUNT(*) FROM " + TABLE + " WHERE key_sha256 = ? AND digest = ?")
                .params(use.keySha256(), use.digest()).query(Long.class).single();
            if (claimed != null && claimed > 0) {
                return Outcome.REPLAY;
            }
            if (rows.isEmpty() || rows.get(0)[1] == 1) {
                return Outcome.REVOKED;
            }
            long stored = rows.get(0)[0];
            // A counting authenticator's counter only goes up; one that keeps none stays 0 (the SPI's rule).
            boolean moves = use.signCount() > 0 ? stored < use.signCount() : stored == use.signCount();
            if (!moves) {
                return Outcome.COUNTER;
            }
            try {
                client.sql("INSERT INTO " + TABLE + " (key_sha256, digest, passkey_id, submission, sign_count, replaced_sign_count, used_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?)").params(use.keySha256(), use.digest(), use.passkeyId(), use.submission(), use.signCount(), stored,
                    use.at().toEpochMilli()).update();
            } catch (DuplicateKeyException e) {
                // Another process claimed the digest between the look-up and the insert: nothing of this use stays.
                status.setRollbackOnly();
                return Outcome.REPLAY;
            }
            client.sql("UPDATE " + JdbcPasskeyRepository.TABLE + " SET sign_count = ?, last_used = ? WHERE id = ?")
                .params(use.signCount(), use.at().toEpochMilli(), use.passkeyId()).update();
            return Outcome.RECORDED;
        });
        return outcome == null ? Outcome.REVOKED : outcome;
    }

    @Override
    public void release(PasskeyUse use) {
        jdbc.inTransaction(status -> {
            JdbcClient client = jdbc.client();
            // The same lock record() takes, so a release and a use of this key never interleave.
            client.sql("SELECT id FROM " + JdbcPasskeyRepository.TABLE + " WHERE id = ? FOR UPDATE").param(use.passkeyId())
                .query((rs, row) -> rs.getLong(1)).list();
            List<Long> replaced = client.sql("SELECT replaced_sign_count FROM " + TABLE + " WHERE key_sha256 = ? AND digest = ? "
                + "AND passkey_id = ? AND sign_count = ? AND used_at = ?").params(use.keySha256(), use.digest(), use.passkeyId(),
                use.signCount(), use.at().toEpochMilli()).query((rs, row) -> rs.getLong(1)).list();
            if (replaced.isEmpty()) {
                return null;
            }
            // Only this use's claim: never another request's of the same digest.
            int removed = client.sql("DELETE FROM " + TABLE + " WHERE key_sha256 = ? AND digest = ? AND passkey_id = ? AND sign_count = ? "
                + "AND used_at = ?").params(use.keySha256(), use.digest(), use.passkeyId(), use.signCount(), use.at().toEpochMilli()).update();
            if (removed > 0) {
                client.sql("UPDATE " + JdbcPasskeyRepository.TABLE + " SET sign_count = ? WHERE id = ? AND sign_count = ?")
                    .params(replaced.get(0), use.passkeyId(), use.signCount()).update();
            }
            return null;
        });
    }

    @Override
    public long signedCount(long passkeyId) {
        return jdbc.number("SELECT COUNT(*) FROM " + TABLE + " WHERE passkey_id = ?", passkeyId);
    }
}
