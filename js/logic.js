// 面積計算・農薬チェック・集計など、画面に依存しない計算

import { daysBetween } from './util.js';

// 緯度経度の多角形 [[lat, lng], ...] の面積（㎡）。測地線近似。
export function areaM2(latlngs) {
  if (!latlngs || latlngs.length < 3) return 0;
  const R = 6378137;
  const d2r = Math.PI / 180;
  let area = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const [lat1, lng1] = latlngs[i];
    const [lat2, lng2] = latlngs[(i + 1) % latlngs.length];
    area += (lng2 - lng1) * d2r * (2 + Math.sin(lat1 * d2r) + Math.sin(lat2 * d2r));
  }
  return Math.abs((area * R * R) / 2);
}

export function m2ToAre(m2) {
  return Math.round((m2 / 100) * 10) / 10;
}

export const MATERIAL_KINDS = {
  pesticide: '農薬',
  fertilizer: '肥料',
  other: 'その他資材',
};

export function yearOf(iso) {
  return Number(String(iso).slice(0, 4));
}

// 作業に含まれる資材の、圃場ごとの使用量（10aあたり量 × 面積）
export function materialAmountForField(entry, field) {
  return (Number(entry.per10a) || 0) * ((Number(field?.area) || 0) / 10);
}

// 作業時間（人時）を圃場の面積で按分する。面積が無ければ均等割り。
export function laborShare(task, field, fields) {
  const people = Math.max(1, (task.workerIds || []).length);
  const total = (Number(task.hours) || 0) * people;
  const targets = (task.fieldIds || []).map((id) => fields.find((f) => f.id === id)).filter(Boolean);
  if (!targets.length) return 0;
  const sumArea = targets.reduce((s, f) => s + (Number(f.area) || 0), 0);
  if (sumArea > 0) return (total * (Number(field.area) || 0)) / sumArea;
  return total / targets.length;
}

// 同じ年に、その圃場でその農薬を使う作業の回数（予定も含む）
export function pesticideUseCount(state, fieldId, materialId, year, excludeTaskId) {
  return state.tasks.filter(
    (t) =>
      t.id !== excludeTaskId &&
      yearOf(t.date) === year &&
      (t.fieldIds || []).includes(fieldId) &&
      (t.materials || []).some((m) => m.materialId === materialId),
  ).length;
}

// 作業（下書き）に対する農薬の警告を返す
export function checkTask(state, draft) {
  const warnings = [];
  if (!draft.date) return warnings;
  const year = yearOf(draft.date);
  for (const entry of draft.materials || []) {
    const mat = state.materials.find((m) => m.id === entry.materialId);
    if (!mat || mat.kind !== 'pesticide') continue;
    for (const fieldId of draft.fieldIds || []) {
      const field = state.fields.find((f) => f.id === fieldId);
      if (!field) continue;
      const maxUses = Number(mat.maxUses) || 0;
      if (maxUses > 0) {
        const count = pesticideUseCount(state, fieldId, mat.id, year, draft.id) + 1;
        if (count > maxUses) {
          warnings.push(`${field.name}：「${mat.name}」は今回で${year}年の${count}回目です（上限 ${maxUses}回）`);
        }
      }
      const preDays = Number(mat.preHarvestDays) || 0;
      if (preDays > 0 && field.harvestDate) {
        const left = daysBetween(draft.date, field.harvestDate);
        if (left < preDays) {
          warnings.push(
            `${field.name}：「${mat.name}」は収穫${preDays}日前まで。収穫予定日（${field.harvestDate}）まで${left}日しかありません`,
          );
        }
      }
    }
  }
  return warnings;
}

// 圃場ごとの集計（指定年の実績）
export function summarizeByField(state, year) {
  const done = state.tasks.filter((t) => t.status === 'done' && yearOf(t.date) === year);
  return state.fields.map((field) => {
    const tasks = done.filter((t) => (t.fieldIds || []).includes(field.id));
    let labor = 0;
    let cost = 0;
    let pesticideTimes = 0;
    const materialTotals = {};
    for (const t of tasks) {
      labor += laborShare(t, field, state.fields);
      let usedPesticide = false;
      for (const entry of t.materials || []) {
        const mat = state.materials.find((m) => m.id === entry.materialId);
        if (!mat) continue;
        const amount = materialAmountForField(entry, field);
        materialTotals[mat.id] = (materialTotals[mat.id] || 0) + amount;
        cost += amount * (Number(mat.unitPrice) || 0);
        if (mat.kind === 'pesticide') usedPesticide = true;
      }
      if (usedPesticide) pesticideTimes += 1;
    }
    const area = Number(field.area) || 0;
    return {
      field,
      taskCount: tasks.length,
      labor,
      cost,
      costPer10a: area > 0 ? cost / (area / 10) : 0,
      pesticideTimes,
      materialTotals,
    };
  });
}

// 作業者ごとの作業時間（指定年の実績）
export function summarizeByWorker(state, year) {
  const done = state.tasks.filter((t) => t.status === 'done' && yearOf(t.date) === year);
  return state.workers.map((w) => {
    const tasks = done.filter((t) => (t.workerIds || []).includes(w.id));
    return {
      worker: w,
      taskCount: tasks.length,
      hours: tasks.reduce((s, t) => s + (Number(t.hours) || 0), 0),
    };
  });
}

// 作業種類ごとの回数・時間（指定年の実績）
export function summarizeByWorkType(state, year) {
  const done = state.tasks.filter((t) => t.status === 'done' && yearOf(t.date) === year);
  const map = new Map();
  for (const t of done) {
    const cur = map.get(t.workType) || { workType: t.workType, taskCount: 0, labor: 0 };
    cur.taskCount += 1;
    cur.labor += (Number(t.hours) || 0) * Math.max(1, (t.workerIds || []).length);
    map.set(t.workType, cur);
  }
  return [...map.values()].sort((a, b) => b.labor - a.labor);
}

// CSV 出力用：作業 × 圃場 × 資材 を1行に展開
export function recordRows(state, year) {
  const header = ['日付', '状態', '作業', '圃場', '面積(a)', '作物', '品種', '作業者', '作業時間(人時・按分)', '資材', '区分', '10aあたり量', '使用量', '単位', '費用(円)', 'メモ'];
  const rows = [header];
  const tasks = state.tasks
    .filter((t) => yearOf(t.date) === year)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const t of tasks) {
    const workers = (t.workerIds || []).map((id) => state.workers.find((w) => w.id === id)?.name).filter(Boolean).join('・');
    for (const fieldId of t.fieldIds || []) {
      const f = state.fields.find((x) => x.id === fieldId);
      if (!f) continue;
      const base = [t.date, t.status === 'done' ? '実績' : '予定', t.workType, f.name, f.area ?? '', f.crop ?? '', f.variety ?? '', workers, round(laborShare(t, f, state.fields))];
      const mats = (t.materials || []).map((e) => ({ e, m: state.materials.find((x) => x.id === e.materialId) })).filter((x) => x.m);
      if (!mats.length) {
        rows.push([...base, '', '', '', '', '', '', t.memo || '']);
      } else {
        for (const { e, m } of mats) {
          const amount = materialAmountForField(e, f);
          rows.push([...base, m.name, MATERIAL_KINDS[m.kind] || '', e.per10a, round(amount), m.unit || '', Math.round(amount * (Number(m.unitPrice) || 0)), t.memo || '']);
        }
      }
    }
  }
  return rows;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
