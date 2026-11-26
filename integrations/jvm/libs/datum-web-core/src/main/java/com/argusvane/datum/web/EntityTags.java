package com.argusvane.datum.web;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * HTTP entity tags (RFC 9110 section 8.8.3) for the two places a Datum facade reads or writes one: the
 * {@code ETag} of a definition or catalog (the hash in quotes) and the {@code If-None-Match} / {@code If-Match}
 * request headers, which are lists. One reader for both, so a list is read the same everywhere.
 *
 * <p>Spring's {@code checkNotModified} is not used: it answers 412 for a failed {@code If-Match}, where the wire
 * says 409 with the current hash in the body, so the facades (framework-free) decide.
 *
 * <p>Tags are compared on their opaque value: a weak marker ({@code W/}) and the quotes are taken off, a bare
 * (unquoted) tag is read as its value too, as the browser builder has always sent it. That is the weak comparison
 * of RFC 9110 for both headers, a deliberate leniency for {@code If-Match}.
 */
public final class EntityTags {

    private EntityTags() {
    }

    /** The hash as an entity tag: in quotes. */
    public static String of(String hash) {
        return "\"" + hash + "\"";
    }

    /**
     * The opaque values a header lists, in order; empty for a missing or blank header. {@code *} is returned as
     * {@code "*"}. A comma inside quotes belongs to the tag.
     */
    public static List<String> parse(String header) {
        return tagsOf(header).stream().map(Tag::value).toList();
    }

    /** A tag's opaque value, and whether it is the wildcard: only a bare {@code *}; a quoted one is an ordinary tag. */
    private record Tag(String value, boolean wildcard) {
    }

    private static List<Tag> tagsOf(String header) {
        List<Tag> tags = new ArrayList<>();
        if (header == null) {
            return tags;
        }
        int at = 0;
        int length = header.length();
        while (at < length) {
            while (at < length && (header.charAt(at) == ',' || Character.isWhitespace(header.charAt(at)))) {
                at++;
            }
            if (at >= length) {
                break;
            }
            if (header.startsWith("W/", at)) {
                at += 2;
            }
            StringBuilder tag = new StringBuilder();
            boolean quoted = at < length && header.charAt(at) == '"';
            if (quoted) {
                at++;
                while (at < length && header.charAt(at) != '"') {
                    tag.append(header.charAt(at++));
                }
                at++;
                // Anything between the closing quote and the next comma is not part of the tag.
                while (at < length && header.charAt(at) != ',') {
                    at++;
                }
            } else {
                while (at < length && header.charAt(at) != ',') {
                    tag.append(header.charAt(at++));
                }
            }
            String opaque = tag.toString().strip();
            if (!opaque.isEmpty()) {
                tags.add(new Tag(opaque, !quoted && opaque.equals("*")));
            }
        }
        return tags;
    }

    /** Whether an {@code If-None-Match} header lists {@code value} or is {@code *}: the client's copy is current. */
    public static boolean matchesAny(String header, String value) {
        for (Tag tag : tagsOf(header)) {
            if (tag.wildcard() || tag.value().equals(value)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether an {@code If-Match} precondition holds for the current value: no header (or a blank one), {@code *}, or
     * a listed tag equal to it. Compared in constant time, as the hashes guard a write.
     */
    public static boolean preconditionHolds(String header, String current) {
        List<Tag> tags = tagsOf(header);
        if (tags.isEmpty()) {
            return true;
        }
        byte[] expected = current.getBytes(StandardCharsets.UTF_8);
        boolean holds = false;
        for (Tag tag : tags) {
            // No short circuit: how many tags matched is not a timing signal worth leaking, and the list is short.
            holds |= tag.wildcard() | MessageDigest.isEqual(expected, tag.value().getBytes(StandardCharsets.UTF_8));
        }
        return holds;
    }
}
