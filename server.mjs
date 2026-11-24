#!/usr/bin/env node
// agro-OPS — sales desk for a fresh produce wholesaler.
// Zero dependencies: node:http + node:sqlite. Run: node server.mjs
//   --reset  wipe the database and reseed demo data
//   --lan    listen on all interfaces so the team can open it from other machines
import { createServer } from 'node:http';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { DB_PATH, PUBLIC_DIR } from './lib/paths.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  console.log('Database reset.');
}

const { AppError } = await import('./lib/db.mjs');
const { ApiResult, FileResult, handleApi, PUBLIC_API } = await import('./lib/api.mjs');
const { maybeSeed } = await import('./lib/seed.mjs');
const { renderInvoice, renderDeliveryNote, renderBoatNote, renderItemReceipt, renderHarvestGrn, renderPriceEnquiry, renderLabourHire, renderDisposal, renderWeightLoss, renderStemWeight, renderTransferNote } = await import('./lib/print.mjs');
const { ensureAdminUser, getSessionUser } = await import('./lib/auth.mjs');
if (maybeSeed()) console.log('Seeded demo data. (--reset regenerates it; BAAZARU_NO_DEMO=1 starts blank.)');
if (ensureAdminUser()) console.log("Created user 'admin' using the supplied setup password.");

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (status === 413) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(buf);
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    // On overflow, keep draining (discarding) instead of destroying the socket —
    // destroying it would tear down the response too and the client would see a
    // connection reset instead of the 413.
    req.on('data', c => {
      if (oversized) return;
      size += c.length;
      if (size > max) {
        oversized = true;
        chunks.length = 0;
        reject(new AppError(413, 'Request too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversized) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sessionToken(req) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'baazaru_session') return v.join('=');
  }
  return '';
}

// Behind the Cloudflare tunnel every request arrives over loopback. Trust
// CF-Connecting-IP only then: Cloudflare overwrites it at its edge, while a
// direct LAN client (--lan) could set it to anything.
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const forwarded = req.headers['cf-connecting-ip'];
  return loopback && typeof forwarded === 'string' && forwarded ? forwarded : peer;
}

async function apiRequest(req, res, pathname, query) {
  try {
    const token = sessionToken(req);
    const user = getSessionUser(token);
    if (!user && !PUBLIC_API.has(`${req.method} ${pathname}`)) {
      return send(res, 401, { error: 'Sign in required' });
    }
    const slipUpload = req.method === 'POST' && /^\/api\/orders\/\d+\/slip$/.test(pathname);
    const body = req.method === 'POST' || req.method === 'PATCH'
      ? await readBody(req, slipUpload ? 9_000_000 : 1_000_000) : null;
    const ip = clientIp(req);
    const result = handleApi(req.method, pathname, query, body, { user, ip, token });
    if (result instanceof FileResult) {
      res.writeHead(200, {
        'Content-Type': result.type,
        'Content-Disposition': `inline; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      });
      return res.end(result.buf);
    }
    if (result instanceof ApiResult) {
      const buf = JSON.stringify(result.body);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': result.cookie,
      });
      res.end(buf);
    } else {
      send(res, 200, result);
    }
  } catch (err) {
    if (err instanceof AppError) {
      send(res, err.status, { error: err.message, ...err.extra });
    } else {
      console.error(err);
      send(res, 500, { error: 'Internal error' });
    }
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 404, { error: 'Not found' });
  try {
    if (!statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
    send(res, 200, readFileSync(file), MIME[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }
  if (pathname.startsWith('/api/')) {
    apiRequest(req, res, pathname, new URL(req.url, 'http://localhost').searchParams);
  } else if (req.method === 'GET' && pathname.startsWith('/print/')) {
    servePrint(req, res, pathname);
  } else if (req.method === 'GET') {
    serveStatic(res, pathname);
  } else {
    send(res, 405, { error: 'Method not allowed' });
  }
});

const PRINT_ROUTES = [
  [/^\/print\/invoice\/(\d+)$/, renderInvoice],
  [/^\/print\/delivery-note\/(\d+)$/, renderDeliveryNote],
  [/^\/print\/boat-note\/(\d+)$/, renderBoatNote],
  [/^\/print\/item-receipt\/(\d+)$/, renderItemReceipt],
  [/^\/print\/harvest-grn\/(\d+)$/, renderHarvestGrn],
  [/^\/print\/price-enquiry\/(\d+)$/, renderPriceEnquiry],
  [/^\/print\/labor-hire\/(\d+)$/, renderLabourHire],
  [/^\/print\/disposal\/(\d+)$/, renderDisposal],
  [/^\/print\/weight-loss\/(\d+)$/, renderWeightLoss],
  [/^\/print\/stem-weight\/(\d+)$/, renderStemWeight],
  [/^\/print\/transfer\/(\d+)$/, renderTransferNote],
];

function servePrint(req, res, pathname) {
  // Printed documents carry customer and financial data — session required.
  if (!getSessionUser(sessionToken(req))) {
    return send(res, 401,
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>agro-OPS</title></head>
       <body style="font-family:system-ui;padding:40px;color:#333">
       <p>Sign in first — <a href="/">open agro-OPS</a>, then print again.</p></body></html>`,
      'text/html; charset=utf-8');
  }
  for (const [rx, render] of PRINT_ROUTES) {
    const m = rx.exec(pathname);
    if (!m) continue;
    try {
      return send(res, 200, render(Number(m[1])), 'text/html; charset=utf-8');
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const msg = err instanceof AppError ? err.message : 'Internal error';
      if (status === 500) console.error(err);
      return send(res, status,
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>agro-OPS</title></head>
         <body style="font-family:system-ui;padding:40px;color:#333"><p>${msg
           .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</p>
         </body></html>`,
        'text/html; charset=utf-8');
    }
  }
  send(res, 404, { error: 'Not found' });
}

const PORT = Number(process.env.PORT) || 4780;
const HOST = args.has('--lan') ? '0.0.0.0' : '127.0.0.1';

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is agro-OPS already running? (PORT=... to change)`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`agro-OPS running at http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const i of ifaces ?? []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`  on your network: http://${i.address}:${PORT}`);
      }
    }
  }
});
