package com.argusvane.datum.pdf;

import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The two registries as datum-spring-web declares them, for a test context without that module's
 * auto-configuration: each collects the binding's contribution beans.
 */
@Configuration(proxyBeanMethods = false)
public class MonitoringRegistries {

    @Bean
    DatumCapabilities datumCapabilities(ObjectProvider<DatumCapability> capabilities) {
        return new DatumCapabilities(() -> capabilities.orderedStream().toList());
    }

    @Bean
    DatumHealthContributors datumHealthContributors(ObjectProvider<DatumHealthCheck> checks) {
        return new DatumHealthContributors(() -> checks.orderedStream().toList());
    }
}
