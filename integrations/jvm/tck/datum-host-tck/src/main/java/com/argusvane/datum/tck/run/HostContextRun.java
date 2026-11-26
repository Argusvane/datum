package com.argusvane.datum.tck.run;

import com.argusvane.datum.tck.HostContextContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.HostTck;

/** {@link HostContextContract} against the host {@link HostTck} was given (or the {@code datum.tck.*} system properties). */
public class HostContextRun implements HostContextContract {

    @Override
    public HostTarget target() {
        return HostTck.target();
    }
}
