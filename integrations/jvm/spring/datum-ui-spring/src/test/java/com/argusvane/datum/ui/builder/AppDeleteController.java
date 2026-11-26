package com.argusvane.datum.ui.builder;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * The MVC form of {@link AppRoutes}' application route. A class of its own: as a member of the configuration it
 * would be registered twice (once as a nested component, once by the bean method).
 */
@RestController
public class AppDeleteController {

    @DeleteMapping("/api/forms/{key}")
    public ResponseEntity<Void> delete(@PathVariable String key) {
        return ResponseEntity.noContent().header("X-App", "deleted").build();
    }
}
