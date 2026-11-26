package com.argusvane.datum.sandbox.wasi;

import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.ReadableByteChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.channels.WritableByteChannel;
import java.nio.file.AccessDeniedException;
import java.nio.file.AccessMode;
import java.nio.file.CopyOption;
import java.nio.file.DirectoryStream;
import java.nio.file.FileStore;
import java.nio.file.FileSystem;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.ProviderMismatchException;
import java.nio.file.StandardOpenOption;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.FileAttributeView;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.UserPrincipalLookupService;
import java.nio.file.spi.FileSystemProvider;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * A read-only view of a run's in-memory file system: the guest's {@code /app} preopen goes through it.
 *
 * <p>Why: Jimfs keeps every directory entry and every name on the JVM heap until the file system is closed, and its
 * size cap counts file content only. A guest that may reach {@code qjs:os} (a host-trusted rule module can) could
 * otherwise create directories with names of hundreds of kilobytes for its whole budget and hold about half a GiB of
 * the application's heap per run. A wasmtime host's preopen fills
 * a temp directory on disk instead, so this is a hazard of the in-memory file system alone. A run writes nothing there:
 * the guest reads the files it was handed ({@link GuestRun#appFiles()}) and answers on stdout.
 *
 * <p>Every operation that would create, change or remove an entry, a name, content or a time stamp throws
 * {@link AccessDeniedException} before it reaches Jimfs; a WASI layer maps it to an errno (Endive's: {@code EIO}), so the
 * guest sees a failed call, never a trap. Channels opened for reading are wrapped the same way, so a truncate, an
 * allocate or a write through a read descriptor is refused as an {@link IOException} rather than escaping Endive's
 * handlers as an unchecked {@code NonWritableChannelException}. Reads, look-ups, attributes and listings delegate.
 */
final class ReadOnlyFileSystem extends FileSystem {

    private static final Set<OpenOption> WRITING = Set.of(StandardOpenOption.WRITE, StandardOpenOption.APPEND,
        StandardOpenOption.CREATE, StandardOpenOption.CREATE_NEW, StandardOpenOption.TRUNCATE_EXISTING,
        StandardOpenOption.DELETE_ON_CLOSE);

    private final FileSystem delegate;
    private final Provider provider;

    private ReadOnlyFileSystem(FileSystem delegate) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.provider = new Provider(this, delegate.provider());
    }

    /** A read-only view of a file system; closing the view closes the file system. */
    static ReadOnlyFileSystem over(FileSystem delegate) {
        return new ReadOnlyFileSystem(delegate);
    }

    @Nullable Path wrap(@Nullable Path path) {
        return path == null ? null : new ReadOnlyPath(this, path);
    }

    Path unwrap(Path path) {
        if (path instanceof ReadOnlyPath own && own.fs == this) {
            return own.delegate;
        }
        throw new ProviderMismatchException();
    }

    private static AccessDeniedException denied(Path path) {
        return new AccessDeniedException(String.valueOf(path), null, "the run's /app is read-only");
    }

    @Override
    public FileSystemProvider provider() {
        return provider;
    }

    @Override
    public void close() throws IOException {
        delegate.close();
    }

    @Override
    public boolean isOpen() {
        return delegate.isOpen();
    }

    @Override
    public boolean isReadOnly() {
        return true;
    }

    @Override
    public String getSeparator() {
        return delegate.getSeparator();
    }

    @Override
    public Iterable<Path> getRootDirectories() {
        List<Path> roots = new ArrayList<>();
        delegate.getRootDirectories().forEach(root -> roots.add(wrap(root)));
        return roots;
    }

    @Override
    public Iterable<FileStore> getFileStores() {
        return delegate.getFileStores();
    }

    @Override
    public Set<String> supportedFileAttributeViews() {
        return delegate.supportedFileAttributeViews();
    }

    @Override
    public Path getPath(String first, String... more) {
        return wrap(delegate.getPath(first, more));
    }

    @Override
    public PathMatcher getPathMatcher(String syntaxAndPattern) {
        PathMatcher matcher = delegate.getPathMatcher(syntaxAndPattern);
        return path -> path instanceof ReadOnlyPath own && own.fs == this && matcher.matches(own.delegate);
    }

    @Override
    public UserPrincipalLookupService getUserPrincipalLookupService() {
        throw new UnsupportedOperationException("not offered on a run's /app");
    }

    @Override
    public WatchService newWatchService() {
        throw new UnsupportedOperationException("not offered on a run's /app");
    }

    /** A path of the view: the delegate's path, every derived path wrapped again. */
    static final class ReadOnlyPath implements Path {

        final ReadOnlyFileSystem fs;
        final Path delegate;

        ReadOnlyPath(ReadOnlyFileSystem fs, Path delegate) {
            this.fs = fs;
            this.delegate = delegate;
        }

        private Path own(Path other) {
            return fs.unwrap(other);
        }

        private boolean ours(Path other) {
            return other instanceof ReadOnlyPath path && path.fs == fs;
        }

        @Override
        public FileSystem getFileSystem() {
            return fs;
        }

        @Override
        public boolean isAbsolute() {
            return delegate.isAbsolute();
        }

        @Override
        public Path getRoot() {
            return fs.wrap(delegate.getRoot());
        }

        @Override
        public Path getFileName() {
            return fs.wrap(delegate.getFileName());
        }

        @Override
        public Path getParent() {
            return fs.wrap(delegate.getParent());
        }

        @Override
        public int getNameCount() {
            return delegate.getNameCount();
        }

        @Override
        public Path getName(int index) {
            return fs.wrap(delegate.getName(index));
        }

        @Override
        public Path subpath(int beginIndex, int endIndex) {
            return fs.wrap(delegate.subpath(beginIndex, endIndex));
        }

        @Override
        public boolean startsWith(Path other) {
            return ours(other) && delegate.startsWith(((ReadOnlyPath) other).delegate);
        }

        @Override
        public boolean endsWith(Path other) {
            return ours(other) && delegate.endsWith(((ReadOnlyPath) other).delegate);
        }

        @Override
        public Path normalize() {
            return fs.wrap(delegate.normalize());
        }

        @Override
        public Path resolve(Path other) {
            return fs.wrap(delegate.resolve(own(other)));
        }

        @Override
        public Path relativize(Path other) {
            return fs.wrap(delegate.relativize(own(other)));
        }

        @Override
        public URI toUri() {
            return delegate.toUri();
        }

        @Override
        public Path toAbsolutePath() {
            return fs.wrap(delegate.toAbsolutePath());
        }

        @Override
        public Path toRealPath(LinkOption... options) throws IOException {
            return fs.wrap(delegate.toRealPath(options));
        }

        @Override
        public WatchKey register(WatchService watcher, WatchEvent.Kind<?>[] events, WatchEvent.Modifier... modifiers) {
            throw new UnsupportedOperationException("not offered on a run's /app");
        }

        @Override
        public int compareTo(Path other) {
            return delegate.compareTo(own(other));
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof ReadOnlyPath path && path.fs == fs && delegate.equals(path.delegate);
        }

        @Override
        public int hashCode() {
            return delegate.hashCode();
        }

        @Override
        public String toString() {
            return delegate.toString();
        }
    }

    /** The view's provider: reads delegate, every change is refused. */
    private static final class Provider extends FileSystemProvider {

        private final ReadOnlyFileSystem fs;
        private final FileSystemProvider delegate;

        Provider(ReadOnlyFileSystem fs, FileSystemProvider delegate) {
            this.fs = fs;
            this.delegate = delegate;
        }

        @Override
        public String getScheme() {
            return delegate.getScheme();
        }

        @Override
        public FileSystem newFileSystem(URI uri, Map<String, ?> env) {
            throw new UnsupportedOperationException("not offered on a run's /app");
        }

        @Override
        public FileSystem getFileSystem(URI uri) {
            throw new UnsupportedOperationException("not offered on a run's /app");
        }

        @Override
        public Path getPath(URI uri) {
            throw new UnsupportedOperationException("not offered on a run's /app");
        }

        @Override
        public SeekableByteChannel newByteChannel(Path path, Set<? extends OpenOption> options, FileAttribute<?>... attrs)
            throws IOException {
            return newFileChannel(path, options, attrs);
        }

        @Override
        public FileChannel newFileChannel(Path path, Set<? extends OpenOption> options, FileAttribute<?>... attrs) throws IOException {
            Path own = fs.unwrap(path);
            for (OpenOption option : options) {
                if (WRITING.contains(option)) {
                    throw denied(path);
                }
            }
            return new ReadChannel(path, delegate.newFileChannel(own, options, attrs));
        }

        @Override
        public DirectoryStream<Path> newDirectoryStream(Path dir, DirectoryStream.Filter<? super Path> filter) throws IOException {
            DirectoryStream<Path> entries = delegate.newDirectoryStream(fs.unwrap(dir), entry -> filter.accept(fs.wrap(entry)));
            return new DirectoryStream<>() {
                @Override
                public Iterator<Path> iterator() {
                    Iterator<Path> inner = entries.iterator();
                    return new Iterator<>() {
                        @Override
                        public boolean hasNext() {
                            return inner.hasNext();
                        }

                        @Override
                        public Path next() {
                            return fs.wrap(inner.next());
                        }
                    };
                }

                @Override
                public void close() throws IOException {
                    entries.close();
                }
            };
        }

        @Override
        public void createDirectory(Path dir, FileAttribute<?>... attrs) throws IOException {
            fs.unwrap(dir);
            throw denied(dir);
        }

        @Override
        public void createSymbolicLink(Path link, Path target, FileAttribute<?>... attrs) throws IOException {
            fs.unwrap(link);
            throw denied(link);
        }

        @Override
        public void createLink(Path link, Path existing) throws IOException {
            fs.unwrap(link);
            throw denied(link);
        }

        @Override
        public void delete(Path path) throws IOException {
            fs.unwrap(path);
            throw denied(path);
        }

        @Override
        public Path readSymbolicLink(Path link) throws IOException {
            return fs.wrap(delegate.readSymbolicLink(fs.unwrap(link)));
        }

        @Override
        public void copy(Path source, Path target, CopyOption... options) throws IOException {
            fs.unwrap(target);
            throw denied(target);
        }

        @Override
        public void move(Path source, Path target, CopyOption... options) throws IOException {
            fs.unwrap(source);
            throw denied(source);
        }

        @Override
        public boolean isSameFile(Path path, Path path2) throws IOException {
            return delegate.isSameFile(fs.unwrap(path), fs.unwrap(path2));
        }

        @Override
        public boolean isHidden(Path path) throws IOException {
            return delegate.isHidden(fs.unwrap(path));
        }

        @Override
        public FileStore getFileStore(Path path) throws IOException {
            return delegate.getFileStore(fs.unwrap(path));
        }

        @Override
        public void checkAccess(Path path, AccessMode... modes) throws IOException {
            Path own = fs.unwrap(path);
            for (AccessMode mode : modes) {
                if (mode == AccessMode.WRITE) {
                    delegate.checkAccess(own);
                    throw denied(path);
                }
            }
            delegate.checkAccess(own, modes);
        }

        @Override
        @SuppressWarnings("unchecked")
        public <V extends FileAttributeView> @Nullable V getFileAttributeView(Path path, Class<V> type, LinkOption... options) {
            Path own = fs.unwrap(path);
            if (type != BasicFileAttributeView.class) {
                // Only the basic view is offered, read-only; Endive asks for no other.
                return null;
            }
            BasicFileAttributeView view = delegate.getFileAttributeView(own, BasicFileAttributeView.class, options);
            if (view == null) {
                return null;
            }
            return (V) new BasicFileAttributeView() {
                @Override
                public String name() {
                    return view.name();
                }

                @Override
                public BasicFileAttributes readAttributes() throws IOException {
                    return view.readAttributes();
                }

                @Override
                public void setTimes(FileTime lastModifiedTime, FileTime lastAccessTime, FileTime createTime) throws IOException {
                    throw denied(path);
                }
            };
        }

        @Override
        public <A extends BasicFileAttributes> A readAttributes(Path path, Class<A> type, LinkOption... options) throws IOException {
            return delegate.readAttributes(fs.unwrap(path), type, options);
        }

        @Override
        public Map<String, Object> readAttributes(Path path, String attributes, LinkOption... options) throws IOException {
            return delegate.readAttributes(fs.unwrap(path), attributes, options);
        }

        @Override
        public void setAttribute(Path path, String attribute, Object value, LinkOption... options) throws IOException {
            fs.unwrap(path);
            throw denied(path);
        }
    }

    /** A channel opened for reading: reads delegate, every write, truncate or exclusive lock is refused. */
    private static final class ReadChannel extends FileChannel {

        private final Path path;
        private final FileChannel delegate;

        ReadChannel(Path path, FileChannel delegate) {
            this.path = path;
            this.delegate = delegate;
        }

        @Override
        public int read(ByteBuffer dst) throws IOException {
            return delegate.read(dst);
        }

        @Override
        public long read(ByteBuffer[] dsts, int offset, int length) throws IOException {
            return delegate.read(dsts, offset, length);
        }

        @Override
        public int read(ByteBuffer dst, long position) throws IOException {
            return delegate.read(dst, position);
        }

        @Override
        public int write(ByteBuffer src) throws IOException {
            throw denied(path);
        }

        @Override
        public long write(ByteBuffer[] srcs, int offset, int length) throws IOException {
            throw denied(path);
        }

        @Override
        public int write(ByteBuffer src, long position) throws IOException {
            throw denied(path);
        }

        @Override
        public long position() throws IOException {
            return delegate.position();
        }

        @Override
        public FileChannel position(long newPosition) throws IOException {
            delegate.position(newPosition);
            return this;
        }

        @Override
        public long size() throws IOException {
            return delegate.size();
        }

        @Override
        public FileChannel truncate(long size) throws IOException {
            throw denied(path);
        }

        @Override
        public void force(boolean metaData) throws IOException {
            delegate.force(metaData);
        }

        @Override
        public long transferTo(long position, long count, WritableByteChannel target) throws IOException {
            return delegate.transferTo(position, count, target);
        }

        @Override
        public long transferFrom(ReadableByteChannel src, long position, long count) throws IOException {
            throw denied(path);
        }

        @Override
        public MappedByteBuffer map(MapMode mode, long position, long size) throws IOException {
            if (mode != MapMode.READ_ONLY) {
                throw denied(path);
            }
            return delegate.map(mode, position, size);
        }

        @Override
        public FileLock lock(long position, long size, boolean shared) throws IOException {
            if (!shared) {
                throw denied(path);
            }
            return delegate.lock(position, size, true);
        }

        @Override
        public FileLock tryLock(long position, long size, boolean shared) throws IOException {
            if (!shared) {
                throw denied(path);
            }
            return delegate.tryLock(position, size, true);
        }

        @Override
        protected void implCloseChannel() throws IOException {
            delegate.close();
        }
    }
}
