//! The guest side of port forwarding (SPEC 8.8, DEV-APPS C4): the app's servers in the VM, reached from the Mac's localhost.
//!
//! The host listens on the Mac's `127.0.0.1` for a forward the user allowed and, for each connection it accepts, opens a vsock
//! connection to guest port 1026 whose first line is the VM port, `P\n`. This module connects to `127.0.0.1:P` **inside the VM**
//! (its own loopback, nothing else: the address is fixed here, only the port comes from the host) and copies bytes both ways.
//! This is the one place the guest connects to anything (GOVERNANCE INV-N1, rule `n1-no-guest-egress` names this file): no route
//! leaves the VM, so the loopback is all it can reach.
//!
//! PID 1 must never panic (panic=abort): no `unwrap`, `expect` or indexing, and no `println!`.

use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::os::fd::AsRawFd;
use std::thread;
use std::time::Duration;

/// How long the connection to the app's server may take (it is on the same machine).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const STACK: usize = 256 * 1024;

/// Port 1026: one connection per forwarded TCP connection. The first line is the VM port; the bytes after it belong to the
/// connection, so the line is read one byte at a time.
pub fn forward_conn(mut stream: File, _n: u64) {
    let Some(port) = read_port_line(&mut stream) else { return };
    // the VM's own loopback, on the port the host named: never another address
    let target = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let server = match TcpStream::connect_timeout(&target, CONNECT_TIMEOUT) {
        Ok(s) => s,
        Err(_) => {
            // nothing listens there (yet): the host sees the connection end at once and closes its side
            // SAFETY: shutdown(2) on a descriptor this function owns.
            unsafe { libc::shutdown(stream.as_raw_fd(), libc::SHUT_RDWR) };
            return;
        }
    };
    let _ = server.set_nodelay(true);
    splice(server, stream);
}

fn read_port_line(f: &mut File) -> Option<u16> {
    let mut digits = String::new();
    let mut byte = [0u8; 1];
    loop {
        match f.read(&mut byte) {
            Ok(1) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            _ => return None,
        }
        let c = byte.first().copied()?;
        if c == b'\n' {
            break;
        }
        if !c.is_ascii_digit() || digits.len() >= 5 {
            return None;
        }
        digits.push(char::from(c));
    }
    digits.parse::<u16>().ok().filter(|p| *p > 0)
}

/// Copies both ways until either side is done; then ends the whole exchange.
fn splice(server: TcpStream, mut host: File) {
    let (Ok(mut server_r), Ok(mut host_w)) = (server.try_clone(), host.try_clone()) else { return };
    let mut server_w = match server.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let down = thread::Builder::new().name("portfwd-down".into()).stack_size(STACK).spawn(move || {
        let _ = io::copy(&mut server_r, &mut host_w);
        let _ = host_w.flush();
        // SAFETY: shutdown(2) on a descriptor this thread owns; the host sees EOF and passes it on to the Mac's client.
        unsafe { libc::shutdown(host_w.as_raw_fd(), libc::SHUT_WR) };
    });
    let _ = io::copy(&mut host, &mut server_w);
    let _ = server_w.shutdown(Shutdown::Write);
    if let Ok(h) = down {
        let _ = h.join();
    }
    // SAFETY: as above; both directions are over.
    unsafe { libc::shutdown(host.as_raw_fd(), libc::SHUT_RDWR) };
    let _ = server.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Seek;

    fn file_with(bytes: &[u8]) -> File {
        let mut f = tempfile();
        f.write_all(bytes).unwrap();
        f.rewind().unwrap();
        f
    }

    fn tempfile() -> File {
        let p = std::env::temp_dir().join(format!("portfwd-{}-{}", std::process::id(), rand_suffix()));
        let f = std::fs::OpenOptions::new().read(true).write(true).create_new(true).open(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        f
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn a_forwarded_connection_reaches_the_vm_loopback_server_and_ends_cleanly() {
        use std::net::TcpListener;
        use std::os::fd::OwnedFd;
        use std::os::unix::net::UnixStream;
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).unwrap();
            s.write_all(&buf).unwrap();
            s.write_all(b" back").unwrap();
        });
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.write_all(format!("{port}\nhello").as_bytes()).unwrap();
        let t = thread::spawn(move || forward_conn(File::from(OwnedFd::from(guest)), 1));
        host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut got = Vec::new();
        let _ = host.read_to_end(&mut got);
        assert_eq!(got, b"hello back");
        server.join().unwrap();
        drop(host); // the Mac's client goes away: the guest side ends too
        t.join().unwrap();
    }

    #[test]
    fn nothing_listening_ends_the_connection_at_once() {
        use std::os::fd::OwnedFd;
        use std::os::unix::net::UnixStream;
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.write_all(format!("{free}\n").as_bytes()).unwrap();
        forward_conn(File::from(OwnedFd::from(guest)), 1);
        let _ = host.set_read_timeout(Some(Duration::from_secs(5))); // (macOS refuses it on a socket already shut down)
        let mut got = Vec::new();
        assert_eq!(host.read_to_end(&mut got).unwrap_or(0), 0);
    }

    #[test]
    fn the_port_line_is_a_port() {
        assert_eq!(read_port_line(&mut file_with(b"3000\nGET /")), Some(3000));
        assert_eq!(read_port_line(&mut file_with(b"65535\n")), Some(65535));
        for bad in [&b"0\n"[..], b"65536\n", b"123456\n", b"80x\n", b"\n", b"8080", b"-1\n", b"127.0.0.1:80\n"] {
            assert_eq!(read_port_line(&mut file_with(bad)), None, "{:?}", String::from_utf8_lossy(bad));
        }
    }
}
