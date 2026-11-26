package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/** The one PEM certificate reader: other block types and indentation are tolerated, damage is not. */
class PemCertificatesTest {

    private final String cert = Fixtures.text("tsa.cert.pem");

    @Test
    void readsEveryCertificateAndIgnoresOtherBlocks() {
        String key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
        assertThat(PemCertificates.read(key + cert + "-----BEGIN FOO BAR-----\nAAAA\n-----END FOO BAR-----\n" + cert)).hasSize(2);
        assertThat(PemCertificates.read(null)).isEmpty();
        assertThat(PemCertificates.read("no pem here")).isEmpty();
    }

    @Test
    void anIndentedBlockIsReadNotDropped() {
        String indented = cert.lines().map(line -> "    " + line).collect(java.util.stream.Collectors.joining("\n"));
        assertThat(PemCertificates.read(indented + "\n" + cert)).hasSize(2);
    }

    @Test
    void aDamagedOrUnterminatedBlockFails() {
        assertThatThrownBy(() -> PemCertificates.read("-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PemCertificates.read(cert + "-----BEGIN CERTIFICATE-----\nAAAA\n"))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
