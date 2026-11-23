import {randomUUID} from 'node:crypto';
import {problem} from './storage.mjs';
import {requireUser,limit} from './auth.mjs';
const invalid=()=>{throw problem(400,'invalid_input','Ungültige Termindaten.');};
const missing=()=>{throw problem(404,'not_found','Nicht gefunden.');};
function instant(s){
 if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s))return invalid();
 const d=new Date(s);if(!Number.isFinite(+d)||d.toISOString()!==s.replace(/Z$/,s.includes('.')?'Z':'.000Z'))return invalid();return d.toISOString();
}
function validate(ctx,user,b){
 if(typeof b.title!=='string'||!b.title.trim()||b.title.length>120||typeof b.notes!=='string'||b.notes.length>4000||!['planned','confirmed','done','canceled'].includes(b.status))invalid();
 const startsAt=instant(b.startsAt),endsAt=instant(b.endsAt);if(endsAt<=startsAt||Date.parse(endsAt)-Date.parse(startsAt)>7*86400000)invalid();
 if(typeof b.timeZone!=='string')invalid();try{new Intl.DateTimeFormat('de',{timeZone:b.timeZone});}catch{invalid();}
 if(b.projectId!==null){if(typeof b.projectId!=='string')invalid();const p=ctx.db.get('projects',b.projectId);if(!p||p.ownerId!==user.id)missing();}
 return {...b,title:b.title.trim(),startsAt,endsAt};
}
const escape=s=>s.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
function fold(s){let lines=[],line='';for(const c of s){if(Buffer.byteLength(line+c)>75){lines.push(line);line=' ';}line+=c;}return [...lines,line].join('\r\n');}
const stamp=s=>s.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
export function calendar(events){return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Podcast-Studio//Planer//DE',...events.flatMap(e=>['BEGIN:VEVENT',`UID:${e.id}@podcast-studio`,`DTSTAMP:${stamp(e.updatedAt)}`,`DTSTART:${stamp(e.startsAt)}`,`DTEND:${stamp(e.endsAt)}`,`SUMMARY:${escape(e.title)}`,`DESCRIPTION:${escape(e.notes)}`,`SEQUENCE:${e.revision-1}`,`STATUS:${({planned:'TENTATIVE',confirmed:'CONFIRMED',done:'CONFIRMED',canceled:'CANCELLED'})[e.status]}`,'END:VEVENT']),'END:VCALENDAR'].map(fold).join('\r\n')+'\r\n';}
export async function planner(ctx,req,res,pathname,user,{json,body}){
 if(!/^\/api\/planner(?:\/|$)/.test(pathname))return false;requireUser(user);
 const sql=ctx.db.sql,method=req.method;
 const view=r=>({id:r.id,projectId:r.project_id,projectTitle:r.project_id?(ctx.db.get('projects',r.project_id)?.ownerId===user.id?ctx.db.get('projects',r.project_id).title:null):null,title:r.title,notes:r.notes,status:r.status,startsAt:r.starts_at,endsAt:r.ends_at,timeZone:r.time_zone,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at});
 const read=id=>{const r=sql.prepare('SELECT * FROM planner_events WHERE id=? AND owner_id=?').get(id,user.id);if(!r)missing();return view(r);};
 const send=(status,data)=>{json(res,status,data);return true;};
 const ics=events=>{const data=Buffer.from(calendar(events));res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename="Termin.ics"','Cache-Control':'no-store','Content-Length':data.length});res.end(data);return true;};
 if(['/api/planner/events','/api/planner/events.ics'].includes(pathname)&&method==='GET'){
 const q=new URL(req.url,'http://localhost').searchParams,from=instant(q.get('from')),to=instant(q.get('to'));if(to<=from||Date.parse(to)-Date.parse(from)>400*86400000)throw problem(400,'range_too_large','Zeitraum zu groß.');
 const rows=sql.prepare('SELECT * FROM planner_events WHERE owner_id=? AND starts_at<? AND ends_at>? ORDER BY starts_at,id LIMIT 501').all(user.id,to,from);if(rows.length>500)throw problem(400,'range_too_large','Zu viele Termine.');const events=rows.map(view);return pathname.endsWith('.ics')?ics(events):send(200,events);
 }
 if(pathname==='/api/planner/events'&&method==='POST'){
 limit(ctx,'create:'+user.id,60,60000);const b=validate(ctx,user,{projectId:null,notes:'',status:'planned',timeZone:'Europe/Berlin',...await body(req)}),id=randomUUID(),now=new Date().toISOString();
 sql.prepare('INSERT INTO planner_events VALUES (?,?,?,?,?,?,?,?,?,1,?,?)').run(id,user.id,b.projectId,b.title,b.notes,b.status,b.startsAt,b.endsAt,b.timeZone,now,now);return send(201,read(id));
 }
 const m=pathname.match(/^\/api\/planner\/events\/([^/]+)(\/ics)?$/);if(!m)missing();const event=read(m[1]);
 if(method==='GET')return m[2]?ics([event]):send(200,event);
 if(!m[2]&&method==='DELETE'){sql.prepare('DELETE FROM planner_events WHERE id=? AND owner_id=?').run(event.id,user.id);res.writeHead(204);res.end();return true;}
 if(!m[2]&&method==='PATCH'){const input=await body(req);return ctx.db.tx(()=>{const fresh=read(event.id);if(input.revision!==fresh.revision)throw problem(409,'revision_conflict','Termin wurde inzwischen geändert.',{revision:fresh.revision});const b=validate(ctx,user,{...fresh,...input});sql.prepare('UPDATE planner_events SET project_id=?,title=?,notes=?,status=?,starts_at=?,ends_at=?,time_zone=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?').run(b.projectId,b.title,b.notes,b.status,b.startsAt,b.endsAt,b.timeZone,new Date().toISOString(),event.id,user.id);return send(200,read(event.id));});}
 throw problem(405,'method_not_allowed','Methode nicht erlaubt.');
}
