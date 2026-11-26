package com.argusvane.datum.springweb.spring;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import javax.sql.DataSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.ResourceTransactionManager;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.Assert;

/**
 * What every Datum SQL store of the Spring bindings shares (framework-first): Spring's
 * {@link JdbcClient} over the application's {@link DataSource}, a {@link TransactionTemplate}, and Spring's exception
 * translation, so a duplicate key is {@code DuplicateKeyException} and a value the database refuses is
 * {@code DataIntegrityViolationException}, as Spring reads them for each database.
 *
 * <p><b>The transaction rule.</b> Every store call is a transaction of its own, {@code PROPAGATION_REQUIRES_NEW}:
 * committed when the call returns, rolled back when it throws, and never part of a transaction the application has
 * open on the calling thread (suspended for the call under the application's manager, left alone beside the stores'
 * own, which never sees it; either way the store's statements run on another connection). So a timestamp serial taken
 * before signing survives the caller's rollback, a remembered receipt or a claimed nonce is there for every other
 * instance as soon as the call returns, and a store that needs several statements atomically (the passkey claim and
 * counter move under {@code SELECT ... FOR UPDATE}) runs them in one {@link #inTransaction} call. Each call is its own unit of work on its own connection; no store joins an
 * application transaction.
 *
 * <p>The transaction manager is the application's when it is the application's only one and a JDBC manager of this
 * data source: a {@link ResourceTransactionManager} whose resource is the data source itself (Spring
 * Boot's {@code JdbcTransactionManager}, any {@code DataSourceTransactionManager}). Every other manager, JPA's and
 * Hibernate's included, and one of another database or of none (JTA), is passed over for a {@link JdbcTransactionManager}
 * of the stores' own over the data source. Not JPA's: a new JPA transaction begins on the entity manager
 * open-in-view has bound to the request thread, and its commit flushes that persistence context, so a store call would
 * write the application's unflushed entity changes; and where the JPA dialect does not expose its JDBC connection, the
 * stores' statements would run in auto-commit outside it and the passkey row lock would not hold. Nothing is lost by
 * the own manager: each call is a new transaction anyway.
 *
 * <p>The own manager and the client run over a private wrapper of the data source, so their connections are bound to
 * the thread under a key no other manager uses. A {@code JpaTransactionManager} binds the connection Hibernate exposes
 * under the data source itself, without marking it a JDBC transaction, and a JDBC manager over that same key would take
 * it for its own: the store's commit would then commit the application's flushed JPA work mid-transaction (proved in {@code DatumStoreJdbcTest}). Under the wrapper the store's transaction always has a
 * connection of its own. For the same reason a JDBC manager is the application's only when it is
 * the sole manager: a {@code @Primary} JDBC manager beside JPA's would find JPA's connection under the data source.
 */
public final class DatumStoreJdbc {

    private final DataSource dataSource;
    private final boolean ownTransactions;
    private final PlatformTransactionManager transactionManager;
    private final JdbcClient client;
    private final TransactionTemplate transactions;

    /** {@code connections} is the key the manager binds its connection under and the client asks for it by. */
    private DatumStoreJdbc(DataSource dataSource, DataSource connections, PlatformTransactionManager transactionManager) {
        this.dataSource = dataSource;
        this.ownTransactions = connections != dataSource;
        this.transactionManager = transactionManager;
        this.client = JdbcClient.create(connections);
        this.transactions = new TransactionTemplate(transactionManager);
        this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /** The stores' access with a transaction manager of their own over {@code dataSource} (see the class). */
    public static DatumStoreJdbc of(DataSource dataSource) {
        Objects.requireNonNull(dataSource, "dataSource");
        DataSource connections = new StoreConnections(dataSource);
        return new DatumStoreJdbc(dataSource, connections, new JdbcTransactionManager(connections));
    }

    /** The stores' access with {@code transactionManager}, which must manage {@code dataSource} (see {@link #manages}). */
    public static DatumStoreJdbc of(DataSource dataSource, PlatformTransactionManager transactionManager) {
        Objects.requireNonNull(dataSource, "dataSource");
        Objects.requireNonNull(transactionManager, "transactionManager");
        Assert.isTrue(manages(transactionManager, dataSource), "The transaction manager does not manage the stores' DataSource as a JDBC "
            + "transaction manager, so the stores' statements would run outside its transactions (or, under JPA, flush the "
            + "application's persistence context).");
        return new DatumStoreJdbc(dataSource, dataSource, transactionManager);
    }

    /**
     * The stores' access as an auto-configuration builds it: the application's transaction manager when it is the only
     * one and a JDBC manager of {@code dataSource}, else one of the stores' own (see the class). Not {@code getIfUnique}:
     * a {@code @Primary} among several may sit beside a JPA manager of the same data source.
     */
    public static DatumStoreJdbc forApplication(DataSource dataSource, ObjectProvider<PlatformTransactionManager> managers) {
        List<PlatformTransactionManager> all = managers.stream().limit(2).toList();
        PlatformTransactionManager application = all.size() == 1 ? all.get(0) : null;
        return application != null && manages(application, dataSource) ? of(dataSource, application) : of(dataSource);
    }

    /**
     * Whether {@code manager} is a JDBC manager of {@code dataSource}: a {@link ResourceTransactionManager} whose
     * resource is that data source (identity, no unwrapping). A JPA or Hibernate manager over it is not, see the class.
     */
    public static boolean manages(PlatformTransactionManager manager, DataSource dataSource) {
        return manager instanceof ResourceTransactionManager resource && resource.getResourceFactory() == dataSource;
    }

    /** The data source the stores were given. */
    public DataSource dataSource() {
        return dataSource;
    }

    /** Whether the store calls run under the stores' own manager, on connections no other manager binds (see the class). */
    public boolean ownTransactions() {
        return ownTransactions;
    }

    /** The transaction manager the store calls run under. */
    public PlatformTransactionManager transactionManager() {
        return transactionManager;
    }

    /** The client, for statements inside {@link #inTransaction}. */
    public JdbcClient client() {
        return client;
    }

    /**
     * Runs {@code work} in one new transaction: committed when it returns, rolled back when it throws or when it marks
     * its status rollback-only (a store that wants its statements undone without failing).
     */
    public <T> T inTransaction(TransactionCallback<T> work) {
        return transactions.execute(work);
    }

    /** One statement's update count, committed. */
    public int update(String sql, Object... args) {
        Integer count = inTransaction(status -> client.sql(sql).params(args).update());
        return count == null ? 0 : count;
    }

    /** The rows of one query. */
    public <T> List<T> query(String sql, RowMapper<T> rows, Object... args) {
        return query(sql, 0, rows, args);
    }

    /** At most {@code maxRows} rows ({@code setMaxRows}, so the same statement runs on every database); 0 is no bound. */
    public <T> List<T> query(String sql, int maxRows, RowMapper<T> rows, Object... args) {
        return inTransaction(status -> {
            JdbcClient.StatementSpec statement = client.sql(sql).params(args);
            if (maxRows > 0) {
                statement = statement.withMaxRows(maxRows);
            }
            return statement.query(rows).list();
        });
    }

    /** A single number ({@code SELECT COUNT(*) ...}); 0 for no row or a NULL. */
    public long number(String sql, Object... args) {
        List<Long> found = query(sql, (rs, row) -> {
            long value = rs.getLong(1);
            return rs.wasNull() ? 0L : value;
        }, args);
        return found.isEmpty() ? 0 : found.get(0);
    }

    /** An insert's generated key, committed: the first column of the first generated row, or null when the driver gave none. */
    public Object insert(String sql, Object... args) {
        return inTransaction(status -> {
            KeyHolder keys = new GeneratedKeyHolder();
            client.sql(sql).params(args).update(keys);
            return firstKey(keys);
        });
    }

    /**
     * The first column of the first generated row. Not {@code KeyHolder.getKey()}: PostgreSQL hands back every column of
     * the row, and a named key column is folded differently by each database (H2 upper, PostgreSQL lower, MySQL
     * {@code GENERATED_KEY}); the id is the first column of every Datum table.
     */
    public static Object firstKey(KeyHolder keys) {
        List<Map<String, Object>> rows = keys.getKeyList();
        if (rows.isEmpty() || rows.get(0).isEmpty()) {
            return null;
        }
        return rows.get(0).values().iterator().next();
    }

    /**
     * The data source under another identity: the thread-bound key of the stores' own connections, which no application
     * manager binds (see the class). Not a {@code TransactionAwareDataSourceProxy} or an {@code InfrastructureProxy}, which
     * Spring unwraps to the target.
     */
    private static final class StoreConnections extends DelegatingDataSource {

        StoreConnections(DataSource target) {
            super(target);
        }
    }
}
