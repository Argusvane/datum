package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TimestampQuery;
import com.argusvane.datum.timestamp.TimestampRefusal;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@code datum.tsa.accepted-policies}: a request may ask for the issuing policy or one of the listed ones, and the
 * token names the policy asked for; any other is an unacceptedPolicy rejection that lists what is accepted.
 */
@SpringBootTest(classes = TsaMvcTestApp.class, properties = {
    "datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true",
    "datum.tsa.access=open",
    "datum.tsa.signer.self-signed=true",
    "datum.tsa.policy=1.2.3.4",
    "datum.tsa.accepted-policies[0]=1.2.3.5",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcAcceptedPoliciesTest extends TsaContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected Reply send(String method, String path, byte[] body, String... headers) {
        return MvcTransport.send(mvc, method, path, body, headers);
    }

    private Reply ask(String policy) {
        return post(TimestampQuery.forData("x".getBytes(StandardCharsets.UTF_8), "sha256", true, null, policy));
    }

    @Test
    void theIssuingAndTheListedPoliciesAreAcceptedAndNamedInTheToken() throws Exception {
        assertThat(ask("1.2.3.4").status()).isEqualTo(200);
        Reply listed = ask("1.2.3.5");
        assertThat(listed.status()).isEqualTo(200);
        assertThat(parse(listed).getTimeStampToken().getTimeStampInfo().getPolicy().getId()).isEqualTo("1.2.3.5");
        assertThat(parse(post(TimestampQuery.forData("x".getBytes(StandardCharsets.UTF_8)))).getTimeStampToken().getTimeStampInfo().getPolicy().getId())
            .as("no policy asked for: the issuing one").isEqualTo("1.2.3.4");
    }

    @Test
    void anotherPolicyIsRefusedAndTheMessageListsTheAcceptedOnes() throws Exception {
        Reply other = ask("1.2.3.6");
        assertThat(other.status()).isEqualTo(400);
        assertThat(parse(other).getFailInfo().intValue()).isEqualTo(bcMask(TimestampRefusal.FAIL_UNACCEPTED_POLICY));
        assertThat(parse(other).getStatusString()).contains("1.2.3.4").contains("1.2.3.5");
    }
}
