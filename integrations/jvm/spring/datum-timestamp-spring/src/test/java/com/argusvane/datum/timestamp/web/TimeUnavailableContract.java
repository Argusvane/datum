package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TimestampRefusal;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import org.bouncycastle.asn1.cmp.PKIFailureInfo;
import org.bouncycastle.tsp.TimeStampResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * An application's own TsaTimeSource that says the clock cannot be trusted: POST answers 503 with RFC 3161's
 * timeNotAvailable (a rejection any client reads), the refusal event carries the failInfo, the health check is DOWN
 * with the reason, and the server recovers when the source does. Self-signed key, open access, on both stacks.
 */
public abstract class TimeUnavailableContract extends TsaContract {

    @Autowired
    SwitchableTimeSource time;

    @AfterEach
    void restore() {
        time.available();
    }

    @Test
    void anUnavailableTimeSourceAnswers503WithTimeNotAvailableAndPublishesTheFailInfo() throws Exception {
        time.unavailable("the system clock is 4 s from the reference");
        int issuedBefore = events.issued.size();

        Reply reply = stamp();

        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.type()).isEqualTo("application/timestamp-reply");
        TimeStampResponse response = parse(reply);
        assertThat(response.getStatus()).isEqualTo(2);
        assertThat(response.getFailInfo().intValue()).isEqualTo(PKIFailureInfo.timeNotAvailable).isEqualTo(bcMask(TimestampRefusal.FAIL_TIME_NOT_AVAILABLE));
        assertThat(response.getStatusString()).contains("time source is not available").contains("4 s from the reference");
        assertThat(events.refused).isNotEmpty();
        TimestampRefusedEvent event = events.refused.get(events.refused.size() - 1);
        assertThat(event.failInfo()).isEqualTo(TimestampRefusal.FAIL_TIME_NOT_AVAILABLE);
        assertThat(event.failName()).isEqualTo("timeNotAvailable");
        assertThat(events.issued).hasSize(issuedBefore);
    }

    @Test
    void theHealthCheckIsDownWithTheReasonWhileTheSourceIsUnavailableAndUpAgain() {
        assertThat(health.evaluate().get("datum-tsa").up()).isTrue();

        time.unavailable("drift 4 s");
        DatumHealthContributors.Status down = health.evaluate().get("datum-tsa");
        assertThat(down.up()).isFalse();
        assertThat(down.details()).containsEntry("time", "unavailable (drift 4 s)");

        time.available();
        DatumHealthContributors.Status up = health.evaluate().get("datum-tsa");
        assertThat(up.up()).isTrue();
        assertThat(up.details()).containsEntry("time", "available");
        assertThat(stamp().status()).isEqualTo(200);
    }
}
