package com.argusvane.datum.ui;

import com.argusvane.datum.core.DatumStartupCheck;
import java.util.List;
import java.util.Optional;

/**
 * What the start says about the builder (integrations/jvm/README.md "Libraries and bindings"): with the
 * builder on, one INFO line that it is, and who decides who may use it. Every host binding shares it, so a Quarkus binding would write the same words.
 *
 * <p>Framework-first: who may build is the application's security, not a Datum
 * policy, so there is no policy to probe here: the binding's own start-up check WARNs when the builder's writes are
 * on and the application declares no security filter chain (on Spring, datum-spring-web's
 * {@code DatumSecurityStartupCheck}), because only the binding can see the framework's security.
 */
public final class BuilderStartupChecks {

    /** The category the builder's start-up lines have always been written under. */
    public static final String CATEGORY = "datum.ui";

    private BuilderStartupChecks() {
    }

    /** The builder's start-up check: the INFO line with the builder on, nothing with it off. */
    public static DatumStartupCheck check(UiSettings settings) {
        return () -> notice(settings).map(text -> List.of(DatumStartupCheck.Notice.info(CATEGORY, text))).orElse(List.of());
    }

    /** The INFO line for the builder switch, or none with the builder off. */
    public static Optional<String> notice(UiSettings settings) {
        if (!settings.builderEnabled()) {
            return Optional.empty();
        }
        return Optional.of("The Datum builder is enabled: its bundle is served and the form write endpoints are on. "
            + "Who may use them is the application's security (secure the builder's routes in your filter chain).");
    }
}
