// The AI Plague: web server. Node 18+, no dependencies.
// Run:  ADMIN_TOKEN=<secret> node server/server.js   then open http://localhost:3000
// API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) are read from the environment and never sent to browsers.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function isAdmin(req, url) {
  if (!ADMIN_TOKEN) return false;   // no token configured: admin actions are disabled
  return req.headers['x-admin-token'] === ADMIN_TOKEN || url.searchParams.get('token') === ADMIN_TOKEN;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, engine.fullState());
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(engine.fullState())}\n\n`);
    engine.subscribe(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => clearInterval(ping));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/admin/start' || url.pathname === '/api/admin/stop')) {
    if (!isAdmin(req, url)) return json(res, 403, { error: 'forbidden' });
    const out = url.pathname.endsWith('start') ? engine.startMatch() : engine.stopMatch();
    return json(res, out.error ? 409 : 200, out);
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

  const file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`The AI Plague on http://localhost:${PORT} (admin ${ADMIN_TOKEN ? 'enabled' : 'disabled'})`));
