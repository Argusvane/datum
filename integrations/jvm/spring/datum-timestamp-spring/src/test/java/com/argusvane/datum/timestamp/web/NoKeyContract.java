package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TimestampRefusal;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import org.junit.jupiter.api.Test;

/** The server is on but has no signing key: refusals in DER, 503 plain text for the certificates, health DOWN. */
public abstract class NoKeyContract extends TsaContract {

    @Test
    void aRequestIsASystemFailureRejectionWith503() throws Exception {
        Reply reply = stamp();

        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.type()).isEqualTo("application/timestamp-reply");
        assertThat(parse(reply).getFailInfo().intValue()).isEqualTo(bcMask(TimestampRefusal.FAIL_SYSTEM_FAILURE));
        assertThat(parse(reply).getStatusString()).isEqualTo("The timestamp server has no usable key.");
    }

    @Test
    void theCertificateEndpointsAre503PlainText() {
        Reply one = get(path() + "/certificate");
        Reply many = get(path() + "/certificates");

        assertThat(one.status()).isEqualTo(503);
        assertThat(one.text()).isEqualTo("The timestamp server has no certificate it can use.\n");
        assertThat(many.status()).isEqualTo(503);
        assertThat(many.text()).isEqualTo("The timestamp server has no certificate.\n");
    }

    @Test
    void theHealthCheckIsDownWithTheReason() {
        DatumHealthContributors.Status status = health.evaluate().get("datum-tsa");

        assertThat(status.up()).isFalse();
        assertThat(status.details()).containsEntry("reason", "The site has no timestamp server certificate.");
    }
}
