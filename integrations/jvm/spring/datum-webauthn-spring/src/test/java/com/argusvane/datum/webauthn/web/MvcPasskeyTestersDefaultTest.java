package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * Who may use the Test context is a bean: the binding's default is the exact match on the
 * named roles, and it is the rule the {@code PasskeysApi} asks.
 */
@SpringBootTest(classes = PasskeysMvcTestApp.class, properties = {"spring.main.web-application-type=servlet", "datum.webauthn.test-roles=TESTER"})
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = "datum.webauthn.allow-memory-stores=true")
class MvcPasskeyTestersDefaultTest {

    @Autowired
    PasskeysApi api;

    @Autowired
    PasskeyTesters testers;

    @Test
    void theDefaultIsTheExactMatchOnTheNamedRolesAndIgnoresAHierarchy() {
        PasskeysApi.Options options = (PasskeysApi.Options) ReflectionTestUtils.getField(api, "options");
        assertThat(options.testers()).isSameAs(testers);
        assertThat(testers.test(new TestingAuthenticationToken("t", "n/a", "ROLE_TESTER"))).isTrue();
        // A role an application's hierarchy might place above TESTER is still refused: the gate is not widened.
        assertThat(testers.test(new TestingAuthenticationToken("a", "n/a", "ROLE_ADMIN"))).isFalse();
    }
}
