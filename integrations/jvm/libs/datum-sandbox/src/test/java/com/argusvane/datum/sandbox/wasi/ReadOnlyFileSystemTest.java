package com.argusvane.datum.sandbox.wasi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.google.common.jimfs.Configuration;
import com.google.common.jimfs.Jimfs;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.AccessMode;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.ProviderMismatchException;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFileAttributeView;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The guest's view of its {@code /app}: reads go through, every change is refused before it reaches Jimfs (names and entries Jimfs keeps on the heap are not under its size cap).
 */
class ReadOnlyFileSystemTest {

    private FileSystem jimfs;
    private Path app;

    @BeforeEach
    void open() throws Exception {
        jimfs = Jimfs.newFileSystem(Configuration.unix());
        Path real = Files.createDirectories(jimfs.getPath("/app"));
        Files.writeString(real.resolve("run.js"), "print(1);");
        app = ReadOnlyFileSystem.over(jimfs).getPath("/app");
    }

    @AfterEach
    void close() throws Exception {
        jimfs.close();
    }

    @Test
    void readsListingsAndAttributesGoThrough() throws Exception {
        Path run = app.resolve("run.js");
        assertThat(run.getFileSystem().isReadOnly()).isTrue();
        assertThat(Files.readString(run)).isEqualTo("print(1);");
        assertThat(Files.exists(run)).isTrue();
        assertThat(Files.isRegularFile(run)).isTrue();
        assertThat(Files.isDirectory(app)).isTrue();
        assertThat(Files.size(run)).isEqualTo(9);
        assertThat(Files.readAttributes(run, "basic:size")).containsEntry("size", 9L);
        try (FileChannel channel = FileChannel.open(run, StandardOpenOption.READ)) {
            ByteBuffer buffer = ByteBuffer.allocate(5);
            channel.read(buffer, 0);
            assertThat(new String(buffer.array(), StandardCharsets.UTF_8)).isEqualTo("print");
            channel.position(6);
            assertThat(channel.position()).isEqualTo(6);
        }
        List<String> names = new ArrayList<>();
        try (Stream<Path> listing = Files.list(app)) {
            listing.forEach(path -> {
                assertThat(path.getFileSystem()).isSameAs(app.getFileSystem());
                names.add(path.getFileName().toString());
            });
        }
        assertThat(names).containsExactly("run.js");
        Files.getFileAttributeView(run, BasicFileAttributeView.class).readAttributes();
        app.getFileSystem().provider().checkAccess(run, AccessMode.READ);
    }

    @Test
    void pathsStayInTheView() throws Exception {
        Path run = app.resolve("run.js");
        assertThat(run.getParent()).isEqualTo(app);
        assertThat(run.startsWith(app)).isTrue();
        assertThat(run.startsWith(jimfs.getPath("/app"))).as("a path of another file system").isFalse();
        assertThat(app.resolve("x/../run.js").normalize()).isEqualTo(run);
        assertThat(run.toRealPath().getFileSystem()).isSameAs(app.getFileSystem());
        assertThat(app.relativize(run).toString()).isEqualTo("run.js");
        assertThatThrownBy(() -> app.resolve(jimfs.getPath("run.js"))).isInstanceOf(ProviderMismatchException.class);
        assertThatThrownBy(() -> app.getFileSystem().provider().newFileChannel(jimfs.getPath("/app/run.js"),
            java.util.Set.of(StandardOpenOption.READ))).as("a path from outside the view").isInstanceOf(ProviderMismatchException.class);
    }

    @Test
    void nothingCanBeCreatedChangedOrRemoved() throws Exception {
        Path run = app.resolve("run.js");
        Path other = app.resolve("other");
        assertThatThrownBy(() -> Files.createDirectory(app.resolve("d"))).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.createDirectory(app.resolve("a".repeat(200_000)))).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.writeString(other, "x")).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.newByteChannel(other, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE))
            .isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> FileChannel.open(run, StandardOpenOption.APPEND)).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> FileChannel.open(run, StandardOpenOption.READ, StandardOpenOption.TRUNCATE_EXISTING))
            .isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> FileChannel.open(run, StandardOpenOption.READ, StandardOpenOption.DELETE_ON_CLOSE))
            .isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.delete(run)).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.move(run, other)).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.copy(run, other)).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.createSymbolicLink(other, run)).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.createLink(other, run)).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.setLastModifiedTime(run, FileTime.fromMillis(0))).isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> Files.setAttribute(run, "basic:lastModifiedTime", FileTime.fromMillis(0)))
            .isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> app.getFileSystem().provider().checkAccess(run, AccessMode.WRITE))
            .isInstanceOf(AccessDeniedException.class);
        assertThat(Files.getFileAttributeView(run, PosixFileAttributeView.class)).as("only the basic view, read-only").isNull();

        // Through a descriptor opened for reading: write, truncate and transfers in are refused as IOExceptions,
        // which Endive's WASI handlers map to an errno.
        try (FileChannel channel = FileChannel.open(run, StandardOpenOption.READ)) {
            assertThatThrownBy(() -> channel.write(ByteBuffer.wrap(new byte[] {1}))).isInstanceOf(AccessDeniedException.class);
            assertThatThrownBy(() -> channel.write(ByteBuffer.wrap(new byte[] {1}), 100)).isInstanceOf(AccessDeniedException.class);
            assertThatThrownBy(() -> channel.truncate(0)).isInstanceOf(AccessDeniedException.class);
            assertThatThrownBy(() -> channel.lock()).isInstanceOf(AccessDeniedException.class);
            assertThatThrownBy(() -> channel.map(FileChannel.MapMode.READ_WRITE, 0, 1)).isInstanceOf(AccessDeniedException.class);
        }

        // Nothing reached the real file system.
        try (Stream<Path> listing = Files.list(jimfs.getPath("/app"))) {
            assertThat(listing.map(path -> path.getFileName().toString())).containsExactly("run.js");
        }
        assertThat(Files.readString(jimfs.getPath("/app/run.js"))).isEqualTo("print(1);");
    }
}
