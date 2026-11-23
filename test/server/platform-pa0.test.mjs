import {test,expect} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDB} from '../../server/db.mjs';
import {migrate,snapshot} from '../../server/migrate.mjs';
test('PA0 transactional migration, constraints, backup, identifiers and idempotency',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pa0-unit-'));const file=path.join(dir,'studio.sqlite');const db=openDB(file);
 try {
 db.put('projects',{id:'p',title:'unchanged'});
 expect(()=>db.get('projects; DROP TABLE projects','p')).toThrow();
 expect(()=>db.where('projects','x\'','p')).toThrow();
 expect(()=>db.tx(()=>{db.put('projects',{id:'rollback'});throw Error('abort');})).toThrow();expect(db.get('projects','rollback')).toBeUndefined();
 expect(()=>db.tx(async()=>{})).toThrow();
 const result=await migrate(db,file);expect(result.changed).toBe(true);
 const copy=new DatabaseSync(result.backupPath,{readOnly:true});expect(copy.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');expect(copy.prepare('PRAGMA user_version').get().user_version).toBe(0);copy.close();
 expect(db.get('projects','p')).toEqual({id:'p',title:'unchanged'});
 expect(db.sql.prepare('SELECT count(*) n FROM plans').get().n).toBe(3);
 const before=await readFile(result.backupPath);expect(await migrate(db,file)).toEqual({changed:false,version:1});expect(await readFile(result.backupPath)).toEqual(before);
 expect(()=>db.sql.prepare("INSERT INTO usage VALUES ('a','u','wrong','2026-11','j',1,NULL,'reserved',NULL,'now',NULL)").run()).toThrow();
 db.sql.prepare("INSERT INTO usage VALUES ('a','u','llm_tokens','2026-11','j',1,NULL,'reserved',NULL,'now',NULL)").run();
 expect(()=>db.sql.prepare("INSERT INTO usage VALUES ('b','u','llm_tokens','2026-11','j',1,NULL,'reserved',NULL,'now',NULL)").run()).toThrow();
 await expect(snapshot(db.sql,result.backupPath)).rejects.toThrow();
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test('PA0 failed DDL migration rolls back schema and version',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pa0-rollback-'));const file=path.join(dir,'studio.sqlite');const db=openDB(file);
 try {
 db.sql.prepare("INSERT INTO projects VALUES ('broken','invalid-json')").run();
 await expect(migrate(db,file)).rejects.toThrow();
 expect(db.sql.prepare('PRAGMA user_version').get().user_version).toBe(0);
 expect(db.sql.prepare("SELECT count(*) n FROM sqlite_master WHERE name='plans'").get().n).toBe(0);
 expect(db.sql.prepare("SELECT data FROM projects WHERE id='broken'").get().data).toBe('invalid-json');
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
