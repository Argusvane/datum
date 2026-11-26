package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.core.io.ResourceHandle;
import java.io.IOException;
import java.io.InputStream;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;

/** A Spring {@link Resource} as the libraries' {@link ResourceHandle}; the description is Spring's. */
public final class SpringResources {

    private SpringResources() {
    }

    /**
     * A location as the Datum properties that name files on the server take it: a Spring resource location
     * ({@code classpath:}, {@code file:}, a URL) as written, a bare path as a file (a Windows drive path included, see
     * {@link #isFilePath}). One rule for every module that reads the
     * same property: the timestamp server's {@code datum.tsa.retired-certificates} and its key store were read this way, while
     * the PDF module, reading that same property, handed a bare path to the resource loader, where it is a class-path (or
     * servlet-context) resource and a file such as {@code /etc/datum/old-tsa.pem} was not found.
     */
    public static Resource location(ResourceLoader resources, String location) {
        return resources.getResource(isFilePath(location) ? "file:" + location : location);
    }

    /**
     * Whether {@link #location} reads {@code location} as a file path rather than a Spring location: no colon, or a Windows
     * drive path ({@code C:\...} or {@code C:/...}), whose colon is the drive's and not a scheme's. Judged on the text, not
     * the running platform, so a property means the same on every target the release builds; a one-letter scheme is
     * no Spring location. A drive-relative {@code C:name} is left to the loader, as written.
     */
    static boolean isFilePath(String location) {
        int colon = location.indexOf(':');
        if (colon < 0) {
            return true;
        }
        char drive = Character.toUpperCase(location.charAt(0));
        return colon == 1 && drive >= 'A' && drive <= 'Z' && location.length() > 2
            && (location.charAt(2) == '\\' || location.charAt(2) == '/');
    }

    /** The handle over {@code resource}, or null for null. */
    public static ResourceHandle handle(Resource resource) {
        if (resource == null) {
            return null;
        }
        return new ResourceHandle() {
            @Override
            public String description() {
                return resource.getDescription();
            }

            @Override
            public boolean exists() {
                return resource.exists();
            }

            @Override
            public InputStream open() throws IOException {
                return resource.getInputStream();
            }

            @Override
            public String toString() {
                return resource.getDescription();
            }
        };
    }
}
