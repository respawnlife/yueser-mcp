#!/usr/bin/env node
/**
 * 器库数据层 · 读模型构建
 *
 * 把 v3/yueser-data 里的 JSON（事实源）物化成 data.sqlite（读模型）。
 * JSON 仍是唯一事实源：git 可 diff、编辑可直接改、validate 可校验。
 * SQLite 只是构建产物，供 /mcp 服务与后续 API 做快速查询。
 *
 *   node build-db.mjs [--data ../yueser-data] [--out ./data.sqlite]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = import.meta.dirname;
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const hit = process.argv.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : dflt;
};

const DATA = path.resolve(HERE, process.env.YUESER_DATA || argOf('--data', '../../yueser-data'));
const OUT = path.resolve(HERE, argOf('--out', './data.sqlite'));

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);
const globFiles = (dir, prefix, ext = '.json') =>
  exists(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort()
    : [];

function log(s) {
  process.stdout.write(s + '\n');
}

/* ---------------- 1. 读事实源 ---------------- */

// 1a. MCP 条目（已合并 probe 结果、权限、service 元信息）
const derivedPath = path.join(DATA, 'derived/mcp-entries.json');
if (!exists(derivedPath)) {
  console.error(`✗ 缺少 ${derivedPath}（先跑数据仓 npm run build 生成 derived/）`);
  process.exit(1);
}
const derived = readJson(derivedPath);
const entries = derived.entries || [];
log(`MCP 条目：${entries.length}（${derivedPath}）`);

// 1b. 导读（多个文件，按 slug 合并；长导读优先覆盖短导读）
const introDir = path.join(DATA, 'content/mcp');
const intros = new Map();
for (const f of globFiles(introDir, 'intros')) {
  let arr;
  try {
    arr = readJson(path.join(introDir, f));
  } catch {
    continue;
  }
  const list = Array.isArray(arr) ? arr : Object.values(arr);
  for (const it of list) {
    if (!it || !it.slug) continue;
    const prev = intros.get(it.slug) || {};
    const next = { ...prev };
    for (const [k, v] of Object.entries(it)) {
      if (k === 'slug' || v == null || v === '') continue;
      // 长导读（字段更长）覆盖短导读
      if (typeof v === 'string' && typeof next[k] === 'string' && next[k].length >= v.length) continue;
      next[k] = v;
    }
    intros.set(it.slug, next);
  }
}
log(`导读：${intros.size} 条（${globFiles(introDir, 'intros').length} 个文件）`);

// 1c. 配置提示（P32）
const hintsPath = path.join(introDir, 'config-hints.json');
const hints = exists(hintsPath) ? readJson(hintsPath) : {};
const hintList = Array.isArray(hints) ? hints : Object.values(hints);
log(`配置提示：${hintList.length}`);

// 1d. 本地工具注册表（权威口径：156 个，含分类与 status）
const toolRegPath = path.join(DATA, 'content/tools.json');
const toolReg = new Map();
if (exists(toolRegPath)) {
  const reg = readJson(toolRegPath);
  for (const cat of reg.categories || []) {
    for (const t of cat.tools || []) {
      if (!t || !t.slug) continue;
      toolReg.set(t.slug, {
        slug: t.slug,
        category: cat.slug || null,
        categoryName: cat.name || null,
        name: t.name || null,
        nameEn: t.name_en || null,
        nameJa: t.name_ja || null,
        desc: t.desc || null,
        descEn: t.desc_en || null,
        descJa: t.desc_ja || null,
        url: t.url || `/tools/${t.slug}/`,
        status: t.status || 'live',
      });
    }
  }
}
log(`工具注册表：${toolReg.size}`);

// 1e. mini-tools（108 个可交互工具的 op/placeholder/how，用于补强描述）
const miniDir = path.join(DATA, 'content/mini-tools');
const miniBySlug = new Map();
for (const f of globFiles(miniDir, 'batch-')) {
  const arr = readJson(path.join(miniDir, f));
  for (const t of Array.isArray(arr) ? arr : Object.values(arr)) {
    if (t && t.slug) miniBySlug.set(t.slug, t);
  }
}
log(`mini-tools：${miniBySlug.size}`);

// 1f. 探针元信息（"数据截至"）
const probesPath = path.join(introDir, 'probes-remote.json');
let probeMeta = { lastProbeAt: null, count: 0 };
if (exists(probesPath)) {
  const p = readJson(probesPath);
  probeMeta = { lastProbeAt: p.probedAt || p.generatedAt || null, count: p.count || 0 };
}

/* ---------------- 2. 建库 ---------------- */

if (exists(OUT)) fs.rmSync(OUT);
const db = new DatabaseSync(OUT);
// 单文件产物：不用 WAL，避免多出 -wal/-shm 伴生文件，方便随 release 分发
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE servers (
  slug          TEXT PRIMARY KEY,
  kind          TEXT,
  name          TEXT,
  title         TEXT,
  description   TEXT,
  region        TEXT,
  downloads     INTEGER,
  version       TEXT,
  license       TEXT,
  repo          TEXT,
  url           TEXT,
  install       TEXT,
  probed        INTEGER NOT NULL DEFAULT 0,
  probed_at     TEXT,
  tool_count    INTEGER NOT NULL DEFAULT 0,
  category      TEXT,
  category_name TEXT,
  permissions   TEXT,      -- JSON array: ["read","write","credential"]
  service_type  TEXT,
  provider      TEXT,
  docs_url      TEXT,
  tools_json    TEXT,      -- JSON array [{name,description,params}]
  what          TEXT,
  "when"        TEXT,
  note          TEXT,
  what_en       TEXT,
  when_en       TEXT,
  note_en       TEXT,
  what_ja       TEXT,
  when_ja       TEXT,
  note_ja       TEXT,
  config_json   TEXT,      -- JSON: {transport,command,args,env[],credential,notes}
  search_blob   TEXT       -- 归一化检索文本
);

CREATE INDEX idx_servers_category ON servers(category);
CREATE INDEX idx_servers_probed    ON servers(probed);
CREATE INDEX idx_servers_toolcount ON servers(tool_count DESC);
CREATE INDEX idx_servers_downloads ON servers(downloads DESC);

CREATE TABLE tools (
  slug          TEXT PRIMARY KEY,
  category      TEXT,
  category_name TEXT,
  name          TEXT,
  name_en       TEXT,
  name_ja       TEXT,
  desc          TEXT,
  desc_en       TEXT,
  desc_ja       TEXT,
  url           TEXT,
  status        TEXT,
  interactive   INTEGER NOT NULL DEFAULT 0,  -- 有 mini-tools 即时处理定义
  op            TEXT,
  search_blob   TEXT
);

CREATE INDEX idx_tools_category ON tools(category);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

const norm = (s) => (s == null ? '' : String(s).toLowerCase());

/* ---------------- 3. 写 servers ---------------- */

db.exec('BEGIN');
const insServer = db.prepare(`
INSERT INTO servers (slug,kind,name,title,description,region,downloads,version,license,repo,url,install,
  probed,probed_at,tool_count,category,category_name,permissions,service_type,provider,docs_url,tools_json,
  what,"when",note,what_en,when_en,note_en,what_ja,when_ja,note_ja,config_json,search_blob)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const hintBySlug = new Map();
for (const h of hintList) if (h && h.slug) hintBySlug.set(h.slug, h);
// config-hints 也可能是 {slug: {...}} 形态
for (const [k, v] of Object.entries(hints && !Array.isArray(hints) ? hints : {})) {
  if (v && typeof v === 'object' && !hintBySlug.has(k)) hintBySlug.set(k, { slug: k, ...v });
}

let withTools = 0;
let withPerm = 0;
let withHint = 0;

for (const e of entries) {
  const intro = intros.get(e.slug) || {};
  const perms = Array.isArray(e.permissions) ? e.permissions : [];
  const tools = Array.isArray(e.tools) ? e.tools : [];
  const hint = hintBySlug.get(e.slug) || null;
  if (tools.length) withTools++;
  if (perms.length) withPerm++;
  if (hint) withHint++;

  const searchBlob = [
    e.slug, e.name, e.title, e.description, e.category, e.categoryName,
    Array.isArray(e.permissions) ? e.permissions.join(' ') : '',
    (e.service && e.service.provider) || '',
    tools.slice(0, 40).map((t) => `${t.name} ${t.description || ''}`).join(' '),
    intro.what, intro.when, intro.note,
  ].map(norm).join(' ');

  insServer.run(
    e.slug ?? null,
    e.kind ?? null,
    e.name ?? null,
    e.title ?? null,
    e.description ?? null,
    e.region ?? null,
    Number.isFinite(e.downloads) ? e.downloads : null,
    e.version ?? null,
    e.license ?? null,
    e.repo ?? null,
    e.url ?? null,
    e.install ?? null,
    e.probed ? 1 : 0,
    e.probedAt ?? null,
    Number.isFinite(e.toolCount) ? e.toolCount : tools.length,
    e.category ?? null,
    e.categoryName ?? null,
    JSON.stringify(perms),
    (e.service && e.service.type) || null,
    (e.service && e.service.provider) || null,
    (e.service && e.service.docsUrl) || null,
    JSON.stringify(tools),
    intro.what ?? null,
    intro.when ?? null,
    intro.note ?? null,
    intro.what_en ?? null,
    intro.when_en ?? null,
    intro.note_en ?? null,
    intro.what_ja ?? null,
    intro.when_ja ?? null,
    intro.note_ja ?? null,
    hint ? JSON.stringify(hint) : null,
    searchBlob
  );
}
db.exec('COMMIT');

/* ---------------- 4. 写 tools ---------------- */

db.exec('BEGIN');
const insTool = db.prepare(`
INSERT INTO tools (slug,category,category_name,name,name_en,name_ja,desc,desc_en,desc_ja,url,status,interactive,op,search_blob)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const allToolSlugs = new Set([...toolReg.keys(), ...miniBySlug.keys()]);
for (const slug of allToolSlugs) {
  const reg = toolReg.get(slug);
  const mini = miniBySlug.get(slug);
  const mn = (mini && mini.name) || {};
  const md = (mini && mini.desc) || {};
  const name = reg?.name || mn.zh || slug;
  const nameEn = reg?.nameEn || mn.en || null;
  const nameJa = reg?.nameJa || mn.ja || null;
  const desc = reg?.desc || md.zh || null;
  const descEn = reg?.descEn || md.en || null;
  const descJa = reg?.descJa || md.ja || null;
  const blob = norm([slug, reg?.category, reg?.categoryName, name, nameEn, nameJa, desc, descEn, descJa, mini?.op].join(' '));
  insTool.run(
    slug,
    reg?.category ?? null,
    reg?.categoryName ?? null,
    name, nameEn, nameJa,
    desc, descEn, descJa,
    reg?.url || `/tools/${slug}/`,
    reg?.status || (mini ? 'live' : null),
    mini ? 1 : 0,
    mini?.op ?? null,
    blob
  );
}
db.exec('COMMIT');
const toolCountFinal = allToolSlugs.size;

/* ---------------- 5. meta ---------------- */

const insMeta = db.prepare('INSERT INTO meta (key,value) VALUES (?,?)');
insMeta.run('generatedAt', new Date().toISOString());
insMeta.run('sourceGeneratedAt', derived.generatedAt || '');
insMeta.run('lastProbeAt', probeMeta.lastProbeAt || '');
insMeta.run('serverCount', String(entries.length));
insMeta.run('toolCount', String(toolCountFinal));
insMeta.run('schemaVersion', '1');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

const size = fs.statSync(OUT).size;
const wal = `${OUT}-wal`;
if (exists(wal)) fs.rmSync(wal);
if (exists(`${OUT}-shm`)) fs.rmSync(`${OUT}-shm`);

log('');
log(`✅ ${OUT}`);
log(`   ${(size / 1024).toFixed(1)} KB`);
log(`   servers ${entries.length} · 有实测工具清单 ${withTools} · 有权限标注 ${withPerm} · 有配置提示 ${withHint}`);
log(`   tools ${toolCountFinal}`);
log(`   最近探针 ${probeMeta.lastProbeAt || '（无）'}`);
