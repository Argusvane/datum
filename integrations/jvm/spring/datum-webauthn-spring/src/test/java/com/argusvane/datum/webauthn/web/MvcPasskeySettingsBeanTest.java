package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.spring.DatumRouteBase;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.webauthn.PasskeySettings;
import com.argusvane.datum.webauthn.spring.DatumWebAuthnProperties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;

/**
 * An application's {@link PasskeySettings} bean is what the passkey routes run with: its path moves the
 * routes and the base the security matchers follow, and its {@code registerAtSubmit} and {@code labelPath} reach the
 * endpoints. The properties say the opposite on each, so a value read from them instead shows here.
 */
@MvcApp
@Import(MvcPasskeySettingsBeanTest.Mine.class)
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = {"datum.webauthn.allow-memory-stores=true",
    "datum.webauthn.path=/property-keys", "datum.webauthn.register-at-submit=true", "datum.webauthn.label-path=fromTheProperties"})
class MvcPasskeySettingsBeanTest {

    /** The properties' settings with the path, register-at-submit and label path an application's tenant store chose. */
    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @Bean
        PasskeySettings applicationPasskeySettings(DatumWebAuthnProperties properties) {
            PasskeySettings s = properties.toSettings();
            return new PasskeySettings(s.enabled(), s.rpId(), s.rpName(), s.origins(), s.anonymous(), false, s.window(), s.challengeTtl(), "/keys",
                s.passkeys(), s.secret(), "applicant.name", s.keepYears(), s.siteSigning(), s.forms(), s.allowMemoryStores(), s.residentKey(),
                s.challengeSkew(), s.signedAtSkew(), s.anonymousGrace());
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    ApplicationContext context;

    @Test
    void theRoutesAndTheMatchersBaseFollowTheBeansPath() {
        assertThat(context.getBeansOfType(PasskeySettings.class)).containsOnlyKeys("applicationPasskeySettings");
        assertThat(context.getBean(PasskeysRoutes.class).path()).isEqualTo("/keys");
        assertThat(context.getBean("datumWebAuthnRouteBase", DatumRouteBase.class)).isEqualTo(new DatumRouteBase(Base.WEBAUTHN, "/keys"));
        assertThat(MvcTransport.send(mvc, "GET", "/keys/passkeys?form=petition", null).status()).isEqualTo(200);
    }

    @Test
    void registerAtSubmitAndTheLabelPathAreTheBeans() {
        Reply reply = MvcTransport.send(mvc, "GET", "/keys/passkeys?form=petition", null);
        assertThat(reply.status()).isEqualTo(200);
        JsonNode signing = reply.json().get("signing");
        assertThat(signing.get("register").asBoolean()).as("the bean's registerAtSubmit=false, not the property's true").isFalse();
        assertThat(signing.get("labelPath").asString()).isEqualTo("applicant.name");
    }

    /**
     * The refusal the advertised flag stands for (a flag that silently weakens the policy is a defect): with the bean's registerAtSubmit=false
     * a signed-in person is refused a passkey at the form, for a submission and an amendment alike, while the properties
     * say true. A challenge or register step that read the flag anywhere but the bean would issue one here.
     */
    @Test
    void aPasskeyAtTheFormIsRefusedAsTheBeanSays() {
        for (String context : new String[] {"submit", "amend"}) {
            for (String step : new String[] {"/keys/challenge", "/keys/register"}) {
                byte[] body = ("{\"form\":\"petition\",\"context\":\"" + context + "\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                Reply reply = MvcTransport.send(mvc, "POST", step, body, "Content-Type", "application/json", "X-Test-User", "ada");
                assertThat(reply.status()).as(step + " " + context).isEqualTo(403);
                assertThat(reply.code()).as(step + " " + context).isEqualTo("signing.register_off");
            }
        }
    }
}
