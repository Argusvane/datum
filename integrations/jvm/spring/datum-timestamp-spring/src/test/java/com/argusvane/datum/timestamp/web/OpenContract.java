package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.TimestampRefusal;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Set;
import java.util.TreeSet;
import org.bouncycastle.tsp.TimeStampResponse;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The server open to everyone (access=open) with a self-signed certificate, one retired certificate and one
 * configured client: every status the endpoint answers (endpoint catalog {@code issueTimestamp}) except the flood ones, on
 * both stacks.
 */
public abstract class OpenContract extends TsaContract {

    @org.springframework.beans.factory.annotation.Autowired
    com.argusvane.datum.timestamp.TimestampAuthority authority;

    /**
     * The application's {@code TimestampRequestCustomizer} on the wire: a hook refusal is an RFC 3161 badRequest
     * rejection (400) with its message, a customizer that throws a systemFailure (503) that names nothing of the cause, and
     * neither issues a token; by default the customizer runs for the endpoint only, so the host's own seal over the same
     * digest is granted.
     */
    @Test
    void theApplicationsRequestCustomizerRefusesAsRfc3161AndLeavesTheHostsOwnTokensAlone() {
        int issued = events.issued.size();
        int refusedBefore = events.refused.size();

        Reply refused = post(com.argusvane.datum.timestamp.TimestampQuery.forData(TsaTestBeans.REFUSED));
        assertThat(refused.status()).isEqualTo(400);
        assertThat(refused.type()).isEqualTo("application/timestamp-reply");
        TimeStampResponse rejection = parse(refused);
        assertThat(rejection.getStatus()).isEqualTo(2);
        assertThat(rejection.getFailInfo().intValue()).isEqualTo(org.bouncycastle.asn1.cmp.PKIFailureInfo.badRequest);
        assertThat(rejection.getStatusString()).isEqualTo("This digest is on the deny list.");

        Reply failed = post(com.argusvane.datum.timestamp.TimestampQuery.forData(TsaTestBeans.FAILING));
        assertThat(failed.status()).isEqualTo(503);
        TimeStampResponse failure = parse(failed);
        assertThat(failure.getFailInfo().intValue()).isEqualTo(org.bouncycastle.asn1.cmp.PKIFailureInfo.systemFailure);
        assertThat(failure.getStatusString()).doesNotContain("secret").doesNotContain("policy service");

        assertThat(events.issued).as("no token for a refused or failed request").hasSize(issued);
        assertThat(events.refused).hasSize(refusedBefore + 2);

        byte[] sealed = authority.stamp(TsaTestBeans.REFUSED, "sealing");
        try {
            assertThat(new TimeStampResponse(sealed).getStatus()).as("the host's own seal is not the endpoint's policy").isZero();
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void aTokenIsGrantedAsATimestampReplyThatIsNeverCached() throws Exception {
        Reply reply = stamp();

        assertThat(reply.status()).isEqualTo(200);
        assertThat(reply.type()).isEqualTo("application/timestamp-reply");
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        TimeStampResponse response = parse(reply);
        assertThat(response.getStatus()).isZero();
        assertThat(response.getTimeStampToken()).isNotNull();
        assertThat(events.issued).isNotEmpty();
        TimestampIssuedEvent event = events.issued.get(events.issued.size() - 1);
        assertThat(event.serial()).isEqualTo(response.getTimeStampToken().getTimeStampInfo().getSerialNumber().longValueExact());
        assertThat(event.imprintAlgorithm()).isEqualTo("sha256");
        assertThat(event.client()).isNull();
    }

    @Test
    void aFailingEventListenerDoesNotLoseTheSignedToken() throws Exception {
        events.failing = true;
        try {
            Reply reply = stamp();

            assertThat(reply.status()).isEqualTo(200);
            assertThat(parse(reply).getTimeStampToken()).isNotNull();
        } finally {
            events.failing = false;
        }
    }

    @Test
    void aListenerThatFailsAnAssertionDoesNotLoseTheSignedToken() throws Exception {
        events.failingWithError = true;
        try {
            Reply reply = stamp();

            assertThat(reply.status()).isEqualTo(200);
            assertThat(parse(reply).getTimeStampToken()).isNotNull();
        } finally {
            events.failingWithError = false;
        }
    }

    @Test
    void serialsOnlyGoUp() throws Exception {
        long first = parse(stamp()).getTimeStampToken().getTimeStampInfo().getSerialNumber().longValueExact();
        long second = parse(stamp()).getTimeStampToken().getTimeStampInfo().getSerialNumber().longValueExact();

        assertThat(second).isGreaterThan(first);
    }

    @Test
    void theAlternateRequestTypeAndAParameterAreTaken() {
        byte[] query = com.argusvane.datum.timestamp.TimestampQuery.forData("x".getBytes(StandardCharsets.UTF_8));

        assertThat(send("POST", path(), query, "Content-Type", "application/timestamp-request").status()).isEqualTo(200);
        assertThat(send("POST", path(), query, "Content-Type", "Application/Timestamp-Query; charset=utf-8").status()).isEqualTo(200);
    }

    @Test
    void anotherContentTypeIs415PlainText() {
        Reply reply = send("POST", path(), new byte[] {1, 2, 3}, "Content-Type", "application/json");

        assertThat(reply.status()).isEqualTo(415);
        assertThat(reply.type()).startsWith("text/plain");
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(reply.text()).isEqualTo("Send a TimeStampReq as application/timestamp-query.\n");
    }

    @Test
    void noContentTypeIs415() {
        assertThat(send("POST", path(), new byte[] {1}).status()).isEqualTo(415);
    }

    @Test
    void aBodyOverTheLimitIs413() {
        Reply reply = post(new byte[16 * 1024 + 1]);

        assertThat(reply.status()).isEqualTo(413);
        assertThat(reply.type()).startsWith("text/plain");
        assertThat(reply.text()).contains("too large");
    }

    @Test
    void aBodyAtTheLimitIsReadAndRefusedAsNotATimeStampReq() {
        Reply reply = post(new byte[16 * 1024]);

        assertThat(reply.status()).isEqualTo(400);
    }

    @Test
    void aSessionCookieIs403PlainTextBeforeAnythingElse() {
        Reply reply = send("POST", path(), new byte[] {1}, "Content-Type", "application/json", "Cookie", "JSESSIONID=abc");

        assertThat(reply.status()).isEqualTo(403);
        assertThat(reply.type()).startsWith("text/plain");
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        assertThat(reply.text()).startsWith("This timestamp server takes no browser session");
        assertThat(stamp("Cookie", "SESSION=abc").status()).isEqualTo(403);
        assertThat(stamp("Cookie", "a=b").status()).as("by default any cookie is refused").isEqualTo(403);
        assertThat(stamp("Cookie", "theme=dark").status()).isEqualTo(403);
        assertThat(stamp().status()).as("no cookie passes").isEqualTo(200);
    }

    @Test
    void aRequestThatIsNoTimeStampReqIsARejectionInDerWithTheWiresWords() throws Exception {
        int before = events.refused.size();
        Reply reply = post("not a TimeStampReq".getBytes(StandardCharsets.US_ASCII));

        assertThat(reply.status()).isEqualTo(400);
        assertThat(reply.type()).isEqualTo("application/timestamp-reply");
        assertThat(reply.headers().getFirst("Cache-Control")).isEqualTo("no-store");
        TimeStampResponse response = parse(reply);
        assertThat(response.getStatus()).isEqualTo(2);
        assertThat(response.getStatusString()).startsWith("The request is not a TimeStampReq");
        assertThat(response.getFailInfo().intValue()).isEqualTo(bcMask(TimestampRefusal.FAIL_BAD_DATA_FORMAT));
        assertThat(response.getTimeStampToken()).isNull();
        assertThat(events.refused).hasSize(before + 1);
        TimestampRefusedEvent event = events.refused.get(events.refused.size() - 1);
        assertThat(event.failInfo()).isEqualTo(TimestampRefusal.FAIL_BAD_DATA_FORMAT);
        assertThat(event.failName()).isEqualTo("badDataFormat");
    }

    @Test
    void aPolicyOtherThanTheServersIsAnUnacceptedPolicyRejection() throws Exception {
        byte[] query = com.argusvane.datum.timestamp.TimestampQuery.forData("x".getBytes(StandardCharsets.UTF_8), "sha256", true, null, "1.2.3.4");
        Reply reply = post(query);

        assertThat(reply.status()).isEqualTo(400);
        assertThat(parse(reply).getFailInfo().intValue()).isEqualTo(bcMask(TimestampRefusal.FAIL_UNACCEPTED_POLICY));
    }

    @Test
    void aWrongMethodIs405() {
        Reply get = get(path());
        assertThat(get.status()).isEqualTo(405);
        assertThat(send("POST", path() + "/certificate", new byte[0]).status()).isEqualTo(405);
    }

    @Test
    void aConfiguredClientsKeyIsRecognisedAndLogged() {
        int before = events.issued.size();
        Reply reply = stamp("Authorization", "Bearer " + KEY_ONE);

        assertThat(reply.status()).isEqualTo(200);
        assertThat(events.issued).hasSize(before + 1);
        assertThat(events.issued.get(before).client()).isEqualTo(HASH_ONE.substring(0, 12));
    }

    @Test
    void aWrongKeyIs401EvenWhenTheServerIsOpen() {
        Reply reply = stamp("Authorization", "Bearer dtsa_not-a-key");

        assertThat(reply.status()).isEqualTo(401);
        assertThat(reply.headers().getFirst("WWW-Authenticate")).isEqualTo("Bearer realm=\"timestamp server\", Basic realm=\"timestamp server\"");
    }

    // ------------------------------------------------------------------ certificates

    @Test
    void theCertificateIsServedAsPemChainAndAsDer() throws Exception {
        Reply pem = get(path() + "/certificate");
        assertThat(pem.status()).isEqualTo(200);
        assertThat(pem.type()).isEqualTo("application/pem-certificate-chain");
        assertThat(pem.headers().getFirst("Content-Disposition")).isEqualTo("inline; filename=\"timestamp-server.pem\"");
        assertThat(pem.headers().getFirst("Cache-Control")).isEqualTo("no-cache");
        assertThat(pem.headers().getFirst("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(pem.text()).startsWith("-----BEGIN CERTIFICATE-----\n");

        Reply der = get(path() + "/certificate?format=der");
        assertThat(der.status()).isEqualTo(200);
        assertThat(der.type()).isEqualTo("application/pkix-cert");
        assertThat(der.headers().getFirst("Content-Disposition")).isEqualTo("inline; filename=\"timestamp-server.cer\"");
        java.security.cert.X509Certificate leaf = (java.security.cert.X509Certificate) java.security.cert.CertificateFactory.getInstance("X.509")
            .generateCertificate(new java.io.ByteArrayInputStream(der.body()));
        assertThat(leaf.getSubjectX500Principal().getName()).contains("Datum development timestamp server");
    }

    @Test
    void theCertificatesListNamesTheCurrentAndTheRetiredOnes() {
        Reply reply = get(path() + "/certificates");

        assertThat(reply.status()).isEqualTo(200);
        assertThat(reply.type()).isEqualTo("application/x-pem-file");
        String text = reply.text();
        assertThat(text).startsWith("# CN=Datum development timestamp server\n# SHA-256 ");
        assertThat(text).contains("\n# Current\n-----BEGIN CERTIFICATE-----").contains("\n# Retired\n-----BEGIN CERTIFICATE-----");
        assertThat(text.split("-----BEGIN CERTIFICATE-----", -1)).hasSize(3);
        assertThat(text).containsPattern("# Valid \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d to \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC\n");
        assertThat(text).containsPattern("# SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}\n");
    }

    // ------------------------------------------------------------------ health and OpenAPI

    @Test
    void theHealthCheckIsUpAndSaysWhereSerialsComeFrom() {
        DatumHealthContributors.Status status = health.evaluate().get("datum-tsa");

        assertThat(status).isNotNull();
        assertThat(status.up()).isTrue();
        assertThat(status.details()).containsEntry("serialAllocator", "memory").containsEntry("access", "open").containsEntry("key", "present");
    }

    @Test
    void theOpenApiDocumentListsTheThreeRoutesWithTheTimestampMediaTypes() throws Exception {
        Reply doc = get("/v3/api-docs/datum-tsa");
        assertThat(doc.status()).isEqualTo(200);
        JsonNode root = new JsonMapper().readTree(doc.body());
        Set<String> paths = new TreeSet<>();
        root.path("paths").propertyNames().forEach(paths::add);
        assertThat(paths).isEqualTo(new TreeSet<>(Arrays.asList(path(), path() + "/certificate", path() + "/certificates")));

        JsonNode post = root.path("paths").path(path()).path("post");
        assertThat(post.path("operationId").asString()).isEqualTo("issueTimestamp");
        assertThat(post.path("requestBody").path("content").propertyNames()).contains("application/timestamp-query");
        assertThat(post.path("responses").path("200").path("content").propertyNames()).contains("application/timestamp-reply");
        assertThat(post.path("responses").propertyNames()).contains("200", "400", "401", "403", "413", "415", "429", "503");
    }

    /** The document holds to the library's endpoint catalog (integrations/jvm/README.md "Libraries and bindings"), on this stack. */
    @Test
    void theDocumentHoldsToTheEndpointCatalog() throws Exception {
        JsonNode doc = new JsonMapper().readTree(get("/v3/api-docs/datum-tsa").body());
        java.util.Map<com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base, String> bases = java.util.Map.of(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.TSA, path());
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.differences(doc, bases)).isEmpty();
        assertThat(com.argusvane.datum.web.openapi.DatumEndpointCatalog.missing(doc, "tsa", bases, endpoint -> true)).isEmpty();
    }
}
