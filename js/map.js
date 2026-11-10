// 地図（Leaflet + 国土地理院タイル）と、田んぼの区画の描画

/* global L */
import { esc, today } from './util.js';

const VIEW_KEY = 'tanbo-note:mapView';
const LAYER_KEY = 'tanbo-note:mapLayers';
const ESRI_ATTR = 'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics';
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

  map = L.map(el, { zoomControl: false, attributionControl: true })
    .setView(view ? [view.lat, view.lng] : [36.2, 138.25], view ? view.zoom : 5);

  const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
    maxZoom: 20, maxNativeZoom: 18, attribution: GSI_ATTR,
  });
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, maxNativeZoom: 19, attribution: ESRI_ATTR,
  });
  const std = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    maxZoom: 20, maxNativeZoom: 18, attribution: GSI_ATTR,
  });
  // 写真の上に重ねる地名・県や市町村の境界（地理院地図を半透明で重ねる）
  const labels = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    maxZoom: 20, maxNativeZoom: 18, opacity: 0.45, attribution: GSI_ATTR,
  });
  const bases = { '航空写真（国土地理院）': photo, '航空写真（Esri）': esri, '地図': std };
  const overlays = { '地名・境界を重ねる': labels };
  let pref = {};
  try { pref = JSON.parse(localStorage.getItem(LAYER_KEY) || '{}'); } catch { pref = {}; }
  (bases[pref.base] || photo).addTo(map);
  if (pref.labels !== false) labels.addTo(map);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
  const saveLayerPref = (patch) => {
    pref = { ...pref, ...patch };
    try { localStorage.setItem(LAYER_KEY, JSON.stringify(pref)); } catch { /* 無視 */ }
  };
  map.on('baselayerchange', (e) => saveLayerPref({ base: e.name }));
  map.on('overlayadd', (e) => { if (e.layer === labels) saveLayerPref({ labels: true }); });
  map.on('overlayremove', (e) => { if (e.layer === labels) saveLayerPref({ labels: false }); });

  addSearchControl();
  L.control.zoom({ position: 'bottomright', zoomInTitle: '拡大', zoomOutTitle: '縮小' }).addTo(map);

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

// 地名・住所で検索（国土地理院の地名検索API）
function addSearchControl() {
  const Search = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-search');
      box.innerHTML = `
        <form class="map-search-form" role="search">
          <input type="search" name="q" placeholder="地名・住所で探す（例：新潟市 秋葉区）" aria-label="地名・住所で探す" enterkeyhint="search">
          <button type="submit" class="btn small primary">検索</button>
        </form>
        <ul class="map-search-results" hidden></ul>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      const form = box.querySelector('form');
      const list = box.querySelector('ul');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = form.q.value.trim();
        if (!q) return;
        form.q.blur();
        list.hidden = false;
        list.innerHTML = '<li class="muted">検索中…</li>';
        try {
          const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
          if (!res.ok) throw new Error(String(res.status));
          const items = (await res.json()).slice(0, 8);
          if (!items.length) { list.innerHTML = '<li class="muted">見つかりませんでした</li>'; return; }
          list.innerHTML = items.map((it, i) => `<li><button type="button" data-i="${i}">${esc(it.properties?.title || '')}</button></li>`).join('');
          list.querySelectorAll('button').forEach((b) => {
            b.onclick = () => {
              const [lng, lat] = items[Number(b.dataset.i)].geometry.coordinates;
              map.setView([lat, lng], 16);
              list.hidden = true;
            };
          });
        } catch {
          list.innerHTML = '<li class="muted">検索できませんでした。通信状態を確認してください</li>';
        }
      });
      form.q.addEventListener('input', () => { if (!form.q.value) list.hidden = true; });
      return box;
    },
  });
  new Search().addTo(map);
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
