'use strict';

/**
 * 成长树 · 单文件服务端
 * Node.js >= 18，零第三方依赖，仅使用 http / fs / crypto / path。
 * 启动：node server.js（默认 127.0.0.1:5173）
 * 环境变量：PORT、HOST、DATA_DIR、SECURE_COOKIE=1（公网 HTTPS 时启用 Secure Cookie）
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const MAX_BODY = 64 * 1024 * 1024;
const MAX_NOTE = 2 * 1024 * 1024;
const MAX_PHOTO = 8 * 1024 * 1024;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SUPER_ADMIN = 'protractor45';
const WEEK_RE = /^\d{4}W\d{2}$/;
const SLOTS = [[480, 720], [720, 1020], [1140, 1320]];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------------------------------------------------------------- 基础工具

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function safeFileName(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name.replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..') return null;
  if (base.includes('..') || /[\u0000-\u001f<>:"/\\|?*]/.test(base)) return null;
  if (!/^[\w.\-\u4e00-\u9fa5 ()（）\[\]【】]+$/.test(base)) return null;
  if (base.length > 100) return null;
  return base;
}

// ---------------------------------------------------------------- 文件存储

const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(key, run.catch(() => {}));
  return run;
}

async function ensureDir(dir) { await fs.promises.mkdir(dir, { recursive: true }); }

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.promises.rename(tmp, file);
}

const store = {
  users: [],
  sessions: {},
  friends: [],
  chats: [],
  feedback: [],
  blueprints: [],
};

const globalFile = name => path.join(DATA_DIR, `${name}.json`);
async function saveGlobal(name) {
  await writeJsonFile(globalFile(name), store[name]);
}

async function initStore() {
  await ensureDir(DATA_DIR);
  await ensureDir(path.join(DATA_DIR, 'users'));
  await ensureDir(path.join(DATA_DIR, 'blueprints'));
  store.users = await readJsonFile(globalFile('users'), []);
  store.sessions = await readJsonFile(globalFile('sessions'), {});
  store.friends = await readJsonFile(globalFile('friends'), []);
  store.chats = await readJsonFile(globalFile('chats'), []);
  store.feedback = await readJsonFile(globalFile('feedback'), []);
  store.blueprints = await readJsonFile(globalFile('blueprints'), []);
  const now = Date.now();
  let cleaned = false;
  for (const token of Object.keys(store.sessions)) {
    if (!store.sessions[token] || store.sessions[token].exp < now) { delete store.sessions[token]; cleaned = true; }
  }
  if (cleaned) await saveGlobal('sessions');
}

const treeFile = uid => path.join(DATA_DIR, 'users', uid, 'tree.json');
const notesDir = uid => path.join(DATA_DIR, 'users', uid, 'notes');
const photosDir = uid => path.join(DATA_DIR, 'users', uid, 'photos');
const blueprintDir = id => path.join(DATA_DIR, 'blueprints', id);

async function readTree(uid) {
  const t = await readJsonFile(treeFile(uid), null);
  return t && typeof t === 'object' ? t : defaultTree();
}
async function writeTree(uid, tree) { await writeJsonFile(treeFile(uid), tree); }

async function pruneRemovedPhotos(uid, prevFiles, nextFiles) {
  const keep = new Set((nextFiles || []).map(f => f.storedAs).filter(Boolean));
  for (const f of prevFiles || []) {
    if (f.local || !f.storedAs || keep.has(f.storedAs)) continue;
    await fs.promises.unlink(path.join(photosDir(uid), f.storedAs)).catch(() => {});
  }
}

// ---------------------------------------------------------------- 周与科技点

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}W${String(week).padStart(2, '0')}`;
}

function weekDayIndex(now) { return ((now.getDay() + 6) % 7) + 1; }

function timeToMin(t) {
  if (typeof t !== 'string' || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function mergeIntervals(list) {
  const sorted = list.filter(i => i[1] > i[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function overlapTotal(merged, start, end) {
  let total = 0;
  for (const [a, b] of merged) {
    const s = Math.max(a, start), e = Math.min(b, end);
    if (e > s) total += e - s;
  }
  return total;
}

function busyForDay(table, day) {
  const list = [];
  for (const c of table.courses || []) {
    if (Number(c.day) === day) list.push([timeToMin(c.start), timeToMin(c.end)]);
  }
  for (const p of table.plans || []) {
    if (Array.isArray(p.days) && p.days.map(Number).includes(day)) list.push([timeToMin(p.start), timeToMin(p.end)]);
  }
  return mergeIntervals(list.filter(iv => iv[0] !== null && iv[1] !== null));
}

function freeMinutes(table, now) {
  const today = weekDayIndex(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let total = 0;
  let remaining = 0;
  for (let day = 1; day <= 7; day++) {
    const busy = busyForDay(table, day);
    for (const [s, e] of SLOTS) {
      total += (e - s) - overlapTotal(busy, s, e);
      if (day < today) continue;
      const from = day === today ? Math.max(s, nowMin) : s;
      if (e > from) remaining += (e - from) - overlapTotal(busy, from, e);
    }
  }
  return { total, remaining };
}

function ensureWeek(tree, now) {
  const key = isoWeekKey(now);
  let changed = false;
  if (!tree.week || tree.week.key !== key) {
    const weeks = tree.timer && tree.timer.weeks && typeof tree.timer.weeks === 'object' ? tree.timer.weeks : {};
    const prevKey = Object.keys(weeks).filter(k => WEEK_RE.test(k) && k < key).sort().pop();
    const inherited = prevKey && weeks[prevKey]
      ? clone(weeks[prevKey])
      : (weeks[key] ? clone(weeks[key]) : { courses: [], plans: [] });
    weeks[key] = inherited;
    const keys = Object.keys(weeks).sort();
    while (keys.length > 12) delete weeks[keys.shift()];
    tree.timer = tree.timer || {};
    tree.timer.weeks = weeks;
    tree.timer.weekKey = key;
    tree.timer.spent = 0;
    tree.timer.bonus = 0;
    tree.week = { key };
    tree.tasks = (tree.tasks || []).map(t => ({ ...t, done: false, doneAt: null }));
    changed = true;
  }
  tree.timer = tree.timer || { rate: 50, spent: 0, bonus: 0, weeks: {} };
  tree.timer.weeks = tree.timer.weeks || {};
  if (!tree.timer.weeks[key]) { tree.timer.weeks[key] = { courses: [], plans: [] }; changed = true; }
  if (!tree.week) { tree.week = { key }; changed = true; }
  return changed;
}

function taskBonus(tree) {
  return (tree.tasks || []).reduce((sum, t) => sum + (t.done ? clampInt(t.points, 0, 1000, 0) : 0), 0);
}

function computeMeta(tree, now = new Date()) {
  const key = tree.week && tree.week.key ? tree.week.key : isoWeekKey(now);
  const table = tree.timer.weeks[key] || { courses: [], plans: [] };
  const { total, remaining } = freeMinutes(table, now);
  const rate = clampInt(tree.timer.rate, 0, 100, 50);
  const bonus = taskBonus(tree);
  const available = Math.floor(((remaining / 60) * (rate / 100) + bonus - (tree.timer.spent || 0)) * 100) / 100;
  const exp = Math.min(1500, Math.max(0, Number(tree.exp) || 0));
  return {
    available,
    remainingMinutes: Math.round(remaining),
    totalFreeMinutes: Math.round(total),
    rate,
    bonus,
    used: Number(tree.timer.spent) || 0,
    level: Math.min(15, Math.floor(exp / 100) + 1),
    exp,
    weekKey: key,
  };
}

function defaultTree() {
  const key = isoWeekKey(new Date());
  return {
    version: 1,
    points: 0,
    exp: 0,
    categories: [
      { id: 'cat_art', name: '艺术' },
      { id: 'cat_sport', name: '运动' },
      { id: 'cat_study', name: '学习' },
    ],
    abilities: [],
    files: [],
    tasks: [],
    week: { key },
    timer: { rate: 50, spent: 0, bonus: 0, weekKey: key, weeks: { [key]: { courses: [], plans: [] } } },
  };
}

// ---------------------------------------------------------------- 树校验

function sanitizeWeekTable(raw) {
  const table = { courses: [], plans: [] };
  if (!raw || typeof raw !== 'object') return table;
  for (const c of Array.isArray(raw.courses) ? raw.courses.slice(0, 300) : []) {
    if (!c || typeof c !== 'object') continue;
    const start = timeToMin(c.start), end = timeToMin(c.end), day = clampInt(c.day, 1, 7, 0);
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    if (!title || title.length > 40 || !day || start === null || end === null) continue;
    if (start < 480 || end > 1320 || start >= end) continue;
    table.courses.push({
      id: typeof c.id === 'string' && c.id.length <= 64 ? c.id : crypto.randomUUID(),
      day, start: c.start, end: c.end, title,
    });
  }
  for (const p of Array.isArray(raw.plans) ? raw.plans.slice(0, 300) : []) {
    if (!p || typeof p !== 'object') continue;
    const start = timeToMin(p.start), end = timeToMin(p.end);
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const days = [...new Set((Array.isArray(p.days) ? p.days : []).map(Number).filter(d => d >= 1 && d <= 7))].sort();
    if (!title || title.length > 40 || !days.length || start === null || end === null) continue;
    if (start < 480 || end > 1320 || start >= end) continue;
    table.plans.push({
      id: typeof p.id === 'string' && p.id.length <= 64 ? p.id : crypto.randomUUID(),
      days, start: p.start, end: p.end, title, break: p.break === true,
    });
  }
  return table;
}

function sanitizeTree(input, prev, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '数据结构不正确');
  const now = new Date();
  const charge = options.charge !== false;
  const base = clone(prev && typeof prev === 'object' ? prev : defaultTree());
  ensureWeek(base, now);

  const result = {
    version: (Number(base.version) || 0) + 1,
    points: 0,
    exp: Math.min(1500, Math.max(0, Number(base.exp) || 0)),
    categories: [],
    abilities: [],
    files: [],
    tasks: [],
    week: { key: base.week.key },
    timer: {
      rate: clampInt(input.timer && input.timer.rate, 0, 100, clampInt(base.timer.rate, 0, 100, 50)),
      spent: Math.max(0, Number(base.timer.spent) || 0),
      bonus: 0,
      weekKey: base.week.key,
      weeks: {},
    },
  };

  // 分类
  const rawCats = Array.isArray(input.categories) ? input.categories : base.categories;
  if (rawCats.length > 20) fail(400, '分类数量超过上限（20 个）');
  const catIds = new Set();
  const catNames = new Set();
  for (const c of rawCats) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!id || id.length > 64 || !name || name.length > 30) fail(400, '分类名称或编号不合法');
    if (catIds.has(id)) fail(400, '分类编号重复');
    if (catNames.has(name.toLowerCase())) fail(400, `分类「${name}」重复`);
    catIds.add(id);
    catNames.add(name.toLowerCase());
    result.categories.push({ id, name });
  }
  if (!result.categories.length) {
    result.categories = defaultTree().categories;
    for (const c of result.categories) catIds.add(c.id);
  }

  // 能力节点（第一遍：基础字段）
  const rawAbilities = Array.isArray(input.abilities) ? input.abilities : base.abilities;
  if (!Array.isArray(rawAbilities)) fail(400, '能力列表格式不正确');
  if (rawAbilities.length > 300) fail(400, '节点数量超过上限（300 个）');
  const prevById = new Map((base.abilities || []).map(a => [a.id, a]));
  const idSet = new Set();
  const names = new Set();

  for (const a of rawAbilities) {
    if (!a || typeof a !== 'object') fail(400, '能力节点格式不正确');
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail(400, '能力节点编号不合法');
    if (idSet.has(id)) fail(400, '能力节点编号重复');
    idSet.add(id);
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name || name.length > 40) fail(400, '能力名称需为 1–40 个字符');
    const key = name.toLowerCase();
    if (names.has(key)) fail(400, `能力名称「${name}」已存在（同一棵树内唯一）`);
    names.add(key);
    const kind = a.kind === 'group' ? 'group' : a.kind === 'leaf' ? 'leaf' : null;
    if (!kind) fail(400, '能力类型必须为 group 或 leaf');
    const prevNode = prevById.get(id);
    const wasUnlocked = prevNode ? prevNode.unlocked === true : false;
    const unlocked = kind === 'leaf' && (wasUnlocked || a.unlocked === true);
    const cost = kind === 'leaf' ? clampInt(a.cost, 1, 100000, 0) : 0;
    if (kind === 'leaf' && !cost) fail(400, '知识点成本必须为 1–100000 的整数');
    const note = typeof a.note === 'string' ? a.note.slice(0, 5000) : '';
    const photos = [];
    for (const p of Array.isArray(a.photos) ? a.photos.slice(0, 3) : []) {
      if (!p || typeof p !== 'object') continue;
      const storedAs = safeFileName(p.storedAs);
      if (!storedAs) continue;
      photos.push({
        id: typeof p.id === 'string' ? p.id.slice(0, 64) : crypto.randomUUID(),
        name: typeof p.name === 'string' ? p.name.slice(0, 100) : storedAs,
        mime: typeof p.mime === 'string' ? p.mime.slice(0, 60) : 'application/octet-stream',
        size: clampInt(p.size, 0, MAX_PHOTO, 0),
        storedAs,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt.slice(0, 40) : new Date().toISOString(),
      });
    }
    result.abilities.push({
      id,
      name,
      cost,
      unlocked,
      kind,
      parentId: kind === 'leaf' && typeof a.parentId === 'string' ? a.parentId : null,
      prereqIds: Array.isArray(a.prereqIds) ? [...new Set(a.prereqIds.filter(x => typeof x === 'string'))].slice(0, 8) : [],
      categoryId: null,
      ox: Number.isFinite(Number(a.ox)) ? Math.round(Number(a.ox)) : 0,
      oy: Number.isFinite(Number(a.oy)) ? Math.round(Number(a.oy)) : 0,
      note,
      photos,
    });
  }

  const byId = new Map(result.abilities.map(a => [a.id, a]));
  const groups = result.abilities.filter(a => a.kind === 'group');
  const defaultCat = result.categories[0].id;

  // 父子、分类、前置
  for (const a of result.abilities) {
    if (a.kind === 'group') {
      const raw = rawAbilities.find(x => x.id === a.id);
      const cat = raw && typeof raw.categoryId === 'string' ? raw.categoryId : defaultCat;
      a.categoryId = catIds.has(cat) ? cat : defaultCat;
      a.parentId = null;
      a.prereqIds = [];
      a.unlocked = false;
      continue;
    }
    if (!a.parentId) fail(400, `知识点「${a.name}」必须挂在能力组下`);
    const parent = byId.get(a.parentId);
    if (!parent || parent.kind !== 'group') fail(400, `知识点「${a.name}」的父级不是能力组`);
    a.categoryId = null;
    for (const pid of a.prereqIds) {
      const pre = byId.get(pid);
      if (!pre || pre.kind !== 'leaf') fail(400, `知识点「${a.name}」的前置不存在或不是知识点`);
      if (pre.id === a.id) fail(400, `知识点「${a.name}」不能把自己设为前置`);
      if (pre.parentId !== a.parentId) fail(400, `知识点「${a.name}」的前置必须与它同属一个能力组`);
    }
  }

  // 环检测（仅 leaf 前置）
  const state = new Map();
  function visit(id, stack) {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) fail(400, `前置关系存在循环：${stack.concat(id).join(' → ')}`);
    state.set(id, 1);
    const node = byId.get(id);
    if (node && node.kind === 'leaf') for (const pid of node.prereqIds) visit(pid, stack.concat(id));
    state.set(id, 2);
  }
  for (const a of result.abilities) if (a.kind === 'leaf') visit(a.id, []);

  // 已点亮节点前置必须全部点亮
  for (const a of result.abilities) {
    if (a.kind !== 'leaf' || !a.unlocked) continue;
    for (const pid of a.prereqIds) {
      const pre = byId.get(pid);
      if (!pre || !pre.unlocked) fail(409, `「${a.name}」的前置知识点尚未点亮`);
    }
  }

  // 组成本 = 子知识点成本之和
  for (const g of groups) {
    g.cost = result.abilities.filter(a => a.kind === 'leaf' && a.parentId === g.id).reduce((s, a) => s + a.cost, 0);
    g.prereqIds = [];
  }

  // 文件元数据
  const rawFiles = Array.isArray(input.files) ? input.files : base.files;
  if (Array.isArray(rawFiles)) {
    if (rawFiles.length > 200) fail(400, '文件数量超过上限（200 个）');
    for (const f of rawFiles) {
      if (!f || typeof f !== 'object') continue;
      const local = f.local === true;
      const storedAs = local ? '' : safeFileName(f.storedAs);
      if (!local && !storedAs) continue;
      const nodeId = typeof f.nodeId === 'string' && byId.has(f.nodeId) ? f.nodeId : null;
      if (!local && !nodeId) continue;
      result.files.push({
        id: typeof f.id === 'string' ? f.id.slice(0, 64) : crypto.randomUUID(),
        nodeId,
        name: typeof f.name === 'string' ? f.name.slice(0, 100) : (storedAs || '未命名'),
        mime: typeof f.mime === 'string' ? f.mime.slice(0, 60) : 'application/octet-stream',
        size: clampInt(f.size, 0, MAX_PHOTO, 0),
        storedAs,
        local,
        createdAt: typeof f.createdAt === 'string' ? f.createdAt.slice(0, 40) : new Date().toISOString(),
      });
    }
  }

  // 任务
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : base.tasks;
  if (Array.isArray(rawTasks)) {
    if (rawTasks.length > 100) fail(400, '任务数量超过上限（100 个）');
    for (const t of rawTasks) {
      if (!t || typeof t !== 'object') continue;
      const name = typeof t.name === 'string' ? t.name.trim() : '';
      if (!name || name.length > 40) fail(400, '任务名称需为 1–40 个字符');
      const done = t.done === true;
      result.tasks.push({
        id: typeof t.id === 'string' ? t.id.slice(0, 64) : crypto.randomUUID(),
        name,
        points: clampInt(t.points, 0, 1000, 0),
        done,
        doneAt: done && typeof t.doneAt === 'string' ? t.doneAt.slice(0, 40) : (done ? new Date().toISOString() : null),
      });
    }
  }

  // 课表：仅保留当前周及最近 12 周
  const rawWeeks = input.timer && input.timer.weeks && typeof input.timer.weeks === 'object'
    ? input.timer.weeks : base.timer.weeks;
  const weekKeys = Object.keys(rawWeeks || {}).filter(k => WEEK_RE.test(k)).sort().slice(-12);
  for (const key of weekKeys) result.timer.weeks[key] = sanitizeWeekTable(rawWeeks[key]);
  if (!result.timer.weeks[base.week.key]) {
    result.timer.weeks[base.week.key] = sanitizeWeekTable(base.timer.weeks[base.week.key]);
  }

  result.timer.bonus = taskBonus(result);

  // 点亮扣点与经验
  if (charge) {
    const newly = result.abilities.filter(a => {
      if (a.kind !== 'leaf' || !a.unlocked) return false;
      const p = prevById.get(a.id);
      return p && p.unlocked !== true;
    });
    for (const a of newly) {
      const before = computeMeta(result, now);
      if (before.available + 1e-9 < a.cost) {
        fail(409, `科技点不足，点亮「${a.name}」还差 ${Math.max(0, Math.ceil((a.cost - before.available) * 100) / 100)}`);
      }
      result.timer.spent += a.cost;
      result.exp = Math.min(1500, result.exp + a.cost * 10);
    }
  }

  const meta = computeMeta(result, now);
  result.points = meta.available;
  result.exp = meta.exp;
  return { tree: result, meta };
}

// ---------------------------------------------------------------- 鉴权与限速

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

async function verifyPassword(user, password) {
  const hash = await scryptHash(password, user.salt);
  return safeEqual(hash, user.hash);
}

const challenges = new Map();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `grow_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${SECURE_COOKIE ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `grow_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`);
}

async function currentUser(req) {
  const token = parseCookies(req).grow_session;
  if (!token) return null;
  const session = store.sessions[token];
  if (!session || session.exp < Date.now()) return null;
  const user = store.users.find(u => u.id === session.uid);
  return user || null;
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) fail(401, '请先登录');
  return user;
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.role !== 'admin') fail(403, '需要管理员权限');
  return user;
}

function userView(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.name === SUPER_ADMIN ? 'admin' : user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    privacy: { ...user.privacy },
  };
}

const limits = new Map();
function pruneLimit(key) {
  const entry = limits.get(key);
  if (!entry) return [];
  const cutoff = Date.now() - entry.window;
  const kept = entry.hits.filter(t => t > cutoff);
  if (kept.length) limits.set(key, { ...entry, hits: kept });
  else limits.delete(key);
  return kept;
}
function limitExceeded(key, max, windowMs) {
  return pruneLimit(key).length >= max;
}
function limitRecord(key, windowMs) {
  const entry = limits.get(key) || { window: windowMs, hits: [] };
  entry.window = windowMs;
  entry.hits.push(Date.now());
  limits.set(key, entry);
}
function limitClear(key) { limits.delete(key); }

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const host = req.headers.host;
    if (!host || new URL(origin).host !== host) fail(403, '跨站请求被拒绝');
  } catch {
    fail(403, '跨站请求被拒绝');
  }
}

// ---------------------------------------------------------------- HTTP 辅助

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res, error) {
  if (error instanceof HttpError) return json(res, error.status, { error: error.message });
  console.error('[server]', error);
  return json(res, 500, { error: '服务器内部错误' });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new HttpError(413, '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

async function readJson(req) {
  const type = (req.headers['content-type'] || '').toLowerCase();
  if (!type.includes('application/json')) fail(415, '请求必须为 JSON');
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    fail(400, 'JSON 格式不正确');
  }
}

// ---------------------------------------------------------------- 好友/蓝图辅助

function friendship(a, b) {
  const rec = store.friends.find(f => (f.a === a && f.b === b) || (f.a === b && f.b === a));
  return rec || null;
}
function areFriends(a, b) {
  const rec = friendship(a, b);
  return !!(rec && rec.status === 'accepted');
}
function findUser(id) { return store.users.find(u => u.id === id) || null; }

function canViewBlueprint(bp, viewer) {
  if (!viewer) return false;
  if (bp.ownerId === viewer.id) return true;
  if (viewer.role === 'admin') return true;
  const owner = findUser(bp.ownerId);
  if (!owner) return false;
  if (owner.privacy && owner.privacy.bp === false) return bp.visibility === 'public';
  if (bp.visibility === 'public') return true;
  if (bp.visibility === 'friends') return areFriends(viewer.id, bp.ownerId);
  return false;
}

function blueprintSummary(bp, viewer) {
  return {
    id: bp.id,
    title: bp.title,
    note: bp.note,
    ownerId: bp.ownerId,
    ownerName: bp.ownerName,
    category: bp.category,
    categoryName: bp.categoryName,
    visibility: bp.visibility,
    score: bp.score,
    nodeCount: (bp.nodes || []).length,
    imageCount: (bp.images || []).length,
    createdAt: bp.createdAt,
    updatedAt: bp.updatedAt,
    mine: viewer ? bp.ownerId === viewer.id : false,
  };
}

function scoreBlueprint(bp) {
  const title = String(bp.title || '').trim();
  const note = String(bp.note || '').trim();
  const nodes = Array.isArray(bp.nodes) ? bp.nodes : [];
  const images = Array.isArray(bp.images) ? bp.images : [];
  const files = Array.isArray(bp.files) ? bp.files : [];
  let score = title.length >= 2 ? 10 : 0;
  score += Math.min(30, Math.floor(note.length / 3));
  score += Math.min(15, nodes.length * 3);
  const noted = nodes.filter(n => String(n.note || '').trim()).length;
  score += nodes.length ? Math.round((30 * noted) / nodes.length) : 0;
  score += images.length + files.length > 0 ? 15 : 0;
  score += nodes.length >= 2 && nodes.length <= 30 ? 5 : 0;
  return Math.min(100, score);
}

// ---------------------------------------------------------------- 路由

const routes = [];
function on(method, pattern, handler) {
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
}

// --- 鉴权

on('GET', '/api/auth/challenge', async (req, res) => {
  const ip = clientIp(req);
  const key = `challenge:${ip}`;
  if (limitExceeded(key, 60, 60 * 1000)) fail(429, '验证码请求过于频繁');
  limitRecord(key, 60 * 1000);
  const a = crypto.randomInt(2, 20);
  const b = crypto.randomInt(2, 20);
  const id = crypto.randomUUID();
  challenges.set(id, { answer: a + b, exp: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  json(res, 200, { id, question: `${a} + ${b} = ?`, expiresIn: 300 });
});

on('POST', '/api/auth/register', async (req, res) => {
  const ip = clientIp(req);
  const hourKey = `register:hour:${ip}`;
  const dayKey = `register:day:${ip}`;
  if (limitExceeded(hourKey, 5, 60 * 60 * 1000) || limitExceeded(dayKey, 15, 24 * 60 * 60 * 1000)) {
    fail(429, '注册尝试过于频繁，请稍后再试');
  }
  limitRecord(hourKey, 60 * 60 * 1000);
  limitRecord(dayKey, 24 * 60 * 60 * 1000);

  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const challenge = challenges.get(body.challengeId);
  if (!challenge || challenge.exp < Date.now()) fail(400, '验证码已过期，请刷新');
  challenges.delete(body.challengeId);
  if (Number(body.answer) !== challenge.answer) fail(400, '验证码答案不正确');
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(name)) fail(400, '用户名需为 2–20 位中文、字母、数字、下划线或短横线');
  if (password.length < 8 || password.length > 128) fail(400, '密码长度需为 8–128 位');
  if (store.users.some(u => u.name.toLowerCase() === name.toLowerCase())) fail(409, '用户名已存在');

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptHash(password, salt);
  const user = {
    id: crypto.randomUUID(),
    name,
    salt,
    hash,
    createdAt: new Date().toISOString(),
    role: name.toLowerCase() === SUPER_ADMIN ? 'admin' : 'user',
    lastLoginAt: new Date().toISOString(),
    privacy: { tree: true, timer: true, bp: true },
  };
  store.users.push(user);
  await saveGlobal('users');
  await writeTree(user.id, defaultTree());

  const token = crypto.randomBytes(32).toString('hex');
  store.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_MS };
  await saveGlobal('sessions');
  setSessionCookie(res, token);
  json(res, 201, { user: userView(user) });
});

on('POST', '/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const ipKey = `login-ip:${ip}`;
  const accountKey = `login-account:${name}`;
  if (limitExceeded(ipKey, 20, 10 * 60 * 1000) || limitExceeded(accountKey, 5, 10 * 60 * 1000)) {
    fail(429, '登录失败次数过多，账号已临时锁定，请 10 分钟后再试');
  }
  const user = store.users.find(u => u.name.toLowerCase() === name);
  const ok = user && password ? await verifyPassword(user, password) : false;
  if (!ok) {
    limitRecord(ipKey, 10 * 60 * 1000);
    limitRecord(accountKey, 10 * 60 * 1000);
    fail(401, '用户名或密码错误');
  }
  limitClear(accountKey);
  if (user.name === SUPER_ADMIN) user.role = 'admin';
  user.lastLoginAt = new Date().toISOString();
  await saveGlobal('users');
  const token = crypto.randomBytes(32).toString('hex');
  store.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_MS };
  await saveGlobal('sessions');
  setSessionCookie(res, token);
  json(res, 200, { user: userView(user) });
});

on('POST', '/api/auth/logout', async (req, res) => {
  const token = parseCookies(req).grow_session;
  if (token && store.sessions[token]) {
    delete store.sessions[token];
    await saveGlobal('sessions');
  }
  clearSessionCookie(res);
  json(res, 200, { ok: true });
});

on('GET', '/api/auth/me', async (req, res) => {
  const user = await requireUser(req);
  json(res, 200, { user: userView(user) });
});

on('POST', '/api/auth/password', async (req, res) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const current = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!(await verifyPassword(user, current))) fail(403, '当前密码不正确');
  if (next.length < 8 || next.length > 128) fail(400, '新密码长度需为 8–128 位');
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = await scryptHash(next, user.salt);
  const token = parseCookies(req).grow_session;
  for (const t of Object.keys(store.sessions)) {
    if (store.sessions[t].uid === user.id && t !== token) delete store.sessions[t];
  }
  await saveGlobal('users');
  await saveGlobal('sessions');
  json(res, 200, { ok: true });
});

// --- 用户资料

on('PUT', '/api/users/me', async (req, res) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (user.name === SUPER_ADMIN) fail(400, '超级管理员用户名不可修改');
    if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(name)) fail(400, '用户名需为 2–20 位中文、字母、数字、下划线或短横线');
    if (name.toLowerCase() === SUPER_ADMIN) fail(409, '该用户名已被保留');
    if (store.users.some(u => u.id !== user.id && u.name.toLowerCase() === name.toLowerCase())) fail(409, '用户名已存在');
    user.name = name;
    for (const bp of store.blueprints) if (bp.ownerId === user.id) bp.ownerName = name;
  }
  if (body.privacy && typeof body.privacy === 'object') {
    if (typeof body.privacy.tree === 'boolean') user.privacy.tree = body.privacy.tree;
    if (typeof body.privacy.timer === 'boolean') user.privacy.timer = body.privacy.timer;
    if (typeof body.privacy.bp === 'boolean') user.privacy.bp = body.privacy.bp;
  }
  await saveGlobal('users');
  await saveGlobal('blueprints');
  json(res, 200, { user: userView(user) });
});

// --- 树

on('GET', '/api/tree', async (req, res) => {
  const user = await requireUser(req);
  const data = await withLock(`tree:${user.id}`, async () => {
    const tree = await readTree(user.id);
    const reset = ensureWeek(tree, new Date());
    const meta = computeMeta(tree);
    tree.points = meta.available;
    tree.timer.bonus = meta.bonus;
    if (reset) await writeTree(user.id, tree);
    return { tree, meta };
  });
  json(res, 200, data);
});

on('PUT', '/api/tree', async (req, res) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const input = body && body.tree ? body.tree : body;
  const data = await withLock(`tree:${user.id}`, async () => {
    const prev = await readTree(user.id);
    const { tree, meta } = sanitizeTree(input, prev, { charge: true });
    await writeTree(user.id, tree);
    await pruneRemovedPhotos(user.id, prev.files, tree.files);
    return { tree, meta };
  });
  json(res, 200, data);
});

on('POST', '/api/prune', async (req, res) => {
  const user = await requireUser(req);
  const data = await withLock(`tree:${user.id}`, async () => {
    const tree = await readTree(user.id);
    ensureWeek(tree, new Date());
    const before = tree.abilities.length;
    const groupIds = new Set(tree.abilities.filter(a => a.kind === 'group').map(a => a.id));
    tree.abilities = tree.abilities.filter(a => a.kind === 'group' || (a.parentId && groupIds.has(a.parentId)));
    const leafIds = new Set(tree.abilities.filter(a => a.kind === 'leaf').map(a => a.id));
    for (const a of tree.abilities) {
      if (a.kind === 'leaf') a.prereqIds = (a.prereqIds || []).filter(id => leafIds.has(id) && id !== a.id);
      else a.prereqIds = [];
    }
    // 清理悬空文件/照片引用
    const prevFiles = tree.files || [];
    const nodeIds = new Set(tree.abilities.map(a => a.id));
    tree.files = prevFiles.filter(f => f.local ? !f.nodeId : (f.nodeId && nodeIds.has(f.nodeId)));
    for (const g of tree.abilities.filter(a => a.kind === 'group')) {
      g.cost = tree.abilities.filter(a => a.kind === 'leaf' && a.parentId === g.id).reduce((s, a) => s + a.cost, 0);
    }
    tree.version = (tree.version || 0) + 1;
    const meta = computeMeta(tree);
    tree.points = meta.available;
    await writeTree(user.id, tree);
    await pruneRemovedPhotos(user.id, prevFiles, tree.files);
    return { tree, meta, removed: before - tree.abilities.length };
  });
  json(res, 200, data);
});

// --- 笔记

on('GET', '/api/notes', async (req, res) => {
  const user = await requireUser(req);
  const dir = notesDir(user.id);
  await ensureDir(dir);
  const names = await fs.promises.readdir(dir).catch(() => []);
  const items = [];
  for (const name of names) {
    if (!safeFileName(name)) continue;
    const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    if (st && st.isFile()) items.push({ name, size: st.size, updatedAt: st.mtime.toISOString() });
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  json(res, 200, { notes: items });
});

on('POST', '/api/notes', async (req, res) => {
  const user = await requireUser(req);
  const url = new URL(req.url, 'http://localhost');
  let name = safeFileName(url.searchParams.get('name'));
  let content;
  const type = (req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/json')) {
    const body = await readJson(req);
    name = name || safeFileName(body.name);
    content = typeof body.content === 'string' ? body.content : '';
  } else {
    const buf = await readBody(req, MAX_NOTE);
    content = buf.toString('utf8');
  }
  if (!name) fail(400, '文件名不合法');
  if (!name.toLowerCase().endsWith('.md')) name = `${name}.md`;
  if (content.length > MAX_NOTE) fail(413, '笔记内容过大');
  const dir = notesDir(user.id);
  await ensureDir(dir);
  const file = path.join(dir, name);
  if (!file.startsWith(dir + path.sep)) fail(400, '文件名不合法');
  await fs.promises.writeFile(file, content, 'utf8');
  json(res, 200, { name, size: Buffer.byteLength(content), updatedAt: new Date().toISOString() });
});

on('GET', '/api/notes/:name', async (req, res, params) => {
  const user = await requireUser(req);
  const name = safeFileName(params.name);
  if (!name) fail(400, '文件名不合法');
  const dir = notesDir(user.id);
  const file = path.join(dir, name);
  if (!file.startsWith(dir + path.sep)) fail(400, '文件名不合法');
  const content = await fs.promises.readFile(file, 'utf8').catch(() => null);
  if (content === null) fail(404, '笔记不存在');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(content);
});

on('DELETE', '/api/notes/:name', async (req, res, params) => {
  const user = await requireUser(req);
  const name = safeFileName(params.name);
  if (!name) fail(400, '文件名不合法');
  const dir = notesDir(user.id);
  const file = path.join(dir, name);
  if (!file.startsWith(dir + path.sep)) fail(400, '文件名不合法');
  const ok = await fs.promises.unlink(file).then(() => true).catch(() => false);
  if (!ok) fail(404, '笔记不存在');
  json(res, 200, { ok: true });
});

// --- 照片

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

on('POST', '/api/photos', async (req, res) => {
  const user = await requireUser(req);
  const url = new URL(req.url, 'http://localhost');
  const nodeId = url.searchParams.get('nodeId') || '';
  const display = (url.searchParams.get('name') || 'photo').slice(0, 100);
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(mime)) fail(415, '仅支持 PNG / JPEG / WebP / GIF 图片');
  const buf = await readBody(req, MAX_PHOTO);
  if (!buf.length) fail(400, '图片内容为空');
  const data = await withLock(`tree:${user.id}`, async () => {
    const tree = await readTree(user.id);
    ensureWeek(tree, new Date());
    const node = tree.abilities.find(a => a.id === nodeId);
    if (!node) fail(404, '目标知识点不存在');
    if ((node.photos || []).length >= 3) fail(409, '每个知识点最多 3 张照片');
    const storedAs = `${crypto.randomUUID()}${IMAGE_EXT[mime]}`;
    const dir = photosDir(user.id);
    await ensureDir(dir);
    await fs.promises.writeFile(path.join(dir, storedAs), buf);
    const photo = {
      id: crypto.randomUUID(),
      name: safeFileName(display) || 'photo',
      mime,
      size: buf.length,
      storedAs,
      createdAt: new Date().toISOString(),
    };
    node.photos = node.photos || [];
    node.photos.push(photo);
    tree.files = tree.files || [];
    tree.files.push({
      id: photo.id, nodeId: node.id, name: photo.name, mime, size: photo.size,
      storedAs, local: false, createdAt: photo.createdAt,
    });
    tree.version = (tree.version || 0) + 1;
    await writeTree(user.id, tree);
    return { photo, tree };
  });
  json(res, 201, { photo: data.photo });
});

on('GET', '/api/photos/:name', async (req, res, params) => {
  const viewer = await requireUser(req);
  const name = safeFileName(params.name);
  if (!name) fail(400, '文件名不合法');
  const ownerIds = [viewer.id];
  for (const f of store.friends) {
    if (f.status !== 'accepted') continue;
    const other = f.a === viewer.id ? f.b : f.b === viewer.id ? f.a : null;
    if (!other) continue;
    const owner = findUser(other);
    if (owner && owner.privacy.tree) ownerIds.push(other);
  }
  let found = null;
  let ownerId = null;
  for (const uid of ownerIds) {
    const tree = await readTree(uid);
    const entry = (tree.files || []).find(x => !x.local && x.storedAs === name);
    if (entry) { found = entry; ownerId = uid; break; }
  }
  if (!found) fail(404, '照片不存在');
  const file = path.join(photosDir(ownerId), name);
  const buf = await fs.promises.readFile(file).catch(() => null);
  if (!buf) fail(404, '照片不存在');
  res.writeHead(200, {
    'Content-Type': found.mime || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(buf);
});

on('DELETE', '/api/photos/:name', async (req, res, params) => {
  const user = await requireUser(req);
  const name = safeFileName(params.name);
  if (!name) fail(400, '文件名不合法');
  const data = await withLock(`tree:${user.id}`, async () => {
    const tree = await readTree(user.id);
    const entry = (tree.files || []).find(f => !f.local && f.storedAs === name);
    if (!entry) fail(404, '照片不存在');
    for (const a of tree.abilities) {
      if (Array.isArray(a.photos)) a.photos = a.photos.filter(p => p.storedAs !== name);
    }
    tree.files = tree.files.filter(f => f.storedAs !== name);
    tree.version = (tree.version || 0) + 1;
    await fs.promises.unlink(path.join(photosDir(user.id), name)).catch(() => {});
    await writeTree(user.id, tree);
    return { ok: true };
  });
  json(res, 200, data);
});

// --- 导入导出

on('GET', '/api/export', async (req, res) => {
  const user = await requireUser(req);
  const tree = await readTree(user.id);
  ensureWeek(tree, new Date());
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="growth-tree-${user.name}.json"`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(tree, null, 2));
});

on('POST', '/api/import', async (req, res) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const input = body && body.tree ? body.tree : body;
  const data = await withLock(`tree:${user.id}`, async () => {
    const prev = await readTree(user.id);
    const fresh = defaultTree();
    const { tree, meta } = sanitizeTree(input, fresh, { charge: false });
    tree.version = (Number(prev.version) || 0) + 1;
    tree.timer.spent = Math.max(0, Number(prev.timer.spent) || 0);
    tree.timer.rate = clampInt(input.timer && input.timer.rate, 0, 100, clampInt(prev.timer.rate, 0, 100, 50));
    const nextMeta = computeMeta(tree);
    tree.points = nextMeta.available;
    await writeTree(user.id, tree);
    return { tree, meta: nextMeta };
  });
  json(res, 200, data);
});

// --- 蓝图

on('GET', '/api/blueprints', async (req, res) => {
  const viewer = await requireUser(req);
  const url = new URL(req.url, 'http://localhost');
  const category = (url.searchParams.get('category') || '').trim();
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const ownerFilter = url.searchParams.get('owner') || '';
  let list = store.blueprints.filter(bp => canViewBlueprint(bp, viewer));
  if (category) list = list.filter(bp => bp.category === category || bp.categoryName === category);
  if (ownerFilter) list = list.filter(bp => bp.ownerId === ownerFilter || bp.ownerName.toLowerCase() === ownerFilter.toLowerCase());
  if (q) list = list.filter(bp => `${bp.title} ${bp.note} ${bp.ownerName}`.toLowerCase().includes(q));
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  json(res, 200, { blueprints: list.slice(0, 100).map(bp => blueprintSummary(bp, viewer)) });
});

on('POST', '/api/blueprints', async (req, res) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const note = typeof body.note === 'string' ? body.note.slice(0, 5000) : '';
  const visibility = ['public', 'friends', 'private'].includes(body.visibility) ? body.visibility : 'private';
  if (title.length < 2 || title.length > 60) fail(400, '蓝图标题需为 2–60 个字符');
  if (store.blueprints.filter(b => b.ownerId === user.id).length >= 50) fail(409, '每个用户最多发布 50 份蓝图');
  const data = await withLock(`tree:${user.id}`, async () => {
    const tree = await readTree(user.id);
    ensureWeek(tree, new Date());
    const selectedIds = Array.isArray(body.nodeIds) ? new Set(body.nodeIds.filter(x => typeof x === 'string')) : null;
    let nodes = tree.abilities.filter(a => !selectedIds || selectedIds.has(a.id));
    if (!nodes.length) fail(400, '请选择至少一个节点');
    // 补全叶子节点的父组
    const ids = new Set(nodes.map(n => n.id));
    for (const leaf of nodes.filter(n => n.kind === 'leaf')) {
      if (leaf.parentId && !ids.has(leaf.parentId)) {
        const g = tree.abilities.find(a => a.id === leaf.parentId);
        if (g) { nodes.push(g); ids.add(g.id); }
      }
    }
    if (nodes.length > 300) nodes = nodes.slice(0, 300);
    const group = nodes.find(n => n.kind === 'group') || null;
    const cat = group ? tree.categories.find(c => c.id === group.categoryId) : tree.categories[0];
    const id = crypto.randomUUID();
    const dir = blueprintDir(id);
    await ensureDir(path.join(dir, 'images'));
    await ensureDir(path.join(dir, 'files'));
    const images = [];
    const files = [];
    for (const node of nodes) {
      for (const p of node.photos || []) {
        const src = path.join(photosDir(user.id), p.storedAs);
        if (!fs.existsSync(src)) continue;
        const ext = path.extname(p.storedAs) || '';
        const storedAs = `${crypto.randomUUID()}${ext}`;
        await fs.promises.copyFile(src, path.join(dir, 'images', storedAs));
        images.push({ id: crypto.randomUUID(), nodeId: node.id, name: p.name, mime: p.mime, size: p.size, storedAs, createdAt: new Date().toISOString() });
      }
      for (const f of (tree.files || [])) {
        if (f.nodeId !== node.id || f.local || !f.storedAs) continue;
        if (images.some(i => i.storedAs === f.storedAs)) continue;
        files.push({ id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime, size: f.size });
      }
    }
    const bp = {
      id,
      title,
      note,
      ownerId: user.id,
      ownerName: user.name,
      category: cat ? cat.id : 'cat_study',
      categoryName: cat ? cat.name : '学习',
      visibility,
      nodes: nodes.map(n => ({ ...clone(n), sourceId: n.id, categoryName: n.kind === 'group' ? (cat ? cat.name : '学习') : null })),
      files,
      images,
      score: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    bp.score = scoreBlueprint(bp);
    store.blueprints.push(bp);
    await saveGlobal('blueprints');
    await writeJsonFile(path.join(dir, 'blueprint.json'), bp);
    return bp;
  });
  json(res, 201, { blueprint: blueprintSummary(data, user) });
});

on('GET', '/api/blueprints/:id', async (req, res, params) => {
  const viewer = await requireUser(req);
  const bp = store.blueprints.find(b => b.id === params.id);
  if (!bp) fail(404, '蓝图不存在');
  if (!canViewBlueprint(bp, viewer)) fail(403, '无权查看该蓝图');
  json(res, 200, { blueprint: bp, mine: bp.ownerId === viewer.id, canManage: bp.ownerId === viewer.id || viewer.role === 'admin' });
});

on('PUT', '/api/blueprints/:id', async (req, res, params) => {
  const user = await requireUser(req);
  const bp = store.blueprints.find(b => b.id === params.id);
  if (!bp) fail(404, '蓝图不存在');
  if (bp.ownerId !== user.id && user.role !== 'admin') fail(403, '无权修改该蓝图');
  const body = await readJson(req);
  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (title.length < 2 || title.length > 60) fail(400, '蓝图标题需为 2–60 个字符');
    bp.title = title;
  }
  if (typeof body.note === 'string') bp.note = body.note.slice(0, 5000);
  if (['public', 'friends', 'private'].includes(body.visibility)) bp.visibility = body.visibility;
  bp.score = scoreBlueprint(bp);
  bp.updatedAt = new Date().toISOString();
  await saveGlobal('blueprints');
  await writeJsonFile(path.join(blueprintDir(bp.id), 'blueprint.json'), bp);
  json(res, 200, { blueprint: blueprintSummary(bp, user) });
});

on('DELETE', '/api/blueprints/:id', async (req, res, params) => {
  const user = await requireUser(req);
  const bp = store.blueprints.find(b => b.id === params.id);
  if (!bp) fail(404, '蓝图不存在');
  if (bp.ownerId !== user.id && user.role !== 'admin') fail(403, '无权删除该蓝图');
  store.blueprints = store.blueprints.filter(b => b.id !== bp.id);
  await saveGlobal('blueprints');
  await fs.promises.rm(blueprintDir(bp.id), { recursive: true, force: true });
  json(res, 200, { ok: true });
});

on('POST', '/api/blueprints/:id/import', async (req, res, params) => {
  const user = await requireUser(req);
  const bp = store.blueprints.find(b => b.id === params.id);
  if (!bp) fail(404, '蓝图不存在');
  if (!canViewBlueprint(bp, user)) fail(403, '无权导入该蓝图');

  const data = await withLock(`tree:${user.id}`, async () => {
    const tree = await readTree(user.id);
    ensureWeek(tree, new Date());
    const sourceNodes = Array.isArray(bp.nodes) ? bp.nodes : [];
    const sourceIds = new Set(sourceNodes.map(n => n.id));
    const groups = sourceNodes.filter(n => n.kind === 'group');
    const leaves = sourceNodes.filter(n => n.kind === 'leaf' && n.parentId && sourceIds.has(n.parentId));
    const kept = [...groups, ...leaves];
    if (!kept.length) fail(400, '蓝图没有可导入的完整子树');
    if (tree.abilities.length + kept.length > 300) fail(409, '导入后节点数量将超过上限（300 个）');

    const idMap = new Map();
    for (const n of kept) idMap.set(n.id, crypto.randomUUID());

    // 分类：按蓝图里的 categoryName 复用或新建
    const existingCats = new Map(tree.categories.map(c => [c.name.toLowerCase(), c]));
    const catMap = new Map();
    for (const g of groups) {
      const name = typeof g.categoryName === 'string' && g.categoryName.trim() ? g.categoryName.trim() : (bp.categoryName || '学习');
      const found = existingCats.get(name.toLowerCase());
      if (found) { catMap.set(g.id, found.id); continue; }
      if (tree.categories.length >= 20) { catMap.set(g.id, tree.categories[0] ? tree.categories[0].id : 'cat_study'); continue; }
      const cat = { id: `cat_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, name: name.slice(0, 30) };
      tree.categories.push(cat);
      existingCats.set(cat.name.toLowerCase(), cat);
      catMap.set(g.id, cat.id);
    }

    const usedNames = new Set(tree.abilities.map(a => a.name.toLowerCase()));
    function uniqueName(name) {
      let base = String(name || '导入节点').slice(0, 40);
      let candidate = base;
      let n = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        const suffix = ` ${n++}`;
        candidate = base.slice(0, 40 - suffix.length) + suffix;
      }
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }

    const added = [];
    for (const g of groups) {
      added.push({
        id: idMap.get(g.id),
        name: uniqueName(g.name),
        cost: 0,
        unlocked: false,
        kind: 'group',
        parentId: null,
        prereqIds: [],
        categoryId: catMap.get(g.id) || tree.categories[0].id,
        ox: 0, oy: 0,
        note: typeof g.note === 'string' ? g.note.slice(0, 5000) : (typeof bp.note === 'string' ? bp.note.slice(0, 5000) : ''),
        photos: [],
      });
    }
    for (const leaf of leaves) {
      const parentId = idMap.get(leaf.parentId);
      if (!parentId) continue;
      added.push({
        id: idMap.get(leaf.id),
        name: uniqueName(leaf.name),
        cost: clampInt(leaf.cost, 1, 100000, 1),
        unlocked: false,
        kind: 'leaf',
        parentId,
        prereqIds: (leaf.prereqIds || []).filter(pid => idMap.has(pid)).map(pid => idMap.get(pid)),
        categoryId: null,
        ox: Number.isFinite(Number(leaf.ox)) ? Number(leaf.ox) : 0,
        oy: Number.isFinite(Number(leaf.oy)) ? Number(leaf.oy) : 0,
        note: typeof leaf.note === 'string' ? leaf.note.slice(0, 5000) : '',
        photos: [],
      });
    }

    // 导入蓝图图片到自己的照片目录
    tree.files = tree.files || [];
    const dir = blueprintDir(bp.id);
    for (const img of bp.images || []) {
      const mappedNode = idMap.get(img.nodeId);
      if (!mappedNode) continue;
      const node = added.find(a => a.id === mappedNode);
      if (!node || node.photos.length >= 3) continue;
      const storedAs = safeFileName(img.storedAs);
      if (!storedAs) continue;
      const src = path.join(dir, 'images', storedAs);
      if (!fs.existsSync(src)) continue;
      const ext = path.extname(storedAs) || '';
      const newStored = `${crypto.randomUUID()}${ext}`;
      const target = photosDir(user.id);
      await ensureDir(target);
      await fs.promises.copyFile(src, path.join(target, newStored));
      node.photos.push({
        id: crypto.randomUUID(),
        name: img.name || '蓝图图片',
        mime: img.mime || 'application/octet-stream',
        size: img.size || 0,
        storedAs: newStored,
        createdAt: new Date().toISOString(),
      });
      tree.files.push({
        id: crypto.randomUUID(), nodeId: node.id, name: img.name || '蓝图图片',
        mime: img.mime || 'application/octet-stream', size: img.size || 0,
        storedAs: newStored, local: false, createdAt: new Date().toISOString(),
      });
    }

    tree.abilities.push(...added);
    for (const g of tree.abilities.filter(a => a.kind === 'group')) {
      g.cost = tree.abilities.filter(a => a.kind === 'leaf' && a.parentId === g.id).reduce((s, a) => s + a.cost, 0);
    }
    tree.version = (tree.version || 0) + 1;
    const meta = computeMeta(tree);
    tree.points = meta.available;
    await writeTree(user.id, tree);
    return { tree, meta, imported: added.length };
  });
  json(res, 200, data);
});

on('POST', '/api/blueprints/:id/refresh', async (req, res, params) => {
  const user = await requireUser(req);
  const bp = store.blueprints.find(b => b.id === params.id);
  if (!bp) fail(404, '蓝图不存在');
  if (bp.ownerId !== user.id) fail(403, '只有主人可以刷新蓝图');
  const tree = await readTree(user.id);
  ensureWeek(tree, new Date());
  const dir = blueprintDir(bp.id);
  const imagesDir = path.join(dir, 'images');
  await fs.promises.rm(imagesDir, { recursive: true, force: true });
  await ensureDir(imagesDir);
  await ensureDir(path.join(dir, 'files'));
  const nodes = [];
  const images = [];
  const files = [];
  for (const old of bp.nodes || []) {
    const sourceId = old.sourceId || old.id;
    const current = tree.abilities.find(a => a.id === sourceId);
    if (!current) continue;
    nodes.push({ ...clone(current), sourceId, categoryName: current.kind === 'group' ? (bp.categoryName || '') : null });
    for (const p of current.photos || []) {
      const src = path.join(photosDir(user.id), p.storedAs);
      if (!fs.existsSync(src)) continue;
      const ext = path.extname(p.storedAs) || '';
      const storedAs = `${crypto.randomUUID()}${ext}`;
      await fs.promises.copyFile(src, path.join(imagesDir, storedAs));
      images.push({ id: crypto.randomUUID(), nodeId: current.id, name: p.name, mime: p.mime, size: p.size, storedAs, createdAt: new Date().toISOString() });
    }
  }
  for (const f of tree.files || []) {
    if (f.local || !f.storedAs) continue;
    if (!nodes.some(n => n.id === f.nodeId)) continue;
    files.push({ id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime, size: f.size });
  }
  bp.nodes = nodes;
  bp.images = images;
  bp.files = files;
  bp.updatedAt = new Date().toISOString();
  bp.score = scoreBlueprint(bp);
  await saveGlobal('blueprints');
  await writeJsonFile(path.join(dir, 'blueprint.json'), bp);
  json(res, 200, { blueprint: bp });
});

on('GET', '/api/blueprints/:id/images/:img', async (req, res, params) => {
  const viewer = await requireUser(req);
  const bp = store.blueprints.find(b => b.id === params.id);
  if (!bp) fail(404, '蓝图不存在');
  if (!canViewBlueprint(bp, viewer)) fail(403, '无权查看该蓝图');
  const name = safeFileName(params.img);
  if (!name) fail(400, '文件名不合法');
  const image = (bp.images || []).find(i => i.storedAs === name);
  if (!image) fail(404, '图片不存在');
  const file = path.join(blueprintDir(bp.id), 'images', name);
  const buf = await fs.promises.readFile(file).catch(() => null);
  if (!buf) fail(404, '图片不存在');
  res.writeHead(200, {
    'Content-Type': image.mime || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(buf);
});

// --- 社交

on('GET', '/api/users', async (req, res) => {
  const user = await requireUser(req);
  const key = `search:${user.id}`;
  if (limitExceeded(key, 20, 60 * 1000)) fail(429, '搜索过于频繁');
  limitRecord(key, 60 * 1000);
  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) fail(400, '搜索词至少 2 个字符');
  const lower = q.toLowerCase();
  const results = store.users
    .filter(u => u.id !== user.id && u.name.toLowerCase().includes(lower))
    .slice(0, 12)
    .map(u => ({ id: u.id, name: u.name, role: u.name === SUPER_ADMIN ? 'admin' : u.role, isFriend: areFriends(user.id, u.id) }));
  json(res, 200, { users: results });
});

on('GET', '/api/friends', async (req, res) => {
  const user = await requireUser(req);
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const f of store.friends) {
    if (f.a !== user.id && f.b !== user.id) continue;
    const otherId = f.a === user.id ? f.b : f.a;
    const other = findUser(otherId);
    if (!other) continue;
    const item = { id: other.id, name: other.name, createdAt: f.createdAt };
    if (f.status === 'accepted') friends.push(item);
    else if (f.a === user.id) outgoing.push(item);
    else incoming.push(item);
  }
  json(res, 200, { friends, incoming, outgoing });
});

on('POST', '/api/friends', async (req, res) => {
  const user = await requireUser(req);
  const body = await readJson(req);
  const targetId = typeof body.uid === 'string' ? body.uid : '';
  const target = findUser(targetId);
  if (!target) fail(404, '用户不存在');
  if (target.id === user.id) fail(400, '不能添加自己为好友');
  const existing = friendship(user.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') fail(409, '你们已经是好友');
    if (existing.a === target.id) {
      existing.status = 'accepted';
      await saveGlobal('friends');
      return json(res, 200, { ok: true, accepted: true });
    }
    fail(409, '好友申请已发送，请等待对方处理');
  }
  store.friends.push({ a: user.id, b: target.id, status: 'pending', createdAt: new Date().toISOString() });
  await saveGlobal('friends');
  json(res, 201, { ok: true });
});

on('POST', '/api/friends/:id/accept', async (req, res, params) => {
  const user = await requireUser(req);
  const rec = store.friends.find(f => f.a === params.id && f.b === user.id && f.status === 'pending');
  if (!rec) fail(404, '没有找到该好友申请');
  rec.status = 'accepted';
  await saveGlobal('friends');
  json(res, 200, { ok: true });
});

on('POST', '/api/friends/:id/reject', async (req, res, params) => {
  const user = await requireUser(req);
  const idx = store.friends.findIndex(f => f.a === params.id && f.b === user.id && f.status === 'pending');
  if (idx < 0) fail(404, '没有找到该好友申请');
  store.friends.splice(idx, 1);
  await saveGlobal('friends');
  json(res, 200, { ok: true });
});

on('DELETE', '/api/friends/:id', async (req, res, params) => {
  const user = await requireUser(req);
  const before = store.friends.length;
  store.friends = store.friends.filter(f => !((f.a === user.id && f.b === params.id) || (f.b === user.id && f.a === params.id)));
  if (store.friends.length === before) fail(404, '好友关系不存在');
  await saveGlobal('friends');
  json(res, 200, { ok: true });
});

on('GET', '/api/chat/:id', async (req, res, params) => {
  const user = await requireUser(req);
  const other = findUser(params.id);
  if (!other) fail(404, '用户不存在');
  if (!areFriends(user.id, other.id)) fail(403, '只能和好友聊天');
  const chat = store.chats.find(c => (c.a === user.id && c.b === other.id) || (c.a === other.id && c.b === user.id));
  json(res, 200, { messages: chat ? chat.messages.slice(-500) : [], peer: { id: other.id, name: other.name } });
});

on('POST', '/api/chat/:id', async (req, res, params) => {
  const user = await requireUser(req);
  const other = findUser(params.id);
  if (!other) fail(404, '用户不存在');
  if (!areFriends(user.id, other.id)) fail(403, '只能和好友聊天');
  const body = await readJson(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 1000) fail(400, '消息长度需为 1–1000 个字符');
  let chat = store.chats.find(c => (c.a === user.id && c.b === other.id) || (c.a === other.id && c.b === user.id));
  if (!chat) {
    chat = { a: user.id, b: other.id, messages: [] };
    store.chats.push(chat);
  }
  const message = { from: user.id, text, at: new Date().toISOString() };
  chat.messages.push(message);
  if (chat.messages.length > 1000) chat.messages = chat.messages.slice(-1000);
  await saveGlobal('chats');
  json(res, 201, { message });
});

on('GET', '/api/users/:id/tree', async (req, res, params) => {
  const viewer = await requireUser(req);
  const target = findUser(params.id);
  if (!target) fail(404, '用户不存在');
  const isSelf = viewer.id === target.id;
  if (!isSelf && viewer.role !== 'admin') {
    if (!areFriends(viewer.id, target.id)) fail(403, '只能查看好友的树');
    if (!target.privacy.tree) fail(403, '对方已关闭树查看权限');
  }
  const data = await withLock(`tree:${target.id}`, async () => {
    const tree = await readTree(target.id);
    ensureWeek(tree, new Date());
    const meta = computeMeta(tree);
    if (!isSelf && !target.privacy.timer) {
      tree.timer = { rate: 0, spent: 0, bonus: 0, weekKey: tree.week.key, weeks: { [tree.week.key]: { courses: [], plans: [] } } };
    }
    return { tree, meta: isSelf || target.privacy.timer ? meta : { ...meta, available: 0, remainingMinutes: 0, totalFreeMinutes: 0, bonus: 0, used: 0 } };
  });
  json(res, 200, { ...data, user: { id: target.id, name: target.name }, readOnly: true });
});

// --- 反馈

on('GET', '/api/feedback', async (req, res) => {
  const user = await requireUser(req);
  const isAdmin = user.role === 'admin';
  const list = store.feedback
    .filter(f => isAdmin || f.uid === user.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 200);
  json(res, 200, { feedback: list });
});

on('POST', '/api/feedback', async (req, res) => {
  const user = await requireUser(req);
  const key = `feedback:${user.id}`;
  if (limitExceeded(key, 10, 60 * 60 * 1000)) fail(429, '反馈提交过于频繁');
  const body = await readJson(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) fail(400, '反馈内容需为 1–2000 个字符');
  limitRecord(key, 60 * 60 * 1000);
  const item = {
    id: crypto.randomUUID(),
    uid: user.id,
    name: user.name,
    text,
    createdAt: new Date().toISOString(),
    replies: [],
  };
  store.feedback.unshift(item);
  await saveGlobal('feedback');
  json(res, 201, { feedback: item });
});

on('POST', '/api/feedback/:id/reply', async (req, res, params) => {
  const user = await requireUser(req);
  const item = store.feedback.find(f => f.id === params.id);
  if (!item) fail(404, '反馈不存在');
  if (user.role !== 'admin' && item.uid !== user.id) fail(403, '无权回复该反馈');
  const body = await readJson(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) fail(400, '回复内容需为 1–2000 个字符');
  item.replies.push({ id: crypto.randomUUID(), uid: user.id, name: user.name, text, createdAt: new Date().toISOString() });
  await saveGlobal('feedback');
  json(res, 200, { feedback: item });
});

on('DELETE', '/api/feedback/:id', async (req, res, params) => {
  const user = await requireUser(req);
  const item = store.feedback.find(f => f.id === params.id);
  if (!item) fail(404, '反馈不存在');
  if (user.role !== 'admin' && item.uid !== user.id) fail(403, '无权删除该反馈');
  store.feedback = store.feedback.filter(f => f.id !== item.id);
  await saveGlobal('feedback');
  json(res, 200, { ok: true });
});

// --- 管理

on('GET', '/api/admin/users', async (req, res) => {
  await requireAdmin(req);
  const users = [];
  for (const u of store.users) {
    const tree = await readTree(u.id);
    users.push({
      ...userView(u),
      abilityCount: (tree.abilities || []).length,
      blueprintCount: store.blueprints.filter(b => b.ownerId === u.id).length,
      superAdmin: u.name === SUPER_ADMIN,
    });
  }
  users.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  json(res, 200, { users });
});

on('GET', '/api/admin/users/:id/blueprints', async (req, res, params) => {
  const admin = await requireAdmin(req);
  const target = findUser(params.id);
  if (!target) fail(404, '用户不存在');
  const list = store.blueprints.filter(b => b.ownerId === target.id).map(b => blueprintSummary(b, admin));
  json(res, 200, { blueprints: list });
});

on('POST', '/api/admin/users/:id/role', async (req, res, params) => {
  const admin = await requireAdmin(req);
  const target = findUser(params.id);
  if (!target) fail(404, '用户不存在');
  if (target.name === SUPER_ADMIN) fail(400, '超级管理员不可调整角色');
  const body = await readJson(req);
  if (!['admin', 'user'].includes(body.role)) fail(400, '角色必须为 admin 或 user');
  target.role = body.role;
  await saveGlobal('users');
  json(res, 200, { user: userView(target) });
});

on('DELETE', '/api/admin/users/:id', async (req, res, params) => {
  const admin = await requireAdmin(req);
  const target = findUser(params.id);
  if (!target) fail(404, '用户不存在');
  if (target.name === SUPER_ADMIN) fail(400, '超级管理员不可删除');

  // 级联清理：tree/notes/photos/blueprints/friends/chats/feedback/sessions
  await fs.promises.rm(path.join(DATA_DIR, 'users', target.id), { recursive: true, force: true });
  const owned = store.blueprints.filter(b => b.ownerId === target.id);
  for (const bp of owned) {
    await fs.promises.rm(blueprintDir(bp.id), { recursive: true, force: true });
  }
  store.blueprints = store.blueprints.filter(b => b.ownerId !== target.id);
  store.friends = store.friends.filter(f => f.a !== target.id && f.b !== target.id);
  store.chats = store.chats.filter(c => c.a !== target.id && c.b !== target.id);
  store.feedback = store.feedback.filter(f => f.uid !== target.id).map(f => ({
    ...f,
    replies: (f.replies || []).filter(r => r.uid !== target.id),
  }));
  for (const t of Object.keys(store.sessions)) {
    if (store.sessions[t].uid === target.id) delete store.sessions[t];
  }
  store.users = store.users.filter(u => u.id !== target.id);
  await Promise.all([saveGlobal('users'), saveGlobal('blueprints'), saveGlobal('friends'), saveGlobal('chats'), saveGlobal('feedback'), saveGlobal('sessions')]);
  json(res, 200, { ok: true });
});

// --- 状态

on('GET', '/api/status', async (req, res) => {
  json(res, 200, {
    ok: true,
    time: new Date().toISOString(),
    week: isoWeekKey(new Date()),
    users: store.users.length,
    superAdmin: SUPER_ADMIN,
    version: '1.0.0',
  });
});

// ---------------------------------------------------------------- 静态资源

const CSP = nonce => [
  "default-src 'self'",
  `script-src 'nonce-${nonce}'`,
  `style-src 'nonce-${nonce}'`,
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

async function serveIndex(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  let html;
  try {
    html = await fs.promises.readFile(path.join(ROOT, 'index.html'), 'utf8');
  } catch {
    return json(res, 500, { error: '前端文件缺失' });
  }
  html = html.split('__CSP_NONCE__').join(nonce);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP(nonce),
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

async function handleStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') return serveIndex(req, res);
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : 'User-agent: *\nDisallow: /api/\n');
  }
  if (pathname === '/favicon.ico') {
    const file = path.join(ROOT, 'favicon.ico');
    const buf = await fs.promises.readFile(file).catch(() => null);
    if (buf) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    res.writeHead(204);
    return res.end();
  }
  fail(404, '页面不存在');
}

// ---------------------------------------------------------------- 请求分发

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = route.parts[i];
      if (p.startsWith(':')) {
        try { params[p.slice(1)] = decodeURIComponent(parts[i]); }
        catch { ok = false; break; }
      } else if (p !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

async function handle(req, res) {
  securityHeaders(res);
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname.startsWith('/api/')) {
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) fail(405, '方法不允许');
    if (req.method !== 'GET') requireSameOrigin(req);
    const matched = matchRoute(req.method, pathname);
    if (!matched) fail(404, '接口不存在');
    await matched.route.handler(req, res, matched.params);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, '方法不允许');
  await handleStatic(req, res, pathname);
}

async function main() {
  await initStore();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      sendError(res, err);
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.listen(PORT, HOST, () => {
    console.log(`成长树已启动：http://${HOST}:${PORT}`);
    console.log(`数据目录：${DATA_DIR}`);
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const t of Object.keys(store.sessions)) {
      if (!store.sessions[t] || store.sessions[t].exp < now) { delete store.sessions[t]; changed = true; }
    }
    if (changed) saveGlobal('sessions').catch(() => {});
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    for (const key of limits.keys()) pruneLimit(key);
  }, 10 * 60 * 1000);
  cleanup.unref();
}

main().catch(err => {
  console.error('启动失败：', err);
  process.exit(1);
});
