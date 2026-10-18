//! `mkcpio` writes the two kinds of uncompressed "newc" (070701) cpio archives vmapp needs.
//!
//! ```text
//! mkcpio <dir> <out.cpio>                  pack a directory tree (an app's core.cpio, SPEC section 2.1)
//! mkcpio --init FILE <out.cpio>            build the initramfs: dev, dev/console (char 5,1), proc, sys, tmp, init
//! mkcpio <dir> <out.cpio> --init FILE      same; <dir> is ignored in --init mode
//! ```
//!
//! Directory mode is deterministic: entries sorted by path (byte order), uid/gid 0, mtime 0, fixed inode
//! numbers, mode 0755 for directories and for files with any exec bit, else 0644. Relative symlinks that stay
//! inside the tree are kept; absolute or escaping symlinks and special files are errors. The archive ends with
//! `TRAILER!!!`. The initramfs mode follows agent-vm/tools/mkinitramfs (commit 8f0c069).

use std::fs;
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::ExitCode;

const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFCHR: u32 = 0o020000;
const S_IFLNK: u32 = 0o120000;
const MAX_NAME: usize = 4096;

struct Entry {
    name: String,
    mode: u32,
    nlink: u32,
    rdev_major: u32,
    rdev_minor: u32,
    data: Vec<u8>,
    /// Regular files are read from disk while writing, to keep memory flat.
    path: Option<std::path::PathBuf>,
    size: u64,
}

impl Entry {
    fn simple(name: &str, mode: u32, nlink: u32) -> Entry {
        Entry { name: name.to_owned(), mode, nlink, rdev_major: 0, rdev_minor: 0, data: Vec::new(), path: None, size: 0 }
    }
}

struct Counting<W: Write> {
    inner: W,
    pos: u64,
}

impl<W: Write> Counting<W> {
    fn put(&mut self, b: &[u8]) -> io::Result<()> {
        self.inner.write_all(b)?;
        self.pos += b.len() as u64;
        Ok(())
    }

    fn pad4(&mut self) -> io::Result<()> {
        let n = (4 - self.pos % 4) % 4;
        self.put(&[0u8; 3][..n as usize])
    }
}

fn write_header<W: Write>(w: &mut Counting<W>, ino: u32, e: &Entry) -> io::Result<()> {
    let namesize = e.name.len() as u32 + 1;
    let fields: [u32; 13] = [
        ino,
        e.mode,
        0, // uid
        0, // gid
        e.nlink,
        0, // mtime
        e.size as u32,
        0, // devmajor
        0, // devminor
        e.rdev_major,
        e.rdev_minor,
        namesize,
        0, // check
    ];
    w.put(b"070701")?;
    for f in fields {
        w.put(format!("{f:08X}").as_bytes())?;
    }
    w.put(e.name.as_bytes())?;
    w.put(&[0])?;
    w.pad4() // header (110) + name, padded to 4
}

fn write_archive<W: Write>(out: W, entries: &[Entry]) -> io::Result<u64> {
    let mut w = Counting { inner: out, pos: 0 };
    for (i, e) in entries.iter().enumerate() {
        write_header(&mut w, i as u32 + 1, e)?;
        if let Some(p) = &e.path {
            let mut f = fs::File::open(p)?;
            let n = io::copy(&mut f, &mut w.inner)?;
            if n != e.size {
                return Err(io::Error::other(format!("{} changed while packing", p.display())));
            }
            w.pos += n;
        } else {
            w.put(&e.data)?;
        }
        w.pad4()?;
    }
    // Trailer: nlink 1, all else zero.
    let trailer = Entry::simple("TRAILER!!!", 0, 1);
    write_header(&mut w, 0, &trailer)?;
    w.inner.flush()?;
    Ok(w.pos)
}

/// A symlink in directory `dir_depth` levels below the root must not point outside the tree.
fn check_link(dir_depth: usize, target: &str) -> Result<(), String> {
    if target.is_empty() {
        return Err("empty symlink target".into());
    }
    if target.starts_with('/') {
        return Err(format!("absolute symlink target {target:?} (only relative links inside the tree are allowed)"));
    }
    let mut depth = dir_depth as i64;
    for c in target.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("symlink target {target:?} escapes the tree"));
                }
            }
            _ => depth += 1,
        }
    }
    Ok(())
}

fn walk(root: &Path, rel: &str, out: &mut Vec<Entry>) -> Result<(), String> {
    let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let rd = fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for item in rd {
        let item = item.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let name = item.file_name().into_string().map_err(|n| format!("non-UTF-8 file name {n:?} in {}", dir.display()))?;
        let relname = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if relname.len() > MAX_NAME - 1 {
            return Err(format!("path too long: {relname}"));
        }
        let path = item.path();
        let md = fs::symlink_metadata(&path).map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        let ft = md.file_type();
        if ft.is_dir() {
            out.push(Entry::simple(&relname, S_IFDIR | 0o755, 2));
            walk(root, &relname, out)?;
        } else if ft.is_file() {
            let mode = if md.permissions().mode() & 0o111 != 0 { 0o755 } else { 0o644 };
            if md.len() > u64::from(u32::MAX) {
                return Err(format!("{relname}: file larger than 4 GiB"));
            }
            let mut e = Entry::simple(&relname, S_IFREG | mode, 1);
            e.size = md.len();
            e.path = Some(path);
            out.push(e);
        } else if ft.is_symlink() {
            let target = fs::read_link(&path).map_err(|e| format!("cannot read link {}: {e}", path.display()))?;
            let target = target.into_os_string().into_string().map_err(|_| format!("{relname}: non-UTF-8 symlink target"))?;
            let depth = relname.split('/').count() - 1;
            check_link(depth, &target).map_err(|e| format!("{relname}: {e}"))?;
            let mut e = Entry::simple(&relname, S_IFLNK | 0o777, 1);
            e.size = target.len() as u64;
            e.data = target.into_bytes();
            out.push(e);
        } else {
            return Err(format!("{relname}: unsupported file type (only files, directories and symlinks)"));
        }
    }
    Ok(())
}

fn pack_dir(dir: &Path) -> Result<Vec<Entry>, String> {
    let md = fs::metadata(dir).map_err(|e| format!("cannot stat {}: {e}", dir.display()))?;
    if !md.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }
    let mut entries = Vec::new();
    walk(dir, "", &mut entries)?;
    entries.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    Ok(entries)
}

fn init_entries(init: &Path) -> Result<Vec<Entry>, String> {
    let data = fs::read(init).map_err(|e| format!("cannot read {}: {e}", init.display()))?;
    if data.len() > u32::MAX as usize {
        return Err("init binary too large for newc".into());
    }
    let mut c = Entry::simple("dev/console", S_IFCHR | 0o600, 1);
    c.rdev_major = 5;
    c.rdev_minor = 1;
    let mut i = Entry::simple("init", S_IFREG | 0o755, 1);
    i.size = data.len() as u64;
    i.data = data;
    Ok(vec![
        Entry::simple("dev", S_IFDIR | 0o755, 2),
        c,
        Entry::simple("proc", S_IFDIR | 0o755, 2),
        Entry::simple("sys", S_IFDIR | 0o755, 2),
        Entry::simple("tmp", S_IFDIR | 0o755, 2),
        i,
    ])
}

fn usage() -> ExitCode {
    eprintln!("usage: mkcpio <dir> <out.cpio>\n       mkcpio --init FILE <out.cpio>");
    ExitCode::from(2)
}

fn run() -> Result<ExitCode, String> {
    let mut positional: Vec<String> = Vec::new();
    let mut init: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--init" {
            init = Some(args.next().ok_or("--init needs a file")?);
        } else if a.starts_with("--") {
            return Err(format!("unknown option {a}"));
        } else {
            positional.push(a);
        }
    }
    let (entries, out_path) = match (&init, positional.as_slice()) {
        (Some(f), [out]) | (Some(f), [_, out]) => (init_entries(Path::new(f))?, out.clone()),
        (None, [dir, out]) => (pack_dir(Path::new(dir))?, out.clone()),
        _ => return Ok(usage()),
    };
    let f = fs::File::create(&out_path).map_err(|e| format!("cannot create {out_path}: {e}"))?;
    let n = write_archive(BufWriter::new(f), &entries).map_err(|e| format!("cannot write {out_path}: {e}"))?;
    eprintln!("mkcpio: wrote {out_path} ({n} bytes, {} entries)", entries.len());
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    match run() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mkcpio: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        assert!(check_link(1, "../x").is_ok());
        assert!(check_link(0, "../x").is_err());
        assert!(check_link(0, "/etc").is_err());
        assert!(check_link(2, "a/../../b").is_ok());
    }

    #[test]
    fn trailer_only_is_aligned() {
        let mut v = Vec::new();
        let n = write_archive(&mut v, &[]).unwrap();
        assert_eq!(n as usize, v.len());
        assert_eq!(v.len() % 4, 0);
        assert!(v.starts_with(b"070701"));
        assert!(v.windows(10).any(|w| w == b"TRAILER!!!"));
    }
}
