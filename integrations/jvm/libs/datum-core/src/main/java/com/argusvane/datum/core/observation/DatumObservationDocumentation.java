package com.argusvane.datum.core.observation;

import io.micrometer.common.docs.KeyName;
import io.micrometer.observation.docs.ObservationDocumentation;

/**
 * Datum's observations as Micrometer documents them: the names and keys of {@link DatumObservationNames},
 * for a host's documentation tooling and for the tests that hold the names apart from Datum's meters.
 */
public enum DatumObservationDocumentation implements ObservationDocumentation {

    /** {@link DatumObservationNames#SANDBOX_RUN}. */
    SANDBOX_RUN(DatumObservationNames.SANDBOX_RUN, "datum sandbox", Keys.OP, Keys.OUTCOME, Keys.ENGINE_MODE),

    /** {@link DatumObservationNames#PDF_RUN}. */
    PDF_RUN(DatumObservationNames.PDF_RUN, "datum pdf program", Keys.OP, Keys.OUTCOME, Keys.ENGINE_MODE),

    /** {@link DatumObservationNames#PDF}. */
    PDF(DatumObservationNames.PDF, "datum pdf", Keys.OP, Keys.OUTCOME, Keys.SEAL, Keys.TIMESTAMP),

    /** {@link DatumObservationNames#SUBMISSION}. */
    SUBMISSION(DatumObservationNames.SUBMISSION, "datum submission", Keys.MODE, Keys.CHANNEL, Keys.OUTCOME, Keys.STAGE),

    /** {@link DatumObservationNames#TSA_ISSUE}. */
    TSA_ISSUE(DatumObservationNames.TSA_ISSUE, "datum tsa issue", Keys.CHANNEL, Keys.OUTCOME);

    private final String name;
    private final String contextualName;
    private final KeyName[] low;

    DatumObservationDocumentation(String name, String contextualName, KeyName... low) {
        this.name = name;
        this.contextualName = contextualName;
        this.low = low;
    }

    @Override
    public String getName() {
        return name;
    }

    @Override
    public String getContextualName() {
        return contextualName;
    }

    @Override
    public KeyName[] getLowCardinalityKeyNames() {
        return low.clone();
    }

    @Override
    public KeyName[] getHighCardinalityKeyNames() {
        return this == PDF || this == SUBMISSION ? new KeyName[] {Keys.FORM} : new KeyName[0];
    }

    /** The keys, as {@link DatumObservationNames} spells them. */
    public enum Keys implements KeyName {
        OP(DatumObservationNames.OP),
        OUTCOME(DatumObservationNames.OUTCOME),
        ENGINE_MODE(DatumObservationNames.ENGINE_MODE),
        MODE(DatumObservationNames.MODE),
        CHANNEL(DatumObservationNames.CHANNEL),
        STAGE(DatumObservationNames.STAGE),
        SEAL(DatumObservationNames.SEAL),
        TIMESTAMP(DatumObservationNames.TIMESTAMP),
        FORM(DatumObservationNames.FORM);

        private final String key;

        Keys(String key) {
            this.key = key;
        }

        @Override
        public String asString() {
            return key;
        }
    }
}
