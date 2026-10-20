// 学習計画の計算ロジック（DOM非依存。ブラウザでは window.Planner、Node では module.exports）
(function (root) {
  'use strict';

  // ---- 日付ユーティリティ（ローカル日付を "YYYY-MM-DD" 文字列で扱う） ----
  function toKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(key, n) {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return toKey(d);
  }

  // DST の影響を受けないよう UTC で日数差を求める
  function diffDays(fromKey, toKeyStr) {
    const [y1, m1, d1] = fromKey.split('-').map(Number);
    const [y2, m2, d2] = toKeyStr.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }

  function weekday(key) {
    return parseKey(key).getDay();
  }

  // from〜to（両端含む）のうち休息曜日を除いた学習日数
  function countStudyDays(fromKey, toKeyStr, restDays) {
    if (fromKey > toKeyStr) return 0;
    const rest = new Set(restDays || []);
    let count = 0;
    for (let k = fromKey; k <= toKeyStr; k = addDays(k, 1)) {
      if (!rest.has(weekday(k))) count++;
    }
    return count;
  }

  function isStudyDay(key, restDays) {
    return !(restDays || []).includes(weekday(key));
  }

  // ---- 進捗集計 ----
  function sumLogs(task, predicate) {
    let s = 0;
    for (const [k, v] of Object.entries(task.logs || {})) {
      if (!predicate || predicate(k)) s += Number(v) || 0;
    }
    return s;
  }

  // initialDone はタスク登録時点で既に終わっていた量
  function doneTotal(task) {
    return (Number(task.initialDone) || 0) + sumLogs(task);
  }

  function doneBefore(task, dayKey) {
    return (Number(task.initialDone) || 0) + sumLogs(task, (k) => k < dayKey);
  }

  function doneOn(task, dayKey) {
    return Number((task.logs || {})[dayKey]) || 0;
  }

  // ---- 1日のノルマ計算 ----
  // 「その日の開始時点の残量」を「その日〜期限の学習日数」で割る。
  // 当日に記録してもノルマ自体は変わらない（達成度だけが変わる）ようにするため。
  function quotaFor(task, dayKey, restDays) {
    if (dayKey < task.startDate) return 0;
    const remaining = Math.max(0, task.total - doneBefore(task, dayKey));
    if (remaining === 0) return 0;
    if (dayKey > task.deadline) return remaining; // 期限超過：残り全部
    if (!isStudyDay(dayKey, restDays) && dayKey !== task.deadline) return 0;
    const days = Math.max(1, countStudyDays(dayKey, task.deadline, restDays));
    return Math.ceil(remaining / days);
  }

  // 理想ペース（開始日〜期限を学習日で均等割り）に対する前日終了時点の差
  function paceStatus(task, todayKey, restDays) {
    const done = doneBefore(task, todayKey);
    if (doneTotal(task) >= task.total) return { status: 'done', diff: 0, expected: task.total };
    if (todayKey > task.deadline) return { status: 'overdue', diff: done - task.total, expected: task.total };
    if (todayKey <= task.startDate) return { status: 'ontrack', diff: 0, expected: 0 };

    const allDays = Math.max(1, countStudyDays(task.startDate, task.deadline, restDays));
    const elapsed = countStudyDays(task.startDate, addDays(todayKey, -1), restDays);
    const base = Number(task.initialDone) || 0;
    const expected = base + ((task.total - base) * elapsed) / allDays;
    const diff = done - expected;
    // 1日分の理想量の半分以上の差を「遅れ／先行」とみなす
    const tolerance = (task.total - base) / allDays / 2;
    let status = 'ontrack';
    if (diff < -tolerance) status = 'behind';
    else if (diff > tolerance) status = 'ahead';
    return { status, diff, expected };
  }

  // 今後 n 日間の見込みノルマ（各日のノルマを達成し続けた場合）
  function forecast(task, fromKey, n, restDays) {
    const result = [];
    // 今日の記録はノルマ消化として扱い、未達分は明日以降に再配分される
    let remaining = Math.max(0, task.total - doneBefore(task, fromKey));
    for (let i = 0; i < n; i++) {
      const key = addDays(fromKey, i);
      let q = 0;
      if (remaining > 0 && key >= task.startDate) {
        if (key > task.deadline) q = remaining;
        else if (isStudyDay(key, restDays) || key === task.deadline) {
          q = Math.ceil(remaining / Math.max(1, countStudyDays(key, task.deadline, restDays)));
        }
      }
      if (i === 0) {
        // 今日は実績が上回っていれば実績分を消化
        q = Math.min(remaining, Math.max(q, doneOn(task, key)));
      }
      result.push({ date: key, amount: q });
      remaining -= q;
    }
    return result;
  }

  // 今日やるべき順：期限超過 → 遅れ → 期限が近い
  function priorityScore(task, todayKey, restDays) {
    const pace = paceStatus(task, todayKey, restDays);
    const daysLeft = diffDays(todayKey, task.deadline);
    let score = daysLeft;
    if (pace.status === 'overdue') score -= 10000;
    else if (pace.status === 'behind') score -= 1000;
    if (pace.status === 'done') score += 100000;
    return score;
  }

  function sortByPriority(tasks, todayKey, restDays) {
    return [...tasks].sort(
      (a, b) => priorityScore(a, todayKey, restDays) - priorityScore(b, todayKey, restDays)
    );
  }

  const Planner = {
    toKey, parseKey, addDays, diffDays, weekday, countStudyDays, isStudyDay,
    doneTotal, doneBefore, doneOn, quotaFor, paceStatus, forecast,
    priorityScore, sortByPriority,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Planner;
  else root.Planner = Planner;
})(typeof window !== 'undefined' ? window : globalThis);
