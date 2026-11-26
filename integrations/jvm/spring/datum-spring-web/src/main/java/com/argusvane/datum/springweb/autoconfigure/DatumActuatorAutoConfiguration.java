package com.argusvane.datum.springweb.autoconfigure;

import com.argusvane.datum.springweb.spring.DatumHealthContributor;
import com.argusvane.datum.springweb.spring.DatumInfoContributor;
import com.argusvane.datum.web.assets.DatumAssets;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import org.springframework.boot.actuate.autoconfigure.info.ConditionalOnEnabledInfoContributor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.health.autoconfigure.contributor.ConditionalOnEnabledHealthIndicator;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthContributor;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The {@code datum} health contributor and {@code info.datum}, when actuator is on the classpath. The capabilities
 * contribute {@code DatumHealthCheck} and {@code DatumCapability} beans, which {@link DatumHealthContributors} and
 * {@link DatumCapabilities} collect.
 *
 * <p>The health is a {@link DatumHealthContributor} composite, one member per check, so
 * {@code management.endpoint.health.group.readiness.include=readinessState,datum/runtime} keeps a TSA or passkey problem
 * out of readiness; the standard switches work ({@code management.health.datum.enabled},
 * {@code management.info.datum.enabled}, and the {@code defaults} switches of both). The actuator JSON lists the checks under
 * {@code components.datum.components.<check>}. Each half sits in its own
 * nested configuration behind its own classes, so an application with the health module and no actuator auto-configuration
 * (or the reverse) gets the half it can serve.
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
public final class DatumActuatorAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = {
        "org.springframework.boot.health.contributor.CompositeHealthContributor",
        "org.springframework.boot.health.autoconfigure.contributor.ConditionalOnEnabledHealthIndicator"})
    static class HealthConfiguration {

        /**
         * Named {@code datumHealthIndicator}, so Boot calls it {@code datum} and an application bean of that name still
         * replaces it. With no check contributed (datum-spring-web alone), a plain UP indicator: an empty
         * composite would read UNKNOWN.
         */
        @Bean
        @ConditionalOnMissingBean(name = "datumHealthIndicator")
        @ConditionalOnEnabledHealthIndicator("datum")
        HealthContributor datumHealthIndicator(DatumHealthContributors contributors) {
            if (contributors.isEmpty()) {
                return (HealthIndicator) () -> Health.up().build();
            }
            return new DatumHealthContributor(contributors);
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = {
        "org.springframework.boot.actuate.info.InfoContributor",
        "org.springframework.boot.actuate.autoconfigure.info.ConditionalOnEnabledInfoContributor"})
    static class InfoConfiguration {

        @Bean
        @ConditionalOnEnabledInfoContributor("datum")
        DatumInfoContributor datumInfoContributor(DatumAssets assets, DatumCapabilities capabilities) {
            return new DatumInfoContributor(assets, capabilities);
        }
    }
}
