package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.timestamp.web.TsaHealth;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.bouncycastle.tsp.TimeStampResponse;
import org.junit.jupiter.api.Test;

/** The time source hook: RFC 3161's timeNotAvailable when the TSA cannot trust its clock. */
class TsaTimeSourceTest {

    private static final Instant NOW = Fixtures.OCT_5;

    private static TimestampAuthority authority(TsaTimeSource source, AtomicInteger serials) {
        return new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("tsa")), null, null, source, entry -> serials.incrementAndGet(), List.of(), List.of(),
            DatumObservations.none());
    }

    @Test
    void theDefaultSourceWrapsTheClockAndIsAlwaysAvailable() {
        assertThat(TsaTimeSource.of(Fixtures.clock(NOW)).read()).isEqualTo(TsaTimeSource.Reading.available(NOW));
        AtomicInteger serials = new AtomicInteger();
        TimestampResponse issued = authority(TsaTimeSource.of(Fixtures.clock(NOW)), serials)
            .issue(TimestampQuery.parse(TimestampQuery.forData("x".getBytes())));
        assertThat(issued.serial()).isEqualTo(1);
    }

    @Test
    void anUnavailableSourceRefusesWithTimeNotAvailableBeforeAKeyIsLoadedOrASerialTaken() throws Exception {
        AtomicInteger serials = new AtomicInteger();
        TimestampAuthority authority = authority(() -> TsaTimeSource.Reading.unavailable("the system clock drifted 4.2 s from the reference"), serials);

        assertThatThrownBy(() -> authority.issue(TimestampQuery.parse(TimestampQuery.forData("x".getBytes()))))
            .isInstanceOfSatisfying(TimestampRefusedException.class, refused -> {
                assertThat(refused.failInfo()).isEqualTo(TimestampRefusal.FAIL_TIME_NOT_AVAILABLE);
                assertThat(refused.httpStatus()).isEqualTo(503);
                assertThat(refused.getMessage()).contains("time source is not available").contains("drifted 4.2 s");
            });
        assertThat(serials).hasValue(0);

        TimestampReply reply = authority.respond(TimestampQuery.forData("x".getBytes()), null);
        assertThat(reply.status()).isEqualTo(503);
        TimeStampResponse read = new TimeStampResponse(reply.body());
        assertThat(read.getStatus()).isEqualTo(2);
        assertThat(read.getFailInfo().intValue()).isEqualTo(org.bouncycastle.asn1.cmp.PKIFailureInfo.timeNotAvailable);
        assertThat(read.getStatusString()).contains("drifted 4.2 s");
    }

    @Test
    void aReasonWithAnUnpairedSurrogateStillAnswersWithTheRefusal() throws Exception {
        TimestampAuthority authority = authority(() -> TsaTimeSource.Reading.unavailable("cut off \ud800"), new AtomicInteger());
        TimestampReply reply = authority.respond(TimestampQuery.forData("x".getBytes()), null);
        assertThat(reply.status()).isEqualTo(503);
        assertThat(new TimeStampResponse(reply.body()).getStatusString()).contains("cut off ?");
        assertThat(((TsaTimeSource.Unavailable) TsaTimeSource.Reading.unavailable("x".repeat(500))).reason()).hasSize(200);
    }

    @Test
    void aSourceThatThrowsIsUnavailableAndItsMessageStaysOutOfTheReply() {
        TimestampAuthority authority = authority(() -> {
            throw new IllegalStateException("ntp.internal.example:123 unreachable");
        }, new AtomicInteger());
        assertThatThrownBy(() -> authority.issue(TimestampQuery.parse(TimestampQuery.forData("x".getBytes()))))
            .isInstanceOfSatisfying(TimestampRefusedException.class, refused -> {
                assertThat(refused.failInfo()).isEqualTo(TimestampRefusal.FAIL_TIME_NOT_AVAILABLE);
                assertThat(refused.getMessage()).doesNotContain("ntp.internal.example");
            });
    }

    @Test
    void theSourceRecoversAndTokensFlowAgain() {
        AtomicReference<TsaTimeSource.Reading> reading = new AtomicReference<>(TsaTimeSource.Reading.unavailable("drift"));
        AtomicInteger serials = new AtomicInteger();
        TimestampAuthority authority = authority(reading::get, serials);
        TimestampQuery query = TimestampQuery.parse(TimestampQuery.forData("x".getBytes()));
        assertThatThrownBy(() -> authority.issue(query)).isInstanceOf(TimestampRefusedException.class);
        reading.set(TsaTimeSource.Reading.available(NOW));
        assertThat(authority.issue(query).serial()).isEqualTo(1);
    }

    @Test
    void healthIsDownWithTheReasonWhileTheSourceIsUnavailableAndUpOtherwise() {
        AtomicReference<TsaTimeSource.Reading> reading = new AtomicReference<>(TsaTimeSource.Reading.unavailable("drift 4 s"));
        TsaHealth health = new TsaHealth(TsaKeyMaterial.of(Fixtures.key("tsa")), reading::get, "jdbc", "open");

        var down = health.status();
        assertThat(down.up()).isFalse();
        assertThat(down.details()).containsEntry("time", "unavailable (drift 4 s)");
        assertThat(String.valueOf(down.details().get("reason"))).contains("drift 4 s");

        reading.set(TsaTimeSource.Reading.available(NOW));
        var up = health.status();
        assertThat(up.up()).isTrue();
        assertThat(up.details()).containsEntry("time", "available");
    }
}
