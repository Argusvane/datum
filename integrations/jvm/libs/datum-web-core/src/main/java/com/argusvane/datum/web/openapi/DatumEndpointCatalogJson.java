package com.argusvane.datum.web.openapi;

import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Endpoint;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.HeaderDef;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.ParameterDef;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Property;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.SchemaDef;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.SharedResponse;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Status;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import tools.jackson.core.util.DefaultIndenter;
import tools.jackson.core.util.DefaultPrettyPrinter;
import tools.jackson.core.util.Separators;
import tools.jackson.databind.json.JsonMapper;

/**
 * The endpoint catalog as one JSON document, {@code integrations/shared/endpoint-catalog.json}: the data the Java catalog
 * holds, written for the hosts that are not Java (the Node conformance kit, the tests a Quarkus filter would have, any other host's
 * OpenAPI check). The Java catalog stays the source; {@code DatumEndpointCatalogTest#theSharedCatalogIsCurrent} fails
 * when the committed file differs and regenerates it with {@code -Ddatum.catalog.write=true}.
 *
 * <p>Written by Jackson's pretty printer over plain maps and lists: members keep the order the catalog declares them
 * in, two-space indent, one trailing newline, {@code \n} line ends, so the file is byte-stable on every machine
 * (the printer is configured for {@code "name": value} and one array element per line, and writes an empty
 * container as {@code {}} or {@code []}, as the committed file always had). A status that limits a header to some of its
 * codes adds {@code headerCodes} ({@code {"Retry-After": ["server.busy"]}}) and a shared response adds
 * {@code retryAfterCodes}; both are left out otherwise. The default-response rule is derived by asking {@link DatumEndpointCatalog#defaultResponses} for the
 * four body/method combinations, so it cannot drift from the function the bindings call.
 */
public final class DatumEndpointCatalogJson {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    private DatumEndpointCatalogJson() {
    }

    /** Jackson's default printer with "name": value, LF lines, two-space indent for objects and arrays, empty containers bare. */
    private static DefaultPrettyPrinter printer() {
        DefaultPrettyPrinter printer = new DefaultPrettyPrinter(Separators.createDefaultInstance()
            .withObjectNameValueSpacing(Separators.Spacing.AFTER)
            .withObjectEmptySeparator("")
            .withArrayEmptySeparator(""));
        DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
        printer.indentObjectsWith(indenter);
        printer.indentArraysWith(indenter);
        return printer;
    }

    /** The catalog document, ending with a newline. */
    public static String json() {
        Map<String, Object> root = new LinkedHashMap<>();
        Map<String, Object> bases = new LinkedHashMap<>();
        for (Base base : Base.values()) {
            bases.put(base.name().toLowerCase(Locale.ROOT), base.defaultPath());
        }
        root.put("bases", bases);
        List<Object> endpoints = new ArrayList<>();
        for (Endpoint endpoint : DatumEndpointCatalog.endpoints()) {
            endpoints.add(endpoint(endpoint));
        }
        root.put("endpoints", endpoints);
        List<Object> schemas = new ArrayList<>();
        for (SchemaDef schema : DatumEndpointCatalog.schemas()) {
            schemas.add(schema(schema));
        }
        root.put("schemas", schemas);
        List<Object> headers = new ArrayList<>();
        for (HeaderDef header : DatumEndpointCatalog.headers()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("component", header.component());
            out.put("header", header.header());
            out.put("description", header.description());
            out.put("type", header.type());
            out.put("minimum", header.minimum());
            headers.add(out);
        }
        root.put("headers", headers);
        List<Object> parameters = new ArrayList<>();
        for (ParameterDef parameter : DatumEndpointCatalog.parameters()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("component", parameter.component());
            out.put("name", parameter.name());
            out.put("description", parameter.description());
            out.put("type", parameter.type());
            parameters.add(out);
        }
        root.put("parameters", parameters);
        List<Object> responses = new ArrayList<>();
        for (SharedResponse response : DatumEndpointCatalog.sharedResponses()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("component", response.component());
            out.put("status", response.status());
            out.put("description", response.description());
            out.put("codes", response.codes());
            out.put("retryAfter", response.retryAfter());
            if (!response.retryAfterCodes().isEmpty()) {
                out.put("retryAfterCodes", response.retryAfterCodes());
            }
            responses.add(out);
        }
        root.put("responses", responses);
        root.put("defaultResponses", defaultResponses());
        return MAPPER.writer().with(printer()).writeValueAsString(root) + "\n";
    }

    private static Map<String, Object> endpoint(Endpoint endpoint) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("capability", endpoint.capability());
        out.put("groups", endpoint.groups());
        out.put("tag", endpoint.tag());
        out.put("operationId", endpoint.operationId());
        out.put("method", endpoint.method());
        out.put("base", endpoint.base().name().toLowerCase(Locale.ROOT));
        out.put("path", endpoint.path());
        out.put("switch", endpoint.switchKey());
        out.put("body", endpoint.body());
        List<Object> statuses = new ArrayList<>();
        for (Status status : endpoint.statuses()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("status", status.status());
            entry.put("codes", status.codes());
            entry.put("headers", status.headers());
            if (!status.headerCodes().isEmpty()) {
                // Only when a header is limited to some of the status's codes, so a reader that ignores it reads the
                // same document as before: the header the status can carry.
                entry.put("headerCodes", status.headerCodes());
            }
            statuses.add(entry);
        }
        out.put("statuses", statuses);
        return out;
    }

    private static Map<String, Object> schema(SchemaDef schema) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", schema.name());
        out.put("description", schema.description());
        List<Object> properties = new ArrayList<>();
        for (Property property : schema.properties()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", property.name());
            entry.put("type", property.type());
            entry.put("description", property.description());
            entry.put("nullable", property.nullable());
            entry.put("example", property.example());
            properties.add(entry);
        }
        out.put("properties", properties);
        out.put("required", schema.required());
        return out;
    }

    /**
     * The shared error responses every operation gets unless it declares the status itself, each with the condition that
     * adds it: {@code always}, {@code body} (the route reads a request body) or {@code post} (the method is POST).
     */
    private static List<Object> defaultResponses() {
        Map<Integer, String> always = DatumEndpointCatalog.defaultResponses(false, "GET");
        Map<Integer, String> withBody = DatumEndpointCatalog.defaultResponses(true, "GET");
        Map<Integer, String> post = DatumEndpointCatalog.defaultResponses(false, "POST");
        List<Object> out = new ArrayList<>();
        for (Map.Entry<Integer, String> entry : DatumEndpointCatalog.defaultResponses(true, "POST").entrySet()) {
            String when = always.containsKey(entry.getKey()) ? "always" : withBody.containsKey(entry.getKey()) ? "body" : post.containsKey(entry.getKey()) ? "post" : "?";
            Map<String, Object> rule = new LinkedHashMap<>();
            rule.put("status", entry.getKey());
            rule.put("component", entry.getValue());
            rule.put("when", when);
            out.add(rule);
        }
        return out;
    }
}
