package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The flood rule and the wrong-key lockout count an IPv6 client by its /64 and an IPv4-mapped address as its IPv4
 * address, as the FastAPI host does: one host handed a whole /64 cannot walk past either by changing address.
 */
class TsaEndpointAddressTest {

    /** A counter that never forgets within the test, and the identifiers it was asked about. */
    private static final class Counting implements TsaFlood {

        final Map<String, Integer> counts = new HashMap<>();
        final List<String> identifiers = new ArrayList<>();

        @Override
        public boolean isAllowed(String event, int limit, long windowSeconds, String identifier) {
            identifiers.add(identifier);
            return counts.getOrDefault(event + "\u0000" + identifier, 0) < limit;
        }

        @Override
        public void register(String event, long windowSeconds, String identifier) {
            counts.merge(event + "\u0000" + identifier, 1, Integer::sum);
        }
    }

    private static int status(TsaEndpoint endpoint, String authorization, String address) {
        TsaEndpoint.Admission admission = endpoint.admit(new TsaRequest("application/timestamp-query", authorization, List.of(), address, 10));
        return admission.admitted() ? 200 : admission.refusal().status();
    }

    @Test
    void theFloodRuleHoldsAcrossTheAddressesOfOne64AndAMappedAddressIsItsIpv4() {
        Counting flood = new Counting();
        TsaEndpoint endpoint = endpoint(TsaSettings.defaults().withAccess(TsaSettings.Access.OPEN).withFloodLimit(2), flood);
        assertThat(status(endpoint, null, "2001:db8:1:2::1")).isEqualTo(200);
        assertThat(status(endpoint, null, "2001:db8:1:2::2")).isEqualTo(200);
        assertThat(status(endpoint, null, "2001:db8:1:2::3")).isEqualTo(429);
        assertThat(status(endpoint, null, "2001:db8:1:3::1")).isEqualTo(200);
        assertThat(status(endpoint, null, "198.51.100.9")).isEqualTo(200);
        assertThat(status(endpoint, null, "::ffff:198.51.100.9")).isEqualTo(200);
        assertThat(status(endpoint, null, "198.51.100.9")).isEqualTo(429);
        assertThat(flood.identifiers).contains("2001:db8:1:2::/64", "2001:db8:1:3::/64", "198.51.100.9")
            .doesNotContain("2001:db8:1:2::1", "::ffff:198.51.100.9");
    }

    @Test
    void theWrongKeyLockoutHoldsAcrossTheAddressesOfOne64() {
        TsaEndpoint endpoint = endpoint(TsaSettings.defaults().withAccess(TsaSettings.Access.CLIENTS).withFailedKeysPerHour(2), new Counting());
        assertThat(List.of(
            status(endpoint, "Bearer dtsa_wrong0", "2001:db8:1:2::1"),
            status(endpoint, "Bearer dtsa_wrong1", "2001:db8:1:2::2"),
            status(endpoint, "Bearer dtsa_wrong2", "2001:db8:1:2::3"))).containsExactly(401, 401, 429);
        assertThat(status(endpoint, "Bearer dtsa_wrong3", "2001:db8:1:3::1")).isEqualTo(401);
    }

    private static TsaEndpoint endpoint(TsaSettings settings, TsaFlood flood) {
        TsaKeyMaterial keys = TsaKeyMaterial.of(SelfSignedTsaCertificate.create("Address TSA"));
        Clock clock = Clock.systemUTC();
        TimestampAuthority authority = new TimestampAuthority(keys, null, null, clock, new InMemoryTsaLog(clock));
        // No key is known, so every key presented is a wrong one.
        return new TsaEndpoint(authority, key -> Optional.empty(), flood, new TsaCertificates(keys, List.of()), settings, event -> { }, Set.of());
    }
}
