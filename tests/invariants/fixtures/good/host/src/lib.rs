//! Fixture launcher library. Never use println!/eprintln!/print! here.
use std::io::Write;

/// Writes one line to stderr, ignoring failures (`eprintln!` would panic on a closed pipe).
pub fn log_line(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

pub fn first(v: &[u8]) -> u8 {
    v.first().copied().expect("fixture: callers pass a non-empty slice")
}

#[cfg(test)]
mod tests {
    #[test]
    fn prints_are_fine_in_tests() {
        println!("{}", super::first(&[1]));
    }
}
