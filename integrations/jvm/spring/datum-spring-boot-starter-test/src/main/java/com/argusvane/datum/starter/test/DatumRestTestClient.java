package com.argusvane.datum.starter.test;

import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.client.RestTestClient;
import tools.jackson.databind.node.ObjectNode;

/**
 * Datum's endpoints through {@link RestTestClient}, Boot 4's client for a Servlet application bound to MockMvc or a running
 * server: the same helpers as {@link DatumWebTestClient}, each returning the response spec to add
 * expectations to. {@link #of} reads the API base from {@code datum.web.api.path} like the routes do.
 */
public final class DatumRestTestClient {

    private final RestTestClient client;
    private final String api;

    public DatumRestTestClient(RestTestClient client) {
        this(client, DatumApiBase.DEFAULT);
    }

    public DatumRestTestClient(RestTestClient client, String api) {
        this.client = client;
        this.api = api;
    }

    /** With the API base the application configured ({@code datum.web.api.path}). */
    public static DatumRestTestClient of(RestTestClient client, Environment environment) {
        return new DatumRestTestClient(client, DatumApiBase.of(environment));
    }

    /** The API base the helpers use. */
    public String api() {
        return api;
    }

    /** The form definition of a key. */
    public RestTestClient.ResponseSpec definition(String key) {
        return get(api + "/forms/" + key + "/definition");
    }

    /** The data source's options. */
    public RestTestClient.ResponseSpec dataSource(String id) {
        return get(api + "/data-sources/" + id);
    }

    /** Posts a submission envelope as one submit attempt: {document, submissionKey} with a fresh key. */
    public RestTestClient.ResponseSpec submit(ObjectNode envelope) {
        return submit(envelope, java.util.UUID.randomUUID().toString());
    }

    /** Posts a submission envelope under this submission key: a retry of one attempt sends the same key. */
    public RestTestClient.ResponseSpec submit(ObjectNode envelope, String submissionKey) {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("submissionKey", submissionKey);
        return post(api + "/submissions", body);
    }

    /** Posts an envelope to the validate endpoint. */
    public RestTestClient.ResponseSpec validate(ObjectNode envelope, String scope) {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("scope", scope);
        return post(api + "/submissions/validate", body);
    }

    /** Posts a JSON object to any path. */
    public RestTestClient.ResponseSpec post(String path, ObjectNode body) {
        return client.post().uri(path).contentType(MediaType.APPLICATION_JSON).body(DatumTestForms.bytes(body)).exchange();
    }

    /** Gets any path. */
    public RestTestClient.ResponseSpec get(String path) {
        return client.get().uri(path).exchange();
    }
}
