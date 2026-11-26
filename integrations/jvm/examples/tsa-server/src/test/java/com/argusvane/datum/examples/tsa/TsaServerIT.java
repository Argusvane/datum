package com.argusvane.datum.examples.tsa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.TsaContract;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Boots the example and runs the README's round trip: {@code openssl ts -query}, the server, {@code openssl ts
 * -verify} against the certificates the server publishes; those two tests are skipped, with a message, when there is
 * no openssl command. The wire contract (a granted token over the digest, the refusals in order, the public
 * certificates) is the host test kit's timestamp contract, which needs no openssl.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class TsaServerIT implements TsaContract {

    @LocalServerPort
    int port;

    @TempDir
    Path dir;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    private static void needsOpenssl() {
        boolean present;
        try {
            Process process = new ProcessBuilder("openssl", "version").redirectErrorStream(true).start();
            present = process.waitFor(20, TimeUnit.SECONDS) && process.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            present = false;
        }
        assumeTrue(present, "No openssl command to make and check timestamp requests: the openssl round trip is skipped.");
    }

    private String openssl(String... arguments) throws Exception {
        List<String> command = new java.util.ArrayList<>(List.of("openssl"));
        command.addAll(List.of(arguments));
        Process process = new ProcessBuilder(command).directory(dir.toFile()).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(String.join(" ", arguments) + ": " + output).isZero();
        return output;
    }

    private HttpResponse<byte[]> call(HttpRequest request) throws Exception {
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofByteArray());
    }

    @Test
    @Order(1)
    void anOpensslQueryIsStampedAndVerifiesAgainstThePublishedCertificates() throws Exception {
        needsOpenssl();
        Files.writeString(dir.resolve("file.txt"), "a document the server never sees");
        openssl("ts", "-query", "-data", "file.txt", "-sha256", "-cert", "-out", "file.tsq");

        HttpResponse<byte[]> stamped = call(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/tsa"))
            .header("Content-Type", "application/timestamp-query")
            .POST(HttpRequest.BodyPublishers.ofFile(dir.resolve("file.tsq"))).build());
        assertThat(stamped.statusCode()).isEqualTo(200);
        assertThat(stamped.headers().firstValue("Content-Type")).contains("application/timestamp-reply");
        Files.write(dir.resolve("file.tsr"), stamped.body());

        HttpResponse<byte[]> certificates = call(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/tsa/certificates")).GET().build());
        assertThat(certificates.statusCode()).isEqualTo(200);
        Files.write(dir.resolve("tsa.pem"), certificates.body());

        assertThat(openssl("ts", "-verify", "-data", "file.txt", "-in", "file.tsr", "-CAfile", "tsa.pem")).contains("Verification: OK");
        assertThat(openssl("ts", "-reply", "-in", "file.tsr", "-text")).contains("Status: Granted").contains("Hash Algorithm: sha256");
    }

    @Test
    @Order(2)
    void aTokenOfAnotherFileDoesNotVerify() throws Exception {
        needsOpenssl();
        Files.writeString(dir.resolve("file.txt"), "one document");
        openssl("ts", "-query", "-data", "file.txt", "-sha256", "-cert", "-out", "file.tsq");
        HttpResponse<byte[]> stamped = call(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/tsa"))
            .header("Content-Type", "application/timestamp-query")
            .POST(HttpRequest.BodyPublishers.ofFile(dir.resolve("file.tsq"))).build());
        Files.write(dir.resolve("file.tsr"), stamped.body());
        Files.write(dir.resolve("tsa.pem"),
            call(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/tsa/certificates")).GET().build()).body());
        Files.writeString(dir.resolve("other.txt"), "another document");

        Process process = new ProcessBuilder("openssl", "ts", "-verify", "-data", "other.txt", "-in", "file.tsr", "-CAfile", "tsa.pem")
            .directory(dir.toFile()).redirectErrorStream(true).start();
        process.getInputStream().readAllBytes();
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).isNotZero();
    }
}
