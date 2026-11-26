package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code datum.submissions.*}: settings of the submissions binding that are not the runtime's ({@code datum.runtime.*}) or the host
 * options' ({@code datum.host.*}). Binding-level: they shape the development defaults this binding supplies, so an
 * application that supplies its own store ignores them.
 */
@ConfigurationProperties(prefix = "datum.submissions")
public class DatumSubmissionsProperties {

    /** The largest {@code datum.submissions.idempotency.memory-size}: ten million receipts. */
    static final int MAX_MEMORY_SIZE = 10_000_000;

    private final Idempotency idempotency = new Idempotency();

    public Idempotency getIdempotency() {
        return idempotency;
    }

    /** {@code datum.submissions.idempotency.*}: the store that answers a repeated delivery with its first receipt. */
    public static class Idempotency {

        /**
         * How many accepted documents the in-memory store (used when the application has no DataSource and no store bean) remembers;
         * past it the oldest is forgotten. From 16 to 10000000.
         */
        private int memorySize = InMemorySubmissionIdempotencyStore.DEFAULT_MAX_ENTRIES;

        public int getMemorySize() {
            return memorySize;
        }

        public void setMemorySize(int memorySize) {
            this.memorySize = memorySize;
        }

        /** @throws IllegalArgumentException naming the property when it is outside its bounds */
        int checkedMemorySize() {
            if (memorySize < 16 || memorySize > MAX_MEMORY_SIZE) {
                throw new DatumConfigurationException("datum.submissions.idempotency.memory-size", "datum.submissions.idempotency.memory-size is " + memorySize + "; it must be from 16 to "
                    + MAX_MEMORY_SIZE + ".");
            }
            return memorySize;
        }
    }
}
