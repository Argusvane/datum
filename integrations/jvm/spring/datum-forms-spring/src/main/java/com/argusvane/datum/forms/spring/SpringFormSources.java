package com.argusvane.datum.forms.spring;

import com.argusvane.datum.forms.FormSources;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.ResourcePatternResolver;

/**
 * The Spring half of {@code datum.forms.locations}: every pattern, {@code classpath:}, {@code classpath*:} and
 * {@code file:} alike, is read by Spring's own {@link ResourcePatternResolver} and becomes the library's
 * {@link FormSources.Source}s (framework-first: the library's {@code java.nio} glob walk for {@code file:}
 * locations is gone, so the patterns mean what they mean everywhere else in a Spring application, Ant-style
 * {@code *}, {@code ?} and {@code **}). A resource that is not readable or has no file name is skipped; a base
 * directory that does not exist finds nothing.
 */
public final class SpringFormSources {

    private SpringFormSources() {
    }

    /** The resolver the default repository reads through. */
    public static FormSources.Resolver resolver(ResourcePatternResolver resources) {
        return location -> {
            List<FormSources.Source> found = new ArrayList<>();
            for (Resource resource : resources.getResources(location)) {
                if (!resource.isReadable() || resource.getFilename() == null) {
                    continue;
                }
                found.add(new FormSources.Source(resource.getFilename(), describe(resource), () -> {
                    try (InputStream in = resource.getInputStream()) {
                        return in.readAllBytes();
                    }
                }));
            }
            // Sorted by where they are, so a location's order never depends on how the file system listed it.
            found.sort(java.util.Comparator.comparing(FormSources.Source::where));
            return found;
        };
    }

    private static String describe(Resource resource) {
        try {
            return resource.getURL().toString();
        } catch (IOException e) {
            return resource.getDescription();
        }
    }
}
