import { normalizeEntry } from './src/storage.mjs';
import { timingSafeEqual } from 'node:crypto';
import { verifyPassword, createSessionCookie, clearSessionCookie, isAuthenticated } from './src/auth.mjs';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
export default {
 async fetch(request, env) {
  try {
   const url = new URL(request.url), path = url.pathname;
   if(!env.APP_PASSWORD || env.APP_PASSWORD.startsWith('REPLACE_') || !env.SESSION_SECRET || env.SESSION_SECRET.startsWith('REPLACE_') || env.SESSION_SECRET.length<32) return json({error:'Configure a private password and a random session secret of at least 32 characters.'},503);
   if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({error:'Not configured'},503);
   if (path === '/api/backup' && request.method === 'GET') {
    const supplied = request.headers.get('Authorization') || '';
    const expected = `Bearer ${env.BACKUP_TOKEN || ''}`;
    if (!env.BACKUP_TOKEN || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return json({error:'Authentication required'},401);
    const result = await env.DB.prepare('SELECT data FROM entries ORDER BY time_start DESC, id').all();
    const entries = result.results.map(row => JSON.parse(row.data));
    return json({schemaVersion:1, exportedAt:new Date().toISOString(), count:entries.length, entries});
   }
   if (!['GET','HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin) return json({error:'Invalid origin'},403);
   const authenticated = isAuthenticated(request.headers.get('Cookie') || '', env);
   if (path === '/login-status') return json({authenticated});
   if (path === '/login' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'local', now = Date.now();
    const row = await env.DB.prepare('SELECT * FROM login_attempts WHERE ip=?').bind(ip).first();
    if (row && row.reset_at > now && row.attempts >= 10) return json({error:'Try again in 15 minutes'},429);
    const body = await readBody(request);
    if (!verifyPassword(body.password,env)) {
     await env.DB.prepare('INSERT INTO login_attempts(ip,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(ip) DO UPDATE SET attempts=CASE WHEN reset_at < ? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at < ? THEN ? ELSE reset_at END').bind(ip,now+900000,now,now,now+900000).run();
     return json({error:'Invalid password'},401);
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip=? OR reset_at < ?').bind(ip,now).run();
    return json({ok:true},200,{'Set-Cookie':createSessionCookie(env)});
   }
   if (path === '/logout' && request.method === 'POST') return json({ok:true},200,{'Set-Cookie':clearSessionCookie()});
   if (path.startsWith('/api/')) {
    if (!authenticated) return json({error:'Authentication required'},401);
    if (path === '/api/entries' && request.method === 'GET') {
     const all = url.searchParams.get('limit') === 'all';
     const cutoff = new Date(Date.now()-4*86400000).toISOString();
     const result = all ? await env.DB.prepare('SELECT data FROM entries ORDER BY time_start DESC').all() : await env.DB.prepare("SELECT data FROM entries WHERE time_start >= ? OR (json_extract(data, '$.sleep_type') IS NOT NULL AND json_extract(data, '$.time_stop') IS NULL) ORDER BY time_start DESC").bind(cutoff).all();
     const entries = result.results.map(r=>JSON.parse(r.data));
     for (const e of entries) if ((e.left_side || e.right_side || e.bottle) && !e.time_stop && Date.now()-Date.parse(e.time_start)>=3600000) {
      e.time_stop=new Date(Date.parse(e.time_start)+3600000).toISOString();
      e.time_display = display(e.time_start,e.time_stop);
      await env.DB.prepare('UPDATE entries SET data=? WHERE id=? AND json_extract(data,\'$.time_stop\') IS NULL').bind(JSON.stringify(e),e.id).run();
     }
     return json({entries});
    }
    if (path === '/api/entries' && request.method === 'POST') {
     const entry = normalizeEntry({...await readBody(request),id:crypto.randomUUID()});
     let result;
     if ((entry.left_side || entry.right_side || entry.bottle) && !entry.time_stop) {
      result=await env.DB.prepare("INSERT INTO entries(id,time_start,data) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM entries WHERE json_extract(data,'$.time_stop') IS NULL AND (json_extract(data,'$.left_side')=1 OR json_extract(data,'$.right_side')=1 OR json_extract(data,'$.bottle')=1) AND time_start > ?)").bind(entry.id,entry.time_start,JSON.stringify(entry),new Date(Date.now()-3600000).toISOString()).run();
      if (!result.meta.changes) return json({error:'A feeding is already active. Refresh to see it.'},409);
     } else if (entry.sleep_type && !entry.time_stop) {
      result = await env.DB.prepare("INSERT INTO entries(id,time_start,data) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM entries WHERE json_extract(data,'$.time_stop') IS NULL AND json_extract(data,'$.sleep_type') IS NOT NULL)").bind(entry.id,entry.time_start,JSON.stringify(entry)).run();
      if (!result.meta.changes) return json({error:'Sleep is already active. Refresh to see it.'},409);
     } else await env.DB.prepare('INSERT INTO entries VALUES(?,?,?)').bind(entry.id,entry.time_start,JSON.stringify(entry)).run();
     return json({entry},201);
    }
    const match=path.match(/^\/api\/entries\/([^/]+)$/);
    if (match) {
     const id=decodeURIComponent(match[1]);
     const old=await env.DB.prepare('SELECT data FROM entries WHERE id=?').bind(id).first();
     if (!old) return json({error:'Entry not found'},404);
     if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM entries WHERE id=?').bind(id).run();return json({ok:true});}
     if(request.method==='PUT'){
      const entry={...normalizeEntry(await readBody(request)),id,created_at:JSON.parse(old.data).created_at};
      await env.DB.prepare('UPDATE entries SET time_start=?,data=? WHERE id=?').bind(entry.time_start,JSON.stringify(entry),id).run();
      return json({entry});
     }
    }
    return json({error:'Not found'},404);
   }
   return env.ASSETS.fetch(request);
  } catch(error) {return json({error:error.statusCode?error.message:'Request failed'},error.statusCode||500);}
 }
};
async function readBody(request){const text=await request.text();if(text.length>16000)throw Object.assign(new Error('Entry too large'),{statusCode:413});try{return JSON.parse(text)}catch{throw Object.assign(new Error('Invalid JSON'),{statusCode:400});}}
function display(start,stop){const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'});return `${f.format(new Date(start))} to ${f.format(new Date(stop))}`;}
