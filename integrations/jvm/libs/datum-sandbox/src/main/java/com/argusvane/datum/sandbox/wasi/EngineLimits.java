package com.argusvane.datum.sandbox.wasi;

/**
 * The memory budgets an engine's runs may be given, handed to {@link GuestRuntimeProvider#create} so an engine refuses at
 * creation limits it cannot honour (a budget below the module's own initial memory: {@link MemoryFloorException}) rather
 * than on the first run. The layer above derives them from its own settings (the Datum lifecycle: the smaller and the
 * larger of the validation and PDF memory budgets); each run's own {@link Budget} still carries its limit.
 *
 * @param minMemoryBytes the smallest memory budget any run will be given
 * @param maxMemoryBytes the largest memory budget any run will be given
 */
public record EngineLimits(long minMemoryBytes, long maxMemoryBytes) {

    public EngineLimits {
        if (minMemoryBytes <= 0) {
            throw new IllegalArgumentException("The least memory budget is above zero: " + minMemoryBytes);
        }
        if (maxMemoryBytes < minMemoryBytes) {
            throw new IllegalArgumentException("The largest memory budget (" + maxMemoryBytes + ") is not below the least ("
                + minMemoryBytes + ").");
        }
    }
}
