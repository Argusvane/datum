package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.springweb.support.Failures;
import com.argusvane.datum.web.assets.WithheldAssets;
import com.argusvane.datum.web.json.DatumJsonMapper;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import tools.jackson.databind.JsonNode;

/** An MVC application with Datum-style controllers and one controller (with advice) of its own. */
@SpringBootConfiguration
@EnableAutoConfiguration
@Import({MvcTestApp.DatumTestController.class, MvcTestApp.AppController.class, MvcTestApp.AppAdvice.class})
public class MvcTestApp {

    @Bean
    WithheldAssets builderFilesWithheld() {
        return path -> path.equals("datum-builder.js");
    }

    @RestController
    @DatumController
    @RequestMapping("/test")
    @Tag(name = "test")
    static class DatumTestController {

        private final DatumProperties properties;
        private final DatumJsonMapper json;

        DatumTestController(DatumProperties properties, DatumJsonMapper json) {
            this.properties = properties;
            this.json = json;
        }

        @GetMapping("/throw/{kind}")
        String thrower(@PathVariable String kind) {
            throw Failures.of(kind);
        }

        @GetMapping("/hidden/x")
        String hidden() {
            return "hidden";
        }

        @PostMapping("/echo")
        @Operation(summary = "Echo the number of members",
            requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(content = @io.swagger.v3.oas.annotations.media.Content(mediaType = "application/json")),
            responses = @ApiResponse(responseCode = "200", description = "the size"))
        Map<String, Object> echo(HttpServletRequest request) {
            JsonNode node = MvcBodies.readJson(request, properties.web().api().maxBodySize().toBytes(), json);
            return Map.of("size", node.size());
        }
    }

    @RestController
    static class AppController {

        @GetMapping("/app/boom")
        String boom() {
            throw new IllegalStateException("the application's own failure");
        }
    }

    @RestControllerAdvice
    static class AppAdvice {

        @ExceptionHandler(IllegalStateException.class)
        @ResponseStatus(HttpStatus.I_AM_A_TEAPOT)
        String handle() {
            return "app handled";
        }
    }
}
