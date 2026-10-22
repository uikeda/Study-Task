const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/planner.js');

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function makeTask(overrides = {}) {
  return {
    id: 't1',
    title: '問題集',
    unit: 'ページ',
    total: 100,
    initialDone: 0,
    startDate: '2026-10-01',
    deadline: '2026-10-10',
    studyDays: ALL_DAYS,
    ...overrides,
  };
}

test('distribute は合計が残量と一致し、端数を前倒しする', () => {
  const plan = P.distribute(10, ['a', 'b', 'c']);
  assert.deepEqual(plan, { a: 4, b: 3, c: 3 });
});

test('均等に進めた場合のノルマ', () => {
  const r = P.analyzeTask(makeTask(), {}, '2026-10-01');
  assert.equal(r.quota, 10);
  assert.equal(r.studyDaysLeft, 10);
  assert.equal(r.status, 'onTrack');
});

test('今日の記録でノルマ自体は変わらず、残りノルマが減る', () => {
  const logs = { '2026-10-01': { t1: 4 } };
  const r = P.analyzeTask(makeTask(), logs, '2026-10-01');
  assert.equal(r.quota, 10);
  assert.equal(r.quotaLeft, 6);
  assert.equal(r.done, 4);
});

test('遅れると翌日以降のノルマが増え、遅れ判定になる', () => {
  // 5日間何もせず 10/6 を迎えた: 残り100を5日で
  const r = P.analyzeTask(makeTask(), {}, '2026-10-06');
  assert.equal(r.quota, 20);
  assert.equal(r.status, 'behind');
});

test('先に進めるとノルマが減り、先行判定になる', () => {
  const logs = { '2026-10-01': { t1: 50 } };
  const r = P.analyzeTask(makeTask(), logs, '2026-10-02');
  assert.equal(r.quota, 6); // 残り50を9日 → ceil(50/9)
  assert.equal(r.status, 'ahead');
});

test('学習日以外はノルマ0、学習日のみに配分する', () => {
  // 2026-10-03 は土曜、10-04 は日曜。平日のみ。
  const task = makeTask({ studyDays: [1, 2, 3, 4, 5] });
  assert.equal(P.analyzeTask(task, {}, '2026-10-03').quota, 0);
  const days = P.studyDaysBetween(task, '2026-10-01', '2026-10-10');
  assert.equal(days.length, 7);
});

test('期限切れ・完了・開始前の判定', () => {
  assert.equal(P.analyzeTask(makeTask(), {}, '2026-10-11').status, 'overdue');
  assert.equal(P.analyzeTask(makeTask({ initialDone: 100 }), {}, '2026-10-05').status, 'done');
  assert.equal(P.analyzeTask(makeTask(), {}, '2026-09-30').status, 'notStarted');
});

test('期限までに学習日がない場合は残り全量がノルマ', () => {
  // 期限当日が土曜で平日のみ学習
  const task = makeTask({ deadline: '2026-10-03', studyDays: [1, 2, 3, 4, 5] });
  const r = P.analyzeTask(task, {}, '2026-10-03');
  assert.equal(r.quota, 100);
  assert.equal(r.status, 'behind');
});

test('forecast は計画どおり進めた場合の配分を返す', () => {
  const f = P.forecast(makeTask(), {}, '2026-10-08', 5);
  assert.deepEqual(f, {
    '2026-10-08': 34,
    '2026-10-09': 33,
    '2026-10-10': 33,
    '2026-10-11': 0,
    '2026-10-12': 0,
  });
});

test('月をまたぐ日付計算', () => {
  assert.equal(P.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(P.diffDays('2026-12-30', '2027-01-02'), 3);
});

test('dailyAmounts は過去=実績、今日=ノルマ、未来=予定量を返す', () => {
  const logs = { '2026-10-03': { t1: 7 } };
  const r = P.dailyAmounts(makeTask(), logs, '2026-10-04', '2026-10-02', '2026-10-05');
  assert.deepEqual(r['2026-10-02'], { type: 'done', amount: 0 });
  assert.deepEqual(r['2026-10-03'], { type: 'done', amount: 7 });
  // 残り93を10/4〜10/10の7日に配分 → 14,13,13,...
  assert.deepEqual(r['2026-10-04'], { type: 'today', amount: 14, done: 0 });
  assert.deepEqual(r['2026-10-05'], { type: 'plan', amount: 13 });
});

test('upcomingEvents は過ぎた予定を除き、近い順に残り日数を付ける', () => {
  const events = [
    { id: 'a', title: '共通テスト', date: '2027-01-16' },
    { id: 'b', title: '模試', date: '2026-11-01' },
    { id: 'c', title: '終わった模試', date: '2026-10-01' },
  ];
  const r = P.upcomingEvents(events, '2026-10-22');
  assert.deepEqual(r.map((e) => [e.id, e.daysLeft]), [['b', 10], ['a', 86]]);
});
