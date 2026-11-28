package com.argusvane.datum.pdf;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfProgram;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.pdf.verify.Certificates;
import com.argusvane.datum.timestamp.TimestampToken;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * A runtime that plays the PDF program with the kernel's reply shapes ({@code pdf-abi.ts} {@code PdfKernelResponse}),
 * so the service can be tested without a WebAssembly engine.
 *
 * <p>{@code capabilities} answers ABI 1.0.0 and a kernel version. {@code document}, {@code render} and
 * {@code fill} answer a small "PDF" ({@code %PDF-1.7} and the request's digest) and, when the request carries a
 * {@code signature}, a signing handoff shaped as the kernel's ({@code sign.ts prepareSignature}): the byte range
 * {@code [0, 10, 20, length - 20]}, its SHA-256 as {@code digest}, and as {@code toBeSigned} a DER SET of signed
 * attributes ({@link #signedAttributes}: contentType, messageDigest = that digest, and the commitment the kernel
 * reads, the request's over the printed layout's, a statement kept unless ""). {@code sign} prepares the same way.
 * {@code complete} checks what the kernel checks of the host's half: a known prepared file, the same certificates,
 * the attributes rebuilt from the bytes and the completion's commitment whose SHA-256 must be the echoed
 * {@code toBeSignedDigest}, a value that verifies over them with the leaf's key (an ECDSA value as DER or
 * {@code r||s}, as the kernel takes both), and a timestamp token whose imprint is the value's SHA-256 (else
 * {@code signature}: "the token vouches for a different signature value"). Every op may be replaced with {@link #on}.
 */
public final class ScriptedPdfRuntime implements GuestRuntime {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** One request the runtime received. */
    public record Request(String op, ObjectNode body) {
    }

    /** What a prepare handed out. */
    record Prepared(byte[] toBeSigned, List<String> certificates, String field) {
    }

    /** The kernel's commitment-type OIDs ({@code COMMITMENT_TYPE_OIDS}, ETSI TS 101 733). */
    static final Map<String, String> COMMITMENT_TYPE_OIDS = Map.of("origin", "1.2.840.113549.1.9.16.6.1", "receipt", "1.2.840.113549.1.9.16.6.2",
        "delivery", "1.2.840.113549.1.9.16.6.3", "sender", "1.2.840.113549.1.9.16.6.4", "approval", "1.2.840.113549.1.9.16.6.5",
        "creation", "1.2.840.113549.1.9.16.6.6");

    /** A commitment the kernel refuses ({@code commitmentOf} throws). */
    static final class BadCommitment extends RuntimeException {
        BadCommitment(String message) {
            super(message);
        }
    }

    private final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, Function<ObjectNode, String>> handlers = new ConcurrentHashMap<>();
    private final Map<String, Prepared> prepared = new ConcurrentHashMap<>();

    public ScriptedPdfRuntime() {
        handlers.put("document", this::produced);
        handlers.put("render", this::produced);
        handlers.put("fill", this::produced);
        handlers.put("sign", this::produced);
        handlers.put("complete", this::complete);
        handlers.put("timestampRequest", body -> {
            byte[] value = Base64.getDecoder().decode(body.path("signature").asString(""));
            return "{\"ok\":true,\"op\":\"timestampRequest\",\"request\":\""
                + Base64.getEncoder().encodeToString(com.argusvane.datum.timestamp.TimestampQuery.forData(value)) + "\"}";
        });
        handlers.put("inspect", body -> "{\"ok\":true,\"op\":\"inspect\",\"info\":{\"pageCount\":1,\"pages\":[],\"fields\":[],\"hasXfa\":false,\"encrypted\":false}}");
        handlers.put("build", body -> "{\"ok\":true,\"op\":\"build\",\"layoutId\":\"default\",\"layoutKind\":\"derived\",\"document\":{},\"warnings\":[]}");
        handlers.put("layout", body -> "{\"ok\":true,\"op\":\"layout\",\"pages\":[],\"warnings\":[]}");
        handlers.put("verify", body -> "{\"ok\":true,\"op\":\"verify\",\"signatures\":[],\"attachments\":[],\"warnings\":[],\"documentId\":null}");
    }

    /** Replaces an op's answer. */
    public ScriptedPdfRuntime on(String op, Function<ObjectNode, String> answer) {
        handlers.put(op, answer);
        return this;
    }

    /** Every request but the capabilities probe, in order. */
    public List<Request> requests() {
        synchronized (requests) {
            return List.copyOf(requests);
        }
    }

    /** The requests of one op. */
    public List<ObjectNode> requests(String op) {
        return requests().stream().filter(r -> r.op().equals(op)).map(Request::body).toList();
    }

    public long count(String op) {
        return requests().stream().filter(r -> r.op().equals(op)).count();
    }

    /**
     * A PdfRuntime over this runtime: its own program, slots, and an engine of the given mode ({@code bytecode} cannot
     * run the PDF program, as Endive's bytecode fallback cannot).
     */
    public PdfRuntime pdfRuntime(String mode, int slots) {
        ProgramLimits limits = ProgramLimits.defaults();
        PdfProgram program = new PdfProgram(ProgramRunner.on(this), Program.of(Program.Kind.PDF, "/* pdf program */".getBytes(StandardCharsets.UTF_8)), limits,
            new AbiProbe());
        HostOptions host = new HostOptions("fail", "refuse", "UTC", Clock.fixed(Instant.parse("2026-10-15T12:00:00Z"), ZoneOffset.UTC));
        return PdfRuntime.of(program, new RunSlots(slots, Duration.ZERO, "PDF render"), engine(mode), host, limits);
    }

    /** A scripted engine of this mode. */
    public static EngineInfo engine(String mode) {
        boolean bytecode = EngineInfo.BYTECODE.equals(mode);
        return new EngineInfo("scripted", "test", mode, bytecode ? "No native code for this test platform." : "");
    }

    public PdfRuntime pdfRuntime() {
        return pdfRuntime("jffi", 2);
    }

    @Override
    public RunOutput run(GuestRun run) {
        byte[] stdin = run.stdinBytes();
        ObjectNode body;
        try {
            body = (ObjectNode) StrictJson.decode(stdin);
        } catch (StrictJson.NotJsonException e) {
            throw new IllegalStateException(e);
        }
        String op = body.path("op").asString("");
        if (op.equals("capabilities")) {
            return RunOutput.exited(0, "{\"ok\":true,\"op\":\"capabilities\",\"abi\":\"1.0.0\",\"kernelVersion\":\"0.1.0\"}".getBytes(StandardCharsets.UTF_8),
                new byte[0]);
        }
        requests.add(new Request(op, body.deepCopy()));
        Function<ObjectNode, String> handler = handlers.get(op);
        String answer = handler == null ? "{\"ok\":false,\"error\":{\"code\":\"invalid_request\",\"message\":\"unknown op\"}}" : handler.apply(body);
        return RunOutput.exited(0, answer.getBytes(StandardCharsets.UTF_8), new byte[0]);
    }

    // ------------------------------------------------------------------------------------------------- the kernel's shapes

    /** {@code document}/{@code render}/{@code fill}/{@code sign}: a "PDF", and a handoff when there is a signature. */
    private String produced(ObjectNode body) {
        String op = body.path("op").asString("");
        byte[] pdf = ("%PDF-1.7\n% fake " + op + " " + sha256Hex(StrictJson.encode(body).getBytes(StandardCharsets.UTF_8)) + "\n%%EOF\n")
            .getBytes(StandardCharsets.US_ASCII);
        ObjectNode answer = NODES.objectNode();
        answer.put("ok", true);
        answer.put("op", op);
        answer.put("bytes", Base64.getEncoder().encodeToString(pdf));
        if (!op.equals("sign")) {
            answer.put("pageCount", 1);
            answer.putArray("pages");
        }
        answer.putArray("warnings");
        if (op.equals("document")) {
            String layout = body.path("layoutId").isString() ? body.path("layoutId").stringValue() : chosenLayout(body);
            answer.put("layoutId", layout);
            answer.put("layoutKind", layout.equals("default") ? "derived" : "generated");
            answer.put("layoutChoice", body.path("layoutId").isString() ? "asked" : (layout.equals("default") ? "derived" : "default"));
        }
        JsonNode signature = body.get("signature");
        if (signature != null && signature.isObject()) {
            List<String> certificates = new ArrayList<>();
            signature.path("certificates").values().forEach(c -> certificates.add(c.asString()));
            if (certificates.isEmpty()) {
                return "{\"ok\":false,\"error\":{\"code\":\"signature\",\"message\":\"A signature needs at least the signer's certificate.\"}}";
            }
            X509Certificate leaf = Certificates.fromBase64(certificates.get(0));
            // The kernel's merge ({...layout, ...requested}): the request's commitment, else the printed layout's.
            JsonNode commitment = signature.has("commitment") ? signature.get("commitment") : layoutBlock(body).get("commitment");
            byte[] toBeSigned;
            try {
                toBeSigned = signedAttributes(digestOver(pdf), commitment);
            } catch (BadCommitment e) {
                return failure("signature", e.getMessage());
            }
            String field = signature.path("field").isString() ? signature.path("field").stringValue() : "Signature1";
            prepared.put(sha256Hex(pdf), new Prepared(toBeSigned, certificates, field));
            ObjectNode signing = answer.putObject("signing");
            signing.put("field", field);
            ArrayNode range = signing.putArray("byteRange");
            range.add(0).add(10).add(20).add(pdf.length - 20);
            signing.put("digest", Base64.getEncoder().encodeToString(digestOver(pdf)));
            signing.put("toBeSigned", Base64.getEncoder().encodeToString(toBeSigned));
            signing.put("toBeSignedDigest", Base64.getEncoder().encodeToString(sha256(toBeSigned)));
            signing.put("signatureAlgorithm", algorithmOf(leaf));
            signing.put("subFilter", signature.path("subFilter").asString("ETSI.CAdES.detached"));
        }
        return StrictJson.encode(answer);
    }

    /** The printed layout's own signature block (document: the layout by id; render: the document's), or an empty object. */
    private static JsonNode layoutBlock(ObjectNode body) {
        String op = body.path("op").asString("");
        if (op.equals("render")) {
            JsonNode block = body.path("document").path("signature");
            return block.isObject() ? block : NODES.objectNode();
        }
        if (!op.equals("document")) {
            return NODES.objectNode();
        }
        String layout = body.path("layoutId").isString() ? body.path("layoutId").stringValue() : chosenLayout(body);
        for (JsonNode candidate : body.path("pdf").path("layouts").values()) {
            if (candidate.path("id").asString("").equals(layout) && candidate.path("signature").isObject()) {
                return candidate.get("signature");
            }
        }
        return NODES.objectNode();
    }

    /** SHA-256 over the fake prepared file's byte range {@code [0, 10, 20, length - 20]}. */
    public static byte[] digestOver(byte[] pdf) {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            sha.update(pdf, 0, 10);
            sha.update(pdf, 20, pdf.length - 20);
            return sha.digest();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Signed attributes as the kernel builds them ({@code cms.ts signedAttributes}, DER): contentType id-data,
     * messageDigest, and a commitment-type indication when the commitment names one, its statement kept unless ""
     * (the kernel's {@code commitmentOf}).
     *
     * @throws BadCommitment for a commitment the kernel refuses
     */
    public static byte[] signedAttributes(byte[] digest, JsonNode commitment) {
        org.bouncycastle.asn1.ASN1EncodableVector attributes = new org.bouncycastle.asn1.ASN1EncodableVector();
        attributes.add(new org.bouncycastle.asn1.DERSequence(new org.bouncycastle.asn1.ASN1Encodable[] {
            new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.3"),
            new org.bouncycastle.asn1.DERSet(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.7.1"))}));
        attributes.add(new org.bouncycastle.asn1.DERSequence(new org.bouncycastle.asn1.ASN1Encodable[] {
            new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.4"),
            new org.bouncycastle.asn1.DERSet(new org.bouncycastle.asn1.DEROctetString(digest))}));
        if (commitment != null && !commitment.isNull()) {
            String oid = COMMITMENT_TYPE_OIDS.get(commitment.path("type").isString() ? commitment.path("type").stringValue() : "");
            if (oid == null) {
                throw new BadCommitment("Unknown commitment type");
            }
            JsonNode statement = commitment.get("statement");
            if (statement != null && !statement.isString()) {
                throw new BadCommitment("commitment.statement must be a string");
            }
            org.bouncycastle.asn1.ASN1EncodableVector indication = new org.bouncycastle.asn1.ASN1EncodableVector();
            indication.add(new org.bouncycastle.asn1.ASN1ObjectIdentifier(oid));
            if (statement != null && !statement.stringValue().isEmpty()) {
                indication.add(new org.bouncycastle.asn1.DERUTF8String(statement.stringValue()));
            }
            attributes.add(new org.bouncycastle.asn1.DERSequence(new org.bouncycastle.asn1.ASN1Encodable[] {
                new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.16"),
                new org.bouncycastle.asn1.DERSet(new org.bouncycastle.asn1.DERSequence(indication))}));
        }
        try {
            return new org.bouncycastle.asn1.DERSet(attributes).getEncoded("DER");
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The layout the answers choose when none is asked: the declared default, else the first, else derived. */
    private static String chosenLayout(ObjectNode body) {
        JsonNode pdf = body.path("pdf");
        if (pdf.path("defaultLayoutId").isString()) {
            return pdf.path("defaultLayoutId").stringValue();
        }
        for (JsonNode layout : pdf.path("layouts").values()) {
            if (layout.path("id").isString()) {
                return layout.path("id").stringValue();
            }
        }
        return "default";
    }

    static String algorithmOf(X509Certificate leaf) {
        String kind = com.argusvane.datum.timestamp.TsaCertificateRules.algorithm(leaf);
        if (kind == null) {
            return "unknown";
        }
        return switch (kind) {
            case "EC-P256" -> "ECDSA-P256-SHA256";
            case "EC-P384" -> "ECDSA-P384-SHA256";
            default -> "RSASSA-PKCS1-v1_5-SHA256";
        };
    }

    /** {@code complete}: the host's half checked as the kernel checks it. */
    private String complete(ObjectNode body) {
        byte[] pdf = Base64.getDecoder().decode(body.path("pdf").path("data").asString(""));
        Prepared was = prepared.get(sha256Hex(pdf));
        if (was == null) {
            return failure("signature", "The PDF has no prepared signature to complete.");
        }
        JsonNode signing = body.path("signing");
        List<String> certificates = new ArrayList<>();
        signing.path("certificates").values().forEach(c -> certificates.add(c.asString()));
        if (!certificates.equals(was.certificates())) {
            return failure("signature", "The certificates differ from the ones the signature was prepared with.");
        }
        // The kernel rebuilds the attributes from the bytes and the completion's commitment, then compares digests.
        byte[] rebuilt;
        try {
            rebuilt = signedAttributes(digestOver(pdf), signing.get("commitment"));
        } catch (BadCommitment e) {
            return failure("signature", e.getMessage());
        }
        if (signing.path("toBeSignedDigest").isString()
            && !signing.path("toBeSignedDigest").stringValue().equals(Base64.getEncoder().encodeToString(sha256(rebuilt)))) {
            return failure("signature", "The signed attributes differ from what sign handed out: the bytes, the certificates or the commitment changed in between");
        }
        byte[] value = Base64.getDecoder().decode(signing.path("value").asString(""));
        X509Certificate leaf = Certificates.fromBase64(certificates.get(0));
        if (!verifies(leaf, rebuilt, value)) {
            return failure("signature", "The signature value does not verify with the signer's certificate.");
        }
        boolean timestamped = false;
        JsonNode token = signing.path("timestamp").path("token");
        if (token.isString()) {
            TimestampToken parsed;
            try {
                parsed = TimestampToken.parse(Base64.getDecoder().decode(token.stringValue()));
            } catch (RuntimeException e) {
                return failure("signature", "The timestamp token cannot be read.");
            }
            if (!parsed.covers(value)) {
                return failure("signature", "The timestamp token vouches for a different signature value.");
            }
            timestamped = true;
        }
        byte[] signed = ("%PDF-1.7\n% signed " + sha256Hex(value) + (timestamped ? " timestamped" : "") + "\n%%EOF\n").getBytes(StandardCharsets.US_ASCII);
        ObjectNode answer = NODES.objectNode();
        answer.put("ok", true);
        answer.put("op", "complete");
        answer.put("bytes", Base64.getEncoder().encodeToString(signed));
        answer.put("field", was.field());
        answer.put("cms", Base64.getEncoder().encodeToString(new byte[] {0x30, 0x00}));
        answer.put("timestamped", timestamped);
        return StrictJson.encode(answer);
    }

    private static boolean verifies(X509Certificate leaf, byte[] data, byte[] value) {
        List<String> algorithms = leaf.getPublicKey().getAlgorithm().equals("RSA") ? List.of("SHA256withRSA")
            : List.of("SHA256withECDSA", "SHA256withECDSAinP1363Format");
        for (String algorithm : algorithms) {
            try {
                Signature verifier = Signature.getInstance(algorithm);
                verifier.initVerify(leaf.getPublicKey());
                verifier.update(data);
                if (verifier.verify(value)) {
                    return true;
                }
            } catch (Exception e) {
                // next
            }
        }
        return false;
    }

    public static String failure(String code, String message) {
        ObjectNode answer = NODES.objectNode();
        answer.put("ok", false);
        answer.set("error", objectOf(code, message));
        return StrictJson.encode(answer);
    }

    private static ObjectNode objectOf(String code, String message) {
        ObjectNode error = NODES.objectNode();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String sha256Hex(byte[] bytes) {
        return java.util.HexFormat.of().formatHex(sha256(bytes));
    }
}
