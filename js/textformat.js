// 学習計画のテキスト（Markdown）形式への書き出し・読み込み。
// Claude などのチャットに貼り付けて計画を相談し、返ってきたテキストをアプリへ戻すために使う。
// ブラウザでは window.TextFormat、Node では module.exports として使う。
(function (root) {
  'use strict';

  const P = typeof module !== 'undefined' && module.exports ? require('./planner.js') : root.Planner;

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const STATUS_LABEL = {
    onTrack: '順調',
    ahead: '先行',
    behind: '遅れ',
    overdue: '期限切れ',
    done: '完了',
    notStarted: '開始前',
  };

  const HEADER = `# Study Task 学習計画

<!--
このテキストは学習管理アプリ「Study Task」と計画をやり取りするためのものです。
編集するときは次の書式を守り、テキスト全体を返してください。

- タスク1つにつき「## タスク名」の見出しと、その下の「- 項目: 値」の行で書きます。
- 項目
  - id: アプリが付けた識別子。既存タスクでは変更・削除しないでください。新しいタスクには書かないでください。
  - 科目: 任意
  - 量: 全体量と単位（例: 240 問、1900 語、300 ページ）
  - 済: これまでに終えた量（0 以上、全体量以下）
  - 開始: 開始日（YYYY-MM-DD）
  - 期限: 期限日（YYYY-MM-DD）
  - 曜日: 学習する曜日（例: 月火水木金、毎日、平日）
  - タグ: 任意。復習のタスクには「復習」と書きます。
  - 復習元: 復習タスクのとき、復習する元のタスク名（「## 」の後ろと同じ名前）
  - 状況: アプリが書き出す参考情報です。読み込み時は無視されます。
- タスクを消すと、アプリからも削除されます。
- 毎日のノルマはアプリが「残量 ÷ 期限までの学習日数」で自動計算するので、書く必要はありません。
-->
`;

  function isValidDate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    return P.formatDate(P.parseDate(str)) === str;
  }

  function formatWeekdays(days) {
    if (days.length === 7) return '毎日';
    return [...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join('');
  }

  function parseWeekdays(str) {
    const s = str.replace(/\s|曜日?|、|,|・/g, '');
    if (s === '毎日') return ALL_DAYS.slice();
    if (s === '平日') return [1, 2, 3, 4, 5];
    if (s === '土日') return [0, 6];
    const days = [];
    for (const ch of s) {
      const d = WEEKDAYS.indexOf(ch);
      if (d === -1) return null;
      if (!days.includes(d)) days.push(d);
    }
    return days.length > 0 ? days.sort((a, b) => a - b) : null;
  }

  // 全角数字・カンマ混じりの数値も受け付ける
  function toNumber(str) {
    const s = str.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, '').trim();
    return /^\d+$/.test(s) ? Number(s) : NaN;
  }

  function reviewSource(state, task) {
    return task.reviewOf ? state.tasks.find((t) => t.id === task.reviewOf) : null;
  }

  function serialize(state, today) {
    const tasks = [...state.tasks].sort((a, b) => a.deadline.localeCompare(b.deadline));
    const blocks = tasks.map((task) => {
      const a = P.analyzeTask(task, state.logs, today);
      let status = STATUS_LABEL[a.status];
      if (a.quota > 0) status += `（今日のノルマ ${a.quota} ${task.unit}、今日の実績 ${a.doneToday}）`;
      const lines = [
        `## ${task.title}`,
        `- id: ${task.id}`,
        task.subject ? `- 科目: ${task.subject}` : null,
        `- 量: ${task.total} ${task.unit}`,
        `- 済: ${a.done}`,
        `- 開始: ${task.startDate}`,
        `- 期限: ${task.deadline}`,
        `- 曜日: ${formatWeekdays(task.studyDays)}`,
        task.tags && task.tags.length ? `- タグ: ${task.tags.join(' ')}` : null,
        reviewSource(state, task) ? `- 復習元: ${reviewSource(state, task).title}` : null,
        `- 状況: ${status}`,
      ];
      return lines.filter((l) => l !== null).join('\n');
    });
    return `${HEADER}\n書き出し日: ${today}\n\n${blocks.join('\n\n')}\n`;
  }

  // テキストを解析してタスク定義の配列を返す。不正な行はエラーとして行番号付きで集める。
  // チャットの返信を丸ごと貼り付けた場合に備え、コードブロックがあればその中だけを読む
  function extractCodeBlocks(text) {
    const blocks = [...text.matchAll(/^\s*```[^\n]*\n([\s\S]*?)^\s*```/gm)].map((m) => m[1]);
    return blocks.some((b) => /^\s*##\s/m.test(b)) ? blocks.join('\n') : text;
  }

  function parse(text, today) {
    const lines = extractCodeBlocks(text.replace(/\r\n?/g, '\n')).split('\n');
    const tasks = [];
    const errors = [];
    let current = null;
    let inComment = false;

    const finish = () => {
      if (!current) return;
      const t = current;
      const err = (message) => errors.push({ line: t.line, message: `「${t.title}」: ${message}` });
      if (t.total === undefined) err('「量」がありません');
      if (!t.deadline) err('「期限」がありません');
      if (!t.startDate) t.startDate = today;
      if (!t.studyDays) t.studyDays = ALL_DAYS.slice();
      if (t.done === undefined) t.done = 0;
      if (t.deadline && t.startDate && t.deadline < t.startDate) err('期限が開始日より前です');
      if (t.total !== undefined && t.done > t.total) err('「済」が全体量を超えています');
      delete t.line;
      tasks.push(t);
      current = null;
    };

    lines.forEach((raw, i) => {
      const lineNo = i + 1;
      const line = raw.trim();
      // 書式説明の HTML コメントは読み飛ばす
      if (inComment) {
        if (line.includes('-->')) inComment = false;
        return;
      }
      if (line.startsWith('<!--')) {
        if (!line.includes('-->')) inComment = true;
        return;
      }

      const heading = line.match(/^##\s+(.+)$/);
      if (heading) {
        finish();
        current = { title: heading[1].trim(), line: lineNo };
        return;
      }
      if (!current) return; // 最初のタスク見出しより前は説明文として無視

      const item = line.match(/^[-*・]\s*([^:：]+?)\s*[:：]\s*(.*)$/);
      if (!item) return;
      const [, key, value] = item;
      const bad = (message) => errors.push({ line: lineNo, message });

      switch (key) {
        case 'id':
          if (value) current.id = value;
          break;
        case '科目':
          current.subject = value;
          break;
        case 'タグ':
          current.tags = value.split(/[\s,、，・]+/).filter(Boolean);
          break;
        case '復習元':
          if (value) current.reviewOf = value;
          break;
        case '量': {
          const m = value.match(/^([0-9０-９,，]+)\s*(.+)$/);
          const total = m ? toNumber(m[1]) : NaN;
          if (!(total > 0) || !m[2].trim()) bad(`「量」は「240 問」のように数値と単位で書いてください: ${value}`);
          else Object.assign(current, { total, unit: m[2].trim() });
          break;
        }
        case '済': {
          const done = toNumber(value.replace(/[^\d０-９,，]+$/, ''));
          if (Number.isNaN(done)) bad(`「済」は0以上の整数で書いてください: ${value}`);
          else current.done = done;
          break;
        }
        case '開始':
        case '期限':
          if (!isValidDate(value)) bad(`「${key}」は YYYY-MM-DD 形式で書いてください: ${value}`);
          else current[key === '開始' ? 'startDate' : 'deadline'] = value;
          break;
        case '曜日': {
          const days = parseWeekdays(value);
          if (!days) bad(`「曜日」が読み取れません: ${value}`);
          else current.studyDays = days;
          break;
        }
        default:
          break; // 状況など未知の項目は無視
      }
    });
    finish();

    const seen = new Set();
    for (const t of tasks) {
      if (!t.id) continue;
      if (seen.has(t.id)) errors.push({ line: 0, message: `id「${t.id}」が重複しています` });
      seen.add(t.id);
    }
    if (tasks.length === 0 && errors.length === 0) {
      errors.push({ line: 0, message: '「## タスク名」で始まるタスクが見つかりませんでした' });
    }
    return { tasks, errors };
  }

  const FIELDS = ['title', 'subject', 'total', 'unit', 'startDate', 'deadline'];

  function setOptional(obj, key, value) {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  }

  // 解析結果を現在の状態に当てはめた新しい状態と、変更点の一覧を返す（元の state は変更しない）。
  // 「済」の増加は今日の実績として記録し、減少は adjust（補正値）で差し引く。
  function applyImport(state, parsed, today, newId) {
    const next = { ...state, tasks: [], logs: JSON.parse(JSON.stringify(state.logs)) };
    const changes = { added: [], updated: [], removed: [], unchanged: 0 };
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    const kept = new Set();
    const resolved = [];

    for (const p of parsed.tasks) {
      const old = p.id && byId.get(p.id);
      if (!old) {
        next.tasks.push({
          id: newId(),
          createdAt: new Date().toISOString(),
          title: p.title,
          subject: p.subject || '',
          total: p.total,
          unit: p.unit,
          initialDone: p.done,
          startDate: p.startDate,
          deadline: p.deadline,
          studyDays: p.studyDays,
        });
        resolved.push([next.tasks[next.tasks.length - 1], p, null]);
        changes.added.push(p.title);
        continue;
      }

      kept.add(old.id);
      const task = { ...old, subject: p.subject || '', studyDays: p.studyDays };
      resolved.push([task, p, old]);
      for (const f of FIELDS) if (f !== 'subject' && p[f] !== undefined) task[f] = p[f];

      const diffs = [];
      for (const f of FIELDS) if ((old[f] || '') !== (task[f] || '')) diffs.push(f);
      if (old.studyDays.join() !== task.studyDays.join()) diffs.push('studyDays');

      const delta = p.done - P.totalDone(old, state.logs);
      if (delta > 0) {
        if (!next.logs[today]) next.logs[today] = {};
        next.logs[today][old.id] = (next.logs[today][old.id] || 0) + delta;
      } else if (delta < 0) {
        task.adjust = (old.adjust || 0) + delta;
      }
      if (delta !== 0) diffs.push('done');
      task.diffs = diffs;

      next.tasks.push(task);
    }

    // タグと復習元（タスク名で指定）は、全タスクの名前が確定してから当てはめる
    for (const [task, p, old] of resolved) {
      setOptional(task, 'tags', p.tags && p.tags.length ? p.tags : undefined);
      const source = p.reviewOf && (next.tasks.find((t) => t.title === p.reviewOf && !P.isReview(t)) || next.tasks.find((t) => t.title === p.reviewOf && t !== task));
      setOptional(task, 'reviewOf', source ? source.id : undefined);
      if (!old) continue;
      if ((old.tags || []).join() !== (task.tags || []).join() || old.reviewOf !== task.reviewOf) task.diffs.push('tags');
      if (task.diffs.length > 0) changes.updated.push(task.title);
      else changes.unchanged++;
      delete task.diffs;
    }

    for (const old of state.tasks) {
      if (kept.has(old.id)) continue;
      changes.removed.push(old.title);
      for (const [d, entries] of Object.entries(next.logs)) {
        delete entries[old.id];
        if (Object.keys(entries).length === 0) delete next.logs[d];
      }
    }
    return { state: next, changes };
  }

  // チャットで新しく計画を立ててもらうためのプロンプト
  function planningPrompt(today) {
    return `あなたは学習計画を立てるアシスタントです。私の勉強の予定を、学習管理アプリ「Study Task」に読み込める形式で作ってください。

# 進め方
1. まず次の情報を質問してください。私がすでに書いている項目は聞かなくてかまいません。
   - 目標（試験名・試験日など）
   - 使う教材と、それぞれの分量（ページ数・問題数・単語数など）と、すでに終えた量
   - 勉強できる曜日と、1日に使える時間
2. 教材ごとに、1単位あたりの所要時間を見積もってください（例: 数学の問題は1問10分）。
3. その見積もりで、各曜日の合計勉強時間が使える時間に収まるように、各タスクの期限を決めてください。収まらない場合は、無理に詰め込まず、どれを削るか・どこを延ばすかを提案してください。
4. 最後に、計画をコードブロック1つにまとめて出力してください。

# 出力形式（厳守）
- 今日は ${today} です。日付はすべて YYYY-MM-DD 形式で書いてください。
- 1タスクにつき「## タスク名」の見出しと、その下に「- 項目: 値」の行を書きます。
- 使える項目は次のとおりです。これ以外の項目は書かないでください。
  - 科目: 任意
  - 量: 全体量と単位（必須。例: 240 問、300 ページ、1900 語。数値は整数）
  - 済: すでに終えた量（0 なら省略可）
  - 開始: 開始日（省略すると今日）
  - 期限: 期限日（必須。開始日以降）
  - 曜日: 学習する曜日（例: 月水金、毎日、平日、土日。省略すると毎日）
  - タグ: 復習のタスクには「復習」と書く（それ以外は省略）
  - 復習元: 復習タスクのとき、復習する元のタスク名（「## 」の後ろと完全に同じ名前）
- 終えた教材の復習は、元のタスクとは別に「タグ: 復習」のタスクとして作ってください（例: 「青チャート数IA 復習1回目」）。
- 「id」の行は書かないでください（アプリが付けます）。
- 毎日のノルマはアプリが「残量 ÷ 期限までの学習日数」で自動計算するので、書かないでください。
- 量は数えられる単位にしてください。「1周」「全部」のような単位は避け、大きな教材は章や周回ごとに別のタスクに分けてかまいません（例: 「青チャート 1周目」「青チャート 2周目」）。
- 2周目のように前のタスクの後に始めるものは、開始日を前のタスクの期限の翌日にしてください。
- 説明や補足はコードブロックの外に書き、コードブロックの中には計画だけを入れてください。

# 出力例
\`\`\`
## 青チャート数IA 1周目
- 科目: 数学
- 量: 240 問
- 開始: ${today}
- 期限: ${P.addDays(today, 30)}
- 曜日: 月火水木金土

## 英単語ターゲット1900
- 科目: 英語
- 量: 1900 語
- 済: 300
- 期限: ${P.addDays(today, 45)}
- 曜日: 毎日
\`\`\`

# 私の状況
（ここに目標・教材・使える時間などを書く）
`;
  }

  const TextFormat = { serialize, parse, applyImport, parseWeekdays, formatWeekdays, planningPrompt };

  if (typeof module !== 'undefined' && module.exports) module.exports = TextFormat;
  else root.TextFormat = TextFormat;
})(typeof window !== 'undefined' ? window : globalThis);
