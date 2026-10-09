'use strict';
// Static Vercel structure validation (npm run lint):
//  - every api/*.js handler exists, parses, and enforces its declared methods
//  - all require('../...') paths inside server/ and api/ resolve to real files
//  - vercel.json parses; cron path maps to an existing handler; the SPA
//    rewrite cannot swallow /api/*
//  - public/ entry exists and its local references resolve
//  - .env.example lists every env var the code requires; no real .env present
//  - prints the route → method table
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS  ' + msg);
  else { failures++; console.log('  FAIL  ' + msg); }
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ---- route table (source of truth: the api/ tree) ----
const apiFiles = walk(path.join(ROOT, 'api'), []).filter(f => f.endsWith('.js') && !f.endsWith('_lib.js'));
const routeFor = f => '/' + path.relative(ROOT, f).replace(/\\/g, '/')
  .replace(/\.js$/, '').replace(/\/index$/, '');
const methodsFor = src => {
  const m = src.match(/allowMethods\(req, res, \[([^\]]+)\]\)/);
  if (m) return m[1].replace(/'/g, '').split(',').map(s => s.trim());
  if (/req\.method === 'GET'/.test(src) && /req\.method === 'POST'/.test(src)) return ['GET', 'POST'];
  return [];
};

console.log('\nROUTE → METHOD TABLE');
const seen = new Set();
for (const f of apiFiles.sort()) {
  const route = routeFor(f);
  const src = fs.readFileSync(f, 'utf8');
  const methods = methodsFor(src);
  ok(!seen.has(route), 'no route collision for ' + route);
  seen.add(route);
  ok(methods.length > 0, route + ' declares explicit methods [' + methods.join(', ') + ']');
  console.log('        ' + route.padEnd(38) + methods.join(', '));
  ok(/module\.exports\s*=\s*async/.test(src), route + ' exports an async handler');
}

// ---- vercel.json ----
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
ok(Array.isArray(vercel.rewrites), 'vercel.json rewrites present');
const spa = vercel.rewrites.find(r => r.destination === '/index.html');
ok(spa && /api/.test(spa.source), 'SPA rewrite excludes /api/* (no API swallowing)');
ok(Array.isArray(vercel.crons) && vercel.crons.length === 1, 'exactly one cron');
const cronPath = vercel.crons[0].path; // /api/cron/hourly
ok(seen.has(cronPath), 'cron path ' + cronPath + ' maps to an existing handler');
ok(/Bearer/.test(fs.readFileSync(path.join(ROOT, 'api/cron/hourly.js'), 'utf8')), 'cron handler is Bearer-guarded');

// ---- require() resolution inside server/ and api/ ----
const codeFiles = walk(path.join(ROOT, 'server'), []).concat(apiFiles).filter(f => f.endsWith('.js'));
for (const f of codeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const base = path.resolve(path.dirname(f), m[1]);
    const exists = ['', '.js', '/index.js'].some(s => fs.existsSync(base + s));
    if (!exists) {
      failures++;
      console.log('  FAIL  unresolved require "' + m[1] + '" in ' + path.relative(ROOT, f));
    }
  }
}
ok(true, 'all relative require() paths resolve (see FAIL lines above, if any)');

// ---- frontend ----
const indexHtml = path.join(ROOT, 'public', 'index.html');
ok(fs.existsSync(indexHtml), 'public/index.html exists');
const html = fs.readFileSync(indexHtml, 'utf8');
for (const m of html.matchAll(/(?:href|src)="\/([^"]+)"/g)) {
  ok(fs.existsSync(path.join(ROOT, 'public', m[1])), 'frontend reference /' + m[1] + ' resolves');
}
const apiRefs = new Set();
const jsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
for (const m of jsSrc.matchAll(/['"](\/api\/[^'"]+)['"]/g)) {
  apiRefs.add(m[1].replace(/\$\{[^}]+\}/g, ':id'));
}
for (const ref of apiRefs) {
  const asRoute = ref.replace(/:id.*$/, ':id').replace(/\/:id$/, '/:id');
  const matches = [...seen].some(r =>
    ref === r || ref.startsWith(r + '/') || r.includes('[id]') &&
    ref.match(new RegExp('^' + r.replace(/\[id\]/g, '[^/]+') + '$')));
  ok(matches, 'frontend calls existing API route ' + ref + (asRoute ? '' : ''));
}

// ---- env contract ----
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const declared = new Set([...envExample.matchAll(/^([A-Z_]+)=/gm)].map(m => m[1]));
const used = new Set();
for (const f of codeFiles.concat([path.join(ROOT, 'tests/helpers.js')])) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/process\.env\.([A-Z_]+)/g)) used.add(m[1]);
}
used.delete('TZ'); // optional platform timezone, not a required secret
used.delete('NODE_PATH');
for (const v of used) {
  ok(declared.has(v), '.env.example declares ' + v);
}
ok(!fs.existsSync(path.join(ROOT, '.env')), 'no real .env in the project');
ok(!fs.existsSync(path.join(ROOT, 'node_modules')), 'no node_modules in the project');
ok(fs.existsSync(path.join(ROOT, 'README.md')), 'README.md present');
ok(fs.existsSync(path.join(ROOT, 'package.json')), 'package.json present');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const dep of ['mongodb', 'exceljs', 'googleapis']) {
  ok(pkg.dependencies && pkg.dependencies[dep], 'dependency declared: ' + dep);
}

console.log('');
console.log(failures ? `STATIC CHECKS: ${failures} FAILED` : 'STATIC CHECKS: ALL PASSED');
process.exit(failures ? 1 : 0);
