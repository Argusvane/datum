package com.argusvane.datum.examples.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.AssetsContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.Reply;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Story two end to end on a real port: the page, the form it asks for, and a submission answered with the handler's
 * reference. The assets, the glue and the builder's files staying away (the builder is off) are the host test kit's
 * assets contract, the same classes every JVM host binding runs.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class UiExampleIT implements AssetsContract {

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    @Test
    @Order(1)
    void thePageAsksTheServerForTheForm() {
        Reply page = http().get("/");
        assertThat(page.status()).isEqualTo(200);
        assertThat(page.text()).contains("<datum-form").contains("src=\"/api/forms/contact/definition\"");

        Reply definition = http().get(target().api("/forms/contact/definition"));
        assertThat(definition.status()).isEqualTo(200);
        assertThat(definition.json().get("id").asString()).isEqualTo("contact");
        assertThat(definition.header("ETag")).isPresent();
    }

    @Test
    @Order(2)
    void aSubmissionIsAnsweredWithTheHandlersReference() {
        String envelope = "{\"versionContext\":{\"form\":{\"id\":\"contact\",\"version\":\"1\"},"
            + "\"client\":{\"runtimeVersion\":\"x\",\"rendererVersion\":\"x\",\"schemaVersion\":\"1\"}},"
            + "\"submission\":{\"locale\":\"en\",\"values\":{\"name\":\"Ada\",\"email\":\"ada@example.org\",\"message\":\"Hello\"}}}";
        Reply reply = http().postJson(target().api("/submissions"), "{\"document\":" + envelope + ",\"submissionKey\":\"" + java.util.UUID.randomUUID() + "\"}");
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        assertThat(reply.json().get("reference").asString()).isEqualTo("CONTACT-0001");
    }
}
