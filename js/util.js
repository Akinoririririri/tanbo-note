// 共通ユーティリティ

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ローカル時刻での YYYY-MM-DD
export function today() {
  return toISODate(new Date());
}

export function toISODate(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00');
  const b = new Date(toIso + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}

export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('ja-JP', { maximumFractionDigits: digits });
}

export function fmtArea(a) {
  return `${fmtNum(a, 1)} a`;
}

export function fmtYen(n) {
  return `${Math.round(n || 0).toLocaleString('ja-JP')} 円`;
}

export function num(value) {
  const n = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ファイルとしてダウンロードさせる
export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

// モーダル（<dialog id="modal">）を開く
export function openModal(title, bodyHTML, { onSubmit, submitLabel = '保存', extraButtons = '', onReady } = {}) {
  const dlg = document.getElementById('modal');
  dlg.innerHTML = `
    <form class="modal-form" novalidate>
      <header class="modal-head"><h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="閉じる">✕</button></header>
      <div class="modal-body">${bodyHTML}</div>
      <footer class="modal-actions">
        ${extraButtons}
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>キャンセル</button>
        ${onSubmit ? `<button class="btn primary" type="submit">${esc(submitLabel)}</button>` : ''}
      </footer>
    </form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const result = onSubmit(form);
    if (result !== false) dlg.close();
  });
  dlg.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => dlg.close()));
  if (!dlg.open) dlg.showModal();
  onReady?.(form, dlg);
  return { dlg, form };
}

export function closeModal() {
  const dlg = document.getElementById('modal');
  if (dlg.open) dlg.close();
}
