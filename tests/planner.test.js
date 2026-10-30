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

test('completedOn は累計が全体量に達した日を返す', () => {
  const task = makeTask({ total: 10 });
  assert.equal(P.completedOn(task, { '2026-10-02': { t1: 4 }, '2026-10-03': { t1: 6 }, '2026-10-04': { t1: 1 } }), '2026-10-03');
  assert.equal(P.completedOn(task, { '2026-10-02': { t1: 4 } }), null);
  assert.equal(P.completedOn(makeTask({ total: 10, initialDone: 10 }), {}), null);
});

test('reviewSummary は復習を回数順に並べ、最後の復習からの経過日数を出す', () => {
  const source = makeTask({ id: 'src', total: 10, initialDone: 0 });
  const r1 = makeTask({ id: 'r1', total: 10, tags: ['復習'], reviewOf: 'src', startDate: '2026-10-05' });
  const r2 = makeTask({ id: 'r2', total: 10, tags: ['復習'], reviewOf: 'src', startDate: '2026-10-12', deadline: '2026-10-20' });
  const other = makeTask({ id: 'x', tags: ['復習'], reviewOf: 'zzz' });
  const logs = {
    '2026-10-03': { src: 10 },
    '2026-10-08': { r1: 10 },
    '2026-10-13': { r2: 4 },
  };
  const s = P.reviewSummary(source, [r2, other, source, r1], logs, '2026-10-15');
  assert.deepEqual(s.reviews.map((r) => [r.task.id, r.round, r.status]), [['r1', 1, 'done'], ['r2', 2, 'ahead']]);
  assert.equal(s.completedCount, 1);
  assert.equal(s.active.task.id, 'r2');
  assert.equal(s.lastReviewedOn, '2026-10-08');
  assert.equal(s.daysSince, 7);

  // 復習がまだない場合は、元のタスクを終えた日からの日数
  const none = P.reviewSummary(source, [source], logs, '2026-10-15');
  assert.equal(none.reviews.length, 0);
  assert.equal(none.daysSince, 12);
});

test('dayAchievement はその日の時点の記録でノルマを計算し、後の記録に影響されない', () => {
  const task = makeTask();
  const logs = { '2026-10-01': { t1: 10 }, '2026-10-02': { t1: 5 }, '2026-10-05': { t1: 50 } };
  const d1 = P.dayAchievement([task], logs, '2026-10-01');
  assert.equal(d1.rate, 1);
  assert.equal(d1.cleared, 1);
  const d2 = P.dayAchievement([task], logs, '2026-10-02');
  assert.equal(d2.items[0].quota, 10);
  assert.equal(d2.rate, 0.5);
  assert.equal(d2.cleared, 0);
});

test('dayAchievement はタスクごとの達成率を平均し、ノルマのない日は rate が null', () => {
  const a = makeTask();
  const b = makeTask({ id: 't2', unit: '語', total: 1000 });
  const day = P.dayAchievement([a, b], { '2026-10-01': { t1: 20, t2: 0 } }, '2026-10-01');
  assert.equal(day.rate, 0.5); // a は 100%（超過分は数えない）、b は 0%
  assert.equal(day.count, 2);
  assert.equal(P.dayAchievement([a], {}, '2026-09-30').rate, null);
});

test('dayAchievement は登録日より前の日を評価に含めない', () => {
  const task = makeTask({ createdAt: '2026-10-03T12:00:00' });
  assert.equal(P.dayAchievement([task], {}, '2026-10-02').count, 0);
  assert.equal(P.dayAchievement([task], {}, '2026-10-03').count, 1);
});

test('achievementSeries は古い順に指定日数分を返す', () => {
  const s = P.achievementSeries([makeTask()], {}, '2026-10-03', 3);
  assert.deepEqual(s.map((d) => d.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('streak はノルマのない日を飛ばして連続達成日数を数え、今日が途中なら昨日までを数える', () => {
  // 土曜（10/3, 10/10）は学習日でない。80 を 8 学習日で割って 1日 10
  const task = makeTask({ total: 80, studyDays: [0, 1, 2, 3, 4, 5] });
  const logs = { '2026-10-01': { t1: 10 }, '2026-10-02': { t1: 10 }, '2026-10-04': { t1: 10 } };
  assert.equal(P.streak([task], logs, '2026-10-05'), 3);
  assert.equal(P.streak([task], { ...logs, '2026-10-05': { t1: 10 } }, '2026-10-05'), 4);
  assert.equal(P.streak([task], { ...logs, '2026-10-04': { t1: 5 } }, '2026-10-05'), 0); // 昨日が未達成なら途切れる
  assert.equal(P.streak([], {}, '2026-10-05'), 0);
});

test('expectedDone は計画どおりなら終えているはずの量を返す', () => {
  const task = makeTask({ initialDone: 20 });
  assert.equal(P.expectedDone(task, '2026-09-30'), 20);
  assert.equal(P.expectedDone(task, '2026-10-01'), 20);
  assert.equal(P.expectedDone(task, '2026-10-06'), 60); // 5 学習日経過: 20 + 80 * 5/10
  assert.equal(P.expectedDone(task, '2026-10-11'), 100);
});

// 10/29（木）時点の例: 月〜土、240問、10/20〜11/15。昨日までに 50問、今日 5問
function behindTask() {
  return makeTask({ id: 'm', total: 240, startDate: '2026-10-20', deadline: '2026-11-15', studyDays: [1, 2, 3, 4, 5, 6] });
}
function behindLogs() {
  const logs = {};
  [['10-20', 4], ['10-21', 6], ['10-22', 9], ['10-23', 5], ['10-24', 8], ['10-26', 7], ['10-27', 6], ['10-28', 5], ['10-29', 5]]
    .forEach(([d, n]) => { logs[`2026-${d}`] = { m: n }; });
  return logs;
}

test('recentPace は今日を含まない直近の学習日あたりの実績を返す', () => {
  const r = P.recentPace(behindTask(), behindLogs(), '2026-10-29');
  assert.equal(r.days, 7); // 10/21〜10/28 のうち日曜を除く7日
  assert.equal(r.pace, 46 / 7);
  assert.equal(P.recentPace(behindTask(), behindLogs(), '2026-10-20'), null);
  // 学習日以外にやった分も数える
  const logs = { ...behindLogs(), '2026-10-25': { m: 7 } };
  assert.equal(P.recentPace(behindTask(), logs, '2026-10-29').pace, 53 / 7);
});

test('projectFinish は最近のペースで終わる日と期限からの遅れを返す', () => {
  const p = P.projectFinish(behindTask(), behindLogs(), '2026-10-29');
  // 残り185問 ÷ 6.57問 → 29学習日。今日は記録済みなので明日（10/30）から数える
  assert.equal(p.date, '2026-12-02');
  assert.equal(p.delay, 17);
  assert.equal(p.sampleDays, 7);
  assert.deepEqual(P.projectFinish(makeTask(), { '2026-10-01': { t1: 100 } }, '2026-10-02'), { done: true });
  assert.equal(P.projectFinish(behindTask(), {}, '2026-10-29').date, null); // 記録がなくペースが 0
});

test('recoveryOptions は期限・学習日・量を変えた案と、それぞれの1日の量を返す', () => {
  const opts = P.recoveryOptions(behindTask(), behindLogs(), '2026-10-29');
  const by = Object.fromEntries(opts.map((o) => [o.id, o]));
  assert.deepEqual(opts.map((o) => o.id), ['pace', 'extend', 'everyday', 'reduce', 'keep']);
  assert.deepEqual(by.pace.changes, { deadline: '2026-12-02' });
  assert.ok(by.pace.perDay < 7);
  assert.deepEqual(by.extend.changes, { deadline: '2026-11-22' });
  assert.equal(by.extend.perDay, 190 / 21);
  assert.equal(by.everyday.perDay, 190 / 18);
  assert.equal(by.reduce.changes.total, 50 + Math.floor((46 / 7) * 15)); // 最近のペースで期限までに終わる量
  assert.equal(by.keep.perDay, 190 / 15);
});

test('recoveryOptions は期限切れのタスクに「このまま」を出さず、今日から1週間延ばす案を出す', () => {
  const task = { ...behindTask(), deadline: '2026-10-27' };
  const opts = P.recoveryOptions(task, behindLogs(), '2026-10-29');
  assert.ok(!opts.some((o) => o.id === 'keep' || o.id === 'everyday' || o.id === 'reduce'));
  assert.ok(opts.some((o) => o.id === 'extend' && o.changes.deadline === '2026-11-05'));
});

test('isUnrecordedDay はノルマがあって記録が一つもない日だけ true', () => {
  const task = makeTask();
  assert.equal(P.isUnrecordedDay([task], {}, '2026-10-02'), true);
  assert.equal(P.isUnrecordedDay([task], { '2026-10-02': { t1: 3 } }, '2026-10-02'), false);
  assert.equal(P.isUnrecordedDay([task], {}, '2026-09-30'), false); // 開始前
});
