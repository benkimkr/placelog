'use strict';

// ── IndexedDB (video blob storage) ──────────────────────────────────────────
const videoDB = (() => {
  let db = null;

  const open = () => new Promise((res, rej) => {
    const req = indexedDB.open('placelog_v1', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('blobs');
    req.onsuccess = e => { db = e.target.result; res(); };
    req.onerror = () => rej(req.error);
  });

  const save = (id, blob) => new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob, id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });

  const get = id => new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  const remove = id => new Promise((res, rej) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });

  return { open, save, get, remove };
})();

// ── App State ────────────────────────────────────────────────────────────────
let cards = [];
let activeStep = 1;
let activeTab = 'youtube';
let mapData = null;        // { lat, lon, display_name, mapUrl }
let pendingVideoFile = null;
const mapState = {};       // cardId → 'media' | 'map'

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await videoDB.open().catch(() => {});
  cards = loadCards();
  renderFeed();
  setupListeners();
});

// ── Persistence ──────────────────────────────────────────────────────────────
function loadCards() {
  try { return JSON.parse(localStorage.getItem('placelog') || '[]'); }
  catch { return []; }
}

function persistCards() {
  localStorage.setItem('placelog', JSON.stringify(cards));
}

// ── Feed ─────────────────────────────────────────────────────────────────────
function renderFeed() {
  const feed = document.getElementById('feed');
  const empty = document.getElementById('empty-state');

  feed.querySelectorAll('.card').forEach(c => c.remove());

  if (!cards.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  [...cards].reverse().forEach(card => feed.appendChild(buildCard(card)));
  cards.forEach(c => { if (c.mediaType === 'video') loadVideoSrc(c.id); });
}

function buildCard(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;

  const name = shortName(card.placeFullName || card.placeName);
  const tagsHtml = (card.tags || [])
    .map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const mapsHref = `https://maps.google.com/?q=${card.lat},${card.lon}`;

  el.innerHTML = `
    <div class="card-media">
      <div id="mc-${card.id}">${buildMediaHtml(card)}</div>
      <div class="card-overlay-top">
        <div class="card-location">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
          <span>${esc(name)}</span>
        </div>
        ${card.mediaType !== 'none'
          ? `<button class="btn-toggle-map" onclick="toggleMap('${card.id}')">🗺️ 지도</button>`
          : ''}
      </div>
    </div>
    <div class="card-body">
      ${card.caption ? `<p class="card-caption">${esc(card.caption)}</p>` : ''}
      ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
      <div class="card-footer">
        <span class="card-date">${fmtDate(card.createdAt)}</span>
        <div class="card-footer-right">
          <a class="btn-icon-sm" href="${mapsHref}" target="_blank" rel="noopener" title="구글맵에서 보기">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/>
            </svg>
          </a>
          <button class="btn-icon-sm" onclick="shareCard('${card.id}')" title="공유">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/>
            </svg>
          </button>
          <button class="btn-icon-sm danger" onclick="deleteCard('${card.id}')" title="삭제">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>`;

  return el;
}

function buildMediaHtml(card) {
  switch (card.mediaType) {
    case 'youtube':
      return `<iframe src="https://www.youtube.com/embed/${card.mediaId}?rel=0"
                frameborder="0" allowfullscreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
              </iframe>`;
    case 'instagram':
      return `<iframe class="ig"
                src="https://www.instagram.com/${card.igType || 'p'}/${card.mediaId}/embed/"
                frameborder="0" scrolling="no" allowtransparency="true">
              </iframe>`;
    case 'video':
      return `<video data-vid="${card.id}" controls playsinline preload="metadata"></video>`;
    default:
      return `<iframe src="${esc(card.mapUrl)}" frameborder="0"
                style="border:0;width:100%;height:100%" loading="lazy">
              </iframe>`;
  }
}

async function loadVideoSrc(cardId) {
  const vid = document.querySelector(`video[data-vid="${cardId}"]`);
  if (!vid || vid.src) return;
  const blob = await videoDB.get(cardId).catch(() => null);
  if (blob) vid.src = URL.createObjectURL(blob);
}

// ── Map Toggle ────────────────────────────────────────────────────────────────
function toggleMap(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (!card) return;

  const mc  = document.getElementById(`mc-${cardId}`);
  const btn = mc.closest('.card-media').querySelector('.btn-toggle-map');

  if (mapState[cardId] === 'map') {
    mc.innerHTML = buildMediaHtml(card);
    if (card.mediaType === 'video') loadVideoSrc(cardId);
    mapState[cardId] = 'media';
    btn.innerHTML = '🗺️ 지도';
  } else {
    mc.innerHTML = `<iframe src="${esc(card.mapUrl)}" frameborder="0"
                      style="border:0;width:100%;height:100%" loading="lazy"></iframe>`;
    mapState[cardId] = 'map';
    btn.innerHTML = '▶️ 미디어';
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openCreateModal() {
  resetDraft();
  document.getElementById('create-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('place-input').focus(), 350);
}

function closeCreateModal() {
  document.getElementById('create-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  resetDraft();
}

function resetDraft() {
  mapData = null;
  pendingVideoFile = null;

  // Step 1
  document.getElementById('place-input').value = '';
  document.getElementById('map-iframe').src = '';
  document.getElementById('map-iframe').style.display = 'none';
  document.getElementById('map-placeholder').style.cssText = '';
  document.getElementById('map-placeholder').innerHTML = `
    <svg width="40" height="40" viewBox="0 0 24 24" fill="var(--text-muted)">
      <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/>
    </svg>
    <p>장소를 검색하면 지도가 표시됩니다</p>`;
  document.getElementById('place-name-hint').textContent = '';
  document.getElementById('btn-next-1').disabled = true;
  setBtnSearchIcon();

  // Step 2
  document.getElementById('youtube-url').value = '';
  document.getElementById('instagram-url').value = '';
  document.getElementById('yt-preview').innerHTML = '';
  document.getElementById('ig-preview').innerHTML = '';
  document.getElementById('upload-preview').innerHTML = '';
  document.getElementById('upload-zone').style.display = '';

  // Step 3
  document.getElementById('caption').value = '';
  document.getElementById('tags-input').value = '';

  // Reset tabs to youtube
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'youtube'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-youtube'));
  activeTab = 'youtube';

  // Go to step 1 (hide current step if different)
  document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
  document.getElementById('step-1').classList.remove('hidden');
  document.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('active', i === 0));
  activeStep = 1;
}

function goStepBack() {
  if (activeStep > 1) goStep(activeStep - 1);
  else closeCreateModal();
}

function goStep(n) {
  document.getElementById(`step-${activeStep}`).classList.add('hidden');
  document.getElementById(`step-${n}`).classList.remove('hidden');
  document.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('active', i + 1 === n));
  if (n === 3) populateStep3();
  activeStep = n;
}

function populateStep3() {
  if (!mapData) return;
  const name = shortName(mapData.display_name);
  document.getElementById('mini-name').textContent = name;
  document.getElementById('mini-full').textContent = mapData.display_name;
  document.getElementById('mini-map').innerHTML =
    `<iframe src="${esc(mapData.mapUrl)}" loading="lazy" style="border:none"></iframe>`;
}

// ── Place Search ──────────────────────────────────────────────────────────────
async function searchPlace() {
  const q = document.getElementById('place-input').value.trim();
  if (!q) return;

  const ph      = document.getElementById('map-placeholder');
  const iframe  = document.getElementById('map-iframe');
  const hint    = document.getElementById('place-name-hint');
  const btnNext = document.getElementById('btn-next-1');

  iframe.style.display = 'none';
  ph.style.cssText = '';
  ph.innerHTML = `<div class="spinner"></div><p>검색 중...</p>`;
  hint.textContent = '';
  btnNext.disabled = true;
  mapData = null;

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`,
      { headers: { 'Accept-Language': 'ko,en' } }
    );
    const data = await res.json();

    if (!data.length) {
      ph.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><p style="color:var(--text-muted)">찾을 수 없어요<br>다른 이름으로 검색해보세요</p>`;
      setBtnSearchIcon();
      return;
    }

    const { lat, lon, display_name } = data[0];
    const d = 0.007;
    const bbox = `${+lon - d},${+lat - d},${+lon + d},${+lat + d}`;
    const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;

    mapData = { lat, lon, display_name, mapUrl };

    ph.style.display = 'none';
    iframe.src = mapUrl;
    iframe.style.display = 'block';
    hint.textContent = display_name;
    btnNext.disabled = false;

  } catch {
    ph.innerHTML = `<p style="color:var(--text-muted);font-size:13px">검색 중 오류가 발생했어요</p>`;
  }

  setBtnSearchIcon();
}

function setBtnSearchIcon() {
  document.getElementById('btn-search').innerHTML =
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
       <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
     </svg>`;
}

// ── Media Tabs ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${tab}`));
}

// ── YouTube ───────────────────────────────────────────────────────────────────
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

function previewYoutube() {
  const id = parseYtId(document.getElementById('youtube-url').value.trim());
  document.getElementById('yt-preview').innerHTML = id
    ? `<iframe src="https://www.youtube.com/embed/${id}?rel=0" frameborder="0" allowfullscreen
               allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
       </iframe>`
    : '';
}

// ── Instagram ─────────────────────────────────────────────────────────────────
function parseIgInfo(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('instagram.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[0] === 'p' || parts[0] === 'reel'))
      return { type: parts[0], id: parts[1] };
  } catch {}
  return null;
}

function previewInstagram() {
  const info = parseIgInfo(document.getElementById('instagram-url').value.trim());
  document.getElementById('ig-preview').innerHTML = info
    ? `<iframe class="ig"
               src="https://www.instagram.com/${info.type}/${info.id}/embed/"
               frameborder="0" scrolling="no" allowtransparency="true">
       </iframe>`
    : '';
}

// ── Video Upload ──────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file?.type.startsWith('video/')) { toast('동영상 파일만 업로드할 수 있어요'); return; }
  if (file.size > 200 * 1024 * 1024)   { toast('200MB 이하 파일만 업로드 가능해요'); return; }

  pendingVideoFile = file;
  const src = URL.createObjectURL(file);

  document.getElementById('upload-zone').style.display = 'none';
  document.getElementById('upload-preview').innerHTML = `
    <div class="upload-done">
      <video src="${src}" controls playsinline preload="metadata"></video>
      <div class="upload-meta">${esc(file.name)} (${(file.size / 1024 / 1024).toFixed(1)} MB)</div>
      <button class="btn-clear-upload" onclick="clearUpload()">✕</button>
    </div>`;
}

function clearUpload() {
  pendingVideoFile = null;
  document.getElementById('upload-preview').innerHTML = '';
  document.getElementById('upload-zone').style.display = '';
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveCard() {
  if (!mapData) { toast('장소를 먼저 선택해주세요'); return; }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  const caption = document.getElementById('caption').value.trim();
  const rawTags = document.getElementById('tags-input').value.trim();
  const tags = rawTags
    ? rawTags.split(/[\s,，]+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean).map(t => '#' + t)
    : [];

  let mediaType = 'none', mediaId = null, igType = null;

  const ytId  = parseYtId(document.getElementById('youtube-url').value);
  const igInfo = parseIgInfo(document.getElementById('instagram-url').value);

  if (activeTab === 'youtube'   && ytId)           { mediaType = 'youtube';   mediaId = ytId; }
  else if (activeTab === 'instagram' && igInfo)    { mediaType = 'instagram'; mediaId = igInfo.id; igType = igInfo.type; }
  else if (activeTab === 'upload'    && pendingVideoFile) { mediaType = 'video'; }

  const id = uid();
  const card = {
    id,
    placeName:     shortName(mapData.display_name),
    placeFullName: mapData.display_name,
    lat:      mapData.lat,
    lon:      mapData.lon,
    mapUrl:   mapData.mapUrl,
    mediaType, mediaId, igType,
    caption, tags,
    createdAt: new Date().toISOString()
  };

  if (mediaType === 'video' && pendingVideoFile) {
    await videoDB.save(id, pendingVideoFile).catch(() => {});
  }

  cards.push(card);
  persistCards();
  renderFeed();
  closeCreateModal();
  toast('장소가 저장됐어요 📍');

  if (mediaType === 'video') setTimeout(() => loadVideoSrc(id), 200);
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteCard(id) {
  if (!confirm('이 기록을 삭제할까요?')) return;
  const card = cards.find(c => c.id === id);
  if (card?.mediaType === 'video') await videoDB.remove(id).catch(() => {});
  cards = cards.filter(c => c.id !== id);
  persistCards();
  renderFeed();
  toast('삭제됐어요');
}

// ── Share ─────────────────────────────────────────────────────────────────────
async function shareCard(id) {
  const card = cards.find(c => c.id === id);
  if (!card) return;

  const name = shortName(card.placeFullName || card.placeName);
  const tags = (card.tags || []).join(' ');
  const mapsUrl = `https://maps.google.com/?q=${card.lat},${card.lon}`;
  const text = [
    `📍 ${name}`,
    card.caption,
    tags,
    `🗺️ ${mapsUrl}`,
    '',
    'PLACELOG으로 기록됨'
  ].filter(Boolean).join('\n');

  if (navigator.share) {
    try { await navigator.share({ title: `PLACELOG — ${name}`, text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }

  try {
    await navigator.clipboard.writeText(text);
    toast('클립보드에 복사됐어요 ✓');
  } catch {
    toast('공유 기능을 사용할 수 없어요');
  }
}

// ── Listeners ─────────────────────────────────────────────────────────────────
function setupListeners() {
  // Enter on place search
  document.getElementById('place-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchPlace();
  });

  // YouTube live preview
  const ytEl = document.getElementById('youtube-url');
  ytEl.addEventListener('input',  debounce(previewYoutube, 600));
  ytEl.addEventListener('paste',  () => setTimeout(previewYoutube, 80));

  // Instagram live preview
  const igEl = document.getElementById('instagram-url');
  igEl.addEventListener('input',  debounce(previewInstagram, 600));
  igEl.addEventListener('paste',  () => setTimeout(previewInstagram, 80));

  // File picker
  document.getElementById('file-input').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  // Upload zone click
  const zone = document.getElementById('upload-zone');
  zone.addEventListener('click', () => document.getElementById('file-input').click());

  // Drag & drop
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Close on backdrop click
  document.getElementById('create-overlay').addEventListener('click', e => {
    if (e.target.id === 'create-overlay') closeCreateModal();
  });

  // Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCreateModal();
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function shortName(displayName) {
  if (!displayName) return '알 수 없는 장소';
  return displayName.split(',')[0].trim();
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
