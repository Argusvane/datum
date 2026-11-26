package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Endpoint;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.HeaderDef;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.ParameterDef;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Property;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.SchemaDef;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.SharedResponse;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Status;
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.PathItem;
import io.swagger.v3.oas.models.headers.Header;
import io.swagger.v3.oas.models.media.ArraySchema;
import io.swagger.v3.oas.models.media.Content;
import io.swagger.v3.oas.models.media.IntegerSchema;
import io.swagger.v3.oas.models.media.MediaType;
import io.swagger.v3.oas.models.media.ObjectSchema;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.media.StringSchema;
import io.swagger.v3.oas.models.parameters.HeaderParameter;
import io.swagger.v3.oas.models.responses.ApiResponse;
import io.swagger.v3.oas.models.responses.ApiResponses;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Optional;
import org.springdoc.core.customizers.OpenApiCustomizer;

/**
 * Adds Datum's shared schemas, headers and error responses to a Datum group's document, and each route's statuses and
 * response headers, all from the library's {@link DatumEndpointCatalog} (integrations/jvm/README.md "Libraries and bindings": a Quarkus {@code OASFilter} would build from the same data).
 *
 * <p>Components: schemas {@code ErrorsBody}, {@code ErrorItem}, {@code ProblemDetail}; headers {@code RetryAfter},
 * {@code ETag}, {@code XDatumRemovedLocales}, {@code XPageCount}, {@code Location}; the request header parameter
 * {@code IfMatch}; and the error responses {@code BadRequest}, {@code PayloadTooLarge}, {@code UnsupportedMediaType},
 * {@code Unprocessable}, {@code TooManyRequests} and {@code Unavailable} (both document {@code Retry-After}; on a 503 only
 * {@code server.busy} sends it) and
 * {@code InternalError}. Every operation then gets the ones that can happen on any endpoint, unless the endpoint
 * declared that status itself ({@link DatumEndpointCatalog#defaultResponses}); an operation the catalog knows (by its
 * operation id) also gets a status of its route that its annotations left out, and the headers its route answers on
 * the responses its annotations wrote. It is attached to Datum's groups only, never to the application's own
 * operations.
 */
public final class DatumOpenApiCustomizer implements OpenApiCustomizer {

    private static final String SCHEMAS = "#/components/schemas/";
    private static final String RESPONSES = "#/components/responses/";
    private static final String HEADERS = "#/components/headers/";

    private final boolean problemDetails;

    public DatumOpenApiCustomizer(boolean problemDetails) {
        this.problemDetails = problemDetails;
    }

    @Override
    public void customise(OpenAPI openApi) {
        Components components = openApi.getComponents();
        if (components == null) {
            components = new Components();
            openApi.setComponents(components);
        }
        addComponents(components);
        if (openApi.getPaths() != null) {
            openApi.getPaths().values().forEach(this::addOperationResponses);
        }
    }

    private void addComponents(Components components) {
        for (SchemaDef definition : DatumEndpointCatalog.schemas()) {
            ObjectSchema schema = new ObjectSchema();
            schema.description(definition.description());
            for (Property property : definition.properties()) {
                schema.addProperty(property.name(), schema(property));
            }
            definition.required().forEach(schema::addRequiredItem);
            components.addSchemas(definition.name(), schema);
        }
        for (HeaderDef definition : DatumEndpointCatalog.headers()) {
            Schema<?> schema = "integer".equals(definition.type()) ? new IntegerSchema() : new StringSchema();
            if (definition.minimum() != null) {
                schema.minimum(BigDecimal.valueOf(definition.minimum()));
            }
            components.addHeaders(definition.component(), new Header().description(definition.description()).schema(schema));
        }
        for (ParameterDef definition : DatumEndpointCatalog.parameters()) {
            components.addParameters(definition.component(), new HeaderParameter()
                .name(definition.name())
                .description(definition.description())
                .schema(new StringSchema()));
        }
        for (SharedResponse definition : DatumEndpointCatalog.sharedResponses()) {
            components.addResponses(definition.component(), error(definition.description(), definition.retryAfter() ? "RetryAfter" : null));
        }
    }

    private static Schema<?> schema(Property property) {
        Schema<?> schema;
        if ("array:string".equals(property.type())) {
            schema = new ArraySchema().items(new StringSchema());
        } else if (property.type().startsWith("array:")) {
            schema = new ArraySchema().items(new Schema<>().$ref(SCHEMAS + property.type().substring("array:".length())));
        } else if (property.type().startsWith("ref:")) {
            schema = new Schema<>().$ref(SCHEMAS + property.type().substring("ref:".length()));
        } else if ("integer".equals(property.type())) {
            schema = new IntegerSchema();
        } else if ("boolean".equals(property.type())) {
            schema = new io.swagger.v3.oas.models.media.BooleanSchema();
        } else {
            schema = new StringSchema();
        }
        if (property.nullable()) {
            schema.nullable(true);
        }
        if (property.description() != null) {
            schema.description(property.description());
        }
        if (property.example() != null) {
            schema.example(property.example());
        }
        return schema;
    }

    private ApiResponse error(String description, String retryAfterHeader) {
        ApiResponse response = new ApiResponse().description(description);
        Content content = new Content();
        String schema = problemDetails ? "ProblemDetail" : "ErrorsBody";
        content.addMediaType(problemDetails ? "application/problem+json" : "application/json",
            new MediaType().schema(new Schema<>().$ref(SCHEMAS + schema)));
        response.setContent(content);
        if (retryAfterHeader != null) {
            response.addHeaderObject("Retry-After", new Header().$ref(HEADERS + retryAfterHeader));
        }
        return response;
    }

    private void addOperationResponses(PathItem item) {
        item.readOperationsMap().forEach((method, operation) -> {
            if (operation.getResponses() == null) {
                operation.setResponses(new ApiResponses());
            }
            Optional<Endpoint> route = operation.getOperationId() == null ? Optional.empty() : DatumEndpointCatalog.endpoint(operation.getOperationId());
            route.ifPresent(endpoint -> addRouteStatuses(operation, endpoint));
            boolean body = operation.getRequestBody() != null;
            for (Map.Entry<Integer, String> shared : DatumEndpointCatalog.defaultResponses(body, method.name()).entrySet()) {
                add(operation, String.valueOf(shared.getKey()), shared.getValue());
            }
        });
    }

    /** The route's statuses its annotations left out, and its headers on the responses they wrote. */
    private void addRouteStatuses(Operation operation, Endpoint endpoint) {
        ApiResponses responses = operation.getResponses();
        for (Status status : endpoint.statuses()) {
            String key = String.valueOf(status.status());
            ApiResponse written = responses.get(key);
            if (written == null) {
                String described = status.codes().isEmpty() ? "See the route's documentation." : "(" + String.join(", ", status.codes()) + ")";
                written = new ApiResponse().description(described);
                responses.addApiResponse(key, written);
            }
            if (written.get$ref() != null) {
                continue;
            }
            ApiResponse response = written;
            for (String name : status.headers()) {
                if (response.getHeaders() == null || response.getHeaders().keySet().stream().noneMatch(name::equalsIgnoreCase)) {
                    DatumEndpointCatalog.header(name).ifPresent(header ->
                        response.addHeaderObject(header.header(), new Header().$ref(HEADERS + header.component())));
                }
            }
        }
    }

    private static void add(Operation operation, String status, String component) {
        if (!operation.getResponses().containsKey(status)) {
            operation.getResponses().addApiResponse(status, new ApiResponse().$ref(RESPONSES + component));
        }
    }
}
