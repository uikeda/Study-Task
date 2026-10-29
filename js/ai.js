// Claude API に直接プロンプトを送り、計画の相談をするための処理。
// リクエストの組み立て（buildRequest）は純粋関数、送信（send）はブラウザで SDK を読み込んで行う。
// ブラウザでは window.AI、Node では module.exports として使う。
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const TF = isNode ? require('./textformat.js') : root.TextFormat;

  // SDK はビルドなしで使えるよう CDN の ESM 版を、送信時に初めて読み込む
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.134.0/+esm';

  const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（高性能）' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（バランス）' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（安い・速い）' },
  ];
  const DEFAULT_MODEL = MODELS[0].id;

  // 安全上の理由で断られたときに別のモデルで続けるサーバー側の仕組み。Haiku には無い
  const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

  function systemPrompt(state, today) {
    const current = state.tasks.length
      ? `# 現在の計画（アプリに登録済み）
${TF.serialize(state, today)}`
      : '# 現在の計画\nまだタスクは登録されていません。';

    return `${TF.planningRules(today)}
# アプリとの連携
- あなたの返信はアプリ「Study Task」の画面に表示されます。計画を含むコードブロックは、ユーザーが確認してからアプリに取り込みます。
- 情報が足りないときは、計画を出す前に質問してください。質問や相談への回答だけで計画を変えない返信には、コードブロックを書かないでください。
- 計画を出すときは、変更しないタスクも含めて計画全体を1つのコードブロックに書いてください。コードブロックに書かなかった既存タスクはアプリから削除されます。
- 既存のタスクは「- id: 」の行をそのまま残してください（id が無いと別のタスクとして追加されます）。「済」は現在の値のまま書き、ユーザーが進めた量を伝えたときだけ増やしてください。
- 「状況」の行は参考情報なので、出力には書かなくてかまいません。

${current}`;
  }

  // Messages API に渡すパラメータ。history は [{ role, content }]（assistant の content は API の返したブロックのまま）
  function buildRequest({ model, history, state, today }) {
    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      system: systemPrompt(state, today),
      messages: history,
    };
    if (FALLBACK_MODELS.includes(params.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    return params;
  }

  // 返信の本文（text ブロック）だけをつなげる
  function replyText(message) {
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
  }

  // 返信に、アプリに取り込める計画（## 見出しを含むコードブロック）があるか
  function hasPlan(text) {
    return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].some((m) => /^\s*##\s/m.test(m[1]));
  }

  let sdkPromise = null;
  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = import(SDK_URL).catch((err) => {
        sdkPromise = null;
        throw err;
      });
    }
    return sdkPromise;
  }

  // 送信して { message, text } を返す。失敗時は画面に出せる日本語のメッセージを持つ Error を投げる
  async function send({ apiKey, model, history, state, today }) {
    let Anthropic;
    try {
      Anthropic = (await loadSdk()).default;
    } catch (err) {
      throw new Error('Claude の SDK を読み込めませんでした。インターネット接続を確認してください。');
    }
    // API キーは利用者自身のもので、このブラウザから直接 Anthropic に送る
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    let message;
    try {
      message = await client.beta.messages.create(buildRequest({ model, history, state, today }));
    } catch (err) {
      throw new Error(errorMessage(Anthropic, err));
    }
    if (message.stop_reason === 'refusal') {
      throw new Error('この内容には回答できないと判断されました。言い方を変えて送ってください。');
    }
    const text = replyText(message);
    if (message.stop_reason === 'max_tokens') {
      return { message, text: `${text}\n\n（返信が長すぎて途中で切れました。「続きを書いて」と送るか、範囲を絞って頼んでください）` };
    }
    return { message, text };
  }

  function errorMessage(Anthropic, err) {
    if (err instanceof Anthropic.AuthenticationError) return 'API キーが正しくありません。設定を確認してください。';
    if (err instanceof Anthropic.PermissionDeniedError) return 'この API キーではこのモデルを使えません。';
    if (err instanceof Anthropic.RateLimitError) return '利用の上限に達しました。少し待ってから送ってください。';
    if (err instanceof Anthropic.BadRequestError) return `リクエストが受け付けられませんでした: ${err.message}`;
    if (err instanceof Anthropic.APIConnectionError) return 'Anthropic に接続できませんでした。インターネット接続を確認してください。';
    if (err instanceof Anthropic.APIError) return `エラーが発生しました（${err.status ?? '不明'}）: ${err.message}`;
    return `エラーが発生しました: ${err.message}`;
  }

  const AI = { MODELS, DEFAULT_MODEL, SDK_URL, systemPrompt, buildRequest, replyText, hasPlan, send };

  if (isNode) module.exports = AI;
  else root.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
