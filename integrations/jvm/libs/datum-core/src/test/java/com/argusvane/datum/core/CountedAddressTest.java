package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The address a counter keys on: an IPv6 client by its /64, an IPv4 client (mapped or not) by its address, anything else
 * as it is. The first ten cases are the FastAPI host's, so both hosts count one client under one key.
 */
class CountedAddressTest {

    static Stream<Arguments> addresses() {
        return Stream.of(
            Arguments.of("203.0.113.7", "203.0.113.7"),
            Arguments.of("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"),
            Arguments.of("2001:DB8:1:2::1", "2001:db8:1:2::/64"),
            Arguments.of("2001:db8:1:3::1", "2001:db8:1:3::/64"),
            Arguments.of("::ffff:203.0.113.7", "203.0.113.7"),
            Arguments.of("::1", "::/64"),
            Arguments.of("fe80::1%eth0", "fe80::/64"),
            Arguments.of("testclient", "testclient"),
            Arguments.of("", ""),
            Arguments.of(null, null),
            // The servlet container's long form of loopback, and the hex form of a mapped address.
            Arguments.of("0:0:0:0:0:0:0:1", "::/64"),
            Arguments.of("::ffff:cb00:7107", "203.0.113.7"),
            Arguments.of("2001:0db8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2::/64"),
            Arguments.of("0:0:1:0:ffff::", "0:0:1::/64"),
            Arguments.of("1:2:3:4:5:6:1.2.3.4", "1:2:3:4::/64"),
            Arguments.of("1:2:3:4:5:6:7::", "1:2:3:4::/64"),
            // A bracketed literal, as Spring's forwarded-header handling leaves an IPv6 client (with the port an
            // X-Forwarded-For entry may carry): counted by what is inside the brackets.
            Arguments.of("[::1]", "::/64"),
            Arguments.of("[2001:db8:1:2::1]", "2001:db8:1:2::/64"),
            Arguments.of("[2001:DB8:1:2:aaaa:bbbb:cccc:dddd]:8443", "2001:db8:1:2::/64"),
            Arguments.of("[::ffff:203.0.113.7]", "203.0.113.7"),
            Arguments.of("[fe80::1%eth0]:1", "fe80::/64"),
            Arguments.of("[2001:db8:1:2::1]:65535", "2001:db8:1:2::/64"),
            Arguments.of("[203.0.113.7:4711]", "203.0.113.7"),
            Arguments.of("[203.0.113.7:65535]", "203.0.113.7"),
            // Not an IPv6 address: counted as it is, never resolved.
            Arguments.of("localhost", "localhost"),
            Arguments.of("example.invalid", "example.invalid"),
            Arguments.of("[localhost]", "[localhost]"),
            Arguments.of("[203.0.113.7]", "[203.0.113.7]"),
            Arguments.of("[]", "[]"),
            Arguments.of("[203.0.113.7:65536]", "[203.0.113.7:65536]"),
            Arguments.of("[203.0.113.07:80]", "[203.0.113.07:80]"),
            Arguments.of("[203.0.113.7:80:80]", "[203.0.113.7:80:80]"),
            Arguments.of("[203.0.113.7]:80", "[203.0.113.7]:80"),
            Arguments.of("[::1", "[::1"),
            Arguments.of("::1]", "::1]"),
            Arguments.of("[[::1]]", "[[::1]]"),
            Arguments.of("[fe80::1%a]b]", "[fe80::1%a]b]"),
            Arguments.of("[::1]]", "[::1]]"),
            Arguments.of("[::1]:", "[::1]:"),
            Arguments.of("[::1]:x", "[::1]:x"),
            Arguments.of("[::1]:+80", "[::1]:+80"),
            Arguments.of("[::1]:123456", "[::1]:123456"),
            Arguments.of("[::1]:65536", "[::1]:65536"),
            Arguments.of("[::1]8080", "[::1]8080"),
            Arguments.of("[2001:db8:1:2::/64]", "[2001:db8:1:2::/64]"),
            Arguments.of(":::", ":::"),
            Arguments.of("1::2::3", "1::2::3"),
            Arguments.of("1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"),
            Arguments.of("1:2:3:4::5:6:7:8", "1:2:3:4::5:6:7:8"),
            Arguments.of("12345::1", "12345::1"),
            Arguments.of("::ffff:203.0.113.007", "::ffff:203.0.113.007"),
            Arguments.of("fe80::1%", "fe80::1%"),
            Arguments.of("fe80::1%a%b", "fe80::1%a%b"),
            Arguments.of("2001:db8:1:2::/64", "2001:db8:1:2::/64"),
            Arguments.of("unix:/run/app.sock", "unix:/run/app.sock"));
    }

    @ParameterizedTest
    @MethodSource("addresses")
    void theCountedAddress(String address, String counted) {
        assertThat(CountedAddress.of(address)).isEqualTo(counted);
    }

    @ParameterizedTest
    @MethodSource("addresses")
    void countingTwiceIsCountingOnce(String address, String counted) {
        assertThat(CountedAddress.of(CountedAddress.of(address))).isEqualTo(counted);
    }

    @org.junit.jupiter.api.Test
    void everyAddressOfOne64IsOneKey() {
        assertThat(Arrays.asList("2001:db8:1:2::1", "2001:db8:1:2::ffff", "2001:db8:1:2:ffff:ffff:ffff:ffff").stream()
            .map(CountedAddress::of).distinct().toList()).containsExactly("2001:db8:1:2::/64");
        assertThat(CountedAddress.of("2001:db8:1:3::1")).isNotEqualTo(CountedAddress.of("2001:db8:1:2::1"));
    }
}
