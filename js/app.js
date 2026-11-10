// 画面の組み立てと操作

import * as store from './store.js';
import * as mapView from './map.js';
import {
  esc, today, addDays, fmtDate, fmtNum, fmtArea, fmtYen, num, toast, download, toCSV,
  openModal, closeModal,
} from './util.js';
import {
  areaM2, m2ToAre, MATERIAL_KINDS, checkTask, summarizeByField, summarizeByWorker,
  summarizeByWorkType, recordRows, materialAmountForField, yearOf,
} from './logic.js';

// ---- 端末ごとの設定（共有データには入れない） ----
const LOCAL_KEY = 'tanbo-note:device';
const device = loadDevice();
function loadDevice() {
  try { return { me: '', onlyMine: false, ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') }; } catch { return { me: '', onlyMine: false }; }
}
function saveDevice() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(device)); } catch { /* 無視 */ }
}

// ---- 画面ごとの一時的な状態 ----
const ui = {
  todayDate: today(),
  planMonth: today().slice(0, 7),
  planStatus: 'all',
  summaryYear: yearOf(today()),
};

const ROUTES = {
  today: { title: '今日の作業', render: renderToday },
  map: { title: '田んぼ地図', render: renderMapSide },
  plan: { title: '予定・記録', render: renderPlan },
  summary: { title: '集計', render: renderSummary },
  settings: { title: '設定', render: renderSettings },
};

function currentRoute() {
  const name = (location.hash.replace(/^#\/?/, '') || 'today').split('?')[0];
  return ROUTES[name] ? name : 'today';
}

// ================= 起動 =================
function boot() {
  store.load();
  mapView.initMap(document.getElementById('map'), {
    onFieldClick: (id) => openFieldModal(id),
    onDrawDone: (points, editingId) => onPolygonDrawn(points, editingId),
    onMessage: toast,
  });
  store.subscribe(() => {
    render();
    if (store.lastSaveFailed()) toast('保存に失敗しました。ブラウザの保存領域を確認してください');
  });
  window.addEventListener('hashchange', render);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  render();
}

function render() {
  const state = store.get();
  const route = currentRoute();
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  document.getElementById('farmName').textContent = state.settings.farmName || '田んぼノート';
  const meName = state.workers.find((w) => w.id === device.me)?.name;
  document.getElementById('meBadge').textContent = meName ? `${meName} さん` : '';

  const isMap = route === 'map';
  document.getElementById('mapPage').hidden = !isMap;
  document.getElementById('view').hidden = isMap;
  document.body.dataset.route = route;
  if (isMap) {
    document.getElementById('mapSide').innerHTML = renderMapSide(state);
    mapView.renderFields(state);
    mapView.refreshSize();
  } else {
    document.getElementById('view').innerHTML = ROUTES[route].render(state);
  }
  document.title = `${ROUTES[route].title} | 田んぼノート`;
}

// ================= 共通パーツ =================
function names(list, ids) {
  return (ids || []).map((id) => list.find((x) => x.id === id)?.name).filter(Boolean);
}

function taskCard(t, state, { showDate = false } = {}) {
  const fields = names(state.fields, t.fieldIds);
  const workers = names(state.workers, t.workerIds);
  const area = (t.fieldIds || []).reduce((s, id) => s + (Number(state.fields.find((f) => f.id === id)?.area) || 0), 0);
  const mats = (t.materials || []).map((e) => {
    const m = state.materials.find((x) => x.id === e.materialId);
    return m ? `${esc(m.name)} ${fmtNum(e.per10a, 2)}${esc(m.unit || '')}/10a` : '';
  }).filter(Boolean);
  const overdue = t.status !== 'done' && t.date < today();
  const warnings = t.status !== 'done' ? checkTask(state, t) : [];
  return `
  <article class="card task ${t.status === 'done' ? 'is-done' : ''}">
    <div class="task-head">
      <span class="badge ${t.status === 'done' ? 'ok' : overdue ? 'danger' : 'warn'}">${t.status === 'done' ? '完了' : overdue ? '未完了' : '予定'}</span>
      ${showDate ? `<span class="task-date">${fmtDate(t.date)}</span>` : ''}
      <strong class="task-type">${esc(t.workType)}</strong>
    </div>
    <dl class="task-meta">
      <dt>田んぼ</dt><dd>${fields.length ? esc(fields.join('、')) : '<span class="muted">未指定</span>'}${area ? ` <span class="muted">（計 ${fmtArea(area)}）</span>` : ''}</dd>
      <dt>担当</dt><dd>${workers.length ? esc(workers.join('、')) : '<span class="muted">未定</span>'}</dd>
      ${mats.length ? `<dt>資材</dt><dd>${mats.join('、')}</dd>` : ''}
      ${t.hours ? `<dt>時間</dt><dd>${fmtNum(t.hours, 2)} 時間${workers.length > 1 ? ` × ${workers.length}人` : ''}</dd>` : ''}
      ${t.memo ? `<dt>メモ</dt><dd class="pre">${esc(t.memo)}</dd>` : ''}
    </dl>
    ${warnings.length ? `<ul class="warn-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="task-actions no-print">
      <button class="btn small" data-action="edit-task" data-id="${t.id}">編集</button>
      ${t.status === 'done'
        ? `<button class="btn small" data-action="uncomplete-task" data-id="${t.id}">予定に戻す</button>`
        : `<button class="btn small primary" data-action="complete-task" data-id="${t.id}">実績にする</button>`}
    </div>
  </article>`;
}

function emptyState(text, actionHTML = '') {
  return `<div class="empty"><p>${text}</p>${actionHTML}</div>`;
}

// ================= 今日の作業 =================
function renderToday(state) {
  const d = ui.todayDate;
  let tasks = state.tasks.filter((t) => t.date === d);
  const me = state.workers.find((w) => w.id === device.me);
  if (me && device.onlyMine) tasks = tasks.filter((t) => (t.workerIds || []).includes(me.id));
  const planned = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const overdue = state.tasks.filter((t) => t.status !== 'done' && t.date < today() && (!me || !device.onlyMine || (t.workerIds || []).includes(me.id)));
  const setupHint = !state.fields.length
    ? `<div class="notice">まずは <a href="#/map">田んぼ地図</a> で田んぼを登録し、<a href="#/settings">設定</a> で作業者と資材を登録しましょう。</div>`
    : '';

  return `
  <div class="print-only print-title">作業指示書　${esc(state.settings.farmName || '')}　${fmtDate(d)}</div>
  <div class="toolbar no-print">
    <div class="date-nav">
      <button class="icon-btn" data-action="today-shift" data-n="-1" aria-label="前の日">‹</button>
      <input type="date" id="todayDate" value="${d}">
      <button class="icon-btn" data-action="today-shift" data-n="1" aria-label="次の日">›</button>
      ${d !== today() ? '<button class="btn small" data-action="today-reset">今日</button>' : ''}
    </div>
    <div class="toolbar-right">
      ${me ? `<label class="check"><input type="checkbox" id="onlyMine" ${device.onlyMine ? 'checked' : ''}> 自分の作業だけ</label>` : ''}
      <button class="btn" data-action="print">作業指示書を印刷</button>
      <button class="btn primary" data-action="new-task" data-date="${d}">＋ 作業予定</button>
    </div>
  </div>
  ${setupHint}
  ${d === today() && overdue.length ? `<div class="notice danger no-print">終わっていない過去の予定が ${overdue.length} 件あります。<a href="#/plan" data-action="show-overdue">確認する</a></div>` : ''}
  <h2 class="section-title">これからの作業 <span class="count">${planned.length}</span></h2>
  ${planned.length ? `<div class="cards">${planned.map((t) => taskCard(t, state)).join('')}</div>` : emptyState('この日の予定はありません')}
  <h2 class="section-title">終わった作業 <span class="count">${done.length}</span></h2>
  ${done.length ? `<div class="cards">${done.map((t) => taskCard(t, state)).join('')}</div>` : emptyState('まだありません')}
  `;
}

// ================= 地図（横の一覧） =================
function renderMapSide(state) {
  const totalArea = state.fields.reduce((s, f) => s + (Number(f.area) || 0), 0);
  return `
  <div class="map-actions">
    <button class="btn primary" data-action="draw-field">＋ 田んぼを追加</button>
    <button class="btn" data-action="fit-all">全体を表示</button>
    <button class="btn" data-action="locate">現在地</button>
  </div>
  <div class="legend">
    <span><i style="background:${mapView.STATUS_COLORS.planned}"></i>今日の予定あり</span>
    <span><i style="background:${mapView.STATUS_COLORS.done}"></i>今日の作業完了</span>
    <span><i style="background:${mapView.STATUS_COLORS.none}"></i>今日は作業なし</span>
  </div>
  <h2 class="section-title">田んぼ一覧 <span class="count">${state.fields.length}枚・${fmtArea(totalArea)}</span></h2>
  ${state.fields.length ? `<ul class="field-list">${state.fields.map((f) => `
    <li><button class="field-item" data-action="focus-field" data-id="${f.id}">
      <strong>${esc(f.name)}</strong>
      <span class="muted">${fmtArea(f.area)}${f.crop ? `・${esc(f.crop)}` : ''}${f.variety ? `（${esc(f.variety)}）` : ''}</span>
    </button></li>`).join('')}</ul>`
    : emptyState('「＋ 田んぼを追加」を押して、地図上で田んぼの角を順にタップしてください。')}
  `;
}

// ================= 予定・記録 =================
function renderPlan(state) {
  const month = ui.planMonth;
  let tasks;
  if (ui.planStatus === 'overdue') {
    tasks = state.tasks.filter((t) => t.status !== 'done' && t.date < today());
  } else {
    tasks = state.tasks.filter((t) => t.date.startsWith(month));
    if (ui.planStatus !== 'all') tasks = tasks.filter((t) => (ui.planStatus === 'done' ? t.status === 'done' : t.status !== 'done'));
  }
  tasks.sort((a, b) => a.date.localeCompare(b.date) || a.workType.localeCompare(b.workType));
  const byDate = new Map();
  tasks.forEach((t) => { if (!byDate.has(t.date)) byDate.set(t.date, []); byDate.get(t.date).push(t); });

  return `
  <div class="toolbar">
    <div class="date-nav">
      <button class="icon-btn" data-action="month-shift" data-n="-1" aria-label="前の月">‹</button>
      <input type="month" id="planMonth" value="${month}" ${ui.planStatus === 'overdue' ? 'disabled' : ''}>
      <button class="icon-btn" data-action="month-shift" data-n="1" aria-label="次の月">›</button>
    </div>
    <div class="toolbar-right">
      <select id="planStatus" aria-label="表示する作業">
        ${[['all', 'すべて'], ['planned', '予定のみ'], ['done', '実績のみ'], ['overdue', '未完了（過去）']].map(([v, l]) => `<option value="${v}" ${ui.planStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn primary" data-action="new-task">＋ 作業を追加</button>
    </div>
  </div>
  ${byDate.size ? [...byDate.entries()].map(([d, list]) => `
    <h2 class="section-title date-title ${d === today() ? 'is-today' : ''}">${fmtDate(d)}${d === today() ? ' 今日' : ''}</h2>
    <div class="cards">${list.map((t) => taskCard(t, state)).join('')}</div>`).join('')
    : emptyState('この条件の作業はありません')}
  `;
}

// ================= 集計 =================
function yearsInData(state) {
  const ys = new Set(state.tasks.map((t) => yearOf(t.date)));
  ys.add(yearOf(today()));
  return [...ys].sort((a, b) => b - a);
}

function renderSummary(state) {
  const y = ui.summaryYear;
  const byField = summarizeByField(state, y);
  const byWorker = summarizeByWorker(state, y);
  const byType = summarizeByWorkType(state, y);
  const tot = byField.reduce((s, r) => ({ labor: s.labor + r.labor, cost: s.cost + r.cost, area: s.area + (Number(r.field.area) || 0) }), { labor: 0, cost: 0, area: 0 });
  const matTotals = state.materials.map((m) => ({
    m,
    amount: byField.reduce((s, r) => s + (r.materialTotals[m.id] || 0), 0),
  })).filter((x) => x.amount > 0);
  const doneCount = state.tasks.filter((t) => t.status === 'done' && yearOf(t.date) === y).length;

  return `
  <div class="toolbar">
    <select id="summaryYear" aria-label="年">${yearsInData(state).map((v) => `<option value="${v}" ${v === y ? 'selected' : ''}>${v}年</option>`).join('')}</select>
    <div class="toolbar-right">
      <button class="btn" data-action="export-csv">作業記録をCSV出力</button>
    </div>
  </div>
  <p class="muted small">完了（実績）にした作業だけを集計します。作業時間は「時間 × 人数」を田んぼの面積で按分しています。</p>
  <div class="stats">
    <div class="stat"><span>作業実績</span><strong>${doneCount} 件</strong></div>
    <div class="stat"><span>総作業時間</span><strong>${fmtNum(tot.labor)} 人時</strong></div>
    <div class="stat"><span>資材費</span><strong>${fmtYen(tot.cost)}</strong></div>
    <div class="stat"><span>面積</span><strong>${fmtArea(tot.area)}</strong></div>
  </div>

  <h2 class="section-title">田んぼごと</h2>
  ${byField.length ? `<div class="table-wrap"><table>
    <thead><tr><th>田んぼ</th><th>面積</th><th>品種</th><th class="num">作業</th><th class="num">人時</th><th class="num">10aあたり人時</th><th class="num">資材費</th><th class="num">10aあたり資材費</th><th class="num">農薬使用</th></tr></thead>
    <tbody>${byField.map((r) => `<tr>
      <td>${esc(r.field.name)}</td><td>${fmtArea(r.field.area)}</td><td>${esc(r.field.variety || '')}</td>
      <td class="num">${r.taskCount}</td><td class="num">${fmtNum(r.labor)}</td>
      <td class="num">${r.field.area ? fmtNum(r.labor / (r.field.area / 10), 2) : '-'}</td>
      <td class="num">${fmtYen(r.cost)}</td><td class="num">${r.field.area ? fmtYen(r.costPer10a) : '-'}</td>
      <td class="num">${r.pesticideTimes} 回</td></tr>`).join('')}</tbody>
  </table></div>` : emptyState('田んぼが登録されていません')}

  <div class="two-col">
    <section>
      <h2 class="section-title">作業の種類ごと</h2>
      ${byType.length ? `<div class="table-wrap"><table><thead><tr><th>作業</th><th class="num">回数</th><th class="num">人時</th></tr></thead>
      <tbody>${byType.map((r) => `<tr><td>${esc(r.workType)}</td><td class="num">${r.taskCount}</td><td class="num">${fmtNum(r.labor)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('実績がありません')}
    </section>
    <section>
      <h2 class="section-title">作業者ごと</h2>
      ${byWorker.length ? `<div class="table-wrap"><table><thead><tr><th>作業者</th><th class="num">回数</th><th class="num">時間</th></tr></thead>
      <tbody>${byWorker.map((r) => `<tr><td>${esc(r.worker.name)}</td><td class="num">${r.taskCount}</td><td class="num">${fmtNum(r.hours)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('作業者が登録されていません')}
    </section>
  </div>

  <h2 class="section-title">資材の使用量</h2>
  ${matTotals.length ? `<div class="table-wrap"><table><thead><tr><th>資材</th><th>区分</th><th class="num">使用量</th><th class="num">費用</th></tr></thead>
  <tbody>${matTotals.map(({ m, amount }) => `<tr><td>${esc(m.name)}</td><td>${MATERIAL_KINDS[m.kind] || ''}</td><td class="num">${fmtNum(amount, 2)} ${esc(m.unit || '')}</td><td class="num">${fmtYen(amount * (Number(m.unitPrice) || 0))}</td></tr>`).join('')}</tbody></table></div>` : emptyState('資材を使った実績がありません')}
  `;
}

// ================= 設定 =================
function renderSettings(state) {
  return `
  <section class="card pad">
    <h2 class="section-title">農場</h2>
    <form id="farmForm" class="form-grid">
      <label>農場名<input name="farmName" value="${esc(state.settings.farmName)}" placeholder="例：〇〇農園"></label>
      <label>この端末を使う人
        <select id="meSelect"><option value="">選択しない</option>
          ${state.workers.map((w) => `<option value="${w.id}" ${device.me === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
        </select>
        <small class="muted">選ぶと「今日の作業」で自分の担当だけを表示できます</small>
      </label>
      <div><button class="btn primary">保存</button></div>
    </form>
  </section>

  <section class="card pad">
    <div class="section-head"><h2 class="section-title">作業者</h2><button class="btn small primary" data-action="new-worker">＋ 追加</button></div>
    ${state.workers.length ? `<ul class="simple-list">${state.workers.map((w) => `
      <li><span>${esc(w.name)}</span><span class="row-actions">
        <button class="btn small" data-action="edit-worker" data-id="${w.id}">編集</button>
        <button class="btn small danger" data-action="delete-worker" data-id="${w.id}">削除</button></span></li>`).join('')}</ul>`
      : emptyState('家族やスタッフを登録すると、作業の担当者に選べます')}
  </section>

  <section class="card pad">
    <div class="section-head"><h2 class="section-title">資材（農薬・肥料など）</h2><button class="btn small primary" data-action="new-material">＋ 追加</button></div>
    ${state.materials.length ? `<div class="table-wrap"><table>
      <thead><tr><th>名前</th><th>区分</th><th>単位</th><th class="num">単価</th><th class="num">使用回数上限</th><th class="num">収穫前日数</th><th></th></tr></thead>
      <tbody>${state.materials.map((m) => `<tr>
        <td>${esc(m.name)}</td><td>${MATERIAL_KINDS[m.kind] || ''}</td><td>${esc(m.unit || '')}</td>
        <td class="num">${m.unitPrice ? fmtYen(m.unitPrice) : '-'}</td>
        <td class="num">${m.kind === 'pesticide' && m.maxUses ? `${m.maxUses} 回` : '-'}</td>
        <td class="num">${m.kind === 'pesticide' && m.preHarvestDays ? `${m.preHarvestDays} 日前まで` : '-'}</td>
        <td class="row-actions"><button class="btn small" data-action="edit-material" data-id="${m.id}">編集</button>
          <button class="btn small danger" data-action="delete-material" data-id="${m.id}">削除</button></td></tr>`).join('')}</tbody>
    </table></div>` : emptyState('農薬や肥料を登録すると、作業で使った量や費用を記録できます')}
  </section>

  <section class="card pad">
    <h2 class="section-title">作業の種類</h2>
    <form id="workTypeForm">
      <label>1行に1つずつ書いてください<textarea name="workTypes" rows="8">${esc(state.workTypes.join('\n'))}</textarea></label>
      <button class="btn primary">保存</button>
    </form>
  </section>

  <section class="card pad">
    <h2 class="section-title">データ</h2>
    <p class="muted small">データはこの端末のブラウザに保存されています。機種変更のときや、ほかの端末にデータを移すときは、書き出したファイルを読み込んでください。</p>
    <div class="btn-row">
      <button class="btn" data-action="export-json">データを書き出す</button>
      <label class="btn">データを読み込む<input type="file" id="importFile" accept="application/json,.json" hidden></label>
      <button class="btn danger" data-action="reset-all">すべて削除</button>
    </div>
  </section>

  <p class="muted small credit">地図：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>（航空写真・標準地図）</p>
  `;
}

// ================= モーダル：作業 =================
function materialRow(state, entry = {}) {
  return `<div class="mat-row">
    <select name="matId" aria-label="資材"><option value="">資材を選ぶ</option>
      ${state.materials.map((m) => `<option value="${m.id}" ${entry.materialId === m.id ? 'selected' : ''}>${esc(m.name)}（${MATERIAL_KINDS[m.kind] || ''}）</option>`).join('')}
    </select>
    <input name="per10a" type="number" step="any" min="0" inputmode="decimal" placeholder="10aあたり量" value="${entry.per10a ?? ''}" aria-label="10aあたり量">
    <span class="unit">${esc(state.materials.find((m) => m.id === entry.materialId)?.unit || '')}/10a</span>
    <button type="button" class="icon-btn" data-action="remove-mat-row" aria-label="この資材を外す">✕</button>
  </div>`;
}

function readTaskForm(form, base) {
  const fd = new FormData(form);
  const materials = [...form.querySelectorAll('.mat-row')].map((row) => ({
    materialId: row.querySelector('[name=matId]').value,
    per10a: num(row.querySelector('[name=per10a]').value),
  })).filter((m) => m.materialId);
  return {
    ...base,
    date: fd.get('date') || today(),
    status: fd.get('status') === 'done' ? 'done' : 'planned',
    workType: (fd.get('workType') || '').trim() || 'その他',
    fieldIds: fd.getAll('fieldIds'),
    workerIds: fd.getAll('workerIds'),
    hours: num(fd.get('hours')),
    materials,
    memo: (fd.get('memo') || '').trim(),
  };
}

function openTaskModal(id, preset = {}) {
  const state = store.get();
  const existing = id ? state.tasks.find((t) => t.id === id) : null;
  const t = existing || {
    id: store.newId(), date: preset.date || today(), status: 'planned', workType: state.workTypes[0] || '',
    fieldIds: preset.fieldIds || [], workerIds: [], hours: 0, materials: [], memo: '',
  };
  const workTypes = state.workTypes.includes(t.workType) || !t.workType ? state.workTypes : [...state.workTypes, t.workType];

  const body = `
    <div class="form-grid">
      <label>日付<input type="date" name="date" value="${t.date}" required></label>
      <label>状態<select name="status">
        <option value="planned" ${t.status !== 'done' ? 'selected' : ''}>予定（これからやる）</option>
        <option value="done" ${t.status === 'done' ? 'selected' : ''}>実績（もう終わった）</option></select></label>
      <label class="span2">作業<select name="workType">${workTypes.map((w) => `<option ${w === t.workType ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
    </div>
    <fieldset>
      <legend>田んぼ <button type="button" class="link-btn" data-action="toggle-all" data-name="fieldIds">すべて選ぶ/外す</button></legend>
      ${state.fields.length ? `<div class="check-grid">${state.fields.map((f) => `<label class="check"><input type="checkbox" name="fieldIds" value="${f.id}" ${t.fieldIds.includes(f.id) ? 'checked' : ''}> ${esc(f.name)} <span class="muted">${fmtArea(f.area)}</span></label>`).join('')}</div>`
        : '<p class="muted small">田んぼが未登録です。「田んぼ地図」から登録できます。</p>'}
    </fieldset>
    <fieldset>
      <legend>担当する人</legend>
      ${state.workers.length ? `<div class="check-grid">${state.workers.map((w) => `<label class="check"><input type="checkbox" name="workerIds" value="${w.id}" ${t.workerIds.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('')}</div>`
        : '<p class="muted small">作業者が未登録です。「設定」から登録できます。</p>'}
    </fieldset>
    <fieldset>
      <legend>使う資材</legend>
      <div id="matRows">${t.materials.map((e) => materialRow(state, e)).join('')}</div>
      ${state.materials.length ? '<button type="button" class="btn small" data-action="add-mat-row">＋ 資材を追加</button>' : '<p class="muted small">資材が未登録です。「設定」から登録できます。</p>'}
      <p class="muted small" id="matTotal"></p>
    </fieldset>
    <div class="form-grid">
      <label>作業時間（1人あたり・時間）<input type="number" name="hours" step="0.25" min="0" inputmode="decimal" value="${t.hours || ''}" placeholder="例：2.5"></label>
      <label class="span2">メモ・指示<textarea name="memo" rows="3" placeholder="例：水口側から始める、倍率1000倍">${esc(t.memo)}</textarea></label>
    </div>
    <ul class="warn-list" id="taskWarnings" hidden></ul>`;

  const extra = existing
    ? `<button type="button" class="btn danger" data-action="delete-task" data-id="${t.id}">削除</button>
       <button type="button" class="btn" data-action="copy-task" data-id="${t.id}">複製</button>`
    : '';

  openModal(existing ? '作業を編集' : '作業を追加', body, {
    extraButtons: extra,
    onSubmit: (form) => {
      const draft = readTaskForm(form, { ...t, updatedAt: new Date().toISOString(), createdAt: t.createdAt || new Date().toISOString() });
      if (!draft.fieldIds.length && !confirm('田んぼが選ばれていません。このまま保存しますか？')) return false;
      const warnings = checkTask(store.get(), draft);
      if (warnings.length && !confirm(`農薬の注意があります。\n\n${warnings.join('\n')}\n\nこのまま保存しますか？`)) return false;
      if (draft.status === 'done' && !draft.doneAt) draft.doneAt = new Date().toISOString();
      store.update((s) => store.upsert(s.tasks, draft));
      toast('保存しました');
    },
    onReady: (form) => {
      const refresh = () => refreshTaskForm(form, t);
      form.addEventListener('change', refresh);
      form.addEventListener('input', refresh);
      refresh();
    },
  });
}

function refreshTaskForm(form, base) {
  const state = store.get();
  const draft = readTaskForm(form, base);
  const box = form.querySelector('#taskWarnings');
  const warnings = checkTask(state, draft);
  box.hidden = !warnings.length;
  box.innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');
  // 単位表示と使用量の合計
  form.querySelectorAll('.mat-row').forEach((row) => {
    const m = state.materials.find((x) => x.id === row.querySelector('[name=matId]').value);
    row.querySelector('.unit').textContent = `${m?.unit || ''}/10a`;
  });
  const fields = draft.fieldIds.map((id) => state.fields.find((f) => f.id === id)).filter(Boolean);
  const totals = draft.materials.map((e) => {
    const m = state.materials.find((x) => x.id === e.materialId);
    const amount = fields.reduce((s, f) => s + materialAmountForField(e, f), 0);
    return m && amount ? `${m.name} 合計 ${fmtNum(amount, 2)}${m.unit || ''}` : '';
  }).filter(Boolean);
  form.querySelector('#matTotal').textContent = totals.join('　');
}

function openCompleteModal(id) {
  const state = store.get();
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const body = `
    <p><strong>${esc(t.workType)}</strong>　${esc(names(state.fields, t.fieldIds).join('、'))}</p>
    <div class="form-grid">
      <label>作業した日<input type="date" name="date" value="${t.date}"></label>
      <label>作業時間（1人あたり・時間）<input type="number" name="hours" step="0.25" min="0" inputmode="decimal" value="${t.hours || ''}" placeholder="例：2.5"></label>
    </div>
    <fieldset><legend>作業した人</legend>
      ${state.workers.length ? `<div class="check-grid">${state.workers.map((w) => `<label class="check"><input type="checkbox" name="workerIds" value="${w.id}" ${(t.workerIds.includes(w.id) || (!t.workerIds.length && w.id === device.me)) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('')}</div>` : '<p class="muted small">作業者が未登録です</p>'}
    </fieldset>
    <label>メモ<textarea name="memo" rows="3">${esc(t.memo)}</textarea></label>`;
  openModal('実績にする', body, {
    submitLabel: '完了にする',
    onSubmit: (form) => {
      const fd = new FormData(form);
      store.update((s) => {
        const x = s.tasks.find((y) => y.id === id);
        if (!x) return;
        x.status = 'done';
        x.date = fd.get('date') || x.date;
        x.hours = num(fd.get('hours'));
        x.workerIds = fd.getAll('workerIds');
        x.memo = (fd.get('memo') || '').trim();
        x.doneAt = new Date().toISOString();
        x.updatedAt = x.doneAt;
      });
      toast('お疲れさまでした！実績にしました');
    },
  });
}

// ================= モーダル：田んぼ =================
let pendingPolygon = null;

function onPolygonDrawn(points, editingId) {
  const area = m2ToAre(areaM2(points));
  if (editingId) {
    store.update((s) => {
      const f = s.fields.find((x) => x.id === editingId);
      if (f) { f.polygon = points; f.area = area; }
    });
    toast(`形を更新しました（${fmtArea(area)}）`);
    openFieldModal(editingId);
  } else {
    pendingPolygon = points;
    openFieldModal(null, { polygon: points, area });
  }
}

function openFieldModal(id, preset = {}) {
  const state = store.get();
  const existing = id ? state.fields.find((f) => f.id === id) : null;
  const f = existing || {
    id: store.newId(), name: `田んぼ${state.fields.length + 1}`, area: preset.area || 0, polygon: preset.polygon || [],
    crop: '水稲', variety: '', harvestDate: '', memo: '',
  };
  const recent = existing
    ? state.tasks.filter((t) => (t.fieldIds || []).includes(f.id)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
    : [];
  const body = `
    <div class="form-grid">
      <label class="span2">名前<input name="name" value="${esc(f.name)}" required></label>
      <label>面積（a）<input name="area" type="number" step="0.1" min="0" inputmode="decimal" value="${f.area || ''}"></label>
      <label>作物<input name="crop" value="${esc(f.crop || '')}" placeholder="水稲"></label>
      <label>品種<input name="variety" value="${esc(f.variety || '')}" placeholder="例：コシヒカリ"></label>
      <label>収穫予定日<input name="harvestDate" type="date" value="${f.harvestDate || ''}"></label>
      <label class="span2">メモ<textarea name="memo" rows="2" placeholder="例：水口は北側、ぬかるみ注意">${esc(f.memo || '')}</textarea></label>
    </div>
    <p class="muted small">面積は地図で描いた形から自動で計算します（手で直すこともできます）。収穫予定日を入れると、農薬の「収穫前日数」をチェックします。</p>
    ${existing ? `<h3 class="sub-title">最近の作業</h3>
      ${recent.length ? `<ul class="mini-list">${recent.map((t) => `<li><span class="badge ${t.status === 'done' ? 'ok' : 'warn'}">${t.status === 'done' ? '完了' : '予定'}</span> ${fmtDate(t.date)} ${esc(t.workType)}</li>`).join('')}</ul>` : '<p class="muted small">まだありません</p>'}` : ''}`;
  const extra = existing
    ? `<button type="button" class="btn danger" data-action="delete-field" data-id="${f.id}">削除</button>
       <button type="button" class="btn" data-action="redraw-field" data-id="${f.id}">形を描き直す</button>
       <button type="button" class="btn" data-action="new-task-for-field" data-id="${f.id}">作業を追加</button>`
    : '';
  openModal(existing ? '田んぼ' : '田んぼを登録', body, {
    extraButtons: extra,
    onSubmit: (form) => {
      const fd = new FormData(form);
      const name = (fd.get('name') || '').trim();
      if (!name) { toast('名前を入れてください'); return false; }
      const next = {
        ...f,
        name,
        area: num(fd.get('area')),
        crop: (fd.get('crop') || '').trim(),
        variety: (fd.get('variety') || '').trim(),
        harvestDate: fd.get('harvestDate') || '',
        memo: (fd.get('memo') || '').trim(),
      };
      if (!existing && pendingPolygon) next.polygon = pendingPolygon;
      pendingPolygon = null;
      store.update((s) => store.upsert(s.fields, next));
      toast('保存しました');
    },
  });
}

// ================= モーダル：作業者・資材 =================
function openWorkerModal(id) {
  const state = store.get();
  const w = state.workers.find((x) => x.id === id) || { id: store.newId(), name: '' };
  openModal(id ? '作業者を編集' : '作業者を追加', `<label>名前<input name="name" value="${esc(w.name)}" required placeholder="例：山田 太郎"></label>`, {
    onSubmit: (form) => {
      const name = (new FormData(form).get('name') || '').trim();
      if (!name) { toast('名前を入れてください'); return false; }
      store.update((s) => store.upsert(s.workers, { ...w, name }));
    },
  });
}

function openMaterialModal(id) {
  const state = store.get();
  const m = state.materials.find((x) => x.id === id) || {
    id: store.newId(), name: '', kind: 'fertilizer', unit: 'kg', unitPrice: 0, maxUses: 0, preHarvestDays: 0, dilution: '', memo: '',
  };
  const body = `
    <div class="form-grid">
      <label class="span2">名前<input name="name" value="${esc(m.name)}" required placeholder="例：〇〇粒剤"></label>
      <label>区分<select name="kind">${Object.entries(MATERIAL_KINDS).map(([k, v]) => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>単位<input name="unit" value="${esc(m.unit)}" placeholder="kg / L / 袋"></label>
      <label>単価（円／単位）<input name="unitPrice" type="number" step="any" min="0" inputmode="decimal" value="${m.unitPrice || ''}"></label>
    </div>
    <fieldset class="pesticide-only">
      <legend>農薬の使用基準（ラベルを見て入力）</legend>
      <div class="form-grid">
        <label>使用回数の上限（年）<input name="maxUses" type="number" min="0" step="1" value="${m.maxUses || ''}" placeholder="例：2"></label>
        <label>収穫何日前まで<input name="preHarvestDays" type="number" min="0" step="1" value="${m.preHarvestDays || ''}" placeholder="例：21"></label>
        <label class="span2">希釈倍数・使い方<input name="dilution" value="${esc(m.dilution || '')}" placeholder="例：1000倍、100L/10a"></label>
      </div>
    </fieldset>
    <label>メモ<textarea name="memo" rows="2">${esc(m.memo || '')}</textarea></label>`;
  openModal(id ? '資材を編集' : '資材を追加', body, {
    onSubmit: (form) => {
      const fd = new FormData(form);
      const name = (fd.get('name') || '').trim();
      if (!name) { toast('名前を入れてください'); return false; }
      store.update((s) => store.upsert(s.materials, {
        ...m, name, kind: fd.get('kind'), unit: (fd.get('unit') || '').trim(), unitPrice: num(fd.get('unitPrice')),
        maxUses: num(fd.get('maxUses')), preHarvestDays: num(fd.get('preHarvestDays')),
        dilution: (fd.get('dilution') || '').trim(), memo: (fd.get('memo') || '').trim(),
      }));
    },
    onReady: (form) => {
      const sync = () => { form.querySelector('.pesticide-only').hidden = form.kind.value !== 'pesticide'; };
      form.kind.addEventListener('change', sync);
      sync();
    },
  });
}

// ================= イベント =================
function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  const state = store.get();
  switch (action) {
    case 'new-task': openTaskModal(null, { date: el.dataset.date }); break;
    case 'edit-task': openTaskModal(id); break;
    case 'complete-task': openCompleteModal(id); break;
    case 'uncomplete-task':
      store.update((s) => { const t = s.tasks.find((x) => x.id === id); if (t) { t.status = 'planned'; delete t.doneAt; } });
      break;
    case 'delete-task':
      if (confirm('この作業を削除しますか？')) { store.update((s) => store.remove(s.tasks, id)); closeModal(); toast('削除しました'); }
      break;
    case 'copy-task': {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) break;
      const copy = { ...structuredClone(t), id: store.newId(), status: 'planned', date: today(), createdAt: new Date().toISOString() };
      delete copy.doneAt;
      store.update((s) => s.tasks.push(copy));
      openTaskModal(copy.id);
      toast('複製しました（日付を確認してください）');
      break;
    }
    case 'add-mat-row':
      el.closest('form').querySelector('#matRows').insertAdjacentHTML('beforeend', materialRow(state));
      break;
    case 'remove-mat-row': {
      const form = el.closest('form');
      el.closest('.mat-row').remove();
      form.dispatchEvent(new Event('change'));
      break;
    }
    case 'toggle-all': {
      const boxes = [...el.closest('form').querySelectorAll(`input[name="${el.dataset.name}"]`)];
      const allOn = boxes.every((b) => b.checked);
      boxes.forEach((b) => (b.checked = !allOn));
      el.closest('form').dispatchEvent(new Event('change'));
      break;
    }
    case 'today-shift': ui.todayDate = addDays(ui.todayDate, Number(el.dataset.n)); render(); break;
    case 'today-reset': ui.todayDate = today(); render(); break;
    case 'month-shift': {
      const [y, m] = ui.planMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + Number(el.dataset.n), 1);
      ui.planMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      render();
      break;
    }
    case 'show-overdue': ui.planStatus = 'overdue'; break; // リンク先 #/plan で反映
    case 'print': window.print(); break;
    case 'draw-field': closeModal(); if (mapView.startDrawing()) toast('田んぼの角を順にタップしてください'); break;
    case 'redraw-field':
      closeModal();
      if (currentRoute() !== 'map') location.hash = '#/map';
      setTimeout(() => { mapView.focusField(state.fields.find((f) => f.id === id)); mapView.startDrawing(id); }, 50);
      break;
    case 'focus-field': mapView.focusField(state.fields.find((f) => f.id === id)); openFieldModal(id); break;
    case 'fit-all': mapView.fitAll(state); break;
    case 'locate': mapView.locate(); break;
    case 'new-task-for-field': closeModal(); openTaskModal(null, { fieldIds: [id], date: today() }); break;
    case 'delete-field': {
      const used = state.tasks.filter((t) => (t.fieldIds || []).includes(id)).length;
      if (!confirm(`この田んぼを削除しますか？${used ? `\n${used}件の作業からもこの田んぼが外れます。` : ''}`)) break;
      store.update((s) => {
        store.remove(s.fields, id);
        s.tasks.forEach((t) => { t.fieldIds = (t.fieldIds || []).filter((x) => x !== id); });
      });
      closeModal();
      toast('削除しました');
      break;
    }
    case 'new-worker': openWorkerModal(null); break;
    case 'edit-worker': openWorkerModal(id); break;
    case 'delete-worker':
      if (!confirm('この作業者を削除しますか？（作業の担当からも外れます）')) break;
      store.update((s) => {
        store.remove(s.workers, id);
        s.tasks.forEach((t) => { t.workerIds = (t.workerIds || []).filter((x) => x !== id); });
      });
      if (device.me === id) { device.me = ''; saveDevice(); }
      break;
    case 'new-material': openMaterialModal(null); break;
    case 'edit-material': openMaterialModal(id); break;
    case 'delete-material': {
      const used = state.tasks.filter((t) => (t.materials || []).some((m) => m.materialId === id)).length;
      if (!confirm(`この資材を削除しますか？${used ? `\n${used}件の作業の記録からも消えます。` : ''}`)) break;
      store.update((s) => {
        store.remove(s.materials, id);
        s.tasks.forEach((t) => { t.materials = (t.materials || []).filter((m) => m.materialId !== id); });
      });
      break;
    }
    case 'export-csv': {
      const y = ui.summaryYear;
      download(`作業記録_${y}.csv`, toCSV(recordRows(state, y)), 'text/csv');
      break;
    }
    case 'export-json':
      download(`tanbo-note_${today()}.json`, store.exportJSON(), 'application/json');
      break;
    case 'reset-all':
      if (confirm('すべてのデータを削除します。元に戻せません。よろしいですか？') && confirm('本当に削除しますか？')) {
        store.resetAll();
        toast('削除しました');
      }
      break;
    default: break;
  }
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'todayDate' && el.value) { ui.todayDate = el.value; render(); }
  if (el.id === 'onlyMine') { device.onlyMine = el.checked; saveDevice(); render(); }
  if (el.id === 'planMonth' && el.value) { ui.planMonth = el.value; render(); }
  if (el.id === 'planStatus') { ui.planStatus = el.value; render(); }
  if (el.id === 'summaryYear') { ui.summaryYear = Number(el.value); render(); }
  if (el.id === 'meSelect') { device.me = el.value; saveDevice(); render(); toast('この端末の利用者を設定しました'); }
  if (el.id === 'importFile' && el.files?.[0]) {
    const file = el.files[0];
    file.text().then((text) => {
      if (!confirm('今のデータを、読み込んだデータで置き換えます。よろしいですか？')) return;
      try { store.importJSON(text); toast('読み込みました'); } catch (err) { alert(`読み込めませんでした：${err.message}`); }
    }).finally(() => { el.value = ''; });
  }
}

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form.id === 'farmForm') {
    e.preventDefault();
    const farmName = (new FormData(form).get('farmName') || '').trim();
    store.update((s) => { s.settings.farmName = farmName; });
    toast('保存しました');
  }
  if (form.id === 'workTypeForm') {
    e.preventDefault();
    const list = String(new FormData(form).get('workTypes') || '').split('\n').map((x) => x.trim()).filter(Boolean);
    store.update((s) => { s.workTypes = [...new Set(list)]; });
    toast('保存しました');
  }
});

boot();
