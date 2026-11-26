package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.webauthn.FormSigningSource;
import com.argusvane.datum.webauthn.PasskeyChallenges;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import com.argusvane.datum.webauthn.WebAuthnVerifier;
import java.time.Clock;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.test.context.TestPropertySource;

/** An application's {@code PasskeysApi} bean replaces the binding's. */
@SpringBootTest(classes = {PasskeysMvcTestApp.class, MvcPasskeysApiOverrideTest.Mine.class}, properties = "spring.main.web-application-type=servlet")
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = "datum.webauthn.allow-memory-stores=true")
class MvcPasskeysApiOverrideTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @Bean
        PasskeysApi applicationApi(WebAuthnSettings settings, RegistrationCeremony ceremony, PasskeyChallenges challenges, PasskeyRepository passkeys,
                                   PasskeyUseStore uses, WebAuthnVerifier verifier, FormSigningSource forms, PasskeySubjectResolver subjects,
                                   PasskeyThrottle throttle, DatumJsonMapper json) {
            return new PasskeysApi(settings, new PasskeysApi.Options(false, ""), ceremony, challenges, passkeys, uses, verifier, forms, subjects,
                throttle, json, null, Clock.systemUTC());
        }
    }

    @Autowired
    ApplicationContext context;

    @Test
    void onlyTheApplicationsApiIsInTheContext() {
        assertThat(context.getBeansOfType(PasskeysApi.class)).containsOnlyKeys("applicationApi");
    }
}
