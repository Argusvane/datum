package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.Principal;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.util.ReflectionTestUtils;

/** An application with another rule declares one {@code PasskeyTesters}; the default backs off and the API asks the bean. */
@SpringBootTest(classes = {PasskeysMvcTestApp.class, MvcPasskeyTestersReplacedTest.Mine.class},
    properties = {"spring.main.web-application-type=servlet", "datum.webauthn.test-roles=TESTER"})
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = "datum.webauthn.allow-memory-stores=true")
class MvcPasskeyTestersReplacedTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @Bean
        PasskeyTesters applicationTesters() {
            return principal -> principal != null && "guest".equals(principal.getName());
        }
    }

    @Autowired
    PasskeysApi api;

    @Autowired
    ApplicationContext context;

    @Test
    void anApplicationsOwnRuleIsTheOneTheApiAsks() {
        assertThat(context.getBeansOfType(PasskeyTesters.class)).containsOnlyKeys("applicationTesters");
        PasskeysApi.Options options = (PasskeysApi.Options) ReflectionTestUtils.getField(api, "options");
        Principal guest = () -> "guest";
        assertThat(options.testers().test(guest)).isTrue();
        assertThat(options.testers().test(new TestingAuthenticationToken("t", "n/a", "ROLE_TESTER"))).as("the property no longer applies").isFalse();
    }
}
