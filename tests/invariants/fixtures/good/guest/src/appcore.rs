//! Fixture of the core launcher: chroot into /rt, drop to uid/gid 1000, no_new_privs.

/// The chroot of the core.
pub const ROOT: &str = "/rt";
pub const APP_UID: u32 = 1000;
pub const APP_GID: u32 = 1000;

/// Runs in the forked child, before exec.
pub unsafe fn drop_privileges(root: *const libc::c_char) -> Result<(), u8> {
    if libc::chroot(root) != 0 {
        return Err(1);
    }
    if libc::setgroups(0, std::ptr::null()) != 0 {
        return Err(3);
    }
    if libc::setgid(APP_GID) != 0 {
        return Err(4);
    }
    if libc::setuid(APP_UID) != 0 {
        return Err(5);
    }
    libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn unwrap_is_fine_in_tests() {
        let v: Option<u8> = Some(1);
        assert_eq!(v.unwrap(), 1);
        eprintln!("test output");
    }
}
