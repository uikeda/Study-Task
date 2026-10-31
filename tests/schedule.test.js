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

// 10/29（木）の例: 朝 7:00–7:20、夕方 16:30–17:30、19:00–20:00、20:15–20:45、21:00–21:30
const day = [
  { id: 'k', start: '07:00', end: '07:20', label: '古文' },
  { id: 'c', start: '16:30', end: '17:30', label: '化学' },
  { id: 'm', start: '19:00', end: '20:00', label: '数学' },
  { id: 'e', start: '20:15', end: '20:45', label: '英単語' },
  { id: 'h', start: '21:00', end: '21:30', label: '課題' },
];

test('dayLayout はコマのある時間帯を区間にし、2時間以上の空きをたたむ', () => {
  const rows = S.dayLayout(day);
  assert.deepEqual(rows.map((r) => [r.type, S.fromMinutes(r.from), S.fromMinutes(r.to)]), [
    ['segment', '07:00', '08:00'],
    ['gap', '07:20', '16:30'], // 実際に空いている時間で表す
    ['segment', '16:00', '22:00'], // 18時台（1時間だけの空き）はたたまない
  ]);
  const evening = rows[2];
  assert.equal(evening.height, 6 * 60 * 1.5);
  assert.deepEqual(evening.hours.map((h) => h.label), ['16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00']);
  const math = evening.items.find((x) => x.block.id === 'm');
  assert.equal(math.top, 180 * 1.5);
  assert.equal(math.height, 60 * 1.5);
  assert.deepEqual(evening.free.map((f) => [S.fromMinutes(f.from), S.fromMinutes(f.to)]), [['17:30', '19:00'], ['20:00', '20:15'], ['20:45', '21:00']]);
});

test('dayLayout は今の時刻の時間帯も区間に含め、今の線の位置を返す', () => {
  const rows = S.dayLayout(day, { nowMin: S.toMinutes('12:10') });
  assert.deepEqual(rows.map((r) => r.type), ['segment', 'gap', 'segment', 'gap', 'segment']);
  assert.equal(rows[2].from, 12 * 60);
  assert.equal(rows[2].now, 10 * 1.5);
  assert.equal(rows[0].now, null);
  assert.deepEqual([S.fromMinutes(rows[1].from), S.fromMinutes(rows[1].to)], ['07:20', '12:00']);
});

test('dayLayout は重なるコマを横に並べ、短いコマにも最低限の高さを付ける', () => {
  const rows = S.dayLayout([
    { id: 'a', start: '19:00', end: '20:00' },
    { id: 'b', start: '19:30', end: '20:30' },
    { id: 'c', start: '20:00', end: '20:05' },
    { id: 'd', start: '21:00', end: '21:30' },
  ]);
  const by = Object.fromEntries(rows[0].items.map((x) => [x.block.id, x]));
  assert.deepEqual([by.a.lane, by.b.lane, by.c.lane], [0, 1, 0]); // c は a の終わった列に入る
  assert.deepEqual([by.a.lanes, by.b.lanes, by.c.lanes], [2, 2, 2]);
  assert.equal(by.d.lanes, 1);
  assert.equal(by.c.height, 22);
});

test('dayLayout はコマが無ければ空の配列を返す', () => {
  assert.deepEqual(S.dayLayout([]), []);
});

test('formatDuration は時間と分で表す', () => {
  assert.equal(S.formatDuration(20), '20分');
  assert.equal(S.formatDuration(60), '1時間');
  assert.equal(S.formatDuration(550), '9時間10分');
});

test('assignSubjectColors は保存済みの色を保ち、空いた番号を新しい科目に渡す', () => {
  assert.deepEqual(S.assignSubjectColors(['数学', '英語', '数学', ''], {}, 4), { 数学: 0, 英語: 1 });
  // 国語がなくなり、物理が増えた: 英語の色は変わらず、物理は空いた 0 番を使う
  assert.deepEqual(S.assignSubjectColors(['英語', '物理'], { 国語: 0, 英語: 1 }, 4), { 英語: 1, 物理: 0 });
  // 番号が足りない科目には割り当てない
  assert.deepEqual(S.assignSubjectColors(['a', 'b', 'c'], {}, 2), { a: 0, b: 1 });
});
