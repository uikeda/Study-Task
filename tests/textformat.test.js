const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/planner.js');
const T = require('../js/textformat.js');

const TODAY = '2026-10-22';

function sampleState() {
  return {
    tasks: [
      {
        id: 'a1',
        title: '青チャート数IA',
        subject: '数学',
        total: 240,
        unit: '問',
        initialDone: 0,
        startDate: '2026-10-20',
        deadline: '2026-11-15',
        studyDays: [1, 2, 3, 4, 5, 6],
      },
      {
        id: 'b2',
        title: '英単語',
        subject: '',
        total: 1900,
        unit: '語',
        initialDone: 300,
        startDate: '2026-10-20',
        deadline: '2026-11-30',
        studyDays: [0, 1, 2, 3, 4, 5, 6],
      },
    ],
    logs: { '2026-10-21': { a1: 10 }, '2026-10-22': { b2: 5 } },
  };
}

let counter = 0;
const newId = () => `new${++counter}`;

test('書き出したテキストをそのまま読み込むと変更なし', () => {
  const state = sampleState();
  const text = T.serialize(state, TODAY);
  const parsed = T.parse(text, TODAY);
  assert.deepEqual(parsed.errors, []);
  const { state: next, changes } = T.applyImport(state, parsed, TODAY, newId);
  assert.deepEqual(changes, { added: [], updated: [], removed: [], unchanged: 2 });
  assert.deepEqual(next, state);
});

test('書き出しに済・曜日・状況が含まれる', () => {
  const text = T.serialize(sampleState(), TODAY);
  assert.match(text, /## 青チャート数IA\n- id: a1\n- 科目: 数学\n- 量: 240 問\n- 済: 10\n/);
  assert.match(text, /- 曜日: 月火水木金土/);
  assert.match(text, /- 曜日: 毎日/);
  assert.match(text, /- 状況: /);
});

test('Claude が書いたような表記ゆれのあるテキストを読み込める', () => {
  const text = `計画を作りました。

## 化学 重要問題集
* 科目：化学
- 量: ６０問
- 期限: 2026-11-10
- 曜日: 平日

## 古文単語
- 量: 1,200 語
- 済: 100語
- 開始: 2026-10-25
- 期限: 2026-12-20
- 曜日: 月・水・金`;
  const { tasks, errors } = T.parse(text, TODAY);
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0], {
    title: '化学 重要問題集',
    subject: '化学',
    total: 60,
    unit: '問',
    deadline: '2026-11-10',
    studyDays: [1, 2, 3, 4, 5],
    startDate: TODAY,
    done: 0,
  });
  assert.equal(tasks[1].total, 1200);
  assert.equal(tasks[1].done, 100);
  assert.deepEqual(tasks[1].studyDays, [1, 3, 5]);
});

test('不正な値は行番号付きのエラーになる', () => {
  const text = `## A
- 量: たくさん
- 期限: 2026/11/01
- 曜日: 月曜と金曜

## B
- 量: 10 問
- 済: 20
- 開始: 2026-11-05
- 期限: 2026-11-01`;
  const { errors } = T.parse(text, TODAY);
  const messages = errors.map((e) => e.message).join('\n');
  assert.match(messages, /「量」は/);
  assert.match(messages, /「期限」は YYYY-MM-DD/);
  assert.match(messages, /「曜日」が読み取れません/);
  assert.match(messages, /「B」: 期限が開始日より前/);
  assert.match(messages, /「B」: 「済」が全体量を超えています/);
  assert.equal(errors[0].line, 2);
});

test('追加・更新・削除が反映され、削除したタスクの記録も消える', () => {
  const state = sampleState();
  const text = `## 青チャート数IA（改）
- id: a1
- 科目: 数学
- 量: 200 問
- 済: 10
- 開始: 2026-10-20
- 期限: 2026-11-20
- 曜日: 毎日

## 新しいタスク
- 量: 30 ページ
- 期限: 2026-11-01`;
  const { state: next, changes } = T.applyImport(state, T.parse(text, TODAY), TODAY, newId);
  assert.deepEqual(changes.updated, ['青チャート数IA（改）']);
  assert.deepEqual(changes.added, ['新しいタスク']);
  assert.deepEqual(changes.removed, ['英単語']);
  const a1 = next.tasks.find((t) => t.id === 'a1');
  assert.equal(a1.total, 200);
  assert.equal(a1.deadline, '2026-11-20');
  assert.equal(next.tasks.length, 2);
  assert.deepEqual(next.logs, { '2026-10-21': { a1: 10 } });
  // 元の state は変更されない
  assert.equal(state.tasks[0].total, 240);
});

test('済の増加は今日の実績、減少は補正として反映される', () => {
  const state = sampleState();
  const up = T.serialize(state, TODAY).replace('- 済: 10', '- 済: 25');
  const r1 = T.applyImport(state, T.parse(up, TODAY), TODAY, newId);
  assert.equal(r1.state.logs[TODAY].a1, 15);
  assert.equal(P.totalDone(r1.state.tasks[0], r1.state.logs), 25);

  const down = T.serialize(state, TODAY).replace('- 済: 10', '- 済: 4');
  const r2 = T.applyImport(state, T.parse(down, TODAY), TODAY, newId);
  const a1 = r2.state.tasks.find((t) => t.id === 'a1');
  assert.equal(a1.adjust, -6);
  assert.equal(P.totalDone(a1, r2.state.logs), 4);
  // 補正しても当初ペース（遅れ判定の基準）は変わらない
  const before = P.analyzeTask(state.tasks[0], state.logs, TODAY);
  const after = P.analyzeTask(a1, r2.state.logs, TODAY);
  assert.equal(after.originalPace, before.originalPace);
});

test('id が重複しているとエラー', () => {
  const text = '## A\n- id: x\n- 量: 1 問\n- 期限: 2026-11-01\n\n## B\n- id: x\n- 量: 1 問\n- 期限: 2026-11-01';
  assert.match(T.parse(text, TODAY).errors[0].message, /重複/);
});

test('計画づくりプロンプトに今日の日付が入り、出力例がそのまま読み込める', () => {
  const prompt = T.planningPrompt(TODAY);
  assert.match(prompt, /今日は 2026-10-22 です/);
  const example = prompt.match(/```\n([\s\S]*?)```/)[1];
  const { tasks, errors } = T.parse(example, TODAY);
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].deadline, '2026-11-21');
  assert.equal(tasks[1].done, 300);
});

test('返信を丸ごと貼り付けても、コードブロックの中だけを読む', () => {
  const reply = `計画を立てました。

## 方針
- 量: 多め

\`\`\`markdown
## 化学 重要問題集
- 量: 60 問
- 期限: 2026-11-10
\`\`\`

## 補足
平日は1日1時間です。`;
  const { tasks, errors } = T.parse(reply, TODAY);
  assert.deepEqual(errors, []);
  assert.deepEqual(tasks.map((t) => t.title), ['化学 重要問題集']);
});

test('テキストの読み込みで試験・模試の予定は消えない', () => {
  const state = { ...sampleState(), events: [{ id: 'e1', title: '模試', date: '2026-11-01', kind: 'mock' }] };
  const { state: next } = T.applyImport(state, T.parse(T.serialize(state, TODAY), TODAY), TODAY, newId);
  assert.deepEqual(next.events, state.events);
});

test('復習タグと復習元を書き出し、読み込むと元のタスクにひも付く', () => {
  const state = sampleState();
  state.tasks.push({
    id: 'r1', title: '青チャート 復習1回目', subject: '数学', total: 240, unit: '問', initialDone: 0,
    startDate: '2026-10-22', deadline: '2026-11-05', studyDays: [0, 1, 2, 3, 4, 5, 6], tags: ['復習'], reviewOf: 'a1',
  });
  const text = T.serialize(state, TODAY);
  assert.match(text, /## 青チャート 復習1回目\n[\s\S]*?- タグ: 復習\n- 復習元: 青チャート数IA\n/);

  // そのまま読み込めば変更なし
  const same = T.applyImport(state, T.parse(text, TODAY), TODAY, newId);
  assert.equal(same.changes.unchanged, 3);
  const byId = (a, b) => a.id.localeCompare(b.id);
  assert.deepEqual([...same.state.tasks].sort(byId), [...state.tasks].sort(byId));

  // チャットで新しい復習タスクを足した場合（元のタスク名で指定）
  const added = `${text}
## 英単語 復習1回目
- 量: 1900 語
- 期限: 2026-11-30
- タグ: 復習
- 復習元: 英単語`;
  const r = T.applyImport(state, T.parse(added, TODAY), TODAY, newId);
  const t = r.state.tasks.find((x) => x.title === '英単語 復習1回目');
  assert.deepEqual(t.tags, ['復習']);
  assert.equal(t.reviewOf, 'b2');
  assert.deepEqual(r.changes.added, ['英単語 復習1回目']);
});

test('タグを消すと復習タスクではなくなり、変更として数える', () => {
  const state = sampleState();
  state.tasks[1] = { ...state.tasks[1], tags: ['復習'], reviewOf: 'a1' };
  const text = T.serialize(state, TODAY).replace('- タグ: 復習\n- 復習元: 青チャート数IA\n', '');
  const r = T.applyImport(state, T.parse(text, TODAY), TODAY, newId);
  assert.deepEqual(r.changes.updated, ['英単語']);
  const b2 = r.state.tasks.find((x) => x.id === 'b2');
  assert.equal(b2.tags, undefined);
  assert.equal(b2.reviewOf, undefined);
});
