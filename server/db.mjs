import { DatabaseSync } from 'node:sqlite';
export function openDB(path) {
 const sql = new DatabaseSync(path);
 sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
 const tables = new Set(['projects','recordings','tracks','exports']);
 return { sql, all(table) { if(!tables.has(table)) throw Error('table'); return sql.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r=>JSON.parse(r.data)); },
 get(table,id) { if(!tables.has(table)) throw Error('table'); const row=sql.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : undefined; },
 where(table,field,value) { if(!tables.has(table)) throw Error('table'); if(!['ownerId','projectId','recordingId','trackId'].includes(field)) throw Error('field'); return sql.prepare(`SELECT data FROM ${table} WHERE json_extract(data,'$.${field}')=? ORDER BY rowid`).all(value).map(r=>JSON.parse(r.data)); },
 tx(fn) { if(fn.constructor.name==='AsyncFunction') throw Error('tx callback muss synchron sein'); sql.exec('BEGIN IMMEDIATE'); try { const value=fn(); if(value && typeof value.then==='function') throw Error('tx callback muss synchron sein'); sql.exec('COMMIT'); return value; } catch(error) { sql.exec('ROLLBACK'); throw error; } },
 put(table,row) { if(!tables.has(table)) throw Error('table'); sql.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(row.id,JSON.stringify(row)); return row; }, close(){sql.close();} };
}
