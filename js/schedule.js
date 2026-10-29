// 時間割（どの時間にどのタスクをやるか）の計算ロジック（DOM に依存しない純粋関数のみ）。
// ブラウザでは window.Schedule、Node では module.exports として使う。
//
// 時間割の1コマ: { id, start: 'HH:MM', end: 'HH:MM', taskId?, label, days?: [曜日番号], date?: 'YYYY-MM-DD' }
// days があれば毎週その曜日、date があればその日だけ。label はタスクを消したときの表示用の名前。
(function (root) {
  'use strict';

  const P = typeof module !== 'undefined' && module.exports ? require('./planner.js') : root.Planner;

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function fromMinutes(min) {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }

  function isValidTime(str) {
    return typeof str === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
  }

  function appliesOn(block, date) {
    if (block.date) return block.date === date;
    return (block.days || []).includes(P.parseDate(date).getDay());
  }

  // その日のコマを開始時刻順に
  function blocksOn(schedule, date) {
    return schedule
      .filter((b) => appliesOn(b, date))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }

  // 今やっているコマ（current）と、次のコマ（next）。時刻は 'HH:MM'
  function nowAndNext(schedule, date, time) {
    const now = toMinutes(time);
    const blocks = blocksOn(schedule, date);
    const current = blocks.find((b) => toMinutes(b.start) <= now && now < toMinutes(b.end)) || null;
    const next = blocks.find((b) => toMinutes(b.start) > now) || null;
    return { current, next, blocks };
  }

  // 2つのコマが同じ日に入りうるか
  function shareDay(a, b) {
    if (a.date && b.date) return a.date === b.date;
    if (a.date) return (b.days || []).includes(P.parseDate(a.date).getDay());
    if (b.date) return (a.days || []).includes(P.parseDate(b.date).getDay());
    return (a.days || []).some((d) => (b.days || []).includes(d));
  }

  // candidate と時間が重なるコマ（candidate 自身は除く）
  function overlaps(schedule, candidate) {
    const s = toMinutes(candidate.start);
    const e = toMinutes(candidate.end);
    return schedule.filter((b) => b.id !== candidate.id && shareDay(b, candidate)
      && toMinutes(b.start) < e && s < toMinutes(b.end));
  }

  // 入力チェック。問題がなければ null
  function validate(block) {
    if (!isValidTime(block.start) || !isValidTime(block.end)) return '開始と終了の時刻を入力してください。';
    if (toMinutes(block.end) <= toMinutes(block.start)) return '終了は開始より後の時刻にしてください（日付をまたぐコマは2つに分けてください）。';
    if (!block.taskId && !block.label) return 'タスクを選ぶか、内容を入力してください。';
    if (!block.date && !(block.days && block.days.length)) return '曜日を1つ以上選ぶか、「この日だけ」にしてください。';
    return null;
  }

  const Schedule = { toMinutes, fromMinutes, isValidTime, appliesOn, blocksOn, nowAndNext, overlaps, validate };

  if (typeof module !== 'undefined' && module.exports) module.exports = Schedule;
  else root.Schedule = Schedule;
})(typeof window !== 'undefined' ? window : globalThis);
