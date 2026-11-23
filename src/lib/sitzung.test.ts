import {test,expect,vi} from 'vitest';
import {sicheresZiel,neuLaden} from './sitzung';
test('PA10 return paths reject URL parser bypasses, root and podcast remain same origin',()=>{
 const decoded=new URLSearchParams('weiter=/%09/evil.example').get('weiter')!;
 for(const value of [decoded,'//evil.example','/\\evil.example','/ /evil.example','/\n/evil.example','/\r/evil.example','https://evil.example','/x\u007f'])expect(sicheresZiel(value)).toBe('/');
 for(const base of ['/','/podcast/'])for(const value of [decoded,'//evil.example','/\\evil.example','/projekte?x=1']){
 const dest=new URL(base+sicheresZiel(value).replace(/^\/+/,''),'https://studio.test/');
 expect(dest.origin).toBe('https://studio.test');
 }
 expect(sicheresZiel('/projekte?x=1')).toBe('/projekte?x=1');
 const assign=vi.fn();vi.stubGlobal('window',{location:{href:'https://studio.test/',origin:'https://studio.test',assign}});
 try{neuLaden(decoded);expect(new URL(assign.mock.calls[0][0],'https://studio.test').origin).toBe('https://studio.test');}finally{vi.unstubAllGlobals();}
});

test('reload preserves internal login destinations and notices while weiter rejects login loops',()=>{
 const assign=vi.fn();vi.stubGlobal('window',{location:{href:'https://studio.test/podcast/',origin:'https://studio.test',assign}});
 try{
 for(const path of ['/anmelden?grund=abgemeldet','/anmelden?grund=kennwort','/anmelden?weiter=%2Fkonto&grund=abgelaufen']){
 neuLaden(path);const url=new URL(assign.mock.calls.at(-1)![0],'https://studio.test/');expect(url.origin).toBe('https://studio.test');expect(url.pathname.endsWith('/anmelden')).toBe(true);expect(url.search).toBe(path.slice(path.indexOf('?')));expect(sicheresZiel(path)).toBe('/');
 }
 }finally{vi.unstubAllGlobals();}
});
