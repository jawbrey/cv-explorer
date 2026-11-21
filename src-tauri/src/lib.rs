use rusqlite::{params_from_iter, types::{Value, ValueRef}, Connection, OpenFlags};
use serde_json::{json, Map, Value as J};
use std::sync::Mutex;
use tauri::{Manager, State};

struct Db(Mutex<Option<Connection>>);
type R<T> = Result<T, String>;
fn e<E: ToString>(x: E) -> String { x.to_string() }

// Run a query and return each row as a JSON object keyed by column name.
fn qry(c: &Connection, sql: &str, p: Vec<Value>) -> R<Vec<J>> {
    let mut st = c.prepare(sql).map_err(e)?;
    let cols: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let it = st
        .query_map(params_from_iter(p), |r| {
            let mut m = Map::new();
            for (i, n) in cols.iter().enumerate() {
                m.insert(n.clone(), match r.get_ref(i)? {
                    ValueRef::Integer(x) => json!(x),
                    ValueRef::Real(x) => json!(x),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t).into_owned()),
                    _ => J::Null,
                });
            }
            Ok(J::Object(m))
        })
        .map_err(e)?;
    let out = it.collect::<Result<Vec<_>, _>>().map_err(e);
    out
}

fn count(c: &Connection, sql: &str) -> R<i64> {
    c.query_row(sql, [], |r| r.get(0)).map_err(e)
}

fn with<T>(db: &State<Db>, f: impl FnOnce(&Connection) -> R<T>) -> R<T> {
    let g = db.0.lock().map_err(e)?;
    f(g.as_ref().ok_or("No database open")?)
}

// ---- Settings: the chosen database path is kept in <app config dir>/settings.json
fn settings_file(app: &tauri::AppHandle) -> R<std::path::PathBuf> {
    let d = app.path().app_config_dir().map_err(e)?;
    std::fs::create_dir_all(&d).map_err(e)?;
    Ok(d.join("settings.json"))
}

#[tauri::command]
fn saved_db_path(app: tauri::AppHandle) -> Option<String> {
    let f = settings_file(&app).ok()?;
    let v: J = serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()?;
    v["db_path"].as_str().map(String::from)
}

#[tauri::command]
fn save_db_path(path: String, app: tauri::AppHandle) -> R<()> {
    let f = settings_file(&app)?;
    let mut v: J = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if !v.is_object() { v = json!({}); }
    v["db_path"] = json!(path);
    std::fs::write(f, serde_json::to_string_pretty(&v).map_err(e)?).map_err(e)
}

#[tauri::command]
fn open_db(path: String, db: State<'_, Db>) -> R<J> {
    let c = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(e)?;
    let s = json!({
        "publishers": count(&c, "SELECT COUNT(*) FROM cv_publisher")?,
        "volumes": count(&c, "SELECT COUNT(*) FROM cv_volume")?,
        "issues": count(&c, "SELECT COUNT(*) FROM cv_issue")?,
        "files": count(&c, "SELECT COUNT(*) FROM comic_files")?,
        "matched": count(&c, "SELECT COUNT(*) FROM comic_files WHERE cvid IS NOT NULL")?,
    });
    *db.0.lock().map_err(e)? = Some(c);
    Ok(json!({ "path": path, "stats": s }))
}

#[tauri::command]
fn search_volumes(q: String, publishers: Vec<i64>, years: Vec<String>, issue_years: Vec<String>, db: State<'_, Db>) -> R<Vec<J>> {
    with(&db, |c| {
        let mut p: Vec<Value> = vec![];
        let mut w = String::from(" WHERE 1=1");
        // Series name only: every word must appear in the name, in any order.
        for t in q.split(|ch: char| !ch.is_alphanumeric()).filter(|s| !s.is_empty()) {
            w += " AND v.name LIKE ?";
            p.push(Value::Text(format!("%{t}%")));
        }
        if !years.is_empty() {
            // Series Year: matches cv_volume.start_year only.
            w += &format!(" AND v.start_year IN ({})", vec!["?"; years.len()].join(","));
            p.extend(years.iter().map(|y| Value::Text(y.clone())));
        }
        if !issue_years.is_empty() {
            // Issue Year: series with at least one issue whose cover_date falls in the year.
            w += &format!(" AND v.id IN (SELECT volume_id FROM cv_issue WHERE substr(cover_date,1,4) IN ({}))", vec!["?"; issue_years.len()].join(","));
            p.extend(issue_years.iter().map(|y| Value::Text(y.clone())));
        }
        if !publishers.is_empty() {
            w += &format!(" AND v.publisher_id IN ({})", vec!["?"; publishers.len()].join(","));
            p.extend(publishers.iter().map(|&x| Value::Integer(x)));
        }
        qry(c, &format!(
            "SELECT v.id,v.name,v.start_year,v.count_of_issues,v.image_url,p.name AS publisher \
             FROM cv_volume v LEFT JOIN cv_publisher p ON p.id=v.publisher_id{w} \
             ORDER BY CASE WHEN v.name LIKE 'the %' THEN substr(v.name,5) WHEN v.name LIKE 'an %' THEN substr(v.name,4) WHEN v.name LIKE 'a %' THEN substr(v.name,3) ELSE v.name END COLLATE NOCASE, v.name COLLATE NOCASE, v.start_year LIMIT 501"), p)
    })
}

#[tauri::command]
fn list_publishers(db: State<'_, Db>) -> R<Vec<J>> {
    with(&db, |c| qry(c,
        "SELECT p.id,p.name,COUNT(v.id) AS volumes FROM cv_publisher p \
         LEFT JOIN cv_volume v ON v.publisher_id=p.id GROUP BY p.id ORDER BY volumes DESC LIMIT 300",
        vec![]))
}

#[tauri::command]
fn list_years(db: State<'_, Db>) -> R<Vec<J>> {
    with(&db, |c| qry(c,
        "SELECT start_year AS year, COUNT(*) AS n FROM cv_volume \
         WHERE start_year GLOB '[0-9][0-9][0-9][0-9]' GROUP BY start_year ORDER BY start_year DESC",
        vec![]))
}

#[tauri::command]
fn list_issue_years(db: State<'_, Db>) -> R<Vec<J>> {
    with(&db, |c| qry(c,
        "SELECT substr(cover_date,1,4) AS year, COUNT(DISTINCT volume_id) AS n FROM cv_issue \
         WHERE cover_date GLOB '[0-9][0-9][0-9][0-9]*' GROUP BY year ORDER BY year DESC",
        vec![]))
}

#[tauri::command]
fn get_volume(id: i64, db: State<'_, Db>) -> R<J> {
    with(&db, |c| {
        let v = qry(c, "SELECT v.*,p.name AS publisher FROM cv_volume v LEFT JOIN cv_publisher p ON p.id=v.publisher_id WHERE v.id=?", vec![Value::Integer(id)])?;
        let i = qry(c,
            "SELECT i.id,i.issue_number,i.name,i.cover_date,i.image_url,COALESCE(f.n,0) AS files \
             FROM cv_issue i LEFT JOIN (SELECT cvid,COUNT(*) AS n FROM comic_files GROUP BY cvid) f ON f.cvid=i.id \
             WHERE i.volume_id=? ORDER BY CAST(i.issue_number AS REAL), i.issue_number",
            vec![Value::Integer(id)])?;
        Ok(json!({ "volume": v.into_iter().next(), "issues": i }))
    })
}

#[tauri::command]
fn get_issue(id: i64, db: State<'_, Db>) -> R<J> {
    with(&db, |c| {
        let p = || vec![Value::Integer(id)];
        let i = qry(c, "SELECT i.*,v.name AS volume_name,pb.name AS publisher FROM cv_issue i \
                        LEFT JOIN cv_volume v ON v.id=i.volume_id LEFT JOIN cv_publisher pb ON pb.id=v.publisher_id WHERE i.id=?", p())?;
        let vid = i.first().and_then(|x| x["volume_id"].as_i64()).unwrap_or(-1);
        let ids: Vec<i64> = qry(c, "SELECT id FROM cv_issue WHERE volume_id=? ORDER BY CAST(issue_number AS REAL), issue_number, id", vec![Value::Integer(vid)])?
            .iter().filter_map(|r| r["id"].as_i64()).collect();
        let pos = ids.iter().position(|&x| x == id);
        let nav = json!({
            "prev": pos.and_then(|k| k.checked_sub(1)).map(|k| ids[k]),
            "next": pos.and_then(|k| ids.get(k + 1).copied()),
            "pos": pos.map(|k| k + 1),
            "total": ids.len(),
        });
        Ok(json!({ "issue": i.into_iter().next(), "nav": nav }))
    })
}

#[tauri::command]
fn list_files(q: String, filter: String, offset: i64, db: State<'_, Db>) -> R<Vec<J>> {
    with(&db, |c| {
        let f = match filter.as_str() {
            "matched" => " AND f.cvid IS NOT NULL",
            "unmatched" => " AND f.cvid IS NULL",
            "dups" => " AND f.md5_hash IN (SELECT md5_hash FROM comic_files WHERE md5_hash IS NOT NULL GROUP BY md5_hash HAVING COUNT(*)>1)",
            _ => "",
        };
        qry(c,
            &format!("SELECT f.id,f.filename,f.file_size,f.cvid,i.issue_number,v.name AS volume FROM comic_files f \
                      LEFT JOIN cv_issue i ON i.id=f.cvid LEFT JOIN cv_volume v ON v.id=i.volume_id \
                      WHERE f.filename LIKE ?{f} ORDER BY f.filename LIMIT 50 OFFSET ?"),
            vec![Value::Text(format!("%{}%", q.trim())), Value::Integer(offset)])
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Db(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            saved_db_path, save_db_path, open_db, search_volumes, list_publishers, list_years, list_issue_years, get_volume, get_issue, list_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running CV Explorer");
}
