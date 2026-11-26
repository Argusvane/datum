package com.argusvane.datum.web.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck.Level;
import com.argusvane.datum.web.security.SecurityStartupCheck.Facts;
import org.junit.jupiter.api.Test;

/** The words of the start-up WARN, and when it says nothing. */
class SecurityStartupCheckTest {

    /** The binding words the remedy in its framework's terms; the library adds none of its own. */
    private static final String SPRING = "add spring-boot-starter-security and secure DatumRequestMatchers";
    private static final String OTHER = "add a security policy for the Datum routes";

    @Test
    void openRoutesWithoutAChainWarnNamingTheFix() {
        var notice = SecurityStartupCheck.notice(new Facts(true, true, true, false), "SecurityFilterChain", "DatumRequestMatchers", SPRING).orElseThrow();
        assertThat(notice.level()).isEqualTo(Level.WARN);
        assertThat(notice.logger()).isEqualTo("datum.web");
        assertThat(notice.message()).contains("these routes are open: add spring-boot-starter-security and secure DatumRequestMatchers")
            .contains("builderWrites()").contains("passkeys()").contains("tsa()").contains("no SecurityFilterChain")
            .endsWith(SPRING + ".");
    }

    @Test
    void aChainOrNoOpenRouteSaysNothing() {
        assertThat(SecurityStartupCheck.notice(new Facts(true, true, true, true), "SecurityFilterChain", "DatumRequestMatchers", SPRING)).isEmpty();
        assertThat(SecurityStartupCheck.notice(new Facts(false, false, false, false), "SecurityFilterChain", "DatumRequestMatchers", SPRING)).isEmpty();
        assertThat(SecurityStartupCheck.check(() -> new Facts(false, true, false, false), "SecurityWebFilterChain", "DatumExchangeMatchers", OTHER).check())
            .singleElement().satisfies(notice -> assertThat(notice.message()).contains("SecurityWebFilterChain").contains("DatumExchangeMatchers.passkeys()")
                .doesNotContain("builderWrites").endsWith("these routes are open: " + OTHER + ".")
                .doesNotContain("spring"));
    }
}
