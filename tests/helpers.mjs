import { readFileSync } from 'node:fs';
export const fixture = name => JSON.parse(readFileSync(new URL('../testdata/contracts/' + name, import.meta.url), 'utf8'));
export const valid = fixture('events-valid.json');
export const signatures = fixture('signatures.json');
export const chatId = valid[0].chat_id;
export const turnId = valid.find(e => e.turn_id)?.turn_id;
export const json = (value, status=200, headers={}) => new Response(JSON.stringify(value), { status, headers: { 'content-type':'application/json', ...headers } });
export const bytes = (text, chunkSize=999999) => {
 const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
 return new ReadableStream({ start(c) { for(let i=0;i<data.length;i+=chunkSize)c.enqueue(data.slice(i,i+chunkSize)); c.close(); } });
};
export const sse = (events,chunkSize=999999) => new Response(bytes(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''), chunkSize),{headers:{'content-type':'text/event-stream'}});
export const event = (type,seq=1,changes={}) => {
 const source=valid.find(e=>e.type===type);
 if(!source&&['turn.failed','turn.cancelled'].includes(type)){const e=event('turn.completed',seq,changes);e.type=type;delete e.data.finish_reason;if(type==='turn.failed'){e.data.code='failed';e.data.message='Failure';}else e.data.reason='cancelled';return e;}
 if(!source)throw Error('Fixture not found: '+type);
 return {...structuredClone(source),seq,...changes};
};
export const requestEvent = (index=0,seq=1) => {
 const e=event('agent.tool.request',seq); const v=signatures.vectors[index];
 e.data={call_id:v.call_id,tool_name:v.tool_name,kind:'client',args:JSON.parse(v.args_json),signature:v.signature};return e;
};
export const tick = () => new Promise(r=>setImmediate(r));
