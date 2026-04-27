'use strict';

// ── 카테고리 ──────────────────────────────────────────────────────────────────
const CATS = {
  food:     { label: '음식점', emoji: '🍽️', color: '#ff6b6b' },
  cafe:     { label: '카페',   emoji: '☕',  color: '#ffa726' },
  landmark: { label: '관광지', emoji: '🏛️', color: '#42a5f5' },
  shopping: { label: '쇼핑',   emoji: '🛍️', color: '#ec407a' },
  nature:   { label: '자연',   emoji: '🌿', color: '#66bb6a' },
  other:    { label: '기타',   emoji: '📍', color: '#0057ff' },
};

// ── IndexedDB (동영상 blob) ───────────────────────────────────────────────────
const videoDB = (() => {
  let db = null;
  const open = () => new Promise((res, rej) => {
    const req = indexedDB.open('placelog_v2', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('blobs');
    req.onsuccess = e => { db = e.target.result; res(); };
    req.onerror = () => rej(req.error);
  });
  const save = (id, blob) => new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob, id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  const get = id => new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
  const remove = id => new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  return { open, save, get, remove };
})();

// ── 상태 ─────────────────────────────────────────────────────────────────────
let map;
let cards       = [];
let markers     = {};     // id → L.Marker
let addMode     = false;
let tempMarker  = null;
let tempLatLng  = null;
let tempAddr    = '';
let pendingFile = null;
let activeId    = null;
let addTab      = 'yt';
let selCat      = 'other';

// 드래그 시트
let sheetDrag = false;
let sheetStartY = 0;

// ── 부트스트랩 ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await videoDB.open().catch(() => {});
  cards = loadCards();
  initMap();
  renderAllPins();
  buildCatPills();
  setupListeners();
  updateBadge();
  document.getElementById('add-date').value = today();
});

// ── 지도 초기화 ───────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    tap: false,
  }).setView([37.5665, 126.9780], 12);

  // CartoDB Voyager 타일 (API 키 없음)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // 사용자 위치로 초기 이동
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => map.setView([p.coords.latitude, p.coords.longitude], 14),
      () => {}
    );
  }

  // 지도 클릭 → 핀 배치
  map.on('click', e => { if (addMode) placeTempPin(e.latlng); });

  // 줌 버튼
  document.getElementById('btn-zoomin').onclick  = () => map.zoomIn();
  document.getElementById('btn-zoomout').onclick = () => map.zoomOut();
}

// ── 핀 아이콘 ─────────────────────────────────────────────────────────────────
function makeIcon(cat, active = false) {
  const c = CATS[cat] || CATS.other;
  return L.divIcon({
    html: `<div class="map-pin${active ? ' is-active' : ''}" style="--pc:${c.color}">
             <div class="pin-bub"><span class="pin-emoji">${c.emoji}</span></div>
           </div>`,
    className: '',
    iconSize:   [38, 30],
    iconAnchor: [19, 30],
    popupAnchor: [0, -32],
  });
}

function makeTempIcon() {
  return L.divIcon({
    html: `<div class="map-pin pin-temp" style="--pc:#8b5cf6">
             <div class="pin-bub"><span class="pin-emoji">📍</span></div>
           </div>`,
    className: '',
    iconSize:   [38, 30],
    iconAnchor: [19, 30],
  });
}

// ── 핀 렌더링 ─────────────────────────────────────────────────────────────────
function renderAllPins() {
  cards.forEach(addPin);
}

function addPin(card) {
  const m = L.marker([card.lat, card.lon], { icon: makeIcon(card.category) }).addTo(map);
  m.on('click', () => openViewSheet(card.id));
  markers[card.id] = m;
}

function removePin(id) {
  if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
}

// ── 추가 모드 ─────────────────────────────────────────────────────────────────
function onFabClick() { addMode ? cancelAddMode() : startAddMode(); }

function startAddMode() {
  addMode = true;
  document.getElementById('add-banner').classList.remove('hidden');
  document.getElementById('btn-fab').classList.add('is-cancel');
  document.getElementById('fab-plus').classList.add('hidden');
  document.getElementById('fab-x').classList.remove('hidden');
  document.getElementById('map').classList.add('add-mode');
  closeSheet();
}

function cancelAddMode() {
  addMode = false;
  document.getElementById('add-banner').classList.add('hidden');
  document.getElementById('btn-fab').classList.remove('is-cancel');
  document.getElementById('fab-plus').classList.remove('hidden');
  document.getElementById('fab-x').classList.add('hidden');
  document.getElementById('map').classList.remove('add-mode');
  clearTempPin();
  closeSheet();
}

function clearTempPin() {
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
  tempLatLng = null;
  tempAddr = '';
}

// ── 핀 배치 + 역지오코딩 ──────────────────────────────────────────────────────
function placeTempPin(latlng) {
  clearTempPin();
  tempLatLng = latlng;

  tempMarker = L.marker(latlng, {
    icon: makeTempIcon(),
    draggable: true,
    zIndexOffset: 1000,
  }).addTo(map);

  tempMarker.on('dragend', e => {
    tempLatLng = e.target.getLatLng();
    reverseGeocode(tempLatLng.lat, tempLatLng.lng);
  });

  openAddSheet();
  reverseGeocode(latlng.lat, latlng.lng);

  // 핀이 시트 뒤에 안 가리도록 살짝 위로
  setTimeout(() => map.panBy([0, 80], { animate: true, duration: 0.3 }), 100);
}

async function reverseGeocode(lat, lon) {
  const nameEl = document.getElementById('add-name');
  const addrEl = document.getElementById('add-addr');

  addrEl.textContent = '주소 불러오는 중...';

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { 'Accept-Language': 'ko,en' } }
    );
    const d = await r.json();
    if (d.display_name) {
      tempAddr = d.display_name;
      addrEl.textContent = d.display_name;
      if (!nameEl.value) nameEl.value = shortName(d.display_name);
    }
  } catch {
    addrEl.textContent = '';
  }
}

// ── 바텀시트 ─────────────────────────────────────────────────────────────────
function openViewSheet(id) {
  activeId = id;
  populateView(id);
  showPanel('p-view');
  openSheet();

  // 활성 핀 강조
  Object.keys(markers).forEach(k => {
    const c = cards.find(c => c.id === k);
    if (c) markers[k].setIcon(makeIcon(c.category, k === id));
  });

  // 핀 위로 지도 이동
  const card = cards.find(c => c.id === id);
  if (card) {
    map.panTo([card.lat, card.lon], { animate: true, duration: 0.3 });
    setTimeout(() => map.panBy([0, 100], { animate: true, duration: 0.25 }), 350);
  }
}

function openAddSheet() {
  resetAddForm();
  showPanel('p-add');
  openSheet();
}

function showPanel(id) {
  document.querySelectorAll('.s-panel').forEach(p => p.classList.toggle('hidden', p.id !== id));
}

function openSheet() {
  const sheet = document.getElementById('sheet');
  sheet.classList.add('is-open');
  liftMapControls(true);
  setTimeout(() => map.invalidateSize(), 360);
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('is-open');
  liftMapControls(false);

  // 활성 핀 강조 해제
  if (activeId) {
    const c = cards.find(c => c.id === activeId);
    if (c && markers[activeId]) markers[activeId].setIcon(makeIcon(c.category, false));
    activeId = null;
  }
  setTimeout(() => map.invalidateSize(), 360);
}

function liftMapControls(up) {
  const sheet = document.getElementById('sheet');
  const h = up ? sheet.offsetHeight : 0;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  document.querySelector('.zoom-ctrl').classList.toggle('lifted', up);
  document.querySelector('.btn-myloc').classList.toggle('lifted', up);
}

// ── 뷰 패널 채우기 ────────────────────────────────────────────────────────────
async function populateView(id) {
  const card = cards.find(c => c.id === id);
  if (!card) return;

  const cat = CATS[card.category] || CATS.other;

  const catEl = document.getElementById('sv-cat');
  catEl.textContent = `${cat.emoji} ${cat.label}`;
  catEl.style.color = cat.color;

  document.getElementById('sv-name').textContent = card.name;
  document.getElementById('sv-addr').textContent = card.address || '';
  document.getElementById('sv-date').textContent = card.date ? `📅 ${card.date}` : '';
  document.getElementById('sv-memo').textContent = card.memo || '';
  document.getElementById('sv-maplink').href =
    `https://maps.google.com/?q=${card.lat},${card.lon}`;

  const mediaEl = document.getElementById('sv-media');
  mediaEl.innerHTML = '';

  if (card.mediaType === 'youtube' && card.mediaId) {
    mediaEl.innerHTML =
      `<iframe src="https://www.youtube.com/embed/${card.mediaId}?rel=0"
               frameborder="0" allowfullscreen
               allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
       </iframe>`;
  } else if (card.mediaType === 'video') {
    const vid = document.createElement('video');
    vid.controls = vid.playsInline = true;
    vid.preload = 'metadata';
    mediaEl.appendChild(vid);
    const blob = await videoDB.get(id).catch(() => null);
    if (blob) vid.src = URL.createObjectURL(blob);
  }
}

// ── 추가 폼 ───────────────────────────────────────────────────────────────────
function resetAddForm() {
  document.getElementById('add-name').value = '';
  document.getElementById('add-addr').textContent = '';
  document.getElementById('add-yt').value = '';
  document.getElementById('yt-prev').innerHTML = '';
  document.getElementById('file-prev').innerHTML = '';
  document.getElementById('cam-prev').innerHTML = '';
  document.getElementById('s-upzone').style.display = '';
  document.getElementById('add-memo').value = '';
  document.getElementById('add-date').value = today();
  pendingFile = null;
  selCat = 'other';
  switchAddTab('yt');
  document.querySelectorAll('.cat-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.cat === 'other')
  );
}

function cancelAdd() {
  clearTempPin();
  closeSheet();
}

// ── 카테고리 필 ───────────────────────────────────────────────────────────────
function buildCatPills() {
  const wrap = document.getElementById('cat-pills');
  Object.entries(CATS).forEach(([key, c]) => {
    const btn = document.createElement('button');
    btn.className = `cat-pill${key === 'other' ? ' active' : ''}`;
    btn.dataset.cat = key;
    btn.textContent = `${c.emoji} ${c.label}`;
    btn.onclick = () => {
      selCat = key;
      document.querySelectorAll('.cat-pill').forEach(p =>
        p.classList.toggle('active', p.dataset.cat === key)
      );
    };
    wrap.appendChild(btn);
  });
}

// ── 미디어 탭 ─────────────────────────────────────────────────────────────────
function switchAddTab(tab) {
  addTab = tab;
  document.querySelectorAll('.s-tab').forEach(t => t.classList.toggle('active', t.dataset.stab === tab));
  document.querySelectorAll('.s-tabp').forEach(p => p.classList.toggle('hidden', p.id !== `sp-${tab}`));
}

// ── YouTube 파싱 ─────────────────────────────────────────────────────────────
function parseYtId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be'))    return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v'))           return u.searchParams.get('v');
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2];
      if (u.pathname.startsWith('/embed/'))  return u.pathname.split('/')[2];
    }
  } catch {}
  return null;
}

function previewYt() {
  const id = parseYtId(document.getElementById('add-yt').value.trim());
  document.getElementById('yt-prev').innerHTML = id
    ? `<iframe src="https://www.youtube.com/embed/${id}?rel=0" frameborder="0" allowfullscreen
               allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
       </iframe>`
    : '';
}

// ── 파일 처리 ─────────────────────────────────────────────────────────────────
function handleFile(file, prevId, zoneId) {
  if (!file?.type.startsWith('video/')) { toast('동영상 파일만 업로드할 수 있어요'); return; }
  if (file.size > 200 * 1024 * 1024)   { toast('200MB 이하 파일만 업로드 가능해요'); return; }

  pendingFile = file;
  const src = URL.createObjectURL(file);
  const zone = document.getElementById(zoneId);
  const prev = document.getElementById(prevId);
  if (zone) zone.style.display = 'none';

  prev.innerHTML = `
    <div class="upl-done">
      <video src="${src}" controls playsinline preload="metadata"></video>
      <div class="upl-meta">${esc(file.name)} · ${(file.size/1024/1024).toFixed(1)} MB</div>
      <button class="btn-clr" onclick="clearFile('${prevId}','${zoneId}')">✕</button>
    </div>`;
}

function clearFile(prevId, zoneId) {
  pendingFile = null;
  document.getElementById(prevId).innerHTML = '';
  const zone = document.getElementById(zoneId);
  if (zone) zone.style.display = '';
}

// ── 저장 ─────────────────────────────────────────────────────────────────────
async function saveCard() {
  const name = document.getElementById('add-name').value.trim();
  if (!name)       { toast('장소명을 입력해주세요'); return; }
  if (!tempLatLng) { toast('지도를 탭해서 위치를 선택해주세요'); return; }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  let mediaType = null, mediaId = null;

  if (addTab === 'yt') {
    const id = parseYtId(document.getElementById('add-yt').value);
    if (id) { mediaType = 'youtube'; mediaId = id; }
  } else if (pendingFile) {
    mediaType = 'video';
  }

  const id = uid();
  const card = {
    id,
    name,
    address:   tempAddr,
    category:  selCat,
    lat:       tempLatLng.lat,
    lon:       tempLatLng.lng,
    mediaType,
    mediaId,
    date:      document.getElementById('add-date').value,
    memo:      document.getElementById('add-memo').value.trim(),
    createdAt: new Date().toISOString(),
  };

  if (mediaType === 'video' && pendingFile) {
    await videoDB.save(id, pendingFile).catch(() => {});
  }

  cards.push(card);
  persistCards();
  addPin(card);
  updateBadge();

  // 임시 핀 제거
  clearTempPin();
  cancelAddMode();
  closeSheet();
  toast(`${name} 저장됐어요 📍`);
}

// ── 삭제 ─────────────────────────────────────────────────────────────────────
async function deleteActive() {
  if (!activeId) return;
  const card = cards.find(c => c.id === activeId);
  if (!card) return;
  if (!confirm(`"${card.name}" 을(를) 삭제할까요?`)) return;

  if (card.mediaType === 'video') await videoDB.remove(activeId).catch(() => {});
  removePin(activeId);
  cards = cards.filter(c => c.id !== activeId);
  persistCards();
  updateBadge();
  closeSheet();
  toast('삭제됐어요');
}

// ── 공유 ─────────────────────────────────────────────────────────────────────
async function shareActive() {
  const card = cards.find(c => c.id === activeId);
  if (!card) return;

  const cat = CATS[card.category] || CATS.other;
  const text = [
    `${cat.emoji} ${card.name}`,
    card.address,
    card.memo,
    `🗺️ https://maps.google.com/?q=${card.lat},${card.lon}`,
    '',
    'PLACELOG으로 기록됨',
  ].filter(Boolean).join('\n');

  if (navigator.share) {
    try { await navigator.share({ title: card.name, text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  await navigator.clipboard.writeText(text).catch(() => {});
  toast('클립보드에 복사됐어요 ✓');
}

// ── 내 위치 ───────────────────────────────────────────────────────────────────
function goMyLocation() {
  if (!navigator.geolocation) { toast('위치 권한이 필요해요'); return; }
  navigator.geolocation.getCurrentPosition(
    p => map.setView([p.coords.latitude, p.coords.longitude], 15, { animate: true }),
    () => toast('위치를 가져올 수 없어요')
  );
}

// ── 이벤트 리스너 ─────────────────────────────────────────────────────────────
function setupListeners() {
  // YouTube 실시간 미리보기
  const ytEl = document.getElementById('add-yt');
  ytEl.addEventListener('input', debounce(previewYt, 600));
  ytEl.addEventListener('paste', () => setTimeout(previewYt, 80));

  // 파일 업로드
  document.getElementById('file-inp').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0], 'file-prev', 's-upzone');
  });

  // 업로드 존 클릭
  document.getElementById('s-upzone').addEventListener('click', () =>
    document.getElementById('file-inp').click()
  );

  // 드래그&드롭
  const zone = document.getElementById('s-upzone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], 'file-prev', 's-upzone');
  });

  // 카메라
  document.getElementById('cam-inp').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0], 'cam-prev', null);
  });

  // ESC → 시트 닫기
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('sheet').classList.contains('is-open')) closeSheet();
      else if (addMode) cancelAddMode();
    }
  });

  // 시트 드래그 (스와이프 다운으로 닫기)
  setupSheetDrag();
}

function setupSheetDrag() {
  const dragEl = document.getElementById('sheet-drag');
  const sheet  = document.getElementById('sheet');

  const onStart = e => {
    sheetStartY = (e.touches || [e])[0].clientY;
    sheetDrag = true;
    sheet.style.transition = 'none';
  };
  const onMove = e => {
    if (!sheetDrag) return;
    const dy = (e.touches || [e])[0].clientY - sheetStartY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = e => {
    if (!sheetDrag) return;
    sheetDrag = false;
    const dy = (e.changedTouches || [e])[0].clientY - sheetStartY;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) closeSheet();
  };

  dragEl.addEventListener('touchstart', onStart, { passive: true });
  dragEl.addEventListener('touchmove',  onMove,  { passive: true });
  dragEl.addEventListener('touchend',   onEnd,   { passive: true });
  dragEl.addEventListener('mousedown',  onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onEnd);
}

// ── localStorage ─────────────────────────────────────────────────────────────
function loadCards() {
  try { return JSON.parse(localStorage.getItem('placelog') || '[]'); }
  catch { return []; }
}
function persistCards() {
  localStorage.setItem('placelog', JSON.stringify(cards));
}

function updateBadge() {
  document.getElementById('pin-badge').textContent = `${cards.length} 곳`;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shortName(displayName) {
  return (displayName || '').split(',')[0].trim() || '새 장소';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}
