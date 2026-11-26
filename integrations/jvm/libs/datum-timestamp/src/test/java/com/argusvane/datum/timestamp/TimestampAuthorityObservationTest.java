package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.RecordingObservations;
import io.micrometer.observation.Observation;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Every token asked of the in-process authority is one {@code datum.tsa.issue} observation, with its
 * channel and {@code granted} or the refusal's RFC 3161 failure name, under whatever observation asked (the HTTP request's,
 * a PDF seal's); the request's parse is inside it, so a malformed request is observed too. No serial, no key and no digest
 * is a key of it.
 */
class TimestampAuthorityObservationTest {

    private static final byte[] DATA = "A document the server never sees.".getBytes(StandardCharsets.US_ASCII);

    private final RecordingObservations recording = new RecordingObservations();

    private TimestampAuthority authority() {
        return new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("tsa")), null, null, TsaTimeSource.of(Fixtures.clock(Fixtures.OCT_5)),
            new InMemoryTsaLog(Fixtures.clock(Fixtures.OCT_5), 1000, 1), List.of(), List.of(), recording.observations());
    }

    @Test
    void eachTokenIsOneObservationWithItsChannelAndOutcome() {
        TimestampAuthority authority = authority();
        assertThat(authority.respond(TimestampQuery.forData(DATA), "c-1").granted()).isTrue();
        authority.stamp(DATA, "receipt");
        assertThat(authority.respond("not a TimeStampReq".getBytes(StandardCharsets.US_ASCII), null).granted()).isFalse();
        assertThatThrownBy(() -> authority.issue(TimestampQuery.parse(TimestampQuery.forData(DATA, "sha256", true, null, "1.2.3.4")), null, "sealing"))
            .isInstanceOf(TimestampRefusedException.class);

        List<RecordingObservations.Recorded> issued = recording.named(DatumObservationNames.TSA_ISSUE);
        assertThat(issued).extracting(one -> one.low("channel")).containsExactly("http", "receipt", "http", "sealing");
        assertThat(issued).extracting(one -> one.low("outcome")).containsExactly("granted", "granted", "badDataFormat", "unacceptedPolicy");
        assertThat(issued.get(2).error()).isInstanceOf(TimestampRefusedException.class);
        assertThat(issued).allSatisfy(one -> {
            assertThat(one.low().keySet()).containsExactlyInAnyOrder("channel", "outcome");
            assertThat(one.high()).isEmpty();
        });
    }

    @Test
    void theHostsOwnTokenIsAChildOfWhatAskedForIt() {
        TimestampAuthority authority = authority();
        Observation seal = Observation.start("datum.pdf", recording.registry());
        try (Observation.Scope ignored = seal.openScope()) {
            authority.stamp(DATA, "sealing");
        }
        seal.stop();
        assertThat(recording.named(DatumObservationNames.TSA_ISSUE)).singleElement()
            .satisfies(one -> assertThat(one.parent()).isEqualTo("datum.pdf"));
    }
}
