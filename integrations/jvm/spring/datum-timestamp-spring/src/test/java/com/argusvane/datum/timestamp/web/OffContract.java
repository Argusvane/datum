package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TimestampAuthority;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;

/** datum.tsa.enabled is not set: no endpoint, no beans, the paths are the application's. */
public abstract class OffContract extends TsaContract {

    @Autowired
    ApplicationContext context;

    @Test
    void everyPathIs404AndNoBeanIsMade() {
        assertThat(stamp().status()).isEqualTo(404);
        assertThat(get(path() + "/certificate").status()).isEqualTo(404);
        assertThat(get(path() + "/certificates").status()).isEqualTo(404);
        assertThat(context.getBeanNamesForType(TsaEndpoint.class)).isEmpty();
        assertThat(context.getBeanNamesForType(TimestampAuthority.class)).isEmpty();
        assertThat(health.evaluate()).doesNotContainKey("datum-tsa");
    }
}
