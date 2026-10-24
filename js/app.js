(function () {
  'use strict';

  const P = window.Planner;
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
        return data;
      }
    } catch (e) {
      console.warn('保存データを読み込めませんでした', e);
    }
    return { tasks: [], logs: {}, events: [] };
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

  function renderToday() {
    const t = today();
    document.getElementById('today-label').textContent = `${fmtDate(t)} のタスク`;

    const items = state.tasks
      .map((task) => ({ task, a: P.analyzeTask(task, state.logs, t) }))
      // 今日ノルマがあるもの、今日すでに記録したもの、期限切れで残っているものを表示
      .filter(({ a }) => a.quota > 0 || a.doneToday > 0 || a.status === 'overdue')
      .sort((x, y) => (x.a.quotaLeft === 0) - (y.a.quotaLeft === 0) || x.task.deadline.localeCompare(y.task.deadline));

    const list = document.getElementById('today-list');
    list.innerHTML = items.map(({ task, a }) => todayCard(task, a)).join('');
    document.getElementById('today-empty').hidden = items.length > 0;

    const withQuota = items.filter(({ a }) => a.quota > 0);
    const cleared = withQuota.filter(({ a }) => a.quotaLeft === 0).length;
    document.getElementById('today-summary').textContent =
      withQuota.length > 0 ? `ノルマ達成 ${cleared} / ${withQuota.length}` : '';
  }

  function todayCard(task, a) {
    const cleared = a.quota > 0 && a.quotaLeft === 0;
    let quotaLine;
    if (a.status === 'overdue') {
      quotaLine = `残り <strong>${a.remaining}</strong> ${esc(task.unit)}（期限 ${fmtDate(task.deadline)}）`;
    } else if (a.quota === 0) {
      quotaLine = `今日は学習日ではありません（記録: ${a.doneToday} ${esc(task.unit)}）`;
    } else if (cleared) {
      quotaLine = `ノルマ達成！ <strong>${a.doneToday}</strong> / ${a.quota} ${esc(task.unit)}`;
    } else {
      quotaLine = `今日のノルマ <strong>${a.quotaLeft}</strong> ${esc(task.unit)}（${a.doneToday} / ${a.quota}）`;
    }
    const target = a.quota > 0 ? a.quota : Math.max(a.doneToday, 1);

    return `
      <li class="card${cleared ? ' complete' : ''}" data-id="${task.id}">
        <div class="card-top">${titleHtml(task)}${badge(a.status)}</div>
        <div class="quota">${quotaLine}</div>
        ${bar(a.doneToday / target, cleared)}
        <div class="meta">全体 ${a.done} / ${task.total} ${esc(task.unit)} ・ ${deadlineText(a)}</div>
        <div class="log-row">
          <label>今日やった量 <input type="number" min="0" step="1" value="${a.doneToday}" data-action="set-today"></label>
          ${a.quota > 0 && !cleared ? `<button data-action="fill-quota" data-quota="${a.quota}">ノルマ分を記録</button>` : ''}
        </div>
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

  document.getElementById('btn-delete').addEventListener('click', () => {
    const task = state.tasks.find((x) => x.id === editingId);
    if (!task || !confirm(`「${task.title}」を削除しますか？記録も消えます。`)) return;
    state.tasks = state.tasks.filter((x) => x.id !== editingId);
    // このタスクを元にした復習タスクは残し、ひも付けだけ外す
    for (const x of state.tasks) if (x.reviewOf === editingId) delete x.reviewOf;
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

  document.getElementById('today-list').addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'set-today') return;
    setTodayAmount(e.target.closest('.card').dataset.id, e.target.value);
  });

  document.getElementById('today-list').addEventListener('click', (e) => {
    if (e.target.dataset.action !== 'fill-quota') return;
    setTodayAmount(e.target.closest('.card').dataset.id, e.target.dataset.quota);
  });

  document.getElementById('task-list').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action !== 'edit' && action !== 'add-review') return;
    const task = state.tasks.find((x) => x.id === e.target.closest('.card').dataset.id);
    if (action === 'edit') openDialog(task);
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
      if (!confirm('現在のデータを読み込んだデータで置き換えますか？')) return;
      state = { tasks: data.tasks, logs: data.logs, events: Array.isArray(data.events) ? data.events : [] };
      save();
      renderAll();
    } catch (err) {
      alert(`読み込みに失敗しました: ${err.message}`);
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

  function selectDate(date) {
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
      let countHtml = '';
      if (d === t) {
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
      <div class="btn-row"><button data-action="add-event">＋ この日に試験・模試を追加</button></div>`;
  }

  document.getElementById('cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-day');
    if (!cell) return;
    selectDate(cell.dataset.date);
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

  document.getElementById('btn-event-delete').addEventListener('click', () => {
    const ev = state.events.find((x) => x.id === editingEventId);
    if (!ev || !confirm(`「${ev.title}」を削除しますか？`)) return;
    state.events = state.events.filter((x) => x.id !== editingEventId);
    save();
    eventDialog.close();
    renderAll();
  });

  // ---------- テキスト連携 ----------

  const TF = window.TextFormat;
  const importText = document.getElementById('import-text');
  const preview = document.getElementById('import-preview');

  async function copyText(text, statusId, failMessage) {
    const status = document.getElementById(statusId);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'コピーしました。チャットに貼り付けてください。';
    } catch (err) {
      status.textContent = failMessage;
    }
  }

  document.getElementById('btn-copy-text').addEventListener('click', () => {
    copyText(TF.serialize(state, today()), 'copy-status', 'コピーできませんでした。「ファイルに保存」を使ってください。');
  });

  document.getElementById('btn-copy-prompt').addEventListener('click', () => {
    copyText(TF.planningPrompt(today()), 'prompt-status', 'コピーできませんでした。README のプロンプトを使ってください。');
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

  renderAll();
})();
