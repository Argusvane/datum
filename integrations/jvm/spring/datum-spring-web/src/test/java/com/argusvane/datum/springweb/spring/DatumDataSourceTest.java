package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Which database the stores take, and when they have one. */
class DatumDataSourceTest {

    private static DataSource named(String name) {
        return new DriverManagerDataSource("jdbc:h2:mem:" + name, "sa", "");
    }

    /** What a store configuration looks like: a bean on the condition that picks its data source as the stores do. */
    static class Store {
        private final DataSource dataSource;

        Store(DataSource dataSource) {
            this.dataSource = dataSource;
        }

        String url() {
            return ((DriverManagerDataSource) dataSource).getUrl();
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class Stores {
        @Bean
        @ConditionalOnDatumDataSource
        Store store(@DatumDataSource ObjectProvider<DataSource> qualified, ObjectProvider<DataSource> any) {
            return new Store(DatumDataSources.choose(qualified, any));
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class One {
        @Bean
        DataSource only() {
            return named("only");
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class TwoPlain {
        @Bean
        DataSource first() {
            return named("first");
        }

        @Bean
        DataSource second() {
            return named("second");
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class TwoWithAPrimary {
        @Bean
        DataSource first() {
            return named("first");
        }

        @Bean
        @Primary
        DataSource main() {
            return named("main");
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class TwoWithAQualified {
        @Bean
        @Primary
        DataSource application() {
            return named("application");
        }

        @Bean
        @DatumDataSource
        DataSource forDatum() {
            return named("datum");
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class NamedForDatum {
        @Bean
        DataSource application() {
            return named("application");
        }

        @Bean
        DataSource datumDataSource() {
            return named("bynamed");
        }
    }

    /** The stores come from an auto-configuration, so they are registered after the application's own data sources, as here. */
    private final ApplicationContextRunner runner = new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(Stores.class));

    @Test
    void theSingleDataSourceIsTaken() {
        runner.withUserConfiguration(One.class).run(context -> assertThat(context.getBean(Store.class).url()).endsWith("only"));
    }

    @Test
    void aPrimaryAmongSeveralIsTaken() {
        runner.withUserConfiguration(TwoWithAPrimary.class).run(context -> assertThat(context.getBean(Store.class).url()).endsWith("main"));
    }

    @Test
    void twoPlainDataSourcesAndNoneMarkedLeaveTheStoresOut() {
        runner.withUserConfiguration(TwoPlain.class).run(context -> assertThat(context).doesNotHaveBean(Store.class));
    }

    @Test
    void theMarkedOneIsTakenBesideAPrimaryAndAmongPlainOnes() {
        runner.withUserConfiguration(TwoWithAQualified.class).run(context -> assertThat(context.getBean(Store.class).url()).endsWith("datum"));
        runner.withUserConfiguration(TwoPlain.class, MarkedAmongPlain.class)
            .run(context -> assertThat(context.getBean(Store.class).url()).endsWith("marked"));
    }

    @Test
    void aBeanNamedForTheQualifierIsTakenToo() {
        runner.withUserConfiguration(NamedForDatum.class).run(context -> assertThat(context.getBean(Store.class).url()).endsWith("bynamed"));
    }

    @Configuration(proxyBeanMethods = false)
    static class MarkedAmongPlain {
        @Bean
        @DatumDataSource
        DataSource marked() {
            return named("marked");
        }
    }
}
