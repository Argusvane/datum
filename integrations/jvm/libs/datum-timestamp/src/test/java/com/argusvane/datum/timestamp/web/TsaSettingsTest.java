package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.time.Clock;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The multi-process policy for the in-memory serial store, the passkey stores' rule. */
class TsaSettingsTest {

    private static TsaSettings with(boolean allow) {
        TsaSettings d = TsaSettings.defaults();
        return new TsaSettings(d.enabled(), d.path(), d.access(), d.policy(), d.accuracy(), d.maxRequestBytes(), d.floodLimit(), d.floodWindow(),
            d.signer(), d.clientStore(), d.clients(), d.retiredCertificates(), d.sessionCookies(), allow, d.acceptedPolicies(),
            d.failedKeysPerHour());
    }

    @Test
    void theDefaultRefusesAndNamesThePropertyAndTheMigration() {
        assertThat(TsaSettings.defaults().allowMemoryStores()).isFalse();
        assertThatThrownBy(() -> TsaSettings.defaults().acknowledgeMemoryStore("serial allocator (datum_tsa_log)", "serials repeat"))
            .isInstanceOf(com.argusvane.datum.core.DatumConfigurationException.class)
            .hasMessage("datum.tsa has no SQL store for its serial allocator (datum_tsa_log), and the in-memory one is refused because serials repeat. "
                + "Add one DataSource and run META-INF/datum/db/migration/<dialect>/V300__datum_timestamp.sql, define your own TsaSerialAllocator bean, "
                + "or set datum.tsa.allow-memory-stores=true to acknowledge a single instance.");
    }

    @Test
    void theAcknowledgementLetsItThrough() {
        assertThatCode(() -> with(true).acknowledgeMemoryStore("serial allocator (datum_tsa_log)", "serials repeat")).doesNotThrowAnyException();
    }

    @Test
    void theStartupCheckStillWarnsForTheInMemoryAllocator() {
        List<DatumStartupCheck.Notice> notices = InMemoryTsaLog.startupCheck(new InMemoryTsaLog(Clock.systemUTC())).check();
        assertThat(notices).singleElement().satisfies(n -> {
            assertThat(n.logger()).isEqualTo("datum.tsa");
            assertThat(n.message()).startsWith("The timestamp server takes serial numbers from memory");
        });
    }

    @Test
    void healthSaysWhereSerialsComeFrom() throws Exception {
        TsaKeyMaterial keys = TsaKeyMaterial.of(SelfSignedTsaCertificate.create("Health TSA"));
        assertThat(new TsaHealth(keys, Clock.systemUTC(), "memory", "open").status().details()).containsEntry("serials", "memory (acknowledged)");
        assertThat(new TsaHealth(keys, Clock.systemUTC(), "jdbc", "open").status().details()).containsEntry("serials", "jdbc");
    }
}
