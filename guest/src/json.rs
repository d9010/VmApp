//! Minimal JSON helpers: a string escaper for output and a tiny parser that reads the top-level
//! string / string-array members of a request object.
//!
//! Adapted from agent-vm/guest/src/json.rs (commit 8f0c069). `get_op` was dropped: requests are read with
//! [`parse_object`] and the `op` member is looked up with [`find_str`].

/// Quote `s` as a JSON string literal (including the surrounding quotes).
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A top-level value of an object read by [`parse_object`]: strings, arrays of strings, booleans and
/// non-negative integers are kept; anything else (other numbers, null, nested objects, mixed arrays)
/// becomes `Other`.
#[derive(Debug, PartialEq, Eq)]
pub enum Value {
    Str(String),
    Strs(Vec<String>),
    Bool(bool),
    Uint(u64),
    Other,
}

/// Parse a JSON object into its top-level `(key, value)` pairs (see [`Value`]). `None` when the text is
/// not a well-formed JSON object. Later duplicates of a key come later in the list.
pub fn parse_object(text: &str) -> Option<Vec<(String, Value)>> {
    let mut p = Parser { b: text.as_bytes(), i: 0 };
    let mut out = Vec::new();
    p.ws();
    if !p.eat(b'{') {
        return None;
    }
    p.ws();
    if p.eat(b'}') {
        p.ws();
        return if p.i == p.b.len() { Some(out) } else { None };
    }
    loop {
        p.ws();
        let key = p.string()?;
        p.ws();
        if !p.eat(b':') {
            return None;
        }
        p.ws();
        let value = match p.peek()? {
            b'"' => Value::Str(p.string()?),
            b't' | b'f' | b'0'..=b'9' => {
                let start = p.i;
                p.skip_value(0)?;
                match p.b.get(start..p.i) {
                    Some(b"true") => Value::Bool(true),
                    Some(b"false") => Value::Bool(false),
                    Some(t) => std::str::from_utf8(t).ok().and_then(|s| s.parse::<u64>().ok()).map_or(Value::Other, Value::Uint),
                    None => Value::Other,
                }
            }
            b'[' => {
                let save = p.i;
                match p.string_array() {
                    Some(v) => Value::Strs(v),
                    None => {
                        // Not an array of strings: skip it generically.
                        p.i = save;
                        p.skip_value(0)?;
                        Value::Other
                    }
                }
            }
            _ => {
                p.skip_value(0)?;
                Value::Other
            }
        };
        out.push((key, value));
        p.ws();
        if p.eat(b',') {
            continue;
        }
        if p.eat(b'}') {
            break;
        }
        return None;
    }
    p.ws();
    if p.i == p.b.len() {
        Some(out)
    } else {
        None
    }
}

/// The last string value stored under `key`.
pub fn find_str<'a>(obj: &'a [(String, Value)], key: &str) -> Option<&'a str> {
    obj.iter().rev().find(|(k, _)| k == key).and_then(|(_, v)| match v {
        Value::Str(s) => Some(s.as_str()),
        _ => None,
    })
}

/// The last boolean value stored under `key`.
pub fn find_bool(obj: &[(String, Value)], key: &str) -> Option<bool> {
    obj.iter().rev().find(|(k, _)| k == key).and_then(|(_, v)| match v {
        Value::Bool(b) => Some(*b),
        _ => None,
    })
}

/// The last non-negative integer value stored under `key`.
pub fn find_uint(obj: &[(String, Value)], key: &str) -> Option<u64> {
    obj.iter().rev().find(|(k, _)| k == key).and_then(|(_, v)| match v {
        Value::Uint(n) => Some(*n),
        _ => None,
    })
}

/// The last array-of-strings value stored under `key`.
pub fn find_strs<'a>(obj: &'a [(String, Value)], key: &str) -> Option<&'a [String]> {
    obj.iter().rev().find(|(k, _)| k == key).and_then(|(_, v)| match v {
        Value::Strs(a) => Some(a.as_slice()),
        _ => None,
    })
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.i += 1;
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let s = self.b.get(self.i..self.i.checked_add(4)?)?;
        let s = std::str::from_utf8(s).ok()?;
        let v = u32::from_str_radix(s, 16).ok()?;
        self.i += 4;
        Some(v)
    }

    fn string(&mut self) -> Option<String> {
        if !self.eat(b'"') {
            return None;
        }
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = self.peek()?;
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xd800..0xdc00).contains(&cp) {
                                // High surrogate: expect a following \uXXXX low surrogate.
                                if self.peek() == Some(b'\\') && self.b.get(self.i + 1) == Some(&b'u') {
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xdc00..0xe000).contains(&lo) {
                                        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                                    } else {
                                        cp = 0xfffd;
                                    }
                                } else {
                                    cp = 0xfffd;
                                }
                            }
                            let ch = char::from_u32(cp).unwrap_or('\u{fffd}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return None,
                    }
                }
                c => out.push(c),
            }
        }
        Some(String::from_utf8_lossy(&out).into_owned())
    }

    /// `["a","b",…]`. `None` (position undefined) when it is not an array of strings.
    fn string_array(&mut self) -> Option<Vec<String>> {
        if !self.eat(b'[') {
            return None;
        }
        let mut out = Vec::new();
        self.ws();
        if self.eat(b']') {
            return Some(out);
        }
        loop {
            self.ws();
            out.push(self.string()?);
            self.ws();
            if self.eat(b',') {
                continue;
            }
            if self.eat(b']') {
                return Some(out);
            }
            return None;
        }
    }

    /// Skip one JSON value of any type. `None` on malformed input.
    fn skip_value(&mut self, depth: u32) -> Option<()> {
        if depth > 32 {
            return None;
        }
        match self.peek()? {
            b'"' => {
                self.string()?;
            }
            b'{' => {
                self.i += 1;
                self.ws();
                if self.eat(b'}') {
                    return Some(());
                }
                loop {
                    self.ws();
                    self.string()?;
                    self.ws();
                    if !self.eat(b':') {
                        return None;
                    }
                    self.ws();
                    self.skip_value(depth + 1)?;
                    self.ws();
                    if self.eat(b',') {
                        continue;
                    }
                    if self.eat(b'}') {
                        break;
                    }
                    return None;
                }
            }
            b'[' => {
                self.i += 1;
                self.ws();
                if self.eat(b']') {
                    return Some(());
                }
                loop {
                    self.ws();
                    self.skip_value(depth + 1)?;
                    self.ws();
                    if self.eat(b',') {
                        continue;
                    }
                    if self.eat(b']') {
                        break;
                    }
                    return None;
                }
            }
            _ => {
                // number / true / false / null
                let start = self.i;
                while let Some(c) = self.peek() {
                    if matches!(c, b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                        break;
                    }
                    self.i += 1;
                }
                if self.i == start {
                    return None;
                }
            }
        }
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes() {
        assert_eq!(quote("a\"b\\c\n\u{1}é"), "\"a\\\"b\\\\c\\n\\u0001é\"");
    }

    #[test]
    fn ops() {
        let op = |s: &str| parse_object(s).and_then(|o| find_str(&o, "op").map(str::to_owned));
        assert_eq!(op(r#"{"op":"hello"}"#).as_deref(), Some("hello"));
        assert_eq!(op(r#" { "x": [1,{"a":"b"}], "op" : "shutdown" , "y":null } "#).as_deref(), Some("shutdown"));
        assert_eq!(op(r#"{"op":3}"#), None);
        assert_eq!(op("nope"), None);
        assert_eq!(op("{}"), None);
        assert_eq!(op(r#"{"op":"a""#), None);
    }

    #[test]
    fn start_request() {
        let o = parse_object(
            r#"{"op":"start","command":["node","main.js"],"workdir":"/app","env":["A=1","B=x\"y"]}"#,
        )
        .unwrap();
        assert_eq!(find_str(&o, "op"), Some("start"));
        assert_eq!(find_strs(&o, "command").unwrap(), ["node", "main.js"]);
        assert_eq!(find_str(&o, "workdir"), Some("/app"));
        assert_eq!(find_strs(&o, "env").unwrap(), ["A=1", "B=x\"y"]);
    }

    #[test]
    fn mount_request() {
        let o = parse_object(r#"{"op":"mount","slot":3,"name":"pick-0","ro":true,"x":false,"neg":-1,"f":1.5}"#).unwrap();
        assert_eq!(find_uint(&o, "slot"), Some(3));
        assert_eq!(find_bool(&o, "ro"), Some(true));
        assert_eq!(find_bool(&o, "x"), Some(false));
        assert_eq!(find_uint(&o, "neg"), None);
        assert_eq!(find_uint(&o, "f"), None);
        assert_eq!(find_bool(&o, "slot"), None);
        assert!(parse_object(r#"{"a":tru}"#).is_some()); // lenient scalar skipping, value is Other
    }

    #[test]
    fn objects() {
        let o = parse_object(r#" {"entry":["/a","b\"c"],"env":[],"workdir":"/srv","n":3,"mix":[1,"x"],"o":{"k":[1]}} "#)
            .unwrap();
        assert_eq!(find_strs(&o, "entry").unwrap(), ["/a", "b\"c"]);
        assert_eq!(find_strs(&o, "env").unwrap().len(), 0);
        assert_eq!(find_str(&o, "workdir"), Some("/srv"));
        assert_eq!(find_str(&o, "n"), None);
        assert_eq!(find_uint(&o, "n"), Some(3));
        assert_eq!(find_strs(&o, "mix"), None);
        assert!(parse_object("{}").unwrap().is_empty());
        assert!(parse_object(r#"{"a":"b"} x"#).is_none());
        assert!(parse_object(r#"{"a":["b",]}"#).is_none());
        assert!(parse_object("[]").is_none());
    }
}
