package com.argusvane.datum.sandbox.diagnostics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import com.argusvane.datum.core.DatumConfigurationException;
import com.google.common.jimfs.Configuration;
import com.google.common.jimfs.Jimfs;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

/**
 * The file sink's hardening, on real temporary directories: what it refuses to start on, the modes it
 * creates with, that a capture is visible only whole, that names come from the capture id alone, and that removing a capture
 * touches nothing else. On macOS every test here goes through the real ACL check ({@code /bin/ls -lde}), and two make an ACL
 * with {@code chmod +a} and are refused.
 *
 * <p>The owner refusal is tested on Jimfs with a POSIX view: the checks read attributes through the path's own file system,
 * so a directory whose owner is set to another principal there stands for one another user owns, which a real directory can
 * only be with root.
 */
class DirectoryCaptureSinkTest {

    @TempDir
    Path temp;

    private static String mode(Path path) throws IOException {
        return PosixFilePermissions.toString(Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS));
    }

    private static Set<String> names(Path directory) throws IOException {
        try (Stream<Path> entries = Files.list(directory)) {
            return entries.map(path -> path.getFileName().toString()).collect(Collectors.toSet());
        }
    }

    private Path ownerOnly(String name) throws IOException {
        Path directory = temp.resolve(name);
        Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        return directory;
    }

    // ---------------------------------------------------------------------------------------------- modes

    @Test
    void aMissingDirectoryIsCreated0700AndEveryCaptureIs0700With0600Files() throws IOException {
        Path directory = temp.resolve("made").resolve("captures");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        assertThat(sink.open()).isEmpty();
        assertThat(mode(directory)).isEqualTo("rwx------");
        assertThat(mode(directory.getParent())).as("a parent made for it is the user's alone too").isEqualTo("rwx------");

        String id = Captures.id(1);
        long stored = sink.write(Captures.of(id, 1000));
        Path capture = directory.resolve(id);
        assertThat(mode(capture)).isEqualTo("rwx------");
        assertThat(names(capture)).containsExactlyInAnyOrderElementsOf(RunCapture.FILES);
        for (String file : RunCapture.FILES) {
            assertThat(mode(capture.resolve(file))).as(file).isEqualTo("rw-------");
        }
        assertThat(Files.size(capture.resolve("stdout.bin"))).isEqualTo(1000);
        assertThat(Files.readString(capture.resolve("stdin.bin"))).isEqualTo("{\"values\":{\"name\":\"Ada\"}}");
        assertThat(Files.readString(capture.resolve("run.js"))).isEqualTo("print(1);\n");
        assertThat(Files.readString(capture.resolve("meta.json"))).contains(id);
        long onDisk = 0;
        for (String file : RunCapture.FILES) {
            onDisk += Files.size(capture.resolve(file));
        }
        assertThat(stored).isEqualTo(onDisk);
        assertThat(names(directory)).as("no probe, partial or temporary file is left").containsExactly(id);
    }

    @Test
    void anOwnerOnlyDirectoryThatExistsIsUsedAndWhatItHoldsIsCounted() throws IOException {
        Path directory = ownerOnly("kept");
        DirectoryCaptureSink first = new DirectoryCaptureSink(directory);
        first.open();
        String a = Captures.id(1);
        String b = Captures.id(2);
        long aBytes = first.write(Captures.of(a, 10));
        long bBytes = first.write(Captures.of(b, 20));
        Files.createDirectory(directory.resolve(DirectoryCaptureSink.PARTIAL + Captures.id(3)));
        Files.writeString(directory.resolve("notes.txt"), "the operator's");

        DirectoryCaptureSink second = new DirectoryCaptureSink(directory);
        assertThat(second.open()).containsExactlyInAnyOrder(new RunCaptureSink.Stored(a, aBytes), new RunCaptureSink.Stored(b, bBytes));
        assertThat(second.incomplete()).isEqualTo(1);
    }

    // ---------------------------------------------------------------------------------------------- refusals

    @Test
    void aGroupReadableDirectoryIsRefused() throws IOException {
        Path directory = ownerOnly("group");
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-x---"));
        assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).isInstanceOfSatisfying(DatumConfigurationException.class, e -> {
            assertThat(e.property()).isEqualTo(DirectoryCaptureSink.PROPERTY);
            assertThat(e.problem()).contains("rwxr-x---").contains("personal").doesNotContain("Exception");
            assertThat(e.action()).contains("chmod 700");
        });
        assertThat(names(directory)).as("nothing was written into it").isEmpty();
    }

    @Test
    void aWorldReadableOrWritableDirectoryIsRefused() throws IOException {
        for (String loose : List.of("rwx---r--", "rwx-----x", "rwx----w-", "rwxrwxrwx")) {
            Path directory = ownerOnly("world-" + loose.replace('-', '_'));
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString(loose));
            assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).as(loose).isInstanceOf(DatumConfigurationException.class)
                .hasMessageContaining(loose);
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
            assertThat(names(directory)).isEmpty();
        }
    }

    @Test
    void aSymlinkedDirectoryIsRefusedEvenWhenItPointsAtAGoodOne() throws IOException {
        Path real = ownerOnly("real");
        Path link = Files.createSymbolicLink(temp.resolve("link"), real);
        assertThatThrownBy(() -> new DirectoryCaptureSink(link).open()).isInstanceOfSatisfying(DatumConfigurationException.class,
            e -> assertThat(e.problem()).contains("symbolic link"));
        Path dangling = Files.createSymbolicLink(temp.resolve("dangling"), temp.resolve("nowhere"));
        assertThatThrownBy(() -> new DirectoryCaptureSink(dangling).open()).isInstanceOf(DatumConfigurationException.class)
            .hasMessageContaining("symbolic link");
        assertThat(Files.exists(temp.resolve("nowhere"))).as("a dangling link is not followed to create its target").isFalse();
        assertThat(names(real)).isEmpty();
    }

    @Test
    void aFileInPlaceOfTheDirectoryIsRefused() throws IOException {
        Path file = Files.writeString(temp.resolve("a-file"), "not a directory");
        assertThatThrownBy(() -> new DirectoryCaptureSink(file).open()).isInstanceOfSatisfying(DatumConfigurationException.class,
            e -> assertThat(e.problem()).contains("is not a directory"));
        assertThat(Files.readString(file)).isEqualTo("not a directory");
    }

    @Test
    void anUnwritableDirectoryIsRefused() throws IOException {
        assumeFalse("root".equals(System.getProperty("user.name")), "root writes through any mode");
        Path directory = ownerOnly("read-only");
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("r-x------"));
        try {
            assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).isInstanceOfSatisfying(DatumConfigurationException.class,
                e -> assertThat(e.problem()).contains("not writable"));
        } finally {
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        }
        assertThat(names(directory)).isEmpty();
    }

    @Test
    void aFileSystemWithoutPosixPermissionsIsRefusedSayingThereIsNoAclSupport() throws IOException {
        try (FileSystem windows = Jimfs.newFileSystem(Configuration.windows())) {
            Path directory = windows.getPath("C:\\captures");
            assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).isInstanceOfSatisfying(DatumConfigurationException.class, e -> {
                assertThat(e.problem()).contains("without POSIX permissions");
                assertThat(e.action()).contains("Windows ACL").contains("RunCaptureSink");
            });
            assertThat(Files.exists(directory)).as("nothing is created before the refusal").isFalse();
        }
    }

    @Test
    void aDirectoryChangedAfterTheStartIsNotWrittenInto() throws IOException {
        Path directory = ownerOnly("changed");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        assertThatThrownBy(() -> sink.write(Captures.of(Captures.id(1), 10))).isInstanceOf(IOException.class);
        assertThat(names(directory)).isEmpty();

        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        Path moved = temp.resolve("changed-original");
        Files.move(directory, moved);
        ownerOnly("changed");
        assertThatThrownBy(() -> sink.write(Captures.of(Captures.id(2), 10))).as("another directory under the same name")
            .isInstanceOf(IOException.class);
        assertThat(names(directory)).isEmpty();
    }

    // ---------------------------------------------------------------------------------------------- names

    @Test
    void namesComeFromTheCaptureIdAloneWhateverTheRunCarried() throws IOException {
        Path directory = ownerOnly("hostile");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        Set<String> around = names(temp);
        String hostile = "../../escape/../../etc/passwd\n/tmp/x\u0000 ~/.ssh";
        RunFacts facts = new RunFacts("sandbox", "../../" + hostile, "ab".repeat(32), "// " + hostile + "\n",
            ByteBuffer.wrap(hostile.getBytes(StandardCharsets.UTF_8)), Captures.trapped(hostile, 5).output(), "trap", true, 1);
        String id = Captures.id(1);
        sink.write(RunCapture.of(id, facts, Map.of("op", facts.op())));

        assertThat(names(directory)).containsExactly(id);
        assertThat(names(directory.resolve(id))).containsExactlyInAnyOrderElementsOf(RunCapture.FILES);
        assertThat(names(temp)).as("nothing was written beside the directory").isEqualTo(around);
        assertThat(Files.readString(directory.resolve(id).resolve("stdin.bin"))).isEqualTo(hostile);

        for (String bad : List.of("../" + id, id + "/x", "x", id + "0", "20261123-100001-ABCDEF012345", "")) {
            assertThatThrownBy(() -> RunCapture.of(bad, facts, Map.of())).as(bad).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> sink.remove(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new RunCapture(id, Map.of("../stdin.bin", ByteBuffer.allocate(1)))).isInstanceOf(IllegalArgumentException.class);
    }

    // ---------------------------------------------------------------------------------------------- atomic visibility

    @Test
    void aCaptureIsVisibleOnlyWholeWhileItIsWritten() throws Exception {
        Path directory = ownerOnly("atomic");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        int stdout = 24 * 1024 * 1024;
        AtomicBoolean writing = new AtomicBoolean(true);
        List<String> seen = Collections.synchronizedList(new ArrayList<>());
        Thread watcher = new Thread(() -> {
            while (writing.get()) {
                try (Stream<Path> entries = Files.list(directory)) {
                    for (Path entry : entries.toList()) {
                        String name = entry.getFileName().toString();
                        if (RunCapture.ID.matcher(name).matches()) {
                            // Visible under its name: then every file is there, at its full size.
                            Set<String> files = names(entry);
                            long out = Files.size(entry.resolve("stdout.bin"));
                            seen.add(files.equals(Set.copyOf(RunCapture.FILES)) && out == stdout ? "whole" : "partial: " + files + " " + out);
                        }
                    }
                } catch (NoSuchFileException e) {
                    // A partial directory renamed between the list and the read: try again.
                } catch (java.io.UncheckedIOException e) {
                    if (!(e.getCause() instanceof NoSuchFileException)) {
                        seen.add("error: " + e.getCause());
                    }
                } catch (IOException e) {
                    seen.add("error: " + e);
                }
            }
        });
        watcher.start();
        try {
            for (int i = 0; i < 3; i++) {
                sink.write(Captures.of(Captures.id(i), stdout));
            }
        } finally {
            writing.set(false);
            watcher.join();
        }
        assertThat(seen).as("the watcher saw captures at all").isNotEmpty();
        assertThat(seen).as("never a half capture under a capture's name").allMatch("whole"::equals);
        assertThat(names(directory)).hasSize(3).allMatch(name -> RunCapture.ID.matcher(name).matches());
    }

    @Test
    void aWriteThatFailsLeavesNothingBehind() throws IOException {
        Path directory = ownerOnly("failing");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        String id = Captures.id(1);
        Files.createDirectory(directory.resolve(id));
        Files.writeString(directory.resolve(id).resolve("theirs.txt"), "kept");
        assertThatThrownBy(() -> sink.write(Captures.of(id, 100))).isInstanceOf(FileAlreadyExistsException.class);
        assertThat(names(directory)).as("the partial directory is gone").containsExactly(id);
        assertThat(names(directory.resolve(id))).as("what was there is not written over").containsExactly("theirs.txt");
    }

    // ---------------------------------------------------------------------------------------------- remove

    @Test
    void removeTakesOnlyARealCaptureDirectoryAndFollowsNoLink() throws IOException {
        Path directory = ownerOnly("remove");
        Path outside = ownerOnly("outside");
        Files.writeString(outside.resolve("precious.txt"), "keep me");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        String id = Captures.id(1);
        sink.write(Captures.of(id, 10));
        // A link planted inside a capture, and a link named like a capture: neither target is touched.
        Files.createSymbolicLink(directory.resolve(id).resolve("link"), outside);
        String linkId = Captures.id(2);
        Files.createSymbolicLink(directory.resolve(linkId), outside);
        Files.writeString(directory.resolve("notes.txt"), "the operator's");

        sink.remove(id);
        sink.remove(linkId);
        sink.remove(Captures.id(3));

        assertThat(names(directory)).containsExactlyInAnyOrder(linkId, "notes.txt");
        assertThat(Files.readString(outside.resolve("precious.txt"))).isEqualTo("keep me");
    }

    // ---------------------------------------------------------------------------------------------- removal

    @Test
    void removeTakesTheCaptureOutOfTheNamesBeforeDeletingIt() throws IOException {
        Path directory = ownerOnly("evict");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        String id = Captures.id(1);
        sink.write(Captures.of(id, 10));
        sink.remove(id);
        assertThat(names(directory)).as("neither the capture nor its .evict- name is left").isEmpty();

        // A rename that cannot be made (an .evict- already there) leaves the capture whole under its name.
        String kept = Captures.id(2);
        sink.write(Captures.of(kept, 10));
        Files.createDirectory(directory.resolve(DirectoryCaptureSink.EVICT + kept));
        assertThatThrownBy(() -> sink.remove(kept)).isInstanceOf(FileAlreadyExistsException.class)
            .isNotInstanceOf(RunCaptureSink.PartlyRemovedException.class);
        assertThat(names(directory.resolve(kept))).containsExactlyInAnyOrderElementsOf(RunCapture.FILES);

        // A leftover .evict-<id> is counted at the next start and never removed.
        DirectoryCaptureSink again = new DirectoryCaptureSink(directory);
        assertThat(again.open()).extracting(RunCaptureSink.Stored::id).containsExactly(kept);
        assertThat(again.incomplete()).isEqualTo(1);
        assertThat(names(directory)).contains(DirectoryCaptureSink.EVICT + kept);
    }

    @Test
    void aDeleteThatFailsAfterTheRenameIsAPartialRemoval() throws IOException {
        assumeFalse("root".equals(System.getProperty("user.name")), "root deletes through any mode");
        Path directory = ownerOnly("half");
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        String id = Captures.id(1);
        sink.write(Captures.of(id, 10));
        Path inner = Files.createDirectory(directory.resolve(id).resolve("locked"));
        Files.writeString(inner.resolve("held.txt"), "x");
        Files.setPosixFilePermissions(inner, PosixFilePermissions.fromString("r-x------"));
        try {
            assertThatThrownBy(() -> sink.remove(id)).isInstanceOf(RunCaptureSink.PartlyRemovedException.class);
            assertThat(names(directory)).as("out of the capture names").containsExactly(DirectoryCaptureSink.EVICT + id);
        } finally {
            Files.setPosixFilePermissions(directory.resolve(DirectoryCaptureSink.EVICT + id).resolve("locked"), PosixFilePermissions.fromString("rwx------"));
        }
    }

    // ---------------------------------------------------------------------------------------------- the owner

    @Test
    void aDirectoryOwnedByAnotherUserIsRefused() throws IOException {
        try (FileSystem unix = Jimfs.newFileSystem(Configuration.unix().toBuilder().setAttributeViews("basic", "owner", "posix", "unix").build())) {
            Path directory = unix.getPath("/captures");
            Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            new DirectoryCaptureSink(directory).open();
            Files.setOwner(directory, unix.getUserPrincipalLookupService().lookupPrincipalByName("mallory"));
            assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).isInstanceOfSatisfying(DatumConfigurationException.class, e -> {
                assertThat(e.property()).isEqualTo(DirectoryCaptureSink.PROPERTY);
                assertThat(e.problem()).contains("is owned by mallory").contains("not by the JVM's user");
            });
            try (Stream<Path> entries = Files.list(directory)) {
                assertThat(entries.toList()).as("the probe is gone, nothing else written").isEmpty();
            }
        }
    }

    // ---------------------------------------------------------------------------------------------- the macOS ACL

    private static final String CLEAN = "drwx------  2 ada  staff  64 Nov 23 10:00 /var/tmp/captures\n";

    @Test
    void theAclListingIsReadStrictly() {
        assertThat(DirectoryCaptureSink.aclVerdict(CLEAN)).isEqualTo(DirectoryCaptureSink.AclVerdict.NONE);
        assertThat(DirectoryCaptureSink.aclVerdict("drwx------@ 2 ada  staff  64 Nov 23 10:00 /x\n")).as("extended attributes alone")
            .isEqualTo(DirectoryCaptureSink.AclVerdict.NONE);
        assertThat(DirectoryCaptureSink.aclVerdict("drwx------+ 2 ada  staff  64 Nov 23 10:00 /x\n")).isEqualTo(DirectoryCaptureSink.AclVerdict.ACL);
        assertThat(DirectoryCaptureSink.aclVerdict("drwx------+ 2 ada  staff  64 Nov 23 10:00 /x\n"
            + " 0: group:everyone allow list,search,read,file_inherit,directory_inherit\n")).isEqualTo(DirectoryCaptureSink.AclVerdict.ACL);
        // With extended attributes too, ls prints @ rather than +: the entry lines are what tell.
        assertThat(DirectoryCaptureSink.aclVerdict("drwx------@ 2 ada  staff  64 Nov 23 10:00 /x\n 0: user:mallory allow read\n"))
            .isEqualTo(DirectoryCaptureSink.AclVerdict.ACL);
        for (String unreadable : List.of("", "\n", "-rwx------  1 ada  staff  0 Nov 23 10:00 /x\n", "total 0\n",
            "drwx------  2 ada  staff  64 Nov 23 10:00 /x\ny\n", "drwx------ 2\nnot an entry\n", "drwxrwx---- 2 ada staff 64 /x\n",
            "ls: /x: No such file or directory\n")) {
            assertThat(DirectoryCaptureSink.aclVerdict(unreadable)).as(unreadable).isEqualTo(DirectoryCaptureSink.AclVerdict.UNREADABLE);
        }
    }

    @Test
    void anAclOrAListingThatCannotBeHadRefusesTheStartAndANewAclRefusesTheWrite() throws IOException {
        Path directory = ownerOnly("acl-seam");
        String[] listing = {"drwx------+ 2 ada staff 64 Nov 23 10:00 " + directory + "\n 0: group:everyone allow read\n"};
        DirectoryCaptureSink.AclListing fake = path -> {
            assertThat(path).isEqualTo(directory);
            if (listing[0] == null) {
                throw new IOException("ls cannot run");
            }
            return listing[0];
        };
        assertThatThrownBy(() -> new DirectoryCaptureSink(directory, fake).open()).isInstanceOfSatisfying(DatumConfigurationException.class, e -> {
            assertThat(e.problem()).contains("access control list").contains("personal data");
            assertThat(e.action()).contains("chmod -N " + directory).contains("parent").contains(directory.getParent().toString());
        });
        listing[0] = null;
        assertThatThrownBy(() -> new DirectoryCaptureSink(directory, fake).open()).as("fail closed").isInstanceOfSatisfying(
            DatumConfigurationException.class, e -> assertThat(e.problem()).contains("could not be checked for an access control list"));
        listing[0] = "drwx------ 2 ada staff 64 Nov 23 10:00 /x\nsomething else\n";
        assertThatThrownBy(() -> new DirectoryCaptureSink(directory, fake).open()).as("unreadable").isInstanceOf(DatumConfigurationException.class);
        assertThat(names(directory)).as("no probe was made before the refusal").isEmpty();

        listing[0] = CLEAN;
        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory, fake);
        sink.open();
        sink.write(Captures.of(Captures.id(1), 10));
        listing[0] = "drwx------+ 2 ada staff 64 Nov 23 10:00 /x\n";
        assertThatThrownBy(() -> sink.write(Captures.of(Captures.id(2), 10))).as("an ACL added after the start").isInstanceOf(IOException.class);
        listing[0] = null;
        assertThatThrownBy(() -> sink.write(Captures.of(Captures.id(3), 10))).as("a check that cannot run").isInstanceOf(IOException.class);
        assertThat(names(directory)).hasSize(1);
    }

    private static void chmod(String... arguments) throws IOException, InterruptedException {
        List<String> command = new ArrayList<>(List.of("/bin/chmod"));
        command.addAll(List.of(arguments));
        Process chmod = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(chmod.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(chmod.waitFor()).as(output).isZero();
    }

    @Test
    @EnabledOnOs(OS.MAC)
    void onMacOsARealAclOnTheDirectoryIsRefused() throws Exception {
        Path directory = ownerOnly("acl-real");
        new DirectoryCaptureSink(directory).open();
        chmod("+a", "group:everyone allow list,search,read", directory.toString());
        assertThat(mode(directory)).as("the mode alone says owner-only").isEqualTo("rwx------");
        assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).isInstanceOfSatisfying(DatumConfigurationException.class,
            e -> assertThat(e.action()).contains("chmod -N " + directory));
        chmod("-N", directory.toString());
        new DirectoryCaptureSink(directory).open();
    }

    @Test
    @EnabledOnOs(OS.MAC)
    void onMacOsADirectoryMadeUnderAParentWithAnInheritableAclIsRefusedAndAnAclAddedLaterStopsTheWrites() throws Exception {
        Path parent = ownerOnly("acl-parent");
        chmod("+a", "group:everyone allow list,search,read,add_file,file_inherit,directory_inherit", parent.toString());
        Path directory = parent.resolve("captures");
        assertThatThrownBy(() -> new DirectoryCaptureSink(directory).open()).isInstanceOfSatisfying(DatumConfigurationException.class,
            e -> assertThat(e.action()).contains("parent"));
        assertThat(names(directory)).as("the inherited ACL refused it before anything was written").isEmpty();
        chmod("-N", parent.toString());
        chmod("-N", directory.toString());

        DirectoryCaptureSink sink = new DirectoryCaptureSink(directory);
        sink.open();
        sink.write(Captures.of(Captures.id(1), 10));
        chmod("+a", "group:everyone allow list,search,read,file_inherit,directory_inherit", directory.toString());
        assertThatThrownBy(() -> sink.write(Captures.of(Captures.id(2), 10))).isInstanceOf(IOException.class);
        assertThat(names(directory)).hasSize(1);
        chmod("-N", directory.toString());
    }
}
