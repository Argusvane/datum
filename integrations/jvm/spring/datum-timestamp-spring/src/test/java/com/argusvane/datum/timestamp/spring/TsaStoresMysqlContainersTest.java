package com.argusvane.datum.timestamp.spring;

import javax.sql.DataSource;
import org.junit.jupiter.api.Tag;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.mysql.MySQLContainer;

/**
 * {@link TsaStoresContainersContract} on a real Mysql. Tagged {@code containers}:
 * it runs in the {@code containers} profile and is skipped where Docker does not answer.
 */
@Tag("containers")
@Testcontainers(disabledWithoutDocker = true)
class TsaStoresMysqlContainersTest extends TsaStoresContainersContract {

    @Container
    static final MySQLContainer MYSQL = new MySQLContainer("mysql:8.4");

    @Override
    protected DataSource database() throws Exception {
        return DatumContainerDatabases.fresh(MYSQL);
    }
}
