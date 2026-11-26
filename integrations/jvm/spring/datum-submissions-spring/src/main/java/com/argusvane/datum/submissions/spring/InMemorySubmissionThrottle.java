package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.core.CountedAddress;
import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.web.WebSettings;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The development default throttle: a fixed window per key, in a bounded map that forgets expired windows ({@code limit} attempts per {@code window} per identifier).
 *
 * <p>It lives in the binding, not the library (framework-first): a throttle is rate limiting, which the
 * framework's own tools do (a Bucket4j bean is one way). The library keeps only the
 * {@link SubmissionThrottle} contract; this class is what an application that supplied none gets, with the WARN that
 * says it counts per instance.
 *
 * <p>Which parts of a {@link ThrottleKey} make a key is {@code datum.web.throttle.by} ({@code ip},
 * {@code form}, {@code principal}); the route kind is always part of it, so a flood of validity checks does not
 * use up a visitor's submissions. The address part is the address as {@link CountedAddress} counts it: an IPv6 client by
 * its /64 (one host is commonly handed a whole /64 and could otherwise count each request under a new address), an
 * IPv4-mapped one as its IPv4 address. The client address is whatever the request says it is: behind a proxy the
 * application enables Spring's {@code ForwardedHeaderFilter} (or {@code server.request.header.forwarded.strategy}) so
 * {@code remoteAddress} is the real client, not the proxy; without it every visitor shares one key.
 *
 * <p>The address limit ({@code datum.web.throttle.address-limit}, {@link #DEFAULT_ADDRESS_LIMIT} by default, 0 turns it
 * off) counts every request from one address to a throttled route in a window of its own, whatever form it names and
 * whatever {@code by} says: the routes ask it before they read the body, so a flood of bodies that never parse is
 * counted too. Its windows share the map, the window length, the bound and the eviction with the per-form windows, under
 * keys that start with a character no kind name holds, so the two counts never share a window. Each address window is a
 * caller of its own for the eviction below.
 *
 * <p>Counting is {@link #record}'s job, {@link #check} only reads, as the {@link SubmissionThrottle} contract
 * says. Two requests that both pass {@code check} before either records can overshoot the limit by the number of
 * racing threads, never more; the next request is refused.
 *
 * <p>The map holds at most {@code maxKeys} windows. When it is full the expired ones go first; if that does not
 * make room, a sixteenth of the live windows is dropped, taken from whoever holds the most: the caller (the key's
 * address and principal, every part but the form) with the most live windows gives up its window with the fewest
 * attempts first, the newest among equals, one at a time. A caller that opens windows by naming many forms (an unknown
 * form id is a 404 that still opens one) therefore evicts its own windows of one attempt first, so the full window it
 * is trying to reset goes after every cheaper one it holds; padding the sprayed windows up to the limit does not help
 * either, since among windows as full the newest goes first and the real window is the oldest. Another caller's window
 * is not touched while this one holds more; among callers holding as many, the one whose cheapest window has the
 * fewest attempts, then the newest, goes first (a flood from many addresses opens the newest windows, so the counters
 * already running keep counting). Windows that open at one instant are ordered by when they opened: each carries the
 * number of the window opened before it plus one, and the higher number is the newer. Memory stays bounded under a flood from many addresses at the price of
 * forgetting some counters (an attacker with as many addresses as windows can still gain fresh ones).
 * State is per process: behind several instances each counts alone, which the startup WARN says; replace the bean
 * with a gateway's or a shared store's for one limit across them.
 */
public final class InMemorySubmissionThrottle implements SubmissionThrottle {

    /** The default bound on live windows. */
    public static final int DEFAULT_MAX_KEYS = 10_000;

    /** The largest bound a host may set: ten million windows. */
    public static final int MAX_MAX_KEYS = 10_000_000;

    /**
     * The default address limit: ten times the default per-form limit, so many people behind one office NAT still get
     * through, while a flood from one address is still counted before its bodies are parsed.
     */
    public static final int DEFAULT_ADDRESS_LIMIT = 600;

    /**
     * The start of every address window's key and caller. Every per-form key starts with its kind's name (upper-case
     * letters), so no per-form key can start with this.
     */
    private static final String ADDRESS = "\u0001address\u0000";

    private static final Logger LOG = LoggerFactory.getLogger(InMemorySubmissionThrottle.class);

    /** The parts of the key, from {@code datum.web.throttle.by}. */
    public enum By {
        IP,
        FORM,
        PRINCIPAL;

        /** Reads a configured word ({@code ip}, {@code form}, {@code principal}), or null when unknown. */
        public static By of(String word) {
            if (word == null) {
                return null;
            }
            return switch (word.strip().toLowerCase(java.util.Locale.ROOT)) {
                case "ip" -> IP;
                case "form" -> FORM;
                case "principal", "user" -> PRINCIPAL;
                default -> null;
            };
        }
    }

    /**
     * One key's window: when it opened, the attempts in it, the caller it counts for (the key less its form), and its place
     * in the order windows opened in (two windows of one clock instant still have a newer one).
     */
    private record Window(long start, int count, String caller, long sequence) {
    }

    private final int limit;
    private final int addressLimit;
    private final Map<ThrottleKey.Kind, Integer> kindLimits;
    private final Duration window;
    private final List<By> by;
    private final Clock clock;
    private final int maxKeys;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();
    private final AtomicLong opened = new AtomicLong();

    /** With the {@link #DEFAULT_ADDRESS_LIMIT}. */
    public InMemorySubmissionThrottle(int limit, Duration window, List<By> by, Clock clock, int maxKeys) {
        this(limit, Map.of(), window, by, clock, maxKeys);
    }

    /** With the {@link #DEFAULT_ADDRESS_LIMIT}. */
    public InMemorySubmissionThrottle(int limit, Map<ThrottleKey.Kind, Integer> kindLimits, Duration window, List<By> by, Clock clock,
                                      int maxKeys) {
        this(limit, kindLimits, DEFAULT_ADDRESS_LIMIT, window, by, clock, maxKeys);
    }

    /**
     * @param kindLimits a limit for a route kind that differs from {@code limit} (a flood of validity checks may be allowed more
     *     than submissions, or less); a kind not named uses {@code limit}
     * @param addressLimit the requests one address may send per window to every throttled route together, before their
     *     bodies are read; 0 keeps no address limit
     */
    public InMemorySubmissionThrottle(int limit, Map<ThrottleKey.Kind, Integer> kindLimits, int addressLimit, Duration window, List<By> by,
                                      Clock clock, int maxKeys) {
        if (limit < 1) {
            throw new IllegalArgumentException("The limit is at least one attempt per window.");
        }
        if (addressLimit < 0) {
            throw new IllegalArgumentException("The address limit is at least one request per window, or 0 for none.");
        }
        Objects.requireNonNull(window, "window");
        if (window.isZero() || window.isNegative()) {
            throw new IllegalArgumentException("The window is longer than zero.");
        }
        this.limit = limit;
        this.addressLimit = addressLimit;
        this.kindLimits = Map.copyOf(kindLimits);
        this.window = window;
        this.by = List.copyOf(by);
        this.clock = Objects.requireNonNull(clock, "clock");
        this.maxKeys = Math.max(16, maxKeys);
    }

    /**
     * The throttle {@code datum.web.throttle.*} describes, and the startup WARN that the count is per instance. Every host binding builds the same throttle through this. A value that cannot work stops the start naming the property (framework-first: an unknown {@code by} word, a limit below 1 or a window that is not positive is
     * not clamped with a WARN, which would hide a mistyped switch of the one brake on submissions).
     *
     * @throws IllegalArgumentException naming the property
     */
    public static InMemorySubmissionThrottle fromSettings(WebSettings.Throttle settings, Clock clock) {
        return fromSettings(settings, Map.of(), DEFAULT_MAX_KEYS, DEFAULT_ADDRESS_LIMIT, clock);
    }

    /**
     * As above with the development throttle's own settings (binding-level, not part of {@code WebSettings}): a limit per route
     * kind ({@code datum.web.throttle.limits.<kind>}), the bound on live windows ({@code datum.web.throttle.max-keys}, 16 to
     * 10,000,000) and the address limit ({@code datum.web.throttle.address-limit}, at least 1, or 0 for none).
     *
     * @param kindLimits limits by kind name ({@code submit}, {@code validate}, {@code test}, {@code pdf}, {@code register})
     * @param addressLimit requests per window per address, before the body is read; 0 keeps no address limit
     */
    public static InMemorySubmissionThrottle fromSettings(WebSettings.Throttle settings, Map<String, Integer> kindLimits, int maxKeys,
                                                          int addressLimit, Clock clock) {
        if (addressLimit < 0) {
            throw new DatumConfigurationException("datum.web.throttle.address-limit", "datum.web.throttle.address-limit is " + addressLimit
                + "; it must be at least 1, or 0 to keep no address limit.");
        }
        if (maxKeys < 16 || maxKeys > MAX_MAX_KEYS) {
            throw new DatumConfigurationException("datum.web.throttle.max-keys", "datum.web.throttle.max-keys is " + maxKeys + "; it must be from 16 to " + MAX_MAX_KEYS + ".");
        }
        Map<ThrottleKey.Kind, Integer> perKind = new java.util.EnumMap<>(ThrottleKey.Kind.class);
        for (Map.Entry<String, Integer> entry : kindLimits.entrySet()) {
            ThrottleKey.Kind kind = kindOf(entry.getKey());
            if (kind == null) {
                throw new DatumConfigurationException("datum.web.throttle.limits", "datum.web.throttle.limits has the key '" + entry.getKey()
                    + "', which is not submit, validate, test, pdf or register.");
            }
            if (entry.getValue() == null || entry.getValue() < 1) {
                throw new DatumConfigurationException("datum.web.throttle.limits", "datum.web.throttle.limits." + entry.getKey() + " is " + entry.getValue()
                    + "; it must be at least 1.");
            }
            perKind.put(kind, entry.getValue());
        }
        List<By> by = new ArrayList<>();
        for (String word : settings.by()) {
            By part = By.of(word);
            if (part == null) {
                throw new DatumConfigurationException("datum.web.throttle.by", "datum.web.throttle.by contains '" + word + "', which is not ip, form or principal.");
            }
            if (!by.contains(part)) {
                by.add(part);
            }
        }
        int limit = settings.limit();
        if (limit < 1) {
            throw new DatumConfigurationException("datum.web.throttle.limit", "datum.web.throttle.limit is " + limit + "; it must be at least 1.");
        }
        Duration window = settings.window();
        if (window == null || window.isZero() || window.isNegative()) {
            throw new DatumConfigurationException("datum.web.throttle.window", "datum.web.throttle.window is " + window + "; it must be longer than zero.");
        }
        LOG.warn("Datum: the submission throttle is in memory ({} per {} by {}, {} per address): each application instance counts on its own. "
            + "Supply a SubmissionThrottle bean for one limit across instances.", limit, window, by, addressLimit == 0 ? "no limit" : addressLimit);
        return new InMemorySubmissionThrottle(limit, perKind, addressLimit, window, by, clock, maxKeys);
    }

    private static ThrottleKey.Kind kindOf(String word) {
        if (word == null) {
            return null;
        }
        try {
            return ThrottleKey.Kind.valueOf(word.strip().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException unknown) {
            return null;
        }
    }

    @Override
    public ThrottleDecision check(ThrottleKey key) {
        return check(keyOf(key), limitOf(key.kind()));
    }

    @Override
    public void record(ThrottleKey key) {
        record(keyOf(key), callerOf(key));
    }

    /** The address limit: allowed while the address's window holds fewer than {@link #addressLimit()} requests; always with none. */
    @Override
    public ThrottleDecision checkAddress(String address) {
        if (addressLimit == 0 || address == null) {
            return ThrottleDecision.ALLOW;
        }
        return check(addressKey(address), addressLimit);
    }

    @Override
    public void recordAddress(String address) {
        if (addressLimit == 0 || address == null) {
            return;
        }
        String id = addressKey(address);
        // Its own caller: an address window is never grouped with the per-form windows, whatever by says.
        record(id, id);
    }

    private ThrottleDecision check(String id, int allowed) {
        Window current = windows.get(id);
        long now = now();
        if (current == null || expired(current, now) || current.count() < allowed) {
            return ThrottleDecision.ALLOW;
        }
        return new ThrottleDecision.Deny(Duration.ofNanos(Math.max(0, current.start() + window.toNanos() - now)));
    }

    private void record(String id, String caller) {
        long now = now();
        if (windows.size() >= maxKeys && !windows.containsKey(id)) {
            makeRoom(now);
        }
        windows.merge(id, new Window(now, 1, caller, opened.incrementAndGet()),
            (old, fresh) -> expired(old, now) ? fresh : new Window(old.start(), old.count() + 1, old.caller(), old.sequence()));
    }

    /** An address window's key: the address as {@link CountedAddress} counts it, whoever passed it, after a prefix no kind holds. */
    private static String addressKey(String address) {
        return ADDRESS + CountedAddress.of(address);
    }

    /** How many windows are held now (tests, health). */
    public int size() {
        return windows.size();
    }

    /** The attempts per window. */
    public int limit() {
        return limit;
    }

    /** The requests one address may send per window before their bodies are read; 0 when the throttle keeps no address limit. */
    public int addressLimit() {
        return addressLimit;
    }

    /** The attempts per window for one route kind: its own limit when the host set one, else {@link #limit()}. */
    public int limitOf(ThrottleKey.Kind kind) {
        return kindLimits.getOrDefault(kind, limit);
    }

    /** The window's length. */
    public Duration window() {
        return window;
    }

    private void makeRoom(long now) {
        windows.entrySet().removeIf(entry -> expired(entry.getValue(), now));
        if (windows.size() < maxKeys) {
            return;
        }
        int drop = Math.max(1, maxKeys / 16);
        // The live windows by caller, each caller's cheapest first: the fewest attempts, then the newest (by start, then by
        // the order they opened in). Newest first among equals: a caller that pads windows it sprayed up to the limit loses
        // those, never the older real window it wants reset.
        Map<String, ArrayDeque<Map.Entry<String, Window>>> byCaller = new HashMap<>();
        for (Map.Entry<String, Window> entry : windows.entrySet()) {
            byCaller.computeIfAbsent(entry.getValue().caller(), caller -> new ArrayDeque<>()).add(Map.entry(entry.getKey(), entry.getValue()));
        }
        Comparator<Map.Entry<String, Window>> cheapest = Comparator.<Map.Entry<String, Window>>comparingInt(entry -> entry.getValue().count())
            .thenComparing(Comparator.<Map.Entry<String, Window>>comparingLong(entry -> entry.getValue().start()).reversed())
            .thenComparing(Comparator.<Map.Entry<String, Window>>comparingLong(entry -> entry.getValue().sequence()).reversed());
        // Among callers holding as many, the one whose cheapest window goes first by the same order: the fewest attempts,
        // then the newest (many callers of one window each: the window a flood from fresh addresses just opened makes room,
        // and the counters already running keep counting).
        PriorityQueue<ArrayDeque<Map.Entry<String, Window>>> heaviest = new PriorityQueue<>(
            Comparator.<ArrayDeque<Map.Entry<String, Window>>>comparingInt(ArrayDeque::size).reversed()
                .thenComparing(ArrayDeque::peekFirst, cheapest));
        for (ArrayDeque<Map.Entry<String, Window>> held : byCaller.values()) {
            List<Map.Entry<String, Window>> sorted = new ArrayList<>(held);
            sorted.sort(cheapest);
            heaviest.add(new ArrayDeque<>(sorted));
        }
        // One window at a time from the caller holding the most, so a caller that floods the map pays for the room it takes.
        for (int i = 0; i < drop && !heaviest.isEmpty(); i++) {
            ArrayDeque<Map.Entry<String, Window>> held = heaviest.poll();
            windows.remove(held.pollFirst().getKey());
            if (!held.isEmpty()) {
                heaviest.add(held);
            }
        }
    }

    private boolean expired(Window held, long now) {
        return now - held.start() >= window.toNanos();
    }

    private long now() {
        // The clock's instant as nanoseconds since the epoch: monotonic enough for a window, and a test clock can move it.
        java.time.Instant instant = clock.instant();
        return instant.getEpochSecond() * 1_000_000_000L + instant.getNano();
    }

    /** Who a key counts for: its configured parts but the form, so a caller's windows for every form share one caller. */
    private String callerOf(ThrottleKey key) {
        StringBuilder id = new StringBuilder();
        for (By part : by) {
            switch (part) {
                case IP -> id.append('\u0000').append(address(key));
                case PRINCIPAL -> id.append('\u0000').append(key.principal() == null ? "-" : key.principal());
                case FORM -> {
                }
            }
        }
        return id.toString();
    }

    /** The key's address as it is counted: an IPv6 client by its /64, whoever built the key. */
    private static String address(ThrottleKey key) {
        return key.ip() == null ? "-" : CountedAddress.of(key.ip());
    }

    private String keyOf(ThrottleKey key) {
        StringBuilder id = new StringBuilder(key.kind().name());
        for (By part : by) {
            id.append('\u0000');
            switch (part) {
                case IP -> id.append(address(key));
                case FORM -> id.append(key.formKey() == null ? "-" : key.formKey());
                case PRINCIPAL -> id.append(key.principal() == null ? "-" : key.principal());
            }
        }
        return id.toString();
    }
}
