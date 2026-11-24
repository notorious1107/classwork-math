import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/app.mjs';
import { solution, generateQuestions, formatExpression } from '../backend/store.mjs';
import { practiceOptions } from '../backend/questions.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'classwork-phase3-'));
  let current = Date.parse('2026-11-24T11:00:00Z'), app;
  const start = async () => {
    app = await createApp({ dbPath: join(dir, 'test.sqlite'), clock: () => current });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  };
  const stop = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  const request = async (path, cookie, method = 'GET', data) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async username => {
    const result = await request('/login', null, 'POST', { username, password: username === 'teacher' ? 'Teacher123!' : 'Student123!' });
    assert.equal(result.status, 200); return result.cookie;
  };
  await start();
  try {
    const teacher = await login('teacher');
    const student = async (username, classId) => {
      const made = await request('/students', teacher, 'POST', { username, name: username, password: 'Student123!', ...(classId === undefined ? {} : { classId }) });
      assert.equal(made.status, 201); return { ...made.body, cookie: await login(username) };
    };
    await run({ request, login, teacher, student, db: () => app.db, time: value => { current = Date.parse(value); }, restart: async () => { await stop(); await start(); } });
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
}

test('个人限时：独立起点、幂等开始、全班截止取较早者及重启恢复', async () => {
  await fixture(async ({ request, teacher, student, time, restart }) => {
    const lin = await student('lin'), zhou = await student('zhou');
    for (const value of [0, -1, 1.5, 1441, '20', true]) assert.equal((await request('/assignments', teacher, 'POST', { title: '非法限时', timeLimitMinutes: value })).status, 400);
    const work = (await request('/assignments', teacher, 'POST', { title: '20 分钟', timeLimitMinutes: 20 })).body;
    const path = `/assignments/${work.id}`, answers = work.questions.map(solution);
    const before = (await request(path, lin.cookie)).body;
    assert.equal(before.startedAt, null); assert.deepEqual(before.questions, []); assert.deepEqual(before.expressions, []);
    assert.equal((await request(path + '/draft', lin.cookie, 'PUT', { answers })).status, 400);
    assert.equal((await request(path + '/start', teacher, 'POST', {})).status, 403);
    const starts = await Promise.all([request(path + '/start', lin.cookie, 'POST', {}), request(path + '/start', lin.cookie, 'POST', {})]);
    for (const result of starts) { assert.equal(result.status, 200); assert.equal(result.body.startedAt, '2026-11-24T11:00:00.000Z'); assert.equal(result.body.effectiveDueAt, '2026-11-24T11:20:00.000Z'); }
    time('2026-11-24T11:10:00Z');
    const later = (await request(path + '/start', zhou.cookie, 'POST', {})).body;
    assert.equal(later.effectiveDueAt, '2026-11-24T11:30:00.000Z');
    assert.equal((await request(path + '/start', lin.cookie, 'POST', {})).body.effectiveDueAt, '2026-11-24T11:20:00.000Z');
    const partial = answers.map((v, i) => i < 4 ? v : null);
    assert.equal((await request(path + '/draft', lin.cookie, 'PUT', { answers: partial })).status, 200);
    await restart();
    assert.deepEqual((await request(path, lin.cookie)).body.answers, partial);
    time('2026-11-24T11:20:00Z');
    assert.equal((await request(path + '/submit', lin.cookie, 'POST', { answers, startedAt: '2099-01-01' })).status, 409);
    assert.equal((await request(path + '/draft', lin.cookie, 'PUT', { answers })).status, 200);
    assert.equal((await request(path, lin.cookie)).body.submittedAt, null);
    assert.equal((await request(path + '/submit', zhou.cookie, 'POST', { answers })).body.score, 100);
    const report = (await request(path + '/report', teacher)).body;
    assert.equal(report.pending, 1); assert.equal(report.average, 100);
    time('2026-11-24T11:00:00Z');
    const limited = (await request('/assignments', teacher, 'POST', { title: '全班19:25', timeLimitMinutes: 20, dueAt: '2026-11-24T19:25+08:00' })).body;
    time('2026-11-24T11:10:00Z');
    const limitedPath = `/assignments/${limited.id}`;
    assert.equal((await request(limitedPath + '/start', zhou.cookie, 'POST', {})).body.effectiveDueAt, '2026-11-24T11:25:00.000Z');
    time('2026-11-24T11:25:00Z');
    assert.equal((await request(limitedPath + '/submit', zhou.cookie, 'POST', { answers: limited.questions.map(solution) })).status, 409);
    assert.equal((await request(limitedPath + '/start', lin.cookie, 'POST', {})).status, 409);
    assert.equal((await request(path + '/submit', zhou.cookie, 'POST', { answers })).body.score, 100);
  });
});

test('知识点生成：基础2步、提高3步，整除范围与每一步实际运算', () => {
  const inspect = q => {
    if (typeof q === 'number') { assert.ok(Number.isInteger(q) && q > 0 && q <= 100); return { answer: q, steps: 0 }; }
    const a = inspect(q.a), b = inspect(q.b);
    if (q.op === '*') { assert.ok(a.answer > 1); assert.ok(b.answer > 1); }
    if (q.op === '/') { assert.ok(b.answer > 1); assert.ok(a.answer > b.answer); assert.equal(a.answer % b.answer, 0); }
    const answer = q.op === '+' ? a.answer + b.answer : q.op === '-' ? a.answer - b.answer : q.op === '*' ? a.answer * b.answer : a.answer / b.answer;
    assert.ok(Number.isInteger(answer) && answer > 0 && answer <= 100);
    return { answer, steps: a.steps + b.steps + 1 };
  };
  for (const topic of practiceOptions.topics) for (const difficulty of ['basic', 'advanced']) for (const count of [10, 20, 50]) {
    for (let round = 0; round < 5; round++) {
      const questions = generateQuestions('mixed-100', count, { grade: topic.minGrade, knowledgePoints: [topic.id], difficulty });
      assert.equal(questions.length, count); assert.equal(new Set(questions.map(q => JSON.stringify(q))).size, count);
      for (const q of questions) {
        const checked = inspect(q); assert.equal(checked.steps, difficulty === 'basic' ? 2 : 3); assert.equal(checked.answer, solution(q));
        const expression = formatExpression(q);
        if (topic.id === 'parentheses') assert.match(expression, /\(/);
        else assert.doesNotMatch(expression, /\(/);
        if (topic.id === 'precedence') { assert.match(expression, /[×÷]/); assert.match(expression, /[＋−]/); }
        if (topic.id === 'add-sub-chain') assert.doesNotMatch(expression, /[×÷]/);
        if (topic.id === 'mul-div-chain') assert.doesNotMatch(expression, /[＋−]/);
      }
    }
  }
});

test('混合题配置经API校验并持久保存，年级知识点与难度可回看', async () => {
  await fixture(async ({ request, teacher, restart }) => {
    const catalog = await request('/practice-options', teacher); assert.equal(catalog.status, 200);
    for (const input of [{ grade: 0 }, { grade: '3' }, { knowledgePoints: [] }, { knowledgePoints: ['unknown'] }, { grade: 1, knowledgePoints: ['parentheses'] }, { knowledgePoints: ['precedence', 'precedence'] }, { difficulty: null }, { difficulty: 'hard' }]) {
      assert.equal((await request('/assignments', teacher, 'POST', { title: '无效配置', category: 'mixed-100', ...input })).status, 400);
    }
    const created = await request('/assignments', teacher, 'POST', { title: '提高括号', category: 'mixed-100', grade: 3, knowledgePoints: ['parentheses'], difficulty: 'advanced', questionCount: 50 });
    assert.equal(created.status, 201); const a = created.body;
    assert.equal(a.grade, 3); assert.equal(a.difficulty, 'advanced'); assert.deepEqual(a.knowledgePoints, ['parentheses']);
    await restart();
    const restored = (await request(`/assignments/${a.id}`, teacher)).body;
    assert.deepEqual(restored, a);
  });
});
