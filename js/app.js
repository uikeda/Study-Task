(function () {
  'use strict';

  const P = window.Planner;
  const S = window.Schedule;
  const STORAGE_KEY = 'study-task:v1';
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const STATUS_LABEL = {
    onTrack: '順調',
    ahead: '先行',
    behind: '遅れ',
    overdue: '期限切れ',
    done: '完了',
    notStarted: '開始前',
  };

  let state = load();
  let editingId = null;

  // ---------- 保存・読み込み ----------

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data && Array.isArray(data.tasks) && data.logs) {
        if (!Array.isArray(data.events)) data.events = [];
        if (!Array.isArray(data.schedule)) data.schedule = [];
        if (!data.subjectColors || typeof data.subjectColors !== 'object') data.subjectColors = {};
        if (!Array.isArray(data.dismissedMissing)) data.dismissedMissing = [];
        return data;
      }
    } catch (e) {
      console.warn('保存データを読み込めませんでした', e);
    }
    return { tasks: [], logs: {}, events: [], schedule: [], subjectColors: {}, dismissedMissing: [] };
  }

  let saveWarned = false;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // プライベートブラウズなどで保存できない場合も、表示中の操作は続けられるようにする
      console.warn('保存できませんでした', e);
      if (!saveWarned) {
        saveWarned = true;
        askConfirm('このブラウザではデータを保存できません（プライベートブラウズなど）。ページを閉じると入力した内容は消えます。', { ok: 'OK', cancel: null });
      }
    }
  }

  // 確認ダイアログ。ブラウザの confirm() が使えない環境（埋め込み表示など）でも動くよう、ページ内に出す。
  // cancel を null にすると OK だけのお知らせになる。結果は OK なら true
  const confirmDialog = document.getElementById('confirm-dialog');
  function askConfirm(message, { ok = 'OK', cancel = 'キャンセル', danger = false } = {}) {
    document.getElementById('confirm-message').textContent = message;
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger-fill', danger);
    cancelBtn.hidden = cancel === null;
    if (cancel !== null) cancelBtn.textContent = cancel;
    confirmDialog.returnValue = ''; // Esc で閉じたときに前回の結果が残らないように
    confirmDialog.showModal();
    return new Promise((resolve) => {
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
    });
  }

  function today() {
    return P.formatDate(new Date());
  }

  // ---------- 表示ヘルパー ----------

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(str) {
    const d = P.parseDate(str);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  }

  function deadlineText(a) {
    if (a.daysToDeadline < 0) return `期限を${-a.daysToDeadline}日過ぎています`;
    if (a.daysToDeadline === 0) return '今日が期限';
    return `期限まで${a.daysToDeadline}日（今日を含む学習日 残り${a.studyDaysLeft}日）`;
  }

  function bar(ratio, good) {
    const pct = Math.round(Math.min(1, ratio) * 100);
    return `<div class="bar${good ? ' good' : ''}"><span style="width:${pct}%"></span></div>`;
  }

  function badge(status) {
    return `<span class="badge ${status}">${STATUS_LABEL[status]}</span>`;
  }

  function titleHtml(task) {
    const subject = task.subject ? `<span class="subject">${esc(task.subject)}</span>` : '';
    const tag = P.isReview(task) ? `<span class="tag">${P.REVIEW_TAG}</span>` : '';
    return `<div class="card-title">${tag}${subject}${esc(task.title)}</div>`;
  }

  // ---------- 今日 ----------

  // 「今日」タブ: 時間割に沿って「今のコマ → このあと → 残っているノルマ → 終わったもの」の順に並べる
  function renderToday() {
    const t = today();
    document.getElementById('today-label').textContent = `${fmtDate(t)} のタスク`;
    renderMissingNotice(t);

    const colors = subjectColors();
    const now = S.toMinutes(nowTime());
    const blocks = S.blocksOn(state.schedule, t);
    const current = blocks.find((b) => S.toMinutes(b.start) <= now && now < S.toMinutes(b.end)) || null;
    const items = state.tasks
      .map((task) => ({ task, a: P.analyzeTask(task, state.logs, t) }))
      // 今日ノルマがあるもの、今日すでに記録したもの、期限切れで残っているものを表示
      .filter(({ a }) => a.quota > 0 || a.doneToday > 0 || a.status === 'overdue');

    // タスクはどこか1か所にだけ出す（今 > このあと > 残っている、ノルマを終えたら「終わった」）
    const sections = { now: [], next: [], left: [], done: [] };
    for (const item of items) {
      const { task, a } = item;
      const finished = a.quota > 0 ? a.quotaLeft === 0 : a.status !== 'overdue';
      const slots = blocks.filter((b) => b.taskId === task.id);
      const upcoming = slots.find((b) => S.toMinutes(b.start) > now);
      if (finished) sections.done.push(item);
      else if (current && current.taskId === task.id) sections.now.push({ ...item, block: current });
      else if (upcoming) sections.next.push({ ...item, block: upcoming });
      else sections.left.push({ ...item, passed: slots.filter((b) => S.toMinutes(b.end) <= now).pop() });
    }
    // タスク以外のコマ（学校の課題など）も時間の流れに入れる
    for (const b of blocks) {
      if (blockTask(b)) continue;
      if (b === current) sections.now.push({ block: b });
      else if (S.toMinutes(b.start) > now) sections.next.push({ block: b });
    }
    sections.next.sort((x, y) => x.block.start.localeCompare(y.block.start));
    sections.left.sort((x, y) => x.task.deadline.localeCompare(y.task.deadline));

    const part = (title, entries, kind) => (entries.length ? `
      <h3 class="flow-head">${title}</h3>
      <ul class="flow-list">${entries.map((e) => (e.task ? todayTaskCard(e, colors, kind, now) : todaySlotRow(e.block, kind, now))).join('')}</ul>` : '');
    document.getElementById('today-flow').innerHTML = [
      part('今やること', sections.now, 'now'),
      part('このあと', sections.next, 'next'),
      part('残っているノルマ', sections.left, 'left'),
      sections.done.length ? `
        <h3 class="flow-head">終わった</h3>
        <ul class="flow-list">${sections.done.map((e) => todayDoneRow(e, colors)).join('')}</ul>` : '',
    ].join('');
    document.getElementById('today-empty').hidden = items.length > 0 || blocks.length > 0;

    const withQuota = items.filter(({ a }) => a.quota > 0);
    const cleared = withQuota.filter(({ a }) => a.quotaLeft === 0).length;
    document.getElementById('today-summary').textContent =
      withQuota.length > 0 ? `ノルマ達成 ${cleared} / ${withQuota.length}` : '';
  }

  // 一度に増やす量: ノルマが大きい（単語など）ほど大きく
  function bigStep(quota) {
    return quota >= 30 ? 10 : 5;
  }

  function todayTaskCard({ task, a, block, passed }, colors, kind, now) {
    const unit = esc(task.unit);
    const overdue = a.status === 'overdue';
    let head = '';
    if (kind === 'now') head = `<span class="now-tag">今</span>${block.start}–${block.end} ・ あと${S.toMinutes(block.end) - now}分`;
    else if (kind === 'next') head = `${block.start}–${block.end}`;
    else if (passed) head = `${passed.start}–${passed.end} のコマは終わりました`;

    const input = `<input type="number" min="0" step="1" value="${a.doneToday}" data-action="set-today" aria-label="今日やった量（${unit}）">`;
    const amount = a.quota > 0 ? `${input} <span>/ ${a.quota} ${unit}</span>` : `${input} <span>${unit}</span>`;
    let rest = '';
    if (overdue) rest = `残り <strong>${a.remaining}</strong> ${unit}（期限 ${fmtDate(task.deadline)}）`;
    else if (a.quotaLeft > 0) rest = `ノルマまで あと <strong>${a.quotaLeft}</strong> ${unit}`;
    const ratio = overdue ? a.progress : a.quota > 0 ? a.doneToday / a.quota : 0;
    const step = bigStep(a.quota);
    const lagging = a.status === 'behind' || overdue;

    return `
      <li class="tcard ${subjectClass(task.subject, colors)}${kind === 'now' ? ' is-now' : ''}" data-id="${task.id}">
        ${head ? `<div class="tcard-head">${head}</div>` : ''}
        <div class="tcard-top">${titleHtml(task)}${lagging ? badge(a.status) : ''}</div>
        <div class="tcard-amount">${amount}<span class="tcard-rest">${rest}</span></div>
        <div class="tcard-bar"><span style="width:${Math.round(Math.min(1, ratio) * 100)}%"></span></div>
        <div class="tcard-actions">
          <button data-action="add" data-n="-1" aria-label="1${unit}減らす"${a.doneToday === 0 ? ' disabled' : ''}>−1</button>
          <button data-action="add" data-n="1">+1</button>
          <button data-action="add" data-n="${step}">+${step}</button>
          ${a.quotaLeft > 0 ? `<button class="primary" data-action="fill-quota" data-quota="${a.quota}">ノルマ分</button>` : ''}
        </div>
        ${lagging ? '<button class="link tcard-recover" data-action="recover">遅れを立て直す</button>' : ''}
      </li>`;
  }

  function todaySlotRow(block, kind, now) {
    const head = kind === 'now'
      ? `<span class="now-tag">今</span>${block.start}–${block.end} ・ あと${S.toMinutes(block.end) - now}分`
      : `${block.start}–${block.end}`;
    return `
      <li class="tslot subj-other${kind === 'now' ? ' is-now' : ''}">
        <span class="tslot-time">${head}</span>
        <span class="tslot-title"><i class="subj-dot"></i>${esc(block.label || '（削除されたタスク）')}</span>
      </li>`;
  }

  function todayDoneRow({ task, a }, colors) {
    const unit = esc(task.unit);
    return `
      <li class="tdone ${subjectClass(task.subject, colors)}" data-id="${task.id}">
        <svg class="tdone-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>
        <span class="tdone-title">${titleHtml(task)}</span>
        <label class="tdone-amount"><input type="number" min="0" step="1" value="${a.doneToday}" data-action="set-today" aria-label="今日やった量（${unit}）">${a.quota > 0 ? ` / ${a.quota}` : ''} ${unit}</label>
      </li>`;
  }

  function setTodayAmount(taskId, amount) {
    const t = today();
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    if (!state.logs[t]) state.logs[t] = {};
    if (value === 0) delete state.logs[t][taskId];
    else state.logs[t][taskId] = value;
    if (Object.keys(state.logs[t]).length === 0) delete state.logs[t];
    save();
    renderAll();
  }

  // 直近7日のうち、ノルマがあったのに記録が一つもない日（新しい順）。「勉強しなかった」と答えた日は除く
  function unrecordedDays(t) {
    const answered = state.dismissedMissing || [];
    const days = [];
    for (let i = 1; i <= 7; i++) {
      const d = P.addDays(t, -i);
      if (!answered.includes(d) && P.isUnrecordedDay(state.tasks, state.logs, d)) days.push(d);
    }
    return days;
  }

  function renderMissingNotice(t) {
    const el = document.getElementById('missing-notice');
    const days = unrecordedDays(t);
    el.hidden = days.length === 0;
    if (days.length === 0) {
      el.innerHTML = '';
      return;
    }
    const label = days.length === 1
      ? `${fmtDate(days[0])} の記録がまだありません。`
      : `${fmtDate(days[0])} など ${days.length}日分の記録がまだありません。`;
    el.innerHTML = `
      <span class="notice-text">${label}勉強した日なら、やった量を入れてください。</span>
      <button class="primary" data-action="fill-missing" data-date="${days[0]}">入力する</button>
      <button data-action="dismiss-missing">勉強しなかった</button>`;
  }

  document.getElementById('missing-notice').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'fill-missing') {
      selectDate(btn.dataset.date);
      editingDay = btn.dataset.date;
      showView('calendar');
      document.getElementById('day-detail').scrollIntoView({ block: 'nearest' });
    }
    if (btn.dataset.action === 'dismiss-missing') {
      const answered = new Set([...(state.dismissedMissing || []), ...unrecordedDays(today())]);
      state.dismissedMissing = [...answered].sort().slice(-60);
      save();
      renderToday();
    }
  });

  const todayFlow = document.getElementById('today-flow');

  todayFlow.addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'set-today') return;
    setTodayAmount(e.target.closest('[data-id]').dataset.id, e.target.value);
  });

  todayFlow.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    const action = btn.dataset.action;
    if (action === 'add') setTodayAmount(id, P.doneOn({ id }, state.logs, today()) + Number(btn.dataset.n));
    if (action === 'fill-quota') setTodayAmount(id, btn.dataset.quota);
    if (action === 'recover') openRecover(state.tasks.find((x) => x.id === id));
  });

  // ---------- タスク一覧 ----------

  function renderTasks() {
    const t = today();
    const order = { overdue: 0, behind: 1, onTrack: 2, ahead: 3, notStarted: 4, done: 5 };
    const items = state.tasks
      .map((task) => ({ task, a: P.analyzeTask(task, state.logs, t) }))
      .filter(({ task, a }) => {
        if (taskFilter === 'study') return !P.isReview(task) && a.status !== 'done';
        if (taskFilter === 'review') return P.isReview(task) || a.status === 'done';
        return true;
      })
      .sort((x, y) => order[x.a.status] - order[y.a.status] || x.task.deadline.localeCompare(y.task.deadline));

    document.querySelectorAll('#task-filters .filter').forEach((b) => b.classList.toggle('active', b.dataset.filter === taskFilter));
    document.getElementById('filter-note').hidden = taskFilter !== 'review';

    document.getElementById('task-list').innerHTML = items.map(({ task, a }) => `
      <li class="card${a.status === 'done' ? ' complete' : ''}" data-id="${task.id}">
        <div class="card-top">${titleHtml(task)}${badge(a.status)}</div>
        <div class="quota"><strong>${a.done}</strong> / ${task.total} ${esc(task.unit)}（${Math.round(a.progress * 100)}%）</div>
        ${bar(a.progress, a.status === 'done')}
        <div class="meta">${fmtDate(task.startDate)} 〜 ${fmtDate(task.deadline)} ・ 学習日: ${task.studyDays.map((d) => WEEKDAYS[d]).join('')}</div>
        <div class="meta">${a.status === 'done' ? '完了しました' : deadlineText(a)}${paceText(task, a)}</div>
        ${reviewInfo(task, a)}
        <div class="card-actions">
          <button data-action="edit">編集</button>
          ${a.status === 'behind' || a.status === 'overdue' ? '<button data-action="recover">遅れを立て直す</button>' : ''}
          ${a.status === 'done' && !P.isReview(task) ? '<button data-action="add-review">＋ 復習タスクを作る</button>' : ''}
        </div>
      </li>`).join('');
    const empty = document.getElementById('tasks-empty');
    empty.hidden = items.length > 0;
    empty.textContent = taskFilter === 'all' || state.tasks.length === 0
      ? 'まだタスクがありません。「＋ タスクを追加」から登録してください。'
      : '該当するタスクはありません。';
  }

  let taskFilter = 'all';

  document.getElementById('task-filters').addEventListener('click', (e) => {
    if (!e.target.dataset.filter) return;
    taskFilter = e.target.dataset.filter;
    renderTasks();
  });

  // 復習タスクなら元のタスクと何回目か、終わったタスクなら復習の状況を表示する
  function reviewInfo(task, a) {
    const t = today();
    if (P.isReview(task)) {
      const source = state.tasks.find((x) => x.id === task.reviewOf);
      if (!source) return '';
      const round = P.reviewSummary(source, state.tasks, state.logs, t).reviews.find((r) => r.task === task).round;
      return `<div class="meta">復習元: ${esc(source.title)}（${round}回目）</div>`;
    }
    if (a.status !== 'done') return '';
    const s = P.reviewSummary(task, state.tasks, state.logs, t);
    const since = s.daysSince === null ? '' : `${s.lastReviewedOn ? '前回の復習' : '完了'}から${s.daysSince}日`;
    if (s.reviews.length === 0) {
      return `<div class="review-status"><strong>未復習</strong>${since ? ` ・ ${since}` : ''}</div>`;
    }
    const list = s.reviews.map((r) => {
      const state_ = r.status === 'done'
        ? `完了${r.completedOn ? `（${fmtDate(r.completedOn)}）` : ''}`
        : `${STATUS_LABEL[r.status]} ${Math.round(r.progress * 100)}% ・ 期限 ${fmtDate(r.task.deadline)}`;
      return `<li>${r.round}回目: ${state_}</li>`;
    }).join('');
    return `<div class="review-status"><strong>復習 ${s.completedCount}回完了</strong>${s.active ? ' ・ 復習中' : ''}${since ? ` <span class="muted">・ ${since}</span>` : ''}<ul>${list}</ul></div>`;
  }

  function paceText(task, a) {
    if (a.currentPace === undefined) return '';
    const unit = esc(task.unit);
    return ` ・ 必要ペース 1日 ${Math.ceil(a.currentPace)} ${unit}（当初 ${Math.ceil(a.originalPace)} ${unit}）`;
  }

  // ---------- 遅れの立て直し ----------

  const recoverDialog = document.getElementById('recover-dialog');
  const recoverForm = document.getElementById('recover-form');
  let recoverTaskId = null;
  let recoverOptions = [];

  // 1日あたりの量の表示: 割り切れなければ切り上げて「約」を付ける
  function perDayText(v) {
    if (v === null || v === undefined) return '–';
    return Number.isInteger(v) ? `${v}` : `約${Math.ceil(v)}`;
  }

  function paceText1(v) {
    return `${Math.round(v * 10) / 10}`;
  }

  function delayText(delay) {
    if (delay > 0) return `${delay}日遅れ`;
    if (delay < 0) return `${-delay}日早い`;
    return '期限どおり';
  }

  function recoverOptionLabel(task, o) {
    const unit = esc(task.unit);
    switch (o.id) {
      case 'pace': return { title: '最近のペースに合わせる', detail: `期限を ${fmtDate(o.changes.deadline)} にする` };
      case 'extend': return { title: '期限を1週間延ばす', detail: `期限を ${fmtDate(o.changes.deadline)} にする` };
      case 'everyday': return { title: '毎日を学習日にする', detail: '休みの日がなくなります' };
      case 'reduce': return { title: `全体を ${o.changes.total} ${unit} に減らす`, detail: `${task.total - o.changes.total} ${unit} は後回しにする` };
      default: return { title: 'このまま続ける', detail: '期限と量は変えません' };
    }
  }

  function openRecover(task) {
    if (!task) return;
    const t = today();
    const a = P.analyzeTask(task, state.logs, t);
    const p = P.projectFinish(task, state.logs, t);
    const unit = esc(task.unit);
    recoverTaskId = task.id;
    recoverOptions = P.recoveryOptions(task, state.logs, t);

    const required = P.requiredPace(task, state.logs, t);
    let insight;
    if (p.date) {
      insight = `
        <div>必要なペース <strong>1日 ${perDayText(required)} ${unit}</strong> ／ 最近${p.sampleDays}日のペース <strong>1日 ${paceText1(p.pace)} ${unit}</strong></div>
        <div class="insight-main">このままだと、終わるのは ${fmtDate(p.date)} ごろ（${delayText(p.delay)}）</div>`;
    } else {
      insight = '<div>最近の記録がないため、終わる日を見通せません。</div>';
    }
    document.getElementById('recover-title').textContent = `「${task.title}」を立て直す`;
    document.getElementById('recover-body').innerHTML = `
      <p class="meta">残り ${a.remaining} ${unit} ・ 期限 ${fmtDate(task.deadline)}${a.status === 'overdue' ? '（過ぎています）' : `（学習日 あと${a.studyDaysLeft}日）`}</p>
      <div class="insight">${insight}</div>
      <div class="recover-options" role="radiogroup" aria-label="立て直し方">
        ${recoverOptions.map((o, i) => {
          const { title, detail } = recoverOptionLabel(task, o);
          return `
          <label class="recover-option">
            <input type="radio" name="recover" value="${o.id}"${i === 0 ? ' checked' : ''}>
            <span class="grow"><strong>${title}</strong><span class="meta">${detail}</span></span>
            <span class="per-day"><strong>${perDayText(o.perDay)}</strong> ${unit}/日</span>
          </label>`;
        }).join('')}
      </div>`;
    recoverDialog.showModal();
  }

  recoverForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const task = state.tasks.find((x) => x.id === recoverTaskId);
    const chosen = recoverForm.querySelector('input[name="recover"]:checked');
    const option = chosen && recoverOptions.find((o) => o.id === chosen.value);
    if (task && option) {
      Object.assign(task, option.changes);
      save();
    }
    recoverDialog.close();
    renderAll();
  });

  document.getElementById('btn-recover-cancel').addEventListener('click', () => recoverDialog.close());

  // AI に相談: 状況を相談欄に入れて「連携」タブを開く
  document.getElementById('btn-recover-ai').addEventListener('click', () => {
    const task = state.tasks.find((x) => x.id === recoverTaskId);
    if (!task) return;
    const t = today();
    const a = P.analyzeTask(task, state.logs, t);
    const p = P.projectFinish(task, state.logs, t);
    const required = P.requiredPace(task, state.logs, t);
    const lines = [
      `「${task.title}」が遅れています。残り ${a.remaining} ${task.unit}、期限は ${task.deadline} です。`,
      required !== null ? `期限に間に合わせるには 1日 ${perDayText(required)} ${task.unit} 必要です。` : '期限を過ぎています。',
      p.date ? `最近${p.sampleDays}日のペースは 1日 ${paceText1(p.pace)} ${task.unit} で、このままだと ${p.date} ごろに終わります。` : '',
      '現実的な立て直し方を相談したいです（期限を延ばす・量を減らす・ほかのタスクとの配分を変える、など）。',
    ];
    document.getElementById('consult-text').value = lines.filter(Boolean).join('\n');
    recoverDialog.close();
    showView('sync');
    document.getElementById('prompt-status').textContent = '相談内容を入れました。「コピーして Claude を開く」などで、チャットに貼り付けてください。';
    document.getElementById('consult-panel').scrollIntoView({ block: 'start' });
  });

  // ---------- 週間予定 ----------

  function renderWeek() {
    const t = today();
    const days = Array.from({ length: 7 }, (_, i) => P.addDays(t, i));
    const active = state.tasks.filter((task) => {
      const s = P.analyzeTask(task, state.logs, t).status;
      return s !== 'done' && s !== 'overdue';
    });
    const table = document.getElementById('week-table');
    if (active.length === 0) {
      table.innerHTML = '<tbody><tr><td class="zero">予定中のタスクはありません。</td></tr></tbody>';
      return;
    }

    const rows = active.map((task) => {
      const f = P.forecast(task, state.logs, t, 7);
      const cells = days.map((d) => `<td class="${f[d] ? '' : 'zero'}">${f[d] || '–'}</td>`).join('');
      return `<tr><td>${titleHtml(task)}<div class="meta">単位: ${esc(task.unit)}</div></td>${cells}</tr>`;
    });
    const counts = days.map((d) => active.filter((task) => P.forecast(task, state.logs, t, 7)[d] > 0).length);

    table.innerHTML = `
      <thead><tr><th>タスク</th>${days.map((d, i) => `<th class="${i === 0 ? 'today' : ''}">${fmtDate(d)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}
        <tr class="total"><td>その日のタスク数</td>${counts.map((c) => `<td>${c}</td>`).join('')}</tr>
      </tbody>`;
  }

  function renderAll() {
    renderToday();
    renderTasks();
    renderWeek();
    renderCountdown();
    renderCalendar();
    renderSchedule();
    renderStats();
  }

  // ---------- 追加・編集ダイアログ ----------

  const dialog = document.getElementById('task-dialog');
  const form = document.getElementById('task-form');

  document.getElementById('weekday-checks').innerHTML = WEEKDAYS
    .map((w, i) => `<label><input type="checkbox" name="studyDays" value="${i}">${w}</label>`)
    .join('');

  const reviewCheck = form.elements.review;
  const reviewSelect = form.elements.reviewOf;

  function fillReviewOptions(selfId, selected) {
    const sources = state.tasks.filter((x) => x.id !== selfId && !P.isReview(x));
    reviewSelect.innerHTML = '<option value="">（指定しない）</option>' + sources
      .map((x) => `<option value="${x.id}"${x.id === selected ? ' selected' : ''}>${esc(x.title)}</option>`).join('');
  }

  function toggleReviewFields() {
    document.getElementById('review-source-label').hidden = !reviewCheck.checked;
  }
  reviewCheck.addEventListener('change', toggleReviewFields);

  // 新規作成中に元のタスクを選んだら、名前・量・単位・科目を元のタスクから埋める
  reviewSelect.addEventListener('change', () => {
    if (editingId) return;
    const source = state.tasks.find((x) => x.id === reviewSelect.value);
    if (source) presetReview(source);
  });

  function presetReview(source) {
    const round = P.reviewSummary(source, state.tasks, state.logs, today()).reviews.length + 1;
    form.elements.title.value = `${source.title} 復習${round}回目`;
    form.elements.subject.value = source.subject || '';
    form.elements.total.value = source.total;
    form.elements.unit.value = source.unit;
    form.elements.initialDone.value = 0;
  }

  function openReviewDialog(source) {
    openDialog(null);
    reviewCheck.checked = true;
    fillReviewOptions(null, source.id);
    toggleReviewFields();
    presetReview(source);
  }

  function openDialog(task) {
    editingId = task ? task.id : null;
    form.reset();
    document.getElementById('form-error').textContent = '';
    document.getElementById('dialog-title').textContent = task ? 'タスクを編集' : 'タスクを追加';
    document.getElementById('btn-delete').hidden = !task;

    const t = today();
    const values = task || { title: '', subject: '', total: '', unit: 'ページ', initialDone: 0, startDate: t, deadline: P.addDays(t, 14), studyDays: [0, 1, 2, 3, 4, 5, 6] };
    for (const key of ['title', 'subject', 'total', 'unit', 'initialDone', 'startDate', 'deadline']) {
      form.elements[key].value = values[key] ?? '';
    }
    form.querySelectorAll('input[name="studyDays"]').forEach((cb) => {
      cb.checked = values.studyDays.includes(Number(cb.value));
    });
    reviewCheck.checked = task ? P.isReview(task) : false;
    fillReviewOptions(editingId, task && task.reviewOf);
    toggleReviewFields();
    dialog.showModal();
  }

  function readForm() {
    const f = form.elements;
    const task = {
      title: f.title.value.trim(),
      subject: f.subject.value.trim(),
      total: Math.floor(Number(f.total.value)),
      unit: f.unit.value.trim(),
      initialDone: Math.floor(Number(f.initialDone.value) || 0),
      startDate: f.startDate.value,
      deadline: f.deadline.value,
      studyDays: [...form.querySelectorAll('input[name="studyDays"]:checked')].map((cb) => Number(cb.value)),
      review: reviewCheck.checked,
      reviewOf: reviewCheck.checked && reviewSelect.value ? reviewSelect.value : undefined,
    };
    if (!task.title || !task.unit) return { error: 'タスク名と単位を入力してください。' };
    if (!(task.total > 0)) return { error: '全体量は1以上の数値にしてください。' };
    if (task.initialDone < 0 || task.initialDone > task.total) return { error: 'すでに終えた量は0〜全体量の範囲にしてください。' };
    if (!task.startDate || !task.deadline) return { error: '開始日と期限を入力してください。' };
    if (task.deadline < task.startDate) return { error: '期限は開始日以降にしてください。' };
    if (task.studyDays.length === 0) return { error: '学習する曜日を1つ以上選んでください。' };
    return { task };
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { task, error } = readForm();
    if (error) {
      document.getElementById('form-error').textContent = error;
      return;
    }
    const { review, reviewOf, ...fields } = task;
    let target;
    if (editingId) {
      target = Object.assign(state.tasks.find((x) => x.id === editingId), fields);
    } else {
      target = { id: newId(), createdAt: new Date().toISOString(), ...fields };
      state.tasks.push(target);
    }
    // 復習タグはほかのタグを残したまま付け外しする
    const tags = (target.tags || []).filter((x) => x !== P.REVIEW_TAG);
    if (review) tags.push(P.REVIEW_TAG);
    if (tags.length) target.tags = tags;
    else delete target.tags;
    if (reviewOf) target.reviewOf = reviewOf;
    else delete target.reviewOf;
    save();
    dialog.close();
    renderAll();
  });

  function newId() {
    return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  document.getElementById('btn-cancel').addEventListener('click', () => dialog.close());

  document.getElementById('btn-delete').addEventListener('click', async () => {
    const task = state.tasks.find((x) => x.id === editingId);
    if (!task || !(await askConfirm(`「${task.title}」を削除しますか？記録も消えます。`, { ok: '削除', danger: true }))) return;
    state.tasks = state.tasks.filter((x) => x.id !== editingId);
    // このタスクを元にした復習タスクは残し、ひも付けだけ外す
    for (const x of state.tasks) if (x.reviewOf === editingId) delete x.reviewOf;
    // 時間割のコマは残し、タスクの名前を内容として引き継ぐ
    for (const b of state.schedule) {
      if (b.taskId !== editingId) continue;
      b.label = task.title;
      delete b.taskId;
    }
    for (const [d, entries] of Object.entries(state.logs)) {
      delete entries[editingId];
      if (Object.keys(entries).length === 0) delete state.logs[d];
    }
    save();
    dialog.close();
    renderAll();
  });

  // ---------- イベント ----------

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => showView(el.dataset.goto));
  });

  function showView(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    renderAll(); // 日付が変わっていても最新の状態で表示する
  }

  document.getElementById('btn-add').addEventListener('click', () => openDialog(null));

  document.getElementById('task-list').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action !== 'edit' && action !== 'add-review' && action !== 'recover') return;
    const task = state.tasks.find((x) => x.id === e.target.closest('.card').dataset.id);
    if (action === 'edit') openDialog(task);
    else if (action === 'recover') openRecover(task);
    else openReviewDialog(task);
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study-task-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('input-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.tasks) || typeof data.logs !== 'object') throw new Error('形式が違います');
      if (!(await askConfirm('現在のデータを読み込んだデータで置き換えますか？', { ok: '置き換える', danger: true }))) return;
      state = {
        tasks: data.tasks,
        logs: data.logs,
        events: Array.isArray(data.events) ? data.events : [],
        schedule: Array.isArray(data.schedule) ? data.schedule : [],
        subjectColors: data.subjectColors && typeof data.subjectColors === 'object' ? data.subjectColors : {},
        dismissedMissing: Array.isArray(data.dismissedMissing) ? data.dismissedMissing : [],
      };
      save();
      renderAll();
    } catch (err) {
      askConfirm(`読み込みに失敗しました: ${err.message}`, { cancel: null });
    }
  });

  // ---------- 試験・模試のカウントダウン ----------

  const KIND_LABEL = { exam: '本番', mock: '模試', other: 'その他' };

  function renderCountdown() {
    const upcoming = P.upcomingEvents(state.events, today());
    // 一番近い「本番」を大きく表示し、ほかは近い順に最大3件
    const main = upcoming.find((e) => e.kind === 'exam');
    const others = upcoming.filter((e) => e !== main).slice(0, 3);
    const items = (main ? [main] : []).concat(others);
    const html = items.map((e) => `
      <button class="cd-item ${e.kind}${e === main ? ' main' : ''}" data-date="${e.date}">
        <span class="cd-title"><strong>${esc(e.title)}</strong><br><span class="cd-date">${KIND_LABEL[e.kind]} ・ ${fmtDate(e.date)}</span></span>
        <span class="cd-days">${e.daysLeft === 0 ? '<strong>今日</strong>' : `あと<strong>${e.daysLeft}</strong>日`}</span>
      </button>`).join('');
    document.getElementById('countdown-today').innerHTML = html;
    document.getElementById('countdown-calendar').innerHTML = html;
  }

  document.querySelectorAll('.countdown').forEach((el) => {
    el.addEventListener('click', (e) => {
      const item = e.target.closest('.cd-item');
      if (!item) return;
      selectDate(item.dataset.date);
      showView('calendar');
    });
  });

  // ---------- カレンダー ----------

  let calMonth = today().slice(0, 8) + '01'; // 表示中の月の1日
  let selectedDate = today();
  let editingDay = null; // 記録を直している過去の日

  function selectDate(date) {
    if (date !== selectedDate) editingDay = null;
    selectedDate = date;
    calMonth = date.slice(0, 8) + '01';
  }

  function eventsOn(date) {
    return state.events.filter((e) => e.date === date);
  }

  function renderCalendar() {
    const t = today();
    const first = P.parseDate(calMonth);
    document.getElementById('cal-title').textContent = `${first.getFullYear()}年${first.getMonth() + 1}月`;

    // 日曜始まりで6週分（前後の月の日も含めて表示）
    const start = P.addDays(calMonth, -first.getDay());
    const end = P.addDays(start, 41);
    const amounts = state.tasks.map((task) => P.dailyAmounts(task, state.logs, t, start, end));

    let html = WEEKDAYS.map((w, i) => `<div class="cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = P.addDays(start, i);
      const date = P.parseDate(d);
      const dow = date.getDay();
      const cls = ['cal-day'];
      if (d.slice(0, 7) !== calMonth.slice(0, 7)) cls.push('outside');
      if (d === t) cls.push('today');
      if (d === selectedDate) cls.push('selected');
      if (dow === 0) cls.push('sun');
      if (dow === 6) cls.push('sat');

      const day = amounts.map((a) => a[d]);
      const count = day.filter((a) => a.amount > 0).length;
      const missing = d < t && P.isUnrecordedDay(state.tasks, state.logs, d);
      if (missing) cls.push('missing');
      let countHtml = '';
      if (missing) {
        countHtml = '<span class="count missing-label">未記録</span>';
      } else if (d === t) {
        const met = count > 0 && day.every((a) => a.done >= a.amount);
        countHtml = count ? `<span class="count${met ? ' met' : ''}">${met ? '✓' : ''}${count}件</span>` : '';
      } else if (count) {
        countHtml = `<span class="count${d < t ? ' met' : ''}">${d < t ? '✓' : ''}${count}件</span>`;
      }
      const chips = eventsOn(d).map((e) => `<span class="chip ${e.kind}">${esc(e.title)}</span>`).join('');
      html += `<button class="${cls.join(' ')}" data-date="${d}" aria-label="${fmtDate(d)}"><span class="num">${date.getDate()}</span>${chips}${countHtml}</button>`;
    }
    document.getElementById('cal-grid').innerHTML = html;
    renderDayDetail();
  }

  function renderDayDetail() {
    const t = today();
    const d = selectedDate;
    if (d < t && editingDay === d) {
      renderRecordEditor(d);
      return;
    }
    const rows = [];
    for (const task of state.tasks) {
      const a = P.dailyAmounts(task, state.logs, t, d, d)[d];
      const unit = esc(task.unit);
      let amount = '';
      if (a.type === 'done' && a.amount > 0) amount = `${a.amount} ${unit} やった`;
      else if (a.type === 'today' && (a.amount > 0 || a.done > 0)) amount = `${a.done} / ${a.amount} ${unit}`;
      else if (a.type === 'plan' && a.amount > 0) amount = `${a.amount} ${unit}（予定）`;
      const isDeadline = task.deadline === d;
      if (!amount && !isDeadline) continue;
      rows.push(`<li><span>${titleHtml(task)}${isDeadline ? '<span class="deadline">この日が期限</span>' : ''}</span><span class="amount">${amount}</span></li>`);
    }

    let note = '';
    if (d < t) note = 'この日に記録した実績です。';
    else if (d === t) note = '今日のノルマと実績です。記録は「今日」タブから。';
    else note = '今日のノルマを達成し、以降も計画どおり進めた場合の予定量です。';

    const events = eventsOn(d).map((e) => `
      <div class="event-row ${e.kind}">
        <div class="grow"><strong>${esc(e.title)}</strong>（${KIND_LABEL[e.kind]}）${e.memo ? `<div class="meta">${esc(e.memo)}</div>` : ''}
          <div class="meta">${d >= t ? (d === t ? '今日です' : `あと${P.diffDays(t, d)}日`) : '終了'}</div></div>
        <button data-action="edit-event" data-id="${e.id}">編集</button>
      </div>`).join('');

    document.getElementById('day-detail').innerHTML = `
      <h3>${fmtDate(d)}${d === t ? '（今日）' : ''}</h3>
      ${events}
      ${rows.length ? `<p class="note">${note}</p><ul class="day-list">${rows.join('')}</ul>` : '<p class="note">この日のタスクはありません。</p>'}
      <div class="btn-row">
        ${d < t && recordableTasks(d).length ? '<button data-action="edit-records">記録を直す</button>' : ''}
        <button data-action="add-event">＋ この日に試験・模試を追加</button>
      </div>`;
  }

  // 過去の日に記録できるタスク: その日に記録があるか、その日の時点で終わっていなかったもの
  function recordableTasks(d) {
    const until = P.logsUntil(state.logs, d);
    return state.tasks
      .map((task) => ({ task, a: P.analyzeTask(task, until, d), done: P.doneOn(task, state.logs, d) }))
      .filter(({ task, a, done }) => {
        if (done > 0) return true;
        if (task.createdAt && P.formatDate(new Date(task.createdAt)) > d) return false;
        return a.status !== 'done' && a.status !== 'notStarted';
      });
  }

  function renderRecordEditor(d) {
    const rows = recordableTasks(d).map(({ task, a, done }) => `
      <li>
        <div class="grow">${titleHtml(task)}<div class="meta">${a.quota > 0 ? `この日のノルマ ${a.quota} ${esc(task.unit)}` : 'この日は学習日ではありません'}</div></div>
        <label class="record-input"><input type="number" min="0" step="1" value="${done}" data-task="${task.id}" aria-label="${esc(task.title)} のやった量（${esc(task.unit)}）"> ${esc(task.unit)}</label>
      </li>`).join('');
    document.getElementById('day-detail').innerHTML = `
      <h3>${fmtDate(d)} の記録を直す</h3>
      <ul class="record-edit">${rows}</ul>
      <div class="record-impact" id="record-impact"></div>
      <div class="btn-row">
        <button data-action="cancel-records">キャンセル</button>
        <button class="primary" data-action="save-records">保存</button>
      </div>`;
    updateRecordImpact(d);
  }

  function editedLogs(d) {
    const logs = JSON.parse(JSON.stringify(state.logs));
    const entries = logs[d] || {};
    document.querySelectorAll('#day-detail input[data-task]').forEach((input) => {
      const value = Math.max(0, Math.floor(Number(input.value) || 0));
      if (value === 0) delete entries[input.dataset.task];
      else entries[input.dataset.task] = value;
    });
    if (Object.keys(entries).length) logs[d] = entries;
    else delete logs[d];
    return logs;
  }

  // 保存すると今日のノルマがどう変わるか
  function updateRecordImpact(d) {
    const t = today();
    const logs = editedLogs(d);
    const changes = state.tasks
      .map((task) => ({ task, before: P.analyzeTask(task, state.logs, t).quota, after: P.analyzeTask(task, logs, t).quota }))
      .filter((x) => x.before !== x.after);
    document.getElementById('record-impact').innerHTML = changes.length
      ? `保存すると、今日のノルマが変わります。<ul>${changes.map((x) => `<li>${esc(x.task.title)}: ${x.before} → <strong>${x.after}</strong> ${esc(x.task.unit)}</li>`).join('')}</ul>`
      : '保存しても、今日のノルマは変わりません。';
  }

  document.getElementById('cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-day');
    if (!cell) return;
    selectDate(cell.dataset.date);
    // 未記録の日を押したら、そのまま記録を入れられるようにする
    if (cell.classList.contains('missing')) editingDay = cell.dataset.date;
    renderCalendar();
    document.getElementById('day-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function moveMonth(n) {
    const date = P.parseDate(calMonth);
    date.setMonth(date.getMonth() + n);
    calMonth = P.formatDate(date);
    renderCalendar();
  }
  document.getElementById('cal-prev').addEventListener('click', () => moveMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => moveMonth(1));
  document.getElementById('cal-today').addEventListener('click', () => {
    selectDate(today());
    renderCalendar();
  });

  document.getElementById('day-detail').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'add-event') openEventDialog(null, selectedDate);
    if (action === 'edit-event') openEventDialog(state.events.find((x) => x.id === e.target.dataset.id));
    if (action === 'edit-records') {
      editingDay = selectedDate;
      renderDayDetail();
    }
    if (action === 'cancel-records') {
      editingDay = null;
      renderDayDetail();
    }
    if (action === 'save-records') {
      state.logs = editedLogs(selectedDate);
      editingDay = null;
      save();
      renderAll();
    }
  });

  document.getElementById('day-detail').addEventListener('input', (e) => {
    if (e.target.dataset.task) updateRecordImpact(selectedDate);
  });

  // ---------- 試験・模試ダイアログ ----------

  const eventDialog = document.getElementById('event-dialog');
  const eventForm = document.getElementById('event-form');
  let editingEventId = null;

  function openEventDialog(ev, date) {
    editingEventId = ev ? ev.id : null;
    eventForm.reset();
    document.getElementById('event-form-error').textContent = '';
    document.getElementById('event-dialog-title').textContent = ev ? '試験・模試を編集' : '試験・模試を追加';
    document.getElementById('btn-event-delete').hidden = !ev;
    const values = ev || { title: '', date, kind: 'mock', memo: '' };
    eventForm.elements.title.value = values.title;
    eventForm.elements.date.value = values.date;
    eventForm.elements.memo.value = values.memo || '';
    eventForm.querySelector(`input[name="kind"][value="${values.kind}"]`).checked = true;
    eventDialog.showModal();
  }

  eventForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = eventForm.elements;
    const ev = {
      title: f.title.value.trim(),
      date: f.date.value,
      kind: eventForm.querySelector('input[name="kind"]:checked').value,
      memo: f.memo.value.trim(),
    };
    if (!ev.title || !ev.date) {
      document.getElementById('event-form-error').textContent = '名前と日付を入力してください。';
      return;
    }
    if (editingEventId) Object.assign(state.events.find((x) => x.id === editingEventId), ev);
    else state.events.push({ id: newId(), ...ev });
    save();
    eventDialog.close();
    selectDate(ev.date);
    renderAll();
  });

  document.getElementById('btn-event-cancel').addEventListener('click', () => eventDialog.close());

  document.getElementById('btn-event-delete').addEventListener('click', async () => {
    const ev = state.events.find((x) => x.id === editingEventId);
    if (!ev || !(await askConfirm(`「${ev.title}」を削除しますか？`, { ok: '削除', danger: true }))) return;
    state.events = state.events.filter((x) => x.id !== editingEventId);
    save();
    eventDialog.close();
    renderAll();
  });

  // ---------- テキスト連携 ----------

  const TF = window.TextFormat;
  const importText = document.getElementById('import-text');
  const preview = document.getElementById('import-preview');

  async function copyText(text, statusId) {
    const status = document.getElementById(statusId);
    hideManualCopy(statusId);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'コピーしました。チャットに貼り付けてください。';
    } catch (err) {
      showManualCopy(statusId, text);
    }
  }

  // 自動でコピーできない環境では、テキストを選択した状態で表示して手でコピーしてもらう
  function showManualCopy(statusId, text) {
    const status = document.getElementById(statusId);
    status.textContent = '自動でコピーできませんでした。下の枠のテキストが選択されているので、Ctrl+C（⌘+C）でコピーしてください。';
    let area = document.getElementById(`${statusId}-manual`);
    if (!area) {
      area = document.createElement('textarea');
      area.id = `${statusId}-manual`;
      area.className = 'manual-copy';
      area.rows = 6;
      area.readOnly = true;
      area.setAttribute('aria-label', 'コピーするテキスト');
      status.after(area);
    }
    area.value = text;
    area.focus();
    area.select();
  }

  function hideManualCopy(statusId) {
    const area = document.getElementById(`${statusId}-manual`);
    if (area) area.remove();
  }

  document.getElementById('btn-copy-text').addEventListener('click', () => {
    copyText(TF.serialize(state, today()), 'copy-status');
  });

  function consultPromptText() {
    return TF.consultPrompt(state, today(), document.getElementById('consult-text').value);
  }

  document.getElementById('btn-copy-prompt').addEventListener('click', () => {
    copyText(consultPromptText(), 'prompt-status');
  });

  // チャットを新しいタブで開く前に、同じクリックの中でコピーを済ませる
  // （開いたタブにフォーカスが移ると、非同期のクリップボード API は失敗することがあるため）
  function copySync(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  document.getElementById('consult-panel').addEventListener('click', (e) => {
    const link = e.target.closest('[data-action="copy-open"]');
    if (!link) return;
    const text = consultPromptText();
    const status = document.getElementById('prompt-status');
    hideManualCopy('prompt-status');
    if (copySync(text)) {
      status.textContent = 'コピーしました。開いたチャットに貼り付けて送ってください。';
      return;
    }
    // execCommand が使えなければクリップボード API を試し、それも駄目なら手でコピーしてもらう
    navigator.clipboard.writeText(text)
      .then(() => { status.textContent = 'コピーしました。開いたチャットに貼り付けて送ってください。'; })
      .catch(() => showManualCopy('prompt-status', text));
  });

  document.getElementById('btn-paste').addEventListener('click', async () => {
    try {
      importText.value = await navigator.clipboard.readText();
      showPreview();
    } catch (err) {
      importText.focus();
      preview.hidden = false;
      preview.innerHTML = '<p>クリップボードを読み取れませんでした。入力欄をクリックして貼り付け（Ctrl+V / ⌘+V）てから「内容を確認」を押してください。</p>';
    }
  });

  document.getElementById('btn-save-text').addEventListener('click', () => {
    const blob = new Blob([TF.serialize(state, today())], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study-plan-${today()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('input-text-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    importText.value = await file.text();
    showPreview();
  });

  document.getElementById('btn-preview').addEventListener('click', showPreview);
  importText.addEventListener('input', () => { preview.hidden = true; });

  function computeImport() {
    const t = today();
    const parsed = TF.parse(importText.value, t);
    if (parsed.errors.length > 0) return { errors: parsed.errors };
    return TF.applyImport(state, parsed, t, newId);
  }

  function nameList(names) {
    return `<ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  }

  function showPreview() {
    preview.hidden = false;
    const result = computeImport();
    if (result.errors) {
      preview.innerHTML = `<div class="errors"><strong>読み込めない箇所があります。直してからもう一度確認してください。</strong>
        <ul>${result.errors.map((e) => `<li>${e.line ? `${e.line}行目: ` : ''}${esc(e.message)}</li>`).join('')}</ul></div>`;
      return;
    }
    const { added, updated, removed, unchanged } = result.changes;
    if (added.length + updated.length + removed.length === 0) {
      preview.innerHTML = `<p>変更はありません（${unchanged}件とも同じ内容です）。</p>`;
      return;
    }
    preview.innerHTML = `
      ${added.length ? `<strong>追加 ${added.length}件</strong>${nameList(added)}` : ''}
      ${updated.length ? `<strong>変更 ${updated.length}件</strong>${nameList(updated)}` : ''}
      ${removed.length ? `<div class="removed"><strong>削除 ${removed.length}件（記録も消えます）</strong>${nameList(removed)}</div>` : ''}
      ${unchanged ? `<p>変更なし ${unchanged}件</p>` : ''}
      <p class="note">「済」が増えたタスクは、増えた分を今日の実績として記録します。</p>
      <div class="btn-row"><button class="primary" id="btn-apply">この内容で反映する</button></div>`;
    document.getElementById('btn-apply').addEventListener('click', () => {
      const latest = computeImport(); // 確認後に日付やデータが変わっていても最新の状態に当てはめる
      if (latest.errors) return showPreview();
      state = latest.state;
      save();
      importText.value = '';
      preview.innerHTML = '<p>反映しました。</p>';
      renderAll();
    });
  }

  // ---------- 時間割 ----------

  function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function blockTask(block) {
    return block.taskId ? state.tasks.find((x) => x.id === block.taskId) : null;
  }

  function blockTitleHtml(block) {
    const task = blockTask(block);
    if (task) return titleHtml(task);
    return `<div class="card-title">${esc(block.label || '（削除されたタスク）')}</div>`;
  }

  function blockRepeatText(block) {
    if (block.date) return `${fmtDate(block.date)} だけ`;
    return `毎週 ${formatDays(block.days)}`;
  }

  function formatDays(days) {
    return days.length === 7 ? '毎日' : [...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join('');
  }

  // そのコマでやるタスクの、その日の量（今日ならノルマの残り）
  function blockAmountText(block, date) {
    const task = blockTask(block);
    if (!task) return '';
    const t = today();
    const a = P.dailyAmounts(task, state.logs, t, date, date)[date];
    const unit = esc(task.unit);
    if (a.type === 'today') {
      if (a.amount === 0) return '今日のノルマはありません';
      const left = Math.max(0, a.amount - a.done);
      return left === 0 ? `ノルマ達成（${a.done} / ${a.amount} ${unit}）` : `今日のノルマ 残り <strong>${left}</strong> ${unit}（${a.done} / ${a.amount}）`;
    }
    if (a.type === 'done') return a.amount ? `${a.amount} ${unit} やった` : '記録なし';
    return a.amount ? `予定 ${a.amount} ${unit}` : 'この日の予定量はありません';
  }

  let schedDate = today();

  // 科目の色。検証済みの4色を科目に順に割り当て、5科目目以降と科目なし・タスク以外は「その他」の色にする
  const SUBJECT_COLOR_SLOTS = 4;

  function subjectColors() {
    const subjects = state.tasks.map((x) => x.subject).filter(Boolean);
    const next = S.assignSubjectColors(subjects, state.subjectColors || {}, SUBJECT_COLOR_SLOTS);
    if (JSON.stringify(next) !== JSON.stringify(state.subjectColors || {})) {
      state.subjectColors = next;
      save();
    }
    return next;
  }

  function subjectClass(subject, colors) {
    return subject && subject in colors ? `subj-${colors[subject]}` : 'subj-other';
  }

  function blockSubject(block, colors) {
    const task = blockTask(block);
    const subject = task && task.subject ? task.subject : '';
    const cls = subjectClass(subject, colors);
    return { subject, cls, legend: cls === 'subj-other' ? 'その他' : subject };
  }

  // 時間割タブ: 1日のタイムライン（時間の長さに比例した高さ、空き時間、今の線）
  function renderSchedule() {
    const t = today();
    const d = schedDate;
    document.getElementById('sched-title').textContent = `${fmtDate(d)}${d === t ? '（今日）' : ''}`;
    const blocks = S.blocksOn(state.schedule, d);
    const now = d === t ? S.toMinutes(nowTime()) : null;
    const colors = subjectColors();
    const timeline = document.getElementById('sched-timeline');
    document.getElementById('block-empty').hidden = blocks.length > 0;
    timeline.hidden = blocks.length === 0;

    // 凡例はその日に出てくる科目だけ（色の順に）
    const legend = new Map();
    for (const b of blocks) {
      const s = blockSubject(b, colors);
      legend.set(s.legend, s.cls);
    }
    const order = (cls) => (cls === 'subj-other' ? 99 : Number(cls.slice(5)));
    document.getElementById('sched-legend').innerHTML = [...legend]
      .sort((x, y) => order(x[1]) - order(y[1]))
      .map(([label, cls]) => `<span class="${cls}"><i class="subj-dot"></i>${esc(label)}</span>`).join('');

    if (blocks.length === 0) {
      timeline.innerHTML = '';
      return;
    }
    const rows = S.dayLayout(blocks, { nowMin: now });
    timeline.innerHTML = rows.map((row) => {
      if (row.type === 'gap') {
        return `<div class="tl-gap">${S.fromMinutes(row.from)}〜${S.fromMinutes(row.to)} 空き ${S.formatDuration(row.to - row.from)}</div>`;
      }
      const hours = row.hours.map((h) => `<div class="tl-hour" style="top:${h.top}px"><span>${h.label}</span></div>`).join('');
      const free = row.free.filter((f) => f.height >= 16)
        .map((f) => `<div class="tl-free" style="top:${f.top}px;height:${f.height}px">空き ${S.formatDuration(f.to - f.from)}</div>`).join('');
      const items = row.items.map((item) => timelineBlock(item, d, t, now, colors)).join('');
      const nowLine = row.now === null ? '' : `
        <div class="tl-now" style="top:${row.now}px"><span>${nowTime()}</span></div>`;
      return `
        <div class="tl-seg" style="height:${row.height}px">
          ${hours}
          <div class="tl-area">${free}${items}</div>
          ${nowLine}
        </div>`;
    }).join('');
  }

  function timelineBlock(item, d, t, now, colors) {
    const b = item.block;
    const start = S.toMinutes(b.start);
    const end = S.toMinutes(b.end);
    const isNow = now !== null && start <= now && now < end;
    const isPast = d < t || (now !== null && end <= now);
    const task = blockTask(b);
    const { subject, cls } = blockSubject(b, colors);
    const title = task ? task.title : b.label || '（削除されたタスク）';
    const timeText = `${b.start}–${b.end} ・ ${isNow ? `あと${end - now}分` : S.formatDuration(end - start)}`;
    const amount = blockAmountText(b, d);
    // 高さに入る行数だけ出す: 1行（名前と時刻を横に）/ 2行（名前・時刻）/ 3行（＋ノルマ）
    const short = item.height < 40;
    const showAmount = item.height >= 60;
    const pos = `top:${item.top}px;height:${item.height}px;left:calc(${(item.lane / item.lanes) * 100}% + 2px);width:calc(${100 / item.lanes}% - 4px)`;
    return `
      <button class="tl-block ${cls}${isNow ? ' current' : ''}${isPast ? ' past' : ''}${short ? ' short' : ''}" style="${pos}"
        data-id="${b.id}" title="${esc(`${b.start}〜${b.end} ${title}（${blockRepeatText(b)}）`)}">
        <span class="tl-title">${isNow ? '<span class="tl-now-tag">今</span>' : ''}<i class="subj-dot"></i>${subject ? `<span class="tl-subj">${esc(subject)}</span>` : ''}${esc(title)}</span>
        <span class="tl-time">${timeText}</span>
        ${amount && showAmount ? `<span class="tl-amount">${amount}</span>` : ''}
      </button>`;
  }

  function moveSchedDate(n) {
    schedDate = P.addDays(schedDate, n);
    renderSchedule();
  }
  document.getElementById('sched-prev').addEventListener('click', () => moveSchedDate(-1));
  document.getElementById('sched-next').addEventListener('click', () => moveSchedDate(1));
  document.getElementById('sched-today').addEventListener('click', () => {
    schedDate = today();
    renderSchedule();
  });

  const blockDialog = document.getElementById('block-dialog');
  const blockForm = document.getElementById('block-form');
  let editingBlockId = null;

  document.getElementById('block-days').innerHTML = WEEKDAYS
    .map((w, i) => `<label><input type="checkbox" name="days" value="${i}">${w}</label>`)
    .join('');

  function toggleBlockFields() {
    const once = blockForm.querySelector('input[name="repeat"]:checked').value === 'once';
    document.getElementById('block-days').hidden = once;
    document.getElementById('block-date-field').hidden = !once;
    document.getElementById('block-label-field').hidden = !!blockForm.elements.taskId.value;
  }
  blockForm.addEventListener('change', (e) => {
    if (e.target.name === 'repeat' || e.target.name === 'taskId') toggleBlockFields();
  });

  function openBlockDialog(block) {
    editingBlockId = block ? block.id : null;
    blockForm.reset();
    document.getElementById('block-form-error').textContent = '';
    document.getElementById('block-dialog-title').textContent = block ? '時間を編集' : '時間を追加';
    document.getElementById('btn-block-delete').hidden = !block;

    // 選べるのは終わっていないタスク（編集中のコマのタスクは終わっていても残す）
    const t = today();
    const tasks = state.tasks.filter((x) => (block && x.id === block.taskId) || P.analyzeTask(x, state.logs, t).status !== 'done');
    blockForm.elements.taskId.innerHTML = tasks
      .map((x) => `<option value="${x.id}">${esc(x.subject ? `${x.subject}: ${x.title}` : x.title)}</option>`)
      .join('') + '<option value="">タスク以外（内容を入力）</option>';

    const dow = P.parseDate(schedDate).getDay();
    const values = block || { start: '19:00', end: '20:00', taskId: tasks.length ? tasks[0].id : '', label: '', days: [dow] };
    blockForm.elements.start.value = values.start;
    blockForm.elements.end.value = values.end;
    blockForm.elements.taskId.value = blockTask(values) ? values.taskId : '';
    blockForm.elements.label.value = values.label || '';
    blockForm.elements.date.value = values.date || schedDate;
    blockForm.querySelector(`input[name="repeat"][value="${values.date ? 'once' : 'weekly'}"]`).checked = true;
    blockForm.querySelectorAll('input[name="days"]').forEach((cb) => {
      cb.checked = (values.days || [dow]).includes(Number(cb.value));
    });
    toggleBlockFields();
    blockDialog.showModal();
  }

  blockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = blockForm.elements;
    const once = blockForm.querySelector('input[name="repeat"]:checked').value === 'once';
    const task = state.tasks.find((x) => x.id === f.taskId.value);
    const block = {
      id: editingBlockId || newId(),
      start: f.start.value,
      end: f.end.value,
      label: task ? task.title : f.label.value.trim(),
    };
    if (task) block.taskId = task.id;
    if (once) block.date = f.date.value;
    else block.days = [...blockForm.querySelectorAll('input[name="days"]:checked')].map((cb) => Number(cb.value));
    if (once && !block.date) {
      document.getElementById('block-form-error').textContent = '日付を入力してください。';
      return;
    }
    const error = S.validate(block);
    if (error) {
      document.getElementById('block-form-error').textContent = error;
      return;
    }
    const clash = S.overlaps(state.schedule, block);
    if (clash.length && !(await askConfirm(`${clash.map((b) => `${b.start}〜${b.end}`).join('、')} のコマと時間が重なります。このまま保存しますか？`, { ok: '保存する' }))) return;

    const i = state.schedule.findIndex((x) => x.id === block.id);
    if (i >= 0) state.schedule[i] = block;
    else state.schedule.push(block);
    save();
    blockDialog.close();
    if (once) schedDate = block.date;
    renderAll();
  });

  document.getElementById('btn-add-block').addEventListener('click', () => openBlockDialog(null));
  document.getElementById('btn-block-cancel').addEventListener('click', () => blockDialog.close());
  document.getElementById('btn-block-delete').addEventListener('click', async () => {
    const block = state.schedule.find((x) => x.id === editingBlockId);
    if (!block || !(await askConfirm(`${block.start}〜${block.end} のコマを削除しますか？`, { ok: '削除', danger: true }))) return;
    state.schedule = state.schedule.filter((x) => x.id !== editingBlockId);
    save();
    blockDialog.close();
    renderAll();
  });
  document.getElementById('sched-timeline').addEventListener('click', (e) => {
    const el = e.target.closest('.tl-block');
    if (!el) return;
    openBlockDialog(state.schedule.find((x) => x.id === el.dataset.id));
  });

  // 時刻の表示を保つため、1分ごとに「今」を更新する（日付が変わっていたら全体を描き直す）
  let renderedDate = today();
  setInterval(() => {
    if (today() !== renderedDate) {
      renderedDate = today();
      schedDate = renderedDate;
      renderAll();
      return;
    }
    // 入力中の欄を消さないよう、今日タブの中にフォーカスがあるときは描き直さない
    if (!todayFlow.contains(document.activeElement)) renderToday();
    if (schedDate === renderedDate) renderSchedule();
  }, 30 * 1000);

  // ---------- 達成度 ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const tooltip = document.getElementById('chart-tooltip');

  function pct(rate) {
    return `${Math.round(rate * 100)}%`;
  }

  function chartWidth(el) {
    return Math.max(280, Math.min(720, el.clientWidth || 640));
  }

  // 上端だけ角を丸めた縦棒（4px）。高さが小さいときは丸めを縮める
  function columnPath(x, y, w, h) {
    const r = Math.min(4, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // 右端だけ角を丸めた横棒
  function barPath(x, y, w, h) {
    const r = Math.min(4, w, h / 2);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  function renderStats() {
    const t = today();
    const series = P.achievementSeries(state.tasks, state.logs, t, 14);
    const todayAch = series[series.length - 1];
    const week = series.slice(-7).filter((d) => d.rate !== null);
    const weekAvg = week.length ? week.reduce((s, d) => s + d.rate, 0) / week.length : null;
    const analyses = state.tasks.map((task) => ({ task, a: P.analyzeTask(task, state.logs, t) }));
    const lagging = analyses.filter(({ a }) => a.status === 'behind' || a.status === 'overdue').length;
    const doneCount = analyses.filter(({ a }) => a.status === 'done').length;

    const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
    document.getElementById('stat-tiles').innerHTML = [
      tile('今日の達成率', todayAch.rate === null ? '–' : pct(todayAch.rate), todayAch.count ? `ノルマ達成 ${todayAch.cleared} / ${todayAch.count}` : '今日のノルマはありません'),
      tile('直近7日の平均', weekAvg === null ? '–' : pct(weekAvg), `ノルマのあった ${week.length} 日の平均`),
      tile('連続達成', `${P.streak(state.tasks, state.logs, t)}<small>日</small>`, 'ノルマのない日は数えません'),
      tile('計画より遅れ', `${lagging}<small>件</small>`, `完了 ${doneCount} / 全 ${state.tasks.length} 件`),
    ].join('');

    renderForecast(t);
    renderDailyChart(series, t);
    renderProgressChart(analyses.filter(({ a }) => a.status !== 'done'), t);
  }

  function renderDailyChart(series, t) {
    const el = document.getElementById('chart-daily');
    const W = chartWidth(el);
    const H = 200;
    const m = { top: 20, right: 8, bottom: 26, left: 38 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const slot = iw / series.length;
    const bw = Math.min(24, slot - 6);
    const y = (rate) => m.top + ih * (1 - rate);
    const everyOther = slot < 38;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日ごとのノルマ達成率のグラフ（直近14日）">`;
    for (const v of [0, 0.5, 1]) {
      svg += `<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end">${pct(v)}</text>`;
    }
    series.forEach((d, i) => {
      const cx = m.left + slot * i + slot / 2;
      const date = P.parseDate(d.date);
      if (!everyOther || (series.length - 1 - i) % 2 === 0) {
        svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle"${d.date === t ? ' class="value"' : ''}>${d.date === t ? '今日' : `${date.getMonth() + 1}/${date.getDate()}`}</text>`;
      }
      const label = d.rate === null ? 'ノルマなし' : pct(d.rate);
      const detail = d.count ? `ノルマ達成 ${d.cleared} / ${d.count} 件` : '';
      svg += `<g class="datum" tabindex="0" data-title="${fmtDate(d.date)}" data-value="${label}" data-detail="${detail}">`;
      svg += `<rect class="hit" x="${m.left + slot * i}" y="${m.top}" width="${slot}" height="${ih}"/>`;
      if (d.rate === null) {
        svg += `<text class="empty-mark" x="${cx}" y="${y(0) - 4}" text-anchor="middle">–</text>`;
      } else if (d.rate > 0) {
        svg += `<path class="mark" d="${columnPath(cx - bw / 2, y(d.rate), bw, ih * d.rate)}"/>`;
      }
      svg += '</g>';
      // 値の数字は今日の棒にだけ付ける（ほかはツールチップと表で見る）
      if (d.date === t && d.rate !== null) {
        svg += `<text class="value" x="${cx}" y="${y(d.rate) - 6}" text-anchor="middle">${pct(d.rate)}</text>`;
      }
    });
    svg += '</svg>';
    el.innerHTML = svg;

    document.getElementById('table-daily').innerHTML = `
      <thead><tr><th>日付</th><th>達成率</th><th>ノルマ達成</th></tr></thead>
      <tbody>${series.slice().reverse().map((d) => `<tr><td>${fmtDate(d.date)}</td><td>${d.rate === null ? '–' : pct(d.rate)}</td><td>${d.count ? `${d.cleared} / ${d.count}` : '–'}</td></tr>`).join('')}</tbody>`;
  }

  function renderProgressChart(items, t) {
    const el = document.getElementById('chart-progress');
    document.getElementById('progress-legend').hidden = items.length === 0;
    if (items.length === 0) {
      el.innerHTML = '<p class="chart-empty">進行中のタスクはありません。</p>';
      document.getElementById('table-progress').innerHTML = '';
      return;
    }
    items.sort((x, y) => x.task.deadline.localeCompare(y.task.deadline));
    const W = chartWidth(el);
    const rowH = 40;
    const m = { top: 4, right: 48, left: 0 };
    const iw = W - m.left - m.right;
    const H = m.top + rowH * items.length;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="タスク別の進み具合のグラフ">`;
    items.forEach(({ task, a }, i) => {
      const top = m.top + rowH * i;
      const barY = top + 20;
      const expected = task.total ? Math.min(1, P.expectedDone(task, t) / task.total) : 0;
      const name = task.subject ? `${task.subject}: ${task.title}` : task.title;
      svg += `<text x="${m.left}" y="${top + 13}">${esc(name)}</text>`;
      svg += `<g class="datum" tabindex="0" data-title="${esc(name)}" data-value="${pct(a.progress)}" data-detail="${a.done} / ${task.total} ${esc(task.unit)} ・ 計画の目安 ${pct(expected)} ・ ${STATUS_LABEL[a.status]}">`;
      svg += `<rect class="hit" x="${m.left}" y="${top}" width="${W - m.left}" height="${rowH}"/>`;
      svg += `<rect class="track" x="${m.left}" y="${barY}" width="${iw}" height="10" rx="5"/>`;
      if (a.progress > 0) svg += `<path class="mark" d="${barPath(m.left, barY, Math.max(2, iw * a.progress), 10)}"/>`;
      svg += '</g>';
      const ex = m.left + iw * expected;
      svg += `<line class="tick-mark" x1="${ex}" x2="${ex}" y1="${barY - 4}" y2="${barY + 14}"/>`;
      svg += `<text class="value" x="${W - 4}" y="${barY + 9}" text-anchor="end">${pct(a.progress)}</text>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;

    document.getElementById('table-progress').innerHTML = `
      <thead><tr><th>タスク</th><th>終えた量</th><th>割合</th><th>計画の目安</th><th>状態</th></tr></thead>
      <tbody>${items.map(({ task, a }) => `<tr><td>${esc(task.title)}</td><td>${a.done} / ${task.total} ${esc(task.unit)}</td><td>${pct(a.progress)}</td><td>${pct(task.total ? Math.min(1, P.expectedDone(task, t) / task.total) : 0)}</td><td>${STATUS_LABEL[a.status]}</td></tr>`).join('')}</tbody>`;
  }

  // ---------- 完了の見通し ----------

  let forecastTaskId = null;

  function renderForecast(t) {
    const colors = subjectColors();
    const items = state.tasks
      .map((task) => ({ task, a: P.analyzeTask(task, state.logs, t), p: P.projectFinish(task, state.logs, t) }))
      .filter(({ a }) => a.status !== 'done' && a.status !== 'notStarted')
      // 遅れの大きい順。見通せないものは最後
      .sort((x, y) => (y.p.date ? y.p.delay : -Infinity) - (x.p.date ? x.p.delay : -Infinity));

    const list = document.getElementById('forecast-list');
    const area = document.getElementById('forecast-chart-area');
    if (items.length === 0) {
      list.innerHTML = '<li class="chart-empty">進行中のタスクはありません。</li>';
      area.hidden = true;
      return;
    }
    if (!items.some((x) => x.task.id === forecastTaskId)) forecastTaskId = items[0].task.id;

    list.innerHTML = items.map(({ task, p }) => {
      const unit = esc(task.unit);
      const required = P.requiredPace(task, state.logs, t);
      let paceLine;
      if (p.pace === null) paceLine = 'まだ記録がありません';
      else {
        paceLine = `最近 ${paceText1(p.pace)}${unit}/日 ・ 必要 ${required === null ? '–' : perDayText(required)}${unit}/日`;
        if (p.sampleDays < 5) paceLine += ` ・ 記録${p.sampleDays}日分の参考値`;
      }
      let chip;
      if (!p.date) chip = '<span class="fc-chip">見通せません</span>';
      else chip = `<span class="fc-chip ${p.delay > 0 ? 'late' : 'ok'}">${delayText(p.delay)}</span>`;
      return `
        <li><button class="fc-row ${subjectClass(task.subject, colors)}${task.id === forecastTaskId ? ' selected' : ''}" data-id="${task.id}" aria-pressed="${task.id === forecastTaskId}">
          <span class="fc-main"><span class="fc-title"><i class="subj-dot"></i>${task.subject ? `<span class="tl-subj">${esc(task.subject)}</span>` : ''}${esc(task.title)}</span>
            <span class="meta">${paceLine}</span></span>
          <span class="fc-when"><strong>${p.date ? `${fmtDate(p.date)}` : '–'}</strong>${chip}</span>
        </button></li>`;
    }).join('');

    area.hidden = false;
    const selected = items.find((x) => x.task.id === forecastTaskId);
    renderForecastChart(selected.task, selected.p, t, colors);
  }

  // 累計の折れ線: 実績（開始日〜今日）、当初の計画（開始日〜期限）、このペースの見込み（今日〜終わる日）
  function renderForecastChart(task, p, t, colors) {
    const el = document.getElementById('chart-forecast');
    document.getElementById('forecast-chart-area').className = subjectClass(task.subject, colors);
    const W = chartWidth(el);
    const H = 220;
    const m = { top: 24, right: 14, bottom: 26, left: 40 };
    const start = task.startDate;
    let end = task.deadline > t ? task.deadline : t;
    if (p.date && p.date > end) end = p.date;
    end = P.addDays(end, 2);
    const span = Math.max(1, P.diffDays(start, end));
    const x = (d) => m.left + (P.diffDays(start, d) / span) * (W - m.left - m.right);
    const y = (v) => m.top + (1 - Math.min(v, task.total) / task.total) * (H - m.top - m.bottom);
    const unit = esc(task.unit);

    // 実績の累計を1日ずつ
    let cum = P.doneBefore(task, state.logs, start);
    const points = [];
    for (let d = start; d <= t; d = P.addDays(d, 1)) {
      cum += P.doneOn(task, state.logs, d);
      points.push([x(d), y(cum)]);
    }
    const last = points[points.length - 1];
    const fmt = (n) => Math.round(n * 10) / 10;
    const xd = fmt(x(task.deadline));

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(task.title)}の累計。今日までに${Math.min(cum, task.total)}${unit}。${p.date ? `最近のペースだと${fmtDate(p.date)}に終わる見込み。` : ''}期限は${fmtDate(task.deadline)}">`;
    for (const v of [0, task.total / 2, task.total]) {
      svg += `<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${fmt(y(v))}" y2="${fmt(y(v))}"/>`;
      svg += `<text x="${m.left - 6}" y="${fmt(y(v)) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    }
    // 期限の線と日付
    svg += `<line class="fc-deadline" x1="${xd}" x2="${xd}" y1="${m.top}" y2="${H - m.bottom}"/>`;
    svg += `<text class="value" x="${xd}" y="${m.top - 10}" text-anchor="middle">期限</text>`;
    const ticks = [[start, 'start'], [task.deadline, 'middle']];
    if (p.date && Math.abs(x(p.date) - x(task.deadline)) > 44 && Math.abs(x(p.date) - x(start)) > 44) ticks.push([p.date, 'middle']);
    for (const [d, anchor] of ticks) {
      const dt = P.parseDate(d);
      svg += `<text x="${fmt(x(d))}" y="${H - 8}" text-anchor="${anchor}">${dt.getMonth() + 1}/${dt.getDate()}</text>`;
    }
    // 当初の計画
    svg += `<line class="fc-plan" x1="${fmt(x(start))}" y1="${fmt(y(task.initialDone || 0))}" x2="${xd}" y2="${fmt(y(task.total))}"/>`;
    // このペースの見込み
    if (p.date && last) {
      const xp = fmt(x(p.date));
      svg += `<line class="fc-proj" x1="${fmt(last[0])}" y1="${fmt(last[1])}" x2="${xp}" y2="${fmt(y(task.total))}"/>`;
      svg += `<circle class="fc-end" cx="${xp}" cy="${fmt(y(task.total))}" r="4"/>`;
      if (Math.abs(xp - xd) > 44) svg += `<text class="value" x="${Math.min(xp, W - m.right - 30)}" y="${m.top - 10}" text-anchor="middle">見込み</text>`;
    }
    // 実績
    if (points.length) {
      svg += `<path class="fc-actual" d="M${points.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(' L')}"/>`;
      svg += `<circle class="fc-now" cx="${fmt(last[0])}" cy="${fmt(last[1])}" r="4.5"/>`;
      const lx = Math.min(last[0] + 8, W - m.right - 70);
      svg += `<text class="value" x="${fmt(lx)}" y="${fmt(Math.min(last[1] + 16, H - m.bottom - 6))}">${Math.min(cum, task.total)}${unit}（今日）</text>`;
    }
    svg += '</svg>';
    el.innerHTML = svg;

    const lagging = p.date && p.delay > 0;
    document.getElementById('forecast-actions').innerHTML = lagging
      ? `<button data-action="recover" data-id="${task.id}">「${esc(task.title)}」を立て直す</button>`
      : '';
  }

  document.getElementById('forecast-list').addEventListener('click', (e) => {
    const row = e.target.closest('.fc-row');
    if (!row) return;
    forecastTaskId = row.dataset.id;
    renderForecast(today());
  });

  document.getElementById('forecast-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="recover"]');
    if (btn) openRecover(state.tasks.find((x) => x.id === btn.dataset.id));
  });

  // ツールチップ（マウスでもキーボードのフォーカスでも同じ内容を出す）
  function showTooltip(datum, x, y) {
    tooltip.replaceChildren();
    const value = document.createElement('strong');
    value.textContent = datum.dataset.value;
    const title = document.createElement('div');
    title.className = 'tt-label';
    title.textContent = datum.dataset.title;
    tooltip.append(value, title);
    if (datum.dataset.detail) {
      const detail = document.createElement('div');
      detail.textContent = datum.dataset.detail;
      tooltip.append(detail);
    }
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 12))}px`;
    tooltip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  }

  const statsView = document.getElementById('view-stats');
  statsView.addEventListener('pointermove', (e) => {
    const datum = e.target.closest('.datum');
    if (datum) showTooltip(datum, e.clientX, e.clientY);
    else tooltip.hidden = true;
  });
  statsView.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  statsView.addEventListener('focusin', (e) => {
    const datum = e.target.closest('.datum');
    if (!datum) return;
    const r = datum.getBoundingClientRect();
    showTooltip(datum, r.left + r.width / 2, r.top);
  });
  statsView.addEventListener('focusout', () => { tooltip.hidden = true; });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (statsView.classList.contains('active')) renderStats();
    }, 150);
  });

  renderAll();
})();
