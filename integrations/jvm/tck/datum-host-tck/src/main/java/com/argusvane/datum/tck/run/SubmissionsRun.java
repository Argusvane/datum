package com.argusvane.datum.tck.run;

import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.HostTck;
import com.argusvane.datum.tck.SubmissionsContract;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.TestMethodOrder;

/** {@link SubmissionsContract} against the host {@link HostTck} was given (or the {@code datum.tck.*} system properties). */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
public class SubmissionsRun implements SubmissionsContract {

    @Override
    public HostTarget target() {
        return HostTck.target();
    }
}
