#!/usr/bin/env node
// PATH: tools/build-manifests.mjs
// Node >= 18, no external deps.
// Usage:
//   node tools/build-manifests.mjs --input ./source/v3_curated --out ./cdn --version 20250822 --checksum
import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const INPUT = args.input || './source/v3_curated';
const OUT = args.out || './cdn';
const VERSION = normalizeVersion(args.version || yyyymmdd(new Date()));
const DO_CHECKSUM = !!args.checksum;

async function main() {
  const tbOutBase = path.join(OUT, 'textbook');
  const tbVerDir = path.join(tbOutBase, `v${VERSION}`);
  const tbLatestDir = path.join(tbOutBase, 'latest');
  await cleanDir(tbVerDir);
  await mkdir(tbLatestDir, { recursive: true });
  const tbInBase = path.join(INPUT, 'textbook');

  const curatedRootPath = path.join(tbInBase, 'index.json');
  const curatedRoot = await readJSON(curatedRootPath, 'textbook root index');

  const chapters = ensureChapters(curatedRoot);
  const rootOut = { version: `${VERSION}`, chapters: [] };

  for (const ch of chapters) {
    const chId = ch.id || ch.slug || ch.title || 'CH';
    const chDir = path.join(tbVerDir, chId);
    const chArticlesDir = path.join(chDir, 'articles');
    await mkdir(chArticlesDir, { recursive: true });

    let sections = Array.isArray(ch.sections) ? ch.sections : null;
    if (!sections) sections = await scanSectionsFromFs(tbInBase, chId);

    const outSections = [];
    for (const s of sections) {
      const sid = s.id || s.slug || s.file || s.title;
      const fileIn = resolveArticleSourceFile(tbInBase, chId, s);
      const articleIn = await readJSON(fileIn, `article ${sid}`);

      const outArticle = await transformArticleToCdnSchema(articleIn, chId, sid, DO_CHECKSUM);
      const fileRel = `${chId}/articles/${sid}.json`;
      const fileOut = path.join(tbVerDir, fileRel);
      await writeJSON(fileOut, outArticle);

      const entry = {
        id: sid,
        slug: s.slug || undefined,
        title: outArticle.title || s.title || sid,
        file: fileRel,
        ...(outArticle.sha256 ? { sha256: outArticle.sha256 } : {}),
      };
      outSections.push(entry);
    }

    const chIdx = {
      chapter: { id: chId, slug: ch.slug || ('' + chId).toLowerCase(), title: ch.title || `Kapitel ${chId}` },
      sections: outSections,
    };
    await writeJSON(path.join(tbVerDir, chId, 'index.json'), chIdx);

    rootOut.chapters.push({ id: chId, title: chIdx.chapter.title, index: `${chId}/index.json` });
  }

  await writeJSON(path.join(tbVerDir, 'index.json'), rootOut);
  await writeJSON(path.join(tbOutBase, 'latest', 'index.json'), { version: `${VERSION}`, index: `../v${VERSION}/index.json` });

  await maybeBuildNamespace('exercises');
  await maybeBuildNamespace('exams');
}

function ensureChapters(root) {
  if (root && Array.isArray(root.chapters) && root.chapters.length) return root.chapters;
  throw new Error('Root index missing chapters[]');
}

async function maybeBuildNamespace(ns) {
  const baseIn = path.join(INPUT, ns);
  if (!(await exists(baseIn))) return;
  const baseOut = path.join(OUT, ns);
  const verDir = path.join(baseOut, `v${VERSION}`);
  const latestDir = path.join(baseOut, 'latest');
  await cleanDir(verDir);
  await mkdir(latestDir, { recursive: true });

  const chapters = await listDirs(baseIn);
  const root = { version: `${VERSION}`, chapters: [] };

  for (const chId of chapters) {
    const chDirIn = path.join(baseIn, chId);
    const files = (await listJsonFiles(chDirIn)).sort();
    const outSections = [];
    for (const f of files) {
      const sid = path.basename(f, '.json');
      const rel = `${chId}/${sid}.json`;
      const outPath = path.join(verDir, rel);
      await mkdir(path.dirname(outPath), { recursive: true });
      const raw = await readFile(path.join(chDirIn, f), 'utf8');
      await writeFile(outPath, raw, 'utf-8');
      const entry = { id: sid, file: rel };
      if (DO_CHECKSUM) entry.sha256 = sha256(raw);
      outSections.push(entry);
    }
    const idx = { chapter: { id: chId, slug: chId.toLowerCase(), title: chId }, sections: outSections };
    await writeJSON(path.join(verDir, chId, 'index.json'), idx);
    root.chapters.push({ id: chId, title: chId, index: `${chId}/index.json` });
  }

  await writeJSON(path.join(verDir, 'index.json'), root);
  await writeJSON(path.join(latestDir, 'index.json'), { version: `${VERSION}`, index: `../v${VERSION}/index.json` });
}

// ------------- helpers -------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}
function yyyymmdd(d) { const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0'); return `${y}${m}${day}`; }
function normalizeVersion(v) { return String(v).replace(/^v/i, ''); }
async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function cleanDir(p) { await rm(p, { recursive: true, force: true }); await mkdir(p, { recursive: true }); }
async function readJSON(p, label = 'json') {
  const raw = await readFile(p, 'utf8').catch(e => { throw new Error(`Cannot read ${label} at ${p}: ${e.message}`); });
  try { return JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in ${label} at ${p}: ${e.message}`); }
}
async function writeJSON(p, obj) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(obj, null, 2), 'utf8'); }
async function listDirs(base) { const e = await readdir(base, { withFileTypes: true }).catch(() => []); return e.filter(d => d.isDirectory()).map(d => d.name); }
async function listJsonFiles(base) { const e = await readdir(base, { withFileTypes: true }).catch(() => []); return e.filter(f => f.isFile() && f.name.toLowerCase().endsWith('.json')).map(f => f.name); }
async function scanSectionsFromFs(tbInBase, chId) {
  const dir = path.join(tbInBase, 'articles', chId);
  const files = await listJsonFiles(dir);
  return files.map(f => ({ id: path.basename(f, '.json'), file: `articles/${chId}/${f}` }));
}
function resolveArticleSourceFile(tbInBase, chId, s) {
  const rel = s.file ? s.file.replace(/^\.?\/*/, '') : `articles/${chId}/${(s.id || 'section')}.json`;
  return path.join(tbInBase, rel);
}
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ' '); }
function slug(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function estimateReadingTime(html) { const text = stripTags(html); const words = text.split(/\s+/).filter(Boolean).length; return Math.max(1, Math.round(words / 180)); }
function extractHeadingsFromHTML(html) {
  const rx = /<(h[1-6])[^>]*>(.*?)<\/\1>/gi; const out = []; let m;
  while ((m = rx.exec(html)) !== null) { const level = parseInt(m[1].slice(1), 10); const text = stripTags(m[2]).trim(); const id = slug(text) || `h-${out.length + 1}`; out.push({ id, text, level }); }
  return out;
}
function renderBlocksToHTML(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'heading': { const level = clamp(parseInt(b.level || 2, 10), 1, 6); parts.push(`<h${level}>${escapeHtml(b.text || '')}</h${level}>`); break; }
      case 'paragraph': { parts.push(`<p>${escapeHtml(b.text || '')}</p>`); break; }
      case 'list': { const tag = b.ordered ? 'ol' : 'ul'; const items = Array.isArray(b.items) ? b.items : []; parts.push(`<${tag}>${items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</${tag}>`); break; }
      case 'example': { parts.push(`<div class="example"><strong>Beispiel:</strong> ${escapeHtml(b.text || '')}</div>`); break; }
      case 'note': { parts.push(`<div class="note">${escapeHtml(b.text || '')}</div>`); break; }
      case 'formula': { parts.push(`<pre class="formula"><code>${escapeHtml(b.latex || b.tex || '')}</code></pre>`); break; }
      case 'code': { parts.push(`<pre><code>${escapeHtml(b.code || '')}</code></pre>`); break; }
      case 'step': { const title = b.title ? `<strong>${escapeHtml(b.title)}.</strong> ` : ''; parts.push(`<p>${title}${escapeHtml(b.text || '')}</p>`); break; }
      default: { parts.push(`<pre class="raw">${escapeHtml(JSON.stringify(b))}</pre>`); }
    }
  }
  return parts.join('\n');
}

main().catch(err => { console.error('[build-manifests] ERROR:', err.message); process.exit(1); });
