package com.argusvane.datum.core;

import org.jspecify.annotations.Nullable;

/**
 * The part of a client address a counter keys on: the submission throttle (and the PDF and passkey routes it also
 * counts), and the timestamp server's flood rule and wrong-key lockout.
 *
 * <p>One host is commonly handed a whole IPv6 /64 and can send each request from a new address in it, so an IPv6
 * client is counted by its /64, written as the network ({@code 2001:db8:1:2::/64}: lower case, no leading zeros, the
 * first longest run of two or more zero groups as {@code ::}, the form the FastAPI host writes); an IPv4 client, and an
 * IPv4 address written as IPv4-mapped IPv6 ({@code ::ffff:203.0.113.7}), by its IPv4 address. A zone index
 * ({@code %eth0}) is dropped: the network is the same whatever interface the request arrived on. An IPv6 address in
 * brackets ({@code [2001:db8::1]}, or {@code [2001:db8::1]:8443}), the form Spring's forwarded-header handling reports
 * a proxied IPv6 client in, is counted by the address inside the brackets; so is a bracketed IPv4 address followed
 * by a port ({@code [203.0.113.7:4711]}), the form it reports an IPv4 client in when the proxy wrote the port. A string that is not
 * an IP address (a test client's name, a socket path) is counted as it is, and so is an IPv4 address: as given.
 *
 * <p>The address is parsed here rather than through {@code InetAddress}, which resolves a string that is not a literal
 * through DNS: a counter must never make a network call on a client-supplied value. The grammar is the one Python's
 * {@code ipaddress} reads (one to four hex digits per group, at most one {@code ::} standing for at least one group, a
 * dotted IPv4 tail of four decimal octets without leading zeros), so both hosts count an address alike. Applying the
 * function to its own result gives the same result, so a key counted twice is still one key.
 */
public final class CountedAddress {

    /** The prefix length an IPv6 client is counted under. */
    public static final int IPV6_PREFIX = 64;

    private CountedAddress() {
    }

    /** What a counter keys {@code address} on: the IPv6 /64, the IPv4 address of a mapped one, else the address as given. */
    public static @Nullable String of(@Nullable String address) {
        if (address == null || address.isEmpty() || address.indexOf(':') < 0) {
            return address;
        }
        String literal = unbracketed(address);
        if (literal != null) {
            String ipv4 = ipv4BeforePort(literal);
            if (ipv4 != null) {
                return ipv4;
            }
        }
        int[] groups = ipv6(literal == null ? address : literal);
        if (groups == null) {
            return address;
        }
        if (groups[0] == 0 && groups[1] == 0 && groups[2] == 0 && groups[3] == 0 && groups[4] == 0 && groups[5] == 0xffff) {
            return (groups[6] >> 8) + "." + (groups[6] & 0xff) + "." + (groups[7] >> 8) + "." + (groups[7] & 0xff);
        }
        int[] network = new int[8];
        System.arraycopy(groups, 0, network, 0, IPV6_PREFIX / 16);
        return compressed(network) + "/" + IPV6_PREFIX;
    }

    /**
     * What is inside one bracketed literal ({@code [2001:db8::1]}, optionally followed by {@code :port}, one to five ASCII
     * digits up to 65535), or null when the text is not one. Behind a proxy Spring's forwarded-header handling reports an
     * IPv6 client this way: {@code X-Forwarded-For} gets brackets added around a bare IPv6 entry and keeps an entry
     * already bracketed, port included, as sent; {@code Forwarded: for="[...]"} keeps the brackets and drops the port.
     * Counted as written, the brackets would make every address of one /64 a key of its own. The caller still parses
     * what is inside, so a bracketed text that is not an IPv6 address is counted as it is.
     */
    private static @Nullable String unbracketed(String text) {
        if (text.charAt(0) != '[') {
            return null;
        }
        int close = text.indexOf(']');
        if (close < 0 || text.indexOf('[', 1) >= 0 || text.indexOf(']', close + 1) >= 0) {
            return null;
        }
        if (close < text.length() - 1 && (text.charAt(close + 1) != ':' || !isPort(text.substring(close + 2)))) {
            return null;
        }
        return text.substring(1, close);
    }

    /**
     * The IPv4 address of {@code a.b.c.d:port}, or null when the text is not that. Spring's {@code X-Forwarded-For}
     * handling brackets any entry holding a colon, so a proxy that writes an IPv4 client with its port
     * ({@code 203.0.113.7:4711}) is reported as {@code [203.0.113.7:4711]}; counted as written, every connection would
     * be a key of its own.
     */
    private static @Nullable String ipv4BeforePort(String text) {
        int colon = text.indexOf(':');
        if (colon < 0 || text.indexOf(':', colon + 1) >= 0 || !isPort(text.substring(colon + 1))) {
            return null;
        }
        String host = text.substring(0, colon);
        return ipv4Bits(host) < 0 ? null : host;
    }

    /** A port: one to five ASCII digits, at most 65535. */
    private static boolean isPort(String digits) {
        if (digits.isEmpty() || digits.length() > 5) {
            return false;
        }
        int value = 0;
        for (int i = 0; i < digits.length(); i++) {
            char c = digits.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
            value = value * 10 + (c - '0');
        }
        return value <= 65_535;
    }

    /** The eight groups of an IPv6 address (a zone index allowed and ignored), or null when it is not one. */
    private static int @Nullable [] ipv6(String text) {
        String address = text;
        int zone = text.indexOf('%');
        if (zone >= 0) {
            // As Python reads it: one zone index, not empty, after the address.
            if (zone == text.length() - 1 || text.indexOf('%', zone + 1) >= 0) {
                return null;
            }
            address = text.substring(0, zone);
        }
        int gap = address.indexOf("::");
        if (gap >= 0 && address.indexOf("::", gap + 1) >= 0) {
            return null;
        }
        int[] head;
        int[] tail;
        if (gap < 0) {
            head = groups(address, true);
            tail = new int[0];
            if (head == null || head.length != 8) {
                return null;
            }
        } else {
            head = groups(address.substring(0, gap), false);
            tail = groups(address.substring(gap + 2), true);
            // The gap stands for at least one group.
            if (head == null || tail == null || head.length + tail.length > 7) {
                return null;
            }
        }
        int[] all = new int[8];
        System.arraycopy(head, 0, all, 0, head.length);
        System.arraycopy(tail, 0, all, 8 - tail.length, tail.length);
        return all;
    }

    /**
     * The groups of one side of the gap ({@code ""} is none), each one to four hex digits; the last may be a dotted IPv4
     * address (two groups) when {@code last} says this side ends the address. Null when a part is not a group.
     */
    private static int @Nullable [] groups(String side, boolean last) {
        if (side.isEmpty()) {
            return new int[0];
        }
        String[] parts = side.split(":", -1);
        int[] out = new int[parts.length + 1];
        int n = 0;
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (last && i == parts.length - 1 && part.indexOf('.') >= 0) {
                long bits = ipv4Bits(part);
                if (bits < 0) {
                    return null;
                }
                out[n++] = (int) (bits >>> 16);
                out[n++] = (int) (bits & 0xffff);
                continue;
            }
            int group = hextet(part);
            if (group < 0) {
                return null;
            }
            out[n++] = group;
        }
        int[] trimmed = new int[n];
        System.arraycopy(out, 0, trimmed, 0, n);
        return trimmed;
    }

    /** One group: one to four ASCII hex digits, else -1. */
    private static int hextet(String part) {
        if (part.isEmpty() || part.length() > 4) {
            return -1;
        }
        int value = 0;
        for (int i = 0; i < part.length(); i++) {
            int digit = hexDigit(part.charAt(i));
            if (digit < 0) {
                return -1;
            }
            value = value * 16 + digit;
        }
        return value;
    }

    private static int hexDigit(char c) {
        if (c >= '0' && c <= '9') {
            return c - '0';
        }
        if (c >= 'a' && c <= 'f') {
            return c - 'a' + 10;
        }
        if (c >= 'A' && c <= 'F') {
            return c - 'A' + 10;
        }
        return -1;
    }

    /** A dotted IPv4 address as its 32 bits, or -1: four decimal octets of one to three ASCII digits, no leading zero, at most 255. */
    private static long ipv4Bits(String part) {
        String[] octets = part.split("\\.", -1);
        if (octets.length != 4) {
            return -1;
        }
        long bits = 0;
        for (String octet : octets) {
            if (octet.isEmpty() || octet.length() > 3 || (octet.length() > 1 && octet.charAt(0) == '0')) {
                return -1;
            }
            int value = 0;
            for (int i = 0; i < octet.length(); i++) {
                char c = octet.charAt(i);
                if (c < '0' || c > '9') {
                    return -1;
                }
                value = value * 10 + (c - '0');
            }
            if (value > 255) {
                return -1;
            }
            bits = (bits << 8) | value;
        }
        return bits;
    }

    /** The groups as RFC 5952 text: hex without leading zeros, the first longest run of two or more zero groups as {@code ::}. */
    private static String compressed(int[] groups) {
        int bestStart = -1;
        int bestLength = 1;
        for (int i = 0; i < groups.length; ) {
            if (groups[i] != 0) {
                i++;
                continue;
            }
            int start = i;
            while (i < groups.length && groups[i] == 0) {
                i++;
            }
            if (i - start > bestLength) {
                bestStart = start;
                bestLength = i - start;
            }
        }
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < groups.length; i++) {
            if (i == bestStart) {
                text.append("::");
                i += bestLength - 1;
                continue;
            }
            if (text.length() > 0 && text.charAt(text.length() - 1) != ':') {
                text.append(':');
            }
            text.append(Integer.toHexString(groups[i]));
        }
        return text.toString();
    }
}
