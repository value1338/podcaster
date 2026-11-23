// Fresh copies of the original reviewer wrappers, with isolated output roots.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const base=path.resolve('test/real/evidence/recheck-'+randomUUID());await fs.mkdir(base);
const source=path.resolve('test/real/evidence/reviewfixes-final-20261120');
for(const script of ['review','cleanup-errors','signal','adversarial']){
 const d=base+'/'+script;await fs.mkdir(d);
 for(const name of [script+'.mjs','server.mjs','db.mjs','migrate.mjs','accounts.mjs'])await fs.copyFile(source+'/'+script+'/'+name,d+'/'+name,1);
 const stdout=execFileSync(process.execPath,[d+'/'+script+'.mjs'],{env:{PATH:process.env.PATH},encoding:'utf8'});
 await fs.writeFile(base+'/'+script+'.log',stdout,{flag:'wx'});
}
const stdout=execFileSync(process.execPath,['--test','test/real/guard.test.mjs','test/real/evidence-assertions.mjs'],{env:{PATH:process.env.PATH,RA5_EVIDENCE:base},encoding:'utf8'});
await fs.writeFile(base+'/assertions.log',stdout,{flag:'wx'});console.log(base+'\n'+stdout);
