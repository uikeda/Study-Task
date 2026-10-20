const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../planner.js');

const task = (over = {}) => ({
  id: 't', title: 'x', unit: 'ページ', total: 100,
  startDate: '2026-10-01', deadline: '2026-10-10', logs: {}, ...over,
});

test('diffDays / countStudyDays', () => {
  assert.equal(P.diffDays('2026-10-01', '2026-10-10'), 9);
  assert.equal(P.countStudyDays('2026-10-01', '2026-10-10', []), 10);
  // 10/3(土), 10/4(日), 10/10(土) を除くと 7 日
  assert.equal(P.countStudyDays('2026-10-01', '2026-10-10', [0, 6]), 7);
  assert.equal(P.countStudyDays('2026-10-11', '2026-10-10', []), 0);
});

test('quota: 残量を残り学習日で割り切り上げ', () => {
  assert.equal(P.quotaFor(task(), '2026-10-01', []), 10);
  const t = task({ logs: { '2026-10-01': 5 } });
  // 10/2 開始時点で残り95、残り9日 → 11
  assert.equal(P.quotaFor(t, '2026-10-02', []), 11);
});

test('quota: 当日の記録ではノルマは変わらない', () => {
  const t = task({ logs: { '2026-10-01': 30 } });
  assert.equal(P.quotaFor(t, '2026-10-01', []), 10);
});

test('quota: 休息日は0、期限超過は残り全部、完了は0', () => {
  assert.equal(P.quotaFor(task(), '2026-10-04', [0]), 0);
  assert.equal(P.quotaFor(task({ logs: { '2026-10-05': 40 } }), '2026-10-12', []), 60);
  assert.equal(P.quotaFor(task({ logs: { '2026-10-05': 100 } }), '2026-10-06', []), 0);
  assert.equal(P.quotaFor(task(), '2026-09-30', []), 0);
});

test('quota: 期限日が休息曜日でも期限日は残りを課す', () => {
  // 2026-10-10 は土曜
  const t = task({ logs: { '2026-10-01': 90 } });
  assert.equal(P.quotaFor(t, '2026-10-10', [6]), 10);
});

test('paceStatus', () => {
  assert.equal(P.paceStatus(task(), '2026-10-01', []).status, 'ontrack');
  assert.equal(P.paceStatus(task(), '2026-10-04', []).status, 'behind');
  assert.equal(P.paceStatus(task({ logs: { '2026-10-01': 50 } }), '2026-10-03', []).status, 'ahead');
  assert.equal(P.paceStatus(task({ logs: { '2026-10-01': 20 } }), '2026-10-03', []).status, 'ontrack');
  assert.equal(P.paceStatus(task(), '2026-10-11', []).status, 'overdue');
  assert.equal(P.paceStatus(task({ logs: { '2026-10-01': 100 } }), '2026-10-11', []).status, 'done');
});

test('forecast の合計は残量と一致する', () => {
  const t = task({ logs: { '2026-10-01': 7 } });
  const f = P.forecast(t, '2026-10-02', 9, []);
  assert.equal(f.reduce((s, d) => s + d.amount, 0), 93);
  assert.ok(f.every((d) => d.amount >= 0));
});

test('sortByPriority: 遅れているタスクが先', () => {
  const late = task({ id: 'late', deadline: '2026-10-20' });
  const fine = task({ id: 'fine', deadline: '2026-10-08', logs: { '2026-10-01': 60 } });
  const sorted = P.sortByPriority([fine, late], '2026-10-05', []);
  assert.equal(sorted[0].id, 'late');
});

test('initialDone は開始前の完了量として扱う', () => {
  const t = task({ initialDone: 50 });
  assert.equal(P.quotaFor(t, '2026-10-01', []), 5);
  assert.equal(P.doneTotal(t), 50);
  assert.equal(P.paceStatus(t, '2026-10-03', []).status, 'behind');
  assert.equal(P.paceStatus({ ...t, logs: { '2026-10-01': 10 } }, '2026-10-03', []).status, 'ontrack');
});
