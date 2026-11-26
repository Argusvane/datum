package com.argusvane.datum.starter.test;

import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.assertj.MockMvcTester;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import tools.jackson.databind.node.ObjectNode;

/**
 * Datum's endpoints through {@link MockMvcTester}, Boot 4's AssertJ client for Servlet applications: the same helpers as {@link DatumMockMvc}, each returning the {@link MvcTestResult} to assert on with
 * {@code assertThat(..)}. {@link #of} reads the API base from {@code datum.web.api.path} like the routes do.
 *
 * <pre>{@code
 * @Autowired MockMvcTester mvc;
 * @Autowired Environment environment;
 *
 * assertThat(DatumMockMvcTester.of(mvc, environment).definition("contact")).hasStatusOk();
 * }</pre>
 */
public final class DatumMockMvcTester {

    private final MockMvcTester mvc;
    private final String api;

    public DatumMockMvcTester(MockMvcTester mvc) {
        this(mvc, DatumApiBase.DEFAULT);
    }

    public DatumMockMvcTester(MockMvcTester mvc, String api) {
        this.mvc = mvc;
        this.api = api;
    }

    /** With the API base the application configured ({@code datum.web.api.path}). */
    public static DatumMockMvcTester of(MockMvcTester mvc, Environment environment) {
        return new DatumMockMvcTester(mvc, DatumApiBase.of(environment));
    }

    /** The API base the helpers use. */
    public String api() {
        return api;
    }

    /** The form definition of a key. */
    public MvcTestResult definition(String key) {
        return get(api + "/forms/" + key + "/definition");
    }

    /** The data source's options. */
    public MvcTestResult dataSource(String id) {
        return get(api + "/data-sources/" + id);
    }

    /** Posts a submission envelope as one submit attempt: {document, submissionKey} with a fresh key. */
    public MvcTestResult submit(ObjectNode envelope) {
        return submit(envelope, java.util.UUID.randomUUID().toString());
    }

    /** Posts a submission envelope under this submission key: a retry of one attempt sends the same key. */
    public MvcTestResult submit(ObjectNode envelope, String submissionKey) {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("submissionKey", submissionKey);
        return post(api + "/submissions", body);
    }

    /** Posts an envelope to the validate endpoint. */
    public MvcTestResult validate(ObjectNode envelope, String scope) {
        ObjectNode body = DatumTestForms.json("{}");
        body.set("document", envelope);
        body.put("scope", scope);
        return post(api + "/submissions/validate", body);
    }

    /** Posts a JSON object to any path. */
    public MvcTestResult post(String path, ObjectNode body) {
        return mvc.post().uri(path).contentType(MediaType.APPLICATION_JSON).content(DatumTestForms.bytes(body)).exchange();
    }

    /** Gets any path. */
    public MvcTestResult get(String path) {
        return mvc.get().uri(path).exchange();
    }
}
