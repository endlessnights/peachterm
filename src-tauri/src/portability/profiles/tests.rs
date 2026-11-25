// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

pub(crate) fn conn(name: &str, host: &str, port: u16, user: &str) -> Connection {
    Connection {
        monitoring: Default::default(),
        id: Uuid::new_v4(),
        name: name.into(),
        host: host.into(),
        port,
        username: user.into(),
        auth: AuthMethod::Password,
        key_path: None,
        save_password: false,
        has_stored_secret: false,
        timeout_secs: 15,
        initial_directory: None,
        folder_id: None,
        sort_order: 0,
        created_at: 1,
        updated_at: 1,
    }
}

pub(crate) fn folder(name: &str, parent: Option<Uuid>) -> Folder {
    Folder {
        id: Uuid::new_v4(),
        name: name.into(),
        parent_id: parent,
        expanded: true,
        sort_order: 0,
    }
}

fn export_json(
    tree: &ConnectionTree,
    sel: Option<&HashSet<Uuid>>,
    keys: bool,
) -> (Value, ExportStats) {
    let (doc, stats) = build_export(tree, sel, keys, "2026-11-23T12:00:00Z".into());
    (
        serde_json::from_slice(&export_to_bytes(&doc).unwrap()).unwrap(),
        stats,
    )
}

fn parse(v: Value) -> Parsed {
    parse_document(&serde_json::to_vec(&v).unwrap()).unwrap()
}

fn doc(folders: Value, connections: Value) -> Value {
    json!({"format": FORMAT, "formatVersion": 1, "folders": folders, "connections": connections})
}

fn sample_conn(id: &str, host: &str) -> Value {
    json!({"id": id, "name": "n", "host": host, "port": 22, "username": "root"})
}

const ID1: &str = "11111111-1111-4111-8111-111111111111";
const ID2: &str = "22222222-2222-4222-8222-222222222222";
const ID3: &str = "33333333-3333-4333-8333-333333333333";

// ---- export ----------------------------------------------------------------

#[test]
fn empty_export_is_a_valid_document() {
    let (v, stats) = export_json(&ConnectionTree::default(), None, false);
    assert_eq!(v["format"], "peachterm-connections");
    assert_eq!(v["formatVersion"], 1);
    assert_eq!(v["application"], "PeachTerm");
    assert_eq!(v["folders"], json!([]));
    assert_eq!(v["connections"], json!([]));
    assert_eq!(stats.connections, 0);
    let parsed = parse(v);
    assert!(parsed.invalid.is_empty() && parsed.incoming.connections.is_empty());
}

#[test]
fn export_never_contains_local_ids_secrets_or_internal_flags() {
    let mut c = conn("srv", "10.0.0.1", 22, "root");
    c.has_stored_secret = true;
    c.save_password = true;
    c.key_path = Some("/home/me/.ssh/id_ed25519".into());
    let tree = ConnectionTree {
        connections: vec![c.clone()],
        ..Default::default()
    };
    let (v, _) = export_json(&tree, None, false);
    let text = v.to_string();
    assert!(
        !text.contains(&c.id.to_string()),
        "local id (credential account) leaked"
    );
    assert!(!text.contains("connection:"));
    assert!(!text.contains("hasStoredSecret"));
    assert!(!text.contains("id_ed25519"), "key path must be opt-in");
    assert!(!text.contains("createdAt") && !text.contains("updatedAt"));
    let item = &v["connections"][0];
    assert_eq!(item["savePassword"], true);
    assert_eq!(item["protocol"], "ssh");
    // Only the allowlisted keys exist.
    let keys: BTreeSet<&str> = item
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let allowed: BTreeSet<&str> = [
        "id",
        "name",
        "protocol",
        "host",
        "port",
        "username",
        "auth",
        "folder",
        "order",
        "savePassword",
        "timeoutSecs",
        "initialDirectory",
    ]
    .into();
    assert_eq!(keys, allowed);
}

#[test]
fn key_paths_are_exported_only_on_request() {
    let mut c = conn("srv", "h", 22, "u");
    c.auth = AuthMethod::PublicKey;
    c.key_path = Some("/home/me/key".into());
    let tree = ConnectionTree {
        connections: vec![c],
        ..Default::default()
    };
    let (v, s) = export_json(&tree, None, true);
    assert_eq!(v["connections"][0]["keyPath"], "/home/me/key");
    assert_eq!(s.key_paths, 1);
    let (v, s) = export_json(&tree, None, false);
    assert!(v["connections"][0].get("keyPath").is_none());
    assert_eq!(s.key_paths, 0);
}

#[test]
fn public_ids_are_stable_one_way_and_distinct() {
    let a = Uuid::new_v4();
    assert_eq!(public_id(a), public_id(a));
    assert_ne!(public_id(a), a);
    assert_ne!(public_id(a), public_id(Uuid::new_v4()));
}

#[test]
fn unicode_ipv6_ports_and_hierarchy_survive_a_round_trip() {
    let top = folder("Продакшен 🚀", None);
    let sub = folder("Сервера / БД", Some(top.id));
    let mut a = conn("Главный сервер", "2001:db8::1", 2222, "админ");
    a.folder_id = Some(sub.id);
    a.initial_directory = Some("/var/www/сайт".into());
    let mut b = conn("日本語サーバー", "[fe80::1%eth0]", 22022, "root");
    b.folder_id = Some(top.id);
    let c = conn("plain", "example.org", 22, "");
    let tree = ConnectionTree {
        folders: vec![top, sub],
        connections: vec![a, b, c],
        ..Default::default()
    };
    let (v, stats) = export_json(&tree, None, false);
    assert_eq!((stats.connections, stats.folders), (3, 2));
    let parsed = parse(v);
    assert!(parsed.invalid.is_empty(), "{:?}", parsed.invalid);
    let set = parsed.incoming;
    let ru = set
        .connections
        .iter()
        .find(|c| c.name == "Главный сервер")
        .unwrap();
    assert_eq!(
        (ru.host.as_str(), ru.port, ru.username.as_str()),
        ("2001:db8::1", 2222, "админ")
    );
    assert_eq!(ru.initial_directory.as_deref(), Some("/var/www/сайт"));
    assert_eq!(
        folder_path(&set, ru.folder.as_deref()),
        "Продакшен 🚀 / Сервера / БД"
    );
    let jp = set
        .connections
        .iter()
        .find(|c| c.name == "日本語サーバー")
        .unwrap();
    assert_eq!(jp.port, 22022);
    assert_eq!(
        jp.host, "fe80::1%eth0",
        "brackets are normalised by the shared host validator"
    );
}

#[test]
fn selected_export_includes_only_needed_folders() {
    let a = folder("A", None);
    let b = folder("B", None);
    let sub = folder("Sub", Some(a.id));
    let mut in_sub = conn("one", "h1", 22, "u");
    in_sub.folder_id = Some(sub.id);
    let mut in_b = conn("two", "h2", 22, "u");
    in_b.folder_id = Some(b.id);
    let tree = ConnectionTree {
        folders: vec![a, b, sub],
        connections: vec![in_sub.clone(), in_b],
        ..Default::default()
    };
    let sel: HashSet<Uuid> = [in_sub.id].into();
    let (v, stats) = export_json(&tree, Some(&sel), false);
    assert_eq!((stats.connections, stats.folders), (1, 2));
    let names: Vec<_> = v["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["A", "Sub"]);
}

#[test]
fn hundreds_of_connections_keep_their_order() {
    let mut tree = ConnectionTree::default();
    for i in 0..500 {
        let mut c = conn(
            &format!("host-{i:03}"),
            &format!("h{i}.example.org"),
            22,
            "u",
        );
        c.sort_order = (500 - i) as i64; // reversed on purpose
        tree.connections.push(c);
    }
    let (v, stats) = export_json(&tree, None, false);
    assert_eq!(stats.connections, 500);
    let parsed = parse(v);
    assert_eq!(parsed.incoming.connections.len(), 500);
    let merged = merge(
        &ConnectionTree::default(),
        &MergeRequest {
            incoming: &parsed.incoming,
            selected: None,
            policy: DuplicatePolicy::Skip,
            update: &HashSet::new(),
            preserve_ids: false,
            now: 5,
        },
    )
    .unwrap();
    let order = merged.tree.sorted_children(None, false);
    let names: Vec<String> = order
        .iter()
        .map(|i| match i {
            ItemRef::Connection { id } => merged
                .tree
                .connections
                .iter()
                .find(|c| c.id == *id)
                .unwrap()
                .name
                .clone(),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(names.first().unwrap(), "host-499");
    assert_eq!(names.last().unwrap(), "host-000");
}

// ---- parsing / validation ---------------------------------------------------

#[test]
fn invalid_json_and_foreign_documents_are_refused() {
    assert!(parse_document(b"{not json").is_err());
    assert!(parse_document(b"[]").is_err());
    assert!(parse_document(b"{}").is_err());
    assert!(parse_document(br#"{"format":"putty","formatVersion":1}"#).is_err());
    assert!(parse_document(br#"{"format":"peachterm-connections"}"#).is_err());
    assert!(parse_document(br#"{"format":"peachterm-connections","formatVersion":0}"#).is_err());
    assert!(parse_document(br#"{"format":"peachterm-connections","formatVersion":"1"}"#).is_err());
    let newer =
        parse_document(br#"{"format":"peachterm-connections","formatVersion":2}"#).unwrap_err();
    assert!(newer.to_string().contains("newer version"));
}

#[test]
fn bom_is_tolerated() {
    let mut bytes = b"\xEF\xBB\xBF".to_vec();
    bytes.extend_from_slice(br#"{"format":"peachterm-connections","formatVersion":1}"#);
    assert!(parse_document(&bytes).is_ok());
}

#[test]
fn too_many_records_are_refused() {
    let many: Vec<Value> = (0..MAX_CONNECTIONS + 1).map(|_| json!({})).collect();
    let text = serde_json::to_vec(&doc(json!([]), Value::Array(many))).unwrap();
    assert!(parse_document(&text).is_err());
    let many: Vec<Value> = (0..MAX_FOLDERS + 1).map(|_| json!({})).collect();
    let text = serde_json::to_vec(&doc(Value::Array(many), json!([]))).unwrap();
    assert!(parse_document(&text).is_err());
}

#[test]
fn bad_records_are_reported_and_the_rest_is_kept() {
    let good = sample_conn(ID1, "ok.example.org");
    let mut bad_port = sample_conn(ID2, "h");
    bad_port["port"] = json!(70000);
    let mut zero_port = sample_conn(ID3, "h");
    zero_port["port"] = json!(0);
    let mut float_port = sample_conn("44444444-4444-4444-8444-444444444444", "h");
    float_port["port"] = json!(22.5);
    let mut text_port = sample_conn("55555555-5555-4555-8555-555555555555", "h");
    text_port["port"] = json!("22");
    let mut bad_host = sample_conn("66666666-6666-4666-8666-666666666666", "bad host;rm -rf");
    bad_host["name"] = json!("x");
    let mut bad_auth = sample_conn("77777777-7777-4777-8777-777777777777", "h");
    bad_auth["auth"] = json!("kerberos");
    let mut bad_proto = sample_conn("88888888-8888-4888-8888-888888888888", "h");
    bad_proto["protocol"] = json!("telnet");
    let mut long_name = sample_conn("99999999-9999-4999-8999-999999999999", "h");
    long_name["name"] = json!("x".repeat(500));
    let mut bad_user = sample_conn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "h");
    bad_user["username"] = json!("a@b");
    let mut bad_id = sample_conn("not-a-uuid", "h");
    bad_id["name"] = json!("y");
    let parsed = parse(doc(
        json!([]),
        json!([
            good, bad_port, zero_port, float_port, text_port, bad_host, bad_auth, bad_proto,
            long_name, bad_user, bad_id, 5, "s"
        ]),
    ));
    assert_eq!(parsed.incoming.connections.len(), 1);
    assert_eq!(parsed.invalid.len(), 12);
    assert!(parsed.invalid.iter().all(|i| i.kind == "connection"));
}

#[test]
fn duplicate_ids_inside_a_file_are_flagged() {
    let parsed = parse(doc(
        json!([]),
        json!([sample_conn(ID1, "a"), sample_conn(ID1, "b")]),
    ));
    assert_eq!(parsed.incoming.connections.len(), 1);
    assert_eq!(parsed.invalid[0].reason, "duplicate id");
}

#[test]
fn folder_cycles_dangling_parents_and_excess_depth_are_rejected() {
    let f = |id: &str, parent: Option<&str>| json!({"id": id, "name": id, "parent": parent});
    let parsed = parse(doc(
        json!([
            f("ok1", None),
            f("ok2", Some("ok1")),
            f("ok3", Some("ok2")),
            f("deep", Some("ok3")), // level 4
            f("under-deep", Some("deep")),
            f("cycA", Some("cycB")),
            f("cycB", Some("cycA")),
            f("self", Some("self")),
            f("orphan", Some("missing")),
            f("ok1", None), // duplicate id
        ]),
        json!([]),
    ));
    let keys: BTreeSet<_> = parsed
        .incoming
        .folders
        .iter()
        .map(|f| f.key.as_str())
        .collect();
    assert_eq!(keys, BTreeSet::from(["ok1", "ok2", "ok3"]));
    assert_eq!(parsed.invalid.len(), 7);
}

#[test]
fn connections_in_unusable_folders_are_relocated_to_the_nearest_usable_ancestor() {
    let f = |id: &str, parent: Option<&str>| json!({"id": id, "name": id, "parent": parent});
    let mut deep = sample_conn(ID1, "a");
    deep["folder"] = json!("deep");
    let mut nowhere = sample_conn(ID2, "b");
    nowhere["folder"] = json!("ghost");
    let mut fine = sample_conn(ID3, "c");
    fine["folder"] = json!("l2");
    let parsed = parse(doc(
        json!([
            f("l1", None),
            f("l2", Some("l1")),
            f("l3", Some("l2")),
            f("deep", Some("l3"))
        ]),
        json!([deep, nowhere, fine]),
    ));
    assert_eq!(parsed.relocated, 2);
    let by_name = |h: &str| {
        parsed
            .incoming
            .connections
            .iter()
            .find(|c| c.host == h)
            .unwrap()
    };
    assert_eq!(
        by_name("a").folder.as_deref(),
        Some("l3"),
        "not flattened to the root"
    );
    assert_eq!(by_name("b").folder, None);
    assert_eq!(by_name("c").folder.as_deref(), Some("l2"));
}

#[test]
fn unsupported_fields_are_named_but_never_imported() {
    let mut c = sample_conn(ID1, "h");
    c["password"] = json!("hunter2-should-never-be-read");
    c["passphrase"] = json!("x");
    c["onConnect"] = json!("rm -rf /");
    let mut v = doc(json!([]), json!([c]));
    v["extra"] = json!(1);
    let parsed = parse(v);
    assert_eq!(parsed.incoming.connections.len(), 1);
    let names: Vec<_> = parsed.unsupported_fields.iter().cloned().collect();
    assert!(names.contains(&"connections.password".to_owned()));
    assert!(names.contains(&"connections.onConnect".to_owned()));
    assert!(names.contains(&"extra".to_owned()));
    assert!(
        !format!("{names:?}").contains("hunter2"),
        "values are never echoed"
    );
}

// ---- duplicate detection & merge ------------------------------------------

fn incoming_of(list: Vec<IncomingConnection>) -> IncomingSet {
    IncomingSet {
        folders: vec![],
        connections: list,
    }
}

fn inc(name: &str, host: &str, port: u16, user: &str) -> IncomingConnection {
    IncomingConnection {
        id_hint: None,
        stable_hint: None,
        name: name.into(),
        host: host.into(),
        port,
        username: user.into(),
        auth: AuthMethod::Password,
        key_path: None,
        save_password: false,
        timeout_secs: 15,
        initial_directory: None,
        folder: None,
        order: 0,
        created_at: None,
        updated_at: None,
    }
}

fn run(
    base: &ConnectionTree,
    set: &IncomingSet,
    policy: DuplicatePolicy,
    update: &[usize],
) -> MergeResult {
    let update: HashSet<usize> = update.iter().copied().collect();
    merge(
        base,
        &MergeRequest {
            incoming: set,
            selected: None,
            policy,
            update: &update,
            preserve_ids: false,
            now: 99,
        },
    )
    .unwrap()
}

#[test]
fn different_username_on_the_same_host_is_not_a_duplicate() {
    let base = ConnectionTree {
        connections: vec![conn("a", "host.example.org", 22, "alice")],
        ..Default::default()
    };
    assert_eq!(
        classify(&base, &inc("b", "host.example.org", 22, "bob")),
        Match::New
    );
    assert_eq!(
        classify(&base, &inc("b", "host.example.org", 2222, "alice")),
        Match::New
    );
    assert!(matches!(
        classify(&base, &inc("b", "HOST.example.org", 22, "alice")),
        Match::Duplicate(_)
    ));
    assert_eq!(
        classify(&base, &inc("b", "host.example.org", 22, "Alice")),
        Match::New,
        "user names are case-sensitive"
    );
}

#[test]
fn ipv6_brackets_do_not_hide_duplicates() {
    let base = ConnectionTree {
        connections: vec![conn("a", "[2001:DB8::1]", 22, "u")],
        ..Default::default()
    };
    assert!(matches!(
        classify(&base, &inc("b", "2001:db8::1", 22, "u")),
        Match::Duplicate(_)
    ));
}

#[test]
fn id_match_detects_a_changed_endpoint() {
    let local = conn("a", "old.example.org", 22, "u");
    let base = ConnectionTree {
        connections: vec![local.clone()],
        ..Default::default()
    };
    let mut c = inc("a", "new.example.org", 22, "u");
    c.stable_hint = Some(public_id(local.id));
    assert_eq!(classify(&base, &c), Match::Changed(local.id));
    c.host = "old.example.org".into();
    assert_eq!(classify(&base, &c), Match::Duplicate(local.id));
}

#[test]
fn skip_is_the_safe_default_and_changes_nothing_for_duplicates() {
    let mut existing = conn("mine", "h", 22, "u");
    existing.has_stored_secret = true;
    let base = ConnectionTree {
        connections: vec![existing.clone()],
        ..Default::default()
    };
    let set = incoming_of(vec![
        inc("theirs", "h", 22, "u"),
        inc("new", "other", 22, "u"),
    ]);
    let r = run(&base, &set, DuplicatePolicy::Skip, &[]);
    assert_eq!(r.tree.connections.len(), 2);
    assert_eq!(
        r.tree.connections[0], existing,
        "existing profile is byte-for-byte unchanged"
    );
    assert!(matches!(r.outcomes[0], Outcome::SkippedDuplicate(id) if id == existing.id));
    assert!(matches!(r.outcomes[1], Outcome::Created(_)));
    assert!(!r.tree.connections[1].has_stored_secret);
}

#[test]
fn copies_get_new_ids_and_a_suffix() {
    let existing = conn("srv", "h", 22, "u");
    let base = ConnectionTree {
        connections: vec![existing.clone()],
        ..Default::default()
    };
    let set = incoming_of(vec![inc(&"x".repeat(128), "h", 22, "u")]);
    let r = run(&base, &set, DuplicatePolicy::Copy, &[]);
    let Outcome::Copied(id) = r.outcomes[0] else {
        panic!()
    };
    assert_ne!(id, existing.id);
    let copy = r.tree.connections.iter().find(|c| c.id == id).unwrap();
    assert!(copy.name.ends_with(" (copy)") && copy.name.chars().count() <= 128);
    assert!(!copy.has_stored_secret);
    assert_eq!(
        r.tree
            .connections
            .iter()
            .find(|c| c.id == existing.id)
            .unwrap(),
        &existing
    );
}

#[test]
fn update_changes_only_selected_non_identity_fields_and_keeps_the_secret() {
    let mut a = conn("old name", "h", 22, "u");
    a.has_stored_secret = true;
    a.save_password = true;
    a.key_path = Some("/keep/me".into());
    a.folder_id = None;
    let b = conn("untouched", "h2", 22, "u");
    let base = ConnectionTree {
        connections: vec![a.clone(), b.clone()],
        ..Default::default()
    };
    let mut ia = inc("new name", "h", 22, "u");
    ia.timeout_secs = 99;
    ia.auth = AuthMethod::Agent;
    ia.initial_directory = Some("/srv".into());
    let ib = inc("renamed", "h2", 22, "u");
    let set = incoming_of(vec![ia, ib]);
    let r = run(&base, &set, DuplicatePolicy::Update, &[0]);
    let updated = r.tree.connections.iter().find(|c| c.id == a.id).unwrap();
    assert_eq!(updated.name, "new name");
    assert_eq!(updated.timeout_secs, 99);
    assert_eq!(updated.auth, AuthMethod::Agent);
    assert_eq!(updated.initial_directory.as_deref(), Some("/srv"));
    assert_eq!(
        updated.key_path.as_deref(),
        Some("/keep/me"),
        "a missing key path never wipes a local one"
    );
    assert!(
        updated.has_stored_secret && updated.save_password,
        "stored secret flag untouched"
    );
    assert_eq!(
        (
            updated.host.as_str(),
            updated.port,
            updated.username.as_str()
        ),
        ("h", 22, "u")
    );
    assert_eq!(
        r.tree.connections.iter().find(|c| c.id == b.id).unwrap(),
        &b,
        "unselected duplicate untouched"
    );
    assert!(matches!(r.outcomes[0], Outcome::Updated(_)));
    assert!(matches!(r.outcomes[1], Outcome::SkippedDuplicate(_)));
}

#[test]
fn update_never_moves_a_profile_to_another_host() {
    let mut local = conn("a", "trusted.example.org", 22, "u");
    local.has_stored_secret = true;
    let base = ConnectionTree {
        connections: vec![local.clone()],
        ..Default::default()
    };
    let mut c = inc("a", "evil.example.org", 22, "u");
    c.stable_hint = Some(public_id(local.id));
    let r = run(&base, &incoming_of(vec![c]), DuplicatePolicy::Update, &[0]);
    assert!(matches!(r.outcomes[0], Outcome::SkippedChanged(_)));
    assert_eq!(
        r.tree.connections,
        vec![local],
        "the stored password cannot be redirected"
    );
}

#[test]
fn folders_are_reused_by_name_and_created_when_missing_without_flattening() {
    let root = folder("Prod", None);
    let base = ConnectionTree {
        folders: vec![root],
        ..Default::default()
    };
    let set = IncomingSet {
        folders: vec![
            IncomingFolder {
                key: "a".into(),
                parent: None,
                name: "prod".into(),
                expanded: true,
                order: 0,
                id_hint: None,
            },
            IncomingFolder {
                key: "b".into(),
                parent: Some("a".into()),
                name: "DB".into(),
                expanded: true,
                order: 0,
                id_hint: None,
            },
            IncomingFolder {
                key: "c".into(),
                parent: Some("b".into()),
                name: "Replicas".into(),
                expanded: false,
                order: 0,
                id_hint: None,
            },
            IncomingFolder {
                key: "e".into(),
                parent: None,
                name: "Empty".into(),
                expanded: true,
                order: 1,
                id_hint: None,
            },
        ],
        connections: vec![IncomingConnection {
            folder: Some("c".into()),
            ..inc("r1", "r1", 22, "u")
        }],
    };
    let r = run(&base, &set, DuplicatePolicy::Skip, &[]);
    assert_eq!(
        r.folders_created, 3,
        "DB, Replicas and the empty folder; Prod is reused"
    );
    assert_eq!(
        r.tree
            .folders
            .iter()
            .filter(|f| f.name.eq_ignore_ascii_case("prod"))
            .count(),
        1
    );
    let conn = &r.tree.connections[0];
    assert_eq!(r.tree.folder_level(conn.folder_id.unwrap()), 3);
    assert!(r.tree.too_deep_folders().is_empty());
}

#[test]
fn selected_import_creates_only_the_folders_it_needs() {
    let set = IncomingSet {
        folders: vec![
            IncomingFolder {
                key: "a".into(),
                parent: None,
                name: "A".into(),
                expanded: true,
                order: 0,
                id_hint: None,
            },
            IncomingFolder {
                key: "b".into(),
                parent: None,
                name: "B".into(),
                expanded: true,
                order: 1,
                id_hint: None,
            },
        ],
        connections: vec![
            IncomingConnection {
                folder: Some("a".into()),
                ..inc("one", "h1", 22, "u")
            },
            IncomingConnection {
                folder: Some("b".into()),
                ..inc("two", "h2", 22, "u")
            },
        ],
    };
    let sel: HashSet<usize> = [1].into();
    let r = merge(
        &ConnectionTree::default(),
        &MergeRequest {
            incoming: &set,
            selected: Some(&sel),
            policy: DuplicatePolicy::Skip,
            update: &HashSet::new(),
            preserve_ids: false,
            now: 1,
        },
    )
    .unwrap();
    assert_eq!(r.tree.folders.len(), 1);
    assert_eq!(r.tree.folders[0].name, "B");
    assert_eq!(r.outcomes[0], Outcome::NotSelected);
}

#[test]
fn imports_land_after_existing_siblings_in_file_order() {
    let mut first = conn("existing", "x", 22, "u");
    first.sort_order = 5;
    let base = ConnectionTree {
        connections: vec![first],
        ..Default::default()
    };
    let mut b = inc("b", "hb", 22, "u");
    b.order = 1;
    let mut a = inc("a", "ha", 22, "u");
    a.order = 0;
    let r = run(&base, &incoming_of(vec![b, a]), DuplicatePolicy::Skip, &[]);
    let order: Vec<String> = r
        .tree
        .sorted_children(None, false)
        .iter()
        .map(|i| match i {
            ItemRef::Connection { id } => r
                .tree
                .connections
                .iter()
                .find(|c| c.id == *id)
                .unwrap()
                .name
                .clone(),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(order, ["existing", "a", "b"]);
}

#[test]
fn merge_is_pure() {
    let base = ConnectionTree {
        connections: vec![conn("a", "h", 22, "u")],
        ..Default::default()
    };
    let before = base.clone();
    let _ = run(
        &base,
        &incoming_of(vec![inc("n", "z", 22, "u")]),
        DuplicatePolicy::Skip,
        &[],
    );
    assert_eq!(base, before);
}

#[test]
fn preserve_ids_keeps_free_ids_and_never_collides() {
    let taken = conn("t", "taken", 22, "u");
    let base = ConnectionTree {
        connections: vec![taken.clone()],
        ..Default::default()
    };
    let free = Uuid::new_v4();
    let mut a = inc("a", "ha", 22, "u");
    a.id_hint = Some(free);
    let mut b = inc("b", "hb", 22, "u");
    b.id_hint = Some(taken.id); // id in use, different endpoint -> "changed"; copy gets a fresh id
    let set = incoming_of(vec![a, b]);
    let r = merge(
        &base,
        &MergeRequest {
            incoming: &set,
            selected: None,
            policy: DuplicatePolicy::Copy,
            update: &HashSet::new(),
            preserve_ids: true,
            now: 1,
        },
    )
    .unwrap();
    assert_eq!(r.outcomes[0], Outcome::Created(free));
    let Outcome::Copied(copy_id) = r.outcomes[1] else {
        panic!()
    };
    assert_ne!(copy_id, taken.id);
    let ids: HashSet<_> = r.tree.connections.iter().map(|c| c.id).collect();
    assert_eq!(ids.len(), r.tree.connections.len());
}

/// A local absolute path that does not exist, valid on the platform running the test.
fn missing_absolute_path() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such-folder").join("key");
    assert!(missing.is_absolute());
    let text = missing.to_str().unwrap().to_owned();
    (dir, text)
}

#[test]
fn key_path_probe_never_touches_network_or_relative_paths() {
    assert_eq!(key_path_state(None), KeyPathState::None);
    assert_eq!(
        key_path_state(Some("\\\\attacker\\share\\key")),
        KeyPathState::Unchecked
    );
    assert_eq!(
        key_path_state(Some("//attacker/share/key")),
        KeyPathState::Unchecked
    );
    assert_eq!(
        key_path_state(Some("relative/key")),
        KeyPathState::Unchecked
    );
    assert_eq!(key_path_state(Some("")), KeyPathState::Unchecked);
    assert_eq!(key_path_state(Some("bad\0path")), KeyPathState::Unchecked);
    // A genuinely local absolute path is looked at, whatever the platform.
    let (_dir, missing) = missing_absolute_path();
    assert_eq!(key_path_state(Some(&missing)), KeyPathState::Missing);
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("k");
    std::fs::write(&key, "x").unwrap();
    assert_eq!(
        key_path_state(Some(key.to_str().unwrap())),
        KeyPathState::Present
    );
    // A folder is not a key file.
    assert_eq!(
        key_path_state(Some(dir.path().to_str().unwrap())),
        KeyPathState::Missing
    );
}

/// Windows: a rooted path without a drive (`\foo`, `/foo`) is not absolute
/// there, so it is never probed; UNC and device namespaces are never probed.
#[cfg(windows)]
#[test]
fn windows_paths_are_classified_by_windows_rules() {
    for unsafe_path in [
        "/definitely/not/here/key",
        "\\definitely\\not\\here",
        "\\\\server\\share\\key",
        "\\\\?\\UNC\\server\\share\\key",
        "\\\\.\\pipe\\name",
        "\\\\?\\C:\\Windows\\key",
        "//server/share/key",
        "C:key",
        "key.pem",
        "..\\key",
    ] {
        assert_eq!(
            key_path_state(Some(unsafe_path)),
            KeyPathState::Unchecked,
            "{unsafe_path}"
        );
    }
    assert_eq!(
        key_path_state(Some("C:\\definitely\\not\\here\\key")),
        KeyPathState::Missing
    );
}

/// Unix: drive-letter and backslash paths are ordinary relative names there.
#[cfg(unix)]
#[test]
fn unix_paths_are_classified_by_unix_rules() {
    for path in [
        "C:\\Users\\me\\key",
        "\\\\server\\share",
        "~/key",
        "./key",
        "../key",
    ] {
        assert_eq!(
            key_path_state(Some(path)),
            KeyPathState::Unchecked,
            "{path}"
        );
    }
    assert_eq!(
        key_path_state(Some("/definitely/not/here/key")),
        KeyPathState::Missing
    );
    assert_eq!(
        key_path_state(Some("//server/share/key")),
        KeyPathState::Unchecked,
        "a leading // is never probed, even though Unix treats it as a local path"
    );
}
