package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaClientKeys;
import com.argusvane.datum.timestamp.TsaClientStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * The timestamp clients from configuration ({@code datum.tsa.clients}): each entry the SHA-256 of a client key,
 * lowercase hex, optionally as {@code label=hash}. Only hashes are configured, never keys, so a leaked
 * {@code application.yml} lets nobody ask for tokens. A client's id is the first 12 characters of its hash (what
 * the log records); with no label its label is {@code client <id>}.
 *
 * <p>A malformed entry stops the start (a typo must not silently lock a client out or, worse, in).
 */
public final class PropertiesTsaClientStore implements TsaClientStore {

    private static final Pattern HASH = Pattern.compile("[0-9a-fA-F]{64}");

    private record Entry(TsaClient client, String hash) {
    }

    private final List<Entry> entries = new ArrayList<>();

    /**
     * @param configured the {@code datum.tsa.clients} entries
     * @throws IllegalArgumentException when an entry is not a SHA-256 hash
     */
    public PropertiesTsaClientStore(List<String> configured) {
        for (String raw : configured == null ? List.<String>of() : configured) {
            if (raw == null || raw.isBlank()) {
                continue;
            }
            String text = raw.strip();
            int equals = text.indexOf('=');
            String label = equals > 0 ? text.substring(0, equals).strip() : null;
            String hash = (equals > 0 ? text.substring(equals + 1) : text).strip().toLowerCase(Locale.ROOT);
            if (!HASH.matcher(hash).matches()) {
                throw new DatumConfigurationException("datum.tsa.clients", "datum.tsa.clients holds an entry that is not the SHA-256 (64 hex digits) of a client key.");
            }
            String id = hash.substring(0, 12);
            entries.add(new Entry(new TsaClient(id, label == null || label.isEmpty() ? "client " + id : label), hash));
        }
    }

    /** How many clients are configured. */
    public int size() {
        return entries.size();
    }

    @Override
    public Optional<TsaClient> authenticate(String key) {
        if (key == null || key.isEmpty()) {
            return Optional.empty();
        }
        // Every entry is compared, in constant time each, so the answer's timing does not say which one was close.
        TsaClient found = null;
        for (Entry entry : entries) {
            if (TsaClientKeys.matches(key, entry.hash())) {
                found = entry.client();
            }
        }
        return Optional.ofNullable(found);
    }
}
