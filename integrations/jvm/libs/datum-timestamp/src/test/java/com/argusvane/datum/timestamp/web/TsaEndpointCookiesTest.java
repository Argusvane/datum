package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Which cookies make the timestamp server refuse a request (403). The default {@code "*"} is any cookie, the rule the
 * FastAPI host's {@code datum.tsa.session_cookies} has; a configured list refuses only its names, in any letter case.
 */
class TsaEndpointCookiesTest {

    private static int status(TsaEndpoint endpoint, String... cookies) {
        TsaEndpoint.Admission admission = endpoint.admit(
            new TsaRequest("application/timestamp-query", null, List.of(cookies), "192.0.2.1", 10));
        return admission.admitted() ? 200 : admission.refusal().status();
    }

    @Test
    void theDefaultIsAnyCookie() {
        assertThat(TsaSettings.defaults().sessionCookies()).containsExactly("*");
    }

    @Test
    void theDefaultRefusesAnyCookieAndPassesNone() {
        TsaEndpoint endpoint = endpoint(TsaSettings.defaults(), Set.of());
        assertThat(status(endpoint, "a")).as("an arbitrary cookie").isEqualTo(403);
        assertThat(status(endpoint, "theme")).isEqualTo(403);
        assertThat(status(endpoint, "JSESSIONID")).isEqualTo(403);
        assertThat(status(endpoint, "x", "y")).isEqualTo(403);
        assertThat(status(endpoint)).as("no cookie").isEqualTo(200);
    }

    @Test
    void aNamedListRefusesOnlyThoseNamesWhateverTheCase() {
        TsaEndpoint endpoint = endpoint(TsaSettings.defaults().withSessionCookies(List.of("JSESSIONID", "Sid")), Set.of());
        assertThat(status(endpoint, "jsessionid")).isEqualTo(403);
        assertThat(status(endpoint, "SID")).isEqualTo(403);
        assertThat(status(endpoint, "theme", "sid")).as("one named cookie among others").isEqualTo(403);
        assertThat(status(endpoint, "theme")).as("an unnamed cookie").isEqualTo(200);
        assertThat(status(endpoint)).isEqualTo(200);
    }

    @Test
    void aStarInAConfiguredListMeansAny() {
        TsaEndpoint endpoint = endpoint(TsaSettings.defaults().withSessionCookies(List.of("JSESSIONID", "*")), Set.of());
        assertThat(status(endpoint, "a")).isEqualTo(403);
        assertThat(status(endpoint)).isEqualTo(200);
    }

    @Test
    void anEmptyListRefusesNone() {
        TsaEndpoint endpoint = endpoint(TsaSettings.defaults().withSessionCookies(List.of()), Set.of());
        assertThat(status(endpoint, "JSESSIONID")).isEqualTo(200);
    }

    @Test
    void theHostsRenamedCookieAddsToAListAndIsRedundantBesideAStar() {
        TsaEndpoint named = endpoint(TsaSettings.defaults().withSessionCookies(List.of("JSESSIONID")), Set.of("MVCSESSION"));
        assertThat(status(named, "mvcsession")).isEqualTo(403);
        assertThat(status(named, "theme")).isEqualTo(200);
        TsaEndpoint any = endpoint(TsaSettings.defaults(), Set.of("MVCSESSION"));
        assertThat(status(any, "MVCSESSION")).isEqualTo(403);
        assertThat(status(any, "theme")).isEqualTo(403);
        assertThat(status(any)).isEqualTo(200);
    }

    private static TsaEndpoint endpoint(TsaSettings settings, Set<String> extra) {
        TsaKeyMaterial keys = TsaKeyMaterial.of(SelfSignedTsaCertificate.create("Cookies TSA"));
        Clock clock = Clock.systemUTC();
        TimestampAuthority authority = new TimestampAuthority(keys, null, null, clock, new InMemoryTsaLog(clock));
        TsaFlood open = new TsaFlood() {
            @Override
            public boolean isAllowed(String event, int limit, long windowSeconds, String identifier) {
                return true;
            }

            @Override
            public void register(String event, long windowSeconds, String identifier) {
            }
        };
        TsaClient client = new TsaClient("c-1", "Client one");
        // OPEN access so a request that gets past the cookie check is admitted without a key.
        return new TsaEndpoint(authority, key -> Optional.of(client), open, new TsaCertificates(keys, List.of()),
            settings.withAccess(TsaSettings.Access.OPEN), event -> { }, extra);
    }
}
