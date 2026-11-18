/* 静态站点演示后端（学习树版）：拦截 /api/*，数据仅保存在当前浏览器。 */
(() => {
  'use strict';

  const STORE_KEY = 'study-tree-site-demo-v1';
  const NOTES_DB = 'study-tree-site-demo-files';
  const SEED_TREE = __SEED_TREE__;
  const SELF_ID = 'demo-self';
  const BP_CATS = [
    { id: 'sport', name: '运动' },
    { id: 'study', name: '学习' },
    { id: 'art', name: '艺术' },
    { id: 'other', name: '其他' },
  ];

  const SEED_NOTES = {
    'seed-welcome-欢迎使用.md': [
      '# 欢迎使用学习树',
      '',
      '这是 **站点演示版**：界面与交互都可以操作，数据只保存在当前浏览器。',
      '',
      '## 可以试试',
      '',
      '- 点击知识点卡片，打开右侧面板',
      '- 点亮知识点、设置前置依赖、写学习记录',
      '- 打开「时间」排课，或用「说明」查看完整文档',
      '- 新建、编辑并预览 Markdown 笔记',
      '- 在蓝图市场发布能力、导入别人的节点结构',
      '',
      '> 蓝图在演示版中保存在本机；多用户、好友聊天、意见反馈与管理后台需要本地 Node 服务，站点演示版未启用。',
    ].join('\n'),
    'seed-plan-学习计划.md': [
      '# 本周学习计划',
      '',
      '1. 补齐 CSS 布局笔记',
      '2. 完成两节 JavaScript 练习',
      '3. 周四晚整理错题',
      '',
      '```js',
      'const growth = (time, focus) => time * focus;',
      '```',
    ].join('\n'),
  };

  const DOC_MARKDOWN = [
    '# 学习树 · 演示版',
    '',
    '学习树把「要学的东西」画成一棵树：**空闲时间换科技点，科技点点亮知识点**。',
    '',
    '## 演示范围',
    '',
    '- 学习树：分类、能力组、知识点、前置依赖、点亮、学习记录、照片',
    '- 时间规划：周课表、日常安排、转化率与科技点换算',
    '- 笔记：Markdown 编辑与预览、本地上传；数据存在浏览器',
    '- 蓝图：发布能力、浏览市场、查看内容、导入节点结构；蓝图保存在浏览器',
    '- 导入 / 导出完整学习树 JSON',
    '',
    '## 未启用',
    '',
    '多用户注册登录、好友聊天、意见反馈、管理员后台都依赖本地 Node 服务；本站为静态演示版，这些入口已隐藏。',
    '',
    '## 本地运行完整版',
    '',
    '在项目目录执行 `node server.js`，打开 `http://127.0.0.1:5173` 即可使用完整功能。',
  ].join('\n');

  const clone = value => JSON.parse(JSON.stringify(value));

  let memory = null;
  function db() {
    if (memory) return memory;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.tree && Array.isArray(parsed.tree.abilities)) {
          if (!Array.isArray(parsed.blueprints)) {
            parsed.blueprints = seedBlueprints(parsed.tree);
            memory = parsed;
            save();
            return memory;
          }
          memory = parsed;
          return memory;
        }
      }
    } catch (e) { /* 存储不可用时退回内存 */ }
    memory = {
      tree: clone(SEED_TREE),
      blueprints: seedBlueprints(clone(SEED_TREE)),
      userName: '演示同学',
      displayName: '演示同学',
      avatar: '',
      privacy: { tree: true, timer: true, bp: true },
    };
    save();
    return memory;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(memory)); } catch (e) { /* 忽略配额错误 */ }
  }

  const user = () => {
    const d = db();
    return {
      id: 'demo-self',
      name: d.userName || '演示同学',
      displayName: d.displayName || d.userName || '演示同学',
      avatar: d.avatar || '',
      createdAt: Date.now() - 86400000 * 30,
      role: 'user',
      admin: false,
      protected: false,
      privacy: d.privacy || { tree: true, timer: true, bp: true },
    };
  };

  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
  const fail = (status, message) => json({ error: message }, status);

  function headerOf(init, name) {
    const headers = init.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key]) : '';
  }

  async function bodyBytes(init) {
    const body = init.body;
    if (body === undefined || body === null) return new Uint8Array();
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return new Uint8Array();
  }

  async function bodyText(init) {
    if (typeof init.body === 'string') return init.body;
    if (init.body instanceof Blob) return init.body.text();
    return new TextDecoder().decode(await bodyBytes(init));
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NOTES_DB, 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('notes')) req.result.createObjectStore('notes');
        if (!req.result.objectStoreNames.contains('photos')) req.result.createObjectStore('photos');
        if (!req.result.objectStoreNames.contains('bpnotes')) req.result.createObjectStore('bpnotes');
        if (!req.result.objectStoreNames.contains('bpimages')) req.result.createObjectStore('bpimages');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idb(mode, storeName, run) {
    return openDb().then(idbDb => new Promise((resolve, reject) => {
      const tx = idbDb.transaction(storeName, mode);
      const req = run(tx.objectStore(storeName));
      tx.oncomplete = () => { idbDb.close(); resolve(req ? req.result : undefined); };
      tx.onerror = () => { idbDb.close(); reject(tx.error); };
    }));
  }

  const putBlob = (store, key, blob) => idb('readwrite', store, s => s.put(blob, key));
  const getBlob = (store, key) => idb('readonly', store, s => s.get(key));
  const delBlob = (store, key) => idb('readwrite', store, s => s.delete(key));

  const extMime = name => {
    if (/\.md$/i.test(name) || /\.markdown$/i.test(name)) return 'text/markdown';
    if (/\.pdf$/i.test(name)) return 'application/pdf';
    if (/\.txt$/i.test(name)) return 'text/plain';
    if (/\.png$/i.test(name)) return 'image/png';
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
    if (/\.gif$/i.test(name)) return 'image/gif';
    if (/\.webp$/i.test(name)) return 'image/webp';
    if (/\.bmp$/i.test(name)) return 'image/bmp';
    return 'application/octet-stream';
  };

  function makeId(prefix) {
    return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function bpCatName(id) {
    const c = BP_CATS.find(x => x.id === id);
    return c ? c.name : '其他';
  }

  function bpVisibilityName(id) {
    if (id === 'friends') return '仅好友';
    if (id === 'private') return '私人';
    return '公开';
  }

  function scoreBlueprint(bp) {
    const title = String(bp.title || '').trim();
    const note = String(bp.note || '').trim();
    const nodes = Array.isArray(bp.nodes) ? bp.nodes : [];
    const files = Array.isArray(bp.files) ? bp.files : [];
    const parts = {
      title: title.length >= 8 ? 10 : title.length >= 4 ? 8 : title.length >= 2 ? 4 : 0,
      note: note.length >= 60 ? 30 : note.length >= 30 ? 25 : note.length >= 10 ? 18 : note.length >= 1 ? 8 : 0,
      nodes: nodes.length >= 4 ? 15 : nodes.length >= 2 ? 10 : nodes.length >= 1 ? 5 : 0,
      nodeNotes: 0,
      files: Math.min(15, files.length * 3),
      size: files.length && (bp.size || 0) > 0 ? 5 : 0,
    };
    const withNote = nodes.filter(n => String(n.note || '').trim().length >= 10).length;
    const totalNoteLen = nodes.reduce((sum, n) => sum + String(n.note || '').trim().length, 0);
    parts.nodeNotes = Math.min(18, withNote * 6) + Math.min(12, Math.floor(totalNoteLen / 150));
    return { score: Math.min(100, Math.round(Object.values(parts).reduce((sum, v) => sum + v, 0))), parts };
  }

  function subtreeNodes(tree, rootId) {
    const ids = new Set([rootId]);
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (const a of tree.abilities) {
        if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) {
          ids.add(a.id);
          changed = true;
        }
      }
    }
    return tree.abilities.filter(a => ids.has(a.id));
  }

  function seedBlueprints(tree) {
    const make = (id, rootId, title, note, category, days) => {
      const root = tree.abilities.find(a => a.id === rootId);
      if (!root) return null;
      const nodes = subtreeNodes(tree, rootId).map(n => ({
        id: n.id, name: n.name, cost: n.cost, unlocked: n.unlocked, kind: n.kind,
        parentId: n.parentId, prereqIds: n.prereqIds || [], note: n.note || '',
      }));
      const bp = {
        id, title, note, ownerId: 'demo-example', ownerName: '示例导师',
        category, categoryName: bpCatName(category), visibility: 'public',
        treeCategoryName: '', sourceNodeId: rootId,
        createdAt: Date.now() - days * 86400000, updatedAt: Date.now() - days * 86400000,
        size: 0, nodes, files: [], images: [],
      };
      return Object.assign(bp, scoreBlueprint(bp));
    };
    return [
      make('bp_sample_frontend', 'g_frontend', '前端入门路线', '从 HTML/CSS 到 JavaScript 的前端入门路线，适合零基础按顺序点亮。', 'study', 3),
      make('bp_sample_badminton', 'g_badminton', '羽毛球基础训练', '握拍、发球与基础步法，适合每周安排两次练习。', 'sport', 6),
    ].filter(Boolean);
  }

  function canSeeBp(bp) {
    if (!bp) return false;
    if (bp.ownerId === SELF_ID) return true;
    return (bp.visibility || 'public') === 'public';
  }

  function bpBrief(bp) {
    const sc = scoreBlueprint(bp);
    return {
      id: bp.id, title: bp.title, note: bp.note, ownerName: bp.ownerName, ownerId: bp.ownerId,
      category: bp.category, categoryName: bp.categoryName,
      visibility: bp.visibility || 'public', visibilityName: bpVisibilityName(bp.visibility || 'public'),
      nodeCount: bp.nodes.length, fileCount: bp.files.length, size: bp.size || 0,
      createdAt: bp.createdAt, updatedAt: bp.updatedAt || bp.createdAt, sourceNodeId: bp.sourceNodeId || '',
      cover: bp.images && bp.images.length ? `/api/blueprints/${encodeURIComponent(bp.id)}/images/${encodeURIComponent(bp.images[0].id)}` : '',
      imageCount: (bp.images || []).length,
      score: sc.score, belowThreshold: false, mine: bp.ownerId === SELF_ID,
    };
  }

  async function packageBpFiles(bpId, files) {
    const out = [];
    for (const f of files || []) {
      if (f.local) continue;
      let blob = null;
      if (SEED_NOTES[f.storedAs]) blob = new Blob([SEED_NOTES[f.storedAs]], { type: f.mime || 'text/markdown' });
      else if (f.storedAs) {
        try { blob = await getBlob('notes', f.storedAs); } catch (e) { blob = null; }
      }
      const key = blob ? `${bpId}/${f.id}-${f.name}` : '';
      if (blob) {
        try { await putBlob('bpnotes', key, blob); } catch (e) { /* ignore */ }
      }
      out.push({
        id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime,
        size: f.size, storedAs: key, createdAt: f.createdAt,
      });
    }
    return out;
  }

  async function applyBpImages(bpId, previous, raw) {
    const oldList = Array.isArray(previous) ? previous : [];
    const next = [];
    const list = Array.isArray(raw) ? raw.slice(0, 3) : [];
    for (const img of list) {
      if (!img || typeof img !== 'object') continue;
      if (img.id) {
        const hit = oldList.find(x => x.id === img.id);
        if (hit) { next.push(hit); continue; }
      }
      const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(img.data || ''));
      if (!m) continue;
      let bytes;
      try { bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)); } catch (e) { continue; }
      if (!bytes.length || bytes.length > 2 * 1024 * 1024) continue;
      const imgId = makeId('img');
      const storedAs = `${bpId}/${imgId}`;
      try { await putBlob('bpimages', storedAs, new Blob([bytes], { type: m[1] })); } catch (e) { continue; }
      next.push({
        id: imgId,
        name: String(img.name || 'image').slice(0, 80),
        mime: m[1],
        size: bytes.length,
        storedAs,
      });
    }
    const keep = new Set(next.map(x => x.id));
    for (const old of oldList) {
      if (keep.has(old.id)) continue;
      try { await delBlob('bpimages', old.storedAs); } catch (e) { /* ignore */ }
    }
    return next;
  }

  async function deleteBpAssets(bp) {
    for (const img of bp.images || []) {
      try { await delBlob('bpimages', img.storedAs); } catch (e) { /* ignore */ }
    }
    for (const f of bp.files || []) {
      if (f.storedAs) { try { await delBlob('bpnotes', f.storedAs); } catch (e) { /* ignore */ } }
    }
  }

  function resetDemo() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    try { indexedDB.deleteDatabase(NOTES_DB); } catch (e) { /* ignore */ }
    location.reload();
  }

  async function exportDoc() {
    const doc = clone(db().tree);
    const files = [];
    for (const f of doc.files || []) {
      const entry = { id: f.id, nodeId: f.nodeId, name: f.name, mime: f.mime, size: f.size, createdAt: f.createdAt };
      if (SEED_NOTES[f.storedAs]) {
        entry.data = btoa(unescape(encodeURIComponent(SEED_NOTES[f.storedAs])));
      } else if (f.storedAs) {
        try {
          const blob = await getBlob('notes', f.storedAs);
          if (blob) entry.data = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.readAsDataURL(blob);
          });
        } catch (e) { /* ignore */ }
      }
      files.push(entry);
    }
    return {
      format: 'tech-tree',
      version: 7,
      exportedAt: new Date().toISOString(),
      owner: db().userName,
      points: doc.points,
      categories: doc.categories,
      abilities: doc.abilities,
      files,
      tasks: doc.tasks,
      week: doc.week,
      timer: doc.timer,
    };
  }

  async function importDoc(body) {
    const incoming = JSON.parse(body || '{}');
    if (!Array.isArray(incoming.abilities)) return fail(400, '这个文件里没有学习树数据（缺少 abilities）');
    const tree = {
      version: 7,
      points: Number(incoming.points) || 0,
      exp: Number(incoming.exp) || 0,
      categories: Array.isArray(incoming.categories) ? incoming.categories : [],
      abilities: incoming.abilities,
      files: [],
      tasks: Array.isArray(incoming.tasks) ? incoming.tasks : [],
      week: incoming.week || { key: '' },
      timer: incoming.timer || { rate: 50, courses: [], plans: [], spent: 0, bonus: 0, weekKey: '', weeks: {} },
    };
    const valid = new Set(tree.abilities.map(a => a.id));
    for (const f of Array.isArray(incoming.files) ? incoming.files : []) {
      if (!f || !valid.has(f.nodeId)) continue;
      let storedAs = typeof f.storedAs === 'string' ? f.storedAs : '';
      if (typeof f.data === 'string' && f.data) {
        try {
          const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
          storedAs = `${f.id || makeId('f')}-${f.name || 'file'}`;
          await putBlob('notes', storedAs, new Blob([bytes], { type: f.mime || extMime(f.name || '') }));
        } catch (e) { storedAs = ''; }
      }
      tree.files.push({
        id: f.id || makeId('f'),
        nodeId: f.nodeId,
        name: String(f.name || 'file'),
        mime: f.mime || extMime(String(f.name || '')),
        size: Number(f.size) || 0,
        storedAs,
        local: false,
        createdAt: Number(f.createdAt) || Date.now(),
      });
    }
    db().tree = tree;
    save();
    return json({ ok: true, tree });
  }

  async function handle(url, init) {
    const d = db();
    const p = url.pathname;
    const method = (init.method || 'GET').toUpperCase();

    if (p === '/api/hello') return json({ app: 'study-tree', apiVersion: 12 });
    if (p === '/api/status') return json({ ok: true, version: 7, user: user() });
    if (p === '/api/doc') return json({ markdown: DOC_MARKDOWN });

    // 认证
    if (p === '/api/auth/me') return json({ user: user() });
    if (p === '/api/auth/challenge') return json({ id: makeId('ch'), q: '3 + 4 = ?' });
    if (p === '/api/auth/login' || p === '/api/auth/register') {
      try {
        const body = JSON.parse(await bodyText(init) || '{}');
        if (typeof body.name === 'string' && body.name.trim()) {
          d.userName = body.name.trim().slice(0, 20);
          d.displayName = d.userName;
          save();
        }
        return json({ user: user(), migrated: 0 });
      } catch (e) { return fail(400, '请求格式有误'); }
    }
    if (p === '/api/auth/logout') return json({ ok: true });
    if (p === '/api/auth/password') return json({ ok: true });

    if (p === '/api/users/me' && method === 'PUT') {
      try {
        const body = JSON.parse(await bodyText(init) || '{}');
        if (body.displayName !== undefined) d.displayName = String(body.displayName || '').trim().slice(0, 20) || d.userName;
        if (body.avatar !== undefined && /^data:image\//i.test(String(body.avatar || ''))) d.avatar = String(body.avatar).slice(0, 400000);
        if (body.privacy && typeof body.privacy === 'object') {
          d.privacy = { tree: body.privacy.tree !== false, timer: body.privacy.timer !== false, bp: body.privacy.bp !== false };
        }
        save();
        return json({ ok: true, user: user() });
      } catch (e) { return fail(400, '请求格式有误'); }
    }

    // 树
    if (p === '/api/tree' && method === 'GET') return json(d.tree);
    if (p === '/api/tree' && method === 'PUT') {
      try {
        const doc = JSON.parse(await bodyText(init) || '{}');
        if (!doc || !Array.isArray(doc.abilities)) return fail(400, '树数据格式不正确');
        d.tree = doc;
        save();
        return json({ ok: true, tree: d.tree });
      } catch (e) { return fail(400, '请求内容不是合法的 JSON'); }
    }
    if (p === '/api/prune' && method === 'POST') return json({ ok: true, removed: 0 });
    if (p === '/api/export') return json(await exportDoc());
    if (p === '/api/import' && method === 'POST') return importDoc(await bodyText(init));

    // 笔记文件
    if (p === '/api/notes' && method === 'POST') {
      const name = (url.searchParams.get('name') || '').trim();
      const nodeId = (url.searchParams.get('nodeId') || '').trim();
      if (!nodeId) return fail(400, '缺少 nodeId');
      if (!/\.(md|markdown|pdf|txt|doc|docx|ppt|pptx|png|jpe?g|gif|webp|bmp)$/i.test(name)) return fail(400, '不支持这个文件类型');
      const bytes = await bodyBytes(init);
      if (!bytes.length) return fail(400, '文件是空的');
      if (bytes.length > 32 * 1024 * 1024) return fail(413, '文件不能超过 32MB');
      const id = makeId('f');
      const storedAs = `${id}-${name}`;
      try { await putBlob('notes', storedAs, new Blob([bytes], { type: headerOf(init, 'content-type') || extMime(name) })); }
      catch (e) { return fail(503, '当前浏览器无法保存文件'); }
      return json({ ok: true, file: { id, nodeId, name, mime: extMime(name), size: bytes.length, storedAs, createdAt: Date.now() } }, 201);
    }
    if (p.startsWith('/api/notes/')) {
      let storedAs = '';
      try { storedAs = decodeURIComponent(p.slice('/api/notes/'.length)); } catch (e) { return fail(400, '非法文件名'); }
      if (method === 'GET') {
        if (SEED_NOTES[storedAs]) {
          return new Response(SEED_NOTES[storedAs], { status: 200, headers: { 'Content-Type': extMime(storedAs) + '; charset=utf-8', 'Cache-Control': 'no-store' } });
        }
        try {
          const blob = await getBlob('notes', storedAs);
          if (!blob) return fail(404, '文件不存在');
          return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type || extMime(storedAs), 'Cache-Control': 'no-store' } });
        } catch (e) { return fail(404, '文件不存在'); }
      }
      if (method === 'PUT') {
        const bytes = await bodyBytes(init);
        try { await putBlob('notes', storedAs, new Blob([bytes], { type: extMime(storedAs) })); } catch (e) { return fail(503, '保存失败'); }
        return json({ ok: true, size: bytes.length });
      }
      if (method === 'DELETE') {
        try { await delBlob('notes', storedAs); } catch (e) { /* ignore */ }
        return json({ ok: true });
      }
    }

    // 节点照片
    if (p === '/api/photos' && method === 'POST') {
      const name = (url.searchParams.get('name') || '').trim();
      const nodeId = (url.searchParams.get('nodeId') || '').trim();
      if (!nodeId) return fail(400, '缺少 nodeId');
      if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return fail(400, '只支持图片文件');
      const bytes = await bodyBytes(init);
      if (!bytes.length) return fail(400, '文件是空的');
      if (bytes.length > 8 * 1024 * 1024) return fail(413, '图片不能超过 8MB');
      const id = makeId('ph');
      const storedAs = `${id}-${name}`;
      try { await putBlob('photos', storedAs, new Blob([bytes], { type: headerOf(init, 'content-type') || extMime(name) })); }
      catch (e) { return fail(503, '当前浏览器无法保存图片'); }
      return json({ ok: true, photo: { id, nodeId, name, mime: extMime(name), size: bytes.length, storedAs, createdAt: Date.now() } }, 201);
    }
    if (p.startsWith('/api/photos/')) {
      let storedAs = '';
      try { storedAs = decodeURIComponent(p.slice('/api/photos/'.length)); } catch (e) { return fail(400, '非法文件名'); }
      if (method === 'GET') {
        try {
          const blob = await getBlob('photos', storedAs);
          if (!blob) return fail(404, '图片不存在');
          return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type || extMime(storedAs) } });
        } catch (e) { return fail(404, '图片不存在'); }
      }
      if (method === 'DELETE') {
        try { await delBlob('photos', storedAs); } catch (e) { /* ignore */ }
        return json({ ok: true });
      }
    }

    // 蓝图（本地版）
    const bpImgMatch = p.match(/^\/api\/blueprints\/([^/]+)\/images\/([^/]+)$/);
    if (bpImgMatch && method === 'GET') {
      const bp = d.blueprints.find(x => x.id === bpImgMatch[1]);
      if (!bp) return fail(404, '蓝图不存在');
      if (!canSeeBp(bp)) return fail(403, '无权查看这个蓝图');
      const img = (bp.images || []).find(x => x.id === bpImgMatch[2]);
      if (!img) return fail(404, '图片不存在');
      try {
        const blob = await getBlob('bpimages', img.storedAs);
        if (!blob) return fail(404, '图片文件不存在');
        return new Response(blob, { status: 200, headers: { 'Content-Type': img.mime || 'image/png', 'Cache-Control': 'public, max-age=86400' } });
      } catch (e) { return fail(404, '图片文件不存在'); }
    }

    if (p === '/api/blueprints' && method === 'GET') {
      const scope = url.searchParams.get('scope') || 'all';
      const cat = url.searchParams.get('cat') || '';
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const friendOnly = url.searchParams.get('friend') === '1';
      const ownerFilter = String(url.searchParams.get('owner') || '');
      let list = d.blueprints.filter(bp => {
        const mine = bp.ownerId === SELF_ID;
        if (scope === 'mine') return mine;
        if (scope === 'others') return !mine && canSeeBp(bp);
        return canSeeBp(bp);
      });
      if (friendOnly) list = [];
      if (ownerFilter) list = list.filter(bp => bp.ownerId === ownerFilter);
      if (q) {
        list = list.filter(bp =>
          String(bp.title || '').toLowerCase().includes(q) ||
          String(bp.note || '').toLowerCase().includes(q) ||
          String(bp.ownerName || '').toLowerCase().includes(q)
        );
      }
      const counts = { all: list.length, friends: 0 };
      BP_CATS.forEach(c => { counts[c.id] = 0; });
      list.forEach(bp => { counts[bp.category] = (counts[bp.category] || 0) + 1; });
      if (cat && BP_CATS.some(c => c.id === cat)) list = list.filter(bp => bp.category === cat);
      const brief = list.slice()
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .map(bpBrief);
      return json({ blueprints: brief, counts, total: brief.length });
    }

    if (p === '/api/blueprints' && method === 'POST') {
      let body;
      try { body = JSON.parse(await bodyText(init) || '{}'); }
      catch (e) { return fail(400, '请求格式有误'); }
      const nodeId = String(body.nodeId || '');
      const root = d.tree.abilities.find(a => a.id === nodeId);
      if (!root) return fail(404, '找不到这个父级');
      if (root.kind !== 'group') return fail(400, '只能把父级能力发布成蓝图');
      const nodes = subtreeNodes(d.tree, root.id);
      const nodeIds = new Set(nodes.map(n => n.id));
      const sourceFiles = (d.tree.files || []).filter(f => nodeIds.has(f.nodeId));
      const id = makeId('bp');
      const files = await packageBpFiles(id, sourceFiles);
      const images = await applyBpImages(id, [], body.images);
      const treeCat = d.tree.categories.find(c => c.id === root.categoryId);
      const category = BP_CATS.some(c => c.id === String(body.category || '')) ? String(body.category) : 'other';
      const bp = {
        id,
        title: String(body.title || root.name).trim().slice(0, 40) || root.name,
        note: String(body.note || '').trim().slice(0, 300),
        ownerId: SELF_ID,
        ownerName: user().displayName,
        category,
        categoryName: bpCatName(category),
        visibility: ['public', 'friends', 'private'].includes(String(body.visibility || '')) ? String(body.visibility) : 'public',
        treeCategoryName: treeCat ? treeCat.name : '',
        sourceNodeId: root.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        size: files.reduce((sum, f) => sum + (f.size || 0), 0),
        nodes: nodes.map(n => ({
          id: n.id, name: n.name, cost: n.cost, unlocked: n.unlocked, kind: n.kind,
          parentId: n.parentId, prereqIds: n.prereqIds || [], note: n.note || '',
        })),
        files,
        images,
      };
      Object.assign(bp, scoreBlueprint(bp));
      d.blueprints.push(bp);
      save();
      return json({ ok: true, blueprint: bp }, 201);
    }

    const bpMatch = p.match(/^\/api\/blueprints\/([^/]+)(?:\/(import|refresh))?$/);
    if (bpMatch) {
      const bp = d.blueprints.find(x => x.id === bpMatch[1]);
      if (!bp) return fail(404, '蓝图不存在');
      const action = bpMatch[2] || '';

      if (method === 'GET' && !action) {
        if (!canSeeBp(bp)) return fail(403, '这个蓝图只对作者可见');
        const sc = scoreBlueprint(bp);
        return json({
          blueprint: {
            id: bp.id, title: bp.title, note: bp.note, ownerName: bp.ownerName,
            mine: bp.ownerId === SELF_ID, category: bp.category, categoryName: bp.categoryName,
            visibility: bp.visibility || 'public', visibilityName: bpVisibilityName(bp.visibility || 'public'),
            sourceNodeId: bp.sourceNodeId || '', score: sc.score, scoreParts: sc.parts,
            belowThreshold: false, createdAt: bp.createdAt, updatedAt: bp.updatedAt || bp.createdAt,
            size: bp.size || 0,
            nodes: (bp.nodes || []).map(n => ({ id: n.id, name: n.name, kind: n.kind, cost: n.cost, parentId: n.parentId || null, prereqIds: n.prereqIds || [] })),
            files: (bp.files || []).map(f => ({ name: f.name, size: f.size })),
            images: (bp.images || []).map(img => ({ id: img.id, name: img.name, size: img.size, mime: img.mime })),
          },
        });
      }

      if (method === 'PUT' && !action) {
        if (bp.ownerId !== SELF_ID) return fail(403, '只能编辑自己发布的蓝图');
        let body;
        try { body = JSON.parse(await bodyText(init) || '{}'); }
        catch (e) { return fail(400, '请求格式有误'); }
        if (body.title !== undefined) {
          const title = String(body.title || '').trim().slice(0, 40);
          if (!title) return fail(400, '标题不能为空');
          bp.title = title;
        }
        if (body.note !== undefined) bp.note = String(body.note || '').trim().slice(0, 300);
        if (body.category !== undefined) {
          if (!BP_CATS.some(c => c.id === String(body.category))) return fail(400, '分类不合法');
          bp.category = String(body.category);
          bp.categoryName = bpCatName(bp.category);
        }
        if (body.visibility !== undefined) {
          if (!['public', 'friends', 'private'].includes(String(body.visibility))) return fail(400, '可见性不合法');
          bp.visibility = String(body.visibility);
        }
        if (body.images !== undefined) bp.images = await applyBpImages(bp.id, bp.images, body.images);
        bp.updatedAt = Date.now();
        Object.assign(bp, scoreBlueprint(bp));
        save();
        return json({ ok: true, blueprint: bp });
      }

      if (action === 'refresh' && method === 'POST') {
        if (bp.ownerId !== SELF_ID) return fail(403, '只能更新自己发布的蓝图');
        if (!bp.sourceNodeId) return fail(400, '这个蓝图没有记录来源节点，不能自动同步。');
        const root = d.tree.abilities.find(a => a.id === bp.sourceNodeId);
        if (!root) return fail(404, '原来的父级已经被删除或改名，无法同步内容。');
        const nodes = subtreeNodes(d.tree, root.id);
        const nodeIds = new Set(nodes.map(n => n.id));
        const sourceFiles = (d.tree.files || []).filter(f => nodeIds.has(f.nodeId));
        for (const f of bp.files || []) {
          if (f.storedAs) { try { await delBlob('bpnotes', f.storedAs); } catch (e) { /* ignore */ } }
        }
        bp.nodes = nodes.map(n => ({
          id: n.id, name: n.name, cost: n.cost, unlocked: n.unlocked, kind: n.kind,
          parentId: n.parentId, prereqIds: n.prereqIds || [], note: n.note || '',
        }));
        bp.files = await packageBpFiles(bp.id, sourceFiles);
        bp.size = bp.files.reduce((sum, f) => sum + (f.size || 0), 0);
        bp.updatedAt = Date.now();
        Object.assign(bp, scoreBlueprint(bp));
        save();
        return json({ ok: true, nodeCount: bp.nodes.length, fileCount: bp.files.length, size: bp.size, updatedAt: bp.updatedAt });
      }

      if (action === 'import' && method === 'POST') {
        if (!canSeeBp(bp)) return fail(403, '这个蓝图只对作者可见');
        let body = {};
        try { body = JSON.parse(await bodyText(init) || '{}'); } catch (e) { /* ignore */ }
        const tree = d.tree;
        const cat = tree.categories.find(c => c.id === String(body.categoryId || ''))
          || tree.categories.find(c => c.name === bp.categoryName)
          || tree.categories[0];
        const bpInSet = new Set((bp.nodes || []).map(n => n.id));
        const kidsOf = new Map();
        (bp.nodes || []).forEach(n => {
          if (!n.parentId || !bpInSet.has(n.parentId)) return;
          if (!kidsOf.has(n.parentId)) kidsOf.set(n.parentId, []);
          kidsOf.get(n.parentId).push(n);
        });
        const roots = (bp.nodes || []).filter(n => !n.parentId || n.id === bp.sourceNodeId);
        const kept = [];
        const keptIds = new Set();
        const stack = roots.slice();
        while (stack.length) {
          const n = stack.pop();
          if (!n || keptIds.has(n.id)) continue;
          keptIds.add(n.id);
          kept.push(n);
          (kidsOf.get(n.id) || []).forEach(k => stack.push(k));
        }
        if (!kept.length) return fail(400, '这个蓝图的数据不完整（找不到有效的根节点），导入不了');
        const idMap = {};
        kept.forEach(n => { idMap[n.id] = makeId('a'); });
        const nodes = kept.map(n => ({
          id: idMap[n.id], name: n.name, cost: n.cost, unlocked: false, kind: n.kind,
          parentId: n.parentId ? (idMap[n.parentId] || null) : null,
          prereqIds: (n.prereqIds || []).map(x => idMap[x]).filter(Boolean),
          categoryId: n.parentId ? null : cat.id,
          ox: 0, oy: 0, note: n.note || '', photos: [],
        }));
        const files = [];
        for (const f of bp.files || []) {
          const newNodeId = idMap[f.nodeId];
          if (!newNodeId) continue;
          const newStoredAs = `${makeId('f')}-${f.name}`;
          let blob = null;
          if (f.storedAs) { try { blob = await getBlob('bpnotes', f.storedAs); } catch (e) { blob = null; } }
          if (blob) { try { await putBlob('notes', newStoredAs, blob); } catch (e) { /* ignore */ } }
          files.push({
            id: makeId('f'), nodeId: newNodeId, name: f.name, mime: f.mime,
            size: f.size, storedAs: blob ? newStoredAs : '', local: false, createdAt: Date.now(),
          });
        }
        tree.abilities = tree.abilities.concat(nodes);
        tree.files = (tree.files || []).concat(files);
        save();
        return json({ ok: true, tree, added: nodes.length, categoryId: cat.id });
      }

      if (method === 'DELETE' && !action) {
        if (bp.ownerId !== SELF_ID) return fail(403, '只能删除自己发布的蓝图');
        await deleteBpAssets(bp);
        d.blueprints = d.blueprints.filter(x => x.id !== bp.id);
        save();
        return json({ ok: true });
      }
    }

    // 演示版未启用的功能
    if (p === '/api/friends' && method === 'GET') return json({ friends: [], incoming: [], outgoing: [] });
    if (p.startsWith('/api/friends')) return fail(403, '演示版暂不支持好友功能');
    if (p === '/api/users' && method === 'GET') return json({ users: [] });
    if (p.startsWith('/api/chat/')) return method === 'GET' ? json({ messages: [] }) : fail(403, '演示版暂不支持聊天');
    if (p === '/api/feedback' && method === 'GET') return json({ feedback: [] });
    if (p.startsWith('/api/feedback')) return fail(403, '演示版暂不支持意见反馈');
    if (p.startsWith('/api/admin')) return fail(403, '演示版未启用管理后台');

    return fail(404, '演示版未实现该接口');
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    const url = new URL(raw, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      try {
        return await handle(url, init || {});
      } catch (e) {
        console.error('[demo]', e);
        return fail(503, '本地演示服务异常');
      }
    }
    return nativeFetch(input, init);
  };

  function patchUi() {
    const reset = document.getElementById('demoReset');
    if (reset && !reset.dataset.bound) {
      reset.dataset.bound = '1';
      reset.addEventListener('click', () => {
        if (confirm('重置演示数据？当前修改、笔记与照片会恢复为初始示例。')) resetDemo();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    patchUi();
    setTimeout(patchUi, 150);
  });
})();
