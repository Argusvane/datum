package com.argusvane.datum.ui.builder;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * An application's annotated route on a builder path ({@code PATCH /api/forms/{key}}), on both stacks. On WebFlux a
 * path-wide 405 route in Datum's routers used to shadow it, because every router function is tried before any
 * annotated controller; the 405 now comes from a handler mapping ordered after both.
 */
@RestController
public class AppPatchController {

    @PatchMapping("/api/forms/{key}")
    public ResponseEntity<Void> patch(@PathVariable String key) {
        return ResponseEntity.noContent().header("X-App", "patched").build();
    }
}
