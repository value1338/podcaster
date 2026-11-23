import {useEffect,useRef,useState} from 'react';
import {useLocation} from 'react-router';
import {api,ApiError,type WatchState} from '../../lib/api';
import {Button} from '../../components';
import {playLive,clearVideo} from '../../lib/live/hls';
import './zuschauen.css';
const labels={created:'Die Sendung hat noch nicht begonnen.',live:'Live',interrupted:'Die Sendung ist unterbrochen.',ended:'Die Sendung ist beendet.',invalid:'Dieser Link ist ungültig, widerrufen oder die Sendung wurde beendet.',full:'Alle Zuschauerplätze sind belegt.',connecting:'Verbindung wird hergestellt.',offline:'Verbindung unterbrochen. Es wird kein Livebild angezeigt.'};
export function ZuschauenSeite(){
 const fragmentKey=useLocation().hash;
 const [state,setState]=useState<WatchState|null>(null),[status,setStatus]=useState<keyof typeof labels>('connecting'),[playing,setPlaying]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const entry=useRef<Promise<void>|null>(null),leaveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const video=useRef<HTMLVideoElement>(null),dispose=useRef<(()=>void)|undefined>(undefined);
 useEffect(()=>{clearTimeout(leaveTimer.current);setStatus('connecting');setState(null);let active=true,timer:ReturnType<typeof setTimeout>;const fragment=new URLSearchParams(location.hash.slice(1));let token=fragment.get('t');if(location.hash)history.replaceState(history.state,'',location.pathname+location.search);
 const clear=()=>{dispose.current?.();dispose.current=undefined;if(video.current)clearVideo(video.current);};
 const poll=async()=>{try{const next=await api.request<WatchState>('GET','/watch/state',undefined,AbortSignal.timeout(2000));if(!active)return;setState(next);setStatus(next.status);if(next.status!=='live')clear();}catch(e){if(!active)return;clear();setState(null);setStatus(e instanceof ApiError&&e.code==='viewers_full'?'full':e instanceof ApiError&&e.status===404?'invalid':'offline');}if(active)timer=setTimeout(()=>void poll(),3000);};
 void(async()=>{try{if(token||!entry.current){entry.current=token?api.watchEnter(token):Promise.resolve();token=null;}await entry.current;if(active)await poll();}catch(e){token=null;if(active)setStatus(e instanceof ApiError&&e.code==='viewers_full'?'full':'invalid');}})();
 const leave=()=>{clear();};window.addEventListener('pagehide',leave);
 return()=>{active=false;token=null;clearTimeout(timer);clear();window.removeEventListener('pagehide',leave);leaveTimer.current=setTimeout(()=>{void api.watchLeave().catch(()=>{});},0);};},[fragmentKey]);
 useEffect(()=>{if(!playing||status!=='live'||!state||!video.current)return;setError('');dispose.current=playLive(video.current,state.epoch,message=>{setError(message);});return()=>{dispose.current?.();dispose.current=undefined;};},[playing,status,state?.epoch,retry]);
 useEffect(()=>{if(!error||status!=='live'||!playing)return;const t=setTimeout(()=>setRetry(n=>n+1),1500);return()=>clearTimeout(t);},[error,status,playing,retry]);
 return <main className="zuschauen-page"><header><p>Podcast-Studio · Live</p><h1>{state?.publicTitle||'Live zuschauen'}</h1></header><p role="status">{labels[status]}</p>{status==='live'&&<><video ref={video} controls playsInline aria-label="Livebild"/><Button onClick={()=>{setPlaying(true);setRetry(n=>n+1);}}>Bild und Ton starten</Button>{error&&<p role="alert">{error}</p>}</>}<p>Live wird nicht aufgezeichnet. Geplante Verzögerung: 6–10 Sekunden.</p></main>;
}
