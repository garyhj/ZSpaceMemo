use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tracing_subscriber::fmt::MakeWriter;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ROTATED_FILES: usize = 2;

static FILE_SINK: OnceLock<Mutex<RotatingLogSink>> = OnceLock::new();

struct RotatingLogSink {
    dir: PathBuf,
    file: Option<File>,
    size: u64,
    line_buf: Vec<u8>,
}

impl RotatingLogSink {
    fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let log_path = dir.join("zspace-kit.log");
        let existing_size = fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        let mut sink = Self {
            dir,
            file,
            size: existing_size,
            line_buf: Vec::with_capacity(256),
        };
        sink.rotate_if_needed();
        sink
    }

    fn rotate_if_needed(&mut self) {
        if self.size < MAX_LOG_BYTES {
            return;
        }
        self.file = None;
        for idx in (1..=MAX_ROTATED_FILES).rev() {
            let src = if idx == 1 {
                self.dir.join("zspace-kit.log")
            } else {
                self.dir.join(format!("zspace-kit.{}.log", idx - 1))
            };
            let dst = self.dir.join(format!("zspace-kit.{idx}.log"));
            if dst.exists() {
                let _ = fs::remove_file(&dst);
            }
            if src.exists() {
                let _ = fs::rename(&src, &dst);
            }
        }
        let log_path = self.dir.join("zspace-kit.log");
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .ok();
        self.size = 0;
    }

    fn write_bytes(&mut self, data: &[u8]) {
        for &b in data {
            self.line_buf.push(b);
            if b == b'\n' {
                self.flush_line();
            } else if self.line_buf.len() >= 16 * 1024 {
                self.line_buf.push(b'\n');
                self.flush_line();
            }
        }
    }

    fn flush_line(&mut self) {
        if self.line_buf.is_empty() {
            return;
        }
        let raw = String::from_utf8_lossy(&self.line_buf);
        let sanitized = sanitize_log_line(&raw);
        self.line_buf.clear();

        self.rotate_if_needed();
        if let Some(f) = &mut self.file {
            if f.write_all(sanitized.as_bytes()).is_ok() {
                self.size += sanitized.len() as u64;
                let _ = f.flush();
            }
        }
    }
}

/// Redact credential/token values from log lines before persisting or emitting to stderr.
pub fn sanitize_log_line(line: &str) -> String {
    let mut out = line.to_string();
    let sensitive_keys = [
        "access_token",
        "refresh_token",
        "auth_token",
        "csrf_token",
        "session_token",
        "id_token",
        "api_key",
        "access_key",
        "secret_key",
        "client_secret",
        "auth_code",
        "token",
        "password",
        "passwd",
        "secret",
        "authorization",
        "cookie",
        "code",
    ];
    for key in sensitive_keys {
        out = redact_key_values(&out, key);
    }
    out = redact_bearer(&out);
    out
}

fn redact_bearer(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while let Some(pos) = lower[i..].find("bearer ") {
        let start = i + pos;
        out.push_str(&input[i..start + 7]);
        let rest = &input[start + 7..];
        let len = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '}'))
            .unwrap_or(rest.len());
        out.push_str("[REDACTED]");
        i = start + 7 + len;
    }
    out.push_str(&input[i..]);
    out
}

fn redact_key_values(input: &str, key: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while let Some(rel) = lower[i..].find(key) {
        let start = i + rel;
        let prev = if start == 0 {
            ' '
        } else {
            input[..start].chars().next_back().unwrap_or(' ')
        };
        // Match standalone keys OR snake_case/kebab-case suffixes like `custom_auth_token`
        // for keys longer than `"code"` (avoids false positives on `exit_code=0`).
        let allow_prefixed = key != "code" && matches!(prev, '_' | '-');
        let before_ok = start == 0 || allow_prefixed || (!prev.is_ascii_alphanumeric() && prev != '_');
        let after_idx = start + key.len();
        if !before_ok || after_idx >= input.len() {
            out.push_str(&input[i..after_idx]);
            i = after_idx;
            continue;
        }
        let after = &input[after_idx..];
        // Handle `"key":"value"`, `key="value"`, `key=value`, `key: value`
        let rest_trimmed = after.trim_start_matches(['"', '\'', ' ']);
        if rest_trimmed.starts_with('=') || rest_trimmed.starts_with(':') {
            let sep_offset = after.len() - rest_trimmed.len() + 1;
            let val_start_in_input = after_idx + sep_offset;
            let val_slice = &input[val_start_in_input..];
            let ws_len = val_slice
                .find(|c: char| c != ' ' && c != '\t')
                .unwrap_or(val_slice.len());
            let v = &val_slice[ws_len..];
            if v.starts_with('"') || v.starts_with('\'') {
                let quote = v.chars().next().unwrap();
                let inner = &v[1..];
                let end_q = inner.find(quote).unwrap_or(inner.len());
                out.push_str(&input[i..val_start_in_input + ws_len + 1]);
                out.push_str("[REDACTED]");
                i = val_start_in_input + ws_len + 1 + end_q;
            } else {
                let end_v = v
                    .find(|c: char| c.is_whitespace() || matches!(c, '&' | ',' | ';' | '}' | '"'))
                    .unwrap_or(v.len());
                if end_v == 0 {
                    out.push_str(&input[i..val_start_in_input + ws_len]);
                    i = val_start_in_input + ws_len;
                } else {
                    out.push_str(&input[i..val_start_in_input + ws_len]);
                    out.push_str("[REDACTED]");
                    i = val_start_in_input + ws_len + end_v;
                }
            }
        } else {
            out.push_str(&input[i..after_idx]);
            i = after_idx;
        }
    }
    out.push_str(&input[i..]);
    out
}

pub struct SanitizedTeeWriter;

impl Write for SanitizedTeeWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let sanitized = sanitize_log_line(&String::from_utf8_lossy(buf));
        let _ = io::stderr().write_all(sanitized.as_bytes());
        if let Some(sink) = FILE_SINK.get() {
            if let Ok(mut guard) = sink.lock() {
                guard.write_bytes(sanitized.as_bytes());
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        if let Some(sink) = FILE_SINK.get() {
            if let Ok(mut guard) = sink.lock() {
                guard.flush_line();
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub struct SanitizedMakeWriter;

impl<'a> MakeWriter<'a> for SanitizedMakeWriter {
    type Writer = SanitizedTeeWriter;

    fn make_writer(&'a self) -> Self::Writer {
        SanitizedTeeWriter
    }
}

pub fn init_subscriber() {
    let _ = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(SanitizedMakeWriter)
        .try_init();
}

pub fn attach_log_dir(dir: PathBuf) {
    let _ = FILE_SINK.get_or_init(|| Mutex::new(RotatingLogSink::new(dir)));
}

#[cfg(test)]
mod tests {
    use super::sanitize_log_line;

    #[test]
    fn redacts_tokens_secrets_and_bearer_headers() {
        let input = r#"INFO auth: Bearer abc.def.ghi {"access_token":"xyz123","auth_token":"at_999","code":"mycode"} password=pass1 token=tok_99 nas_api_key=k_secret"#;
        let out = sanitize_log_line(input);
        assert!(!out.contains("abc.def.ghi"));
        assert!(!out.contains("xyz123"));
        assert!(!out.contains("at_999"));
        assert!(!out.contains("mycode"));
        assert!(!out.contains("pass1"));
        assert!(!out.contains("tok_99"));
        assert!(!out.contains("k_secret"));
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn preserves_unicode_and_normal_telemetry() {
        let input = "INFO sync: 同步完成 total=12 fetched=2 exit_code=0 cpu=9.0%";
        assert_eq!(sanitize_log_line(input), input);
    }
}
