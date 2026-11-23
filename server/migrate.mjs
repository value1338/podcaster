import { backup, DatabaseSync } from 'node:sqlite';
import { open, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// SQLite online backup includes committed WAL data. Destination is exclusively reserved.
export async function snapshot(sql, destination) {
 const handle = await open(destination, 'wx', 0o600); await handle.close();
 await backup(sql, destination);
 await chmod(destination, 0o600);
 const check = new DatabaseSync(destination, {readOnly:true});
 try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Snapshot integrity_check fehlgeschlagen'); }
 finally { check.close(); }
 return destination;
}

async function migrateBase(db, databasePath) {
 const version = db.sql.prepare('PRAGMA user_version').get().user_version;
 if (version === 1) return {changed:false, version};
 if (version !== 0) throw Error('Unbekannte Schema-Version: '+version);
 const backupPath = databasePath + '.pa0-' + randomUUID() + '.sqlite';
 await snapshot(db.sql, backupPath);
 db.tx(() => {
 // Recheck under writer lock: another migrator may have finished during backup.
 const current = db.sql.prepare('PRAGMA user_version').get().user_version;
 if(current === 1) return;
 if(current !== 0) throw Error('Unbekannte Schema-Version');
 db.sql.exec(`CREATE INDEX IF NOT EXISTS projects_owner    ON projects  (json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS recordings_owner  ON recordings(json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS recordings_proj   ON recordings(json_extract(data,'$.projectId'));
CREATE INDEX IF NOT EXISTS tracks_owner      ON tracks    (json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS tracks_rec        ON tracks    (json_extract(data,'$.recordingId'));
CREATE INDEX IF NOT EXISTS exports_owner     ON exports   (json_extract(data,'$.ownerId'));
CREATE INDEX IF NOT EXISTS exports_track     ON exports   (json_extract(data,'$.trackId'));

CREATE TABLE plans(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  asr_seconds_month INTEGER, llm_tokens_month INTEGER, llm_cost_micro_month INTEGER,
  storage_bytes INTEGER, active_jobs INTEGER,          -- NULL = unbegrenzt
  updated_at TEXT NOT NULL);
CREATE TABLE users(
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('owner','member')),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  password_hash TEXT,                                   -- NULL bis Einrichtung
  status TEXT NOT NULL CHECK(status IN('active','disabled')),
  created_at TEXT NOT NULL, last_login_at TEXT);
CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role='owner';
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT);
CREATE TABLE tokens(                                    -- Einladung, Ersteinrichtung, Kennwort-Rücksetzung
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN('invite','setup','reset')),
  user_id TEXT REFERENCES users(id),                    -- setup/reset
  email TEXT, plan_id TEXT REFERENCES plans(id),        -- invite
  created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE usage(                                     -- Reservierung und Verbuchung, eine Zeile je Auftrag+Zähler+Konto
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,           -- Konto-ID oder '*' (Plattform gesamt)
  meter TEXT NOT NULL CHECK(meter IN('asr_seconds','llm_tokens','llm_cost_micro')),
  period TEXT NOT NULL,                                 -- 'YYYY-MM' (UTC) zum Zeitpunkt der Reservierung
  job_id TEXT NOT NULL, reserved INTEGER NOT NULL, used INTEGER,
  status TEXT NOT NULL CHECK(status IN('reserved','committed','released')),
  note TEXT, created_at TEXT NOT NULL, settled_at TEXT,
  UNIQUE(job_id, meter, user_id));
CREATE INDEX usage_sum ON usage(user_id, meter, period, status);
CREATE TABLE jobs(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('asr','llm','archive','restore','evict')),
  subject_type TEXT NOT NULL CHECK(subject_type IN('track','project')), subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','canceled')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
  error_code TEXT, error_message TEXT,
  input TEXT NOT NULL,                                  -- JSON, unveränderlich
  state TEXT,                                           -- JSON, Fortschritt (z. B. fertige ASR-Fenster)
  result TEXT,                                          -- JSON, z. B. {transcriptId} / {generationId}
  idem_key TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  UNIQUE(owner_id, idem_key));
CREATE INDEX jobs_work ON jobs(status, kind, next_attempt_at);
CREATE INDEX jobs_subject ON jobs(subject_type, subject_id, kind);
CREATE TABLE transcripts(
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, job_id TEXT NOT NULL,
  language TEXT, model TEXT NOT NULL, device TEXT NOT NULL, timestamps TEXT NOT NULL CHECK(timestamps IN('word','segment','none')),
  duration_ms INTEGER NOT NULL,
  segments TEXT NOT NULL,                               -- JSON, aktueller (bearbeitbarer) Stand
  machine TEXT NOT NULL,                                -- JSON, unveränderte Maschinenfassung
  edited INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE generations(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, track_id TEXT, job_id TEXT NOT NULL,
  task TEXT NOT NULL, content TEXT NOT NULL, data TEXT,  -- data: JSON (z. B. Kapitel)
  provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cost_micro INTEGER, usage_estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE INDEX generations_project ON generations(project_id, created_at);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, subject TEXT, detail TEXT);
`);
 const now = new Date().toISOString();
 const plan = db.sql.prepare('INSERT INTO plans VALUES (?,?,?,?,?,?,?,?)');
 plan.run('intern','Intern',null,null,null,null,4,now);
 plan.run('free','Free',3600,200000,null,10000000000,1,now);
 plan.run('pro','Pro',36000,3000000,null,200000000000,3,now);
 const setting = db.sql.prepare('INSERT INTO settings VALUES (?,?,?,NULL)');
 for(const [key,value] of Object.entries({'llm.globalTokensMonth':5000000,'llm.globalCostMicroMonth':null})) setting.run(key,JSON.stringify(value),now);
 db.sql.exec('PRAGMA user_version=1');
 });
 return {changed:true,version:1,backupPath};
}

export function pelVersion(sql) {
 return sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_ext'").get() ? (sql.prepare("SELECT version FROM schema_ext WHERE name='pel'").get()?.version??0) : 0;
}
export async function migrate(db, databasePath) {
 const base=await migrateBase(db,databasePath);
 if(pelVersion(db.sql)===1)return base;
 if(pelVersion(db.sql)!==0)throw Error('Unbekannte pel-Version');
 const backupPath=databasePath+'.pel-'+randomUUID()+'.sqlite';
 await snapshot(db.sql,backupPath);
 db.tx(()=>{
 if(pelVersion(db.sql)===1)return;
 db.sql.exec(`CREATE TABLE schema_ext(name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);

CREATE TABLE planner_events(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN('planned','confirmed','done','canceled')),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,          -- UTC-Instanten
  time_zone TEXT NOT NULL,                                 -- IANA, Anzeigezone
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX planner_owner_start ON planner_events(owner_id, starts_at);

CREATE TABLE edits(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('audio','video')),
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX edits_owner_project ON edits(owner_id, project_id);
CREATE TABLE edit_revisions(
  edit_id TEXT NOT NULL REFERENCES edits(id), revision INTEGER NOT NULL, owner_id TEXT NOT NULL,
  edl TEXT NOT NULL, edl_sha256 TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(edit_id, revision));
CREATE TABLE renders(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, edit_id TEXT NOT NULL, revision INTEGER NOT NULL,
  edl_sha256 TEXT NOT NULL, track_ids TEXT NOT NULL,       -- JSON-Array, für archive.busy()
  format TEXT NOT NULL CHECK(format IN('mp4','mp3','wav')),
  status TEXT NOT NULL CHECK(status IN('queued','processing','ready','failed','canceled')),
  progress REAL, bytes INTEGER, sha256 TEXT, duration_ms INTEGER, error TEXT,
  created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX renders_owner ON renders(owner_id, status);
CREATE INDEX renders_edit ON renders(edit_id, revision, format);

CREATE TABLE live_sessions(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, public_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('created','live','interrupted','ended')),
  end_reason TEXT, epoch INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT UNIQUE, token_created_at TEXT,           -- NULL = widerrufen
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
CREATE INDEX live_owner ON live_sessions(owner_id, created_at);

INSERT INTO schema_ext VALUES('pel',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`);
 const setting=db.sql.prepare('INSERT OR IGNORE INTO settings VALUES (?,?,?,NULL)');
 for(const [k,v] of Object.entries({'live.maxViewers':10,'live.maxMinutes':240}))setting.run(k,JSON.stringify(v),new Date().toISOString());
 });
 return {...base,changed:true,ext:{pel:1},backupPath:base.backupPath??backupPath,pelBackupPath:backupPath};
}
