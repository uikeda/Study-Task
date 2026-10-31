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

  // ---------- 1日のタイムライン ----------

  // 1日のタイムライン表示の配置を求める。blocks は blocksOn の結果（開始時刻順）。
  // コマのある時間帯（1時間単位）を「区間」として縦に並べ、2時間以上コマのない時間はたたんで「空き」の行にする。
  // nowMin（分）を渡すと、その時間帯も区間に含めて「今」の線の位置を返す。
  // 戻り値は上から順の行: { type: 'segment', from, to, height, hours, items, free, now } または { type: 'gap', from, to }
  function dayLayout(blocks, { nowMin = null, pxPerMin = 1.5, minHeight = 22, minFree = 15 } = {}) {
    const spans = blocks.map((b) => ({ block: b, start: toMinutes(b.start), end: toMinutes(b.end) }));
    const hours = new Set();
    for (const s of spans) {
      for (let h = Math.floor(s.start / 60); h < Math.ceil(s.end / 60); h++) hours.add(h);
    }
    if (nowMin !== null) hours.add(Math.floor(nowMin / 60));
    const sorted = [...hours].sort((a, b) => a - b);
    if (sorted.length === 0) return [];

    // 連続する時間をまとめる。1時間だけの空きはたたまずにつなげる
    const runs = [];
    for (const h of sorted) {
      const last = runs[runs.length - 1];
      if (last && h - last.to <= 1) last.to = h + 1;
      else runs.push({ from: h, to: h + 1 });
    }

    const rows = [];
    runs.forEach((run, i) => {
      const from = run.from * 60;
      const to = run.to * 60;
      const y = (min) => (min - from) * pxPerMin;
      const inRun = spans.filter((s) => s.start < to && s.end > from);
      const items = placeLanes(inRun).map((s) => ({
        block: s.block,
        lane: s.lane,
        lanes: s.lanes,
        top: y(Math.max(s.start, from)),
        height: Math.max(minHeight, (Math.min(s.end, to) - Math.max(s.start, from)) * pxPerMin),
      }));
      // コマとコマの間の空き時間
      const free = [];
      let maxEnd = null;
      for (const s of inRun) {
        if (maxEnd !== null && s.start - maxEnd >= minFree) free.push({ from: maxEnd, to: s.start, top: y(maxEnd), height: (s.start - maxEnd) * pxPerMin });
        maxEnd = maxEnd === null ? s.end : Math.max(maxEnd, s.end);
      }
      rows.push({
        type: 'segment',
        from,
        to,
        height: (to - from) * pxPerMin,
        hours: Array.from({ length: run.to - run.from + 1 }, (_, k) => ({ label: `${run.from + k}:00`, top: k * 60 * pxPerMin })),
        items,
        free,
        now: nowMin !== null && nowMin >= from && nowMin < to ? y(nowMin) : null,
      });
      const next = runs[i + 1];
      if (next) {
        // たたんだ空きは、実際に空いている時間（前のコマの終わり〜次のコマの始まり）で表す
        // （「今」のためだけの区間にはコマが無いので、その区間の端を使う）
        const nextFrom = next.from * 60;
        const nextTo = next.to * 60;
        const inNext = spans.filter((s) => s.start < nextTo && s.end > nextFrom);
        const prevEnd = inRun.length ? Math.max(...inRun.map((s) => s.end)) : to;
        const nextStart = inNext.length ? Math.min(...inNext.map((s) => s.start)) : nextFrom;
        rows.push({ type: 'gap', from: prevEnd, to: nextStart });
      }
    });
    return rows;
  }

  // 重なるコマを横に並べる。重なりでつながるまとまりごとに、列番号（lane）と列数（lanes）を決める
  function placeLanes(spans) {
    const result = [];
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const laneEnds = [];
      for (const s of cluster) {
        let lane = laneEnds.findIndex((end) => end <= s.start);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = s.end;
        s.lane = lane;
      }
      for (const s of cluster) result.push({ ...s, lanes: laneEnds.length });
      cluster = [];
    };
    for (const s of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (cluster.length && s.start >= clusterEnd) flush();
      cluster.push(s);
      clusterEnd = Math.max(clusterEnd, s.end);
    }
    if (cluster.length) flush();
    return result;
  }

  // 「1時間30分」のような長さの表示
  function formatDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return `${m}分`;
    return m ? `${h}時間${m}分` : `${h}時間`;
  }

  // ---------- 科目の色 ----------

  // 科目に色の番号（0〜slots-1）を割り当てる。保存済みの割り当ては変えず（科目の色が勝手に変わらないように）、
  // 使われなくなった科目の番号は空けて、新しい科目に空いている番号を順に渡す。番号が足りない科目は割り当てない（「その他」の色になる）
  function assignSubjectColors(subjects, saved, slots) {
    const result = {};
    const wanted = [...new Set(subjects.filter(Boolean))];
    for (const s of wanted) {
      if (Number.isInteger(saved[s]) && saved[s] < slots && !Object.values(result).includes(saved[s])) result[s] = saved[s];
    }
    for (const s of wanted) {
      if (s in result) continue;
      const free = Array.from({ length: slots }, (_, i) => i).find((i) => !Object.values(result).includes(i));
      if (free === undefined) break;
      result[s] = free;
    }
    return result;
  }

  const Schedule = { toMinutes, fromMinutes, isValidTime, appliesOn, blocksOn, nowAndNext, overlaps, validate, dayLayout, formatDuration, assignSubjectColors };

  if (typeof module !== 'undefined' && module.exports) module.exports = Schedule;
  else root.Schedule = Schedule;
})(typeof window !== 'undefined' ? window : globalThis);
