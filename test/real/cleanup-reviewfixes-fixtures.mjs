// Only explicit evidence roots from this fix session; no global temp discovery.
import * as fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const evidence=path.resolve('test/real/evidence');
const roots=process.argv.slice(2).map(p=>path.resolve(p));
if(!roots.length||roots.some(p=>!p.startsWith(evidence+'/')))throw Error('explicit_owned_evidence_roots_required');
const files=[],dirs=new Set(),preserved=[];
const digest=b=>createHash('sha256').update(b).digest('hex');
async function walk(dir,fixture=false){for(const e of await fs.readdir(dir,{withFileTypes:true})){
 const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('unexpected_symlink');
 if(e.isDirectory()){const isFixture=fixture||['archive','archive-foreign','archive-missing-hidden','ar-unknown','ar-output'].includes(e.name);await walk(f,isFixture);if(isFixture)dirs.add(f);}
 else if(e.name==='retainedDataDir.json'){
  const dbdir=JSON.parse(await fs.readFile(f));if(!dbdir.startsWith(path.resolve('test/real')+'/')||!path.basename(dbdir).startsWith('.studio-ra5-'))throw Error('unexpected_db_root');await walk(dbdir,true);dirs.add(dbdir);
 }else if(fixture){if(e.name.includes('.pa0-')){preserved.push(f);continue;}await remember(f);}
 else if((e.name==='result.json'&&(await fs.readFile(f,'utf8'))==='FOREIGN OUTPUT SENTINEL')||(e.name==='sentinel'&&(await fs.readFile(f,'utf8'))==='KEEP')||(e.name==='foreign.txt'&&dir.endsWith('/secret/out')))await remember(f);
 }}
async function remember(f){const s=await fs.lstat(f);files.push({file:f,dev:s.dev,ino:s.ino,sha256:digest(await fs.readFile(f))});}
for(const root of roots)await walk(root);
const unique=[...new Map(files.map(f=>[f.file,f])).values()];
const journal=evidence+'/fixture-cleanup-'+Date.now()+'.json';await fs.writeFile(journal,JSON.stringify({roots,files:unique,preservedProtectedSnapshots:preserved},null,2),{flag:'wx'});
for(const entry of unique){const s=await fs.lstat(entry.file);if(s.dev!==entry.dev||s.ino!==entry.ino||digest(await fs.readFile(entry.file))!==entry.sha256)throw Error('fixture_changed');await fs.unlink(entry.file);}
for(const d of [...dirs].sort((a,b)=>b.length-a.length))await fs.rmdir(d).catch(e=>{if(e.code!=='ENOTEMPTY')throw e;});
console.log(JSON.stringify({journal,removed:unique.length,preservedSnapshots:preserved.length}));
