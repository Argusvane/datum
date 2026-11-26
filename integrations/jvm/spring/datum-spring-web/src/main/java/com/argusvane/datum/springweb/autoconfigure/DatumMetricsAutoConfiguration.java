package com.argusvane.datum.springweb.autoconfigure;

import com.argusvane.datum.web.monitoring.DatumMeters;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/**
 * {@link DatumMeters}, the helper the capabilities register their meters through, when Micrometer is on the
 * classpath. It reads the {@code MeterRegistry} lazily, so it works whichever auto-configuration creates it.
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class)
@ConditionalOnClass(MeterRegistry.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
public final class DatumMetricsAutoConfiguration {

    @Bean
    DatumMeters datumMeters(ObjectProvider<MeterRegistry> registry) {
        return DatumMeters.lazy(registry::getIfAvailable);
    }
}
