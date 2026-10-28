import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventSub } from '../src/twitch/eventsub.js';
import { normalizeNotification } from '../src/twitch/events.js';
import { Helix, ChatSender } from '../src/twitch/helix.js';
import { Auth, SCOPES } from '../src/twitch/auth.js';
class Socket {
 static all=[];
 constructor(url){this.url=url;this.listeners={};Socket.all.push(this);}
 addEventListener(name,fn){this.listeners[name]=fn;}
 close(){this.closed=true;this.listeners.close?.();}
}
const welcome=(id='session')=>({metadata:{message_type:'session_welcome'},payload:{session:{id,keepalive_timeout_seconds:30}}});
const notification=(type='channel.chat.message',event={broadcaster_user_id:'channel',chatter_user_id:'viewer',chatter_user_login:'fern',message_id:'parent',message:{text:'!catchup'},badges:[{set_id:'moderator'}]})=>({metadata:{message_type:'notification',message_id:'delivery-1',message_timestamp:'2026-10-28T19:20:00Z'},payload:{subscription:{type},event}});
test('welcome creates all ten subscriptions; denied scopes do not stop others',async()=>{
 const calls=[],logs=[];const e=new EventSub({helix:{request:async(path,options)=>{calls.push({path,...options.body});if(options.body.type==='channel.follow')throw Object.assign(new Error(),{status:403});}},broadcasterId:'channel',userId:'bot',WebSocketImpl:Socket,log:x=>logs.push(x)});
 const socket=e.start();try{await e.handle(welcome(),socket);assert.equal(calls.length,10);assert.ok(calls.every(x=>x.transport.session_id==='session'));assert.deepEqual(calls.find(x=>x.type==='channel.raid').condition,{to_broadcaster_user_id:'channel'});assert.equal(calls.find(x=>x.type==='channel.follow').version,'2');assert.equal(logs.length,11);assert.ok(logs.some(x=>x.includes('scopes')));}finally{e.stop();}
});
test('notifications normalize, deduplicate, enforce channel, and carry moderator badges',async()=>{
 const items=[];const e=new EventSub({helix:{request:async()=>{}},broadcasterId:'channel',userId:'bot',WebSocketImpl:Socket,onItem:item=>items.push(item),log:()=>{}});const socket=e.start();
 try{await e.handle(welcome(),socket);await e.handle(notification(),socket);await e.handle(notification(),socket);assert.equal(items.length,1);assert.equal(items[0].text,'!catchup');assert.equal(items[0].meta.isMod,true);assert.equal(items[0].meta.messageId,'parent');assert.equal(normalizeNotification(notification('channel.cheer',{broadcaster_user_id:'other',bits:10}),'channel'),null);}finally{e.stop();}
});
test('server-directed reconnect migrates without resubscribing; old socket closes after welcome',async()=>{
 let subscriptions=0;const e=new EventSub({helix:{request:async()=>{subscriptions++;}},broadcasterId:'channel',userId:'bot',WebSocketImpl:Socket,log:()=>{}});const old=e.start();
 try{await e.handle(welcome(),old);await e.handle({metadata:{message_type:'session_reconnect'},payload:{session:{reconnect_url:'wss://eventsub.wss.twitch.tv/ws?reconnect=abc'}}},old);const next=e.pending;assert.ok(next);assert.ok(!old.closed);await e.handle(welcome('migrated'),next);assert.ok(old.closed);assert.equal(e.current,next);assert.equal(subscriptions,10);await e.handle({metadata:{message_type:'session_keepalive'},payload:{}},next);assert.ok(next.watchdog);}finally{e.stop();}
});
test('unexpected socket loss reconnects fresh and resubscribes',async()=>{
 let calls=0;const e=new EventSub({helix:{request:async()=>{calls++;}},broadcasterId:'channel',userId:'bot',WebSocketImpl:Socket,retryMs:2,log:()=>{}});const old=e.start();
 try{await e.handle(welcome(),old);old.close();await new Promise(resolve=>setTimeout(resolve,10));const next=Socket.all.at(-1);assert.notEqual(old,next);await e.handle(welcome('fresh'),next);assert.equal(calls,20);}finally{e.stop();}
});
test('all event types normalize readable facts and reject foreign shared chat',()=>{
 const events={ 'channel.follow':{},'channel.raid':{to_broadcaster_user_id:'channel',viewers:120},'channel.subscribe':{tier:'1000'},'channel.subscription.gift':{total:20},'channel.subscription.message':{cumulative_months:6},'channel.cheer':{bits:1500},'channel.update':{category_name:'Ember Vault',title:'One lantern'},'stream.online':{},'stream.offline':{} };
 for(const[type,data]of Object.entries(events)){const item=normalizeNotification(notification(type,{broadcaster_user_id:'channel',user_login:'fern',...data}),'channel');assert.equal(item.kind,'event');assert.ok(item.text.length>5);assert.ok(!item.text.includes('undefined'));}
 assert.equal(normalizeNotification(notification('channel.chat.message',{broadcaster_user_id:'channel',source_broadcaster_user_id:'other'}),'channel'),null);
});
test('chat sends only to configured channel, replies to parent, caps text and spaces attempts including 401 retry',async()=>{
 let now=0,token='old';const calls=[];const helix=new Helix({clientId:'app',auth:{token:async()=>token,refresh:async()=>{token='new';}},fetchImpl:async(url,options)=>{if(url.includes('shared_chat/session'))return Response.json({data:[]});calls.push({now,body:JSON.parse(options.body)});return calls.length===1?new Response('',{status:401}):Response.json({data:[{is_sent:true}]});}});
 const sender=new ChatSender({helix,broadcasterId:'channel',senderId:'bot',now:()=>now,sleep:async ms=>{now+=ms;}});
 await assert.rejects(sender.send({text:'hello',parentId:'p',broadcasterId:'other'}));
 await sender.send({text:'x'.repeat(600),parentId:'p'});await sender.send({text:'second',parentId:'q'});
 assert.deepEqual(calls.map(x=>x.now),[0,2000,4000]);assert.equal(calls[0].body.message.length,450);assert.equal(calls[0].body.reply_parent_message_id,'p');assert.ok(calls.every(x=>x.body.broadcaster_id==='channel'&&!('for_source_only' in x.body)));
});
test('OAuth tokens are stored mode 600; startup validates; concurrent refresh exchanges once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'clerk-auth-'));let exchanges=0,validations=0;
 const auth=new Auth({env:{TWITCH_CLIENT_ID:'app',TWITCH_CLIENT_SECRET:'secret'},tokenFile:join(dir,'tokens.json'),fetchImpl:async url=>{
  if(url.endsWith('/validate')){validations++;return Response.json({client_id:'app',user_id:'bot',login:'clerkbot',expires_in:3600});}
  exchanges++;return Response.json({access_token:'new',refresh_token:'refresh',expires_in:3600});
 }});
 try{await auth.save({access_token:'old',refresh_token:'refresh',expires_in:3600});assert.equal((await stat(join(dir,'tokens.json'))).mode&0o777,0o600);await auth.load();assert.equal(validations,1);await Promise.all([auth.refresh('old'),auth.refresh('old')]);assert.equal(exchanges,1);assert.equal(JSON.parse(await readFile(join(dir,'tokens.json'))).access_token,'new');}finally{await rm(dir,{recursive:true,force:true});}
});
test('OAuth login requests required scopes and callback rejects missing state before exchange',async()=>{
 let network=0;const auth=new Auth({env:{TWITCH_CLIENT_ID:'app',TWITCH_CLIENT_SECRET:'secret'},fetchImpl:async()=>{network++;}});
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(){}};
 await auth.route({method:'GET',headers:{}},res,new URL('http://localhost/auth/login'));const target=new URL(res.headers.Location);assert.deepEqual(target.searchParams.get('scope').split(' '),SCOPES);assert.ok(res.headers['Set-Cookie'].includes('HttpOnly'));
 await auth.route({method:'GET',headers:{}},res,new URL('http://localhost/auth/callback?code=bad'));assert.equal(res.status,400);assert.equal(network,0);
});

test('Shared Chat blocks sends because user tokens cannot restrict fan-out',async()=>{
 let sends=0;const helix=new Helix({clientId:'app',auth:{token:async()=> 'token'},fetchImpl:async url=>{if(url.includes('shared_chat/session'))return Response.json({data:[{session_id:'shared'}]});sends++;return Response.json({data:[{is_sent:true}]});}});
 const sender=new ChatSender({helix,broadcasterId:'channel',senderId:'bot',sleep:async()=>{}});
 await assert.rejects(sender.send({text:'hello',parentId:'parent'}),{code:'SHARED_CHAT'});assert.equal(sends,0);
});
