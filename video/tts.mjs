import { readFileSync, writeFileSync } from 'node:fs';
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY not set');
const text = readFileSync('narration.txt', 'utf8').replace(/^﻿/, '');
const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
  method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
});
if (!r.ok) { console.log(r.status, (await r.text()).slice(0, 400)); process.exit(1); }
writeFileSync('narration.mp3', Buffer.from(await r.arrayBuffer()));
console.log('ok');
