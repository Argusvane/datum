package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.webauthn.web.PasskeysApi;
import java.security.Principal;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;

/**
 * Who may use a form's Test context: nobody unless {@code datum.webauthn.test-roles} names a role, and
 * then only an authenticated, non-anonymous Spring Security authentication holding it.
 */
class SecurityRoleTestersTest {

    private static DatumWebAuthnProperties roles(String... roles) {
        DatumWebAuthnProperties properties = new DatumWebAuthnProperties();
        properties.setTestRoles(List.of(roles));
        return properties;
    }

    @Test
    void nobodyByDefault() {
        assertThat(DatumWebAuthnWebAutoConfiguration.testers(new DatumWebAuthnProperties())).isSameAs(PasskeysApi.Options.NOBODY);
        assertThat(DatumWebAuthnWebAutoConfiguration.testers(roles(" "))).isSameAs(PasskeysApi.Options.NOBODY);
        assertThat(new PasskeysApi.Options(true, "").testers().test(new TestingAuthenticationToken("x", "y", "ROLE_TESTER"))).isFalse();
    }

    @Test
    void aNamedRoleMatchesItsAuthorityWithOrWithoutThePrefix() {
        var testers = DatumWebAuthnWebAutoConfiguration.testers(roles("FORM_ADMIN"));
        assertThat(testers.test(new TestingAuthenticationToken("a", "n/a", "ROLE_FORM_ADMIN"))).isTrue();
        assertThat(testers.test(new TestingAuthenticationToken("a", "n/a", "FORM_ADMIN"))).isTrue();
        assertThat(testers.test(new TestingAuthenticationToken("a", "n/a", "ROLE_USER"))).isFalse();
        assertThat(DatumWebAuthnWebAutoConfiguration.testers(roles("ROLE_FORM_ADMIN")).test(new TestingAuthenticationToken("a", "n/a", "ROLE_FORM_ADMIN")))
            .isTrue();
    }

    @Test
    void anAnonymousUnauthenticatedOrPlainPrincipalIsNoTester() {
        var testers = new SecurityRoleTesters(List.of("TESTER"));
        TestingAuthenticationToken unauthenticated = new TestingAuthenticationToken("a", "n/a", "ROLE_TESTER");
        unauthenticated.setAuthenticated(false);
        assertThat(testers.test(unauthenticated)).isFalse();
        assertThat(testers.test(new AnonymousAuthenticationToken("key", "anonymous", AuthorityUtils.createAuthorityList("ROLE_TESTER")))).isFalse();
        Principal plain = () -> "tester";
        assertThat(testers.test(plain)).isFalse();
        assertThat(testers.test(null)).isFalse();
    }

    // ------------------------------------------------------------------------------------------------------ role prefix

    /** A role prefix the application chose with GrantedAuthorityDefaults is the one a named role is matched under. */
    @Test
    void aRolePrefixTheApplicationChoseIsHonoured() {
        var noPrefix = new SecurityRoleTesters(List.of("FORM_ADMIN"), "");
        assertThat(noPrefix.test(new TestingAuthenticationToken("a", "n/a", "FORM_ADMIN"))).isTrue();
        assertThat(noPrefix.test(new TestingAuthenticationToken("a", "n/a", "ROLE_FORM_ADMIN"))).as("the default prefix is not the application's").isFalse();

        var custom = new SecurityRoleTesters(List.of("FORM_ADMIN", "APP_AUDITOR"), "APP_");
        assertThat(custom.test(new TestingAuthenticationToken("a", "n/a", "APP_FORM_ADMIN"))).isTrue();
        assertThat(custom.test(new TestingAuthenticationToken("a", "n/a", "APP_AUDITOR"))).as("already prefixed").isTrue();
        assertThat(custom.test(new TestingAuthenticationToken("a", "n/a", "ROLE_FORM_ADMIN"))).isFalse();
        assertThat(custom.test(new TestingAuthenticationToken("a", "n/a", "FORM_ADMIN"))).as("as hasAuthority reads it").isTrue();
    }

    @Test
    void theBindingReadsTheApplicationsGrantedAuthorityDefaults() {
        var runner = new org.springframework.boot.test.context.runner.ApplicationContextRunner();
        runner.withBean(org.springframework.security.config.core.GrantedAuthorityDefaults.class,
            () -> new org.springframework.security.config.core.GrantedAuthorityDefaults("APP_")).run(context ->
            assertThat(DatumWebAuthnWebAutoConfiguration.rolePrefix(context)).isEqualTo("APP_"));
        runner.withBean(org.springframework.security.config.core.GrantedAuthorityDefaults.class,
            () -> new org.springframework.security.config.core.GrantedAuthorityDefaults("")).run(context ->
            assertThat(DatumWebAuthnWebAutoConfiguration.rolePrefix(context)).isEmpty());
        runner.run(context -> assertThat(DatumWebAuthnWebAutoConfiguration.rolePrefix(context)).isEqualTo("ROLE_"));
        var testers = DatumWebAuthnWebAutoConfiguration.testers(roles("FORM_ADMIN"), "APP_");
        assertThat(testers.test(new TestingAuthenticationToken("a", "n/a", "APP_FORM_ADMIN"))).isTrue();
        assertThat(testers.test(new TestingAuthenticationToken("a", "n/a", "ROLE_FORM_ADMIN"))).isFalse();
    }
}
