package com.argusvane.datum.tck.run;

import com.argusvane.datum.tck.HardeningContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.HostTck;

/** {@link HardeningContract} against the host {@link HostTck} was given (or the {@code datum.tck.*} system properties). */
public class HardeningRun implements HardeningContract {

    @Override
    public HostTarget target() {
        return HostTck.target();
    }
}
