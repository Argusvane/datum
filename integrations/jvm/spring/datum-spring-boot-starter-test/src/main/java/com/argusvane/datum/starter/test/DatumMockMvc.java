package com.argusvane.datum.starter.test;

import java.util.Set;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import tools.jackson.databind.node.ObjectNode;

/**
 * Datum's endpoints through {@link MockMvc} (Servlet applications): the paths come from the API base
 * ({@code datum.web.api.path}, {@code /api} by default), the bodies are the wire shapes. Each method returns the
 * {@link ResultActions} so a test adds its own expectations.
 */
public final class DatumMockMvc {

    private final MockMvc mvc;
    private final String api;

    public DatumMockMvc(MockMvc mvc) {
        this(mvc, "/api");
    }

    /** With the API base the application configured ({@code datum.web.api.path}), as the routes read it. */
    public static DatumMockMvc of(MockMvc mvc, org.springframework.core.env.Environment environment) {
        return new DatumMockMvc(mvc, DatumApiBase.of(environment));
    }

    public DatumMockMvc(MockMvc mvc, String api) {
        this.mvc = mvc;
        this.api = api;
    }

    /** The form definition of a key. */
    public ResultActions definition(String key) throws Exception {
        return get(api + "/forms/" + key + "/definition");
    }

    /** The data source's options. */
    public ResultActions dataSource(String id) throws Exception {
        return get(api + "/data-sources/" + id);
    }

    /** Posts a submission envelope as one submit attempt: {document, submissionKey} with a fresh key. */
    public ResultActions submit(ObjectNode envelope) throws Exception {
        return submit(envelope, java.util.UUID.randomUUID().toString());
    }

    /** Posts a submission envelope under this submission key: a retry of one attempt sends the same key. */
    public ResultActions submit(ObjectNode envelope, String submissionKey) throws Exception {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("submissionKey", submissionKey);
        return post(api + "/submissions", body);
    }

    /** Posts an envelope to the validate endpoint. */
    public ResultActions validate(ObjectNode envelope, String scope) throws Exception {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("scope", scope);
        return post(api + "/submissions/validate", body);
    }

    /** Posts a JSON object to any path. */
    public ResultActions post(String path, ObjectNode body) throws Exception {
        return mvc.perform(MockMvcRequestBuilders.post(path).contentType(MediaType.APPLICATION_JSON).content(DatumTestForms.bytes(body)));
    }

    /** Gets any path. */
    public ResultActions get(String path) throws Exception {
        return mvc.perform(MockMvcRequestBuilders.get(path));
    }

    /** The paths springdoc's document for the group lists (the group name without the {@code datum-} prefix is accepted). */
    public Set<String> apiDocPaths(String group) throws Exception {
        return DatumApiDocs.paths(apiDocs(group));
    }

    /** The {@code METHOD path} pairs springdoc's document for the group lists. */
    public Set<String> apiDocOperations(String group) throws Exception {
        return DatumApiDocs.operations(apiDocs(group));
    }

    private String apiDocs(String group) throws Exception {
        String name = group.startsWith("datum-") ? group : "datum-" + group;
        var response = get(DatumApiDocs.url(name)).andReturn().getResponse();
        if (response.getStatus() != 200) {
            throw new AssertionError("GET " + DatumApiDocs.url(name) + " answered " + response.getStatus() + ": is springdoc on the class path and the group defined?");
        }
        return response.getContentAsString();
    }
}
