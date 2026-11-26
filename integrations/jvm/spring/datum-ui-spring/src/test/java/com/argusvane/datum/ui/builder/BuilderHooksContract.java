package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.contracts.DatumJson;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The application's builder hook beans on the wire, the same on both stacks: the customizers in their
 * {@code @Order} with the request's principal, the stored definition the customized one, a validator's warning in the 200's
 * {@code warnings}, refusals as the 422 {@code definition.refused} with the hook's findings, a throwing hook a 500.
 */
public abstract class BuilderHooksContract {

    static final String FORM = "/api/forms/" + BuilderFixtures.KEY;

    protected abstract Http.Reply send(String method, String path, byte[] body, String... headers);

    private Http.Reply put(String title) {
        ObjectNode definition = BuilderFixtures.base();
        definition.put("title", title);
        return send("PUT", FORM, DatumJson.mapper().writeValueAsBytes(definition), "Content-Type", "application/json");
    }

    @Test
    void theCustomizersRunInOrderAndTheValidatorsWarningRidesInTheAnswer() {
        Http.Reply saved = put("Intake");
        assertThat(saved.status()).as(new String(saved.body(), StandardCharsets.UTF_8)).isEqualTo(200);
        assertThat(saved.json().get("warnings").toString()).contains("Remember the owner.");

        Http.Reply stored = send("GET", FORM + "/definition?public=false", null);
        assertThat(stored.json().get("metadata").get("order").asString()).isEqualTo("first,second");
        assertThat(stored.json().get("metadata").get("by").asString()).as("the request's principal").isEqualTo("tester");
        assertThat(saved.header("ETag")).as("the next If-Match names what was stored").isEqualTo(stored.header("ETag"));
    }

    @Test
    void refusalsAreTheBuildersOwn422AndAThrowingHookIsA500() {
        Http.Reply refused = put("refuse");
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("naming.title");
        assertThat(refused.json().get("kernel").get(0).get("where").asString()).isEqualTo("title");

        Http.Reply vetoed = put("veto");
        assertThat(vetoed.status()).isEqualTo(422);
        assertThat(vetoed.code()).isEqualTo("policy.label");

        Http.Reply failed = put("fail");
        assertThat(failed.status()).isEqualTo(500);
        assertThat(failed.code()).isEqualTo("internal");
    }
}
