#!/usr/bin/env node
// PATH: tools/build-manifests.mjs
// Node >= 18, no external deps.
// Usage:
//   node tools/build-manifests.mjs --input ./source/v3_curated --out ./cdn --version 20250822 --checksum
//
// Converts curated textbook/exercises/exams into versioned CDN layout with manifests.
// - Textbook root:   /textbook/vYYYYMMDD/index.json
// - Chapter subidx:  /textbook/vYYYYMMDD/M01/index.json
// - Articles:        /textbook/vYYYYMMDD/M01/articles/M01L01.json
// - Locator:         /textbook/latest/index.json
//
// The script accepts curated "v3_curated/textbook/index.json" plus "articles/<chapter>/*.json".
// It renders article "body_html" from simple block structures if present; otherwise passes through.

import { readFile, writeFile, mkdir, rm, readdir, stat, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const INPUT = args.input || './source/v3_curated';
const OUT = args.out || './cdn';
const VERSION = normalizeVersion(args.version || yyyymmdd(new Date()));
const DO_CHECKSUM = !!args.checksum;

async function main() {
  const t0 = Date.now();
  // Prepare output dirs
  const tbOutBase = path.join(OUT, 'textbook');
  const tbVerDir = path.join(tbOutBase, `v${VERSION}`);
  const tbLatestDir = path.join(tbOutBase, 'latest');
  await cleanDir(tbVerDir);
  await mkdir(tbLatestDir, { recursive: true });

  const tbInBase = path.join(INPUT, 'textbook');

  // Load curated root
  const curatedRootPath = path.join(tbInBase, 'index.json');
  const curatedRoot = await readJSON(curatedRootPath, 'textbook root index');

  // Build textbook manifests
  const chapters = ensureChapters(curatedRoot);
  const rootOut = { version: `${VERSION}`, chapters: [] };

  for (const ch of chapters) {
    const chId = ch.id || ch.slug || ch.title || 'CH';
    const chDir = path.join(tbVerDir, chId);
    const chArticlesDir = path.join(chDir, 'articles');
    await mkdir(chArticlesDir, { recursive: true });

    // Determine sections: from curated index if present, else by scanning input articles dir
    let sections = Array.isArray(ch.sections) ? ch.sections : null;
    if (!sections) {
      sections = await scanSectionsFromFs(tbInBase, chId);
    }

    // Produce chapter index + transform each section article to CDN schema
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

    // Write chapter index
    const chIdx = {
      chapter: {
        id: chId,
        slug: ch.slug || ('' + chId).toLowerCase(),
        title: ch.title || `Kapitel ${chId}`,
      },
      sections: outSections,
    };
    const chIdxPath = path.join(tbVerDir, chId, 'index.json');
    await writeJSON(chIdxPath, chIdx);

    rootOut.chapters.push({
      id: chId,
      title: chIdx.chapter.title,
      index: `${chId}/index.json`,
    });
  }

  // Write root manifest
  const rootOutPath = path.join(tbVerDir, 'index.json');
  await writeJSON(rootOutPath, rootOut);

  // Write locator
  const latestPath = path.join(tbLatestDir, 'index.json');
  await writeJSON(latestPath, { version: `${VERSION}`, index: `../v${VERSION}/index.json` });

  // Optional: exercises / exams if present
  await maybeBuildNamespace('exercises');
  await maybeBuildNamespace('exams');

  const dt = Date.now() - t0;
  log(`Done in ${dt}ms → ${path.relative(process.cwd(), tbVerDir)}`);
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
      // Copy through 1:1 (do not transform for now)
      const rel = `${chId}/${sid}.json`;
      const outPath = path.join(verDir, rel);
      await mkdir(path.dirname(outPath), { recursive: true });
      const raw = await readFile(path.join(chDirIn, f), 'utf8');
      await writeFile(outPath, raw, 'utf8');
      const entry = { id: sid, file: rel };
      if (DO_CHECKSUM) entry.sha256 = sha256(raw);
      outSections.push(entry);
    }
    const idx = {
      chapter: { id: chId, slug: chId.toLowerCase(), title: chId },
      sections: outSections,
    };
    await writeJSON(path.join(verDir, chId, 'index.json'), idx);
    root.chapters.push({ id: chId, title: chId, index: `${chId}/index.json` });
  }

  await writeJSON(path.join(verDir, 'index.json'), root);
  await writeJSON(path.join(latestDir, 'index.json'), { version: `${VERSION}`, index: `../v${VERSION}/index.json` });
  log(`Namespace '${ns}' built → ${path.relative(process.cwd(), verDir)}`);
}

// ---------------- helpers ----------------
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
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function normalizeVersion(v) {
  return String(v).replace(/^v/i, '');
}
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}
async function cleanDir(p) {
  await rm(p, { recursive: true, force: true });
  await mkdir(p, { recursive: true });
}
async function readJSON(p, label = 'json') {
  const raw = await readFile(p, 'utf8').catch(e => {
    throw new Error(`Cannot read ${label} at ${p}: ${e.message}`);
  });
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`Invalid JSON in ${label} at ${p}: ${e.message}`);
  }
}
async function writeJSON(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}
async function listDirs(base) {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}
async function listJsonFiles(base) {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json')).map(e => e.name);
}
async function scanSectionsFromFs(tbInBase, chId) {
  const dir = path.join(tbInBase, 'articles', chId);
  const files = await listJsonFiles(dir);
  return files.map(f => ({ id: path.basename(f, '.json'), file: `articles/${chId}/${f}` }));
}
function resolveArticleSourceFile(tbInBase, chId, s) {
  // Prefer explicit file path, else infer from id
  const rel = s.file
    ? s.file.replace(/^\.?\/*/, '')
    : `articles/${chId}/${(s.id || 'section')}.json`;
  return path.join(tbInBase, rel);
}
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
function log(...a) { console.log('[build-manifests]', ...a); }

// Transform curated article → CDN schema with body_html + headings + optional sha256
async function transformArticleToCdnSchema(articleIn, chapterId, sectionId, withHash) {
  // Cases:
  // 1) curated block-based → render blocks to HTML
  // 2) has body_html already → use it
  // 3) has body_mdx string → wrap in <pre> as fallback (to avoid heavy MDX deps)

  let body_html = '';
  if (Array.isArray(articleIn.blocks)) {
    body_html = renderBlocksToHTML(articleIn.blocks);
  } else if (typeof articleIn.body_html === 'string') {
    body_html = articleIn.body_html;
  } else if (typeof articleIn.body_mdx === 'string') {
    body_html = `<pre class="mdx">${escapeHtml(articleIn.body_mdx)}</pre>`;
  } else if (typeof articleIn.body === 'string') {
    body_html = `<p>${escapeHtml(articleIn.body)}</p>`;
  }

  const headings = extractHeadingsFromHTML(body_html);
  const out = {
    chapterId,
    sectionId,
    title: articleIn.title || sectionId,
    body_html,
    headings,
    meta: {
      ...(articleIn.meta || {}),
      reading_time_min: articleIn.meta?.reading_time_min || estimateReadingTime(body_html),
      keywords: articleIn.meta?.keywords || [],
    },
  };

  if (withHash) {
    const raw = JSON.stringify(out);
    out.sha256 = sha256(raw);
  }
  return out;
}

// Minimal block → HTML renderer (keep lightweight)
function renderBlocksToHTML(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'heading': {
        const level = clamp(parseInt(b.level || 2, 10), 1, 6);
        parts.push(`<h${level}>${escapeHtml(b.text || '')}</h${level}>`);
        break;
      }
      case 'paragraph': {
        parts.push(`<p>${escapeHtml(b.text || '')}</p>`);
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const items = Array.isArray(b.items) ? b.items : [];
        parts.push(`<${tag}>${items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</${tag}>`);
        break;
      }
      case 'example': {
        parts.push(`<div class="example"><strong>Beispiel:</strong> ${escapeHtml(b.text || '')}</div>`);
        break;
      }
      case 'note': {
        parts.push(`<div class="note">${escapeHtml(b.text || '')}</div>`);
        break;
      }
      case 'formula': {
        // We keep raw tex as <code> to avoid heavy katex deps in build step
        parts.push(`<pre class="formula"><code>${escapeHtml(b.latex || b.tex || '')}</code></pre>`);
        break;
      }
      case 'code': {
        parts.push(`<pre><code>${escapeHtml(b.code || '')}</code></pre>`);
        break;
      }
      case 'step': {
        const title = b.title ? `<strong>${escapeHtml(b.title)}.</strong> ` : '';
        parts.push(`<p>${title}${escapeHtml(b.text || '')}</p>`);
        break;
      }
      default: {
        // Fallback: stringify
        parts.push(`<pre class="raw">${escapeHtml(JSON.stringify(b))}</pre>`);
      }
    }
  }
  return parts.join('\n');
}

function extractHeadingsFromHTML(html) {
  const rx = /<(h[1-6])[^>]*>(.*?)<\/\1>/gi;
  const out = [];
  let m;
  while ((m = rx.exec(html)) !== null) {
    const level = parseInt(m[1].slice(1), 10);
    const text = stripTags(m[2]).trim();
    const id = slug(text) || `h-${out.length + 1}`;
    out.push({ id, text, level });
  }
  return out;
}
function estimateReadingTime(html) {
  const text = stripTags(html);
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 180)); // ~180 wpm
}
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ' '); }
function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

main().catch(err => {
  console.error('[build-manifests] ERROR:', err.message);
  process.exit(1);
});
// placeholder - add the script from the plan here
