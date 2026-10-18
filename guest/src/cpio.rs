//! Streaming extraction of a newc ("070701"/"070702") cpio archive into a directory (SPEC section 4, step 3).
//!
//! The archive is read strictly sequentially (it comes from a raw block device); the `TRAILER!!!` entry marks
//! its end and anything after it is ignored. Only regular files, directories and relative symlinks that stay
//! inside the destination are accepted. Everything else is an error, and the caller powers the VM off.
//! Files get mode 0755 when any exec bit is set, else 0644; directories 0755. The owner is whoever runs this
//! (root in the guest).
//!
//! No `unwrap`/`expect`/indexing: this runs in PID 1 and a panic would take the machine down uncleanly.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const HEADER_LEN: usize = 110;
const MAX_NAME: usize = 4096;
const MAX_LINK: u32 = 4096;
/// SPEC section 2: `core.cpio` is at most 256 MiB.
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const COPY_CHUNK: usize = 64 * 1024;

const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Regular files extracted.
    pub files: u64,
    /// Sum of the regular files' sizes.
    pub bytes: u64,
}

/// A sequential reader that knows its offset (for error messages).
struct Src<R> {
    r: R,
    pos: u64,
}

impl<R: Read> Src<R> {
    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), String> {
        let mut done = 0;
        while done < buf.len() {
            let rest = buf.get_mut(done..).ok_or("internal error: buffer range")?;
            match self.r.read(rest) {
                Ok(0) => return Err(format!("unexpected end of core.cpio at offset {} (no TRAILER!!!)", self.pos)),
                Ok(n) => {
                    done += n;
                    self.pos += n as u64;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("read error at offset {}: {e}", self.pos)),
            }
        }
        Ok(())
    }

    fn skip(&mut self, mut n: u64) -> Result<(), String> {
        let mut scratch = [0u8; 4096];
        while n > 0 {
            let take = n.min(scratch.len() as u64) as usize;
            let buf = scratch.get_mut(..take).ok_or("internal error: skip range")?;
            self.read_exact(buf)?;
            n -= take as u64;
        }
        Ok(())
    }

    /// Copy exactly `n` bytes into `out`.
    fn copy_to(&mut self, out: &mut impl Write, mut n: u64, chunk: &mut [u8]) -> Result<(), String> {
        while n > 0 {
            let take = n.min(chunk.len() as u64) as usize;
            let buf = chunk.get_mut(..take).ok_or("internal error: copy range")?;
            self.read_exact(buf)?;
            out.write_all(buf).map_err(|e| format!("write error: {e}"))?;
            n -= take as u64;
        }
        Ok(())
    }
}

fn hex8(b: &[u8]) -> Option<u32> {
    if b.len() != 8 {
        return None;
    }
    let mut v: u32 = 0;
    for &c in b {
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => return None,
        };
        v = (v << 4) | u32::from(d);
    }
    Some(v)
}

/// Header field `i` (0 = ino, 1 = mode, ..., 6 = filesize, ..., 11 = namesize).
fn field(hdr: &[u8], i: usize) -> Result<u32, String> {
    let start = 6 + i * 8;
    hdr.get(start..start + 8)
        .and_then(hex8)
        .ok_or_else(|| format!("malformed cpio header (field {i} is not 8 hex digits)"))
}

fn pad4(n: u64) -> u64 {
    (4 - n % 4) % 4
}

/// Split an entry name into clean components. `.` components are dropped, so the archive root `.` (or `./`)
/// gives an empty list. Absolute names, empty components and `..` are rejected.
pub fn clean_name(name: &str) -> Result<Vec<&str>, String> {
    if name.starts_with('/') {
        return Err(format!("absolute path in archive: {name:?}"));
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let mut out = Vec::new();
    for c in trimmed.split('/') {
        match c {
            "." => {}
            ".." => return Err(format!("\"..\" in archive path: {name:?}")),
            "" if trimmed.is_empty() => {}
            "" => return Err(format!("empty path component in archive: {name:?}")),
            c => out.push(c),
        }
    }
    Ok(out)
}

/// A symlink at `dir_comps/<name>` pointing at `target` must stay inside the root, judged lexically.
pub fn check_link(dir_comps: &[&str], target: &str) -> Result<(), String> {
    if target.is_empty() {
        return Err("empty symlink target".to_owned());
    }
    if target.starts_with('/') {
        return Err(format!("absolute symlink target: {target:?}"));
    }
    let mut depth = dir_comps.len() as i64;
    for c in target.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("symlink escapes /app: {target:?}"));
                }
            }
            _ => depth += 1,
        }
    }
    Ok(())
}

/// Extract `reader` (a newc archive) below `dest`, which must exist.
pub fn extract<R: Read>(reader: R, dest: &Path) -> Result<Stats, String> {
    let mut src = Src { r: reader, pos: 0 };
    let mut stats = Stats::default();
    let mut symlinks: HashSet<String> = HashSet::new();
    let mut link_paths: Vec<(PathBuf, String)> = Vec::new();
    let mut chunk = vec![0u8; COPY_CHUNK];

    loop {
        let mut hdr = [0u8; HEADER_LEN];
        src.read_exact(&mut hdr)?;
        let magic = hdr.get(..6).unwrap_or(&[]);
        if magic != b"070701" && magic != b"070702" {
            return Err(format!("not a newc cpio (bad magic at offset {})", src.pos - HEADER_LEN as u64));
        }
        let mode = field(&hdr, 1)?;
        let filesize = u64::from(field(&hdr, 6)?);
        let namesize = field(&hdr, 11)? as usize;
        if namesize == 0 || namesize > MAX_NAME {
            return Err(format!("bad name size {namesize} in cpio header"));
        }
        let mut name_buf = vec![0u8; namesize];
        src.read_exact(&mut name_buf)?;
        src.skip(pad4((HEADER_LEN + namesize) as u64))?;
        if name_buf.last() != Some(&0) {
            return Err("cpio entry name is not NUL-terminated".to_owned());
        }
        name_buf.pop();
        let name = std::str::from_utf8(&name_buf).map_err(|_| "cpio entry name is not UTF-8".to_owned())?;

        if name == "TRAILER!!!" {
            break;
        }
        let comps = clean_name(name)?;
        let data_pad = pad4(filesize);
        let kind = mode & S_IFMT;

        if comps.is_empty() {
            // The archive root itself ("."): nothing to create.
            if kind != S_IFDIR {
                return Err(format!("entry {name:?} is not a directory"));
            }
            src.skip(filesize + data_pad)?;
            continue;
        }

        // No entry may live below a symlink of the archive (it would write through the link).
        let mut prefix = String::new();
        for c in comps.iter().take(comps.len() - 1) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(c);
            if symlinks.contains(&prefix) {
                return Err(format!("entry {name:?} is below the symlink {prefix:?}"));
            }
        }
        let rel = comps.join("/");
        let path = dest.join(&rel);

        match kind {
            S_IFDIR => {
                src.skip(filesize + data_pad)?;
                make_parents(&path, dest)?;
                match fs::create_dir(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                        let is_dir = fs::symlink_metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
                        if !is_dir {
                            return Err(format!("{rel}: exists and is not a directory"));
                        }
                    }
                    Err(e) => return Err(format!("mkdir {rel}: {e}")),
                }
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| format!("chmod {rel}: {e}"))?;
            }
            S_IFREG => {
                stats.bytes = stats.bytes.saturating_add(filesize);
                if stats.bytes > MAX_TOTAL_BYTES {
                    return Err(format!("core.cpio holds more than {} MiB of file data", MAX_TOTAL_BYTES >> 20));
                }
                make_parents(&path, dest)?;
                let perm = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(perm)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path)
                    .map_err(|e| format!("create {rel}: {e}"))?;
                src.copy_to(&mut f, filesize, &mut chunk).map_err(|e| format!("{rel}: {e}"))?;
                // fchmod: the creation mode above is subject to the umask.
                f.set_permissions(fs::Permissions::from_mode(perm)).map_err(|e| format!("chmod {rel}: {e}"))?;
                src.skip(data_pad)?;
                stats.files += 1;
            }
            S_IFLNK => {
                if filesize == 0 || filesize > u64::from(MAX_LINK) {
                    return Err(format!("{rel}: bad symlink target length {filesize}"));
                }
                let mut tbuf = vec![0u8; filesize as usize];
                src.read_exact(&mut tbuf)?;
                src.skip(data_pad)?;
                let target = String::from_utf8(tbuf).map_err(|_| format!("{rel}: symlink target is not UTF-8"))?;
                if target.contains('\0') {
                    return Err(format!("{rel}: NUL in symlink target"));
                }
                let dir_comps = comps.get(..comps.len() - 1).unwrap_or(&[]);
                check_link(dir_comps, &target).map_err(|e| format!("{rel}: {e}"))?;
                make_parents(&path, dest)?;
                std::os::unix::fs::symlink(&target, &path).map_err(|e| format!("symlink {rel}: {e}"))?;
                symlinks.insert(rel.clone());
                link_paths.push((path, rel));
            }
            other => {
                return Err(format!("{rel}: unsupported entry type (mode {other:o}); only files, directories and symlinks"));
            }
        }
    }

    // Lexical checks cannot see symlink chains (`a/s -> ..`, `t -> a/s/..`); resolve every link for real.
    let root = fs::canonicalize(dest).map_err(|e| format!("cannot resolve {}: {e}", dest.display()))?;
    for (path, rel) in &link_paths {
        match fs::canonicalize(path) {
            Ok(real) => {
                if !real.starts_with(&root) {
                    return Err(format!("{rel}: symlink resolves outside /app"));
                }
            }
            Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT) | Some(libc::ENOTDIR)) => {} // dangling
            Err(e) => return Err(format!("{rel}: cannot resolve symlink: {e}")),
        }
    }
    Ok(stats)
}

/// Create missing parent directories of `path` below `dest` (mode 0755 through the process umask).
fn make_parents(path: &Path, dest: &Path) -> Result<(), String> {
    match path.parent() {
        Some(p) if p != dest => fs::create_dir_all(p).map_err(|e| format!("mkdir {}: {e}", p.display())),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdr(out: &mut Vec<u8>, mode: u32, filesize: usize, name: &str) {
        out.extend_from_slice(b"070701");
        let fields = [1u32, mode, 0, 0, 1, 0, filesize as u32, 0, 0, 0, 0, name.len() as u32 + 1, 0];
        for f in fields {
            out.extend_from_slice(format!("{f:08X}").as_bytes());
        }
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }

    fn entry(out: &mut Vec<u8>, mode: u32, name: &str, data: &[u8]) {
        hdr(out, mode, data.len(), name);
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }

    fn trailer(out: &mut Vec<u8>) {
        entry(out, 0, "TRAILER!!!", b"");
    }

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("vmapp-cpio-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn names() {
        assert_eq!(clean_name("a/b").unwrap(), ["a", "b"]);
        assert_eq!(clean_name("./a/./b/").unwrap(), ["a", "b"]);
        assert!(clean_name(".").unwrap().is_empty());
        assert!(clean_name("/a").is_err());
        assert!(clean_name("a/../b").is_err());
        assert!(clean_name("..").is_err());
        assert!(clean_name("a//b").is_err());
    }

    #[test]
    fn links() {
        assert!(check_link(&["a"], "../b").is_ok());
        assert!(check_link(&["a"], "../../b").is_err());
        assert!(check_link(&[], "..").is_err());
        assert!(check_link(&[], "/etc/passwd").is_err());
        assert!(check_link(&["a", "b"], "x/../../y").is_ok());
        assert!(check_link(&[], "a/../..").is_err());
        assert!(check_link(&[], "").is_err());
    }

    #[test]
    fn extracts_tree() {
        let mut a = Vec::new();
        entry(&mut a, S_IFDIR | 0o700, "bin", b"");
        entry(&mut a, S_IFREG | 0o700, "bin/run", b"#!/bin/sh\necho hi\n");
        entry(&mut a, S_IFREG | 0o664, "data.txt", b"abcde"); // 5 bytes: needs padding
        entry(&mut a, S_IFLNK | 0o777, "latest", b"data.txt");
        entry(&mut a, S_IFLNK | 0o777, "bin/up", b"../data.txt");
        trailer(&mut a);
        a.extend_from_slice(&[0u8; 512]); // padding after the trailer is ignored
        let d = scratch("tree");
        let st = extract(&a[..], &d).unwrap();
        assert_eq!(st, Stats { files: 2, bytes: 18 + 5 });
        assert_eq!(fs::read(d.join("bin/run")).unwrap(), b"#!/bin/sh\necho hi\n");
        assert_eq!(fs::metadata(d.join("bin/run")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::metadata(d.join("data.txt")).unwrap().permissions().mode() & 0o777, 0o644);
        assert_eq!(fs::metadata(d.join("bin")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::read(d.join("latest")).unwrap(), b"abcde");
        assert_eq!(fs::read(d.join("bin/up")).unwrap(), b"abcde");
        let _ = fs::remove_dir_all(&d);
    }

    fn bad(build: impl FnOnce(&mut Vec<u8>), tag: &str) -> String {
        let mut a = Vec::new();
        build(&mut a);
        trailer(&mut a);
        let d = scratch(tag);
        let e = extract(&a[..], &d).unwrap_err();
        let _ = fs::remove_dir_all(&d);
        e
    }

    #[test]
    fn rejects() {
        assert!(bad(|a| entry(a, S_IFREG | 0o644, "/etc/x", b"x"), "abs").contains("absolute"));
        assert!(bad(|a| entry(a, S_IFREG | 0o644, "../x", b"x"), "dotdot").contains(".."));
        assert!(bad(|a| entry(a, S_IFLNK | 0o777, "l", b"/etc"), "abslink").contains("absolute"));
        assert!(bad(|a| entry(a, S_IFLNK | 0o777, "l", b"../x"), "esc").contains("escapes"));
        assert!(bad(|a| entry(a, 0o020000 | 0o600, "dev", b""), "chr").contains("unsupported"));
        // chain: a/s -> .. is fine alone (lexically `.`), but t -> a/s/.. resolves to / (outside)
        let e = bad(
            |a| {
                entry(a, S_IFDIR | 0o755, "a", b"");
                entry(a, S_IFLNK | 0o777, "a/s", b"..");
                entry(a, S_IFLNK | 0o777, "t", b"a/s/..");
            },
            "chain",
        );
        assert!(e.contains("outside"), "{e}");
        // writing through a symlink of the archive
        let e = bad(
            |a| {
                entry(a, S_IFDIR | 0o755, "d", b"");
                entry(a, S_IFLNK | 0o777, "l", b"d");
                entry(a, S_IFREG | 0o644, "l/x", b"x");
            },
            "through",
        );
        assert!(e.contains("below the symlink"), "{e}");
        // duplicate file
        let e = bad(
            |a| {
                entry(a, S_IFREG | 0o644, "f", b"1");
                entry(a, S_IFREG | 0o644, "f", b"2");
            },
            "dup",
        );
        assert!(e.contains("create f"), "{e}");
    }

    /// Round trip with tools/mkcpio: VMAPP_TEST_CPIO=/path/to/core.cpio cargo test -- --ignored
    #[test]
    #[ignore]
    fn extracts_mkcpio_output() {
        let path = std::env::var("VMAPP_TEST_CPIO").unwrap();
        let d = scratch("mkcpio");
        let st = extract(io::BufReader::new(fs::File::open(path).unwrap()), &d).unwrap();
        eprintln!("{st:?}");
        assert!(st.files > 0);
        assert_eq!(fs::metadata(d.join("bin/run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::read_to_string(d.join("lib/util/up.js")).unwrap(), "console.log('hi');\n");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn truncated_and_garbage() {
        let mut a = Vec::new();
        entry(&mut a, S_IFREG | 0o644, "f", b"hello");
        let d = scratch("trunc");
        assert!(extract(&a[..], &d).unwrap_err().contains("unexpected end"));
        let mut b = a.clone();
        b.truncate(HEADER_LEN + 4);
        assert!(extract(&b[..], &d).is_err());
        assert!(extract(&[0u8; 512][..], &d).unwrap_err().contains("bad magic"));
        let _ = fs::remove_dir_all(&d);
    }
}
