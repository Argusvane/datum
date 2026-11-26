package com.argusvane.datum.core.io;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/**
 * A readable thing the configuration names (a program override, a key store, a PEM file), framework-free:
 * each host binding wraps its own resource type (Spring's {@code Resource}, a Quarkus path) so the libraries
 * read every configured file one way (integrations/jvm/README.md "Libraries and bindings").
 */
public interface ResourceHandle {

    /** How the resource is named in messages ({@code file [/etc/datum/x.js]}, {@code class path resource [...]}). */
    String description();

    /** Whether it can be opened at all. */
    boolean exists();

    /** A fresh stream over the bytes; the caller closes it. */
    InputStream open() throws IOException;

    /** A file on the file system. */
    static ResourceHandle of(Path path) {
        Objects.requireNonNull(path, "path");
        return new ResourceHandle() {
            @Override
            public String description() {
                return "file [" + path.toAbsolutePath() + "]";
            }

            @Override
            public boolean exists() {
                return Files.exists(path);
            }

            @Override
            public InputStream open() throws IOException {
                return Files.newInputStream(path);
            }

            @Override
            public String toString() {
                return description();
            }
        };
    }

    /** A URL (a class loader's resource, a jar entry). */
    static ResourceHandle of(URL url) {
        Objects.requireNonNull(url, "url");
        return new ResourceHandle() {
            @Override
            public String description() {
                return "URL [" + url + "]";
            }

            @Override
            public boolean exists() {
                try (InputStream in = url.openStream()) {
                    return in != null;
                } catch (IOException e) {
                    return false;
                }
            }

            @Override
            public InputStream open() throws IOException {
                return url.openStream();
            }

            @Override
            public String toString() {
                return description();
            }
        };
    }

    /** Bytes already in memory (tests, a value the host read itself). */
    static ResourceHandle of(String description, byte[] bytes) {
        Objects.requireNonNull(description, "description");
        byte[] copy = bytes.clone();
        return new ResourceHandle() {
            @Override
            public String description() {
                return description;
            }

            @Override
            public boolean exists() {
                return true;
            }

            @Override
            public InputStream open() {
                return new ByteArrayInputStream(copy);
            }

            @Override
            public String toString() {
                return description;
            }
        };
    }
}
