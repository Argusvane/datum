package com.argusvane.datum.springweb.autoconfigure;

import com.argusvane.datum.springweb.spring.DatumJdbcProperties;
import com.argusvane.datum.springweb.spring.JdbcSchemaInitializer;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.sql.init.DatabaseInitializationMode;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

/**
 * The one {@link JdbcSchemaInitializer} the JDBC stores of every Datum module share, with {@code datum.jdbc.initialize-schema}
 * (done once here for the four bindings that have stores, where Spring Session
 * has one per module). Each store's bean method asks it for its module's tables, so the bindings need no setting of their own.
 * Present wherever Spring's JDBC and Boot's SQL initialisation are; without them the stores find no initializer and leave the
 * schema to the application. An application's own {@code JdbcSchemaInitializer} bean replaces it.
 */
@AutoConfiguration
@ConditionalOnClass({DataSource.class, ResourceDatabasePopulator.class, DatabaseInitializationMode.class})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties(DatumJdbcProperties.class)
public final class DatumJdbcAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    JdbcSchemaInitializer datumJdbcSchemaInitializer(DatumJdbcProperties properties) {
        return new JdbcSchemaInitializer(properties.getInitializeSchema());
    }
}
