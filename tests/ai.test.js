const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../js/ai.js');

const TODAY = '2026-10-29';
const state = {
  tasks: [{ id: 'a1', title: '青チャート', subject: '数学', total: 240, unit: '問', initialDone: 0, startDate: '2026-10-20', deadline: '2026-11-15', studyDays: [1, 2, 3, 4, 5, 6] }],
  logs: {},
};
const history = [{ role: 'user', content: '数学をもう少し増やしたい' }];

test('buildRequest は今の計画と書式をシステムプロンプトに入れる', () => {
  const p = AI.buildRequest({ model: 'claude-opus-5-5', history, state, today: TODAY });
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.messages, history);
  assert.match(p.system, /- id: a1/);
  assert.match(p.system, /今日は 2026-10-29 です/);
  assert.match(p.system, /コードブロックに書かなかった既存タスクはアプリから削除されます/);
  assert.deepEqual(p.output_config, { effort: 'medium' });
});

test('buildRequest は Opus と Sonnet に断られたときのフォールバックを付け、Haiku には付けない', () => {
  const opus = AI.buildRequest({ model: 'claude-opus-5-5', history, state, today: TODAY });
  assert.equal(opus.fallbacks, 'default');
  assert.deepEqual(opus.betas, ['server-side-fallback-2026-07-01']);
  const haiku = AI.buildRequest({ model: 'claude-haiku-5-5', history, state, today: TODAY });
  assert.equal(haiku.fallbacks, undefined);
  assert.equal(haiku.betas, undefined);
});

test('buildRequest はタスクが無いときもその旨を伝え、モデル未指定なら既定のモデルを使う', () => {
  const p = AI.buildRequest({ history, state: { tasks: [], logs: {} }, today: TODAY });
  assert.equal(p.model, AI.DEFAULT_MODEL);
  assert.match(p.system, /まだタスクは登録されていません/);
});

test('replyText は text ブロックだけをつなげる', () => {
  const message = { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'こんにちは' }, { type: 'text', text: '計画です' }] };
  assert.equal(AI.replyText(message), 'こんにちは\n\n計画です');
});

test('hasPlan は ## 見出しを含むコードブロックがあるときだけ true', () => {
  assert.equal(AI.hasPlan('案です\n```\n## 英単語\n- 量: 100 語\n- 期限: 2026-11-30\n```'), true);
  assert.equal(AI.hasPlan('```js\nconsole.log(1)\n```'), false);
  assert.equal(AI.hasPlan('教材を教えてください。'), false);
});
