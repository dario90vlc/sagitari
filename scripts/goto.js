'use strict';
/* Click a nav view in SAGITARI over CDP. Usage: node goto.js <view> */
const http = require('http');
const WebSocket = require('ws');

const view = process.argv[2];
if (!view) { console.error('usage: node goto.js <view>'); process.exit(1); }

http.get('http://127.0.0.1:9333/json', (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    const page = JSON.parse(d).find((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (!page) { console.error('PAGE_NOT_FOUND'); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.querySelector('[data-view="${view}"]')?.click(); 'OK'` } }));
      setTimeout(() => { ws.close(); process.exit(0); }, 300);
    });
    ws.on('error', (e) => { console.error(e.message); process.exit(1); });
  });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
