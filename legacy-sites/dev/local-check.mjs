import { createTechTree } from '../functions/tech.mjs';
import { createFakeDb } from './fake-db.mjs';

class BackendError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const requireUser = (ctx) => {
  if (!ctx.user) throw new BackendError('login_required', 401);
  return ctx.user;
};

const handler = createTechTree({ db: createFakeDb(), requireUser, BackendError });

async function call(userId, method, action, body) {
  const request = new Request('https://site.test/functions/v1/app?action=' + action, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await handler({ request, user: userId ? { id: userId } : null });
  return { status: response.status, body: await response.json() };
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ` → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
  if (!ok) failures += 1;
}

const A = 'user-a';
const B = 'user-b';

let r = await call(A, 'GET', 'state');
check('初始读到 10 点、空列表', r.body, { state: { points: 10, skills: [] } });

r = await call(A, 'POST', 'skills', { name: 'JavaScript', cost: 3 });
check('添加 JavaScript', { status: r.status, points: r.body.state.points, count: r.body.state.skills.length },
  { status: 200, points: 10, count: 1 });
const jsId = r.body.state.skills[0].id;

r = await call(A, 'POST', 'light', { id: jsId });
check('点亮后余额 7', { status: r.status, points: r.body.state.points, lit: r.body.state.skills[0].lit },
  { status: 200, points: 7, lit: true });

r = await call(A, 'POST', 'light', { id: jsId });
check('重复点亮不重复扣点', { points: r.body.state.points }, { points: 7 });

r = await call(A, 'POST', 'skills', { name: 'React', cost: 8 });
const reactId = r.body.state.skills.find((s) => s.name === 'React').id;
r = await call(A, 'POST', 'light', { id: reactId });
check('余额不足返回 409', { status: r.status, error: r.body.error }, { status: 409, error: 'insufficient_points' });

r = await call(A, 'GET', 'state');
check('刷新后状态保留', { points: r.body.state.points, lit: r.body.state.skills[0].lit, count: r.body.state.skills.length },
  { points: 7, lit: true, count: 2 });

r = await call(B, 'GET', 'state');
check('另一个用户看不到 A 的数据', r.body, { state: { points: 10, skills: [] } });

r = await call(A, 'POST', 'skills', { name: 'X', cost: 0 });
check('成本 0 被拒绝', { status: r.status, error: r.body.error }, { status: 400, error: 'invalid_input' });

r = await call(A, 'POST', 'skills', { name: '   ', cost: 2 });
check('空名称被拒绝', { status: r.status, error: r.body.error }, { status: 400, error: 'invalid_input' });

r = await call(A, 'GET', 'skills');
check('GET 写接口返回 405', r.status, 405);

r = await call(A, 'GET', 'unknown');
check('未知 action 返回 404', r.status, 404);

r = await call(null, 'GET', 'state');
check('未登录返回 401', r.status, 401);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
