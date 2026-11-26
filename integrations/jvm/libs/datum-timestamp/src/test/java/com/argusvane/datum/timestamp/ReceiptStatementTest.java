package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** The receipt statement's shape: six members in RFC 8785 order, imprint SHA-256. */
class ReceiptStatementTest {

    @Test
    void sixMembersInJcsOrder() {
        ReceiptStatement statement = new ReceiptStatement("petition", "PET-0007", 7, Instant.parse("2026-10-05T12:00:01.900Z"),
            "sha256:abc", JsonMapper.builder().build().readTree("{\"webauthn\":{\"z\":1,\"a\":\"\\u00e9\"},\"credentialId\":\"x\"}"));
        assertThat(statement.canonical()).isEqualTo("{\"digest\":\"sha256:abc\",\"form\":\"petition\",\"received\":\"2026-10-05T12:00:01Z\","
            + "\"reference\":\"PET-0007\",\"serial\":7,\"signature\":{\"credentialId\":\"x\",\"webauthn\":{\"a\":\"\u00e9\",\"z\":1}}}");
        assertThat(new ReceiptStatement("f", "R", 1, Instant.EPOCH, "d", null).canonical())
            .isEqualTo("{\"digest\":\"d\",\"form\":\"f\",\"received\":\"1970-01-01T00:00:00Z\",\"reference\":\"R\",\"serial\":1,\"signature\":null}");
    }

    @Test
    void theImprintIsTheSha256OfTheStatementBytes() {
        ReceiptStatement statement = new ReceiptStatement("f", "R", 1, Instant.EPOCH, "d", null);
        assertThat(statement.imprint()).isEqualTo(TimestampQuery.digest("sha256", statement.bytes()));
        TimestampQuery query = TimestampQuery.parse(statement.query());
        assertThat(query.hash()).isEqualTo(statement.imprint());
        assertThat(query.certReq()).isTrue();
    }
}
