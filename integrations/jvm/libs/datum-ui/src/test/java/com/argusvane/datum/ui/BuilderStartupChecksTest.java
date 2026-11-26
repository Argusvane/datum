package com.argusvane.datum.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.DatumStartupCheck.Level;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The builder's start-up line without a framework: one INFO
 * that follows the switch. Who may build is the application's security (framework-first), so the
 * library probes no policy any more; the binding's start-up check WARNs when the builder's writes are on and the
 * application has no security filter chain (datum-spring-web's {@code DatumSecurityStartupCheck}).
 */
class BuilderStartupChecksTest {

    @Test
    void theNoticeFollowsTheSwitchAndNamesTheApplicationsSecurity() {
        assertThat(BuilderStartupChecks.notice(new UiSettings(false, 1024))).isEmpty();
        assertThat(BuilderStartupChecks.notice(new UiSettings(true, 1024)).orElseThrow())
            .contains("The Datum builder is enabled").contains("the application's security").doesNotContain("policy");
    }

    @Test
    void theCheckWritesUnderDatumUiAndOnlyWithTheBuilderOn() {
        assertThat(BuilderStartupChecks.check(new UiSettings(false, 1024)).check()).isEmpty();
        List<DatumStartupCheck.Notice> on = BuilderStartupChecks.check(new UiSettings(true, 1024)).check();
        assertThat(on).extracting(DatumStartupCheck.Notice::level).containsExactly(Level.INFO);
        assertThat(on).extracting(DatumStartupCheck.Notice::logger).containsOnly("datum.ui");
    }
}
