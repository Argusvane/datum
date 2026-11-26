package com.argusvane.datum.web.json;

import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.error.UnsupportedMediaTypeException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;

/**
 * Reading a JSON request body safely, whichever web stack delivers it.
 *
 * <p>The order a controller applies is: {@link #requireJson} (415), {@link #read} (the cap counted on the raw
 * stream before any parsing: 413 {@code bad_document}), then {@link #parse} (400 {@code bad_document}). The
 * stack-specific readers ({@code MvcBodies}, {@code WebFluxBodies}) wrap these steps.
 */
public final class JsonBodies {

    private JsonBodies() {
    }

    /**
     * Refuses any Content-Type but JSON with 415: {@code application/json} or a {@code +json} type, with no
     * charset or UTF-8 (JSON is UTF-8; another charset would be read as the wrong text).
     *
     * @throws UnsupportedMediaTypeException when the type is missing or not JSON
     */
    public static void requireJson(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            throw new UnsupportedMediaTypeException();
        }
        String[] parts = contentType.split(";");
        String type = parts[0].strip().toLowerCase(Locale.ROOT);
        if (!type.equals("application/json") && !(type.startsWith("application/") && type.endsWith("+json"))) {
            throw new UnsupportedMediaTypeException();
        }
        for (int i = 1; i < parts.length; i++) {
            String parameter = parts[i].strip().toLowerCase(Locale.ROOT);
            if (parameter.startsWith("charset=")) {
                String charset = parameter.substring("charset=".length()).replace("\"", "").strip();
                if (!charset.equals("utf-8") && !charset.equals("utf8")) {
                    throw new UnsupportedMediaTypeException();
                }
            }
        }
    }

    /**
     * Reads at most {@code cap} bytes. A declared Content-Length over the cap refuses before a byte is read; a
     * stream longer than the cap stops one byte past it (so memory stays bounded by the cap).
     *
     * @param declaredLength the Content-Length, or a negative number when unknown (chunked)
     * @throws RequestTooLargeException when the body is longer than {@code cap}
     */
    public static byte[] read(InputStream in, long declaredLength, long cap) {
        if (declaredLength > cap) {
            throw tooLarge(cap);
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(Math.max(declaredLength, 512), cap));
            byte[] chunk = new byte[8192];
            long total = 0;
            int n;
            while ((n = in.read(chunk)) != -1) {
                total += n;
                if (total > cap) {
                    throw tooLarge(cap);
                }
                out.write(chunk, 0, n);
            }
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException("The request body could not be read.", e);
        }
    }

    /** The 413 for a body past {@code cap} bytes. */
    public static RequestTooLargeException tooLarge(long cap) {
        return new RequestTooLargeException(cap, "The request body is larger than " + cap + " bytes.");
    }

    /**
     * Parses a body as one JSON value with the Datum mapper.
     *
     * @throws BadRequestException ({@code bad_document}) for text that is not JSON as the mapper reads it:
     *         invalid UTF-8, trailing tokens, nesting past 256, a number or string past its limit
     */
    public static JsonNode parse(DatumJsonMapper json, byte[] body) {
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(body))
                .toString();
        } catch (CharacterCodingException e) {
            throw new BadRequestException("The submission is not JSON.", e);
        }
        if (text.isBlank()) {
            throw new BadRequestException("The submission is not JSON.");
        }
        try {
            JsonNode node = json.mapper().readTree(text);
            if (node == null || node.isMissingNode()) {
                throw new BadRequestException("The submission is not JSON.");
            }
            return node;
        } catch (JacksonException e) {
            throw new BadRequestException("The submission is not JSON.", e);
        }
    }
}
