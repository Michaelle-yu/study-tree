const DEFAULT_POINTS = 10;
const MAX_NAME_LENGTH = 30;
const MAX_COST = 100000;
const MAX_SKILLS = 200;
const MAX_BODY_BYTES = 8192;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (value, status = 200, extra = {}) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'private, no-store', ...extra },
  });

const isSkill = (skill) =>
  skill &&
  typeof skill.id === 'string' &&
  UUID_RE.test(skill.id) &&
  typeof skill.name === 'string' &&
  skill.name.length > 0 &&
  Number.isInteger(skill.cost) &&
  skill.cost > 0 &&
  typeof skill.lit === 'boolean';

const normalize = (row) => ({
  points: Number.isInteger(row.points) && row.points >= 0 ? row.points : DEFAULT_POINTS,
  skills: Array.isArray(row.skills) ? row.skills.filter(isSkill) : [],
});

const view = (state) => ({
  points: state.points,
  skills: state.skills.map(({ id, name, cost, lit }) => ({ id, name, cost, lit })),
});

export function createTechTree({ db, requireUser, BackendError }) {
  const fail = (code, status) => {
    throw new BackendError(code, status);
  };

  async function readState(userId) {
    const result = await db
      .from('tech_state')
      .select('points,skills')
      .eq('user_id', userId)
      .limit(1);
    if (result.error || !Array.isArray(result.data)) fail('state_unavailable', 503);
    const row = result.data[0];
    return row ? normalize(row) : null;
  }

  async function ensureState(userId) {
    const existing = await readState(userId);
    if (existing) return existing;
    const created = await db
      .from('tech_state')
      .insertIfAbsent(
        { user_id: userId, points: DEFAULT_POINTS, skills: [], updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      )
      .select('user_id');
    if (created.error) fail('write_result_unknown', 503);
    const state = await readState(userId);
    if (!state) fail('write_result_unknown', 503);
    return state;
  }

  async function persist(userId, state) {
    const updated = await db
      .from('tech_state')
      .update({
        points: state.points,
        skills: state.skills,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('points,skills');
    if (updated.error) {
      const rejected = [400, 401, 403, 409, 422].includes(updated.error.status);
      fail(rejected ? 'write_rejected' : 'write_result_unknown', 503);
    }
    const row = Array.isArray(updated.data) ? updated.data[0] : undefined;
    if (!row) fail('write_rejected', 503);
    return normalize(row);
  }

  async function readJson(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      fail('invalid_input', 415);
    }
    const reader = request.body?.getReader();
    if (!reader) fail('invalid_input', 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          fail('payload_too_large', 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      fail('invalid_input', 400);
    }
  }

  return async function handle(ctx) {
    const { request } = ctx;
    const action = new URL(request.url).searchParams.get('action');
    if (action !== 'state' && action !== 'skills' && action !== 'light') {
      return json({ error: 'not_found' }, 404);
    }
    const allowed = action === 'state' ? 'GET' : 'POST';
    if (request.method !== allowed) {
      return json({ error: 'method_not_allowed' }, 405, { allow: allowed });
    }

    try {
      const user = requireUser(ctx);
      let state;

      if (action === 'state') {
        state = (await readState(user.id)) || { points: DEFAULT_POINTS, skills: [] };
      } else if (action === 'skills') {
        const body = await readJson(request);
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const cost = body?.cost;
        if (!name || name.length > MAX_NAME_LENGTH || !Number.isInteger(cost) || cost < 1 || cost > MAX_COST) {
          fail('invalid_input', 400);
        }
        state = await ensureState(user.id);
        if (state.skills.length >= MAX_SKILLS) fail('too_many_skills', 409);
        state.skills = state.skills.concat({ id: crypto.randomUUID(), name, cost, lit: false });
        state = await persist(user.id, state);
      } else {
        const body = await readJson(request);
        if (typeof body?.id !== 'string' || !UUID_RE.test(body.id)) fail('invalid_input', 400);
        state = await ensureState(user.id);
        const skill = state.skills.find((item) => item.id === body.id);
        if (!skill) fail('skill_not_found', 404);
        if (!skill.lit) {
          if (state.points < skill.cost) fail('insufficient_points', 409);
          state.points -= skill.cost;
          skill.lit = true;
          state = await persist(user.id, state);
        }
      }

      return json({ state: view(state) });
    } catch (error) {
      if (error instanceof BackendError) {
        return json({ error: error.code }, error.status);
      }
      return json({ error: 'service_unavailable' }, 503);
    }
  };
}
