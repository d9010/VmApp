//! Runs the unit tests of `guest/src/netproxy.rs` (SPEC 8.3 the HTTP proxy, SPEC 8.6 the host-service listener) on the
//! build machine. `vmapp-init` itself only compiles for Linux (vsock, mount, chroot), but the proxy module uses only
//! sockets and the small JSON reader, so it is included here with the few things it takes from `main.rs` stubbed:
//!
//!     (cd tests/guest-net && cargo test)
//!
//! The module is included by path, not copied: what is tested is the guest's own source.

#![allow(dead_code)]

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};

pub const NAME: &str = "vmapp-init";
const MAX_LINE: u64 = 1024 * 1024;

/// Same as `main.rs`: a line on the console (here stderr).
macro_rules! log {
    ($($arg:tt)*) => {{
        let _ = writeln!(io::stderr(), "{}: {}", NAME, format_args!($($arg)*));
    }};
}

#[path = "../../../guest/src/json.rs"]
mod json;
#[path = "../../../guest/src/netproxy.rs"]
mod netproxy;
#[path = "../../../guest/src/portfwd.rs"]
mod portfwd;

/// Same as `main.rs`.
pub enum Line {
    Eof,
    TooLong,
    Text(String),
}

/// Same as `main.rs`.
pub fn read_line(r: &mut BufReader<File>) -> io::Result<Line> {
    let mut buf = Vec::new();
    let n = r.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(Line::Eof);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    } else if buf.len() as u64 > MAX_LINE {
        return Ok(Line::TooLong);
    }
    Ok(Line::Text(String::from_utf8_lossy(&buf).into_owned()))
}

fn main() {
    let _ = writeln!(io::stderr(), "run: cargo test");
}
