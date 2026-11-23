import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoStore} from './demo-store.js';

test('edits stay isolated and a new store resets to fictional samples', async () => {
  const one = createDemoStore(), two = createDemoStore();
  const first = await one('/api/entries');
  const {entry} = await one('/api/entries', {method:'POST', body:{type:'note', note:'Test-only note'}});
  assert.ok((await one('/api/entries')).entries.some(e => e.id === entry.id));
  assert.equal((await two('/api/entries')).entries.some(e => e.note === 'Test-only note'), false);
  first.entries[0].note = 'Mutated response';
  assert.equal((await one('/api/entries')).entries.some(e => e.note === 'Mutated response'), false);
  await one('/api/entries/' + entry.id, {method:'PUT',body:{type:'note',note:'Edited'}});
  assert.equal((await one('/api/entries')).entries.find(e => e.id === entry.id).note, 'Edited');
  await one('/api/entries/' + entry.id, {method:'DELETE'});
  assert.equal((await one('/api/entries')).entries.some(e => e.id === entry.id), false);
});
test('feed and sleep timers are independent; duplicate active feeds are rejected', async () => {
  const api = createDemoStore();
  const feed = await api('/api/entries', {method:'POST',body:{type:'feeding',side:'bottle'}});
  const sleep = await api('/api/entries', {method:'POST',body:{type:'sleep',sleepType:'nap'}});
  await assert.rejects(api('/api/entries', {method:'POST',body:{type:'feeding',side:'left'}}));
  await api('/api/entries/'+feed.entry.id, {method:'PUT',body:{type:'feeding',side:'bottle',startedAt:feed.entry.time_start,stoppedAt:new Date().toISOString(),volume:2,volumeUnit:'oz'}});
  assert.equal((await api('/api/entries')).entries.find(e => e.id === sleep.entry.id).time_stop, null);
});
test('unknown routes cannot access live services', async () => {
  await assert.rejects(createDemoStore()('https://example.com/private'));
});
