// 地図（Leaflet + 国土地理院タイル）と、田んぼの区画の描画

/* global L */
import { esc, today } from './util.js';

const VIEW_KEY = 'tanbo-note:mapView';
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';

let map = null;
let fieldLayer = null;
let drawLayer = null;
let locateLayer = null;
let drawing = null; // { points: [[lat,lng]], editingId }
let handlers = {};
let toolbar = null;

export const STATUS_COLORS = {
  planned: '#e8890c', // 今日の予定あり
  done: '#2f9e44', // 今日の作業が完了
  none: '#2b7de9', // 今日は作業なし
};

export function isReady() {
  return !!map;
}

export function initMap(el, opts) {
  handlers = opts || {};
  if (typeof L === 'undefined') {
    el.innerHTML = '<p class="map-error">地図ライブラリを読み込めませんでした。通信状態を確認して再読み込みしてください。</p>';
    return;
  }
  let view = null;
  try { view = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch { view = null; }

  map = L.map(el, { zoomControl: true, attributionControl: true })
    .setView(view ? [view.lat, view.lng] : [36.2, 138.25], view ? view.zoom : 5);

  const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
    maxZoom: 20, maxNativeZoom: 18, attribution: GSI_ATTR,
  });
  const std = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    maxZoom: 20, maxNativeZoom: 18, attribution: GSI_ATTR,
  });
  photo.addTo(map);
  L.control.layers({ '航空写真': photo, '地図': std }, null, { position: 'topright' }).addTo(map);

  fieldLayer = L.layerGroup().addTo(map);
  drawLayer = L.layerGroup().addTo(map);
  locateLayer = L.layerGroup().addTo(map);

  map.on('moveend', () => {
    const c = map.getCenter();
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() })); } catch { /* 保存できなくても動作は続ける */ }
  });
  map.on('click', (e) => {
    if (!drawing) return;
    drawing.points.push([round6(e.latlng.lat), round6(e.latlng.lng)]);
    redrawDraft();
  });
  map.on('locationfound', (e) => {
    locateLayer.clearLayers();
    L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: '#2b7de9', fillOpacity: 0.1 }).addTo(locateLayer);
    L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#2b7de9', fillOpacity: 1 }).addTo(locateLayer);
  });
  map.on('locationerror', () => handlers.onMessage?.('現在地を取得できませんでした'));

  toolbar = document.createElement('div');
  toolbar.className = 'draw-toolbar';
  toolbar.hidden = true;
  el.appendChild(toolbar);
  L.DomEvent.disableClickPropagation(toolbar);
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-draw]');
    if (!btn) return;
    const act = btn.dataset.draw;
    if (act === 'undo') { drawing?.points.pop(); redrawDraft(); }
    if (act === 'cancel') stopDrawing();
    if (act === 'done') finishDrawing();
  });
}

export function refreshSize() {
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

function fieldStatus(state, fieldId) {
  const d = today();
  const tasks = state.tasks.filter((t) => t.date === d && (t.fieldIds || []).includes(fieldId));
  if (!tasks.length) return 'none';
  return tasks.some((t) => t.status !== 'done') ? 'planned' : 'done';
}

export function renderFields(state) {
  if (!map) return;
  fieldLayer.clearLayers();
  for (const f of state.fields) {
    if (!f.polygon || f.polygon.length < 3) continue;
    const color = STATUS_COLORS[fieldStatus(state, f.id)];
    const poly = L.polygon(f.polygon, { color, weight: 2, fillColor: color, fillOpacity: 0.28 });
    poly.bindTooltip(esc(f.name), { permanent: true, direction: 'center', className: 'field-label' });
    poly.on('click', (e) => {
      if (drawing) return; // 描画中は地図クリックとして扱う（map の click に任せる）
      L.DomEvent.stopPropagation(e);
      handlers.onFieldClick?.(f.id);
    });
    poly.addTo(fieldLayer);
  }
}

export function focusField(field) {
  if (!map || !field?.polygon?.length) return;
  map.fitBounds(L.latLngBounds(field.polygon), { maxZoom: 18, padding: [30, 30], animate: false });
}

export function fitAll(state) {
  if (!map) return;
  const pts = state.fields.flatMap((f) => f.polygon || []);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { maxZoom: 17, padding: [30, 30] });
}

export function locate() {
  map?.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true });
}

export function isDrawing() {
  return !!drawing;
}

export function startDrawing(editingId = null) {
  if (!map) return false;
  if (map.getZoom() < 15) {
    handlers.onMessage?.('田んぼが大きく見えるところまで地図を拡大してから、もう一度押してください');
    return false;
  }
  drawing = { points: [], editingId };
  map.getContainer().classList.add('drawing');
  toolbar.hidden = false;
  redrawDraft();
  return true;
}

function stopDrawing() {
  drawing = null;
  drawLayer.clearLayers();
  toolbar.hidden = true;
  map.getContainer().classList.remove('drawing');
}

function finishDrawing() {
  if (!drawing || drawing.points.length < 3) {
    handlers.onMessage?.('角を3点以上タップしてください');
    return;
  }
  const { points, editingId } = drawing;
  stopDrawing();
  handlers.onDrawDone?.(points, editingId);
}

function redrawDraft() {
  drawLayer.clearLayers();
  const pts = drawing?.points || [];
  if (pts.length >= 3) L.polygon(pts, { color: '#ffd43b', weight: 2, dashArray: '6 4', fillOpacity: 0.2 }).addTo(drawLayer);
  else if (pts.length === 2) L.polyline(pts, { color: '#ffd43b', weight: 2, dashArray: '6 4' }).addTo(drawLayer);
  pts.forEach((p) => L.circleMarker(p, { radius: 5, color: '#000', weight: 1, fillColor: '#ffd43b', fillOpacity: 1 }).addTo(drawLayer));
  toolbar.innerHTML = `
    <span class="draw-hint">田んぼの角を順にタップ（${pts.length}点）</span>
    <button type="button" class="btn small" data-draw="undo" ${pts.length ? '' : 'disabled'}>1点戻す</button>
    <button type="button" class="btn small" data-draw="cancel">やめる</button>
    <button type="button" class="btn small primary" data-draw="done" ${pts.length >= 3 ? '' : 'disabled'}>完了</button>`;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
