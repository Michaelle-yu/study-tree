import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceDir = root;
const source = fs.readFileSync(path.join(sourceDir, 'index.html'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'tools', 'site-demo-shim-v2.js'), 'utf8');
const seed = fs.readFileSync(path.join(root, 'tools', 'demo-seed-clone.json'), 'utf8');

const demoStyle = `
/* 站点演示版 */
.demo-flag{position:fixed;left:12px;bottom:12px;z-index:80;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 12px;border-radius:999px;background:rgba(8,14,24,.94);border:1px solid rgba(245,185,66,.35);color:#ffe6a6;font-size:12px;box-shadow:0 12px 34px rgba(0,0,0,.5);backdrop-filter:blur(10px)}
.demo-flag button{padding:3px 9px;border-radius:999px;border:1px solid rgba(245,185,66,.35);background:rgba(245,185,66,.08);color:#ffe6a6;font-size:11px;cursor:pointer}
.demo-flag button:hover{background:rgba(245,185,66,.16)}
#btn-feedback,[data-sheet-act="btn-feedback"]{display:none!important}
@media (max-width:760px){.demo-flag{left:8px;bottom:8px;font-size:11px;padding:6px 7px 6px 10px}}
`;

const demoMarkup = `
<div class="demo-flag" role="note">
  <span>演示版 · 数据仅存本机</span>
  <button id="demoReset" type="button">重置</button>
</div>
`;

let output = source;
output = output.replace('<title>学习树 · 能力与知识点画布</title>', '<title>学习树 · 演示版</title>');
output = output.replace(
  '<meta name="color-scheme" content="dark">',
  '<meta name="color-scheme" content="dark">\n<meta name="description" content="把要学的东西画成一棵树：能力、知识点、课表与笔记的浏览器演示版。">',
);
output = output.replace('</style>', demoStyle + '\n</style>');
output = output.replace('<div class="auth" id="auth" hidden>', demoMarkup + '\n<div class="auth" id="auth" hidden>');

const scriptIndex = output.lastIndexOf('<script>');
if (scriptIndex < 0) throw new Error('未找到主脚本入口');
const injected = `<script>\n${shim.replace('__SEED_TREE__', seed)}\n</script>\n\n`;
output = output.slice(0, scriptIndex) + injected + output.slice(scriptIndex);

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'index.html'), output);
console.log(`dist/index.html written (${Buffer.byteLength(output)} bytes)`);
