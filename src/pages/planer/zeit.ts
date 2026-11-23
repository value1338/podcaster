const zone='Europe/Berlin';
export function local(utc:string){const p=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(utc));return p.replace(' ','T');}
export function toUtc(value:string,original?:string){
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))throw Error('Datum und Uhrzeit fehlen.');
 // Preserve offset and sub-minute precision of an unchanged existing instant.
 if(original&&local(original)===value)return original;
 const base=Date.parse(value+'Z');const matches=[base-7200000,base-3600000].filter(n=>local(new Date(n).toISOString())===value).sort((a,b)=>a-b);
 if(!matches.length)throw Error('Diese Ortszeit gibt es in Europe/Berlin nicht.');return new Date(matches[0]).toISOString();
}
export function label(utc:string){return new Intl.DateTimeFormat('de-DE',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(utc))+' '+(new Intl.DateTimeFormat('de-DE',{timeZone:zone,timeZoneName:'short'}).formatToParts(new Date(utc)).find(p=>p.type==='timeZoneName')?.value??'');}
export function monthRange(month:string){const [y,m]=month.split('-').map(Number);return {from:toUtc(month+'-01T00:00'),to:toUtc(`${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}-01T00:00`)};}
export function shiftMonth(month:string,delta:number){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7);}
