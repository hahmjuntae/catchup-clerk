import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../src/core/timeline.js';
import { digest } from '../src/core/digest.js';
import { Commands, parseCommand } from '../src/core/commands.js';
import { summarize, mockSummarize, repairJSON } from '../src/core/summarizer.js';
const chat = (ts, text = 'hello', user = 'ash') => ({ ts, kind: 'chat', user, text, meta: {} });
test('timeline prunes by window, bounds capacity, and sorts late deliveries', () => {
  const t = new Timeline({ windowMs: 100, maxItems: 3 });
  [100,150,140,180].forEach(ts=>t.add(chat(ts),180));
  assert.deepEqual(t.snapshot(200).map(x=>x.ts),[140,150,180]);
  assert.equal(t.add(chat(99),200),false);
  assert.deepEqual(t.snapshot(260).map(x=>x.ts),[180]);
  assert.equal(t.snapshot(281).length,0);
});
test('5000-message flood is bounded, sampled evenly, retains every event and top chatters', () => {
  const items = Array.from({length:5000},(_,i)=>chat(i, i%3===0?'KEKW KEKW':i%3===1?'same repeated spam':`Floor discussion number ${i}`,i%2?'regular':'visitor'));
  items.splice(2500,0,{ts:2500,kind:'event',text:'Moss arrives with 120 viewers',eventType:'channel.raid'});
  const d=digest(items);
  assert.equal(d.chatCount,5000); assert.equal(d.events.length,1); assert.ok(d.emoteCount>1500);
  assert.ok(d.chat.length<=70); assert.ok(JSON.stringify(d).length<14000);
  assert.ok(d.chat.some(x=>x.text.includes('4997'))); assert.ok(d.chat[0].repeats>1000);
  assert.equal(d.topChatters[0].count,2500);
});
test('strict commands, own account ignore, per-user and global cooldowns, mod recap', () => {
  assert.equal(parseCommand(' !CATCHUP '),'catchup'); assert.equal(parseCommand('!catchup please'),null);
  assert.equal(parseCommand('hi !catchup'),null);
  const c=new Commands({ownUserId:'bot'});
  assert.equal(c.check({...chat(0,'!catchup'),meta:{userId:'bot'}},0).ignored,true);
  assert.equal(c.check(chat(0,'!catchup'),0).allowed,true);
  assert.equal(c.check(chat(0,'!catchup','bee'),14999).allowed,false);
  assert.equal(c.check(chat(0,'!catchup','bee'),15000).allowed,true);
  assert.equal(c.check(chat(0,'!catchup'),59999).allowed,false);
  assert.equal(c.check(chat(0,'!catchup'),60000).allowed,true);
  assert.equal(c.check(chat(0,'!recap'),60000).allowed,false);
  assert.equal(c.check({...chat(0,'!recap'),meta:{isMod:true}},60000).allowed,true);
});
test('mock is deterministic, structured, and chat stays within 450 characters', async () => {
  const items=[chat(1000,'The glass warden boss is defeated. Victory!'),chat(2000,'emotional support pot'),chat(3000,'Does the lantern heal?')];
  const a=mockSummarize(items,{viewer:'new_viewer'});
  assert.equal(a.bullets.length,3); assert.ok(a.chatReply.length<=450); assert.ok(a.topic.includes('defeated'));
  assert.ok(a.jokes.length); assert.ok(a.moments.length); assert.equal(typeof a.tellNewcomers,'string');
  assert.deepEqual(await summarize(items,{now:4000,viewer:'new_viewer'}),a);
});
test('LLM JSON fences/trailing commas repair, missing fields repair, and length limits', async () => {
  assert.deepEqual(repairJSON('Here: ```json\n{"topic":"hello",}\n```'),{topic:'hello'});
  const result=await summarize([], {env:{LLM_API_KEY:'test'}, fetchImpl:async()=>Response.json({choices:[{message:{content:'```json\n{"topic":"Live run","bullets":["one",],"chatReply":"'+ 'x'.repeat(700)+'"}\n```'}}]})});
  assert.equal(result.topic,'Live run'); assert.equal(result.bullets.length,3); assert.equal(result.chatReply.length,450);
});
test('LLM failures and a hung request return mock within deadline',async()=>{
  const fallback=mockSummarize([]);
  assert.deepEqual(await summarize([],{env:{LLM_API_KEY:'test'},fetchImpl:async()=>Response.json({}, {status:429})}),fallback);
  assert.deepEqual(await summarize([],{env:{LLM_API_KEY:'test'},fetchImpl:()=>new Promise(()=>{}),timeoutMs:10}),fallback);
  assert.deepEqual(await summarize([],{env:{LLM_API_KEY:'test'},fetchImpl:async()=>Response.json({choices:[{message:{content:'not JSON'}}]})}),fallback);
});
