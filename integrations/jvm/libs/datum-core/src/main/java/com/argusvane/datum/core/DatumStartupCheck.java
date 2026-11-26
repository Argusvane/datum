package com.argusvane.datum.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One thing an operator should hear about once at start: a default that stores nothing, a builder any visitor may
 * write with, serial numbers that are unique only within this process, sandbox slots the container cannot hold
 * (integrations/jvm/README.md "Libraries and bindings"). Each capability library writes its checks; every host
 * binding collects them and calls {@link #runAll} once when its beans exist (Spring: after the singletons, before the
 * web server takes requests; a Quarkus binding would run it at start-up), so the words and the conditions are written once.
 *
 * <p>A check only looks: it changes nothing and refuses nothing. Refusing to start is the capability's own business
 * (a multi-process store that must be acknowledged, a key that does not match), where it fails the bean.
 */
@FunctionalInterface
public interface DatumStartupCheck {

    /** What to tell the operator now; empty when all is well. */
    List<Notice> check();

    /** How loud a notice is. */
    enum Level { INFO, WARN }

    /**
     * One line of the start-up log.
     *
     * @param level   INFO for a fact worth knowing, WARN for something to fix before production
     * @param logger  the logger category it is written under (a category such as {@code datum.ui}, or the library class
     *                it concerns)
     * @param message the text, whole
     */
    record Notice(Level level, String logger, String message) {

        public Notice {
            Objects.requireNonNull(level, "level");
            Objects.requireNonNull(logger, "logger");
            Objects.requireNonNull(message, "message");
        }

        public static Notice warn(Class<?> logger, String message) {
            return new Notice(Level.WARN, logger.getName(), message);
        }

        public static Notice info(Class<?> logger, String message) {
            return new Notice(Level.INFO, logger.getName(), message);
        }

        /** A WARN under a category ({@code datum.ui}, {@code datum.tsa}): the one the line had before it was a check. */
        public static Notice warn(String logger, String message) {
            return new Notice(Level.WARN, logger, message);
        }

        public static Notice info(String logger, String message) {
            return new Notice(Level.INFO, logger, message);
        }
    }

    /**
     * Runs every check once, in the order given, and writes each notice under its logger. A check that throws is
     * itself one WARN and the others still run: a start-up notice never stops the start.
     *
     * @return the notices written
     */
    static List<Notice> runAll(Iterable<? extends DatumStartupCheck> checks) {
        List<Notice> written = new ArrayList<>();
        for (DatumStartupCheck check : checks) {
            List<Notice> notices;
            try {
                notices = check.check();
            } catch (RuntimeException e) {
                LoggerFactory.getLogger(DatumStartupCheck.class).warn("Datum: the start-up check {} failed; it was skipped.",
                    check.getClass().getName(), e);
                continue;
            }
            for (Notice notice : notices == null ? List.<Notice>of() : notices) {
                Logger logger = LoggerFactory.getLogger(notice.logger());
                if (notice.level() == Level.WARN) {
                    logger.warn(notice.message());
                } else {
                    logger.info(notice.message());
                }
                written.add(notice);
            }
        }
        return written;
    }
}
