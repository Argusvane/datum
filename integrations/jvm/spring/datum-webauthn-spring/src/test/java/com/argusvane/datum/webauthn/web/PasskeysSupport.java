package com.argusvane.datum.webauthn.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.webauthn.WebAuthnTestKit.Authenticator;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * What every web test shares: the transport (the subclasses supply it), the request helpers and the register
 * ceremony as the glue runs it. The site the application configures is the test class's own (see
 * {@code passkeys-main.properties}).
 */
public abstract class PasskeysSupport {

    static final JsonMapper JSON = JsonMapper.builder().build();
    static final String BASE = "/api/webauthn";

    @Autowired
    ApplicationContext context;

    protected abstract Reply send(String method, String path, byte[] body, String... headers);

    String base() {
        return BASE;
    }

    /**
     * Whether the store behind this contract keeps the counter a test of a passkey moves
     * ({@code PasskeyRepository.touch}): both shipped repositories do.
     */
    boolean storesCheckCounter() {
        return true;
    }

    /** Where the stores live, as health says it: memory or jdbc. */
    String storeKind() {
        return "memory";
    }

    @AfterEach
    void reset() {
        context.getBean(PasskeysTestBeans.SwitchedThrottle.class).wait.set(null);
    }

    // ------------------------------------------------------------------------------------------ helpers

    Reply post(String path, Object body, String user) {
        byte[] bytes = body instanceof byte[] raw ? raw : (body instanceof String text ? text.getBytes(StandardCharsets.UTF_8) : JSON.writeValueAsBytes(body));
        return user == null
            ? send("POST", base() + path, bytes, "Content-Type", "application/json")
            : send("POST", base() + path, bytes, "Content-Type", "application/json", "X-Test-User", user);
    }

    Reply get(String path, String user) {
        return user == null ? send("GET", base() + path, null, "Accept", "application/json")
            : send("GET", base() + path, null, "Accept", "application/json", "X-Test-User", user);
    }

    Reply delete(String path, String user) {
        return user == null ? send("DELETE", base() + path, null) : send("DELETE", base() + path, null, "X-Test-User", user);
    }

    static ObjectNode body(String form, String context) {
        ObjectNode body = JSON.createObjectNode();
        if (form != null) {
            body.put("form", form);
        }
        if (context != null) {
            body.put("context", context);
        }
        return body;
    }

    /** challenge -> create -> register, as the glue does; returns the register reply. */
    Reply registerWith(Authenticator authenticator, String form, String context, String user, String label) {
        Reply challenge = post("/challenge", body(form, context), user);
        assertThat(challenge.status()).as(challenge.text()).isEqualTo(200);
        return registerFrom(authenticator, challenge.json(), form, context, user, label);
    }

    Reply registerFrom(Authenticator authenticator, JsonNode options, String form, String context, String user, String label) {
        ObjectNode posted = body(form, context);
        posted.put("token", options.get("token").asString());
        if (label != null) {
            posted.put("label", label);
        }
        posted.set("credential", authenticator.credentialFor(options));
        return post("/register", posted, user);
    }

    String registered(Authenticator authenticator, String form, String user) {
        Reply reply = registerWith(authenticator, form, "submit", user, null);
        assertThat(reply.status()).as(reply.text()).isEqualTo(201);
        return reply.json().get("id").asString();
    }
}
