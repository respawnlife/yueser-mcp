#!/usr/bin/env node
/**
 * 器库 MCP 服务（Qiku MCP Server）
 *
 * 把器库的实测数据（756 个 MCP 服务器 + 165 个本地工具 + 93 条配置提示）
 * 暴露成 MCP 工具，供 Claude / Cursor / Cline / VS Code 等客户端直接查询。
 *
 * 零依赖：只用 Node 内置模块（node:http + node:sqlite + node:readline）。
 *
 * 用法：
 *   node server.mjs                    # HTTP 模式，默认 :7701，端点 /mcp
 *   node server.mjs --port 8080        # 指定端口
 *   node server.mjs --stdio            # stdio 模式（本地客户端用）
 *
 * 数据：默认读同目录 data.sqlite（由 build-db.mjs 生成）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const HERE = import.meta.dirname;
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const hit = process.argv.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : dflt;
};
const has = (name) => process.argv.includes(name);

const DB_PATH = path.resolve(HERE, argOf('--db', './data.sqlite'));
const STDIO = has('--stdio');
const PORT = Number(argOf('--port', process.env.PORT || 7701));
const HOST = argOf('--host', process.env.HOST || '127.0.0.1');
const ENDPOINT = argOf('--endpoint', '/mcp');

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ 找不到 ${DB_PATH}，先运行：node build-db.mjs`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const SERVER_INFO = { name: 'qiku', title: '器库 Qiku', version: '0.1.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];

const META = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));

/* =========================================================================
 * 数据查询
 * ========================================================================= */

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

function parseJson(s, dflt) {
  if (!s) return dflt;
  try {
    return JSON.parse(s);
  } catch {
    return dflt;
  }
}

function searchServers({ query, category, permission, probedOnly, limit }) {
  const where = [];
  const params = [];
  let orderExtra = '';
  const orderParams = [];

  if (query) {
    where.push("search_blob LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(String(query).toLowerCase())}%`);
    orderExtra += 'CASE WHEN lower(title) LIKE ? ESCAPE \'\\\' THEN 0 ELSE 1 END, ';
    orderParams.push(`%${likeEscape(String(query).toLowerCase())}%`);
  }
  if (category) {
    where.push('category = ?');
    params.push(String(category));
  }
  if (permission) {
    where.push("permissions LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(String(permission))}%`);
  }
  if (probedOnly) where.push('probed = 1');

  const sql = `
    SELECT slug, title, name, description, category, category_name, permissions,
           probed, tool_count, downloads, version, kind, url, install, what, note
    FROM servers
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderExtra} probed DESC, tool_count DESC, COALESCE(downloads, 0) DESC
    LIMIT ?`;
  return db.prepare(sql).all(...params, ...orderParams, limit);
}

function getServer(slug) {
  return db.prepare('SELECT * FROM servers WHERE slug = ?').get(slug);
}

function searchTools({ query, category, limit }) {
  const where = [];
  const params = [];
  let orderExtra = '';
  const orderParams = [];
  if (query) {
    where.push("search_blob LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(String(query).toLowerCase())}%`);
    orderExtra += 'CASE WHEN lower(name) LIKE ? ESCAPE \'\\\' THEN 0 ELSE 1 END, ';
    orderParams.push(`%${likeEscape(String(query).toLowerCase())}%`);
  }
  if (category) {
    where.push('category = ?');
    params.push(String(category));
  }
  where.push("COALESCE(status, 'live') = 'live'");
  const sql = `
    SELECT slug, name, name_en, category, category_name, desc, url, interactive, op, status
    FROM tools
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderExtra} interactive DESC, name
    LIMIT ?`;
  return db.prepare(sql).all(...params, ...orderParams, limit);
}

function listCategories() {
  return db
    .prepare('SELECT category, category_name, COUNT(*) c FROM servers GROUP BY category ORDER BY c DESC')
    .all();
}

/* =========================================================================
 * 配置片段生成
 * ========================================================================= */

const CLIENT_INFO = {
  claude: { label: 'Claude Desktop', key: 'mcpServers', path: '~/Library/Application Support/Claude/claude_desktop_config.json（macOS）' },
  cursor: { label: 'Cursor', key: 'mcpServers', path: '~/.cursor/mcp.json 或项目内 .cursor/mcp.json' },
  cline: { label: 'Cline', key: 'mcpServers', path: 'Cline 设置 → MCP Servers → Configure MCP Servers' },
  vscode: { label: 'VS Code', key: 'servers', path: '.vscode/mcp.json（项目内）' },
  generic: { label: '通用', key: 'mcpServers', path: '按客户端文档填写' },
};

function buildEntry(row, client) {
  const cfg = parseJson(row.config_json, null);
  const typeHint = client === 'vscode' || client === 'cline';

  // 1) 有配置提示（P32）：优先用它
  if (cfg && cfg.transport) {
    if (cfg.transport === 'stdio') {
      const env = {};
      for (const e of cfg.env || []) {
        if (!e || !e.key) continue;
        env[e.key] = e.required ? `<填入：${e.desc || e.key}>` : (e.desc ? `<可选：${e.desc}>` : '');
      }
      const entry = { command: cfg.command || 'npx', args: cfg.args || [] };
      if (Object.keys(env).length) entry.env = env;
      return { entry, credential: cfg.credential || null, notes: cfg.notes || null, source: 'config-hints' };
    }
    // http / sse
    const entry = { url: row.url || '' };
    if (typeHint) entry.type = cfg.transport === 'sse' ? 'sse' : 'http';
    return { entry, credential: cfg.credential || null, notes: cfg.notes || null, source: 'config-hints' };
  }

  // 2) 远程服务：有 url 无 install
  if (row.url && /^https?:\/\//i.test(row.url) && !row.install) {
    const entry = { url: row.url };
    if (typeHint) entry.type = 'http';
    return { entry, credential: null, notes: '远程 MCP 服务，无需本地安装', source: 'url' };
  }

  // 3) npm 包：用 install 字符串推导
  if (row.install) {
    const parts = String(row.install).trim().split(/\s+/);
    const entry = { command: parts[0], args: parts.slice(1) };
    return { entry, credential: null, notes: '未收录该服务的凭证说明，请查阅其 README', source: 'install' };
  }

  return null;
}

function renderConfig(row, client) {
  const info = CLIENT_INFO[client] || CLIENT_INFO.generic;
  const built = buildEntry(row, client);
  if (!built) return { ok: false, text: `没有 ${row.slug} 的可用配置信息（既无 config-hints，也无 url/install）。` };

  const payload = { [info.key]: { [row.slug]: built.entry } };
  const lines = [];
  lines.push(`### ${row.title || row.name || row.slug}`);
  lines.push('');
  lines.push(`客户端：${info.label}`);
  lines.push(`配置文件：${info.path}`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(payload, null, 2));
  lines.push('```');
  if (built.credential) {
    lines.push('');
    lines.push(`**凭证获取**：${built.credential}`);
  }
  const envList = (parseJson(row.config_json, {}) || {}).env || [];
  if (envList.length) {
    lines.push('');
    lines.push('**环境变量**：');
    for (const e of envList) {
      lines.push(`- \`${e.key}\`${e.required ? '（必填）' : '（可选）'}${e.secret ? ' · 机密' : ''} — ${e.desc || ''}`);
    }
  }
  if (built.notes) {
    lines.push('');
    lines.push(`**注意**：${built.notes}`);
  }
  if (built.source !== 'config-hints') {
    lines.push('');
    lines.push(`> 该配置由 ${built.source === 'url' ? '服务地址' : '安装命令'}推导，未经人工核对。`);
  }
  return { ok: true, text: lines.join('\n') };
}

/* =========================================================================
 * 工具定义与实现
 * ========================================================================= */

const TOOLS = [
  {
    name: 'search_mcp_servers',
    title: '搜索 MCP 服务器',
    description:
      '按关键词/分类/权限搜索器库收录的 756 个 MCP 服务器。返回结果含 slug（可用于 get_mcp_server / get_config）、是否经过实测、暴露的工具数量与权限标注。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，匹配名称、描述、分类、导读与工具名。支持中英文。' },
        category: {
          type: 'string',
          description: '分类 slug，例如 coding / office / ai / image / data / devops。可用 list_categories 查看全部。',
        },
        permission: {
          type: 'string',
          enum: ['read', 'write', 'credential'],
          description: '只返回声明了该权限的服务器。read=只读，write=可写，credential=需凭证。',
        },
        probed_only: { type: 'boolean', description: '只返回已实测（拿到真实 tools/list）的服务器。' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 50。' },
      },
    },
  },
  {
    name: 'get_mcp_server',
    title: '获取 MCP 服务器详情',
    description:
      '按 slug 取单个 MCP 服务器的完整档案：安装方式、暴露的工具清单（含参数）、权限标注、版本、许可、维护方与实测时间。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '服务器 slug，例如 npm-zereight-mcp-gitlab。' },
        include_tools: { type: 'boolean', description: '是否包含工具清单，默认 true。' },
        max_tools: { type: 'number', description: '工具清单最多返回几条，默认 30。' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_config',
    title: '生成 MCP 客户端配置',
    description:
      '为指定服务器生成可直接粘贴的客户端配置 JSON（Claude Desktop / Cursor / Cline / VS Code），含环境变量占位与凭证获取说明。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '服务器 slug。' },
        client: {
          type: 'string',
          enum: ['claude', 'cursor', 'cline', 'vscode', 'generic'],
          description: '目标客户端，默认 claude。',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'search_tools',
    title: '搜索器库本地工具',
    description:
      '搜索器库的 156 个在线工具（图片、PDF、文本、编码、计算器等，全部在浏览器本地运行、文件不上传）。返回工具名、分类与页面链接。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，支持中英文。' },
        category: { type: 'string', description: '分类 slug：image / pdf / text / encode / calc / dev / media / random / ai-tools。' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 50。' },
      },
    },
  },
  {
    name: 'list_categories',
    title: '列出分类',
    description: '列出器库 MCP 目录的全部分类及各分类下的服务器数量。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function clampLimit(v, dflt = 10, max = 50) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

function fmtPermissions(raw) {
  const p = parseJson(raw, []);
  if (!p.length) return '未标注';
  return p.map((x) => ({ read: '只读', write: '可写', credential: '需凭证' }[x] || x)).join(' · ');
}

const HANDLERS = {
  search_mcp_servers(args) {
    const rows = searchServers({
      query: args.query,
      category: args.category,
      permission: args.permission,
      probedOnly: args.probed_only,
      limit: clampLimit(args.limit),
    });
    if (!rows.length) {
      return `没有匹配条件的 MCP 服务器。可放宽关键词，或改用 list_categories 查看分类。\n（数据截至 ${META.lastProbeAt || '未知'}）`;
    }
    const lines = [`找到 ${rows.length} 个 MCP 服务器（数据截至 ${META.lastProbeAt || '未知'}）：`, ''];
    rows.forEach((r, i) => {
      const tested = r.probed ? `已实测 ${r.tool_count} 个工具` : '未实测（工具数未知）';
      lines.push(`${i + 1}. **${r.title || r.name}** — slug: \`${r.slug}\``);
      lines.push(`   ${r.description || ''}`);
      const meta = [r.category_name || r.category, tested, `权限：${fmtPermissions(r.permissions)}`, r.version ? `v${r.version}` : null]
        .filter(Boolean)
        .join(' · ');
      lines.push(`   ${meta}`);
      if (r.install) lines.push(`   安装：\`${r.install}\``);
      lines.push('');
    });
    lines.push('用 get_mcp_server 看完整档案，用 get_config 生成客户端配置。');
    return lines.join('\n');
  },

  get_mcp_server(args) {
    if (!args.slug) return '缺少参数 slug。先用 search_mcp_servers 找到目标服务器。';
    const r = getServer(String(args.slug));
    if (!r) return `找不到 slug 为 \`${args.slug}\` 的服务器。用 search_mcp_servers 先检索。`;

    const includeTools = args.include_tools !== false;
    const maxTools = clampLimit(args.max_tools, 30, 500);
    const tools = parseJson(r.tools_json, []);
    const perms = parseJson(r.permissions, []);

    const lines = [];
    lines.push(`# ${r.title || r.name}`);
    lines.push('');
    lines.push(`- slug：\`${r.slug}\``);
    if (r.description) lines.push(`- 简介：${r.description}`);
    if (r.what) lines.push(`- 作用：${r.what}`);
    if (r.when) lines.push(`- 适用：${r.when}`);
    if (r.note) lines.push(`- 注意：${r.note}`);
    lines.push(`- 分类：${r.category_name || r.category || '未分类'}`);
    lines.push(`- 权限：${fmtPermissions(r.permissions)}${perms.length ? '' : '（未标注，使用前请自行核查）'}`);
    lines.push(`- 实测：${r.probed ? `是（暴露 ${r.tool_count} 个工具，${r.probed_at || '日期未知'}）` : '否'}`);
    if (r.version) lines.push(`- 版本：${r.version}`);
    if (r.license) lines.push(`- 许可：${r.license}`);
    if (r.repo) lines.push(`- 仓库：${r.repo}`);
    if (r.url) lines.push(`- 地址：${r.url}`);
    if (r.install) lines.push(`- 安装：\`${r.install}\``);
    if (r.provider) lines.push(`- 维护方：${r.provider}${r.service_type ? `（${r.service_type}）` : ''}`);
    if (r.config_json) lines.push('- 配置提示：有（用 get_config 直接生成）');

    if (includeTools && tools.length) {
      const total = Number(r.tool_count) || tools.length;
      const truncated = total > tools.length;
      lines.push('');
      lines.push(
        `## 暴露的工具（共 ${total}${truncated ? `，已记录 ${tools.length} 个的名称与参数` : ''}${tools.length > maxTools ? `，下面显示前 ${maxTools}` : ''}）`
      );
      for (const t of tools.slice(0, maxTools)) {
        const params = Array.isArray(t.params) && t.params.length ? ` (${t.params.join(', ')})` : '';
        lines.push(`- \`${t.name}\`${params} — ${t.description || ''}`);
      }
      if (tools.length > maxTools) lines.push(`- …… 另有 ${tools.length - maxTools} 个已记录但未显示`);
      if (truncated) lines.push(`- …… 另有 ${total - tools.length} 个未采集明细`);
      if (r.repo) lines.push('', `完整工具清单可查其仓库/文档：${r.repo || r.url || ''}`);
    } else if (includeTools) {
      lines.push('');
      lines.push('## 暴露的工具');
      lines.push('未实测，工具清单未知。');
    }
    return lines.join('\n');
  },

  get_config(args) {
    if (!args.slug) return '缺少参数 slug。';
    const r = getServer(String(args.slug));
    if (!r) return `找不到 slug 为 \`${args.slug}\` 的服务器。`;
    const client = CLIENT_INFO[args.client] ? String(args.client) : 'claude';
    const out = renderConfig(r, client);
    if (!out.ok) return out.text;
    return out.text + '\n\n> 配置为只读生成，凭证需你自己填写，器库不会看到你的令牌。';
  },

  search_tools(args) {
    const rows = searchTools({ query: args.query, category: args.category, limit: clampLimit(args.limit) });
    if (!rows.length) return '没有匹配的本地工具。可放宽关键词或换分类。';
    const lines = [`找到 ${rows.length} 个本地工具（全部在浏览器内运行，文件不上传）：`, ''];
    rows.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.name}**${r.name_en ? ` / ${r.name_en}` : ''} — ${r.category_name || r.category || ''}`);
      lines.push(`   ${r.desc || ''}`);
      lines.push(`   https://yueser.com${r.url}`);
      lines.push('');
    });
    return lines.join('\n');
  },

  list_categories() {
    const rows = listCategories();
    const lines = [`器库 MCP 目录分类（共 ${META.serverCount} 个服务器）：`, ''];
    for (const r of rows) lines.push(`- \`${r.category}\` ${r.category_name || ''} — ${r.c} 个`);
    return lines.join('\n');
  },
};

/* =========================================================================
 * JSON-RPC 处理
 * ========================================================================= */

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  // 通知：不需要响应
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            '器库（Qiku）中文 MCP 服务器与工具目录。用 search_mcp_servers 找 MCP 服务器，get_mcp_server 看详情，get_config 生成客户端配置，search_tools 找浏览器本地工具。数据为实测采集，权限标注来自各服务自身声明。',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case 'tools/call': {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const text = handler(params?.arguments || {});
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: false },
        };
      } catch (e) {
        console.error('[qiku-mcp] tool error:', e && e.stack ? e.stack : e);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: '查询失败，请稍后重试；如持续失败请联系维护者。' }], isError: true },
        };
      }
    }

    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function handlePayload(payload) {
  if (Array.isArray(payload)) {
    const out = payload.map(handleMessage).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMessage(payload);
}

/* =========================================================================
 * HTTP 传输（MCP Streamable HTTP）
 * ========================================================================= */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        if (!over) { over = true; reject(new Error('请求体过大')); }
        return; // 继续排空，保证 413 能写回客户端（不 destroy 连接）
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, ...CORS, ...extraHeaders });
  res.end(buf);
}

function sendSse(res, payload, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...CORS,
    ...extraHeaders,
  });
  const data = Array.isArray(payload) ? payload : [payload];
  for (const m of data) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  req.setTimeout(10000, () => {
    if (!res.headersSent) sendJson(res, 408, { error: 'request_timeout', timeoutMs: 10000 });
    try { req.destroy(); } catch {}
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (pathname === '/health') {
    const cstDay = (d) => {
      try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d ? new Date(d) : new Date()); } catch { return null; }
    };
    return sendJson(res, 200, {
      status: 'ok',
      ok: true, // 兼容旧探针
      version: SERVER_INFO.version,
      uptime: Math.round(process.uptime()),
      server: SERVER_INFO,
      servers: Number(META.serverCount || 0),
      tools: Number(META.toolCount || 0),
      lastProbeAt: META.lastProbeAt || null,
      dbGeneratedAt: META.generatedAt || null,
      dbGeneratedDate: cstDay(META.generatedAt || null),
      todayCst: cstDay(null),
    });
  }

  if (pathname !== ENDPOINT) {
    return sendJson(res, 404, { error: 'not found', hint: `MCP 端点是 ${ENDPOINT}，健康检查是 /health` });
  }

  if (req.method === 'GET') {
    // 不提供服务器主动推送流
    return sendJson(res, 405, { error: 'method not allowed', hint: '请用 POST 发送 JSON-RPC' });
  }

  if (req.method === 'DELETE') {
    res.writeHead(200, CORS);
    return res.end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (String(e && e.message).includes('过大')) return sendJson(res, 413, { error: 'payload_too_large', limitBytes: 4 * 1024 * 1024 }, { Connection: 'close' });
    return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
  }
  if (!raw.trim()) return sendJson(res, 400, rpcError(null, -32700, 'Parse error: empty body'));

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
  }

  const result = handlePayload(payload);

  // 全是通知 → 202
  if (result === null) {
    res.writeHead(202, CORS);
    return res.end();
  }

  const extra = {};
  const isInitialize = !Array.isArray(payload) && payload?.method === 'initialize';
  if (isInitialize) extra['Mcp-Session-Id'] = crypto.randomUUID();

  const accept = String(req.headers.accept || '');
  const wantsJson = accept.includes('application/json') || accept.includes('*/*') || accept === '';
  if (wantsJson) return sendJson(res, 200, result, extra);
  return sendSse(res, result, extra);
});

/* =========================================================================
 * stdio 传输（本地客户端）
 * ========================================================================= */

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let payload;
    try {
      payload = JSON.parse(s);
    } catch {
      process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n');
      return;
    }
    const out = handlePayload(payload);
    if (out === null) return;
    const arr = Array.isArray(out) ? out : [out];
    for (const m of arr) process.stdout.write(JSON.stringify(m) + '\n');
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write(`[qiku-mcp] stdio 模式已启动 · ${META.serverCount} 服务器 / ${META.toolCount} 工具\n`);
}

/* =========================================================================
 * 入口
 * ========================================================================= */

if (STDIO) {
  startStdio();
} else {
  server.listen(PORT, HOST, () => {
    process.stderr.write(
      `[qiku-mcp] http://${HOST}:${PORT}${ENDPOINT}\n` +
        `            数据：${META.serverCount} 个 MCP 服务器 · ${META.toolCount} 个本地工具 · 探针 ${META.lastProbeAt || '无'}\n`
    );
  });
  const shutdown = () => {
    server.close(() => {
      try {
        db.close();
      } catch {}
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
