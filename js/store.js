// データの保存と読み込み。
// いまはブラウザの localStorage に保存する。将来クラウド同期（Firebase など）に
// 差し替えるときは、この load / update / subscribe の形を保ったまま中身を入れ替える。

import { uid } from './util.js';

const KEY = 'tanbo-note:data:v1';
const SCHEMA_VERSION = 1;

export const DEFAULT_WORK_TYPES = [
  '耕起', '畦塗り', '入水', '代かき', '育苗', '田植え', '施肥', '追肥',
  '除草剤散布', '防除', '水管理', '中干し', '草刈り', '畦畔管理',
  '稲刈り', '乾燥調製', '出荷', '見回り', 'その他',
];

function defaults() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { farmName: '', me: '' },
    fields: [],
    tasks: [],
    workers: [],
    materials: [],
    workTypes: [...DEFAULT_WORK_TYPES],
  };
}

function normalize(data) {
  const base = defaults();
  const out = { ...base, ...(data && typeof data === 'object' ? data : {}) };
  out.settings = { ...base.settings, ...(out.settings || {}) };
  for (const key of ['fields', 'tasks', 'workers', 'materials', 'workTypes']) {
    if (!Array.isArray(out[key])) out[key] = base[key];
  }
  out.tasks = out.tasks.map((t) => ({
    status: 'planned', fieldIds: [], workerIds: [], materials: [], hours: 0, memo: '',
    ...t,
  }));
  out.schemaVersion = SCHEMA_VERSION;
  return out;
}

let state = defaults();
const listeners = new Set();
let saveFailed = false;

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? normalize(JSON.parse(raw)) : defaults();
  } catch (e) {
    console.warn('データの読み込みに失敗しました', e);
    state = defaults();
  }
  return state;
}

export function get() {
  return state;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    saveFailed = false;
  } catch (e) {
    console.warn('保存に失敗しました', e);
    saveFailed = true;
  }
}

export function lastSaveFailed() {
  return saveFailed;
}

// state を変更して保存し、画面に通知する
export function update(mutator) {
  mutator(state);
  save();
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function newId() {
  return uid();
}

// 一覧から id で探す
export function byId(list, id) {
  return list.find((x) => x.id === id);
}

export function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

export function remove(list, id) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
}

export function exportJSON() {
  return JSON.stringify({ app: 'tanbo-note', exportedAt: new Date().toISOString(), data: state }, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  const data = parsed && parsed.app === 'tanbo-note' ? parsed.data : parsed;
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.tasks)) {
    throw new Error('田んぼノートのデータではありません');
  }
  update((s) => {
    const next = normalize(data);
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, next);
  });
}

export function resetAll() {
  update((s) => {
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, defaults());
  });
}
