package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.io.ResourceHandle;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.DefaultResourceLoader;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.FileUrlResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.UrlResource;

/**
 * A Spring {@link Resource} as the libraries' {@link ResourceHandle}, and the one rule for a location a
 * Datum property names on the server: a Spring location as written, a bare path as a file.
 */
class SpringResourcesTest {

    private final DefaultResourceLoader loader = new DefaultResourceLoader();

    @Test
    void aMissingFileIsAHandleThatDoesNotExist() {
        ResourceHandle handle = SpringResources.handle(new FileSystemResource("/no/such/datum-sandbox-program.js"));
        assertThat(handle.exists()).isFalse();
        assertThat(handle.description()).isEqualTo("file [/no/such/datum-sandbox-program.js]");
        assertThat(handle.toString()).isEqualTo(handle.description());
    }

    @Test
    void theBytesAreTheResourcesAndNullIsNull() throws IOException {
        ResourceHandle handle = SpringResources.handle(new ByteArrayResource("/* mine */".getBytes(StandardCharsets.UTF_8), "test override"));
        assertThat(handle.exists()).isTrue();
        for (int i = 0; i < 2; i++) {
            try (InputStream in = handle.open()) {
                assertThat(new String(in.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo("/* mine */");
            }
        }
        assertThat(SpringResources.handle(null)).isNull();
    }

    // ------------------------------------------------------------------------------------------ file paths

    @Test
    void aBarePathIsAFile() {
        assertThat(SpringResources.isFilePath("/etc/datum/old-tsa.pem")).isTrue();
        assertThat(SpringResources.isFilePath("config/old-tsa.pem")).isTrue();
        assertThat(SpringResources.location(loader, "/etc/datum/old-tsa.pem")).isInstanceOf(FileUrlResource.class);
    }

    /**
     * A Windows drive path ({@code C:\...}, {@code C:/...}) is a bare path although it holds a colon: read as written it
     * reached the resource loader as an unknown scheme and became a class-path or servlet-context resource, so a Windows
     * host's {@code datum.tsa.retired-certificates=C:\datum\old-tsa.pem} stopped the start. The rule is judged on the text,
     * not the running platform, so it is the same on every build target.
     */
    @Test
    void aWindowsDrivePathIsAFileOnEveryPlatform() {
        for (String path : new String[] {"C:\\datum\\old-tsa.pem", "c:/datum/old-tsa.pem", "D:\\old.pem", "Z:/"}) {
            assertThat(SpringResources.isFilePath(path)).as(path).isTrue();
            Resource resource = SpringResources.location(loader, path);
            assertThat(resource).as(path).isInstanceOf(FileUrlResource.class);
            assertThat(resource.getDescription()).as(path).startsWith("URL [file:");
        }
    }

    @Test
    void aSpringLocationIsReadAsWritten() {
        assertThat(SpringResources.isFilePath("classpath:tsa/old.pem")).isFalse();
        assertThat(SpringResources.isFilePath("file:/etc/datum/old.pem")).isFalse();
        assertThat(SpringResources.isFilePath("https://example.org/old.pem")).isFalse();
        assertThat(SpringResources.location(loader, "classpath:tsa/old.pem")).isInstanceOf(ClassPathResource.class);
        assertThat(SpringResources.location(loader, "https://example.org/old.pem")).isInstanceOf(UrlResource.class);
        // A drive letter needs its separator: "C:old.pem" (drive-relative) is not a path this rule guesses at.
        assertThat(SpringResources.isFilePath("C:old.pem")).isFalse();
    }
}
