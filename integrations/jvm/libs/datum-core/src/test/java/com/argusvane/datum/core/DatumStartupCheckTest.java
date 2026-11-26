package com.argusvane.datum.core;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck.Level;
import com.argusvane.datum.core.DatumStartupCheck.Notice;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The start-up checks run once, in order, and a failing one never stops the others (integrations/jvm/README.md "Libraries and bindings"). */
class DatumStartupCheckTest {

    @Test
    void everyNoticeIsWrittenInOrderAndABrokenCheckIsSkipped() {
        DatumStartupCheck first = () -> List.of(Notice.warn(DatumStartupCheckTest.class, "one"));
        DatumStartupCheck broken = () -> {
            throw new IllegalStateException("bug");
        };
        DatumStartupCheck quiet = List::of;
        DatumStartupCheck last = () -> List.of(Notice.info(String.class, "two"), Notice.warn(Integer.class, "three"));
        List<Notice> written = DatumStartupCheck.runAll(List.of(first, broken, quiet, last));
        assertThat(written).extracting(Notice::message).containsExactly("one", "two", "three");
        assertThat(written).extracting(Notice::level).containsExactly(Level.WARN, Level.INFO, Level.WARN);
        assertThat(written.get(1).logger()).isEqualTo("java.lang.String");
    }

    @Test
    void aCheckAnsweringNullIsQuiet() {
        assertThat(DatumStartupCheck.runAll(List.of(() -> null))).isEmpty();
    }
}
