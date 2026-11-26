package com.argusvane.datum.pdf;

import java.util.List;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * What a {@link PdfRequestCustomizer} may change of one request: copies of the five members it may adjust, written
 * back over the request afterwards, so nothing else of the request is in reach. A member set to null is removed from
 * the request; a member the op does not carry cannot be set ({@link IllegalArgumentException}).
 */
public final class PdfRequestDraft {

    /** The members a customizer may adjust, by op. */
    static final Map<String, Set<String>> MEMBERS = Map.of(
        "document", Set.of("env", "options", "hostContext", "attachments", "fonts"),
        "build", Set.of("hostContext", "attachments"),
        "render", Set.of("env", "options", "fonts"),
        "layout", Set.of("env", "fonts"),
        "fill", Set.of("env", "options", "attachments", "fonts"),
        "sign", Set.of("env", "fonts"));

    private static final List<String> ORDER = List.of("env", "options", "hostContext", "attachments", "fonts");

    private final String op;
    private final String formKey;
    private final Set<String> allowed;
    private final java.util.LinkedHashMap<String, JsonNode> values = new java.util.LinkedHashMap<>();

    PdfRequestDraft(String op, String formKey, ObjectNode request) {
        this.op = op;
        this.formKey = formKey;
        this.allowed = MEMBERS.getOrDefault(op, Set.of());
        for (String name : ORDER) {
            if (allowed.contains(name)) {
                JsonNode value = request.get(name);
                values.put(name, value == null ? null : value.deepCopy());
            }
        }
    }

    /** Whether an op is ever customized. */
    static boolean customizable(String op) {
        return MEMBERS.containsKey(op);
    }

    /** The op the request runs (read only). */
    public String op() {
        return op;
    }

    /** The form the PDF is of, or null (read only). */
    public String formKey() {
        return formKey;
    }

    /** Whether this op carries a member. */
    public boolean carries(String member) {
        return allowed.contains(member);
    }

    /** {@code env}: {@code createdAt}, {@code documentId}, {@code producer}, {@code creator}; or null. */
    public JsonNode env() {
        return values.get("env");
    }

    public void env(JsonNode env) {
        put("env", env);
    }

    /** {@code options}, or null. */
    public JsonNode options() {
        return values.get("options");
    }

    public void options(JsonNode options) {
        put("options", options);
    }

    /** {@code hostContext}, or null. */
    public JsonNode hostContext() {
        return values.get("hostContext");
    }

    public void hostContext(JsonNode hostContext) {
        put("hostContext", hostContext);
    }

    /** {@code attachments}, or null. */
    public JsonNode attachments() {
        return values.get("attachments");
    }

    public void attachments(JsonNode attachments) {
        put("attachments", attachments);
    }

    /** {@code fonts}, or null. */
    public JsonNode fonts() {
        return values.get("fonts");
    }

    public void fonts(JsonNode fonts) {
        put("fonts", fonts);
    }

    private void put(String member, JsonNode value) {
        if (!allowed.contains(member)) {
            throw new IllegalArgumentException("A " + op + " request carries no " + member + ".");
        }
        values.put(member, value == null ? null : value.deepCopy());
    }

    /** Writes the members back over the request (only the allowed ones; abi and op are not among them). */
    void applyTo(ObjectNode request) {
        values.forEach((name, value) -> {
            if (value == null || value.isNull() || value.isMissingNode()) {
                request.remove(name);
            } else {
                request.set(name, value);
            }
        });
    }
}
