//! Fixture of vmapp-init (PID 1): never panics. No unwrap, expect or println!.
mod appcore;

use std::io;

fn mount(source: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: Option<&str>) -> io::Result<()> {
    let _ = (source, target, fstype, flags, data);
    Ok(())
}

fn setup_root() -> Result<(), String> {
    let nsd = libc::MS_NOSUID | libc::MS_NODEV;
    let root = appcore::ROOT;
    mount("/dev/vda", root, "erofs", libc::MS_RDONLY | nsd, None).map_err(|e| format!("runtime image: {e}"))?;
    let app = "/rt/app";
    mount("tmpfs", app, "tmpfs", nsd, Some("mode=0755")).map_err(|e| format!("tmpfs: {e}"))?;
    mount("", app, "", libc::MS_REMOUNT | libc::MS_RDONLY | nsd, None).map_err(|e| format!("remount: {e}"))?;
    Ok(())
}

fn main() {
    let name = std::env::var("X").unwrap_or_default();
    let _ = (setup_root(), name);
}
