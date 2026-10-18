//! The app's core as an EROFS image (SPEC sections 2.1 and 4, step 3, `core.image: "erofs"`).
//!
//! The host verified the image before it was installed (hostlib/erofs.js: the format subset, owners, modes, symlinks) and checks its
//! SHA-256 at every launch. The guest only recognises it (the EROFS magic at byte 1024 of `/dev/vdb`; a cpio starts with "07070"),
//! mounts it read-only, nosuid and nodev at `/rt/app`, and walks the mounted tree once with the rules the cpio extraction applies:
//! regular files, directories and relative symlinks that stay inside `/app`, owned by root, no setuid, setgid or sticky bit. The
//! files are not copied: they cost the VM no memory but the page cache.
//!
//! No `unwrap`/`expect`/indexing: this runs in PID 1.

use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use crate::cpio::{check_link, Stats};

const MAGIC: u32 = 0xE0F5_E1E2;
const SB_OFFSET: usize = 1024;

/// True when `head` (the start of the core disk) is an EROFS image.
pub fn is_erofs(head: &[u8]) -> bool {
    head.get(SB_OFFSET..SB_OFFSET + 4)
        .and_then(|b| <[u8; 4]>::try_from(b).ok())
        .is_some_and(|b| u32::from_le_bytes(b) == MAGIC)
}

/// Walks the mounted image below `root` and applies the core's rules. Returns the number of regular files and their bytes.
pub fn check_tree(root: &Path) -> Result<Stats, String> {
    let mut stats = Stats::default();
    // (directory, its path below root as components)
    let mut stack: Vec<(PathBuf, Vec<String>)> = vec![(root.to_path_buf(), Vec::new())];
    while let Some((dir, comps)) = stack.pop() {
        let rd = fs::read_dir(&dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
        for ent in rd {
            let ent = ent.map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
            let path = ent.path();
            let name = ent.file_name().into_string().map_err(|_| format!("a name that is not UTF-8 in {}", dir.display()))?;
            let md = fs::symlink_metadata(&path).map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
            if md.uid() != 0 || md.gid() != 0 {
                return Err(format!("{} is owned by {}:{}, not root", path.display(), md.uid(), md.gid()));
            }
            if md.mode() & 0o7000 != 0 {
                return Err(format!("{} has a setuid, setgid or sticky bit", path.display()));
            }
            let ft = md.file_type();
            if ft.is_dir() {
                let mut sub = comps.clone();
                sub.push(name);
                stack.push((path, sub));
            } else if ft.is_file() {
                stats.files += 1;
                stats.bytes += md.len();
            } else if ft.is_symlink() {
                let target = fs::read_link(&path).map_err(|e| format!("cannot read the link {}: {e}", path.display()))?;
                let target = target.to_str().ok_or_else(|| format!("{}: a link target that is not UTF-8", path.display()))?;
                let dir_comps: Vec<&str> = comps.iter().map(String::as_str).collect();
                check_link(&dir_comps, target).map_err(|e| format!("{}: {e}", path.display()))?;
            } else {
                let kind = if ft.is_block_device() || ft.is_char_device() { "a device" } else { "not a file, directory or symlink" };
                return Err(format!("{} is {kind}", path.display()));
            }
        }
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_magic() {
        let mut head = vec![0u8; 4096];
        assert!(!is_erofs(&head));
        head[1024..1028].copy_from_slice(&MAGIC.to_le_bytes());
        assert!(is_erofs(&head));
        assert!(!is_erofs(b"070701"));
        assert!(!is_erofs(&[]));
    }
}
