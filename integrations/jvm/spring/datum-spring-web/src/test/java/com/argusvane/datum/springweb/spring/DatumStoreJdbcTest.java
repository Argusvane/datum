package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.persistence.Entity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.orm.jpa.EntityManagerHolder;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.SharedEntityManagerCreator;
import org.springframework.orm.jpa.persistenceunit.PersistenceManagedTypes;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The stores' shared JDBC access, proved of Spring's JdbcClient, TransactionTemplate and exception translation as the stores use them:
 * one committed unit of work per call whatever the pool's auto-commit, nothing left by a failing unit, a duplicate key
 * told apart from other refused values and from a bad statement, generated keys, nulls. Plus the transaction rule:
 * a store call joins no application transaction, and the application's manager is used only when it is a JDBC manager
 * of the stores' data source (never JPA's: a store call must not flush the application's persistence context).
 */
class DatumStoreJdbcTest {

    private String url;

    /** A data source whose connections start without auto-commit, as some pools hand them out. */
    private DataSource manual() {
        DriverManagerDataSource source = new DriverManagerDataSource(url, "sa", "") {
            @Override
            public Connection getConnection() throws SQLException {
                Connection connection = super.getConnection();
                connection.setAutoCommit(false);
                return connection;
            }
        };
        return source;
    }

    private DataSource plain() {
        return new DriverManagerDataSource(url, "sa", "");
    }

    @BeforeEach
    void database() {
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        new JdbcTemplate(plain()).execute("CREATE TABLE t (id BIGINT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(8) NOT NULL UNIQUE, v VARCHAR(16))");
    }

    @Test
    void aWriteIsCommittedWhenThePoolHandsOutConnectionsWithoutAutoCommit() {
        DatumStoreJdbc manual = DatumStoreJdbc.of(manual());
        assertThat(manual.update("INSERT INTO t (k, v) VALUES (?, ?)", "a", "one")).isEqualTo(1);
        // A second connection sees it: the call committed.
        assertThat(DatumStoreJdbc.of(plain()).number("SELECT COUNT(*) FROM t")).isEqualTo(1);
    }

    @Test
    void aFailingUnitOfWorkLeavesNothingBehind() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        assertThatThrownBy(() -> jdbc.inTransaction(status -> {
            jdbc.client().sql("INSERT INTO t (k) VALUES (?)").param("a").update();
            jdbc.client().sql("INSERT INTO t (k) VALUES (?)").param("a").update();
            return null;
        })).isInstanceOf(DuplicateKeyException.class).hasMessageContaining("INSERT INTO t (k) VALUES (?)");
        assertThat(jdbc.number("SELECT COUNT(*) FROM t")).isZero();
    }

    @Test
    void aDuplicateKeyIsTold() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        jdbc.update("INSERT INTO t (k) VALUES (?)", "a");
        assertThatThrownBy(() -> jdbc.update("INSERT INTO t (k) VALUES (?)", "a")).isInstanceOf(DuplicateKeyException.class)
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aNotNullViolationIsARefusedValueButNotADuplicate() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        assertThatThrownBy(() -> jdbc.update("INSERT INTO t (k) VALUES (?)", (Object) null))
            .isInstanceOf(DataIntegrityViolationException.class).isNotInstanceOf(DuplicateKeyException.class);
    }

    @Test
    void aValueWiderThanItsColumnIsARefusedValue() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        assertThatThrownBy(() -> jdbc.update("INSERT INTO t (k) VALUES (?)", "far too long a key"))
            .isInstanceOf(DataIntegrityViolationException.class).isNotInstanceOf(DuplicateKeyException.class);
    }

    @Test
    void aBadStatementIsNeitherDuplicateNorARefusedValue() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        assertThatThrownBy(() -> jdbc.update("INSERT INTO missing (k) VALUES (?)", "a"))
            .isInstanceOf(BadSqlGrammarException.class).isNotInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void generatedKeysQueriesAndNulls() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        Object first = jdbc.insert("INSERT INTO t (k, v) VALUES (?, ?)", "a", null);
        Object second = jdbc.insert("INSERT INTO t (k, v) VALUES (?, ?)", "b", "two");
        assertThat(first).isInstanceOf(Number.class);
        assertThat(((Number) second).longValue()).isEqualTo(((Number) first).longValue() + 1);
        List<String> values = jdbc.query("SELECT v FROM t ORDER BY id", (rows, n) -> rows.getString(1));
        assertThat(values).containsExactly(null, "two");
        assertThat(jdbc.query("SELECT k FROM t ORDER BY id DESC", 1, (rows, n) -> rows.getString(1))).containsExactly("b");
        assertThat(jdbc.number("SELECT MAX(id) FROM t WHERE k = ?", "none")).isZero();
    }

    @Test
    void workMayUndoItsOwnStatementsWithoutFailing() {
        DatumStoreJdbc jdbc = DatumStoreJdbc.of(plain());
        String answer = jdbc.inTransaction(status -> {
            jdbc.client().sql("INSERT INTO t (k) VALUES (?)").param("a").update();
            status.setRollbackOnly();
            return "undone";
        });
        assertThat(answer).isEqualTo("undone");
        assertThat(jdbc.number("SELECT COUNT(*) FROM t")).isZero();
    }

    /**
     * The transaction rule: a store call inside an application transaction on the same database is a transaction of
     * its own. The application rolls back; the store's row stays (a timestamp serial taken before signing, a claimed
     * nonce), with the stores' own manager and with the application's.
     */
    @Test
    void aStoreCallJoinsNoApplicationTransaction() {
        DataSource source = plain();
        PlatformTransactionManager application = new JdbcTransactionManager(source);
        TransactionTemplate outer = new TransactionTemplate(application);
        List<DatumStoreJdbc> stores = List.of(DatumStoreJdbc.of(source), DatumStoreJdbc.of(source, application));
        for (int i = 0; i < stores.size(); i++) {
            DatumStoreJdbc jdbc = stores.get(i);
            String key = "k" + i;
            outer.executeWithoutResult(status -> {
                new JdbcTemplate(source).update("INSERT INTO t (k, v) VALUES (?, 'outer')", "o" + key);
                jdbc.update("INSERT INTO t (k, v) VALUES (?, 'store')", key);
                status.setRollbackOnly();
            });
            assertThat(new JdbcTemplate(source).queryForObject("SELECT COUNT(*) FROM t WHERE k = ?", Integer.class, key))
                .as("the store's row outlives the application's rollback").isEqualTo(1);
            assertThat(new JdbcTemplate(source).queryForObject("SELECT COUNT(*) FROM t WHERE k = ?", Integer.class, "o" + key))
                .as("the application's own row is rolled back").isZero();
        }
    }

    /**
     * A JTA-aware pool in miniature (the shape of a container's or a transaction manager's XA data source): while a global transaction
     * is open on the thread, every connection it hands out is enlisted in it, and an enlisted connection takes no local commit or
     * rollback (the transaction manager commits it, in two phases). Enlistment is the pool's doing, not the caller's.
     */
    private static final class XaStylePool extends DriverManagerDataSource {

        static final ThreadLocal<List<Connection>> GLOBAL = new ThreadLocal<>();
        int enlisted;

        XaStylePool(String url) {
            super(url, "sa", "");
        }

        @Override
        public Connection getConnection() throws SQLException {
            Connection real = super.getConnection();
            List<Connection> global = GLOBAL.get();
            if (global == null) {
                return real;
            }
            enlisted++;
            global.add(real);
            return (Connection) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                (proxy, method, args) -> {
                    boolean back = method.getName().equals("setAutoCommit") && Boolean.TRUE.equals(args[0]);
                    if (method.getName().equals("commit") || method.getName().equals("rollback") || back) {
                        // Switching auto-commit back on would commit pending work, so an enlisted connection refuses that too.
                        throw new SQLException("Cannot call " + method.getName() + " on a connection enlisted in a global transaction");
                    }
                    try {
                        return method.invoke(real, args);
                    } catch (java.lang.reflect.InvocationTargetException e) {
                        throw e.getCause();
                    }
                });
        }
    }

    /**
     * XA: the stores take no part in a JTA transaction and enlist nothing themselves. A manager that
     * is no JDBC manager of the stores' data source (JTA's) is passed over for the stores' own, and each call asks the pool for a
     * connection of its own; whether the pool enlists it is the pool's rule. So:
     * <ul>
     *   <li>outside a global transaction, over an XA-style pool, the stores work and enlist nothing;</li>
     *   <li>inside one, a JTA-aware pool enlists the store's connection and refuses its local commit, so the store call fails (the
     *       documented limitation: call the stores outside a JTA transaction, or give them a non-XA data source);</li>
     *   <li>over a plain pool inside the same global transaction nothing is enlisted and the store's row outlives the rollback.</li>
     * </ul>
     */
    @Test
    void anXaStylePoolEnlistsNothingOutsideAGlobalTransactionAndRefusesTheStoresLocalCommitInside() {
        XaStylePool xa = new XaStylePool(url);
        PlatformTransactionManager jtaLike = new org.springframework.transaction.support.AbstractPlatformTransactionManager() {
            @Override
            protected Object doGetTransaction() {
                return new Object();
            }

            @Override
            protected void doBegin(Object transaction, org.springframework.transaction.TransactionDefinition definition) {
                XaStylePool.GLOBAL.set(new java.util.ArrayList<>());
            }

            @Override
            protected void doCommit(org.springframework.transaction.support.DefaultTransactionStatus status) {
                XaStylePool.GLOBAL.remove();
            }

            @Override
            protected void doRollback(org.springframework.transaction.support.DefaultTransactionStatus status) {
                XaStylePool.GLOBAL.remove();
            }
        };
        // The application's manager here is no JDBC manager of the pool, so the stores bring their own.
        DefaultListableBeanFactory beans = new DefaultListableBeanFactory();
        beans.registerSingleton("transactionManager", jtaLike);
        DatumStoreJdbc stores = DatumStoreJdbc.forApplication(xa, beans.getBeanProvider(PlatformTransactionManager.class));
        assertThat(stores.ownTransactions()).isTrue();

        assertThat(stores.update("INSERT INTO t (k, v) VALUES (?, ?)", "outside", "xa")).isEqualTo(1);
        assertThat(xa.enlisted).as("no global transaction open: nothing enlisted").isZero();

        TransactionTemplate global = new TransactionTemplate(jtaLike);
        global.executeWithoutResult(status -> {
            assertThatThrownBy(() -> stores.update("INSERT INTO t (k, v) VALUES (?, ?)", "inside", "xa"))
                .as("the pool enlisted the store's connection and refuses its local commit")
                .isInstanceOf(org.springframework.transaction.TransactionSystemException.class);
        });
        assertThat(xa.enlisted).as("the pool, not the store, enlisted it").isPositive();
        assertThat(new JdbcTemplate(plain()).queryForObject("SELECT COUNT(*) FROM t WHERE k = 'inside'", Integer.class)).isZero();

        // The workaround: the stores over a plain pool (the application's non-XA data source) inside the same global transaction.
        DataSource nonXa = plain();
        DatumStoreJdbc plainStores = DatumStoreJdbc.of(nonXa);
        global.executeWithoutResult(status -> {
            plainStores.update("INSERT INTO t (k, v) VALUES (?, ?)", "plain", "nonxa");
            status.setRollbackOnly();
        });
        assertThat(new JdbcTemplate(nonXa).queryForObject("SELECT COUNT(*) FROM t WHERE k = 'plain'", Integer.class))
            .as("not enlisted: the row outlives the global rollback").isEqualTo(1);
        assertThat(XaStylePool.GLOBAL.get()).isNull();
    }

    @Test
    void theApplicationsManagerIsUsedOnlyWhenItManagesTheStoresDataSource() {
        DataSource source = plain();
        DataSource other = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");

        DefaultListableBeanFactory same = new DefaultListableBeanFactory();
        PlatformTransactionManager mine = new DataSourceTransactionManager(source);
        same.registerSingleton("transactionManager", mine);
        assertThat(DatumStoreJdbc.forApplication(source, same.getBeanProvider(PlatformTransactionManager.class)).transactionManager()).isSameAs(mine);

        DefaultListableBeanFactory foreign = new DefaultListableBeanFactory();
        PlatformTransactionManager theirs = new DataSourceTransactionManager(other);
        foreign.registerSingleton("transactionManager", theirs);
        DatumStoreJdbc own = DatumStoreJdbc.forApplication(source, foreign.getBeanProvider(PlatformTransactionManager.class));
        assertThat(own.transactionManager()).as("a manager of another database would leave the statements in auto-commit").isNotSameAs(theirs);
        assertThat(own.ownTransactions()).isTrue();

        DefaultListableBeanFactory none = new DefaultListableBeanFactory();
        assertThat(DatumStoreJdbc.forApplication(source, none.getBeanProvider(PlatformTransactionManager.class)).ownTransactions()).isTrue();
        assertThat(DatumStoreJdbc.forApplication(source, same.getBeanProvider(PlatformTransactionManager.class)).ownTransactions()).isFalse();

        assertThatThrownBy(() -> DatumStoreJdbc.of(source, theirs)).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("does not manage");
    }

    /**
     * JPA's manager over the stores' data source is passed over for the stores' own: it is no JDBC manager
     * of the data source (its resource is the entity manager factory), and building the stores on it is refused.
     */
    @Test
    void aJpaManagerIsPassedOverForTheStoresOwn() {
        DataSource source = plain();
        try (Jpa jpa = new Jpa(source)) {
            assertThat(DatumStoreJdbc.manages(jpa.manager, source)).isFalse();
            DefaultListableBeanFactory beans = new DefaultListableBeanFactory();
            beans.registerSingleton("transactionManager", jpa.manager);
            DatumStoreJdbc jdbc = DatumStoreJdbc.forApplication(source, beans.getBeanProvider(PlatformTransactionManager.class));
            assertThat(jdbc.transactionManager()).isNotSameAs(jpa.manager).isInstanceOf(JdbcTransactionManager.class);
            assertThat(jdbc.ownTransactions()).isTrue();
            assertThatThrownBy(() -> DatumStoreJdbc.of(source, jpa.manager)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not manage");
        }
    }

    /**
     * The reproduction: open-in-view binds an entity manager to the request thread; the application loads
     * an entity and changes it outside any transaction, a change never meant to be written. A store call (a remembered
     * receipt, a snapshot) made then must not flush it. Under JPA's manager it did: the new JPA transaction began on the
     * bound entity manager and its commit wrote the change.
     */
    @Test
    void aStoreCallDoesNotFlushTheOpenInViewPersistenceContext() {
        DataSource source = plain();
        try (Jpa jpa = new Jpa(source)) {
            DefaultListableBeanFactory beans = new DefaultListableBeanFactory();
            beans.registerSingleton("transactionManager", jpa.manager);
            DatumStoreJdbc jdbc = DatumStoreJdbc.forApplication(source, beans.getBeanProvider(PlatformTransactionManager.class));
            EntityManager view = jpa.factory.createEntityManager();
            TransactionSynchronizationManager.bindResource(jpa.factory, new EntityManagerHolder(view));
            try {
                view.find(Account.class, 1L).owner = "mallory";
                jdbc.update("INSERT INTO t (k, v) VALUES (?, 'store')", "a");
            } finally {
                TransactionSynchronizationManager.unbindResource(jpa.factory);
                view.close();
            }
            JdbcTemplate read = new JdbcTemplate(source);
            assertThat(read.queryForObject("SELECT owner FROM account WHERE id = 1", String.class))
                .as("the application's unflushed change stays unwritten").isEqualTo("ada");
            assertThat(read.queryForObject("SELECT COUNT(*) FROM t WHERE k = 'a'", Integer.class)).isEqualTo(1);
        }
    }

    /**
     * A store call inside the application's JPA transaction is a transaction of its own on a connection of its own: the
     * application rolls back its entity change and its JDBC statement (run on the connection Hibernate exposes), and the
     * store's row stays. Were the stores' manager to reuse the connection JPA bound for the data source, its commit
     * would have committed the application's statement too.
     */
    @Test
    void aStoreCallInsideAJpaTransactionIsItsOwn() {
        DataSource source = plain();
        try (Jpa jpa = new Jpa(source)) {
            DefaultListableBeanFactory beans = new DefaultListableBeanFactory();
            beans.registerSingleton("transactionManager", jpa.manager);
            DatumStoreJdbc jdbc = DatumStoreJdbc.forApplication(source, beans.getBeanProvider(PlatformTransactionManager.class));
            EntityManager shared = SharedEntityManagerCreator.createSharedEntityManager(jpa.factory);
            new TransactionTemplate(jpa.manager).executeWithoutResult(status -> {
                shared.find(Account.class, 1L).owner = "mallory";
                shared.flush();
                new JdbcTemplate(source).update("INSERT INTO t (k, v) VALUES ('o', 'outer')");
                jdbc.update("INSERT INTO t (k, v) VALUES (?, 'store')", "a");
                status.setRollbackOnly();
            });
            JdbcTemplate read = new JdbcTemplate(source);
            assertThat(read.queryForObject("SELECT owner FROM account WHERE id = 1", String.class)).isEqualTo("ada");
            assertThat(read.queryForObject("SELECT COUNT(*) FROM t WHERE k = 'o'", Integer.class))
                .as("the application's statement is rolled back with its transaction").isZero();
            assertThat(read.queryForObject("SELECT COUNT(*) FROM t WHERE k = 'a'", Integer.class))
                .as("the store's row outlives the application's rollback").isEqualTo(1);
        }
    }

    /**
     * Beside JPA's, an application may declare a JDBC manager of the same data source and mark it {@code @Primary}. The
     * stores still take their own: a JDBC manager over the data source itself would find the connection JPA bound under
     * that key and take it for its own, so a store call inside a JPA transaction would commit the application's flushed
     * work. Only an application's sole manager is used.
     */
    @Test
    void aPrimaryJdbcManagerBesideJpasIsPassedOver() {
        DataSource source = plain();
        try (Jpa jpa = new Jpa(source); GenericApplicationContext beans = new GenericApplicationContext()) {
            JdbcTransactionManager primary = new JdbcTransactionManager(source);
            beans.registerBean("jdbcTransactionManager", PlatformTransactionManager.class, () -> primary, bean -> bean.setPrimary(true));
            beans.registerBean("transactionManager", PlatformTransactionManager.class, () -> jpa.manager);
            beans.refresh();
            DatumStoreJdbc jdbc = DatumStoreJdbc.forApplication(source, beans.getBeanProvider(PlatformTransactionManager.class));
            assertThat(jdbc.ownTransactions()).isTrue();
            EntityManager shared = SharedEntityManagerCreator.createSharedEntityManager(jpa.factory);
            new TransactionTemplate(jpa.manager).executeWithoutResult(status -> {
                shared.find(Account.class, 1L).owner = "mallory";
                shared.flush();
                jdbc.update("INSERT INTO t (k, v) VALUES (?, 'store')", "a");
                status.setRollbackOnly();
            });
            JdbcTemplate read = new JdbcTemplate(source);
            assertThat(read.queryForObject("SELECT owner FROM account WHERE id = 1", String.class)).isEqualTo("ada");
            assertThat(read.queryForObject("SELECT COUNT(*) FROM t WHERE k = 'a'", Integer.class)).isEqualTo(1);
        }
    }

    /** An application entity for the JPA tests. */
    @Entity(name = "Account")
    @Table(name = "account")
    public static class Account {
        @Id
        public Long id;
        public String owner;
    }

    /** Hibernate over the test's data source, with Spring's JPA transaction manager, as Spring Boot's JPA starter wires them. */
    private static final class Jpa implements AutoCloseable {

        final EntityManagerFactory factory;
        final JpaTransactionManager manager;

        Jpa(DataSource source) {
            JdbcTemplate setup = new JdbcTemplate(source);
            setup.execute("CREATE TABLE account (id BIGINT PRIMARY KEY, owner VARCHAR(32))");
            setup.update("INSERT INTO account (id, owner) VALUES (1, 'ada')");
            LocalContainerEntityManagerFactoryBean bean = new LocalContainerEntityManagerFactoryBean();
            bean.setDataSource(source);
            bean.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
            bean.setManagedTypes(PersistenceManagedTypes.of(Account.class.getName()));
            bean.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto", "none"));
            bean.afterPropertiesSet();
            factory = bean.getObject();
            manager = new JpaTransactionManager(factory);
            manager.afterPropertiesSet();
        }

        @Override
        public void close() {
            factory.close();
        }
    }
}
