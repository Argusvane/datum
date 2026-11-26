package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The builder's write routes over a form the host lets {@link HostTarget.Who#PERSON} build
 * ({@link HostTarget#buildForm()}): only someone who may build saves (a visitor and {@link HostTarget.Who#OTHER_PERSON}
 * are refused 401 or 403 by the application's security, whose body is its own: framework-first; with
 * Datum's JSON handlers installed it is {@code access.denied}), a save names its version with {@code If-Match} and answers the new
 * {@code ETag}, a page that fell behind is told 409 {@code form.outdated}, the kernel refuses a risky pattern and a
 * duplicate id (422) before anything is stored, a body whose id is not the key is 422, and creating an id that exists
 * is 409 {@code form.exists}. The host's own storage checks (audit rows, snapshots) are not part of this contract.
 */
public interface BuilderContract extends HostContract {

    private String form() {
        assumeTrue(target().buildForm() != null, "the host names no form a person may build");
        return target().buildForm();
    }

    private Reply load() {
        Reply loaded = http().get(target().api("/forms/" + form() + "/definition?public=false"), HostTarget.Who.PERSON, Map.of());
        assertThat(loaded.status()).as(loaded.toString()).isEqualTo(200);
        assertThat(loaded.header("ETag")).isPresent();
        return loaded;
    }

    private Reply put(String key, ObjectNode definition, HostTarget.Who who, String ifMatch) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept", "application/json");
        if (ifMatch != null) {
            headers.put("If-Match", ifMatch);
        }
        return http().send("PUT", target().api("/forms/" + key), "application/json", definition.toString().getBytes(StandardCharsets.UTF_8), who, headers);
    }

    private static ArrayNode content(ObjectNode definition) {
        return (ArrayNode) definition.get("root").get("children").get("content");
    }

    private static Set<String> codes(Reply reply) {
        Set<String> codes = new TreeSet<>();
        reply.json().path("errors").forEach(error -> codes.add(error.path("code").asString()));
        return codes;
    }

    @Test
    @Order(1701)
    default void onlySomeoneWhoMayBuildSaves() {
        Reply loaded = load();
        ObjectNode definition = (ObjectNode) loaded.json();
        for (HostTarget.Who who : new HostTarget.Who[] {HostTarget.Who.VISITOR, HostTarget.Who.OTHER_PERSON}) {
            Reply refused = put(form(), definition, who, loaded.header("ETag").orElseThrow());
            // The application's security refuses: 401 or 403, the body unchecked (Spring Security's own
            // handlers write none; Datum's DatumSecurityResponses write access.denied).
            assertThat(refused.status()).as(who + " " + refused).isIn(401, 403);
        }
        assertThat(load().header("ETag")).isEqualTo(loaded.header("ETag"));
    }

    @Test
    @Order(1702)
    default void aSaveAnswersItsTagAndAPageThatFellBehindIsTold409() {
        Reply loaded = load();
        ObjectNode definition = (ObjectNode) loaded.json();
        definition.put("version", "tck-" + System.nanoTime());
        Reply saved = put(form(), definition, HostTarget.Who.PERSON, loaded.header("ETag").orElseThrow());
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);
        String sha = saved.json().path("sha256").asString();
        assertThat(sha).matches("[0-9a-f]{64}");
        assertThat(saved.header("ETag")).hasValue("\"" + sha + "\"");
        assertThat(load().header("ETag")).isEqualTo(saved.header("ETag"));

        Reply stale = put(form(), definition, HostTarget.Who.PERSON, loaded.header("ETag").orElseThrow());
        assertThat(stale.status()).as(stale.toString()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("form.outdated");
        assertThat(stale.header("ETag")).isEqualTo(saved.header("ETag"));
    }

    @Test
    @Order(1703)
    default void theKernelRefusesARiskyPatternAndDuplicateIdsAndNothingIsStored() {
        Reply loaded = load();
        ObjectNode risky = (ObjectNode) loaded.json();
        ObjectNode fx = content(risky).addObject();
        fx.put("id", "tckfx");
        fx.put("type", "text");
        fx.putObject("configuration");
        fx.putObject("rules").putObject("visibleWhen").put("run", "both").put("formula", "matches(name, \"(a|a?)+\")");
        Reply refused = put(form(), risky, HostTarget.Who.PERSON, loaded.header("ETag").orElseThrow());
        assertThat(refused.status()).as(refused.toString()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("pattern.risky");
        assertThat(refused.json().path("kernel").path(0).path("where").asString()).isEqualTo("rules:tckfx:visibleWhen");

        ObjectNode duplicates = (ObjectNode) loaded.json();
        for (int i = 0; i < 2; i++) {
            content(duplicates).addObject().put("id", "tckdup").put("type", "text").putObject("configuration");
        }
        Reply duplicate = put(form(), duplicates, HostTarget.Who.PERSON, loaded.header("ETag").orElseThrow());
        assertThat(duplicate.status()).as(duplicate.toString()).isEqualTo(422);
        assertThat(duplicate.code()).isEqualTo("component.id.duplicate");
        assertThat(load().header("ETag")).as("the stored form is the one from before").isEqualTo(loaded.header("ETag"));
    }

    @Test
    @Order(1704)
    default void aBodyWhoseIdIsNotTheKeyIs422AndCreatingAnIdThatExistsIs409() {
        Reply loaded = load();
        ObjectNode other = (ObjectNode) loaded.json();
        other.put("id", form() + "-other");
        Reply mismatch = put(form(), other, HostTarget.Who.PERSON, loaded.header("ETag").orElseThrow());
        assertThat(mismatch.status()).as(mismatch.toString()).isEqualTo(422);
        assertThat(codes(mismatch)).contains("definition.id.mismatch");

        JsonNode existing = loaded.json();
        Reply exists = http().send("POST", target().api("/forms"), "application/json", existing.toString().getBytes(StandardCharsets.UTF_8),
            HostTarget.Who.PERSON, Map.of("Accept", "application/json"));
        assertThat(exists.status()).as(exists.toString()).isEqualTo(409);
        assertThat(exists.code()).isEqualTo("form.exists");
    }
}
