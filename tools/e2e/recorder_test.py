"""Recorder test: guided recording with a scripted WAV mic, checks the saved WAV."""
import json, os, struct, subprocess, time, base64
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, 'out')
subprocess.run(['node', '-e', '''
const fs=require('fs');const sr=48000,dur=50,x=new Float32Array(sr*dur);let s=9;const r=()=>{s=(s*1664525+1013904223)%4294967296;return s/4294967296};
for(let i=0;i<x.length;i++)x[i]=(r()*2-1)*0.002;
for(let g=0;g<5;g++)for(let i=0;i<10;i++){const t=Math.round(sr*(4+g*8+i*0.45));for(let k=0;k<4000;k++)x[t+k]+=0.3*Math.exp(-k/600)*Math.sin(k*(0.2+g*0.05));}
const b=Buffer.alloc(44+x.length*2);b.write('RIFF',0);b.writeUInt32LE(36+x.length*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(x.length*2,40);
for(let i=0;i<x.length;i++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,x[i]))*32767),44+i*2);fs.writeFileSync(process.argv[1],b);''', f'{OUT}/rec_session.wav'], check=True)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={OUT}/rec_session.wav%noloop'])
    pg = b.new_context(**p.devices['Pixel 7']).new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:4173/?debug'); pg.click('#try'); pg.click('#allow'); t0 = time.time()
    pg.wait_for_selector('#flat-manual:not(.hidden)', timeout=5000)
    pg.evaluate("document.querySelector('#open-recorder').click()"); pg.click('#rec-start')
    pg.wait_for_selector('#rec-save:not(.hidden)', timeout=70000)
    info = pg.inner_text('#rec-info')
    data = pg.evaluate("""async () => { const a = document.querySelector('#rec-save'); const buf = await (await fetch(a.href)).arrayBuffer();
      let s = ''; const u = new Uint8Array(buf.slice(0, 44)); for (const c of u) s += String.fromCharCode(c); return [btoa(s), buf.byteLength, a.download]; }""")
    pg.screenshot(path=f'{OUT}/rec-done.png'); b.close()
hdr = base64.b64decode(data[0]); ch, sr = struct.unpack('<HI', hdr[22:28]); size = data[1]
print('info:', info); print('file:', data[2], size, 'bytes; channels', ch, 'rate', sr, 'seconds', round((size - 44) / (2 * ch * sr), 1))
print('errors:', errs)
