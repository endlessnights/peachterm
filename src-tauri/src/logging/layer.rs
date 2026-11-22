//! `tracing` layer that renders events as one-line JSON using only allowlisted
//! fields (see `fields.rs`).
//!
//! * First-party events (target `peachterm_lib…`): `ts`, `level`, `target` and
//!   every allowlisted field. The `message` is never recorded.
//! * Third-party events (tauri, wry, russh, `log`-bridged crates, …): only
//!   `ts`, `level`, `target` and `third_party:true`, and only at WARN/ERROR.
//!   Their text can contain anything (paths, hosts, packet fragments), so it is
//!   not recorded at any level, including DEBUG and TRACE.

use super::clock;
use super::fields::{self, FieldKind, Raw};
use serde_json::{Map, Value};
use std::fmt;
use std::sync::Arc;
use std::time::SystemTime;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_log::NormalizeEvent;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// Destination for rendered lines. Implementations must never block the caller.
pub trait LineSink: Send + Sync + 'static {
    fn write_line(&self, line: String);
}

pub const FIRST_PARTY: &str = "peachterm_lib";

pub fn is_first_party(target: &str) -> bool {
    target == FIRST_PARTY || target.starts_with("peachterm_lib::")
}

fn target_is_plain(target: &str) -> bool {
    !target.is_empty()
        && target.len() <= 64
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
}

/// Render one line. `fields` must already be validated.
pub fn render(now: SystemTime, level: &str, target: &str, fields: Map<String, Value>) -> String {
    let mut object = fields;
    object.insert("ts".into(), Value::from(clock::format_timestamp(now)));
    object.insert("level".into(), Value::from(level));
    object.insert("target".into(), Value::from(target));
    Value::Object(object).to_string()
}

struct Collector {
    fields: Map<String, Value>,
}

impl Collector {
    fn put(&mut self, field: &Field, raw: Raw) {
        // Check the name first: disallowed fields (notably `message`) are never
        // formatted, let alone stored.
        let Some(kind) = fields::kind_of(field.name()) else {
            return;
        };
        if let Some(value) = fields::finish(kind, raw) {
            self.fields.insert(field.name().to_owned(), value);
        }
    }
}

impl Visit for Collector {
    fn record_str(&mut self, field: &Field, value: &str) {
        if fields::kind_of(field.name()).is_some() {
            self.put(field, Raw::Str(value.to_owned()));
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Raw::U64(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Raw::I64(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Raw::Bool(value));
    }
    // `%x` and `?x` arrive here. Only allowlisted fields are formatted, and the
    // result still has to pass the value-shape check.
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let Some(kind) = fields::kind_of(field.name()) else {
            return;
        };
        let text = format!("{value:?}");
        let text = text.trim_matches('"').to_owned();
        let raw = match kind {
            FieldKind::Count => match text.parse::<u64>() {
                Ok(n) => Raw::U64(n),
                Err(_) => return,
            },
            FieldKind::Flag => match text.as_str() {
                "true" => Raw::Bool(true),
                "false" => Raw::Bool(false),
                _ => return,
            },
            _ => Raw::Str(text),
        };
        self.put(field, raw);
    }
}

pub struct SafeLayer<K: LineSink> {
    sink: Arc<K>,
    clock: fn() -> SystemTime,
}

impl<K: LineSink> SafeLayer<K> {
    pub fn new(sink: Arc<K>) -> Self {
        Self {
            sink,
            clock: SystemTime::now,
        }
    }
}

fn level_name(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARN",
        Level::INFO => "INFO",
        Level::DEBUG => "DEBUG",
        Level::TRACE => "TRACE",
    }
}

impl<S: Subscriber, K: LineSink> Layer<S> for SafeLayer<K> {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let normalized = event.normalized_metadata();
        let meta = normalized.as_ref().unwrap_or_else(|| event.metadata());
        let target = meta.target();
        let level = meta.level();
        let now = (self.clock)();

        if !is_first_party(target) {
            if *level > Level::WARN {
                return;
            }
            let mut fields = Map::new();
            fields.insert("third_party".into(), Value::from(true));
            let target = if target_is_plain(target) {
                target
            } else {
                "other"
            };
            self.sink
                .write_line(render(now, level_name(level), target, fields));
            return;
        }

        let mut collector = Collector { fields: Map::new() };
        event.record(&mut collector);
        collector
            .fields
            .entry("event")
            .or_insert_with(|| Value::from("unnamed"));
        self.sink
            .write_line(render(now, level_name(level), target, collector.fields));
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;
    use tracing_subscriber::filter::LevelFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::{Registry, reload};

    #[derive(Default)]
    pub struct VecSink(pub Mutex<Vec<String>>);

    impl LineSink for VecSink {
        fn write_line(&self, line: String) {
            self.0.lock().unwrap().push(line);
        }
    }

    impl VecSink {
        pub fn lines(&self) -> Vec<Value> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
        pub fn raw(&self) -> String {
            self.0.lock().unwrap().join("\n")
        }
    }

    pub fn capture(
        level: LevelFilter,
        run: impl FnOnce(&reload::Handle<LevelFilter, Registry>),
    ) -> Arc<VecSink> {
        let sink = Arc::new(VecSink::default());
        let (filter, handle) = reload::Layer::new(level);
        let subscriber = Registry::default()
            .with(filter)
            .with(SafeLayer::new(sink.clone()));
        tracing::subscriber::with_default(subscriber, || run(&handle));
        sink
    }

    #[test]
    fn records_allowlisted_fields_only() {
        let sink = capture(LevelFilter::TRACE, |_| {
            tracing::info!(
                event = "app.start",
                version = "0.1.0",
                os = "windows",
                count = 3u64,
                enabled = true,
                password = "hunter2",
                host = "secret.example.com",
                username = "root",
                key_path = "C:\\Users\\me\\.ssh\\id_ed25519",
                "message with password=hunter2"
            );
        });
        let lines = sink.lines();
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert_eq!(line["event"], "app.start");
        assert_eq!(line["version"], "0.1.0");
        assert_eq!(line["count"], 3);
        assert_eq!(line["enabled"], true);
        let raw = sink.raw();
        for secret in [
            "hunter2",
            "secret.example.com",
            "root",
            "id_ed25519",
            "message",
        ] {
            assert!(!raw.contains(secret), "leaked {secret}: {raw}");
        }
    }

    #[test]
    fn allowlisted_field_with_hostile_value_is_neutralised_at_every_level() {
        let sink = capture(LevelFilter::TRACE, |_| {
            tracing::trace!(
                event = "test.xy",
                error_kind = "root@10.0.0.1:/etc/shadow secret"
            );
            tracing::debug!(event = "test.xy", auth_kind = %"password=hunter2");
            tracing::info!(
                event = "test.xy",
                session_id = "not-a-uuid-but-a-hostname.example.com"
            );
            tracing::warn!(event = "test.xy", file = "C:\\Users\\me\\settings.json");
        });
        let raw = sink.raw();
        for leaked in [
            "root@",
            "10.0.0.1",
            "etc/shadow",
            "hunter2",
            "hostname.example",
            "C:\\\\Users",
        ] {
            assert!(!raw.contains(leaked), "leaked {leaked}: {raw}");
        }
        assert_eq!(sink.lines().len(), 4);
        assert!(raw.contains("<invalid>"));
    }

    #[test]
    fn debug_formatted_values_are_still_validated() {
        let sink = capture(LevelFilter::TRACE, |_| {
            let secret = String::from("hunter2");
            tracing::info!(event = "test.xy", reason = ?secret, count = ?"abc");
        });
        let raw = sink.raw();
        assert!(!raw.contains("hunter2"));
        assert!(!raw.contains("abc"));
    }

    #[test]
    fn third_party_events_carry_no_text_and_only_warn_and_above() {
        let sink = capture(LevelFilter::TRACE, |_| {
            tracing::error!(target: "russh::client", "failed for user root at 10.0.0.9 password hunter2");
            tracing::warn!(target: "wry", event = "app.start", host = "h.example.com", "x");
            tracing::info!(target: "tauri::app", "info text");
            tracing::debug!(target: "russh::client", "packet bytes 00ff");
            tracing::trace!(target: "russh::client", "packet bytes 00ff");
        });
        let lines = sink.lines();
        assert_eq!(lines.len(), 2);
        for line in &lines {
            assert_eq!(line["third_party"], true);
            assert!(line.get("event").is_none());
            assert!(line.get("message").is_none());
        }
        let raw = sink.raw();
        for leaked in [
            "root",
            "10.0.0.9",
            "hunter2",
            "h.example",
            "packet",
            "info text",
        ] {
            assert!(!raw.contains(leaked), "leaked {leaked}");
        }
    }

    #[test]
    fn level_filter_applies_and_can_change_at_runtime() {
        let sink = capture(LevelFilter::WARN, |handle| {
            tracing::info!(event = "test.a_dropped");
            tracing::warn!(event = "test.a_kept");
            handle.modify(|f| *f = LevelFilter::TRACE).unwrap();
            tracing::trace!(event = "test.b_kept");
            handle.modify(|f| *f = LevelFilter::ERROR).unwrap();
            tracing::warn!(event = "test.c_dropped");
            tracing::error!(event = "test.c_kept");
            handle.modify(|f| *f = LevelFilter::OFF).unwrap();
            tracing::error!(event = "test.d_dropped");
        });
        let events: Vec<String> = sink
            .lines()
            .iter()
            .map(|l| l["event"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(events, ["test.a_kept", "test.b_kept", "test.c_kept"]);
    }

    #[test]
    fn missing_event_name_is_marked_and_lines_are_valid_json() {
        let sink = capture(LevelFilter::INFO, |_| {
            tracing::info!("just text");
        });
        let lines = sink.lines();
        assert_eq!(lines[0]["event"], "unnamed");
        assert_eq!(lines[0]["level"], "INFO");
        assert!(lines[0]["ts"].as_str().unwrap().ends_with('Z'));
        assert!(!sink.raw().contains("just text"));
    }

    #[test]
    fn log_crate_records_are_treated_as_third_party() {
        // `log`-bridged records are normalised by tracing-log; they carry text
        // we do not control, so only the marker line may appear.
        let sink = capture(LevelFilter::TRACE, |_| {
            tracing::warn!(target: "log", "from log crate: password=hunter2");
        });
        assert!(!sink.raw().contains("hunter2"));
    }
}
