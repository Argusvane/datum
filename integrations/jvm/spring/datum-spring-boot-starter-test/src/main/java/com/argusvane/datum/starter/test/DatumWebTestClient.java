package com.argusvane.datum.starter.test;

import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import tools.jackson.databind.node.ObjectNode;

/**
 * Datum's endpoints through a {@link WebTestClient} (WebFlux applications): the paths come from the API base
 * ({@code datum.web.api.path}, {@code /api} by default), the bodies are the wire shapes. Each method returns the
 * spec so a test adds its own expectations.
 */
public final class DatumWebTestClient {

    private final WebTestClient client;
    private final String api;

    public DatumWebTestClient(WebTestClient client) {
        this(client, "/api");
    }

    /** With the API base the application configured ({@code datum.web.api.path}), as the routes read it. */
    public static DatumWebTestClient of(WebTestClient client, org.springframework.core.env.Environment environment) {
        return new DatumWebTestClient(client, DatumApiBase.of(environment));
    }

    public DatumWebTestClient(WebTestClient client, String api) {
        this.client = client;
        this.api = api;
    }

    /** The form definition ({@code public=true}, a browser's copy) of a key. */
    public WebTestClient.ResponseSpec definition(String key) {
        return client.get().uri(api + "/forms/{key}/definition", key).exchange();
    }

    /** The data source's options. */
    public WebTestClient.ResponseSpec dataSource(String id) {
        return client.get().uri(api + "/data-sources/{id}", id).exchange();
    }

    /** Posts a submission envelope as one submit attempt: {document, submissionKey} with a fresh key. */
    public WebTestClient.ResponseSpec submit(ObjectNode envelope) {
        return submit(envelope, java.util.UUID.randomUUID().toString());
    }

    /** Posts a submission envelope under this submission key: a retry of one attempt sends the same key. */
    public WebTestClient.ResponseSpec submit(ObjectNode envelope, String submissionKey) {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("submissionKey", submissionKey);
        return post(api + "/submissions", body);
    }

    /** Posts an envelope to the validate endpoint. */
    public WebTestClient.ResponseSpec validate(ObjectNode envelope, String scope) {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("scope", scope);
        return post(api + "/submissions/validate", body);
    }

    /** Posts a JSON object to any path. */
    public WebTestClient.ResponseSpec post(String path, ObjectNode body) {
        return client.post().uri(path).contentType(MediaType.APPLICATION_JSON).bodyValue(DatumTestForms.bytes(body)).exchange();
    }

    /** Gets any path. */
    public WebTestClient.ResponseSpec get(String path) {
        return client.get().uri(path).exchange();
    }

    /** The paths springdoc's document for the group lists (the group name without the {@code datum-} prefix is accepted). */
    public Set<String> apiDocPaths(String group) {
        return DatumApiDocs.paths(apiDocs(group));
    }

    /** The {@code METHOD path} pairs springdoc's document for the group lists. */
    public Set<String> apiDocOperations(String group) {
        return DatumApiDocs.operations(apiDocs(group));
    }

    private String apiDocs(String group) {
        String name = group.startsWith("datum-") ? group : "datum-" + group;
        byte[] body = client.get().uri(DatumApiDocs.url(name)).exchange().expectStatus().isOk().expectBody().returnResult().getResponseBody();
        return new String(body, StandardCharsets.UTF_8);
    }
}
