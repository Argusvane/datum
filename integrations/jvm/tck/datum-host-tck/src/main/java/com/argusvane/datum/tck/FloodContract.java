package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;

/**
 * The flood limits ({@code datum.web.throttle.*}): asking too often is 429 {@code flood} with {@code Retry-After}.
 * Both cases spend the address's budget, so they are numbered to run after every other contract and after a host's own
 * tests that carry no {@code @Order}.
 *
 * <ul>
 *   <li>FLD-01 ({@code Order.DEFAULT + 9000}): the per-form limit. It posts the refused CTL-02 document (no record is
 *       made) until the host refuses, at most 120 times, so a host sets a low limit ({@code datum.web.throttle.limit=30}
 *       on Spring Boot).</li>
 *   <li>FLD-02 ({@code Order.DEFAULT + 9001}): the address limit. It posts a body that does not parse until the host
 *       refuses, at most 400 times. The per-form limit cannot count such a body (its key names the form, which only the
 *       parsed body gives), so a host without the address limit answers 400 {@code bad_document} every time. The kit runs
 *       from one address, so a host sets the address limit above the rest of a whole kit run and low enough for 400
 *       tries to reach it: {@code datum.web.throttle.address-limit=200} on Spring Boot. A full kit run posts about 60
 *       counted requests before FLD-02 with the per-form limit at 30 (the submissions and dry-run contracts about 25,
 *       FLD-01 at most 31), and even at the most FLD-01 may post (120) it stays under 200.</li>
 * </ul>
 */
public interface FloodContract extends HostContract {

    /** FLD-01: the per-form limit. */
    @Test
    @Order(Order.DEFAULT + 9000)
    default void askingTooOftenIs429WithRetryAfter() {
        String body = TckFixtures.delivered(TckFixtures.envelope("CTL-02"));
        Reply last = null;
        for (int i = 0; i < 120; i++) {
            last = http().postJson(target().api("/submissions"), body);
            if (last.status() == 429) {
                break;
            }
        }
        assertThat(last.status()).as(last.toString()).isEqualTo(429);
        assertThat(last.header("Retry-After")).isPresent();
        assertThat(last.code()).isEqualTo("flood");
    }

    /** FLD-02: the address limit counts a request before its body is parsed. */
    @Test
    @Order(Order.DEFAULT + 9001)
    default void aBodyThatDoesNotParseIsCountedBeforeTheParse() {
        Reply last = null;
        for (int i = 0; i < 400; i++) {
            last = http().postJson(target().api("/submissions"), "{");
            if (last.status() == 429) {
                break;
            }
        }
        assertThat(last.status())
            .as("after 400 bodies that do not parse (a host without the address limit answers 400 bad_document every time): " + last)
            .isEqualTo(429);
        assertThat(last.header("Retry-After")).isPresent();
        assertThat(last.code()).isEqualTo("flood");
    }
}
