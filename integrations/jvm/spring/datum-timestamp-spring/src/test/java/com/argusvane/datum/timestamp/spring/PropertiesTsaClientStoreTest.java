package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaClientKeys;
import com.argusvane.datum.timestamp.web.PropertiesTsaClientStore;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class PropertiesTsaClientStoreTest {

    @Test
    void aKeyIsRecognisedByItsHashAndOthersAreNot() {
        String key = TsaClientKeys.generate();
        PropertiesTsaClientStore store = new PropertiesTsaClientStore(List.of(TsaClientKeys.hash(key).toUpperCase(java.util.Locale.ROOT)));

        TsaClient client = store.authenticate(key).orElseThrow();
        assertThat(client.id()).isEqualTo(TsaClientKeys.hash(key).substring(0, 12));
        assertThat(client.label()).isEqualTo("client " + client.id());
        assertThat(store.authenticate(TsaClientKeys.generate())).isEmpty();
        assertThat(store.authenticate(null)).isEmpty();
        assertThat(store.authenticate("")).isEmpty();
    }

    @Test
    void anEntryMayBeLabelled() {
        String key = TsaClientKeys.generate();
        PropertiesTsaClientStore store = new PropertiesTsaClientStore(Arrays.asList(" ", null, "Billing = " + TsaClientKeys.hash(key)));

        assertThat(store.size()).isEqualTo(1);
        assertThat(store.authenticate(key).orElseThrow().label()).isEqualTo("Billing");
    }

    @Test
    void anEntryThatIsNotAHashStopsTheStart() {
        assertThatThrownBy(() -> new PropertiesTsaClientStore(List.of("dtsa_this-is-a-key-not-a-hash")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("SHA-256")
            .satisfies(e -> assertThat(e.getMessage()).doesNotContain("dtsa_this"));
    }
}
