import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Clerk } from '../src/core/clerk.js';
import { Replay } from '../src/core/replay.js';
import { mockSummarize } from '../src/core/summarizer.js';
import worker, { rateLimit } from '../worker/index.js';
const fixture=JSON.parse(await readFile(new URL('../fixtures/demo-stream.json',import.meta.url)));
test('demo fixture has 25 minutes, 400 chat lines, all events, and three successful catchups',async()=>{
 assert.equal(fixture.durationMs,1500000);assert.equal(fixture.items.filter(x=>x.kind==='chat').length,404);
 let now=0;const cards=[];const clerk=new Clerk({emit:(type,data)=>{if(type==='catchup')cards.push(data);}});const replay=new Replay(clerk,fixture,{wallNow:()=>now,speed:20});replay.start(0);await clerk.queue;
 for(let i=0;i<75;i++){now+=1000;replay.tick();await clerk.queue;}
 assert.equal(cards.length,3);assert.ok(cards[0].summary.bullets[1].includes('120 viewers'));assert.ok(cards[0].summary.bullets[1].includes('20 subscriptions'));assert.ok(cards[0].summary.bullets[0].includes('defeated'));assert.equal(clerk.replies.length,3);assert.ok(clerk.replies.every(x=>x.status==='would post in chat'&&x.parentId&&x.text.length<=450));assert.equal(clerk.joiners.filter(x=>x.status==='Caught up').length,3);assert.ok(replay.loopAt);assert.ok(clerk.state().chat.length<=45);
 now+=45001;replay.tick();await clerk.queue;assert.equal(replay.elapsed,0);assert.equal(clerk.joiners.length,0);
});
test('reset prevents an in-flight summary from publishing to a new replay',async()=>{
 let finish,started;const began=new Promise(resolve=>{started=resolve;});const events=[];const clerk=new Clerk({now:()=>1000,summarizeFn:()=>new Promise(resolve=>{finish=resolve;started();}),emit:(type)=>events.push(type)});
 const pending=clerk.ingest({ts:1000,kind:'chat',user:'new',text:'!catchup',meta:{messageId:'p'}});await began;clerk.reset();finish(mockSummarize([]));await pending;assert.equal(clerk.joiners.length,0);assert.ok(!events.includes('catchup'));
});
test('own-account recap works for broadcaster; automatic own-account replies are ignored',async()=>{
 const clerk=new Clerk({now:()=>1000,ownUserId:'owner'});
 clerk.ingest({ts:1000,kind:'chat',user:'owner',text:'bot reply',meta:{userId:'owner'}});assert.equal(clerk.timeline.size,0);
 await clerk.ingest({ts:1000,kind:'chat',user:'owner',text:'!recap',meta:{userId:'owner',isBroadcaster:true}});assert.equal(clerk.updatedAt,1000);
});
test('Worker summarizes without Twitch credentials, rejects malformed/large requests and foreign origins',async()=>{
 const request=(body,headers={})=>new Request('https://clerk.example/api/summarize',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'test-worker',...headers},body:JSON.stringify(body)});
 let response=await worker.fetch(request({items:fixture.items.slice(0,20),now:100000,viewer:'fern'}),{});assert.equal(response.status,200);let data=await response.json();assert.equal(data.backend,'mock');assert.equal(data.summary.bullets.length,3);
 response=await worker.fetch(request({items:[{ts:'bad'}],now:100}),{});assert.equal(response.status,400);
 response=await worker.fetch(request({text:'x'.repeat(270000)}),{});assert.equal(response.status,413);
 response=await worker.fetch(request({items:[],now:0},{Origin:'https://foreign.example'}),{});assert.equal(response.status,403);
});
test('Worker rate limits per IP and resets after one minute',()=>{for(let i=0;i<12;i++)assert.equal(rateLimit('limited-ip',100),true);assert.equal(rateLimit('limited-ip',100),false);assert.equal(rateLimit('another-ip',100),true);assert.equal(rateLimit('limited-ip',60100),true);});
test('Worker maps panel and overlay to shared app assets',async()=>{for(const page of ['/panel','/overlay','/demo']){let path;const response=await worker.fetch(new Request(`https://clerk.example${page}`),{ASSETS:{fetch:async req=>{path=new URL(req.url).pathname;return new Response('app');}}});assert.equal(response.status,200);assert.equal(path,'/app.html');}});
