package com.argusvane.datum.web.monitoring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck.Level;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.monitoring.EnabledRoutesNotice.Facts;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import org.junit.jupiter.api.Test;

/** The notice names every enabled route and its switch, or says none is on and names the properties. */
class EnabledRoutesNoticeTest {

    private static final Set<String> ALL = Set.of("forms", "ui", "submissions", "pdf", "timestamp", "webauthn");

    @Test
    void anApplicationThatEnabledNothingIsToldWhichPropertiesToSet() {
        var notice = EnabledRoutesNotice.notice(new Facts(WebSettings.defaults(), ALL, Map.of(), false, key -> false));
        assertThat(notice.level()).isEqualTo(Level.INFO);
        assertThat(notice.message()).contains("no Datum route is enabled").contains("datum.web.api.endpoints.*")
            .contains("datum.web.assets.enabled").contains("datum.builder.enabled").contains("datum.tsa.enabled")
            .contains("datum.webauthn.enabled");
    }

    @Test
    void theDefaultsEnableNoEndpointAndNoAssets() {
        WebSettings defaults = WebSettings.defaults();
        assertThat(defaults.assets().enabled()).isFalse();
        for (String name : new String[] {"definition", "data-sources", "submissions", "validate", "test", "inspect", "pdf", "fill",
            "sign", "verify", "certificate"}) {
            assertThat(defaults.api().endpointEnabled(name)).as(name).isFalse();
        }
    }

    @Test
    void enabledRoutesAreListedWithTheirMethodPathAndSwitch() {
        WebSettings settings = new WebSettings(true, new WebSettings.Api("/v1", 1024, false,
            Map.of("submissions", true, "validate", true)), WebSettings.Assets.defaults(), null, null, null);
        Predicate<String> on = key -> key.equals("datum.web.api.endpoints.submissions") || key.equals("datum.tsa.enabled")
            || key.equals("datum.web.api.endpoints.validate");
        var notice = EnabledRoutesNotice.notice(new Facts(settings, ALL, Map.of("tsa", "/stamp"), true, on));
        assertThat(notice.message()).contains("POST /v1/submissions (datum.web.api.endpoints.submissions)")
            .contains("POST /v1/submissions/validate (datum.web.api.endpoints.validate)")
            .contains("POST /stamp (datum.tsa.enabled)")
            .contains("GET /datum/assets/** (datum.web.assets.enabled)")
            .doesNotContain("/pdf").doesNotContain("datum.builder.enabled");
    }

    @Test
    void aSwitchForAbsentCapabilityListsNothing() {
        var notice = EnabledRoutesNotice.notice(new Facts(WebSettings.defaults(), Set.of("forms"), Map.of(), false, key -> true));
        assertThat(notice.message()).contains("/forms/{key}/definition").doesNotContain("/pdf").doesNotContain("/submissions");
    }
}
