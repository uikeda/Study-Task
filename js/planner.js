// 学習計画の計算ロジック（DOM に依存しない純粋関数のみ）。
// ブラウザでは window.Planner、Node では module.exports として使う。
(function (root) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;

  // 'YYYY-MM-DD' <-> ローカル日付。タイムゾーンのずれを避けるため正午で扱う。
  function parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(str, n) {
    const date = parseDate(str);
    date.setDate(date.getDate() + n);
    return formatDate(date);
  }

  function diffDays(from, to) {
    return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
  }

  function isStudyDay(task, dateStr) {
    return task.studyDays.includes(parseDate(dateStr).getDay());
  }

  // from〜to（両端含む）のうち学習日の一覧
  function studyDaysBetween(task, from, to) {
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (isStudyDay(task, d)) days.push(d);
    }
    return days;
  }

  // date より前（date 当日を含まない）までの累計実績
  function doneBefore(task, logs, date) {
    let sum = task.initialDone || 0;
    for (const [d, entries] of Object.entries(logs)) {
      if (d < date && entries[task.id]) sum += entries[task.id];
    }
    return sum;
  }

  function doneOn(task, logs, date) {
    return (logs[date] && logs[date][task.id]) || 0;
  }

  function totalDone(task, logs) {
    let sum = task.initialDone || 0;
    for (const entries of Object.values(logs)) {
      if (entries[task.id]) sum += entries[task.id];
    }
    return sum;
  }

  // 残量 remaining を学習日 days に均等配分する。端数は前倒し（早い日に多く）。
  function distribute(remaining, days) {
    const n = days.length;
    const plan = {};
    let prev = 0;
    days.forEach((d, i) => {
      const cumulative = Math.ceil((remaining * (i + 1)) / n);
      plan[d] = cumulative - prev;
      prev = cumulative;
    });
    return plan;
  }

  // 指定日（通常は今日）時点でのタスクの状態と今日のノルマを求める。
  // ノルマは「今日の開始時点の残量」から計算するので、今日記録しても目標値は変わらない。
  function analyzeTask(task, logs, today) {
    const total = task.total;
    const done = totalDone(task, logs);
    const doneToday = doneOn(task, logs, today);
    const remainingAtStart = Math.max(0, total - doneBefore(task, logs, today));
    const remaining = Math.max(0, total - done);

    const base = {
      done,
      doneToday,
      remaining,
      progress: total > 0 ? Math.min(1, done / total) : 1,
      quota: 0,
      quotaLeft: 0,
      studyDaysLeft: 0,
      daysToDeadline: diffDays(today, task.deadline),
    };

    if (remaining === 0) return { ...base, status: 'done' };
    if (today > task.deadline) return { ...base, status: 'overdue' };
    if (today < task.startDate) {
      return { ...base, status: 'notStarted', studyDaysLeft: studyDaysBetween(task, task.startDate, task.deadline).length };
    }

    const days = studyDaysBetween(task, today, task.deadline);
    let quota;
    if (days.length === 0) {
      // 期限までに学習日が残っていない場合は、残り全部を今日のノルマにする
      quota = remainingAtStart;
    } else if (!isStudyDay(task, today)) {
      quota = 0;
    } else {
      quota = distribute(remainingAtStart, days)[today];
    }

    // 計画当初の1日あたりペースと、現在必要なペースを比べて遅れを判定する
    const originalDays = studyDaysBetween(task, task.startDate, task.deadline).length || 1;
    const originalPace = (total - (task.initialDone || 0)) / originalDays;
    const currentPace = remainingAtStart / (days.length || 1);
    const ratio = originalPace > 0 ? currentPace / originalPace : 1;
    let status = 'onTrack';
    if (days.length === 0 || ratio > 1.2) status = 'behind';
    else if (ratio < 0.9) status = 'ahead';

    return {
      ...base,
      status,
      quota,
      quotaLeft: Math.max(0, quota - doneToday),
      studyDaysLeft: days.length,
      currentPace,
      originalPace,
    };
  }

  // today から numDays 日分の予定量。今日のノルマを達成し、以降も計画どおり進めた場合の見込み。
  function forecast(task, logs, today, numDays) {
    const result = {};
    const end = addDays(today, numDays - 1);
    for (let d = today; d <= end; d = addDays(d, 1)) result[d] = 0;

    const remainingAtStart = Math.max(0, task.total - doneBefore(task, logs, today));
    if (remainingAtStart === 0 || today > task.deadline) return result;

    const from = today < task.startDate ? task.startDate : today;
    const days = studyDaysBetween(task, from, task.deadline);
    if (days.length === 0) {
      result[today] = remainingAtStart;
      return result;
    }
    const plan = distribute(remainingAtStart, days);
    for (const d of Object.keys(result)) {
      if (plan[d]) result[d] = plan[d];
    }
    return result;
  }

  const Planner = {
    parseDate,
    formatDate,
    addDays,
    diffDays,
    isStudyDay,
    studyDaysBetween,
    doneBefore,
    doneOn,
    totalDone,
    distribute,
    analyzeTask,
    forecast,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Planner;
  else root.Planner = Planner;
})(typeof window !== 'undefined' ? window : globalThis);
