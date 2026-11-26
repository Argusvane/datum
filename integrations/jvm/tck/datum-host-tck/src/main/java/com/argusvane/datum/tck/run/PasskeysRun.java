package com.argusvane.datum.tck.run;

import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.HostTck;
import com.argusvane.datum.tck.PasskeysContract;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.TestMethodOrder;

/** {@link PasskeysContract} against the host {@link HostTck} was given (or the {@code datum.tck.*} system properties). */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
public class PasskeysRun implements PasskeysContract {

    @Override
    public HostTarget target() {
        return HostTck.target();
    }
}
