//! The host side of the network permission (SPEC section 8.3, GOVERNANCE INV-N1 to INV-N4).
//!
//! The VM has no network device. The guest proxy asks, over one persistent vsock connection (guest port 1022, opened
//! by [`NetProxy::attach`]), whether it may open `host:port`. This module decides, resolves the name itself, refuses
//! every non-public address, connects, opens a fresh vsock connection to guest port 1025 carrying `N\n`, answers
//! `{"id":N,"ok":true}` and relays bytes (TLS stays end to end: the bytes are copied, never read). Everything the
//! guest sends is untrusted: lines are bounded, names are validated, and nothing here uses an address the guest
//! gave. Never `println!` in this crate (the launcher's stdout belongs to the protocol).
//!
//! The same control connection also carries SERVICES (SPEC 8.6, GOVERNANCE INV-H7): `{"op":"service-open","id":N,
//! "name":"gpu"}`. A service is a loopback endpoint on the host (`--service gpu=127.0.0.1:PORT`) that the LOADER started
//! and handed to this process on its command line. The guest names the service; this module maps the name to the
//! endpoint given at launch, and to nothing else: no address, host name or port from the guest ever reaches a socket
//! call on the service path, and a service can never be reached through a network rule or `net-open`.
//!
//! The app's WINDOWS reach the network through the same proxy (SPEC 8.3 "The app's windows", DEV-APPS C3): the loader
//! asks for the window endpoint ([`NetProxy::serve_window`], stdin op `window-proxy` with a per-run secret) and points the
//! app's partition at it. It is an HTTP `CONNECT` proxy on `127.0.0.1` that only answers a client sending the secret
//! (proxy authentication, which the loader answers for that partition only), and every `CONNECT host:port` goes through
//! the very same rules, name checks, address check, limits, revokes and events as a guest request (the events carry
//! `"window": true`). TLS stays end to end; the bytes are copied, never read.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::{warn, Error, Result};

/// vsock port the guest listens on for the host's persistent network control connection.
pub const NET_CONTROL_PORT: u32 = 1022;
/// vsock port the guest listens on for the data connections (one per proxied TCP connection).
pub const NET_DATA_PORT: u32 = 1025;

/// Connections open or being opened, per app.
pub const MAX_CONNECTIONS: usize = 64;
/// DNS and connect, together.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// No bytes in either direction.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A line from the guest on the control connection.
pub const MAX_LINE: usize = 4096;
/// Rules the launcher keeps (the manifest allows 32 entries).
pub const MAX_RULES: usize = 64;
/// Ports per rule.
pub const MAX_PORTS: usize = 8;
/// Events kept for the parent; older ones are dropped (and counted) past this.
const MAX_EVENTS: usize = 1000;
/// Read timeout of the relay sockets: how often a relay thread looks at the idle clock and the cancel flag.
const POLL: Duration = Duration::from_secs(2);
/// A write that makes no progress for this long ends the connection.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// The services a launcher can be given (`--service NAME=127.0.0.1:PORT`). The guest side has a fixed port for each
/// (`guest/src/netproxy.rs`, SPEC 4): `gpu` is `127.0.0.1:50052`.
pub const KNOWN_SERVICES: [&str; 1] = ["gpu"];
/// Connections open or being opened, per service. A llama.cpp client opens one or two; this is slack.
pub const MAX_SERVICE_CONNECTIONS: usize = 8;
/// One attempt to connect to a service endpoint on the host's loopback.
const SERVICE_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
/// How long a tunnel keeps trying while nothing listens on the endpoint yet. The guest waits 25 s for the answer.
pub const SERVICE_CONNECT_WAIT: Duration = Duration::from_secs(20);
/// Pause between two attempts.
const SERVICE_RETRY: Duration = Duration::from_millis(200);
/// A write to a service that makes no progress for this long ends the connection (a GPU kernel can run for a while).
const SERVICE_WRITE_TIMEOUT: Duration = Duration::from_secs(300);
/// How often a service connection's byte counters are looked at for a `traffic` event.
const SERVICE_TICK: Duration = Duration::from_millis(500);
/// Copy buffer of a service connection (model weights are hundreds of megabytes).
const SERVICE_BUF: usize = 256 * 1024;
/// Copy buffer of a network connection.
const NET_BUF: usize = 32 * 1024;
/// How much the host holds for a network target that has not read it yet (per connection, at most 64 connections).
const NET_QUEUE: usize = 1024 * 1024;

/// Connections of the app's windows open or being opened (DEV-APPS C3), counted apart from the guest's 64 so that
/// neither can starve the other. A browser keeps a few per host in its pool.
pub const MAX_WINDOW_CONNECTIONS: usize = 64;
/// Clients of the window endpoint that have not finished sending their request head yet.
const MAX_WINDOW_PENDING: usize = 32;
/// A window's request head (`CONNECT host:port HTTP/1.1` and its headers).
const MAX_HEAD: usize = 8192;
/// How long a window client may take to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// The user name of the window endpoint's proxy authentication; the password is the per-run secret.
pub const WINDOW_PROXY_USER: &str = "vmapp";
/// Ids of window connections start here, far above any id a guest counts to (the guest numbers its own requests;
/// a collision is still checked) and below 2^53, so the events stay exact in JSON.
const WINDOW_ID_BASE: u64 = 1 << 40;

/// vsock port the guest listens on for forwarded connections (SPEC 8.8 port forwarding): first line `P\n`, then the bytes.
pub const PORTFWD_PORT: u32 = 1026;
/// Ports of one app forwarded at the same time.
pub const MAX_FORWARDS: usize = 16;
/// Forwarded connections open at the same time, per app (all forwards together; a dev server's page opens a few).
pub const MAX_FORWARD_CONNECTIONS: usize = 64;
/// Ids of forwarded connections start here (the window's start at 2^40).
const FORWARD_ID_BASE: u64 = 1 << 41;
/// The same for a service: a server can be busy for a while with a big upload still coming (per connection, at most
/// [`MAX_SERVICE_CONNECTIONS`]).
const SERVICE_QUEUE: usize = 32 * 1024 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------------------
// names and rules
// ---------------------------------------------------------------------------------------------------------

const IP_MESSAGE: &str = "IP addresses are not allowed; use a host name";

/// Name suffixes that mean "this machine or this network".
const LOCAL_TLDS: [&str; 5] = ["localhost", "local", "internal", "localdomain", "lan"];

/// A lower-case ASCII DNS name with at least two labels, the last one not numeric, not a local-network name.
/// Returns the reason when it is not.
pub fn valid_hostname(name: &str) -> std::result::Result<(), &'static str> {
    if name.is_empty() || name.len() > 253 {
        return Err("a host name has 1 to 253 characters");
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.len() < 2 {
        return Err("a host name needs at least two labels (like example.com)");
    }
    for l in &labels {
        let b = l.as_bytes();
        if b.is_empty() || b.len() > 63 {
            return Err("labels have 1 to 63 characters");
        }
        if !b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-') {
            return Err("labels may only use a-z, 0-9 and '-' (international names in their xn-- form)");
        }
        if b.first() == Some(&b'-') || b.last() == Some(&b'-') {
            return Err("labels must not start or end with '-'");
        }
    }
    let last = labels.last().copied().unwrap_or("");
    // A real top-level label starts with a letter; this also keeps every spelling of an IPv4 address (127.1, 0x7f.1) out.
    if !last.as_bytes().first().is_some_and(|c| c.is_ascii_lowercase()) {
        return Err("the last label must start with a letter (a top-level domain)");
    }
    if LOCAL_TLDS.contains(&last) || name == "home.arpa" || name.ends_with(".home.arpa") {
        return Err("names of this machine or of a local network are not allowed");
    }
    Ok(())
}

/// A host name as the guest sent it, made ready for matching: one trailing dot removed, lower-cased. IP literals in
/// any form get their own message.
pub fn normalize_request_host(raw: &str) -> std::result::Result<String, &'static str> {
    if raw.len() > 254 {
        return Err("a host name has 1 to 253 characters");
    }
    let lower = raw.strip_suffix('.').unwrap_or(raw).to_ascii_lowercase();
    if lower.is_empty() {
        return Err("a host name has 1 to 253 characters");
    }
    let last = lower.rsplit('.').next().unwrap_or("");
    if lower.parse::<IpAddr>().is_ok()
        || lower.contains(':')
        || lower.contains('[')
        || (!last.is_empty() && last.bytes().all(|c| c.is_ascii_digit()))
        || last.starts_with("0x")
    {
        return Err(IP_MESSAGE);
    }
    valid_hostname(&lower)?;
    Ok(lower)
}

/// One allowed destination: an exact host, `*.suffix` or `*` (any public host name), and its ports (a list, or `*`: any).
/// A rule only ever names host names: whatever it allows still goes through the address check (`check_addresses`), so `*`
/// is "any public internet host", never the LAN or this Mac.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetRule {
    /// The exact host, or (wildcard) the suffix after `*.`; empty for `*`.
    pub host: String,
    pub wildcard: bool,
    /// `*`: every host name (SPEC 8.3, DEV-APPS C2).
    pub any_host: bool,
    /// The allowed ports; empty when `any_port`.
    pub ports: Vec<u16>,
    /// `:*`: every port 1-65535.
    pub any_port: bool,
}

impl NetRule {
    /// Parses `HOST[:PORT[,PORT]...]` or `HOST:*` (the `--net` flag and the `net-allow` op), where HOST is a name, `*.suffix`
    /// or `*`. Ports default to 443.
    pub fn parse(spec: &str) -> Result<NetRule> {
        let (host_part, ports_part) = match spec.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (spec, None),
        };
        let any_host = host_part == "*";
        let (wildcard, host) = match host_part.strip_prefix("*.") {
            Some(suffix) => (true, suffix),
            None if any_host => (false, ""),
            None => (false, host_part),
        };
        if !any_host {
            valid_hostname(host).map_err(|why| Error::new(format!("network rule '{spec}': {why}")))?;
        }
        if ports_part == Some("*") {
            return Ok(NetRule { host: host.to_string(), wildcard, any_host, ports: vec![], any_port: true });
        }
        let mut ports: Vec<u16> = vec![];
        match ports_part {
            None => ports.push(443),
            Some(p) => {
                for item in p.split(',') {
                    let n: u16 = item
                        .parse()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| Error::new(format!("network rule '{spec}': '{item}' is not a port (1-65535)")))?;
                    if !ports.contains(&n) {
                        ports.push(n);
                    }
                }
            }
        }
        if ports.len() > MAX_PORTS {
            return Err(Error::new(format!("network rule '{spec}': at most {MAX_PORTS} ports")));
        }
        Ok(NetRule { host: host.to_string(), wildcard, any_host, ports, any_port: false })
    }

    /// `api.example.com`, `*.example.com` or `*`: what identifies the rule (one rule per pattern).
    pub fn pattern(&self) -> String {
        if self.any_host {
            "*".to_string()
        } else if self.wildcard {
            format!("*.{}", self.host)
        } else {
            self.host.clone()
        }
    }

    /// The text form `parse` accepts.
    pub fn spec(&self) -> String {
        if self.any_port {
            return format!("{}:*", self.pattern());
        }
        let ports: Vec<String> = self.ports.iter().map(|p| p.to_string()).collect();
        format!("{}:{}", self.pattern(), ports.join(","))
    }

    /// Does this rule allow `host` (already normalised: a valid name, never an address) on `port`? A wildcard covers every
    /// name below the suffix, at any depth, and never the suffix itself; `*` covers every name.
    pub fn matches(&self, host: &str, port: u16) -> bool {
        if !self.any_port && !self.ports.contains(&port) {
            return false;
        }
        if self.any_host {
            return true;
        }
        if !self.wildcard {
            return host == self.host;
        }
        match host.strip_suffix(self.host.as_str()).and_then(|rest| rest.strip_suffix('.')) {
            Some(label) => !label.is_empty(),
            None => false,
        }
    }
}

/// The pattern part of a rule text (`*.example.com:443` -> `*.example.com`), validated like `NetRule::parse`.
pub fn parse_pattern(spec: &str) -> Result<String> {
    let host_part = spec.split_once(':').map_or(spec, |(h, _)| h);
    let rule = NetRule::parse(host_part)?;
    Ok(rule.pattern())
}

// ---------------------------------------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------------------------------------

fn forbidden_v4(a: Ipv4Addr) -> bool {
    let [a0, a1, a2, _] = a.octets();
    a0 == 0 // this network
        || a0 == 10
        || (a0 == 100 && (64..=127).contains(&a1)) // CGNAT
        || a0 == 127
        || (a0 == 169 && a1 == 254) // link-local, cloud metadata
        || (a0 == 172 && (16..=31).contains(&a1))
        || (a0 == 192 && a1 == 0 && a2 == 0) // IETF protocol assignments
        || (a0 == 192 && a1 == 0 && a2 == 2) // TEST-NET-1
        || (a0 == 192 && a1 == 88 && a2 == 99) // 6to4 relay anycast
        || (a0 == 192 && a1 == 168)
        || (a0 == 198 && (a1 == 18 || a1 == 19)) // benchmarking
        || (a0 == 198 && a1 == 51 && a2 == 100) // TEST-NET-2
        || (a0 == 203 && a1 == 0 && a2 == 113) // TEST-NET-3
        || a0 >= 224 // multicast, reserved, broadcast
}

fn v4_from_pair(hi: u16, lo: u16) -> Ipv4Addr {
    Ipv4Addr::new((hi >> 8) as u8, (hi & 0xff) as u8, (lo >> 8) as u8, (lo & 0xff) as u8)
}

fn forbidden_v6(a: Ipv6Addr) -> bool {
    let s = a.segments();
    if a == Ipv6Addr::UNSPECIFIED || a == Ipv6Addr::LOCALHOST {
        return true;
    }
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
    let zeros5 = s[..5].iter().all(|x| *x == 0);
    if zeros5 && s[5] == 0xffff {
        return forbidden_v4(v4_from_pair(s[6], s[7]));
    }
    if zeros5 && s[5] == 0 {
        return true; // ::/96 is deprecated and never a public destination
    }
    if s[0] == 0x64 && s[1] == 0xff9b {
        if s[2..6].iter().all(|x| *x == 0) {
            return forbidden_v4(v4_from_pair(s[6], s[7]));
        }
        if s[2] == 1 {
            return true; // 64:ff9b:1::/48 local-use NAT64
        }
    }
    if s[0] == 0x2002 {
        return forbidden_v4(v4_from_pair(s[1], s[2])); // 6to4
    }
    (s[0] == 0x100 && s[1] == 0 && s[2] == 0 && s[3] == 0) // discard-only 100::/64
        || (s[0] == 0x2001 && s[1] < 0x0200) // 2001::/23 protocol assignments (Teredo, ORCHID, benchmarking...)
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
        || (s[0] >> 8) == 0xff // multicast
}

/// Is this a destination an app must never reach (private, loopback, link-local, CGNAT, unique-local, multicast,
/// reserved, or an IPv4-mapped or embedded one of those)?
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => forbidden_v4(a),
        IpAddr::V6(a) => forbidden_v6(a),
    }
}

/// Checks every address a name resolved to. `Err(reason)` if ANY is forbidden. With `allow_loopback` (tests only),
/// loopback addresses pass; nothing else does.
pub fn check_addresses(host: &str, addrs: &[SocketAddr], allow_loopback: bool) -> std::result::Result<(), String> {
    if addrs.is_empty() {
        return Err(format!("{host} has no addresses"));
    }
    for a in addrs {
        let ip = a.ip().to_canonical();
        if is_forbidden_ip(ip) && !(allow_loopback && ip.is_loopback()) {
            return Err(format!("refused: {host} resolves to {}, a private or local address", a.ip()));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------------------

/// One proxied connection, reported when it closes or is refused (SPEC 5 `{"net":{...}}`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetEvent {
    pub id: u64,
    pub host: String,
    pub port: u16,
    /// The host's decision (rules, addresses, caps); a connect failure after an allow is still `true`.
    pub allowed: bool,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub duration_ms: u64,
    pub reason: Option<String>,
    /// The connection came from one of the app's windows (the window endpoint), not from the guest.
    pub window: bool,
}

impl NetEvent {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "id": self.id, "host": self.host, "port": self.port, "allowed": self.allowed,
            "bytesUp": self.bytes_up, "bytesDown": self.bytes_down, "durationMs": self.duration_ms,
        });
        if let Some(o) = v.as_object_mut() {
            if let Some(r) = &self.reason {
                o.insert("reason".into(), Value::String(r.clone()));
            }
            if self.window {
                o.insert("window".into(), Value::Bool(true));
            }
        }
        v
    }
}

/// A host service an app may reach by name (SPEC 8.6): `NAME=127.0.0.1:PORT`. It comes from the launcher's command
/// line only (`--service`): not from a manifest, a bridge message or the guest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceSpec {
    pub name: String,
    /// Always `127.0.0.1:PORT`.
    pub addr: SocketAddr,
}

impl ServiceSpec {
    /// Parses `NAME=127.0.0.1:PORT`. The name must be one of [`KNOWN_SERVICES`]; the endpoint must be the IPv4 loopback
    /// address written as a literal (no host names, no other address) with a port from 1 to 65535.
    pub fn parse(spec: &str) -> Result<ServiceSpec> {
        let (name, endpoint) = spec
            .split_once('=')
            .ok_or_else(|| Error::new(format!("service '{spec}': expected NAME=127.0.0.1:PORT")))?;
        if !KNOWN_SERVICES.contains(&name) {
            return Err(Error::new(format!("service '{name}' is not known (known: {})", KNOWN_SERVICES.join(", "))));
        }
        let addr: SocketAddr = endpoint
            .parse()
            .map_err(|_| Error::new(format!("service '{name}': '{endpoint}' is not an address like 127.0.0.1:50052")))?;
        match addr {
            SocketAddr::V4(a) if *a.ip() == Ipv4Addr::LOCALHOST && a.port() != 0 => {}
            _ => return Err(Error::new(format!("service '{name}': the endpoint must be 127.0.0.1:PORT (loopback only), not '{endpoint}'"))),
        }
        Ok(ServiceSpec { name: name.to_string(), addr })
    }

    /// The text form `parse` accepts.
    pub fn spec(&self) -> String {
        format!("{}={}", self.name, self.addr)
    }
}

/// Where a service connection is in its life (SPEC 5 `{"service":{...}}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServicePhase {
    /// The tunnel is up.
    Open,
    /// Bytes moved since the last event (cumulative counters).
    Traffic,
    /// The tunnel ended, or was refused.
    Close,
}

impl ServicePhase {
    fn as_str(self) -> &'static str {
        match self {
            ServicePhase::Open => "open",
            ServicePhase::Traffic => "traffic",
            ServicePhase::Close => "close",
        }
    }
}

/// One step in the life of a service connection. Only names and byte counts: the bytes themselves are never read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceEvent {
    pub id: u64,
    pub name: String,
    pub phase: ServicePhase,
    /// The host's decision (the service exists, caps); a connect failure after a yes is still `true`.
    pub allowed: bool,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub duration_ms: u64,
    pub reason: Option<String>,
}

impl ServiceEvent {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "id": self.id, "name": self.name, "phase": self.phase.as_str(), "allowed": self.allowed,
            "bytesUp": self.bytes_up, "bytesDown": self.bytes_down, "durationMs": self.duration_ms,
        });
        if let (Some(r), Some(o)) = (&self.reason, v.as_object_mut()) {
            o.insert("reason".into(), Value::String(r.clone()));
        }
        v
    }
}

/// One step of a port forward (SPEC 5 `{"forward":{...}}`, SPEC 8.8): the listener started (`listen`), one forwarded
/// connection ended (`conn`, with its byte counts), or the forward ended (`stop`). Ports and counts only, never contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForwardEvent {
    /// The connection's id for `conn`; 0 for `listen` and `stop`.
    pub id: u64,
    /// The port in the VM.
    pub port: u16,
    /// The port on the Mac's 127.0.0.1.
    pub host_port: u16,
    pub phase: &'static str,
    /// From the app (the VM's server) to the Mac's client.
    pub bytes_up: u64,
    /// From the Mac's client to the app.
    pub bytes_down: u64,
    pub duration_ms: u64,
    pub reason: Option<String>,
}

impl ForwardEvent {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "id": self.id, "port": self.port, "hostPort": self.host_port, "phase": self.phase,
            "bytesUp": self.bytes_up, "bytesDown": self.bytes_down, "durationMs": self.duration_ms,
        });
        if let (Some(r), Some(o)) = (&self.reason, v.as_object_mut()) {
            o.insert("reason".into(), Value::String(r.clone()));
        }
        v
    }
}

/// A port of the VM forwarded to the Mac's loopback.
struct Forward {
    host_port: u16,
    stop: Arc<AtomicBool>,
    started: Instant,
}

// ---------------------------------------------------------------------------------------------------------
// the proxy
// ---------------------------------------------------------------------------------------------------------

/// Test and developer switches (never passed by the loader, INV-N3).
#[derive(Clone, Debug, Default)]
pub struct NetOptions {
    /// Let loopback addresses (`127/8`, `::1`) through the address check. Nothing else.
    pub allow_loopback: bool,
    /// Answer these names from a table instead of DNS. The answers still go through the address check.
    pub resolve: Vec<(String, IpAddr)>,
    /// How long a service tunnel keeps trying while nothing listens on the service's endpoint yet (the GPU server needs
    /// several seconds to compile its shaders on a cold start, and the app may ask earlier). `None` is
    /// [`SERVICE_CONNECT_WAIT`]; only the unit tests set another value.
    pub service_wait: Option<Duration>,
    /// The guest's connection cannot be half-closed from the host (the libkrun backend, SPEC 8.7): libkrun turns the host's
    /// end-of-file into a reset of the whole connection and keeps its own end open for seconds. So when the target is done
    /// the tunnel is closed in both directions at once, instead of waiting for the guest to close its side. Not set for
    /// Virtualization.framework, whose vsock passes a half-close on.
    pub close_both_on_target_eof: bool,
}

/// Opens a vsock connection to a guest port.
pub type Connector = Arc<dyn Fn(u32) -> Result<OwnedFd> + Send + Sync>;

/// A refusal or failure with the HTTP-ish status the guest proxy shows.
struct Refusal {
    status: u16,
    /// What the Inspector shows (the full story).
    reason: String,
    /// What the app is told, when that must say less than `reason`: the app never learns which address a name
    /// resolved to (a name under a wildcard it was granted could otherwise probe the user's own DNS view).
    guest: Option<String>,
    /// The host's policy said no (rules, addresses, caps) as opposed to a failure after saying yes.
    denied: bool,
}

impl Refusal {
    fn denied(status: u16, reason: impl Into<String>) -> Refusal {
        Refusal { status, reason: reason.into(), guest: None, denied: true }
    }
    fn failed(status: u16, reason: impl Into<String>) -> Refusal {
        Refusal { status, reason: reason.into(), guest: None, denied: false }
    }
}

/// The app's end of a tunnel: the guest's data connection (vsock), or a window's connection to the window endpoint.
enum Peer {
    Vsock(UnixStream),
    Window(TcpStream),
}

impl Peer {
    fn try_clone(&self) -> std::io::Result<Peer> {
        Ok(match self {
            Peer::Vsock(s) => Peer::Vsock(s.try_clone()?),
            Peer::Window(s) => Peer::Window(s.try_clone()?),
        })
    }
    fn shutdown(&self, how: Shutdown) -> std::io::Result<()> {
        match self {
            Peer::Vsock(s) => s.shutdown(how),
            Peer::Window(s) => s.shutdown(how),
        }
    }
    fn set_timeouts(&self, read: Duration, write: Duration) -> std::io::Result<()> {
        match self {
            Peer::Vsock(s) => {
                s.set_read_timeout(Some(read))?;
                s.set_write_timeout(Some(write))
            }
            Peer::Window(s) => {
                s.set_read_timeout(Some(read))?;
                s.set_write_timeout(Some(write))
            }
        }
    }
}

impl Read for Peer {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Peer::Vsock(s) => s.read(buf),
            Peer::Window(s) => s.read(buf),
        }
    }
}

impl Write for Peer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Peer::Vsock(s) => s.write(buf),
            Peer::Window(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Peer::Vsock(s) => s.flush(),
            Peer::Window(s) => s.flush(),
        }
    }
}

/// One open tunnel, as far as revoke and stop need to know.
struct Conn {
    host: String,
    port: u16,
    tcp: TcpStream,
    /// The app's end: the guest's data connection, or the window's connection.
    peer: Peer,
    cancelled: AtomicBool,
    reason: Mutex<Option<String>>,
    bytes_up: AtomicU64,
    bytes_down: AtomicU64,
    started: Instant,
    /// Milliseconds since `started` of the last byte in either direction.
    last_active: AtomicU64,
    /// Some(name) for a service tunnel (SPEC 8.6). Network rules never touch these (a rule change closes the network
    /// connections it no longer allows; a service is closed only by `service_revoke` or the end of the VM).
    service: Option<String>,
    /// How long without a byte ends the tunnel. `None` for a service: a model stays loaded while the user thinks.
    idle_limit: Option<Duration>,
    /// Size of the copy buffer.
    buf_size: usize,
    /// Most bytes from the guest the host holds for a target that is not taking them yet (see [`UpQueue`]).
    queue_cap: usize,
    /// See [`NetOptions::close_both_on_target_eof`].
    close_both_on_target_eof: bool,
}

impl Conn {
    /// Ends the tunnel now: both sockets are shut down, which unblocks the relay threads.
    fn cancel(&self, reason: &str) {
        {
            let mut r = lock(&self.reason);
            if r.is_none() {
                *r = Some(reason.to_string());
            }
        }
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.tcp.shutdown(Shutdown::Both);
        let _ = self.peer.shutdown(Shutdown::Both);
    }

    fn touch(&self) {
        self.last_active.store(self.started.elapsed().as_millis() as u64, Ordering::SeqCst);
    }

    fn idle(&self) -> bool {
        let Some(limit) = self.idle_limit else { return false };
        let now = self.started.elapsed().as_millis() as u64;
        now.saturating_sub(self.last_active.load(Ordering::SeqCst)) >= limit.as_millis() as u64
    }
}

pub struct NetProxy {
    rules: Mutex<Vec<NetRule>>,
    opts: NetOptions,
    connector: Connector,
    /// The control connection's writing half, once attached.
    writer: Mutex<Option<UnixStream>>,
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    /// Connections open or being opened (the cap counts these).
    active: AtomicUsize,
    /// The ids of those connections. The guest numbers its requests itself, so a repeated id is hostile: two
    /// connections under one id would hide one of them from a revoke.
    ids: Mutex<HashSet<u64>>,
    events: Mutex<VecDeque<NetEvent>>,
    dropped: AtomicU64,
    closed: AtomicBool,
    /// The host services this launcher was given (SPEC 8.6). Never changed by the guest.
    services: Mutex<Vec<ServiceSpec>>,
    /// Service connections open or being opened (also counted in `active`).
    service_active: AtomicUsize,
    service_events: Mutex<VecDeque<ServiceEvent>>,
    /// The window endpoint's port, once started (DEV-APPS C3).
    window_port: Mutex<Option<u16>>,
    /// Window connections open or being opened (NOT counted in `active`: the two caps are separate).
    window_active: AtomicUsize,
    /// Window clients still sending their request head.
    window_pending: AtomicUsize,
    next_window_id: AtomicU64,
    /// Port forwards (SPEC 8.8): VM port -> its listener on the Mac.
    forwards: Mutex<HashMap<u16, Forward>>,
    /// Forwarded connections open (NOT counted in `active`).
    forward_active: AtomicUsize,
    next_forward_id: AtomicU64,
    forward_events: Mutex<VecDeque<ForwardEvent>>,
}

/// What a connection slot counts against.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    Net,
    Service,
    Window,
    Forward,
}

/// Releases the connection's slot (count and id) when dropped, on every path.
struct ActiveGuard {
    proxy: Arc<NetProxy>,
    id: u64,
    slot: Slot,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        match self.slot {
            Slot::Window => {
                self.proxy.window_active.fetch_sub(1, Ordering::SeqCst);
            }
            Slot::Forward => {
                self.proxy.forward_active.fetch_sub(1, Ordering::SeqCst);
            }
            Slot::Service => {
                self.proxy.service_active.fetch_sub(1, Ordering::SeqCst);
                self.proxy.active.fetch_sub(1, Ordering::SeqCst);
            }
            Slot::Net => {
                self.proxy.active.fetch_sub(1, Ordering::SeqCst);
            }
        }
        lock(&self.proxy.ids).remove(&self.id);
    }
}

/// Counts a window client that is still sending its request head, for as long as it lives.
struct PendingGuard(Arc<NetProxy>);

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.0.window_pending.fetch_sub(1, Ordering::SeqCst);
    }
}

impl NetProxy {
    pub fn new(rules: Vec<NetRule>, opts: NetOptions, connector: Connector) -> Arc<NetProxy> {
        Self::with_services(rules, vec![], opts, connector)
    }

    /// Like [`new`](Self::new), with the host services the guest may open by name (SPEC 8.6).
    pub fn with_services(rules: Vec<NetRule>, services: Vec<ServiceSpec>, opts: NetOptions, connector: Connector) -> Arc<NetProxy> {
        Arc::new(NetProxy {
            rules: Mutex::new(rules),
            opts,
            connector,
            writer: Mutex::new(None),
            conns: Mutex::new(HashMap::new()),
            ids: Mutex::new(HashSet::new()),
            active: AtomicUsize::new(0),
            events: Mutex::new(VecDeque::new()),
            dropped: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            services: Mutex::new(services),
            service_active: AtomicUsize::new(0),
            service_events: Mutex::new(VecDeque::new()),
            window_port: Mutex::new(None),
            window_active: AtomicUsize::new(0),
            window_pending: AtomicUsize::new(0),
            next_window_id: AtomicU64::new(WINDOW_ID_BASE),
            forwards: Mutex::new(HashMap::new()),
            forward_active: AtomicUsize::new(0),
            next_forward_id: AtomicU64::new(FORWARD_ID_BASE),
            forward_events: Mutex::new(VecDeque::new()),
        })
    }

    /// Is the control connection to the guest open?
    pub fn attached(&self) -> bool {
        lock(&self.writer).is_some()
    }

    /// Takes the control connection (already connected to guest port 1022) and starts serving it.
    pub fn attach(self: &Arc<Self>, ctl: UnixStream) -> Result<()> {
        let mut w = lock(&self.writer);
        if w.is_some() {
            return Ok(());
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::new("the network channel was closed"));
        }
        let reader = ctl.try_clone()?;
        let _ = ctl.set_write_timeout(Some(Duration::from_secs(10)));
        *w = Some(ctl);
        drop(w);
        let me = self.clone();
        thread::Builder::new().name("vmapp-net-ctl".into()).spawn(move || me.serve(reader))?;
        Ok(())
    }

    // ---- rules ----

    /// The current rules (a copy).
    pub fn rules(&self) -> Vec<NetRule> {
        lock(&self.rules).clone()
    }

    /// Adds a rule, replacing the one with the same pattern. A replacement with fewer ports closes the open
    /// connections it no longer allows (the same as a revoke).
    pub fn allow(&self, rule: NetRule) -> Result<()> {
        let snapshot = {
            let mut rules = lock(&self.rules);
            let pattern = rule.pattern();
            if let Some(slot) = rules.iter_mut().find(|r| r.pattern() == pattern) {
                *slot = rule;
            } else if rules.len() >= MAX_RULES {
                return Err(Error::new(format!("at most {MAX_RULES} network rules")));
            } else {
                rules.push(rule);
            }
            rules.clone()
        };
        self.enforce(&snapshot);
        Ok(())
    }

    /// Removes the rule with this pattern, then closes every open connection no remaining rule allows. Returns how
    /// many connections were closed.
    pub fn revoke(&self, pattern: &str) -> usize {
        let remaining = {
            let mut rules = lock(&self.rules);
            rules.retain(|r| r.pattern() != pattern);
            rules.clone()
        };
        self.enforce(&remaining)
    }

    fn enforce(&self, rules: &[NetRule]) -> usize {
        let open: Vec<Arc<Conn>> = lock(&self.conns).values().cloned().collect();
        let mut closed = 0;
        for c in open {
            // A service tunnel is not a network connection: no network rule allows or revokes it.
            if c.service.is_some() {
                continue;
            }
            if !rules.iter().any(|r| r.matches(&c.host, c.port)) {
                c.cancel("revoked");
                closed += 1;
            }
        }
        closed
    }

    fn allowed_by_rules(&self, host: &str, port: u16) -> bool {
        lock(&self.rules).iter().any(|r| r.matches(host, port))
    }

    // ---- events ----

    fn push_event(&self, ev: NetEvent) {
        let mut q = lock(&self.events);
        if q.len() >= MAX_EVENTS {
            q.pop_front();
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
        q.push_back(ev);
    }

    /// Events since the last call, oldest first. When some were dropped, one summary event leads the list.
    pub fn take_events(&self) -> Vec<NetEvent> {
        let mut out: Vec<NetEvent> = vec![];
        let n = self.dropped.swap(0, Ordering::SeqCst);
        if n > 0 {
            out.push(NetEvent {
                id: 0,
                host: "*".into(),
                port: 0,
                allowed: false,
                bytes_up: 0,
                bytes_down: 0,
                duration_ms: 0,
                reason: Some(format!("{n} older network events were dropped")),
                window: false,
            });
        }
        out.extend(lock(&self.events).drain(..));
        out
    }

    // ---- service events (SPEC 8.6) ----

    /// Queues a service event. A `Traffic` event replaces the previous `Traffic` event of the same connection when that is
    /// still the newest one, so a busy tunnel cannot push the `Close` of another one out of the bounded queue.
    fn push_service_event(&self, ev: ServiceEvent) {
        let mut q = lock(&self.service_events);
        if ev.phase == ServicePhase::Traffic {
            if let Some(last) = q.back_mut() {
                if last.phase == ServicePhase::Traffic && last.id == ev.id {
                    *last = ev;
                    return;
                }
            }
        }
        if q.len() >= MAX_EVENTS {
            q.pop_front();
        }
        q.push_back(ev);
    }

    /// Service events since the last call, oldest first.
    pub fn take_service_events(&self) -> Vec<ServiceEvent> {
        lock(&self.service_events).drain(..).collect()
    }

    // ---- the control connection ----

    /// Reads requests until the guest closes the connection or sends something unusable.
    fn serve(self: Arc<Self>, ctl: UnixStream) {
        let mut reader = BufReader::new(ctl);
        loop {
            let mut buf: Vec<u8> = Vec::new();
            match reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if buf.last() != Some(&b'\n') {
                warn(format_args!("vmapp-vm: network control line too long or cut off; closing the channel"));
                break;
            }
            if self.closed.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(&buf) {
                match v.get("op").and_then(|o| o.as_str()) {
                    Some("net-open") => self.request(&v),
                    Some("service-open") => self.service_request(&v),
                    _ => {}
                }
            }
        }
        self.close_all("network channel closed");
    }

    fn reply(&self, v: &Value) {
        let mut w = lock(&self.writer);
        let ok = match w.as_mut() {
            Some(s) => writeln!(s, "{v}").is_ok(),
            None => false,
        };
        if !ok {
            // The guest cannot hear us any more: nothing can be opened or answered.
            drop(w);
            self.cancel_all("network channel closed");
        }
    }

    fn refuse(&self, id: u64, host: &str, port: u16, r: Refusal, started: Instant) {
        let told = r.guest.as_deref().unwrap_or(&r.reason);
        self.reply(&json!({"id": id, "ok": false, "error": told, "status": r.status}));
        self.push_refusal(id, host, port, r, started, false);
    }

    fn push_refusal(&self, id: u64, host: &str, port: u16, r: Refusal, started: Instant, window: bool) {
        self.push_event(NetEvent {
            id,
            host: host.chars().take(253).collect(),
            port,
            allowed: !r.denied,
            bytes_up: 0,
            bytes_down: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            reason: Some(r.reason),
            window,
        });
    }

    /// Why `host:port` is refused by the rules, or `None` when a rule allows it.
    fn rules_refusal(&self, host: &str, port: u16) -> Option<String> {
        if self.allowed_by_rules(host, port) {
            return None;
        }
        Some(if lock(&self.rules).is_empty() {
            "network not granted".to_string()
        } else {
            format!("not allowed: {host}:{port} is not in this app's network permissions")
        })
    }

    /// One `net-open` request. The cheap checks happen here; resolving and connecting happen on a thread of their own.
    fn request(self: &Arc<Self>, v: &Value) {
        let started = Instant::now();
        let Some(id) = v.get("id").and_then(|x| x.as_u64()) else { return };
        let raw_host = v.get("host").and_then(|x| x.as_str()).unwrap_or("");
        let port = v.get("port").and_then(|x| x.as_u64()).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0);
        let shown: String = raw_host.chars().filter(|c| !c.is_control()).take(253).collect();
        let Some(port) = port else {
            return self.refuse(id, &shown, 0, Refusal::denied(403, "invalid port"), started);
        };
        let host = match normalize_request_host(raw_host) {
            Ok(h) => h,
            Err(why) => return self.refuse(id, &shown, port, Refusal::denied(403, why), started),
        };
        if let Some(why) = self.rules_refusal(&host, port) {
            return self.refuse(id, &host, port, Refusal::denied(403, why), started);
        }
        if !lock(&self.ids).insert(id) {
            return self.refuse(id, &host, port, Refusal::denied(403, "duplicate request id"), started);
        }
        if self.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.active.fetch_sub(1, Ordering::SeqCst);
            lock(&self.ids).remove(&id);
            let why = format!("too many connections (limit {MAX_CONNECTIONS})");
            return self.refuse(id, &host, port, Refusal::denied(503, why), started);
        }
        let guard = ActiveGuard { proxy: self.clone(), id, slot: Slot::Net };
        let me = self.clone();
        let name = host.clone();
        let spawned = thread::Builder::new().name("vmapp-net-conn".into()).spawn(move || {
            let _guard = guard;
            me.run_connection(id, host, port, started);
        });
        if spawned.is_err() {
            // The closure (and its guard) was dropped by the failed spawn.
            self.refuse(id, &name, port, Refusal::failed(502, "the host could not start a connection thread"), started);
        }
    }

    // ---- one connection ----

    fn resolve(&self, host: &str, port: u16) -> std::result::Result<Vec<SocketAddr>, Refusal> {
        if let Some((_, ip)) = self.opts.resolve.iter().find(|(n, _)| n == host) {
            return Ok(vec![SocketAddr::new(*ip, port)]);
        }
        // getaddrinfo cannot be interrupted; a thread of its own keeps the 10 s bound.
        let (tx, rx) = mpsc::channel();
        let name = host.to_string();
        let spawned = thread::Builder::new().name("vmapp-net-dns".into()).spawn(move || {
            let r = (name.as_str(), port).to_socket_addrs().map(|i| i.collect::<Vec<_>>());
            let _ = tx.send(r);
        });
        if spawned.is_err() {
            return Err(Refusal::failed(502, "the host could not start a lookup thread"));
        }
        match rx.recv_timeout(CONNECT_TIMEOUT) {
            Ok(Ok(addrs)) => Ok(addrs),
            Ok(Err(e)) => Err(Refusal::failed(502, format!("DNS lookup for {host} failed: {e}"))),
            Err(_) => Err(Refusal::failed(504, format!("DNS lookup for {host} timed out"))),
        }
    }

    /// Resolves, checks every address, connects, and opens the data connection. On success the target socket and
    /// the guest's data socket are returned.
    fn establish(&self, id: u64, host: &str, port: u16, t0: Instant) -> std::result::Result<(TcpStream, UnixStream), Refusal> {
        let tcp = self.connect_target(host, port, t0)?;
        let fd = (self.connector)(NET_DATA_PORT)
            .map_err(|e| Refusal::failed(502, format!("the host could not open the tunnel: {e}")))?;
        let mut vsock = UnixStream::from(fd);
        let _ = vsock.set_write_timeout(Some(Duration::from_secs(10)));
        vsock
            .write_all(format!("{id}\n").as_bytes())
            .map_err(|e| Refusal::failed(502, format!("the host could not open the tunnel: {e}")))?;
        Ok((tcp, vsock))
    }

    /// Resolves `host`, checks EVERY address it resolved to, and connects to one of those checked addresses (never to a
    /// second lookup). The one place a network connection is opened, for the guest and for the windows alike.
    fn connect_target(&self, host: &str, port: u16, t0: Instant) -> std::result::Result<TcpStream, Refusal> {
        let addrs = self.resolve(host, port)?;
        check_addresses(host, &addrs, self.opts.allow_loopback).map_err(|why| Refusal {
            guest: Some(format!("refused: {host} resolves to a private or local address")),
            ..Refusal::denied(403, why)
        })?;
        // Connect to an address that was checked, never to a second lookup.
        let mut last = String::from("no address");
        let mut tcp = None;
        for a in &addrs {
            let left = CONNECT_TIMEOUT.saturating_sub(t0.elapsed());
            if left.is_zero() {
                return Err(Refusal::failed(504, format!("connecting to {host}:{port} timed out")));
            }
            match TcpStream::connect_timeout(a, left) {
                Ok(s) => {
                    tcp = Some(s);
                    break;
                }
                Err(e) => last = e.to_string(),
            }
        }
        tcp.ok_or_else(|| Refusal::failed(502, format!("connect to {host}:{port} failed: {last}")))
    }

    fn run_connection(self: &Arc<Self>, id: u64, host: String, port: u16, t0: Instant) {
        let (tcp, vsock) = match self.establish(id, &host, port, t0) {
            Ok(p) => p,
            Err(r) => return self.refuse(id, &host, port, r, t0),
        };
        let peer = Peer::Vsock(vsock);
        let conn = match self.network_conn(&host, port, &tcp, &peer) {
            Ok(c) => c,
            Err(e) => return self.refuse(id, &host, port, Refusal::failed(502, format!("socket setup failed: {e}")), t0),
        };
        if let Some(why) = self.register(id, &conn) {
            return self.refuse(id, &host, port, Refusal::denied(403, why), t0);
        }
        self.reply(&json!({"id": id, "ok": true}));
        relay(&conn, tcp, peer);
        self.finish(id, &conn, t0, false);
    }

    /// The tunnel record of a network connection (guest or window): socket timeouts set, the usual limits.
    fn network_conn(&self, host: &str, port: u16, tcp: &TcpStream, peer: &Peer) -> std::io::Result<Arc<Conn>> {
        let _ = tcp.set_nodelay(true);
        tcp.set_read_timeout(Some(POLL))?;
        tcp.set_write_timeout(Some(WRITE_TIMEOUT))?;
        peer.set_timeouts(POLL, WRITE_TIMEOUT)?;
        Ok(Arc::new(Conn {
            host: host.to_string(),
            port,
            tcp: tcp.try_clone()?,
            peer: peer.try_clone()?,
            cancelled: AtomicBool::new(false),
            reason: Mutex::new(None),
            bytes_up: AtomicU64::new(0),
            bytes_down: AtomicU64::new(0),
            started: Instant::now(),
            last_active: AtomicU64::new(0),
            service: None,
            idle_limit: Some(IDLE_TIMEOUT),
            buf_size: NET_BUF,
            queue_cap: NET_QUEUE,
            close_both_on_target_eof: self.opts.close_both_on_target_eof,
        }))
    }

    /// Registers an open network connection so that revokes and stops reach it. A revoke (or a stop) between the first
    /// check and the registration must not be missed: then the tunnel is cancelled and the reason returned.
    fn register(&self, id: u64, conn: &Arc<Conn>) -> Option<&'static str> {
        lock(&self.conns).insert(id, conn.clone());
        let late = if self.closed.load(Ordering::SeqCst) {
            Some("stopped")
        } else if !self.allowed_by_rules(&conn.host, conn.port) {
            Some("revoked")
        } else {
            None
        };
        if let Some(why) = late {
            conn.cancel(why);
            lock(&self.conns).remove(&id);
        }
        late
    }

    /// The tunnel is over: unregisters it and queues its event.
    fn finish(&self, id: u64, conn: &Conn, t0: Instant, window: bool) {
        lock(&self.conns).remove(&id);
        let reason = lock(&conn.reason).clone();
        self.push_event(NetEvent {
            id,
            host: conn.host.clone(),
            port: conn.port,
            allowed: true,
            bytes_up: conn.bytes_up.load(Ordering::SeqCst),
            bytes_down: conn.bytes_down.load(Ordering::SeqCst),
            duration_ms: t0.elapsed().as_millis() as u64,
            reason,
            window,
        });
    }

    /// Refuses everything from now on, closes every open connection and the control connection. Does not wait.
    fn cancel_all(&self, reason: &str) {
        self.closed.store(true, Ordering::SeqCst);
        let open: Vec<Arc<Conn>> = lock(&self.conns).values().cloned().collect();
        for c in open {
            c.cancel(reason);
        }
        if let Some(w) = lock(&self.writer).take() {
            let _ = w.shutdown(Shutdown::Both);
        }
    }

    /// The VM is stopping (or the channel broke): [`cancel_all`](Self::cancel_all), then waits (up to 2 s) until the
    /// events of the closed connections are queued. Idempotent.
    pub fn close_all(&self, reason: &str) {
        self.cancel_all(reason);
        let deadline = Instant::now() + Duration::from_secs(2);
        let open = || self.active.load(Ordering::SeqCst) + self.window_active.load(Ordering::SeqCst) + self.forward_active.load(Ordering::SeqCst);
        while open() > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }

    // ---- services (SPEC 8.6) ----

    /// The host services this launcher was given (a copy).
    pub fn services(&self) -> Vec<ServiceSpec> {
        lock(&self.services).clone()
    }

    /// Takes a service away (the user revoked it, or the loader stopped its server): no new tunnel can open, and every
    /// open one is closed now. Returns how many were closed; each reports itself with a `Close` event a moment later.
    pub fn service_revoke(&self, name: &str) -> usize {
        lock(&self.services).retain(|s| s.name != name);
        let open: Vec<Arc<Conn>> = lock(&self.conns).values().filter(|c| c.service.as_deref() == Some(name)).cloned().collect();
        for c in &open {
            c.cancel("revoked");
        }
        open.len()
    }

    /// The endpoint of a service, looked up by name. This is the only way an address reaches a socket call on the
    /// service path.
    fn service_addr(&self, name: &str) -> Option<SocketAddr> {
        lock(&self.services).iter().find(|s| s.name == name).map(|s| s.addr)
    }

    fn refuse_service(&self, id: u64, name: &str, r: Refusal, started: Instant) {
        let told = r.guest.as_deref().unwrap_or(&r.reason);
        self.reply(&json!({"id": id, "ok": false, "error": told, "status": r.status}));
        self.push_service_event(ServiceEvent {
            id,
            name: name.chars().filter(|c| !c.is_control()).take(32).collect(),
            phase: ServicePhase::Close,
            allowed: !r.denied,
            bytes_up: 0,
            bytes_down: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            reason: Some(r.reason),
        });
    }

    /// One `service-open` request. Only a name this launcher was given a `--service` for is opened; the guest supplies no
    /// address, host or port.
    fn service_request(self: &Arc<Self>, v: &Value) {
        let started = Instant::now();
        let Some(id) = v.get("id").and_then(|x| x.as_u64()) else { return };
        let raw = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        if !KNOWN_SERVICES.contains(&raw) || self.service_addr(raw).is_none() {
            return self.refuse_service(id, raw, Refusal::denied(403, "service not granted"), started);
        }
        if !lock(&self.ids).insert(id) {
            return self.refuse_service(id, raw, Refusal::denied(403, "duplicate request id"), started);
        }
        if self.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.active.fetch_sub(1, Ordering::SeqCst);
            lock(&self.ids).remove(&id);
            let why = format!("too many connections (limit {MAX_CONNECTIONS})");
            return self.refuse_service(id, raw, Refusal::denied(503, why), started);
        }
        if self.service_active.fetch_add(1, Ordering::SeqCst) >= MAX_SERVICE_CONNECTIONS {
            self.service_active.fetch_sub(1, Ordering::SeqCst);
            self.active.fetch_sub(1, Ordering::SeqCst);
            lock(&self.ids).remove(&id);
            let why = format!("too many connections to the {raw} service (limit {MAX_SERVICE_CONNECTIONS})");
            return self.refuse_service(id, raw, Refusal::denied(503, why), started);
        }
        let guard = ActiveGuard { proxy: self.clone(), id, slot: Slot::Service };
        let me = self.clone();
        let name = raw.to_string();
        let spawned = thread::Builder::new().name("vmapp-svc-conn".into()).spawn(move || {
            let _guard = guard;
            me.run_service_connection(id, name, started);
        });
        if spawned.is_err() {
            // The closure (and its guard) was dropped by the failed spawn.
            self.refuse_service(id, raw, Refusal::failed(502, "the host could not start a connection thread"), started);
        }
    }

    /// Connects to the service's loopback endpoint, opens the data connection to the guest, and relays until either side
    /// ends, the service is revoked or the VM stops. Reports `open`, `traffic` (every half second while bytes move) and
    /// `close` events, with byte counts only.
    fn run_service_connection(self: &Arc<Self>, id: u64, name: String, t0: Instant) {
        let Some(addr) = self.service_addr(&name) else {
            return self.refuse_service(id, &name, Refusal::denied(403, "service not granted"), t0);
        };
        // The service path of INV-H7: `addr` is the endpoint given on the command line (127.0.0.1 only, see
        // ServiceSpec::parse), looked up by the service's name. Nothing from the guest is an address. A server that is
        // still starting is waited for; a service that is revoked or a VM that stops ends the wait.
        let wait = self.opts.service_wait.unwrap_or(SERVICE_CONNECT_WAIT);
        let tcp = loop {
            match TcpStream::connect_timeout(&addr, SERVICE_CONNECT_TIMEOUT) {
                Ok(s) => break s,
                Err(e) => {
                    let gone = self.closed.load(Ordering::SeqCst) || self.service_addr(&name).is_none();
                    if gone || t0.elapsed() >= wait {
                        let why = format!("the {name} service is not reachable ({e})");
                        return self.refuse_service(id, &name, Refusal::failed(502, why), t0);
                    }
                    thread::sleep(SERVICE_RETRY);
                }
            }
        };
        let _ = tcp.set_nodelay(true);
        let vsock = (|| -> std::result::Result<UnixStream, Refusal> {
            let fd = (self.connector)(NET_DATA_PORT).map_err(|e| Refusal::failed(502, format!("the host could not open the tunnel: {e}")))?;
            let mut vsock = UnixStream::from(fd);
            let _ = vsock.set_write_timeout(Some(Duration::from_secs(10)));
            vsock
                .write_all(format!("{id}\n").as_bytes())
                .map_err(|e| Refusal::failed(502, format!("the host could not open the tunnel: {e}")))?;
            Ok(vsock)
        })();
        let vsock = match vsock {
            Ok(v) => v,
            Err(r) => return self.refuse_service(id, &name, r, t0),
        };
        let prepared = (|| -> std::io::Result<Arc<Conn>> {
            tcp.set_read_timeout(Some(POLL))?;
            tcp.set_write_timeout(Some(SERVICE_WRITE_TIMEOUT))?;
            vsock.set_read_timeout(Some(POLL))?;
            vsock.set_write_timeout(Some(SERVICE_WRITE_TIMEOUT))?;
            Ok(Arc::new(Conn {
                host: format!("service:{name}"),
                port: addr.port(),
                tcp: tcp.try_clone()?,
                peer: Peer::Vsock(vsock.try_clone()?),
                cancelled: AtomicBool::new(false),
                reason: Mutex::new(None),
                bytes_up: AtomicU64::new(0),
                bytes_down: AtomicU64::new(0),
                started: Instant::now(),
                last_active: AtomicU64::new(0),
                service: Some(name.clone()),
                idle_limit: None,
                buf_size: SERVICE_BUF,
                queue_cap: SERVICE_QUEUE,
                close_both_on_target_eof: self.opts.close_both_on_target_eof,
            }))
        })();
        let conn = match prepared {
            Ok(c) => c,
            Err(e) => return self.refuse_service(id, &name, Refusal::failed(502, format!("socket setup failed: {e}")), t0),
        };
        lock(&self.conns).insert(id, conn.clone());
        // A revoke or a stop between the first check and the registration must not be missed.
        let late = if self.closed.load(Ordering::SeqCst) {
            Some("stopped")
        } else if self.service_addr(&name).is_none() {
            Some("revoked")
        } else {
            None
        };
        if let Some(why) = late {
            conn.cancel(why);
            lock(&self.conns).remove(&id);
            return self.refuse_service(id, &name, Refusal::denied(403, why), t0);
        }
        self.reply(&json!({"id": id, "ok": true}));
        let event = |phase: ServicePhase, conn: &Conn| ServiceEvent {
            id,
            name: name.clone(),
            phase,
            allowed: true,
            bytes_up: conn.bytes_up.load(Ordering::SeqCst),
            bytes_down: conn.bytes_down.load(Ordering::SeqCst),
            duration_ms: t0.elapsed().as_millis() as u64,
            reason: if phase == ServicePhase::Close { lock(&conn.reason).clone() } else { None },
        };
        self.push_service_event(event(ServicePhase::Open, &conn));
        let done = Arc::new(AtomicBool::new(false));
        let ticker = {
            let (me, conn, done, name) = (self.clone(), conn.clone(), done.clone(), name.clone());
            thread::Builder::new().name("vmapp-svc-tick".into()).spawn(move || me.tick_service(id, &name, &conn, &done, t0))
        };
        relay(&conn, tcp, Peer::Vsock(vsock));
        done.store(true, Ordering::SeqCst);
        if let Ok(h) = ticker {
            let _ = h.join();
        }
        lock(&self.conns).remove(&id);
        self.push_service_event(event(ServicePhase::Close, &conn));
    }

    /// Looks at a service connection's byte counters until `done` and queues a `traffic` event whenever they changed.
    fn tick_service(&self, id: u64, name: &str, conn: &Conn, done: &AtomicBool, t0: Instant) {
        let mut seen = (0u64, 0u64);
        while !done.load(Ordering::SeqCst) {
            let step = Duration::from_millis(50);
            let mut waited = Duration::ZERO;
            while waited < SERVICE_TICK && !done.load(Ordering::SeqCst) {
                thread::sleep(step);
                waited += step;
            }
            if done.load(Ordering::SeqCst) {
                return;
            }
            let now = (conn.bytes_up.load(Ordering::SeqCst), conn.bytes_down.load(Ordering::SeqCst));
            if now != seen {
                seen = now;
                self.push_service_event(ServiceEvent {
                    id,
                    name: name.to_string(),
                    phase: ServicePhase::Traffic,
                    allowed: true,
                    bytes_up: now.0,
                    bytes_down: now.1,
                    duration_ms: t0.elapsed().as_millis() as u64,
                    reason: None,
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// the window endpoint (SPEC 8.3 "The app's windows", DEV-APPS C3)
// ---------------------------------------------------------------------------------------------------------

impl NetProxy {
    /// Starts the window endpoint, once per launcher: an HTTP `CONNECT` proxy on `127.0.0.1` (a port of the system's
    /// choice, returned) that answers only a client authenticating as [`WINDOW_PROXY_USER`] with `secret`. The loader gives
    /// the secret (stdin, never the command line) and answers the proxy authentication for the app's own partition only.
    pub fn serve_window(self: &Arc<Self>, secret: &str) -> Result<u16> {
        if !(32..=128).contains(&secret.len()) || !secret.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(Error::new("the window endpoint's secret must be 32 to 128 letters and digits"));
        }
        let mut slot = lock(&self.window_port);
        if slot.is_some() {
            return Err(Error::new("the window endpoint is already running"));
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::new("the network channel was closed"));
        }
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = base64(format!("{WINDOW_PROXY_USER}:{secret}").as_bytes());
        let me = self.clone();
        thread::Builder::new().name("vmapp-net-win".into()).spawn(move || me.accept_windows(listener, token))?;
        *slot = Some(port);
        Ok(port)
    }

    /// The window endpoint's port, if it was started.
    pub fn window_port(&self) -> Option<u16> {
        *lock(&self.window_port)
    }

    /// Accepts window clients until the proxy is closed (the VM stops), then drops the listener.
    fn accept_windows(self: Arc<Self>, listener: TcpListener, token: String) {
        use std::os::fd::AsRawFd;
        let token: Arc<str> = token.into();
        while !self.closed.load(Ordering::SeqCst) {
            let mut p = libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: `p` is a valid pollfd for the listener, which outlives the call; the count is 1.
            if unsafe { libc::poll(&mut p, 1, 200) } <= 0 {
                continue;
            }
            let client = match listener.accept() {
                Ok((c, _)) => c,
                Err(_) => continue,
            };
            if self.window_pending.fetch_add(1, Ordering::SeqCst) >= MAX_WINDOW_PENDING {
                self.window_pending.fetch_sub(1, Ordering::SeqCst);
                continue; // dropped, so closed
            }
            let pending = PendingGuard(self.clone());
            let (me, token) = (self.clone(), token.clone());
            // A failed spawn drops the closure: the client is closed and the pending count released.
            let _ = thread::Builder::new().name("vmapp-net-wcli".into()).spawn(move || me.window_client(client, &token, pending));
        }
    }

    /// One client of the window endpoint: its request head, the authentication, then the same decision as for a guest
    /// request (names, rules, limits, addresses), and the tunnel. Every outcome after the authentication is an event.
    fn window_client(self: &Arc<Self>, mut client: TcpStream, token: &str, pending: PendingGuard) {
        let started = Instant::now();
        // an accepted socket inherits the listener's non-blocking mode on macOS
        let _ = client.set_nonblocking(false);
        let _ = client.set_read_timeout(Some(HEAD_TIMEOUT));
        let _ = client.set_write_timeout(Some(Duration::from_secs(10)));
        let head = read_head(&mut client);
        drop(pending);
        let Some(req) = head.as_deref().and_then(parse_head) else {
            return answer(&mut client, 400, "", "bad request");
        };
        if !auth_matches(req.auth.as_deref(), token) {
            // Not the app's window (or its first attempt, before the browser sends the credentials): no event.
            return answer(&mut client, 407, "Proxy-Authenticate: Basic realm=\"vmapp\"\r\n", "");
        }
        let id = self.next_window_id.fetch_add(1, Ordering::SeqCst);
        if !req.method.eq_ignore_ascii_case("CONNECT") {
            let (host, port) = plain_target(&req.target);
            let r = Refusal::denied(405, "a window may only open https and wss connections (CONNECT)");
            return self.refuse_window(&mut client, id, &host, port, r, started);
        }
        let Some((raw_host, port)) = split_target(&req.target) else {
            let shown: String = req.target.chars().filter(|c| !c.is_control()).take(253).collect();
            return self.refuse_window(&mut client, id, &shown, 0, Refusal::denied(400, "invalid CONNECT target"), started);
        };
        let host = match normalize_request_host(raw_host) {
            Ok(h) => h,
            Err(why) => {
                let shown: String = raw_host.chars().filter(|c| !c.is_control()).take(253).collect();
                return self.refuse_window(&mut client, id, &shown, port, Refusal::denied(403, why), started);
            }
        };
        if let Some(why) = self.rules_refusal(&host, port) {
            return self.refuse_window(&mut client, id, &host, port, Refusal::denied(403, why), started);
        }
        if self.closed.load(Ordering::SeqCst) {
            return self.refuse_window(&mut client, id, &host, port, Refusal::denied(403, "stopped"), started);
        }
        // the id must be unique among the open connections (the guest picks its own ids)
        let mut id = id;
        while !lock(&self.ids).insert(id) {
            id = self.next_window_id.fetch_add(1, Ordering::SeqCst);
        }
        if self.window_active.fetch_add(1, Ordering::SeqCst) >= MAX_WINDOW_CONNECTIONS {
            self.window_active.fetch_sub(1, Ordering::SeqCst);
            lock(&self.ids).remove(&id);
            let why = format!("too many window connections (limit {MAX_WINDOW_CONNECTIONS})");
            return self.refuse_window(&mut client, id, &host, port, Refusal::denied(503, why), started);
        }
        let _guard = ActiveGuard { proxy: self.clone(), id, slot: Slot::Window };
        let tcp = match self.connect_target(&host, port, started) {
            Ok(t) => t,
            Err(r) => return self.refuse_window(&mut client, id, &host, port, r, started),
        };
        let mut peer = Peer::Window(client);
        let conn = match self.network_conn(&host, port, &tcp, &peer) {
            Ok(c) => c,
            Err(e) => return self.refuse_window(&mut peer, id, &host, port, Refusal::failed(502, format!("socket setup failed: {e}")), started),
        };
        if let Some(why) = self.register(id, &conn) {
            return self.push_refusal(id, &host, port, Refusal::denied(403, why), started, true);
        }
        if let Err(e) = peer.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n") {
            conn.cancel(&format!("write failed: {e}"));
        }
        relay(&conn, tcp, peer);
        self.finish(id, &conn, started, true);
    }

    fn refuse_window(&self, w: &mut impl Write, id: u64, host: &str, port: u16, r: Refusal, started: Instant) {
        answer(w, r.status, "", r.guest.as_deref().unwrap_or(&r.reason));
        self.push_refusal(id, host, port, r, started, true);
    }
}

// ---------------------------------------------------------------------------------------------------------
// port forwarding (SPEC 8.8, DEV-APPS C4)
// ---------------------------------------------------------------------------------------------------------

impl NetProxy {
    /// Forwards the VM's `port` to the Mac's loopback: listens on `127.0.0.1:port` when that is free, otherwise on a port the
    /// system picks, and carries every connection to the guest (vsock [`PORTFWD_PORT`]), which connects to its own
    /// `127.0.0.1:port`. Returns the Mac's port. A port already forwarded returns its Mac port. The caller (hostlib) checks
    /// the user's grant; this only enforces the limits.
    pub fn forward(self: &Arc<Self>, port: u16) -> Result<u16> {
        if port == 0 {
            return Err(Error::new("port-forward: the port must be 1 to 65535"));
        }
        let mut forwards = lock(&self.forwards);
        if let Some(f) = forwards.get(&port) {
            return Ok(f.host_port);
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::new("the VM is stopping"));
        }
        if forwards.len() >= MAX_FORWARDS {
            return Err(Error::new(format!("port-forward: at most {MAX_FORWARDS} forwarded ports")));
        }
        let listener = match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))) {
            Ok(l) => l,
            Err(_) => TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?,
        };
        listener.set_nonblocking(true)?;
        let host_port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let (me, flag) = (self.clone(), stop.clone());
        thread::Builder::new().name("vmapp-portfwd".into()).spawn(move || me.accept_forwarded(listener, port, host_port, flag))?;
        forwards.insert(port, Forward { host_port, stop, started: Instant::now() });
        drop(forwards);
        self.push_forward_event(ForwardEvent { id: 0, port, host_port, phase: "listen", bytes_up: 0, bytes_down: 0, duration_ms: 0, reason: None });
        Ok(host_port)
    }

    /// Stops forwarding `port`: the listener closes and its open connections are closed now. Returns how many were closed.
    pub fn forward_close(&self, port: u16, reason: &str) -> usize {
        let Some(f) = lock(&self.forwards).remove(&port) else { return 0 };
        f.stop.store(true, Ordering::SeqCst);
        let tag = forward_tag(port);
        let open: Vec<Arc<Conn>> = lock(&self.conns).values().filter(|c| c.service.as_deref() == Some(tag.as_str())).cloned().collect();
        for c in &open {
            c.cancel(reason);
        }
        self.push_forward_event(ForwardEvent {
            id: 0,
            port,
            host_port: f.host_port,
            phase: "stop",
            bytes_up: 0,
            bytes_down: 0,
            duration_ms: f.started.elapsed().as_millis() as u64,
            reason: Some(reason.to_string()),
        });
        open.len()
    }

    /// The forwarded ports: (VM port, Mac port).
    pub fn forwards(&self) -> Vec<(u16, u16)> {
        let mut v: Vec<(u16, u16)> = lock(&self.forwards).iter().map(|(p, f)| (*p, f.host_port)).collect();
        v.sort_unstable();
        v
    }

    fn push_forward_event(&self, ev: ForwardEvent) {
        let mut q = lock(&self.forward_events);
        if q.len() >= MAX_EVENTS {
            q.pop_front();
        }
        q.push_back(ev);
    }

    /// Forward events since the last call, oldest first.
    pub fn take_forward_events(&self) -> Vec<ForwardEvent> {
        lock(&self.forward_events).drain(..).collect()
    }

    fn accept_forwarded(self: Arc<Self>, listener: TcpListener, port: u16, host_port: u16, stop: Arc<AtomicBool>) {
        use std::os::fd::AsRawFd;
        while !stop.load(Ordering::SeqCst) && !self.closed.load(Ordering::SeqCst) {
            let mut p = libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: `p` is a valid pollfd for the listener, which outlives the call; the count is 1.
            if unsafe { libc::poll(&mut p, 1, 200) } <= 0 {
                continue;
            }
            let Ok((client, _)) = listener.accept() else { continue };
            if self.forward_active.fetch_add(1, Ordering::SeqCst) >= MAX_FORWARD_CONNECTIONS {
                self.forward_active.fetch_sub(1, Ordering::SeqCst);
                let why = format!("too many forwarded connections (limit {MAX_FORWARD_CONNECTIONS})");
                self.push_forward_event(ForwardEvent { id: 0, port, host_port, phase: "conn", bytes_up: 0, bytes_down: 0, duration_ms: 0, reason: Some(why) });
                continue; // dropped, so closed
            }
            let mut id = self.next_forward_id.fetch_add(1, Ordering::SeqCst);
            while !lock(&self.ids).insert(id) {
                id = self.next_forward_id.fetch_add(1, Ordering::SeqCst);
            }
            let guard = ActiveGuard { proxy: self.clone(), id, slot: Slot::Forward };
            let me = self.clone();
            let _ = thread::Builder::new().name("vmapp-portfwd-conn".into()).spawn(move || {
                let _guard = guard;
                me.run_forwarded(id, client, port, host_port);
            });
        }
    }

    /// One connection of the Mac to a forwarded port: the data connection to the guest, then the relay.
    fn run_forwarded(self: &Arc<Self>, id: u64, client: TcpStream, port: u16, host_port: u16) {
        let t0 = Instant::now();
        let ended = |reason: String| ForwardEvent { id, port, host_port, phase: "conn", bytes_up: 0, bytes_down: 0, duration_ms: t0.elapsed().as_millis() as u64, reason: Some(reason) };
        let _ = client.set_nonblocking(false);
        let _ = client.set_nodelay(true);
        let vsock = (|| -> std::result::Result<UnixStream, String> {
            let fd = (self.connector)(PORTFWD_PORT).map_err(|e| format!("the host could not open the tunnel: {e}"))?;
            let mut vsock = UnixStream::from(fd);
            vsock.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
            vsock.write_all(format!("{port}\n").as_bytes()).map_err(|e| format!("the host could not open the tunnel: {e}"))?;
            Ok(vsock)
        })();
        let vsock = match vsock {
            Ok(v) => v,
            Err(why) => return self.push_forward_event(ended(why)),
        };
        let prepared = (|| -> std::io::Result<Arc<Conn>> {
            client.set_read_timeout(Some(POLL))?;
            client.set_write_timeout(Some(WRITE_TIMEOUT))?;
            vsock.set_read_timeout(Some(POLL))?;
            vsock.set_write_timeout(Some(WRITE_TIMEOUT))?;
            Ok(Arc::new(Conn {
                host: forward_tag(port),
                port,
                tcp: client.try_clone()?,
                peer: Peer::Vsock(vsock.try_clone()?),
                cancelled: AtomicBool::new(false),
                reason: Mutex::new(None),
                bytes_up: AtomicU64::new(0),
                bytes_down: AtomicU64::new(0),
                started: Instant::now(),
                last_active: AtomicU64::new(0),
                // not a network connection: no network rule touches it (enforce); only forward_close and the stop do
                service: Some(forward_tag(port)),
                idle_limit: None,
                buf_size: NET_BUF,
                queue_cap: NET_QUEUE,
                close_both_on_target_eof: self.opts.close_both_on_target_eof,
            }))
        })();
        let conn = match prepared {
            Ok(c) => c,
            Err(e) => return self.push_forward_event(ended(format!("socket setup failed: {e}"))),
        };
        lock(&self.conns).insert(id, conn.clone());
        // a close or a stop between the accept and the registration must not be missed
        let gone = self.closed.load(Ordering::SeqCst) || !lock(&self.forwards).contains_key(&port);
        if gone {
            conn.cancel("stopped");
        } else {
            relay(&conn, client, Peer::Vsock(vsock));
        }
        lock(&self.conns).remove(&id);
        self.push_forward_event(ForwardEvent {
            id,
            port,
            host_port,
            phase: "conn",
            bytes_up: conn.bytes_up.load(Ordering::SeqCst),
            bytes_down: conn.bytes_down.load(Ordering::SeqCst),
            duration_ms: t0.elapsed().as_millis() as u64,
            reason: lock(&conn.reason).clone(),
        });
    }
}

/// How a forwarded connection is marked in the connection table (never a host name: no network rule can match it).
fn forward_tag(port: u16) -> String {
    format!("port:{port}")
}

/// A window's request, as far as the endpoint reads it.
#[derive(Debug, PartialEq, Eq)]
struct WindowRequest {
    method: String,
    /// `host:port` for CONNECT.
    target: String,
    /// The `Proxy-Authorization` value, if sent.
    auth: Option<String>,
}

/// Reads a request head up to its blank line (without it), or `None` when it is too long, cut off or slow. A client sends
/// nothing after the head before the answer (a CONNECT waits for "200"), so bytes after it are refused too.
fn read_head(s: &mut TcpStream) -> Option<Vec<u8>> {
    let deadline = Instant::now() + HEAD_TIMEOUT;
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        match s.read(&mut chunk) {
            Ok(0) => return None,
            Ok(n) => buf.extend_from_slice(chunk.get(..n).unwrap_or(&[])),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            if end + 4 != buf.len() {
                return None;
            }
            buf.truncate(end);
            return Some(buf);
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
}

/// Parses a request head: the request line and the one header the endpoint reads. `None` when it is not HTTP/1.x, a header
/// line has no colon, or `Proxy-Authorization` comes twice.
fn parse_head(head: &[u8]) -> Option<WindowRequest> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some() || method.is_empty() || target.is_empty() || !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut auth = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("proxy-authorization") {
            if auth.is_some() {
                return None;
            }
            auth = Some(value.trim().to_string());
        }
    }
    Some(WindowRequest { method: method.to_string(), target: target.to_string(), auth })
}

/// Is `auth` (a `Proxy-Authorization` value) `Basic <token>`? The token is compared in constant time.
fn auth_matches(auth: Option<&str>, token: &str) -> bool {
    let Some((scheme, given)) = auth.and_then(|a| a.split_once(' ')) else { return false };
    let (a, b) = (given.trim().as_bytes(), token.as_bytes());
    scheme.eq_ignore_ascii_case("basic") && a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `host` and `port` of a CONNECT target. The host is checked afterwards like a guest's (an IP literal, bracketed or not,
/// is refused there).
fn split_target(target: &str) -> Option<(&str, u16)> {
    let (host, port) = target.rsplit_once(':')?;
    let port = port.parse::<u16>().ok().filter(|p| *p > 0)?;
    Some((host, port))
}

/// Host and port of a plain proxy request (`GET http://host:port/path`), for the event only.
fn plain_target(target: &str) -> (String, u16) {
    let rest = target.split_once("://").map_or(target, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().unwrap_or(0)),
        None => (authority, 80),
    };
    (host.chars().filter(|c| !c.is_control()).take(253).collect(), port)
}

/// Writes a short HTTP answer and nothing else (the connection is closed afterwards).
fn answer(w: &mut impl Write, status: u16, headers: &str, body: &str) {
    let phrase = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        407 => "Proxy Authentication Required",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let _ = write!(
        w,
        "HTTP/1.1 {status} {phrase}\r\n{headers}Content-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = w.flush();
}

/// Standard base64 with padding (the Basic credentials).
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let byte = |i: usize| u32::from(c.get(i).copied().unwrap_or(0));
        let n = (byte(0) << 16) | (byte(1) << 8) | byte(2);
        for i in 0..4 {
            if i <= c.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Bytes read from the guest that the target has not taken yet (the "up" direction, guest -> target).
///
/// Why there is a queue: the virtio socket device behind `vsock` serves both directions of every connection from one
/// place, and it stops serving all of them while it waits for the host to take what the guest sent. If the thread that
/// reads the guest's bytes also writes them to the target, a target that is itself waiting for the host to read its answer
/// (an echo server, or any peer that answers while still being sent to) leaves the host's two threads waiting on each
/// other through the device, and the VM's vsock stops answering, the bridge to the core included. So the guest's bytes are
/// always read, held here up to `cap` bytes, and written to the target by another thread.
struct UpQueue {
    state: Mutex<UpState>,
    changed: std::sync::Condvar,
    cap: usize,
}

#[derive(Default)]
struct UpState {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    /// The guest sent EOF: no more chunks will come.
    finished: bool,
    /// The tunnel is over: drop everything.
    aborted: bool,
}

impl UpQueue {
    fn new(cap: usize) -> UpQueue {
        UpQueue { state: Mutex::new(UpState::default()), changed: std::sync::Condvar::new(), cap }
    }

    /// Adds a chunk, waiting while the queue is full. Returns false when the tunnel is over.
    fn push(&self, chunk: Vec<u8>, conn: &Conn) -> bool {
        let mut s = lock(&self.state);
        while s.bytes >= self.cap && !s.aborted && !conn.cancelled.load(Ordering::SeqCst) {
            s = self.changed.wait_timeout(s, Duration::from_millis(250)).unwrap_or_else(|e| e.into_inner()).0;
        }
        if s.aborted || conn.cancelled.load(Ordering::SeqCst) {
            return false;
        }
        s.bytes += chunk.len();
        s.chunks.push_back(chunk);
        self.changed.notify_all();
        true
    }

    /// The oldest chunk, waiting for one. `None` when the guest is done and everything was taken, or the tunnel is over.
    fn pop(&self, conn: &Conn) -> Option<Vec<u8>> {
        let mut s = lock(&self.state);
        loop {
            if s.aborted || conn.cancelled.load(Ordering::SeqCst) {
                return None;
            }
            if let Some(c) = s.chunks.pop_front() {
                s.bytes -= c.len();
                self.changed.notify_all();
                return Some(c);
            }
            if s.finished {
                return None;
            }
            s = self.changed.wait_timeout(s, Duration::from_millis(250)).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    fn finish(&self) {
        lock(&self.state).finished = true;
        self.changed.notify_all();
    }

    fn abort(&self) {
        let mut s = lock(&self.state);
        s.aborted = true;
        s.chunks.clear();
        s.bytes = 0;
        self.changed.notify_all();
    }
}

/// Copies bytes both ways between the target (`tcp`) and the app's end (`peer`: the guest, or a window) until both sides
/// are done, the tunnel is cancelled or it has been idle for its limit. A half-close is passed on. The app's bytes ("up")
/// pass through an [`UpQueue`]; the target's ("down") are copied by this thread.
fn relay(conn: &Arc<Conn>, tcp: TcpStream, peer: Peer) {
    let (Ok(mut tcp_r), Ok(mut peer_w), Ok(mut peer_r), Ok(mut tcp_w)) =
        (tcp.try_clone(), peer.try_clone(), peer.try_clone(), tcp.try_clone())
    else {
        conn.cancel("socket setup failed");
        return;
    };
    let queue = Arc::new(UpQueue::new(conn.queue_cap));
    // app -> queue
    let (me, q) = (conn.clone(), queue.clone());
    let reader = thread::Builder::new().name("vmapp-net-up".into()).spawn(move || pump_in(&me, &mut peer_r, &q));
    // queue -> target
    let (me, q) = (conn.clone(), queue.clone());
    let writer = thread::Builder::new().name("vmapp-net-out".into()).spawn(move || pump_out(&me, &q, &mut tcp_w));
    // target -> app ("down")
    let how = if conn.close_both_on_target_eof { Shutdown::Both } else { Shutdown::Write };
    pump(conn, &mut tcp_r, &mut peer_w, &conn.bytes_down, |v: &Peer| {
        let _ = v.shutdown(how);
    });
    match (reader, writer) {
        (Ok(r), Ok(w)) => {
            let _ = r.join();
            let _ = w.join();
        }
        (r, w) => {
            conn.cancel("could not start the relay");
            queue.abort();
            if let Ok(h) = r {
                let _ = h.join();
            }
            if let Ok(h) = w {
                let _ = h.join();
            }
        }
    }
    let _ = conn.tcp.shutdown(Shutdown::Both);
    let _ = conn.peer.shutdown(Shutdown::Both);
}

/// App -> queue: always reading, so the device behind the guest's socket is never left waiting (see [`UpQueue`]).
fn pump_in(conn: &Conn, from: &mut Peer, queue: &UpQueue) {
    let mut buf = vec![0u8; conn.buf_size.max(1024)];
    loop {
        if conn.cancelled.load(Ordering::SeqCst) {
            queue.abort();
            return;
        }
        match from.read(&mut buf) {
            Ok(0) => {
                queue.finish();
                return;
            }
            Ok(n) => {
                if !queue.push(buf.get(..n).unwrap_or(&[]).to_vec(), conn) {
                    return;
                }
                conn.touch();
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if conn.idle() {
                    conn.cancel("idle timeout");
                    queue.abort();
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                // Cancelled by us (the sockets were shut down; the reason is already set) or the guest vanished.
                conn.cancel(&format!("connection error: {e}"));
                queue.abort();
                return;
            }
        }
    }
}

/// Queue -> target. When the guest is done and everything was written, the half-close is passed on.
fn pump_out(conn: &Conn, queue: &UpQueue, to: &mut TcpStream) {
    while let Some(chunk) = queue.pop(conn) {
        if let Err(e) = to.write_all(&chunk) {
            conn.cancel(&format!("write failed: {e}"));
            queue.abort();
            return;
        }
        conn.bytes_up.fetch_add(chunk.len() as u64, Ordering::SeqCst);
        conn.touch();
    }
    if !conn.cancelled.load(Ordering::SeqCst) {
        let _ = to.shutdown(Shutdown::Write);
    }
}

fn pump<R: Read, W: Write>(conn: &Conn, from: &mut R, to: &mut W, bytes: &AtomicU64, finish: impl Fn(&W)) {
    let mut buf = vec![0u8; conn.buf_size.max(1024)];
    loop {
        if conn.cancelled.load(Ordering::SeqCst) {
            return;
        }
        match from.read(&mut buf) {
            Ok(0) => {
                finish(to);
                return;
            }
            Ok(n) => {
                if let Err(e) = to.write_all(buf.get(..n).unwrap_or(&[])) {
                    conn.cancel(&format!("write failed: {e}"));
                    return;
                }
                bytes.fetch_add(n as u64, Ordering::SeqCst);
                conn.touch();
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if conn.idle() {
                    conn.cancel("idle timeout");
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                // Cancelled by us (shutdown of the sockets; the reason is already set then) or the peer reset or
                // vanished (the guest powered off): either way the tunnel is over.
                conn.cancel(&format!("connection error: {e}"));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(s: &str) -> NetRule {
        NetRule::parse(s).unwrap()
    }

    #[test]
    fn rules_parse() {
        let r = rule("api.example.com");
        assert_eq!((r.host.as_str(), r.wildcard, r.ports.clone()), ("api.example.com", false, vec![443]));
        let r = rule("*.example.com:443,8443,443");
        assert_eq!((r.host.as_str(), r.wildcard, r.ports.clone()), ("example.com", true, vec![443, 8443]));
        assert_eq!(r.pattern(), "*.example.com");
        assert_eq!(r.spec(), "*.example.com:443,8443");
        assert_eq!(NetRule::parse(&r.spec()).unwrap(), r);
        assert_eq!(parse_pattern("*.example.com:80").unwrap(), "*.example.com");
        assert_eq!(parse_pattern("example.com").unwrap(), "example.com");
    }

    #[test]
    fn rules_reject_unsafe_hosts() {
        for bad in [
            "",
            "**",
            "*:",
            "*:0",
            "*:**",
            "*.*",
            "*.com",
            "*.",
            "localhost",
            "a.localhost",
            "printer.local",
            "svc.internal",
            "router.lan",
            "x.home.arpa",
            "10.0.0.1",
            "127.0.0.1",
            "1.2.3.4:443",
            "[::1]",
            "::1",
            "0x7f.1",
            "0x7f.0x0.0x0.0x1",
            "127.0.0.1.1abc",
            "example.com.:443",
            "Example.com",
            "exa mple.com",
            "-a.example.com",
            "a-.example.com",
            "a..example.com",
            "ex_ample.com",
            "münchen.de",
            "foo*.example.com",
            "a.*.example.com",
            "example",
            "example.com:",
            "example.com:0",
            "example.com:65536",
            "example.com:80,x",
            "example.com:1,2,3,4,5,6,7,8,9",
        ] {
            assert!(NetRule::parse(bad).is_err(), "should be rejected: {bad:?}");
        }
        assert!(NetRule::parse(&format!("{}.com", "a".repeat(64))).is_err(), "label of 64");
        assert!(NetRule::parse(&format!("{}.com", "a".repeat(63))).is_ok(), "label of 63");
        assert!(NetRule::parse(&format!("{}com", "a.".repeat(130))).is_err(), "name over 253");
        assert!(NetRule::parse(&format!("{}com", "a.".repeat(100))).is_ok(), "name of 203");
    }

    #[test]
    fn rules_any_host_and_any_port() {
        let r = rule("*:*");
        assert!(r.any_host && r.any_port && r.ports.is_empty());
        assert_eq!((r.pattern(), r.spec()), ("*".to_string(), "*:*".to_string()));
        assert_eq!(NetRule::parse(&r.spec()).unwrap(), r);
        for (host, port) in [("example.com", 443), ("a.b.example.org", 22), ("github.com", 9418), ("x.io", 1), ("x.io", 65535)] {
            assert!(r.matches(host, port), "{host}:{port}");
        }
        let r = rule("*");
        assert!(r.any_host && !r.any_port && r.ports == vec![443]);
        assert!(r.matches("example.com", 443) && !r.matches("example.com", 80));
        let r = rule("*:22,443");
        assert!(r.matches("github.com", 22) && r.matches("github.com", 443) && !r.matches("github.com", 80));
        let r = rule("*.example.com:*");
        assert!(r.any_port && !r.any_host && r.matches("a.example.com", 8080) && !r.matches("example.com", 8080) && !r.matches("example.org", 443));
        assert_eq!(r.spec(), "*.example.com:*");
        let r = rule("api.example.com:*");
        assert!(r.matches("api.example.com", 5432) && !r.matches("www.example.com", 5432));
        assert_eq!(parse_pattern("*:*").unwrap(), "*");
        // `*` names hosts, never addresses: the request host is still normalised (no IP literals, no local names) and every
        // answer of the name is still checked (check_addresses), whatever the rules say
        for bad in ["127.0.0.1", "10.1.2.3", "[::1]", "localhost", "router.lan", "printer.local"] {
            assert!(normalize_request_host(bad).is_err(), "{bad}");
        }
        let lan: Vec<SocketAddr> = vec!["192.168.1.10:443".parse().unwrap()];
        assert!(check_addresses("evil.example.com", &lan, false).is_err());
    }

    #[test]
    fn matching_exact_and_wildcard() {
        let exact = rule("api.example.com");
        assert!(exact.matches("api.example.com", 443));
        assert!(!exact.matches("api.example.com", 80), "port");
        assert!(!exact.matches("example.com", 443));
        assert!(!exact.matches("x.api.example.com", 443), "an exact rule has no subdomains");
        assert!(!exact.matches("api.example.com.evil.net", 443));
        assert!(!exact.matches("evilapi.example.com", 443));
        let wild = rule("*.example.com:443,8443");
        assert!(wild.matches("a.example.com", 443));
        assert!(wild.matches("a.b.example.com", 8443), "any depth");
        assert!(!wild.matches("example.com", 443), "not the bare suffix");
        assert!(!wild.matches("badexample.com", 443), "suffix must start at a label boundary");
        assert!(!wild.matches("a.example.com.evil.net", 443));
        assert!(!wild.matches(".example.com", 443), "empty label");
        assert!(!wild.matches("a.example.com", 80));
    }

    /// The same vectors hostlib/network.js is tested with (tests/unit/network.test.js): the two must agree.
    #[test]
    fn shared_vectors_agree_with_hostlib() {
        let v: Value = serde_json::from_str(include_str!("../../tests/net/vectors.json")).unwrap();
        for p in v["validPatterns"].as_array().unwrap() {
            let p = p.as_str().unwrap();
            assert!(NetRule::parse(p).is_ok(), "should be valid: {p:?}");
        }
        for p in v["invalidPatterns"].as_array().unwrap() {
            let p = p.as_str().unwrap();
            assert!(NetRule::parse(p).is_err(), "should be invalid: {p:?}");
        }
        for m in v["matching"].as_array().unwrap() {
            let (spec, host, port, want) = (m[0].as_str().unwrap(), m[1].as_str().unwrap(), m[2].as_u64().unwrap() as u16, m[3].as_bool().unwrap());
            assert_eq!(rule(spec).matches(host, port), want, "{spec} vs {host}:{port}");
        }
    }

    #[test]
    fn request_hosts_are_normalised() {
        assert_eq!(normalize_request_host("API.Example.COM.").unwrap(), "api.example.com");
        for ip in ["127.0.0.1", "10.1.2.3", "[::1]", "::1", "2130706433", "0x7f.0.0.1", "127.1", "fe80::1%en0", "0x7f.0x0.0x0.0x1"] {
            assert_eq!(normalize_request_host(ip), Err(IP_MESSAGE), "{ip}");
        }
        let long = "a".repeat(300);
        for bad in ["", ".", "localhost", "a b.com", "evil.com\r\nX: y", long.as_str()] {
            assert!(normalize_request_host(bad).is_err(), "{bad:?}");
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn forbidden_addresses() {
        for bad in [
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.0.1",
            "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.88.99.1", "192.168.1.1",
            "198.18.0.1", "198.19.255.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1",
            "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.0.5", "::ffff:169.254.169.254",
            "::10.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a00:1::1", "100::1",
            "2001::1", "2001:1::1", "2001:db8::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
            "ff00::",
        ] {
            assert!(is_forbidden_ip(ip(bad)), "should be forbidden: {bad}");
        }
        for good in [
            "1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1",
            "192.0.1.1", "192.169.0.1", "198.17.255.255", "198.20.0.1", "203.0.114.1", "223.255.255.255",
            "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2001:200::1", "2001:4860:4860::8888",
            "2606:4700:4700::1111", "2a00:1450:4001::200e", "2620:fe::fe",
        ] {
            assert!(!is_forbidden_ip(ip(good)), "should be allowed: {good}");
        }
    }

    #[test]
    fn address_check_covers_every_answer() {
        let sa = |s: &str| SocketAddr::new(ip(s), 443);
        assert!(check_addresses("a.example.com", &[sa("93.184.216.34")], false).is_ok());
        // one private answer among public ones refuses the whole name (DNS rebinding to the LAN)
        let e = check_addresses("a.example.com", &[sa("93.184.216.34"), sa("192.168.1.10")], false).unwrap_err();
        assert!(e.contains("192.168.1.10") && e.contains("private"), "{e}");
        assert!(check_addresses("a.example.com", &[sa("127.0.0.1")], false).is_err());
        assert!(check_addresses("a.example.com", &[sa("::ffff:127.0.0.1")], false).is_err());
        assert!(check_addresses("a.example.com", &[], false).is_err());
        // the test switch lets loopback through, and only loopback
        assert!(check_addresses("a.example.com", &[sa("127.0.0.1")], true).is_ok());
        assert!(check_addresses("a.example.com", &[sa("::1")], true).is_ok());
        assert!(check_addresses("a.example.com", &[sa("::ffff:127.0.0.1")], true).is_ok());
        assert!(check_addresses("a.example.com", &[sa("192.168.1.10")], true).is_err());
        assert!(check_addresses("a.example.com", &[sa("169.254.169.254")], true).is_err());
        assert!(check_addresses("a.example.com", &[sa("127.0.0.1"), sa("10.0.0.1")], true).is_err());
    }

    // ---- the proxy against a fake guest (socket pairs) and a real local server ----

    use std::net::TcpListener;

    struct Harness {
        proxy: Arc<NetProxy>,
        /// The guest's end of the control connection.
        guest_ctl: BufReader<UnixStream>,
        guest_ctl_w: UnixStream,
        /// Guest ends of the data connections the host opened.
        data_rx: mpsc::Receiver<UnixStream>,
    }

    fn harness(rules: &[&str], loopback: bool) -> Harness {
        harness_with(rules, &[], loopback)
    }

    fn harness_with(rules: &[&str], services: &[&str], loopback: bool) -> Harness {
        harness_full(rules, services, loopback, Duration::ZERO, false)
    }

    /// `service_wait`: how long a service tunnel keeps trying while nothing listens (zero: fail at once, like most tests want).
    /// `both`: `NetOptions::close_both_on_target_eof` (the libkrun backend).
    fn harness_full(rules: &[&str], services: &[&str], loopback: bool, service_wait: Duration, both: bool) -> Harness {
        let (host_end, guest_end) = UnixStream::pair().unwrap();
        let (data_tx, data_rx) = mpsc::channel();
        let data_tx = Mutex::new(data_tx);
        let connector: Connector = Arc::new(move |port| {
            assert_eq!(port, NET_DATA_PORT);
            let (h, g) = UnixStream::pair().unwrap();
            data_tx.lock().unwrap().send(g).unwrap();
            Ok(OwnedFd::from(h))
        });
        let opts = NetOptions {
            allow_loopback: loopback,
            resolve: vec![
                ("test.example.com".into(), ip("127.0.0.1")),
                ("rebind.example.com".into(), ip("192.168.1.10")),
                ("meta.example.com".into(), ip("169.254.169.254")),
            ],
            service_wait: Some(service_wait),
            close_both_on_target_eof: both,
        };
        let specs = services.iter().map(|s| ServiceSpec::parse(s).unwrap()).collect();
        let proxy = NetProxy::with_services(rules.iter().map(|r| rule(r)).collect(), specs, opts, connector);
        proxy.attach(host_end).unwrap();
        let guest_ctl_w = guest_end.try_clone().unwrap();
        guest_end.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        Harness { proxy, guest_ctl: BufReader::new(guest_end), guest_ctl_w, data_rx }
    }

    impl Harness {
        fn open(&mut self, id: u64, host: &str, port: u16) -> Value {
            let line = json!({"op": "net-open", "id": id, "host": host, "port": port});
            writeln!(self.guest_ctl_w, "{line}").unwrap();
            let mut reply = String::new();
            self.guest_ctl.read_line(&mut reply).unwrap();
            serde_json::from_str(&reply).unwrap()
        }

        fn open_service(&mut self, id: u64, name: &str) -> Value {
            let line = json!({"op": "service-open", "id": id, "name": name});
            writeln!(self.guest_ctl_w, "{line}").unwrap();
            let mut reply = String::new();
            self.guest_ctl.read_line(&mut reply).unwrap();
            serde_json::from_str(&reply).unwrap()
        }
    }

    fn wait_service_events(p: &NetProxy, want: impl Fn(&[ServiceEvent]) -> bool) -> Vec<ServiceEvent> {
        let mut all = vec![];
        for _ in 0..300 {
            all.extend(p.take_service_events());
            if want(&all) {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        all
    }

    fn echo_server() -> (u16, thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 1024];
                while let Ok(n) = s.read(&mut buf) {
                    if n == 0 || s.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        });
        (port, h)
    }

    fn wait_events(p: &NetProxy, n: usize) -> Vec<NetEvent> {
        let mut all = vec![];
        for _ in 0..200 {
            all.extend(p.take_events());
            if all.len() >= n {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        all
    }

    #[test]
    fn allowed_tunnel_counts_bytes_and_reports_once() {
        let (port, server) = echo_server();
        let mut h = harness(&[&format!("test.example.com:{port}")], true);
        let r = h.open(1, "TEST.example.com.", port);
        assert_eq!(r, json!({"id": 1, "ok": true}));
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        assert_eq!(&first, b"1\n", "the data connection starts with the request id");
        data.write_all(b"hello").unwrap();
        let mut got = [0u8; 5];
        data.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"hello");
        data.shutdown(Shutdown::Write).unwrap();
        let mut rest = vec![];
        let _ = data.read_to_end(&mut rest);
        let ev = wait_events(&h.proxy, 1);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!((ev[0].host.as_str(), ev[0].port, ev[0].allowed), ("test.example.com", port, true));
        assert_eq!((ev[0].bytes_up, ev[0].bytes_down), (5, 5));
        assert_eq!(ev[0].reason, None);
        let j = ev[0].to_json();
        assert_eq!(j["bytesUp"], 5);
        assert!(j.get("reason").is_none());
        server.join().unwrap();
    }

    /// A server that answers one request and closes at once (an HTTP response with `Connection: close`).
    fn closing_server() -> (u16, thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 16];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"bye");
            }
        });
        (port, h)
    }

    /// The libkrun backend cannot half-close the guest's connection (SPEC 8.7): when the target is done, the tunnel ends and is
    /// reported even though the guest never closes its end. The default keeps the half-close: the report waits for the guest.
    #[test]
    fn target_eof_closes_the_whole_tunnel_when_asked() {
        for both in [true, false] {
            let (port, server) = closing_server();
            let mut h = harness_full(&[&format!("test.example.com:{port}")], &[], true, Duration::ZERO, both);
            assert_eq!(h.open(1, "test.example.com", port)["ok"], true);
            let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let mut first = [0u8; 2];
            data.read_exact(&mut first).unwrap();
            data.write_all(b"req").unwrap();
            let mut got = [0u8; 3];
            data.read_exact(&mut got).unwrap();
            assert_eq!(&got, b"bye");
            // the guest does NOT close its end here
            let mut ev = vec![];
            for _ in 0..40 {
                ev.extend(h.proxy.take_events());
                if !ev.is_empty() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            assert_eq!(!ev.is_empty(), both, "both={both}: {ev:?}");
            drop(data);
            server.join().unwrap();
        }
    }

    #[test]
    fn refusals_are_reported_with_reasons() {
        let mut h = harness(&["test.example.com", "rebind.example.com", "meta.example.com", "*.wild.example.com"], true);
        // not in the rules, wrong port, IP literals, bad names
        let r = h.open(1, "other.example.com", 443);
        assert_eq!(r["ok"], false);
        assert_eq!(r["status"], 403);
        assert!(r["error"].as_str().unwrap().starts_with("not allowed: other.example.com:443"), "{r}");
        assert_eq!(h.open(2, "test.example.com", 80)["status"], 403);
        let r = h.open(3, "127.0.0.1", 443);
        assert!(r["error"].as_str().unwrap().contains("IP addresses"), "{r}");
        assert_eq!(h.open(4, "10.0.0.1", 443)["ok"], false);
        assert_eq!(h.open(5, "wild.example.com", 443)["ok"], false, "bare suffix");
        assert_eq!(h.open(6, "a\u{0}b.example.com", 443)["ok"], false);
        // rules say yes, the address check says no: LAN, link-local metadata (also with the loopback switch on)
        let r = h.open(7, "rebind.example.com", 443);
        assert_eq!(r["status"], 403);
        let told = r["error"].as_str().unwrap();
        assert!(told.contains("resolves to a private or local address"), "{r}");
        assert!(!told.contains("192.168"), "the app is not told which address the name resolved to: {r}");
        assert_eq!(h.open(8, "meta.example.com", 443)["status"], 403);
        let ev = wait_events(&h.proxy, 8);
        assert_eq!(ev.len(), 8, "{ev:?}");
        assert!(ev.iter().all(|e| !e.allowed && e.bytes_up == 0 && e.reason.is_some()), "{ev:?}");
        // ... but the Inspector gets the full story
        let rebind = ev.iter().find(|e| e.host == "rebind.example.com").unwrap();
        assert!(rebind.reason.as_deref().unwrap().contains("192.168.1.10"), "{rebind:?}");
        assert!(h.data_rx.try_recv().is_err(), "no data connection was opened for a refusal");
    }

    #[test]
    fn loopback_is_refused_without_the_test_switch() {
        let (port, _server) = echo_server();
        let mut h = harness(&[&format!("test.example.com:{port}")], false);
        let r = h.open(1, "test.example.com", port);
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("private or local address"), "{r}");
        assert!(!r["error"].as_str().unwrap().contains("127.0.0.1"), "{r}");
        let ev = wait_events(&h.proxy, 1);
        assert!(!ev[0].allowed);
        assert!(ev[0].reason.as_deref().unwrap().contains("127.0.0.1"), "{ev:?}");
    }

    #[test]
    fn no_rules_means_not_granted() {
        let mut h = harness(&[], false);
        let r = h.open(1, "example.com", 443);
        assert_eq!(r["error"], "network not granted");
        assert_eq!(r["status"], 403);
    }

    #[test]
    fn connect_failure_is_allowed_but_reported_as_failed() {
        // a port nothing listens on
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut h = harness(&[&format!("test.example.com:{dead}")], true);
        let r = h.open(1, "test.example.com", dead);
        assert_eq!(r["ok"], false);
        assert_eq!(r["status"], 502);
        let ev = wait_events(&h.proxy, 1);
        assert!(ev[0].allowed, "policy allowed it; the connect failed: {ev:?}");
        assert!(ev[0].reason.as_deref().unwrap().contains("connect"), "{ev:?}");
    }

    #[test]
    fn revoke_closes_open_connections_and_new_ones_are_refused() {
        let (port, server) = echo_server();
        let mut h = harness(&[&format!("test.example.com:{port}")], true);
        assert_eq!(h.open(1, "test.example.com", port)["ok"], true);
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        data.write_all(b"x").unwrap();
        let mut b = [0u8; 1];
        data.read_exact(&mut b).unwrap();
        assert_eq!(h.proxy.revoke("test.example.com"), 1);
        data.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let n = data.read(&mut b).unwrap_or(0);
        assert_eq!(n, 0, "the tunnel was closed by the revoke");
        let ev = wait_events(&h.proxy, 1);
        assert_eq!(ev[0].reason.as_deref(), Some("revoked"));
        let r = h.open(2, "test.example.com", port);
        assert_eq!(r["error"], "network not granted");
        // allow it again with the same pattern: it works again
        h.proxy.allow(rule(&format!("test.example.com:{port}"))).unwrap();
        assert_eq!(h.proxy.rules().len(), 1);
        drop(server);
    }

    #[test]
    fn a_repeated_request_id_is_refused_while_the_first_lives() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let _accepting = thread::spawn(move || {
            let mut keep = vec![];
            while let Ok((s, _)) = l.accept() {
                keep.push(s);
            }
        });
        let mut h = harness(&[&format!("test.example.com:{port}")], true);
        assert_eq!(h.open(7, "test.example.com", port)["ok"], true);
        let _data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let r = h.open(7, "test.example.com", port);
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"], "duplicate request id");
        // the first connection is still revocable (it was not shadowed by the repeat)
        assert_eq!(h.proxy.revoke("test.example.com"), 1);
        // once it is gone the id is free again
        for _ in 0..100 {
            if !lock(&h.proxy.ids).contains(&7) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        h.proxy.allow(rule(&format!("test.example.com:{port}"))).unwrap();
        assert_eq!(h.open(7, "test.example.com", port)["ok"], true);
    }

    #[test]
    fn replacing_a_rule_with_fewer_ports_closes_what_it_no_longer_allows() {
        let accept_forever = || {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            thread::spawn(move || {
                let mut keep = vec![];
                while let Ok((s, _)) = l.accept() {
                    keep.push(s);
                }
            });
            port
        };
        let (p1, p2) = (accept_forever(), accept_forever());
        let mut h = harness(&[&format!("test.example.com:{p1},{p2}")], true);
        assert_eq!(h.open(1, "test.example.com", p1)["ok"], true);
        let mut d1 = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(h.open(2, "test.example.com", p2)["ok"], true);
        let mut d2 = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        h.proxy.allow(rule(&format!("test.example.com:{p1}"))).unwrap();
        let ev = wait_events(&h.proxy, 1);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!((ev[0].port, ev[0].reason.as_deref()), (p2, Some("revoked")));
        let mut b = [0u8; 8];
        d2.read_exact(&mut b[..2]).unwrap(); // the id line the host wrote first
        assert_eq!(d2.read(&mut b).unwrap_or(0), 0, "the connection on the removed port was closed");
        // the one on the kept port still carries data
        d1.read_exact(&mut b[..2]).unwrap();
        d1.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        assert!(d1.write_all(b"x").is_ok());
        assert!(d1.read(&mut b[..1]).is_err(), "no EOF, only silence (the server does not echo)");
        assert_eq!(h.open(3, "test.example.com", p2)["ok"], false);
    }

    #[test]
    fn connection_cap_is_enforced() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let _accepting = thread::spawn(move || {
            let mut keep = vec![];
            while let Ok((s, _)) = l.accept() {
                keep.push(s);
            }
        });
        let mut h = harness(&[&format!("test.example.com:{port}")], true);
        let mut datas = vec![];
        for id in 1..=MAX_CONNECTIONS as u64 {
            assert_eq!(h.open(id, "test.example.com", port)["ok"], true, "connection {id}");
            datas.push(h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        let r = h.open(1000, "test.example.com", port);
        assert_eq!(r["status"], 503, "{r}");
        h.proxy.close_all("stopped");
        let ev = h.proxy.take_events();
        assert_eq!(ev.iter().filter(|e| e.allowed && e.reason.as_deref() == Some("stopped")).count(), MAX_CONNECTIONS);
    }

    #[test]
    fn event_queue_is_bounded() {
        let p = NetProxy::new(vec![], NetOptions::default(), Arc::new(|_| Err(Error::new("unused"))));
        for i in 0..(MAX_EVENTS as u64 + 5) {
            p.push_event(NetEvent { id: i, host: "a.example.com".into(), port: 443, allowed: false, bytes_up: 0, bytes_down: 0, duration_ms: 0, reason: None, window: false });
        }
        let ev = p.take_events();
        assert_eq!(ev.len(), MAX_EVENTS + 1);
        assert!(ev[0].reason.as_deref().unwrap().starts_with("5 older"), "{:?}", ev[0]);
        assert!(p.take_events().is_empty());
    }

    #[test]
    fn oversized_or_garbage_lines_do_not_crash_the_reader() {
        let mut h = harness(&["test.example.com"], true);
        writeln!(h.guest_ctl_w, "not json").unwrap();
        writeln!(h.guest_ctl_w, "{{\"op\":\"net-open\"}}").unwrap();
        writeln!(h.guest_ctl_w, "{{\"op\":\"other\",\"id\":1}}").unwrap();
        let r = h.open(9, "nope.example.com", 443);
        assert_eq!(r["ok"], false, "the reader is still alive after garbage");
        let long = format!("{{\"op\":\"net-open\",\"id\":1,\"host\":\"{}\",\"port\":443}}\n", "a".repeat(MAX_LINE));
        h.guest_ctl_w.write_all(long.as_bytes()).unwrap();
        let mut line = String::new();
        // the host drops the channel; the guest sees EOF
        assert_eq!(h.guest_ctl.read_line(&mut line).unwrap_or(0), 0);
    }

    // ---- host services (SPEC 8.6, INV-H7) ----

    #[test]
    fn service_specs_are_loopback_only() {
        let ok = ServiceSpec::parse("gpu=127.0.0.1:50051").unwrap();
        assert_eq!((ok.name.as_str(), ok.addr.port()), ("gpu", 50051));
        assert_eq!(ok.spec(), "gpu=127.0.0.1:50051");
        // anything but the IPv4 loopback literal is refused: another address, a name, IPv6, a wildcard, port 0
        for bad in [
            "gpu=0.0.0.0:50051",
            "gpu=192.168.1.10:50051",
            "gpu=10.0.0.1:50051",
            "gpu=127.0.0.2:50051",
            "gpu=169.254.169.254:80",
            "gpu=localhost:50051",
            "gpu=example.com:443",
            "gpu=[::1]:50051",
            "gpu=127.0.0.1:0",
            "gpu=127.0.0.1",
            "gpu=:50051",
            "gpu=",
            "gpu",
            "=127.0.0.1:50051",
            "other=127.0.0.1:50051",
            "GPU=127.0.0.1:50051",
            "gpu =127.0.0.1:50051",
        ] {
            assert!(ServiceSpec::parse(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_service_tunnel_reaches_only_the_launch_endpoint_and_counts_bytes() {
        let (port, server) = echo_server();
        let mut h = harness_with(&[], &[&format!("gpu=127.0.0.1:{port}")], false);
        // the loopback test switch is OFF: the service path does not depend on it, and a network rule could not do this
        let r = h.open_service(1, "gpu");
        assert_eq!(r, json!({"id": 1, "ok": true}));
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        assert_eq!(&first, b"1\n", "the data connection starts with the request id");
        data.write_all(b"ggml rpc").unwrap();
        let mut got = [0u8; 8];
        data.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ggml rpc");
        // a traffic event shows up while the tunnel is open
        let ev = wait_service_events(&h.proxy, |e| e.iter().any(|x| x.phase == ServicePhase::Traffic));
        assert!(ev.iter().any(|e| e.phase == ServicePhase::Open && e.name == "gpu" && e.allowed), "{ev:?}");
        let t = ev.iter().rev().find(|e| e.phase == ServicePhase::Traffic).unwrap();
        assert_eq!((t.bytes_up, t.bytes_down), (8, 8), "{t:?}");
        data.shutdown(Shutdown::Write).unwrap();
        let mut rest = vec![];
        let _ = data.read_to_end(&mut rest);
        let ev = wait_service_events(&h.proxy, |e| e.iter().any(|x| x.phase == ServicePhase::Close));
        let close = ev.iter().find(|e| e.phase == ServicePhase::Close).unwrap();
        assert_eq!((close.id, close.name.as_str(), close.allowed), (1, "gpu", true));
        assert_eq!((close.bytes_up, close.bytes_down), (8, 8));
        let j = close.to_json();
        assert_eq!(j["phase"], "close");
        assert_eq!(j["bytesUp"], 8);
        assert!(j.get("reason").is_none());
        // no network event: a service is not a network connection
        assert!(h.proxy.take_events().is_empty());
        server.join().unwrap();
    }

    #[test]
    fn a_service_is_refused_unless_the_launcher_was_given_it() {
        let mut h = harness_with(&["example.com"], &[], false);
        // no --service: refused, with no data connection and a close event that says why
        let r = h.open_service(1, "gpu");
        assert_eq!((r["ok"].clone(), r["status"].clone(), r["error"].clone()), (json!(false), json!(403), json!("service not granted")));
        // a name that is not a service at all, and names built to look like paths or addresses
        for name in ["", "tools", "GPU", "gpu ", "127.0.0.1:22", "../gpu", "gpu\u{0}"] {
            assert_eq!(h.open_service(2, name)["ok"], false, "{name:?}");
        }
        let ev = h.proxy.take_service_events();
        assert!(!ev.is_empty() && ev.iter().all(|e| !e.allowed && e.phase == ServicePhase::Close && e.reason.is_some()), "{ev:?}");
        assert!(h.data_rx.try_recv().is_err(), "no data connection was opened for a refusal");
    }

    #[test]
    fn the_network_path_cannot_reach_a_service() {
        let (port, _server) = echo_server();
        // even with a network rule and the loopback test switch on, `service:gpu` is no host name and no rule can name it
        let mut h = harness_with(&["example.com"], &[&format!("gpu=127.0.0.1:{port}")], true);
        for host in ["service:gpu", "service.gpu", "gpu", "service:gpu.example.com", "127.0.0.1", "localhost"] {
            let r = h.open(1, host, port);
            assert_eq!(r["ok"], false, "{host}: {r}");
        }
        assert!(NetRule::parse("service:gpu").is_err(), "a rule cannot name a service");
        assert!(NetRule::parse("gpu:50052").is_err());
        assert!(h.data_rx.try_recv().is_err());
        assert!(h.proxy.take_service_events().is_empty());
    }

    #[test]
    fn a_service_revoke_closes_tunnels_and_new_ones_are_refused() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let _accepting = thread::spawn(move || {
            let mut keep = vec![];
            while let Ok((s, _)) = l.accept() {
                keep.push(s);
            }
        });
        let mut h = harness_with(&["example.com"], &[&format!("gpu=127.0.0.1:{port}")], false);
        assert_eq!(h.open_service(1, "gpu")["ok"], true);
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        assert_eq!(h.proxy.services().len(), 1);
        assert_eq!(h.proxy.service_revoke("gpu"), 1);
        data.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut b = [0u8; 1];
        assert_eq!(data.read(&mut b).unwrap_or(0), 0, "the tunnel was closed by the revoke");
        let ev = wait_service_events(&h.proxy, |e| e.iter().any(|x| x.phase == ServicePhase::Close));
        let close = ev.iter().find(|e| e.phase == ServicePhase::Close).unwrap();
        assert_eq!(close.reason.as_deref(), Some("revoked"), "{ev:?}");
        // gone for good: refused, and the list is empty
        assert!(h.proxy.services().is_empty());
        assert_eq!(h.open_service(2, "gpu")["error"], "service not granted");
        assert_eq!(h.proxy.service_revoke("gpu"), 0, "revoking twice closes nothing");
    }

    #[test]
    fn network_rule_changes_leave_service_tunnels_alone() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let _accepting = thread::spawn(move || {
            let mut keep = vec![];
            while let Ok((s, _)) = l.accept() {
                keep.push(s);
            }
        });
        let mut h = harness_with(&["example.com"], &[&format!("gpu=127.0.0.1:{port}")], false);
        assert_eq!(h.open_service(1, "gpu")["ok"], true);
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        // revoking every network rule closes zero service tunnels
        assert_eq!(h.proxy.revoke("example.com"), 0);
        data.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        assert!(data.write_all(b"x").is_ok());
        let mut b = [0u8; 1];
        assert!(data.read(&mut b).is_err(), "no EOF, only silence: the tunnel is still up");
        // a later network revoke does not touch it either, and the VM stopping closes it
        h.proxy.close_all("stopped");
        let ev = h.proxy.take_service_events();
        let close = ev.iter().find(|e| e.phase == ServicePhase::Close).unwrap();
        assert_eq!(close.reason.as_deref(), Some("stopped"), "{ev:?}");
    }

    #[test]
    fn service_connections_are_capped_and_ids_are_unique() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let _accepting = thread::spawn(move || {
            let mut keep = vec![];
            while let Ok((s, _)) = l.accept() {
                keep.push(s);
            }
        });
        let mut h = harness_with(&[], &[&format!("gpu=127.0.0.1:{port}")], false);
        let mut datas = vec![];
        for id in 1..=MAX_SERVICE_CONNECTIONS as u64 {
            assert_eq!(h.open_service(id, "gpu")["ok"], true, "tunnel {id}");
            datas.push(h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        let r = h.open_service(1000, "gpu");
        assert_eq!((r["status"].clone(), r["ok"].clone()), (json!(503), json!(false)), "{r}");
        assert_eq!(h.open_service(1, "gpu")["error"], "duplicate request id");
        h.proxy.close_all("stopped");
    }

    #[test]
    fn a_service_that_is_still_starting_is_waited_for() {
        // reserve a port, release it, and start listening on it a moment after the guest asked
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let late = thread::spawn(move || {
            thread::sleep(Duration::from_millis(900));
            let l = TcpListener::bind(("127.0.0.1", port)).unwrap();
            let (mut s, _) = l.accept().unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).unwrap();
            s.write_all(&b).unwrap();
        });
        let mut h = harness_full(&[], &[&format!("gpu=127.0.0.1:{port}")], false, Duration::from_secs(10), false);
        let t = Instant::now();
        let r = h.open_service(1, "gpu");
        assert_eq!(r["ok"], true, "{r}");
        assert!(t.elapsed() >= Duration::from_millis(700), "the tunnel opened before the server was there?");
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        data.write_all(b"late").unwrap();
        let mut got = [0u8; 4];
        data.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"late");
        late.join().unwrap();
    }

    #[test]
    fn a_wait_for_a_service_ends_when_it_is_revoked() {
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut h = harness_full(&[], &[&format!("gpu=127.0.0.1:{dead}")], false, Duration::from_secs(30), false);
        let proxy = h.proxy.clone();
        let revoker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(600));
            proxy.service_revoke("gpu");
        });
        let t = Instant::now();
        let r = h.open_service(1, "gpu");
        assert_eq!(r["ok"], false, "{r}");
        assert!(t.elapsed() < Duration::from_secs(5), "the wait went on after the revoke");
        revoker.join().unwrap();
    }

    #[test]
    fn the_guest_is_always_read_even_when_the_service_is_not_reading() {
        // A service that does not read for a while (a GPU busy with a kernel) must not hold up the guest's side: the host keeps
        // taking what the guest sends (up to the queue), so the device behind the guest's socket is never left waiting.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            thread::sleep(Duration::from_millis(2500));
            let mut total = 0usize;
            let mut buf = vec![0u8; 65536];
            while total < 8 * 1024 * 1024 {
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                total += n;
            }
            total
        });
        let mut h = harness_with(&[], &[&format!("gpu=127.0.0.1:{port}")], false);
        assert_eq!(h.open_service(1, "gpu")["ok"], true);
        let mut data = h.data_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut first = [0u8; 2];
        data.read_exact(&mut first).unwrap();
        let t = Instant::now();
        let chunk = vec![7u8; 65536];
        for _ in 0..128 {
            data.write_all(&chunk).unwrap(); // 8 MiB: far more than the sockets in between can hold
        }
        assert!(t.elapsed() < Duration::from_millis(2000), "the guest's writes waited for the service ({:?})", t.elapsed());
        assert_eq!(server.join().unwrap(), 8 * 1024 * 1024, "every byte arrived once the service read");
        let ev = wait_service_events(&h.proxy, |e| e.iter().any(|x| x.phase == ServicePhase::Traffic && x.bytes_up == 8 * 1024 * 1024));
        assert!(ev.iter().any(|x| x.bytes_up == 8 * 1024 * 1024), "{ev:?}");
        h.proxy.close_all("stopped");
    }

    #[test]
    fn an_unreachable_service_is_reported_as_a_failure() {
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut h = harness_with(&[], &[&format!("gpu=127.0.0.1:{dead}")], false);
        let r = h.open_service(1, "gpu");
        assert_eq!((r["ok"].clone(), r["status"].clone()), (json!(false), json!(502)), "{r}");
        let ev = h.proxy.take_service_events();
        assert!(ev[0].allowed, "policy allowed it; the connect failed: {ev:?}");
        assert!(h.data_rx.try_recv().is_err(), "no data connection for a service that is not there");
    }

    // ---- the window endpoint (DEV-APPS C3) ----

    const SECRET: &str = "0123456789abcdefABCDEF0123456789abcdef";

    fn good_auth() -> String {
        format!("Basic {}", base64(format!("{WINDOW_PROXY_USER}:{SECRET}").as_bytes()))
    }

    fn connect_head(target: &str, auth: Option<&str>) -> String {
        let mut h = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nUser-Agent: test\r\n");
        if let Some(a) = auth {
            h.push_str(&format!("Proxy-Authorization: {a}\r\n"));
        }
        h.push_str("\r\n");
        h
    }

    /// Sends a request head to the window endpoint and reads the answer's head (and a short body, if any).
    fn window_request(port: u16, head: &str) -> (TcpStream, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(head.as_bytes()).unwrap();
        let mut buf = vec![];
        let mut b = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            match s.read(&mut b) {
                Ok(1) => buf.push(b[0]),
                _ => break,
            }
        }
        (s, String::from_utf8_lossy(&buf).into_owned())
    }

    fn window_events(p: &NetProxy, n: usize) -> Vec<NetEvent> {
        let ev = wait_events(p, n);
        assert!(ev.iter().all(|e| e.window), "every event of the window endpoint says so: {ev:?}");
        ev
    }

    #[test]
    fn base64_and_request_heads() {
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"vmapp:secret"), "dm1hcHA6c2VjcmV0");
        let r = parse_head(b"CONNECT a.example.com:443 HTTP/1.1\r\nHost: a.example.com:443\r\nproxy-authorization:  Basic abc \r\nX: y").unwrap();
        assert_eq!((r.method.as_str(), r.target.as_str(), r.auth.as_deref()), ("CONNECT", "a.example.com:443", Some("Basic abc")));
        assert_eq!(parse_head(b"CONNECT a.example.com:443 HTTP/2\r\n"), None, "HTTP/1.x only");
        assert_eq!(parse_head(b"CONNECT a.example.com:443 HTTP/1.1\r\nno colon"), None);
        assert_eq!(parse_head(b"CONNECT x:1 HTTP/1.1\r\nProxy-Authorization: a\r\nProxy-Authorization: b"), None, "twice is refused");
        assert!(auth_matches(Some("basic dG9rZW4="), "dG9rZW4="));
        assert!(!auth_matches(Some("Bearer dG9rZW4="), "dG9rZW4="));
        assert!(!auth_matches(Some("Basic dG9rZW5="), "dG9rZW4="));
        assert!(!auth_matches(None, "dG9rZW4="));
        assert_eq!(split_target("a.example.com:8443"), Some(("a.example.com", 8443)));
        assert_eq!(split_target("[::1]:443"), Some(("[::1]", 443)), "bracketed IPv6 is split, then refused as an address");
        assert_eq!(split_target("a.example.com"), None);
        assert_eq!(split_target("a.example.com:0"), None);
        assert_eq!(plain_target("http://a.example.com:8080/x?y"), ("a.example.com".to_string(), 8080));
        assert_eq!(plain_target("http://a.example.com/"), ("a.example.com".to_string(), 80));
    }

    #[test]
    fn the_window_endpoint_needs_a_good_secret_and_starts_once() {
        let h = harness(&[], false);
        assert!(h.proxy.serve_window("short").is_err());
        assert!(h.proxy.serve_window(&"a".repeat(129)).is_err());
        assert!(h.proxy.serve_window("0123456789abcdef0123456789abcde-").is_err(), "letters and digits only");
        let port = h.proxy.serve_window(SECRET).unwrap();
        assert_eq!(h.proxy.window_port(), Some(port));
        assert!(h.proxy.serve_window(SECRET).is_err(), "once per launcher");
        h.proxy.close_all("stopped");
    }

    #[test]
    fn a_window_client_without_the_secret_gets_407_and_nothing_else() {
        let (tport, _server) = echo_server();
        let h = harness(&[&format!("test.example.com:{tport}")], true);
        let port = h.proxy.serve_window(SECRET).unwrap();
        for auth in [None, Some("Basic dm1hcHA6d3Jvbmc="), Some(format!("Basic {}", base64(format!("other:{SECRET}").as_bytes())).as_str())] {
            let (mut s, head) = window_request(port, &connect_head(&format!("test.example.com:{tport}"), auth));
            assert!(head.starts_with("HTTP/1.1 407 "), "{head}");
            assert!(head.contains("Proxy-Authenticate: Basic realm=\"vmapp\"\r\n"), "{head}");
            let mut rest = vec![];
            let _ = s.read_to_end(&mut rest);
            assert!(rest.is_empty(), "closed after the 407");
        }
        thread::sleep(Duration::from_millis(100));
        assert!(h.proxy.take_events().is_empty(), "an unauthenticated client is not an app connection");
        // a head that is not HTTP, or with bytes after it, is refused before anything is decided
        let (_s, head) = window_request(port, "hello\r\n\r\n");
        assert!(head.starts_with("HTTP/1.1 400 "), "{head}");
        let (_s, head) = window_request(port, &format!("{}extra", connect_head(&format!("test.example.com:{tport}"), Some(&good_auth()))));
        assert!(head.starts_with("HTTP/1.1 400 "), "{head}");
        h.proxy.close_all("stopped");
    }

    #[test]
    fn a_window_tunnel_follows_the_rules_and_counts_bytes() {
        let (tport, server) = echo_server();
        let h = harness(&[&format!("test.example.com:{tport}")], true);
        let port = h.proxy.serve_window(SECRET).unwrap();
        let (mut s, head) = window_request(port, &connect_head(&format!("TEST.example.com.:{tport}"), Some(&good_auth())));
        assert_eq!(head, "HTTP/1.1 200 Connection Established\r\n\r\n");
        s.write_all(b"hello").unwrap();
        let mut got = [0u8; 5];
        s.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"hello");
        s.shutdown(Shutdown::Write).unwrap();
        let mut rest = vec![];
        let _ = s.read_to_end(&mut rest);
        let ev = window_events(&h.proxy, 1);
        assert_eq!((ev[0].host.as_str(), ev[0].port, ev[0].allowed), ("test.example.com", tport, true));
        assert_eq!((ev[0].bytes_up, ev[0].bytes_down), (5, 5));
        assert!(ev[0].id >= WINDOW_ID_BASE);
        assert_eq!(ev[0].to_json()["window"], true);
        assert!(h.data_rx.try_recv().is_err(), "a window tunnel never opens a guest data connection");
        server.join().unwrap();
        h.proxy.close_all("stopped");
    }

    #[test]
    fn a_window_is_refused_what_the_guest_is_refused() {
        let (tport, _server) = echo_server();
        let h = harness(&[&format!("test.example.com:{tport}"), "*.example.com:443"], false);
        let port = h.proxy.serve_window(SECRET).unwrap();
        let auth = good_auth();
        let cases: Vec<(String, &str, &str)> = vec![
            (connect_head("other.example.org:443", Some(&auth)), "403", "not in this app's network permissions"),
            (connect_head(&format!("127.0.0.1:{tport}"), Some(&auth)), "403", "IP addresses are not allowed"),
            (connect_head("[::1]:443", Some(&auth)), "403", "IP addresses are not allowed"),
            (connect_head("localhost:443", Some(&auth)), "403", ""),
            (connect_head("rebind.example.com:443", Some(&auth)), "403", "private or local address"),
            (connect_head("meta.example.com:443", Some(&auth)), "403", "private or local address"),
            // loopback without the test switch: the address check, as for the guest
            (connect_head(&format!("test.example.com:{tport}"), Some(&auth)), "403", "private or local address"),
            (format!("GET http://test.example.com/ HTTP/1.1\r\nProxy-Authorization: {auth}\r\n\r\n"), "405", "only open https and wss"),
        ];
        for (req, status, why) in &cases {
            let (mut s, head) = window_request(port, req);
            assert!(head.starts_with(&format!("HTTP/1.1 {status} ")), "{req}: {head}");
            let mut body = String::new();
            let _ = s.read_to_string(&mut body);
            assert!(body.contains(why), "{req}: {body}");
            assert!(!body.contains("192.168") && !body.contains("169.254"), "the window never learns the address: {body}");
        }
        let ev = window_events(&h.proxy, cases.len());
        assert_eq!(ev.len(), cases.len(), "every refusal is an event: {ev:?}");
        assert!(ev.iter().all(|e| !e.allowed && e.reason.is_some()), "{ev:?}");
        assert!(ev.iter().any(|e| e.reason.as_deref().is_some_and(|r| r.contains("192.168.1.10"))), "the Inspector does: {ev:?}");
        h.proxy.close_all("stopped");
    }

    #[test]
    fn a_revoke_closes_window_tunnels_and_a_stop_closes_the_endpoint() {
        let (tport, _server) = echo_server();
        let h = harness(&[&format!("test.example.com:{tport}")], true);
        let port = h.proxy.serve_window(SECRET).unwrap();
        let (mut s, head) = window_request(port, &connect_head(&format!("test.example.com:{tport}"), Some(&good_auth())));
        assert!(head.starts_with("HTTP/1.1 200 "), "{head}");
        s.write_all(b"x").unwrap();
        let mut b = [0u8; 1];
        s.read_exact(&mut b).unwrap();
        assert_eq!(h.proxy.revoke("test.example.com"), 1);
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(s.read(&mut b).unwrap_or(0), 0, "the revoke closed the window's tunnel");
        let ev = window_events(&h.proxy, 1);
        assert_eq!(ev[0].reason.as_deref(), Some("revoked"));
        let (_s, head) = window_request(port, &connect_head(&format!("test.example.com:{tport}"), Some(&good_auth())));
        assert!(head.starts_with("HTTP/1.1 403 "), "{head}");
        let _ = window_events(&h.proxy, 1);
        // the VM stops: the endpoint stops listening
        h.proxy.close_all("stopped");
        thread::sleep(Duration::from_millis(500));
        let gone = match TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_secs(2)) {
            Err(_) => true,
            Ok(mut c) => {
                let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = c.write_all(connect_head(&format!("test.example.com:{tport}"), Some(&good_auth())).as_bytes());
                let mut buf = [0u8; 16];
                matches!(c.read(&mut buf), Ok(0) | Err(_))
            }
        };
        assert!(gone, "nothing answers on the window endpoint after the stop");
    }

    // ---- port forwarding (SPEC 8.8) ----

    /// A proxy whose connector hands the guest ends of PORTFWD_PORT connections to the test (the test plays the VM).
    fn forward_harness() -> (Arc<NetProxy>, mpsc::Receiver<UnixStream>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let connector: Connector = Arc::new(move |port| {
            assert_eq!(port, PORTFWD_PORT);
            let (h, g) = UnixStream::pair().unwrap();
            tx.lock().unwrap().send(g).unwrap();
            Ok(OwnedFd::from(h))
        });
        (NetProxy::new(vec![], NetOptions::default(), connector), rx)
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn wait_forward_events(p: &NetProxy, want: impl Fn(&[ForwardEvent]) -> bool) -> Vec<ForwardEvent> {
        let mut all = vec![];
        for _ in 0..200 {
            all.extend(p.take_forward_events());
            if want(&all) {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        all
    }

    #[test]
    fn a_forwarded_port_carries_a_mac_connection_to_the_vm_port() {
        let (p, guest) = forward_harness();
        let port = free_port();
        let host_port = p.forward(port).unwrap();
        assert_eq!(host_port, port, "the same port when it is free");
        assert_eq!(p.forward(port).unwrap(), host_port, "forwarding again is the same forward");
        assert_eq!(p.forwards(), vec![(port, host_port)]);
        let mut mac = TcpStream::connect(("127.0.0.1", host_port)).unwrap();
        let mut vm = guest.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut line = [0u8; 6];
        vm.read_exact(&mut line[..port.to_string().len() + 1]).unwrap();
        assert_eq!(&line[..port.to_string().len() + 1], format!("{port}\n").as_bytes(), "the guest is told the VM port only");
        mac.write_all(b"GET / HTTP/1.0\r\n\r\n").unwrap();
        let mut req = [0u8; 18];
        vm.read_exact(&mut req).unwrap();
        vm.write_all(b"HTTP/1.0 200 OK\r\n\r\nhi").unwrap();
        vm.shutdown(Shutdown::Write).unwrap();
        let mut got = String::new();
        mac.read_to_string(&mut got).unwrap();
        assert_eq!(got, "HTTP/1.0 200 OK\r\n\r\nhi");
        drop(mac);
        let ev = wait_forward_events(&p, |e| e.iter().any(|x| x.phase == "conn"));
        assert_eq!(ev[0].phase, "listen");
        let c = ev.iter().find(|x| x.phase == "conn").unwrap();
        assert_eq!((c.port, c.host_port, c.bytes_up, c.bytes_down), (port, host_port, 21, 18), "{c:?}");
        assert!(c.id >= FORWARD_ID_BASE);
        assert_eq!(c.to_json()["hostPort"], host_port);
        p.close_all("stopped");
    }

    #[test]
    fn a_port_taken_on_the_mac_gets_another_and_only_loopback_listens() {
        let (p, _guest) = forward_harness();
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let host_port = p.forward(port).unwrap();
        assert_ne!(host_port, port);
        assert!(p.forward(0).is_err());
        p.close_all("stopped");
    }

    #[test]
    fn closing_a_forward_ends_its_connections_and_network_rules_never_touch_it() {
        let (p, guest) = forward_harness();
        p.allow(rule("a.example.com")).unwrap();
        let port = free_port();
        let host_port = p.forward(port).unwrap();
        let mut mac = TcpStream::connect(("127.0.0.1", host_port)).unwrap();
        let _vm = guest.recv_timeout(Duration::from_secs(5)).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(p.revoke("a.example.com"), 0, "a network revoke does not close a forwarded connection");
        assert_eq!(p.forward_close(port, "closed"), 1);
        mac.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut b = [0u8; 1];
        assert_eq!(mac.read(&mut b).unwrap_or(0), 0, "closed");
        let ev = wait_forward_events(&p, |e| e.iter().any(|x| x.phase == "stop") && e.iter().any(|x| x.phase == "conn"));
        assert_eq!(ev.iter().find(|x| x.phase == "conn").unwrap().reason.as_deref(), Some("closed"));
        thread::sleep(Duration::from_millis(400));
        assert!(TcpStream::connect(("127.0.0.1", host_port)).is_err(), "nothing listens after the close");
        assert_eq!(p.forward_close(port, "closed"), 0, "closing twice is harmless");
        p.close_all("stopped");
    }

    #[test]
    fn forwards_are_capped_and_end_with_the_vm() {
        let (p, _guest) = forward_harness();
        let mut ports = vec![];
        for _ in 0..MAX_FORWARDS {
            let port = free_port();
            ports.push(p.forward(port).unwrap());
        }
        assert!(p.forward(free_port()).is_err(), "at most {MAX_FORWARDS}");
        p.close_all("stopped");
        thread::sleep(Duration::from_millis(500));
        assert!(TcpStream::connect(("127.0.0.1", ports[0])).is_err(), "the listeners end with the VM");
        assert!(p.forward(free_port()).is_err(), "no new forward once stopped");
    }

    #[test]
    fn window_connections_have_their_own_cap() {
        let (tport, _server) = echo_server();
        let h = harness(&[&format!("test.example.com:{tport}")], true);
        h.proxy.window_active.store(MAX_WINDOW_CONNECTIONS, Ordering::SeqCst);
        let port = h.proxy.serve_window(SECRET).unwrap();
        let (_s, head) = window_request(port, &connect_head(&format!("test.example.com:{tport}"), Some(&good_auth())));
        assert!(head.starts_with("HTTP/1.1 503 "), "{head}");
        assert_eq!(h.proxy.active.load(Ordering::SeqCst), 0, "the guest's slots are untouched");
        h.proxy.window_active.store(0, Ordering::SeqCst);
        h.proxy.close_all("stopped");
    }
}
