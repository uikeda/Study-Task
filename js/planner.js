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

  // 開始前に終えていた量 + テキスト取り込み時の減算補正（adjust）。
  // adjust は当初ペースの計算には含めない。
  function baseDone(task) {
    return (task.initialDone || 0) + (task.adjust || 0);
  }

  // date より前（date 当日を含まない）までの累計実績
  function doneBefore(task, logs, date) {
    let sum = baseDone(task);
    for (const [d, entries] of Object.entries(logs)) {
      if (d < date && entries[task.id]) sum += entries[task.id];
    }
    return sum;
  }

  function doneOn(task, logs, date) {
    return (logs[date] && logs[date][task.id]) || 0;
  }

  function totalDone(task, logs) {
    let sum = baseDone(task);
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

  // from〜to の各日について、そのタスクの量を返す。
  // 過去: 実際にやった量（done）、今日: ノルマと実績（today）、未来: 計画どおり進めた場合の予定量（plan）
  function dailyAmounts(task, logs, today, from, to) {
    const result = {};
    const plan = to > today ? forecast(task, logs, today, diffDays(today, to) + 1) : {};
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (d < today) {
        result[d] = { type: 'done', amount: doneOn(task, logs, d) };
      } else if (d === today) {
        const a = analyzeTask(task, logs, today);
        result[d] = { type: 'today', amount: a.quota, done: a.doneToday };
      } else {
        result[d] = { type: 'plan', amount: plan[d] || 0 };
      }
    }
    return result;
  }

  // 今日以降の試験・模試を近い順に、残り日数付きで返す
  function upcomingEvents(events, today) {
    return events
      .filter((e) => e.date >= today)
      .map((e) => ({ ...e, daysLeft: diffDays(today, e.date) }))
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  const REVIEW_TAG = '復習';

  function isReview(task) {
    return (task.tags || []).includes(REVIEW_TAG);
  }

  // 累計が全体量に達した日。開始前の量や補正だけで達した場合など、日付が分からなければ null
  function completedOn(task, logs) {
    let sum = baseDone(task);
    if (sum >= task.total) return null;
    for (const d of Object.keys(logs).sort()) {
      sum += logs[d][task.id] || 0;
      if (sum >= task.total) return d;
    }
    return null;
  }

  // 元のタスクに対する復習タスクの一覧（開始日順に1回目, 2回目…）と、最後に復習を終えた日
  function reviewSummary(source, tasks, logs, today) {
    const reviews = tasks
      .filter((t) => isReview(t) && t.reviewOf === source.id)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.createdAt || '').localeCompare(b.createdAt || ''))
      .map((task, i) => {
        const a = analyzeTask(task, logs, today);
        return { task, round: i + 1, status: a.status, progress: a.progress, completedOn: a.status === 'done' ? completedOn(task, logs) : null };
      });
    const doneDates = reviews.map((r) => r.completedOn).filter(Boolean).sort();
    const lastReviewedOn = doneDates.length ? doneDates[doneDates.length - 1] : null;
    // 復習の起点: 最後に復習を終えた日。まだなら元のタスクを終えた日
    const since = lastReviewedOn || completedOn(source, logs);
    return {
      reviews,
      completedCount: reviews.filter((r) => r.status === 'done').length,
      active: reviews.find((r) => r.status !== 'done') || null,
      lastReviewedOn,
      daysSince: since ? diffDays(since, today) : null,
    };
  }

  // ---------- 達成度 ----------

  // date までの記録だけを残したログ（過去の日のノルマを、その日の時点の状態で計算し直すため）
  function logsUntil(logs, date) {
    const result = {};
    for (const [d, entries] of Object.entries(logs)) if (d <= date) result[d] = entries;
    return result;
  }

  // その日のノルマ達成度。ノルマのあるタスクごとの達成率（上限100%）の平均。
  // 単位の違うタスク（ページと語など）を量で足し合わせないよう、タスク単位で平均する。
  // date より後に登録したタスクは、その日の評価に含めない。
  function dayAchievement(tasks, logs, date) {
    const until = logsUntil(logs, date);
    const items = [];
    for (const task of tasks) {
      if (task.createdAt && formatDate(new Date(task.createdAt)) > date) continue;
      const a = analyzeTask(task, until, date);
      if (a.quota > 0) items.push({ task, quota: a.quota, done: a.doneToday, ratio: Math.min(1, a.doneToday / a.quota) });
    }
    const cleared = items.filter((x) => x.done >= x.quota).length;
    const rate = items.length ? items.reduce((s, x) => s + x.ratio, 0) / items.length : null;
    return { date, rate, cleared, count: items.length, items };
  }

  // today までの numDays 日分の達成度（古い順）
  function achievementSeries(tasks, logs, today, numDays) {
    return Array.from({ length: numDays }, (_, i) => dayAchievement(tasks, logs, addDays(today, i - numDays + 1)));
  }

  // 全ノルマを達成した日が何日続いているか。ノルマのない日は数えずに飛ばす。
  // 今日がまだ達成途中なら、昨日までの連続日数を返す。
  function streak(tasks, logs, today) {
    if (tasks.length === 0) return 0;
    const earliest = tasks.reduce((m, t) => (t.startDate < m ? t.startDate : m), tasks[0].startDate);
    let count = 0;
    for (let d = today; d >= earliest; d = addDays(d, -1)) {
      const day = dayAchievement(tasks, logs, d);
      if (day.count === 0) continue;
      if (day.cleared === day.count) count++;
      else if (d !== today) break;
    }
    return count;
  }

  // 計画どおりなら today の開始時点で終えているはずの量（当初の計画を学習日で均等割り）
  function expectedDone(task, today) {
    const start = task.initialDone || 0;
    if (today <= task.startDate) return start;
    if (today > task.deadline) return task.total;
    const all = studyDaysBetween(task, task.startDate, task.deadline).length;
    if (all === 0) return start;
    const elapsed = studyDaysBetween(task, task.startDate, addDays(today, -1)).length;
    return start + Math.round(((task.total - start) * elapsed) / all);
  }

  const Planner = {
    REVIEW_TAG,
    logsUntil,
    dayAchievement,
    achievementSeries,
    streak,
    expectedDone,
    isReview,
    completedOn,
    reviewSummary,
    dailyAmounts,
    upcomingEvents,
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
