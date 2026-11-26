package com.argusvane.datum.sandbox.diagnostics;

import com.argusvane.datum.core.DatumConfigurationException;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystems;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The default {@link RunCaptureSink}: one directory per capture under a directory the JVM's user alone can read. A capture holds the submitted answers and the form definition in clear text, so the directory is checked before
 * the first byte is written, and every name written under it comes from the capture id alone.
 *
 * <p>At {@link #open()}, in this order, each failure a {@link DatumConfigurationException} naming
 * {@value #PROPERTY} that stops the start:
 * <ol>
 *   <li>the file system must have POSIX permissions (there is no Windows ACL story in this version);</li>
 *   <li>a missing directory is created, mode 0700 as it is made ({@code createDirectories} with the attribute, never a
 *       {@code chmod} after);</li>
 *   <li>it must not be a symbolic link (read without following links), and must be a directory;</li>
 *   <li>it must have no group or other permission bit at all;</li>
 *   <li>on macOS, it must have no access control list ({@link #aclVerdict}): the JDK reads no ACL there, and an ACL entry (one
 *       inherited from the parent included, which every capture file then inherits too) gives others access whatever the mode
 *       says, so {@code /bin/ls -lde} is asked, and a check that cannot run or whose answer does not parse refuses (fail
 *       closed);</li>
 *   <li>the JVM's user must be able to create a file in it (a probe, 0600, removed at once), and the directory's owner must be
 *       the owner of that probe: the effective user, not whatever {@code user.name} claims.</li>
 * </ol>
 *
 * <p>A write: the directory is checked again (the same one, by its file key, still not a link, the same owner, still no group or
 * other bit, on macOS still no ACL), so one swapped or opened up after the start is refused rather than written into. The capture goes into
 * {@code .partial-<id>} (0700), each file under {@code <name>.tmp} (0600, {@code CREATE_NEW} and {@code NOFOLLOW_LINKS}),
 * forced and moved to its name; then the whole directory is renamed to {@code <id>} in one atomic move. So a directory with a
 * capture's name is always complete, and a failed write leaves nothing behind it (the partial directory is removed).
 *
 * <p>{@link #remove} takes only a real directory whose name is a capture id: it first renames {@code <id>} to
 * {@code .evict-<id>} in one atomic move, so a capture is either whole under its name or out of the names altogether, then
 * deletes that, following no link inside it. A rename that fails leaves the capture whole and still counted; a delete that
 * fails leaves an {@code .evict-<id>}. Whatever else is in the folder is never touched, and neither a {@code .partial-<id>}
 * (a JVM that died mid-write) nor an {@code .evict-<id>} is ever removed automatically: {@link #incomplete()} counts both for
 * the startup WARN.
 */
public final class DirectoryCaptureSink implements RunCaptureSink {

    /** The property that names the directory, which every refusal names. */
    public static final String PROPERTY = "datum.runtime.diagnostics.capture.directory";

    /** The prefix of a capture still being written. */
    static final String PARTIAL = ".partial-";

    /** The prefix of a capture taken out of the names by {@link #remove} and not yet deleted. */
    static final String EVICT = ".evict-";

    /** The one program the macOS ACL check runs: absolute, so no {@code PATH} chooses it. */
    static final String LS = "/bin/ls";

    /** The longest the ACL check waits for {@value #LS}. */
    static final long ACL_TIMEOUT_SECONDS = 5;

    /** The most of {@value #LS}'s output the ACL check reads; a listing longer than this does not parse (refused). */
    static final int ACL_OUTPUT_LIMIT = 64 * 1024;

    /** The mode column of a directory's {@code ls -l} line: a {@code d}, nine permission characters, then {@code @} or {@code +}. */
    private static final Pattern MODE_COLUMN = Pattern.compile("d[-rwxsStT]{9}([@+])?");

    /** An ACL entry as {@code ls -e} prints it under the file's line: {@code  0: group:everyone allow list,...}. */
    private static final Pattern ACE_LINE = Pattern.compile("\\s*[0-9]+: .*");

    private static final Set<PosixFilePermission> DIRECTORY_MODE = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_MODE = PosixFilePermissions.fromString("rw-------");
    private static final Set<PosixFilePermission> NOT_OWNER = EnumSet.of(PosixFilePermission.GROUP_READ, PosixFilePermission.GROUP_WRITE,
        PosixFilePermission.GROUP_EXECUTE, PosixFilePermission.OTHERS_READ, PosixFilePermission.OTHERS_WRITE, PosixFilePermission.OTHERS_EXECUTE);
    private static final Set<OpenOption> CREATE = Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Path directory;
    /** The macOS ACL check, or null where there is none to make (not macOS, or not the default file system). */
    private final @Nullable AclListing acl;
    private volatile @Nullable UserPrincipal owner;
    private volatile @Nullable Object fileKey;
    private volatile int incomplete;

    /** @param directory where the captures go; a relative path is resolved against the working directory now */
    public DirectoryCaptureSink(Path directory) {
        this(directory, defaultAcl(Objects.requireNonNull(directory, "directory")));
    }

    /** The sink with the ACL check's listing given (the tests feed it what {@code ls -lde} would print), or none (null). */
    DirectoryCaptureSink(Path directory, @Nullable AclListing acl) {
        this.directory = Objects.requireNonNull(directory, "directory").toAbsolutePath();
        this.acl = acl;
    }

    /**
     * The ACL check's seam: what {@code ls -lde -- <directory>} prints, or an IOException when it cannot be had. The JDK has
     * no ACL view on macOS, so the listing is the only reader of it there.
     */
    @FunctionalInterface
    interface AclListing {
        String list(Path directory) throws IOException;
    }

    /** What an ACL listing says about a directory. */
    enum AclVerdict {
        /** No ACL: the mode column has no {@code +} and no entry is listed. */
        NONE,
        /** An ACL: a {@code +} after the mode, or an entry line. */
        ACL,
        /** Not a listing of one directory this check can read: refused, as an ACL is. */
        UNREADABLE
    }

    /** The real check on macOS for a path of the default file system; none elsewhere. */
    private static @Nullable AclListing defaultAcl(Path directory) {
        boolean mac = System.getProperty("os.name", "").startsWith("Mac");
        return mac && directory.getFileSystem() == FileSystems.getDefault() ? DirectoryCaptureSink::listAcl : null;
    }

    /** The directory, absolute. */
    public Path directory() {
        return directory;
    }

    /**
     * Leftovers found at {@link #open()}: captures half-written ({@code .partial-<id>}, a JVM that died mid-write) or half-removed
     * ({@code .evict-<id>}, a delete that failed). Neither is removed automatically.
     */
    public int incomplete() {
        return incomplete;
    }

    @Override
    public String describe() {
        return "the directory " + directory;
    }

    /** The property that switches the capture, which the refusals name as the way out. */
    private static final String ENABLED = "datum.runtime.diagnostics.capture.enabled";

    // ---------------------------------------------------------------------------------------------- open: the checks

    @Override
    public List<Stored> open() throws IOException {
        harden();
        List<Stored> found = new ArrayList<>();
        int partial = 0;
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory)) {
            for (Path entry : entries) {
                String name = entry.getFileName().toString();
                if (RunCapture.ID.matcher(name).matches()) {
                    BasicFileAttributes attributes = Files.readAttributes(entry, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    if (attributes.isDirectory() && !attributes.isSymbolicLink()) {
                        found.add(new Stored(name, sizeOf(entry)));
                    }
                } else if (name.startsWith(PARTIAL) && RunCapture.ID.matcher(name.substring(PARTIAL.length())).matches()
                    || name.startsWith(EVICT) && RunCapture.ID.matcher(name.substring(EVICT.length())).matches()) {
                    partial++;
                }
            }
        }
        incomplete = partial;
        return found;
    }

    /** The start-up checks, in the class comment's order. */
    private void harden() {
        if (!directory.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") is on a file system without POSIX permissions, "
                + "so its captures could not be kept readable by the JVM's user alone.",
                "Name a directory on a file system with POSIX permissions (Linux, macOS), or set datum.runtime.diagnostics.capture.enabled=false. "
                    + "There is no Windows ACL support in this version; a host there may supply a RunCaptureSink of its own.");
        }
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            try {
                Files.createDirectories(directory, PosixFilePermissions.asFileAttribute(DIRECTORY_MODE));
            } catch (FileAlreadyExistsException e) {
                // Made at the same moment, or a link or a file in its place: the checks below say which.
            } catch (IOException | UnsupportedOperationException e) {
                throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") does not exist and cannot be created ("
                    + e.getClass().getSimpleName() + ").", "Create it, owned by the JVM's user with mode 700, or name another directory.", e);
            }
        }
        PosixFileAttributes attributes;
        try {
            attributes = Files.readAttributes(directory, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (IOException e) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") cannot be read (" + e.getClass().getSimpleName() + ").",
                "Name a directory the JVM's user owns, with mode 700.", e);
        }
        if (attributes.isSymbolicLink()) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") is a symbolic link; captures are written only into "
                + "a real directory, so that no link can send them elsewhere.", "Name the directory itself (owned by the JVM's user, mode 700), not a link to it.");
        }
        if (!attributes.isDirectory()) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") is not a directory.",
                "Name a directory (owned by the JVM's user, mode 700), or remove what is in its place so it can be created.");
        }
        Set<PosixFilePermission> loose = EnumSet.noneOf(PosixFilePermission.class);
        loose.addAll(attributes.permissions());
        loose.retainAll(NOT_OWNER);
        if (!loose.isEmpty()) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") has permissions "
                + PosixFilePermissions.toString(attributes.permissions()) + ": its group or others can use it, and captured runs hold the "
                + "submitted answers and the form definition (personal data) in clear text.",
                "Make it the JVM user's alone (chmod 700 " + directory + "), or name another directory.");
        }
        // Before the probe file is made: an inheritable ACL would be inherited by it too.
        refuseAcl();
        UserPrincipal me = probe();
        if (!me.equals(attributes.owner())) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") is owned by " + attributes.owner().getName()
                + ", not by the JVM's user (" + me.getName() + ").", "Name a directory the JVM's user owns, with mode 700.");
        }
        this.owner = attributes.owner();
        this.fileKey = attributes.fileKey();
    }

    /** The start's ACL check: an ACL, or a listing that cannot be had or read, refuses the start. */
    private void refuseAcl() {
        AclListing listing = acl;
        if (listing == null) {
            return;
        }
        String text;
        try {
            text = listing.list(directory);
        } catch (IOException | RuntimeException e) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") could not be checked for an access control list ("
                + LS + " -lde failed: " + e.getClass().getSimpleName() + "), so it is not known to be readable by the JVM's user alone.",
                "Make sure " + LS + " runs for the JVM's user, or name another directory, or set " + ENABLED + "=false.", e);
        }
        switch (aclVerdict(text)) {
            case NONE -> {
            }
            case ACL -> throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") has an access control list (ls -lde "
                + "lists one): an ACL entry lets other users read what is written there whatever its mode 700 says, and every capture "
                + "file would inherit it, while captured runs hold the submitted answers and the form definition (personal data) in "
                + "clear text.", "Remove it (chmod -N " + directory + "), and remove the inheritable ACL of its parent too (ls -lde "
                + directory.getParent() + "; chmod -N on it), since a directory made under a parent with one inherits it; or name "
                + "another directory.");
            case UNREADABLE -> throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") could not be checked for an "
                + "access control list (" + LS + " -lde printed nothing this check reads), so it is not known to be readable by the JVM's "
                + "user alone.", "Name a directory whose path holds no line break, or set " + ENABLED + "=false.");
        }
    }

    /**
     * What {@code ls -lde -- <directory>} printed says: {@link AclVerdict#NONE} for exactly one line whose first column is a
     * directory's mode with no {@code +} after it; {@link AclVerdict#ACL} when that column ends in {@code +} or any entry line
     * ({@code N: ...}) follows (macOS prints {@code @} rather than {@code +} when there are extended attributes too, so the entry
     * lines are what is relied on); {@link AclVerdict#UNREADABLE} for anything else (no line, not a directory, a line that is
     * neither).
     */
    static AclVerdict aclVerdict(String listing) {
        List<String> lines = listing.lines().filter(line -> !line.isBlank()).toList();
        if (lines.isEmpty()) {
            return AclVerdict.UNREADABLE;
        }
        String first = lines.get(0);
        int space = first.indexOf(' ');
        String mode = space < 0 ? first : first.substring(0, space);
        java.util.regex.Matcher matched = MODE_COLUMN.matcher(mode);
        if (!matched.matches()) {
            return AclVerdict.UNREADABLE;
        }
        boolean acl = "+".equals(matched.group(1));
        for (String line : lines.subList(1, lines.size())) {
            if (!ACE_LINE.matcher(line).matches()) {
                return AclVerdict.UNREADABLE;
            }
            acl = true;
        }
        return acl ? AclVerdict.ACL : AclVerdict.NONE;
    }

    /**
     * Runs {@code /bin/ls -lde -- <directory>}: the absolute binary, no shell, the path one argument after {@code --}, an empty
     * environment but {@code LC_ALL=C}, no stdin, stderr discarded, at most {@value #ACL_OUTPUT_LIMIT} bytes of stdout read, and
     * {@value #ACL_TIMEOUT_SECONDS} s to finish. A non-zero exit, a timeout or an output past the limit is an IOException.
     */
    static String listAcl(Path directory) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(LS, "-lde", "--", directory.toString());
        builder.environment().clear();
        builder.environment().put("LC_ALL", "C");
        builder.redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process process = builder.start();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean[] overflow = new boolean[1];
        Thread reader = new Thread(() -> {
            byte[] chunk = new byte[4096];
            try (InputStream in = process.getInputStream()) {
                for (int n = in.read(chunk); n >= 0; n = in.read(chunk)) {
                    synchronized (out) {
                        if (out.size() + n > ACL_OUTPUT_LIMIT) {
                            overflow[0] = true;
                            return;
                        }
                        out.write(chunk, 0, n);
                    }
                }
            } catch (IOException e) {
                // The process was destroyed, or its pipe closed: the exit code below says what came of it.
            }
        }, "datum-sandbox-acl-check");
        reader.setDaemon(true);
        reader.start();
        try {
            if (!process.waitFor(ACL_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new IOException(LS + " did not finish within " + ACL_TIMEOUT_SECONDS + " s.");
            }
            reader.join(TimeUnit.SECONDS.toMillis(ACL_TIMEOUT_SECONDS));
            synchronized (out) {
                if (overflow[0] || reader.isAlive()) {
                    throw new IOException(LS + " printed more than " + ACL_OUTPUT_LIMIT + " bytes, or did not close its output.");
                }
                if (process.exitValue() != 0) {
                    throw new IOException(LS + " exited " + process.exitValue() + ".");
                }
                return out.toString(StandardCharsets.UTF_8);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new java.io.InterruptedIOException("The ACL check was interrupted.");
        } finally {
            process.destroyForcibly();
        }
    }

    /** Creates and removes a probe file: proves the directory is writable here and answers who the JVM's user is. */
    private UserPrincipal probe() {
        Path probe = directory.resolve(".probe-" + HexFormat.of().formatHex(randomBytes()));
        try {
            try (FileChannel ignored = FileChannel.open(probe, CREATE, PosixFilePermissions.asFileAttribute(FILE_MODE))) {
                // Created, empty: enough to prove the write and read the owner.
            }
        } catch (IOException e) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") is not writable by the JVM's user ("
                + e.getClass().getSimpleName() + ").", "Give the JVM's user write access to it (it should own it, mode 700), or name another directory.", e);
        }
        try {
            return Files.getOwner(probe, LinkOption.NOFOLLOW_LINKS);
        } catch (IOException e) {
            throw new DatumConfigurationException(PROPERTY, PROPERTY + " (" + directory + ") holds files whose owner cannot be read ("
                + e.getClass().getSimpleName() + ").", "Name a directory the JVM's user owns, with mode 700.", e);
        } finally {
            try {
                Files.deleteIfExists(probe);
            } catch (IOException e) {
                // Left behind: a zero-byte file of a name no capture has; the start goes on.
            }
        }
    }

    private static byte[] randomBytes() {
        byte[] bytes = new byte[8];
        RANDOM.nextBytes(bytes);
        return bytes;
    }

    /** The directory is still the one {@link #open()} checked; otherwise the write is refused (an IOException, counted). */
    private void recheck() throws IOException {
        UserPrincipal checkedOwner = owner;
        if (checkedOwner == null) {
            throw new IOException("The capture sink was not opened.");
        }
        PosixFileAttributes now = Files.readAttributes(directory, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        Set<PosixFilePermission> loose = EnumSet.noneOf(PosixFilePermission.class);
        loose.addAll(now.permissions());
        loose.retainAll(NOT_OWNER);
        if (now.isSymbolicLink() || !now.isDirectory() || !Objects.equals(now.fileKey(), fileKey) || !checkedOwner.equals(now.owner())
            || !loose.isEmpty()) {
            throw new IOException("The capture directory is no longer the one checked at start (a link, another directory, "
                + "another owner or wider permissions).");
        }
        AclListing listing = acl;
        if (listing != null && aclVerdict(listing.list(directory)) != AclVerdict.NONE) {
            // Fail closed: an ACL added since the start, or a listing that no longer reads, refuses the write (counted).
            throw new IOException("The capture directory has an access control list now, or it could not be checked for one.");
        }
    }

    // ---------------------------------------------------------------------------------------------- write, remove

    @Override
    public long write(RunCapture capture) throws IOException {
        Objects.requireNonNull(capture, "capture");
        recheck();
        // The record has checked the id: a timestamp and twelve hex digits, nothing a path could be built from.
        String id = capture.id();
        Path partial = directory.resolve(PARTIAL + id);
        Path target = directory.resolve(id);
        FileAttribute<Set<PosixFilePermission>> directoryMode = PosixFilePermissions.asFileAttribute(DIRECTORY_MODE);
        FileAttribute<Set<PosixFilePermission>> fileMode = PosixFilePermissions.asFileAttribute(FILE_MODE);
        Files.createDirectory(partial, directoryMode);
        boolean done = false;
        try {
            long stored = 0;
            for (Map.Entry<String, ByteBuffer> file : capture.files().entrySet()) {
                Path temporary = partial.resolve(file.getKey() + ".tmp");
                try (FileChannel channel = FileChannel.open(temporary, CREATE, fileMode)) {
                    ByteBuffer content = file.getValue();
                    while (content.hasRemaining()) {
                        stored += channel.write(content);
                    }
                    channel.force(false);
                }
                Files.move(temporary, partial.resolve(file.getKey()), StandardCopyOption.ATOMIC_MOVE);
            }
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                // A rename over an empty directory would replace it: never write over anything already there.
                throw new FileAlreadyExistsException(id);
            }
            Files.move(partial, target, StandardCopyOption.ATOMIC_MOVE);
            done = true;
            return stored;
        } finally {
            if (!done) {
                deleteTree(partial);
            }
        }
    }

    @Override
    public void remove(String id) throws IOException {
        if (!RunCapture.ID.matcher(Objects.requireNonNull(id, "id")).matches()) {
            throw new IllegalArgumentException("Not a capture id: \"" + id + "\".");
        }
        Path target = directory.resolve(id);
        BasicFileAttributes attributes;
        try {
            attributes = Files.readAttributes(target, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            return;
        }
        if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
            // Only a real capture directory is ever removed.
            return;
        }
        // Out of the names first, in one atomic move: a capture is whole under its name or gone from the names, never half
        // deleted under it. A rename onto an existing directory could replace it, so an existing .evict-<id> fails the removal.
        Path evicted = directory.resolve(EVICT + id);
        if (Files.exists(evicted, LinkOption.NOFOLLOW_LINKS)) {
            throw new FileAlreadyExistsException(EVICT + id);
        }
        Files.move(target, evicted, StandardCopyOption.ATOMIC_MOVE, LinkOption.NOFOLLOW_LINKS);
        try {
            deleteTree(evicted);
        } catch (IOException e) {
            throw new PartlyRemovedException("Capture " + id + " was taken out of the names but not all of it was deleted ("
                + EVICT + id + " is left).", e);
        }
    }

    /** Deletes a directory and what it holds without following a link (a link is removed, never what it points at). */
    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, @Nullable IOException failure) throws IOException {
                if (failure != null) {
                    throw failure;
                }
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /** The bytes of the regular files directly in a capture directory, read without following links. */
    private static long sizeOf(Path capture) throws IOException {
        long total = 0;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(capture)) {
            for (Path file : files) {
                BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (attributes.isRegularFile()) {
                    total += attributes.size();
                }
            }
        }
        return total;
    }
}
