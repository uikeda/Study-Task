const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/schedule.js');

// 2026-10-29 は木曜（4）
const schedule = [
  { id: 'a', start: '19:00', end: '20:00', taskId: 't1', label: '英単語', days: [1, 2, 3, 4, 5] },
  { id: 'b', start: '07:00', end: '07:30', taskId: 't2', label: '計算', days: [0, 1, 2, 3, 4, 5, 6] },
  { id: 'c', start: '20:30', end: '21:30', label: '模試の復習', date: '2026-10-29' },
  { id: 'd', start: '10:00', end: '12:00', label: '週末の演習', days: [0, 6] },
];

test('blocksOn は曜日と日付指定のコマを開始時刻順に返す', () => {
  assert.deepEqual(S.blocksOn(schedule, '2026-10-29').map((b) => b.id), ['b', 'a', 'c']);
  assert.deepEqual(S.blocksOn(schedule, '2026-10-31').map((b) => b.id), ['b', 'd']);
});

test('nowAndNext は今のコマと次のコマを返す', () => {
  let r = S.nowAndNext(schedule, '2026-10-29', '19:15');
  assert.equal(r.current.id, 'a');
  assert.equal(r.next.id, 'c');
  r = S.nowAndNext(schedule, '2026-10-29', '20:00'); // 終了時刻ちょうどは含まない
  assert.equal(r.current, null);
  assert.equal(r.next.id, 'c');
  r = S.nowAndNext(schedule, '2026-10-29', '22:00');
  assert.equal(r.current, null);
  assert.equal(r.next, null);
});

test('overlaps は同じ日に入りうるコマとの時間の重なりを見つける', () => {
  assert.deepEqual(S.overlaps(schedule, { id: 'x', start: '19:30', end: '20:45', days: [4] }).map((b) => b.id), ['a', 'c']);
  assert.deepEqual(S.overlaps(schedule, { id: 'x', start: '19:30', end: '20:45', days: [6] }), []);
  assert.deepEqual(S.overlaps(schedule, { id: 'x', start: '11:00', end: '11:30', date: '2026-11-01' }).map((b) => b.id), ['d']);
  assert.deepEqual(S.overlaps(schedule, { ...schedule[0] }), []); // 自分自身は除く
  assert.deepEqual(S.overlaps(schedule, { id: 'x', start: '20:00', end: '20:30', days: [4] }), []); // 接しているだけなら重ならない
});

test('validate は時刻・内容・曜日をチェックする', () => {
  assert.equal(S.validate({ start: '09:00', end: '10:00', label: 'x', days: [1] }), null);
  assert.match(S.validate({ start: '10:00', end: '09:00', label: 'x', days: [1] }), /終了は開始より後/);
  assert.match(S.validate({ start: '', end: '09:00', label: 'x', days: [1] }), /時刻/);
  assert.match(S.validate({ start: '09:00', end: '10:00', label: '', days: [1] }), /タスクを選ぶ/);
  assert.match(S.validate({ start: '09:00', end: '10:00', label: 'x', days: [] }), /曜日/);
  assert.equal(S.validate({ start: '09:00', end: '10:00', taskId: 't1', label: '', date: '2026-10-29' }), null);
});

test('toMinutes と fromMinutes は相互に変換できる', () => {
  assert.equal(S.toMinutes('07:05'), 425);
  assert.equal(S.fromMinutes(425), '07:05');
});
