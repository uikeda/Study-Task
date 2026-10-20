(function () {
  'use strict';

  const P = window.Planner;
  const STORAGE_KEY = 'study-task-v1';
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const STATUS_LABEL = {
    ontrack: '順調', ahead: '先行', behind: '遅れ', overdue: '期限超過',
    done: '完了', rest: '休息日', upcoming: '開始前',
  };

  // ---- 状態 ----
  let state = load();
  let selectedDay = P.toKey(new Date());
  let editingId = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        return {
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          settings: { restDays: [], ...(data.settings || {}) },
        };
      }
    } catch (e) {
      console.error('データの読み込みに失敗しました', e);
    }
    return { tasks: [], settings: { restDays: [] } };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      alert('保存に失敗しました。ブラウザの保存領域を確認してください。');
    }
  }

  const today = () => P.toKey(new Date());
  const restDays = () => state.settings.restDays;
  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDate(key) {
    const d = P.parseKey(key);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  }

  function pct(n, d) {
    return d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0;
  }

  function daysLeftLabel(task, dayKey) {
    const n = P.diffDays(dayKey, task.deadline);
    if (n < 0) return `期限を${-n}日超過`;
    if (n === 0) return '今日が期限';
    return `期限まで残り${n}日`;
  }

  // ---- タブ ----
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    try { localStorage.setItem(`${STORAGE_KEY}-view`, name); } catch (e) { /* 無視 */ }
    render();
  }

  function currentView() {
    const active = document.querySelector('.tab.active');
    return active ? active.dataset.view : 'today';
  }

  function render() {
    const view = currentView();
    if (view === 'today') renderToday();
    else if (view === 'tasks') renderTasks();
    else if (view === 'plan') renderPlan();
    else if (view === 'settings') renderSettings();
  }

  // ---- 今日 ----
  function renderToday() {
    const day = selectedDay;
    $('#day-picker').value = day;
    $('#day-weekday').textContent = `(${WEEKDAYS[P.weekday(day)]})${day === today() ? ' 今日' : ''}`;

    // 対象日に関係するタスク：開始済みで、未完了 or 対象日に記録あり
    const relevant = state.tasks.filter((t) => (
      day >= t.startDate && (P.doneBefore(t, day) < t.total || P.doneOn(t, day) > 0)
    ));
    const items = P.sortByPriority(relevant, day, restDays()).map((t) => {
      const quota = P.quotaFor(t, day, restDays());
      const doneToday = P.doneOn(t, day);
      return { t, quota, doneToday, achieved: quota > 0 ? doneToday >= quota : doneToday > 0 };
    });

    const withQuota = items.filter((i) => i.quota > 0);
    const achieved = withQuota.filter((i) => i.doneToday >= i.quota).length;
    const behind = items.filter((i) => ['behind', 'overdue'].includes(P.paceStatus(i.t, day, restDays()).status)).length;

    $('#today-summary').innerHTML = `
      <div><div class="stat-value">${achieved} / ${withQuota.length}</div><div class="stat-label">ノルマ達成</div></div>
      <div><div class="stat-value">${pct(achieved, withQuota.length)}%</div><div class="stat-label">達成率</div></div>
      <div><div class="stat-value">${behind}</div><div class="stat-label">遅れ・超過</div></div>
      ${P.isStudyDay(day, restDays()) ? '' : '<div><div class="stat-value">休</div><div class="stat-label">休息日</div></div>'}
    `;

    const list = $('#today-list');
    if (state.tasks.length === 0) {
      list.innerHTML = '<div class="empty">タスクがありません。「タスク」タブから追加してください。</div>';
      return;
    }
    if (items.length === 0) {
      list.innerHTML = '<div class="empty">この日に取り組むタスクはありません。</div>';
      return;
    }

    list.innerHTML = items.map(({ t, quota, doneToday, achieved: ok }) => {
      const pace = P.paceStatus(t, day, restDays());
      const status = quota === 0 && pace.status !== 'done' && P.doneBefore(t, day) < t.total ? 'rest' : pace.status;
      const total = P.doneTotal(t);
      return `
        <article class="card ${ok ? 'achieved' : ''}" data-id="${esc(t.id)}">
          <div class="card-head">
            <div>
              <div class="card-title">${ok ? '✅ ' : ''}${esc(t.title)}</div>
              <div class="card-sub">${t.subject ? esc(t.subject) + ' · ' : ''}${daysLeftLabel(t, day)}</div>
            </div>
            <span class="badge ${status}">${STATUS_LABEL[status]}</span>
          </div>
          <div class="quota">
            ${quota > 0
              ? `今日のノルマ <strong>${quota}</strong> ${esc(t.unit)}`
              : '今日のノルマはありません'}
          </div>
          ${quota > 0 ? `
            <div class="progress today"><div style="width:${pct(doneToday, quota)}%"></div></div>
            <div class="progress-label"><span>今日 ${doneToday} / ${quota} ${esc(t.unit)}</span><span>${pct(doneToday, quota)}%</span></div>
          ` : ''}
          <div class="progress"><div style="width:${pct(total, t.total)}%"></div></div>
          <div class="progress-label"><span>全体 ${total} / ${t.total} ${esc(t.unit)}</span><span>${pct(total, t.total)}%</span></div>
          <div class="log-row">
            <label>この日の実績 <input type="number" min="0" step="1" class="log-input" value="${doneToday}"></label>
            <span>${esc(t.unit)}</span>
            <button class="small-btn" data-action="plus">＋1</button>
            ${quota > 0 ? '<button class="small-btn" data-action="fill">ノルマ達成</button>' : ''}
          </div>
        </article>`;
    }).join('');
  }

  function setLog(taskId, dayKey, amount) {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.logs = t.logs || {};
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    // 総量を超える記録は総量までに丸める
    const others = P.doneTotal(t) - P.doneOn(t, dayKey);
    const clamped = Math.min(value, Math.max(0, t.total - others));
    if (clamped > 0) t.logs[dayKey] = clamped;
    else delete t.logs[dayKey];
    save();
    render();
  }

  // ---- タスク一覧 ----
  function renderTasks() {
    const list = $('#task-list');
    if (state.tasks.length === 0) {
      list.innerHTML = '<div class="empty">まだタスクがありません。「＋ タスクを追加」から登録しましょう。<br>例: 「数学 問題集」を 200問、期限 11/30</div>';
      return;
    }
    const day = today();
    const sorted = [...state.tasks].sort((a, b) => a.deadline.localeCompare(b.deadline));
    list.innerHTML = sorted.map((t) => {
      const total = P.doneTotal(t);
      let status = P.paceStatus(t, day, restDays()).status;
      if (day < t.startDate && status !== 'done') status = 'upcoming';
      const quota = P.quotaFor(t, day, restDays());
      return `
        <article class="card" data-id="${esc(t.id)}">
          <div class="card-head">
            <div>
              <div class="card-title">${esc(t.title)}</div>
              <div class="card-sub">${t.subject ? esc(t.subject) + ' · ' : ''}${fmtDate(t.startDate)} 〜 ${fmtDate(t.deadline)} · ${daysLeftLabel(t, day)}</div>
            </div>
            <span class="badge ${status}">${STATUS_LABEL[status]}</span>
          </div>
          <div class="progress"><div style="width:${pct(total, t.total)}%"></div></div>
          <div class="progress-label"><span>${total} / ${t.total} ${esc(t.unit)}（残り ${Math.max(0, t.total - total)}）</span><span>${pct(total, t.total)}%</span></div>
          <div class="log-row">
            <span class="card-sub">${status === 'done' ? '完了しました' : `今日のノルマ: ${quota} ${esc(t.unit)}`}</span>
            <span style="flex:1"></span>
            <button class="small-btn" data-action="edit">編集</button>
            <button class="danger-btn" data-action="delete">削除</button>
          </div>
        </article>`;
    }).join('');
  }

  function openDialog(task) {
    editingId = task ? task.id : null;
    const f = $('#task-form').elements;
    $('#task-form').reset();
    $('#dialog-title').textContent = task ? 'タスクを編集' : 'タスクを追加';
    $('#form-error').textContent = '';
    const d = today();
    f.title.value = task ? task.title : '';
    f.subject.value = task ? task.subject || '' : '';
    f.total.value = task ? task.total : '';
    f.unit.value = task ? task.unit : 'ページ';
    f.initialDone.value = task ? task.initialDone || 0 : 0;
    f.startDate.value = task ? task.startDate : d;
    f.deadline.value = task ? task.deadline : P.addDays(d, 13);
    updatePreview();
    $('#task-dialog').showModal();
    f.title.focus();
  }

  function readForm() {
    const f = $('#task-form').elements;
    return {
      title: f.title.value.trim(),
      subject: f.subject.value.trim(),
      total: Math.floor(Number(f.total.value)),
      unit: f.unit.value.trim() || '個',
      initialDone: Math.max(0, Math.floor(Number(f.initialDone.value) || 0)),
      startDate: f.startDate.value,
      deadline: f.deadline.value,
    };
  }

  function validate(v, existing) {
    if (!v.title) return 'タスク名を入力してください。';
    if (!(v.total >= 1)) return '総量は1以上の整数で入力してください。';
    if (!v.startDate || !v.deadline) return '開始日と期限を入力してください。';
    if (v.deadline < v.startDate) return '期限は開始日以降にしてください。';
    const logged = existing ? P.doneTotal({ ...existing, initialDone: 0 }) : 0;
    if (v.initialDone + logged > v.total) return '完了済みの量が総量を超えています。';
    return '';
  }

  function updatePreview() {
    const v = readForm();
    const preview = $('#form-preview');
    const existing = state.tasks.find((t) => t.id === editingId);
    if (validate(v, existing)) { preview.textContent = ''; return; }
    const draft = { ...v, logs: existing ? existing.logs : {} };
    const from = today() > v.startDate ? today() : v.startDate;
    const q = P.quotaFor(draft, from, restDays());
    const days = P.countStudyDays(from, v.deadline, restDays());
    preview.textContent = q > 0
      ? `→ ${fmtDate(from)} 時点で 1日あたり約 ${q} ${v.unit}（学習日 ${days}日）`
      : '';
  }

  function submitForm(e) {
    e.preventDefault();
    const v = readForm();
    const existing = state.tasks.find((t) => t.id === editingId);
    const err = validate(v, existing);
    if (err) { $('#form-error').textContent = err; return; }
    if (existing) Object.assign(existing, v);
    else state.tasks.push({ id: newId(), ...v, logs: {}, createdAt: new Date().toISOString() });
    save();
    $('#task-dialog').close();
    render();
  }

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---- 計画 ----
  function renderPlan() {
    const day = today();
    const active = state.tasks.filter((t) => P.doneTotal(t) < t.total);
    const days = Array.from({ length: 7 }, (_, i) => P.addDays(day, i));
    const table = $('#forecast-table');

    if (active.length === 0) {
      table.innerHTML = '<tr><td class="zero">進行中のタスクはありません</td></tr>';
    } else {
      const head = `<tr><th>タスク</th>${days.map((d) => (
        `<th class="${P.isStudyDay(d, restDays()) ? '' : 'rest'}">${fmtDate(d)}${d === day ? '<br>今日' : ''}</th>`
      )).join('')}</tr>`;
      const rows = P.sortByPriority(active, day, restDays()).map((t) => {
        const f = P.forecast(t, day, 7, restDays());
        return `<tr><td>${esc(t.title)}</td>${f.map((x) => (
          `<td class="${x.amount ? '' : 'zero'}">${x.amount ? `${x.amount}<small> ${esc(t.unit)}</small>` : '–'}</td>`
        )).join('')}</tr>`;
      }).join('');
      table.innerHTML = head + rows;
    }

    // 過去14日：その日にノルマがあったタスクのうち達成した割合
    const hist = Array.from({ length: 14 }, (_, i) => P.addDays(day, i - 13));
    $('#history').innerHTML = hist.map((d) => {
      const withQuota = state.tasks
        .map((t) => ({ q: P.quotaFor(t, d, restDays()), done: P.doneOn(t, d) }))
        .filter((x) => x.q > 0);
      const ok = withQuota.filter((x) => x.done >= x.q).length;
      const ratio = withQuota.length ? ok / withQuota.length : null;
      let bg = '';
      if (ratio === 0) bg = 'background: var(--bad-soft);';
      else if (ratio !== null) bg = `background: color-mix(in srgb, var(--ok) ${Math.round(ratio * 70) + 15}%, var(--surface));`;
      const label = ratio === null ? '' : `${ok}/${withQuota.length}`;
      return `<div><div class="history-cell" style="${bg}" title="${fmtDate(d)} ${label}">${label}</div><div class="history-day">${P.parseKey(d).getDate()}</div></div>`;
    }).join('');
  }

  // ---- 設定 ----
  function renderSettings() {
    $('#rest-days').innerHTML = WEEKDAYS.map((w, i) => (
      `<label><input type="checkbox" value="${i}" ${restDays().includes(i) ? 'checked' : ''}> ${w}</label>`
    )).join('');
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `study-task-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.tasks)) throw new Error('tasks がありません');
        if (!confirm(`${data.tasks.length}件のタスクを読み込みます。現在のデータは上書きされます。よろしいですか？`)) return;
        state = { tasks: data.tasks, settings: { restDays: [], ...(data.settings || {}) } };
        save();
        render();
        alert('インポートしました。');
      } catch (e) {
        alert(`インポートに失敗しました: ${e.message}`);
      }
    };
    reader.readAsText(file);
  }

  // ---- イベント ----
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  $('#prev-day').addEventListener('click', () => { selectedDay = P.addDays(selectedDay, -1); render(); });
  $('#next-day').addEventListener('click', () => { selectedDay = P.addDays(selectedDay, 1); render(); });
  $('#go-today').addEventListener('click', () => { selectedDay = today(); render(); });
  $('#day-picker').addEventListener('change', (e) => { if (e.target.value) { selectedDay = e.target.value; render(); } });

  $('#today-list').addEventListener('change', (e) => {
    if (!e.target.classList.contains('log-input')) return;
    setLog(e.target.closest('.card').dataset.id, selectedDay, e.target.value);
  });
  $('#today-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('.card').dataset.id;
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    if (btn.dataset.action === 'plus') setLog(id, selectedDay, P.doneOn(t, selectedDay) + 1);
    if (btn.dataset.action === 'fill') {
      setLog(id, selectedDay, Math.max(P.doneOn(t, selectedDay), P.quotaFor(t, selectedDay, restDays())));
    }
  });

  $('#add-task').addEventListener('click', () => openDialog(null));
  $('#task-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const t = state.tasks.find((x) => x.id === btn.closest('.card').dataset.id);
    if (!t) return;
    if (btn.dataset.action === 'edit') openDialog(t);
    if (btn.dataset.action === 'delete' && confirm(`「${t.title}」を削除しますか？記録も削除されます。`)) {
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      save();
      render();
    }
  });

  $('#task-form').addEventListener('submit', submitForm);
  $('#task-form').addEventListener('input', () => { $('#form-error').textContent = ''; updatePreview(); });
  $('#cancel-task').addEventListener('click', () => $('#task-dialog').close());

  $('#rest-days').addEventListener('change', () => {
    const checked = [...document.querySelectorAll('#rest-days input:checked')].map((i) => Number(i.value));
    if (checked.length === 7) {
      alert('すべての曜日を休息日にはできません。');
      renderSettings();
      return;
    }
    state.settings.restDays = checked;
    save();
  });
  $('#export-btn').addEventListener('click', exportData);
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  $('#clear-btn').addEventListener('click', () => {
    if (!confirm('すべてのタスクと記録を削除します。元に戻せません。よろしいですか？')) return;
    state = { tasks: [], settings: { restDays: [] } };
    save();
    render();
  });

  // 日付が変わったら自動で今日に追従（タブを開きっぱなしの場合）
  let lastToday = today();
  setInterval(() => {
    if (today() !== lastToday) {
      if (selectedDay === lastToday) selectedDay = today();
      lastToday = today();
      render();
    }
  }, 60 * 1000);

  let initialView = 'today';
  try { initialView = localStorage.getItem(`${STORAGE_KEY}-view`) || 'today'; } catch (e) { /* 無視 */ }
  showView(initialView);
})();
