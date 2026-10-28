import { Clerk } from '/core/clerk.js';
import { Replay } from '/core/replay.js';
import { summarize, validateSummary, mockSummarize } from '/core/summarizer.js';

export async function startHosted({render,catchup,notice}){
 const fixture=await fetch('/fixtures/demo-stream.json').then(r=>r.json());
 const channel=new BroadcastChannel('catchup-clerk-demo-v1');
 let replay,clerk,leader=false,closed=false,release,tick,refresh;
 const speed=new URLSearchParams(location.search).get('speed')||20;
 const emit=(type,data)=>{if(closed)return;(type==='state'?render:catchup)(data);channel.postMessage({type,data});};
 const handleAction=(action,value)=>replay?.action(action,value);
 channel.onmessage=({data})=>{
  if(data.type==='state'&&!leader)render(data.data);
  if(data.type==='catchup'&&!leader)catchup(data.data);
  if(data.type==='request'&&leader)channel.postMessage({type:'state',data:clerk.state()});
  if(data.type==='action'&&leader)handleAction(data.action,data.value);
 };
 const becomeLeader=()=>{
  leader=true;
  clerk=new Clerk({mode:'demo',channel:fixture.channel,emit,summarizeFn:async(items,options)=>{
   try{
    const response=await fetch('/api/summarize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items,viewer:options.viewer,now:options.now}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Summary unavailable');
    const data=await response.json();options.onBackend(data.backend);return validateSummary(data.summary,mockSummarize(items,options));
   }catch{return summarize(items,{...options,onBackend:()=>options.onBackend('mock fallback')});}
  }});
  replay=new Replay(clerk,fixture,{speed});replay.start();tick=setInterval(()=>replay.tick(),500);refresh=setInterval(()=>{if(!clerk.refreshing)clerk.refresh().catch(()=>{});},15000);
 };
 async function elect(){
  if(closed||leader)return;
  if(!navigator.locks){notice('This browser runs a separate replay in each tab.');becomeLeader();return;}
  await navigator.locks.request('catchup-clerk-demo-leader',{ifAvailable:true},async lock=>{
   if(!lock||closed)return;becomeLeader();await new Promise(resolve=>{release=resolve;});
  });
 }
 void elect();channel.postMessage({type:'request'});
 const election=setInterval(()=>{void elect();},2000);
 return {control:async(action,value)=>{if(leader)handleAction(action,value);else channel.postMessage({type:'action',action,value});},stop:()=>{closed=true;clearInterval(tick);clearInterval(refresh);clearInterval(election);release?.();channel.close();}};
}
