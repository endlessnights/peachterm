//! Keyboard shortcut definitions and validation.
//!
//! Actions, defaults and reserved combinations come from
//! `src/shared/shortcutDefaults.json`, which the renderer reads too, so both
//! sides always agree. Only *overrides* are stored in settings; an unassigned
//! action is stored as an empty string.
//!
//! Accelerator syntax: modifiers `Mod` (Ctrl on Windows/Linux, Cmd on macOS),
//! `Ctrl`, `Alt`, `Shift`, `Meta`, then one key, joined by `+`, in that
//! canonical order, e.g. `Mod+Shift+L`, `F2`, `Ctrl+Tab`.

use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

const DEFINITIONS: &str = include_str!("../../../src/shared/shortcutDefaults.json");

#[derive(Debug, Deserialize)]
struct Definitions {
    actions: Vec<ActionDef>,
    reserved: Vec<ReservedDef>,
    #[serde(rename = "reservedMac")]
    reserved_mac: Vec<ReservedDef>,
}

#[derive(Debug, Deserialize)]
pub struct ActionDef {
    pub id: String,
    pub default: String,
}

#[derive(Debug, Deserialize)]
struct ReservedDef {
    accel: String,
    reason: String,
}

fn definitions() -> &'static Definitions {
    static DEFS: OnceLock<Definitions> = OnceLock::new();
    DEFS.get_or_init(|| serde_json::from_str(DEFINITIONS).expect("shortcutDefaults.json is valid"))
}

pub fn actions() -> &'static [ActionDef] {
    &definitions().actions
}

/// A parsed key combination with `Mod` already resolved for this OS.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Combo {
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    key: String,
}

const NAMED_KEYS: &[&str] = &[
    "Tab",
    "Enter",
    "Escape",
    "Space",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
];
const PUNCTUATION: &str = ",./;'[]\\-=`";

fn key_is_valid(key: &str) -> bool {
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => c.is_ascii_uppercase() || c.is_ascii_digit() || PUNCTUATION.contains(c),
        _ => {
            NAMED_KEYS.contains(&key)
                || key
                    .strip_prefix('F')
                    .and_then(|n| n.parse::<u8>().ok())
                    .is_some_and(|n| (1..=24).contains(&n))
        }
    }
}

fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n))
}

/// Parse and canonicalize. `mac` selects what `Mod` means.
pub fn parse(accel: &str, mac: bool) -> Result<(Combo, String), String> {
    let parts: Vec<&str> = accel.split('+').collect();
    let (key, modifiers) = parts
        .split_last()
        .ok_or_else(|| "empty shortcut".to_owned())?;
    if !key_is_valid(key) {
        return Err(format!("unsupported key \"{key}\""));
    }
    let (mut m, mut ctrl, mut alt, mut shift, mut meta) = (false, false, false, false, false);
    for modifier in modifiers {
        let flag = match *modifier {
            "Mod" => &mut m,
            "Ctrl" => &mut ctrl,
            "Alt" => &mut alt,
            "Shift" => &mut shift,
            "Meta" => &mut meta,
            other => return Err(format!("unknown modifier \"{other}\"")),
        };
        if *flag {
            return Err("a modifier is repeated".to_owned());
        }
        *flag = true;
    }
    if modifiers.is_empty() && !is_function_key(key) {
        return Err("needs at least one modifier key (only F1–F12 may be used alone)".to_owned());
    }
    let canonical = [
        (m, "Mod"),
        (ctrl, "Ctrl"),
        (alt, "Alt"),
        (shift, "Shift"),
        (meta, "Meta"),
    ]
    .iter()
    .filter(|(on, _)| *on)
    .map(|(_, name)| *name)
    .chain(std::iter::once(*key))
    .collect::<Vec<_>>()
    .join("+");
    let combo = Combo {
        ctrl: ctrl || (m && !mac),
        meta: meta || (m && mac),
        alt,
        shift,
        key: (*key).to_owned(),
    };
    Ok((combo, canonical))
}

fn reserved_reason(combo: &Combo, mac: bool) -> Option<String> {
    let defs = definitions();
    let lists: &[&Vec<ReservedDef>] = if mac {
        &[&defs.reserved, &defs.reserved_mac]
    } else {
        &[&defs.reserved]
    };
    for list in lists {
        for entry in list.iter() {
            if parse(&entry.accel, mac).is_ok_and(|(c, _)| &c == combo) {
                return Some(entry.reason.clone());
            }
        }
    }
    if !mac && combo.meta {
        return Some("uses the Windows/Super key, which the operating system owns".to_owned());
    }
    None
}

/// Effective binding for every action: override, else default.
fn effective(overrides: &BTreeMap<String, String>) -> Vec<(&'static str, String)> {
    actions()
        .iter()
        .map(|a| {
            (
                a.id.as_str(),
                overrides
                    .get(&a.id)
                    .cloned()
                    .unwrap_or_else(|| a.default.clone()),
            )
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub action: String,
    pub message: String,
}

fn check_for(overrides: &BTreeMap<String, String>, mac: bool) -> Vec<Problem> {
    let mut problems = Vec::new();
    for id in overrides.keys() {
        if !actions().iter().any(|a| &a.id == id) {
            problems.push(Problem {
                action: id.clone(),
                message: "unknown action".into(),
            });
        }
    }
    let mut seen: HashMap<Combo, &str> = HashMap::new();
    for (id, accel) in effective(overrides) {
        if accel.is_empty() {
            continue; // deliberately unassigned
        }
        match parse(&accel, mac) {
            Err(why) => problems.push(Problem {
                action: id.to_owned(),
                message: format!("invalid shortcut: {why}"),
            }),
            Ok((combo, _)) => {
                if let Some(reason) = reserved_reason(&combo, mac) {
                    problems.push(Problem {
                        action: id.to_owned(),
                        message: format!("is reserved: it {reason}"),
                    });
                } else if let Some(other) = seen.insert(combo, id) {
                    problems.push(Problem {
                        action: id.to_owned(),
                        message: format!("is already used by \"{other}\""),
                    });
                }
            }
        }
    }
    problems
}

pub fn check(overrides: &BTreeMap<String, String>) -> Vec<Problem> {
    check_for(overrides, cfg!(target_os = "macos"))
}

/// Validation used when the user saves settings.
pub fn validate(overrides: &BTreeMap<String, String>) -> Result<(), String> {
    match check(overrides).first() {
        None => Ok(()),
        Some(p) => Err(format!("Shortcut \"{}\" {}", p.action, p.message)),
    }
}

/// For files loaded from disk: if the overrides are not valid as a whole, keep
/// every override that is valid on top of the ones already kept and drop the
/// rest (their actions fall back to defaults). Returns the dropped action ids.
pub fn sanitize(overrides: &mut BTreeMap<String, String>) -> Vec<String> {
    if check(overrides).is_empty() {
        return Vec::new();
    }
    let mut dropped = Vec::new();
    for (action, accel) in std::mem::take(overrides) {
        overrides.insert(action.clone(), accel);
        if !check(overrides).is_empty() {
            overrides.remove(&action);
            dropped.push(action);
        }
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    #[test]
    fn defaults_are_valid_unique_and_unreserved_on_every_platform() {
        for mac in [false, true] {
            assert_eq!(check_for(&BTreeMap::new(), mac), vec![], "mac={mac}");
        }
        let ids: std::collections::HashSet<_> = actions().iter().map(|a| &a.id).collect();
        assert_eq!(ids.len(), actions().len());
    }

    #[test]
    fn parsing_canonicalizes_and_resolves_mod_per_platform() {
        let (win, canon) = parse("Mod+Shift+L", false).unwrap();
        assert_eq!(canon, "Mod+Shift+L");
        assert!(win.ctrl && !win.meta && win.shift);
        let (mac, _) = parse("Mod+Shift+L", true).unwrap();
        assert!(mac.meta && !mac.ctrl);
        assert_eq!(parse("F2", false).unwrap().1, "F2");
        assert_eq!(parse("Mod+,", false).unwrap().1, "Mod+,");
    }

    #[test]
    fn rejects_malformed_accelerators() {
        for bad in [
            "",
            "L",
            "Mod+",
            "Mod+Shift",
            "Mod+Mod+L",
            "Hyper+L",
            "Mod+ab",
            "Mod+l",
            "Mod++",
            "Mod+F25",
        ] {
            assert!(parse(bad, false).is_err(), "{bad}");
        }
        assert!(parse("F12", false).is_ok());
    }

    #[test]
    fn detects_duplicates_including_mod_ctrl_aliasing() {
        let problems = check_for(&map(&[("closeTab", "Mod+T")]), false);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].action, "closeTab");
        assert!(problems[0].message.contains("newTab"));
        // On Windows/Linux `Mod` and `Ctrl` are the same key; on macOS they differ.
        assert_eq!(check_for(&map(&[("closeTab", "Ctrl+T")]), false).len(), 1);
        assert!(check_for(&map(&[("closeTab", "Ctrl+T")]), true).is_empty());
    }

    #[test]
    fn swapping_two_bindings_is_allowed() {
        let swapped = map(&[("newTab", "Mod+W"), ("closeTab", "Mod+T")]);
        assert!(check_for(&swapped, false).is_empty());
    }

    #[test]
    fn reserved_combinations_are_refused_with_a_reason() {
        for accel in [
            "F5",
            "Mod+R",
            "Mod+Shift+I",
            "Alt+F4",
            "Ctrl+Alt+Delete",
            "F12",
        ] {
            let p = check_for(&map(&[("lockApp", accel)]), false);
            assert!(
                p.iter()
                    .any(|p| p.action == "lockApp" && p.message.contains("reserved")),
                "{accel}: {p:?}"
            );
        }
        let mac = check_for(&map(&[("lockApp", "Meta+Q")]), true);
        assert!(mac.iter().any(|p| p.message.contains("macOS")));
        // Windows/Super combinations belong to the OS on Windows/Linux.
        assert!(!check_for(&map(&[("lockApp", "Meta+L")]), false).is_empty());
    }

    #[test]
    fn unassigning_is_allowed_and_frees_the_combination() {
        let cleared = map(&[("newTab", ""), ("closeTab", "Mod+T")]);
        assert!(check_for(&cleared, false).is_empty());
    }

    #[test]
    fn unknown_actions_are_reported_and_sanitize_keeps_good_entries() {
        let mut o = map(&[
            ("lockApp", "Mod+Shift+K"),
            ("ghost", "Mod+Shift+G"),
            ("newTab", "F5"),
            ("closeTab", "Mod+N"),
        ]);
        let dropped = sanitize(&mut o);
        assert_eq!(o, map(&[("lockApp", "Mod+Shift+K")]));
        assert_eq!(dropped.len(), 3);
        assert!(validate(&o).is_ok());
    }

    #[test]
    fn validate_message_names_the_action() {
        let err = validate(&map(&[("lockApp", "F5")])).unwrap_err();
        assert!(err.contains("lockApp") && err.contains("reserved"), "{err}");
    }
}
