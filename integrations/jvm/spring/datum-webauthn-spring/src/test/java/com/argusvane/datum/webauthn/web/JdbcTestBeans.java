package com.argusvane.datum.webauthn.web;

import java.util.UUID;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

/** The SQL stores: one H2 database with the shipped V400 migration, and nothing acknowledged. */
@Configuration(proxyBeanMethods = false)
public class JdbcTestBeans {

    /** The stores take the DataSource (on Spring's JDBC). */
    @Bean
    javax.sql.DataSource dataSource() {
        DriverManagerDataSource source = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
        new ResourceDatabasePopulator(new ClassPathResource("META-INF/datum/db/migration/h2/V400__datum_webauthn.sql")).execute(source);
        return source;
    }

    @Bean
    JdbcTemplate jdbcTemplate(javax.sql.DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }
}
