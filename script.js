'use strict';

// ── 카카오 OAuth 설정 ─────────────────────────────────────────────────────────
const KAKAO_JS_KEY = 'a0a94073377626348a12a0473d152c0c';

// ── Firebase 설정 ─────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyBcTMKjYDFOZ0MK7dvCJEkj-4aZzRub1L0',
  authDomain:        'placelog-75bbe.firebaseapp.com',
  projectId:         'placelog-75bbe',
  storageBucket:     'placelog-75bbe.firebasestorage.app',
  messagingSenderId: '715846954889',
  appId:             '1:715846954889:web:3f10bbac1e17bf66933b58',
};
let db;

// ── 카테고리 ──────────────────────────────────────────────────────────────────
const CATS = {
  park:    { label: '공원',        emoji: '🌳', color: '#4ade80' },
  trail:   { label: '산책로',      emoji: '🐾', color: '#86efac' },
  dogcafe: { label: '강아지 카페', emoji: '🐶', color: '#fb923c' },
  vet:     { label: '동물병원',    emoji: '🏥', color: '#60a5fa' },
  petshop: { label: '반려견 용품', emoji: '🛍️', color: '#f472b6' },
};

// 발바닥 SVG (핀 마커용)
const PAW_SVG = `<svg class="pin-paw" viewBox="0 0 24 24" width="19" height="19" fill="rgba(255,255,255,.95)">
  <ellipse cx="12" cy="16.5" rx="5.2" ry="4.2"/>
  <circle cx="6.2"  cy="11.5" r="2.4"/>
  <circle cx="10.4" cy="7.8"  r="2.4"/>
  <circle cx="13.6" cy="7.8"  r="2.4"/>
  <circle cx="17.8" cy="11.5" r="2.4"/>
</svg>`;

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
let cards         = [];
let markers       = {};    // id → kakao.maps.CustomOverlay
let addMode       = false;
let tempMarker    = null;  // kakao.maps.CustomOverlay (임시 핀)
let tempLatLng    = null;  // kakao.maps.LatLng
let tempAddr      = '';
let pendingFile   = null;
let activeId      = null;
let addTab        = 'yt';
let selCat        = 'park';
let searchResults = [];

// 인증
let currentUser  = null;

// 컬렉션 / 다중 구독
let myCollections      = [];
let collectionsUnsub   = null;
let placesUnsubList    = [];
let cardBuckets        = new Map();  // 'personal' | collectionId → cards[]
let pendingInviteCol   = null;

// 드래그 시트
let sheetDrag  = false;
let sheetStartY = 0;

// 탭 / 피드
let currentTab = 'map';
let feedRegion = 'all';

// ── Firestore 초기화 ──────────────────────────────────────────────────────────
function initFirestore() {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
}

function setCardBucket(key, newCards) {
  cardBuckets.set(key, newCards);
  const merged = new Map();
  cardBuckets.forEach(bucket => bucket.forEach(c => merged.set(c.id, c)));
  cards = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (map) refreshPins();
  updateBadge();
  if (currentTab === 'feed') renderFeed();
  if (currentTab === 'collections') renderCollectionsView();
}

function refreshPlacesSubscriptions() {
  placesUnsubList.forEach(u => u());
  placesUnsubList = [];
  cardBuckets.clear();

  const u1 = db.collection('places')
    .where('userId', '==', currentUser.id)
    .onSnapshot(
      snap => setCardBucket('personal', snap.docs.map(d => d.data())),
      err  => toast('데이터 로드 오류: ' + err.message)
    );
  placesUnsubList.push(u1);

  myCollections.forEach(col => {
    const u = db.collection('places')
      .where('collectionId', '==', col.id)
      .onSnapshot(
        snap => setCardBucket(col.id, snap.docs.map(d => d.data())),
        err  => console.error('[col places]', err)
      );
    placesUnsubList.push(u);
  });
}

function subscribeToCollections() {
  if (collectionsUnsub) collectionsUnsub();
  collectionsUnsub = db.collection('collections')
    .where('members', 'array-contains', currentUser.id)
    .onSnapshot(
      snap => {
        myCollections = snap.docs.map(d => d.data());
        updateCollectionSelector();
        refreshPlacesSubscriptions();
        if (currentTab === 'collections') renderCollectionsView();
      },
      err => toast('컬렉션 로드 오류: ' + err.message)
    );
}

// ── 카카오 인증 ───────────────────────────────────────────────────────────────
function initAuth() {
  if (!Kakao.isInitialized()) Kakao.init(KAKAO_JS_KEY);

  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  if (invite) {
    localStorage.setItem('placelog_pending_invite', invite);
    history.replaceState({}, '', location.pathname);
  }

  const stored = localStorage.getItem('placelog_user');
  if (stored) {
    try { currentUser = JSON.parse(stored); onAuthReady(); return; } catch {}
  }
  showLoginScreen();
}

function showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
}
function hideLoginScreen() {
  document.getElementById('login-screen').classList.add('hidden');
}

function setPopupHint(msg) {
  const el = document.getElementById('login-popup-hint');
  if (el) el.textContent = msg;
}

function loginWithKakao() {
  const btn = document.getElementById('btn-kakao');
  if (btn.classList.contains('loading')) return;
  btn.classList.add('loading');
  setPopupHint('');

  Kakao.Auth.login({
    success: async authObj => {
      try {
        const res = await fetch('https://kapi.kakao.com/v2/user/me', {
          headers: { Authorization: `Bearer ${authObj.access_token}` },
        });
        const userData = await res.json();
        if (userData.code < 0) throw new Error(`사용자 조회 실패 (${userData.code})`);

        currentUser = {
          id:           String(userData.id),
          nickname:     userData.kakao_account?.profile?.nickname || '사용자',
          profileImage: userData.kakao_account?.profile?.thumbnail_image_url || null,
        };
        localStorage.setItem('placelog_user', JSON.stringify(currentUser));
        btn.classList.remove('loading');
        onAuthReady();
      } catch (e) {
        console.error('[Kakao login]', e);
        btn.classList.remove('loading');
        setPopupHint('⚠️ ' + e.message);
      }
    },
    fail: err => {
      console.error('[Kakao login fail]', err);
      btn.classList.remove('loading');
      if (err && err.error === 'access_denied') return;
      // 팝업 차단 또는 기타 오류
      setPopupHint('⚠️ 팝업이 차단됐어요. 주소창 오른쪽의 팝업 차단 아이콘을 클릭해 이 사이트의 팝업을 허용한 뒤 다시 시도해주세요.');
    },
  });
}

function onAuthReady() {
  hideLoginScreen();
  updateUserUI();
  subscribeToCollections();
  handlePendingInvite();
}

function updateUserUI() {
  if (!currentUser) return;
  const avatar = document.getElementById('user-avatar');
  if (!avatar) return;
  avatar.classList.remove('hidden');
  if (currentUser.profileImage) {
    avatar.innerHTML = `<img src="${currentUser.profileImage}" alt="">`;
  } else {
    avatar.textContent = (currentUser.nickname[0] || '?').toUpperCase();
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById('profile-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) {
    updateProfileMenu();
    menu.classList.remove('hidden');
  } else {
    menu.classList.add('hidden');
  }
}

function updateProfileMenu() {
  if (!currentUser) return;

  const pmAvatar = document.getElementById('pm-avatar');
  if (pmAvatar) {
    if (currentUser.profileImage) {
      pmAvatar.innerHTML = `<img src="${currentUser.profileImage}" alt="">`;
    } else {
      pmAvatar.textContent = (currentUser.nickname[0] || '?').toUpperCase();
    }
  }

  const pmName = document.getElementById('pm-name');
  if (pmName) pmName.textContent = currentUser.nickname;

  const pmCount = document.getElementById('pm-count');
  if (pmCount) pmCount.textContent = `기록한 장소 ${cards.length}곳`;
}

function logout() {
  document.getElementById('profile-menu')?.classList.add('hidden');
  localStorage.removeItem('placelog_user');
  currentUser = null;
  if (collectionsUnsub) { collectionsUnsub(); collectionsUnsub = null; }
  placesUnsubList.forEach(u => u());
  placesUnsubList = [];
  cardBuckets.clear();
  myCollections = [];
  cards = [];
  Object.keys(markers).forEach(id => removePin(id));
  updateBadge();
  const el = document.getElementById('user-avatar');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  switchTab('map');
  showLoginScreen();
}

// ── 부트스트랩 ────────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const wrap = document.getElementById('profile-wrap');
  const menu = document.getElementById('profile-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (wrap && !wrap.contains(e.target)) menu.classList.add('hidden');
});

document.addEventListener('DOMContentLoaded', async () => {
  await videoDB.open().catch(() => {});

  // 지도·Firestore 초기화 실패해도 initAuth()는 반드시 실행
  try {
    initFirestore();
    initMap();
    buildCatPills();
    setupListeners();
    document.getElementById('add-date').value = today();
  } catch (e) {
    console.error('[init]', e);
  }

  initAuth();
});

// ── 지도 초기화 ───────────────────────────────────────────────────────────────
function initMap() {
  map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 6,
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => {
        map.setCenter(new kakao.maps.LatLng(p.coords.latitude, p.coords.longitude));
        map.setLevel(4);
      },
      () => {}
    );
  }

  kakao.maps.event.addListener(map, 'click', e => {
    if (addMode) placeTempPin(e.latLng);
  });

  document.getElementById('btn-zoomin').onclick  = () => map.setLevel(map.getLevel() - 1);
  document.getElementById('btn-zoomout').onclick = () => map.setLevel(map.getLevel() + 1);
}

// ── 오버레이 콘텐츠 생성 ──────────────────────────────────────────────────────
function makeOverlayContent(cat, active, clickId) {
  const c = CATS[cat] || CATS.park;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="map-pin${active ? ' is-active' : ''}" style="--pc:${c.color}">
    <div class="pin-bub">${PAW_SVG}</div>
  </div>`;
  const pin = wrap.firstChild;
  if (clickId) pin.addEventListener('click', () => openViewSheet(clickId));
  return pin;
}

function makeTempContent() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="map-pin pin-temp" style="--pc:#f97316;touch-action:none">
    <div class="pin-bub">${PAW_SVG}</div>
  </div>`;
  return wrap.firstChild;
}

// ── 핀 렌더링 ─────────────────────────────────────────────────────────────────
function renderAllPins() { cards.forEach(addPin); }

// onSnapshot 갱신 시 핀 동기화 (추가/삭제만 처리해 깜빡임 방지)
function refreshPins() {
  Object.keys(markers).forEach(id => {
    if (!cards.find(c => c.id === id)) {
      removePin(id);
      if (activeId === id) closeSheet();
    }
  });
  cards.forEach(card => {
    if (!markers[card.id]) addPin(card);
  });
}

function addPin(card) {
  const content = makeOverlayContent(card.category, false, card.id);
  const overlay = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(card.lat, card.lon),
    content,
    xAnchor: 0.5,
    yAnchor:  1,
    clickable: true,
    zIndex:    1,
  });
  overlay.setMap(map);
  markers[card.id] = overlay;
}

function removePin(id) {
  if (markers[id]) { markers[id].setMap(null); delete markers[id]; }
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
  document.getElementById('search-wrap').classList.add('hidden');
  clearSearch();
  closeSheet();
}

function cancelAddMode() {
  addMode = false;
  document.getElementById('add-banner').classList.add('hidden');
  document.getElementById('btn-fab').classList.remove('is-cancel');
  document.getElementById('fab-plus').classList.remove('hidden');
  document.getElementById('fab-x').classList.add('hidden');
  document.getElementById('map').classList.remove('add-mode');
  document.getElementById('search-wrap').classList.remove('hidden');
  clearTempPin();
  closeSheet();
}

function clearTempPin() {
  if (tempMarker) { tempMarker.setMap(null); tempMarker = null; }
  tempLatLng = null;
  tempAddr   = '';
}

// ── 핀 배치 + 역지오코딩 ──────────────────────────────────────────────────────
function placeTempPin(latlng) {
  clearTempPin();
  tempLatLng = latlng;

  const content = makeTempContent();
  tempMarker = new kakao.maps.CustomOverlay({
    position: latlng,
    content,
    xAnchor:  0.5,
    yAnchor:  1,
    clickable: true,
    zIndex:   10,
  });
  tempMarker.setMap(map);
  setupTempPinDrag(content, tempMarker);

  openAddSheet();
  reverseGeocode(latlng.getLat(), latlng.getLng());
  setTimeout(() => map.panBy(0, 80), 100);
}

// 임시 핀 드래그 (pointer events → map.getProjection() 변환)
function setupTempPinDrag(el, overlay) {
  let dragging = false;

  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    map.setDraggable(false);
  }, { passive: false });

  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = document.getElementById('map').getBoundingClientRect();
    const pt   = new kakao.maps.Point(e.clientX - rect.left, e.clientY - rect.top);
    const pos  = map.getProjection().coordsFromContainerPoint(pt);
    overlay.setPosition(pos);
    tempLatLng = pos;
  });

  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    map.setDraggable(true);
    reverseGeocode(tempLatLng.getLat(), tempLatLng.getLng());
  });
}

// 카카오 역지오코딩
function reverseGeocode(lat, lon) {
  const nameEl = document.getElementById('add-name');
  const addrEl = document.getElementById('add-addr');
  addrEl.textContent = '주소 불러오는 중...';

  const geocoder = new kakao.maps.services.Geocoder();
  geocoder.coord2Address(lon, lat, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      const r    = result[0];
      const addr = r.road_address?.address_name || r.address.address_name;
      tempAddr = addr;
      addrEl.textContent = addr;
      if (!nameEl.value) nameEl.value = shortName(addr);
    } else {
      addrEl.textContent = '';
    }
  });
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
    if (c) markers[k].setContent(makeOverlayContent(c.category, k === id, c.id));
  });

  const card = cards.find(c => c.id === id);
  if (card) {
    map.panTo(new kakao.maps.LatLng(card.lat, card.lon));
    setTimeout(() => map.panBy(0, 100), 350);
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
  document.getElementById('sheet').classList.add('is-open');
  liftMapControls(true);
  setTimeout(() => map && map.relayout(), 360);
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('is-open');
  liftMapControls(false);

  if (activeId) {
    const c = cards.find(c => c.id === activeId);
    if (c && markers[activeId]) markers[activeId].setContent(makeOverlayContent(c.category, false, c.id));
    activeId = null;
  }
  setTimeout(() => map && map.relayout(), 360);
}

function liftMapControls(up) {
  const h = up ? document.getElementById('sheet').offsetHeight : 0;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  document.querySelector('.zoom-ctrl').classList.toggle('lifted', up);
  document.querySelector('.btn-myloc').classList.toggle('lifted', up);
}

// ── 뷰 패널 채우기 ────────────────────────────────────────────────────────────
async function populateView(id) {
  const card = cards.find(c => c.id === id);
  if (!card) return;

  const cat = CATS[card.category] || CATS.park;
  const catEl = document.getElementById('sv-cat');
  catEl.textContent = `${cat.emoji} ${cat.label}`;
  catEl.style.color = cat.color;

  document.getElementById('sv-name').textContent = card.name;
  document.getElementById('sv-addr').textContent = card.address || '';
  document.getElementById('sv-date').textContent = card.date ? `📅 ${card.date}` : '';
  document.getElementById('sv-memo').textContent = card.memo || '';
  document.getElementById('sv-maplink').href = `https://maps.google.com/?q=${card.lat},${card.lon}`;

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
  document.getElementById('add-collection').value = '';
  pendingFile = null;
  selCat = 'park';
  switchAddTab('yt');
  document.querySelectorAll('.cat-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.cat === 'park')
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
    btn.className = `cat-pill${key === 'park' ? ' active' : ''}`;
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
  const src  = URL.createObjectURL(file);
  const zone = document.getElementById(zoneId);
  const prev = document.getElementById(prevId);
  if (zone) zone.style.display = 'none';

  prev.innerHTML = `
    <div class="upl-done">
      <video src="${src}" controls playsinline preload="metadata"></video>
      <div class="upl-meta">${esc(file.name)} · ${(file.size / 1024 / 1024).toFixed(1)} MB</div>
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

  const id   = uid();
  const card = {
    id,
    name,
    address:      tempAddr,
    region:       extractRegion(tempAddr),
    category:     selCat,
    lat:          tempLatLng.getLat(),
    lon:          tempLatLng.getLng(),
    mediaType,
    mediaId,
    date:         document.getElementById('add-date').value,
    memo:         document.getElementById('add-memo').value.trim(),
    createdAt:    new Date().toISOString(),
    userId:       currentUser.id,
    userNickname: currentUser.nickname,
    collectionId: document.getElementById('add-collection').value || null,
  };

  if (mediaType === 'video' && pendingFile) {
    await videoDB.save(id, pendingFile).catch(() => {});
  }

  try {
    await db.collection('places').doc(card.id).set(card);
    clearTempPin();
    cancelAddMode();
    closeSheet();
    toast(`${name} 저장됐어요 🐾`);
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '저장하기 📍';
    toast('저장에 실패했어요. 다시 시도해주세요');
  }
}

// ── 삭제 ─────────────────────────────────────────────────────────────────────
async function deleteActive() {
  if (!activeId) return;
  const card = cards.find(c => c.id === activeId);
  if (!card) return;
  if (!confirm(`"${card.name}" 을(를) 삭제할까요?`)) return;

  const idToDelete = activeId;
  if (card.mediaType === 'video') await videoDB.remove(idToDelete).catch(() => {});
  closeSheet();
  try {
    await db.collection('places').doc(idToDelete).delete();
    toast('삭제됐어요');
  } catch (e) {
    toast('삭제에 실패했어요');
  }
}

// ── 공유 ─────────────────────────────────────────────────────────────────────
async function shareActive() {
  const card = cards.find(c => c.id === activeId);
  if (!card) return;

  const cat  = CATS[card.category] || CATS.park;
  const text = [
    `${cat.emoji} ${card.name}`,
    card.address,
    card.memo,
    `🗺️ https://maps.google.com/?q=${card.lat},${card.lon}`,
    '',
    '킁킁로그로 기록됨',
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
    p => {
      map.setCenter(new kakao.maps.LatLng(p.coords.latitude, p.coords.longitude));
      map.setLevel(3);
    },
    () => toast('위치를 가져올 수 없어요')
  );
}

// ── 장소 검색 (카카오 키워드 검색) ──────────────────────────────────────────
const doSearch = debounce(q => {
  const drop = document.getElementById('search-drop');
  if (!q.trim()) { hideDrop(); return; }

  drop.innerHTML = '<li class="no-res"><span class="spin"></span></li>';
  drop.classList.remove('hidden');

  const ps = new kakao.maps.services.Places();
  ps.keywordSearch(q, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      searchResults = result;
      renderDrop(result);
    } else if (status === kakao.maps.services.Status.ZERO_RESULT) {
      drop.innerHTML = '<li class="no-res">검색 결과가 없어요</li>';
      drop.classList.remove('hidden');
    } else {
      drop.innerHTML = '<li class="no-res">검색 중 오류가 발생했어요</li>';
      drop.classList.remove('hidden');
    }
  }, { size: 5 });
}, 420);

function renderDrop(results) {
  const drop = document.getElementById('search-drop');
  drop.innerHTML = results.map((r, i) => `
    <li onclick="selectResult(${i})">
      <span class="res-name">${esc(r.place_name)}</span>
      <span class="res-full">${esc(r.road_address_name || r.address_name)}</span>
    </li>
  `).join('');
  drop.classList.remove('hidden');
}

function hideDrop() {
  document.getElementById('search-drop').classList.add('hidden');
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('btn-sc').classList.add('hidden');
  hideDrop();
  searchResults = [];
}

function selectResult(idx) {
  const r = searchResults[idx];
  if (!r) return;

  const latlng = new kakao.maps.LatLng(parseFloat(r.y), parseFloat(r.x));
  clearSearch();

  map.setCenter(latlng);
  map.setLevel(3);

  // add mode 진입 (배너 없이, 검색바 유지)
  addMode = true;
  document.getElementById('btn-fab').classList.add('is-cancel');
  document.getElementById('fab-plus').classList.add('hidden');
  document.getElementById('fab-x').classList.remove('hidden');
  document.getElementById('map').classList.add('add-mode');

  clearTempPin();
  tempLatLng = latlng;
  tempAddr   = r.road_address_name || r.address_name;

  const content = makeTempContent();
  tempMarker = new kakao.maps.CustomOverlay({
    position: latlng,
    content,
    xAnchor:  0.5,
    yAnchor:  1,
    clickable: true,
    zIndex:   10,
  });
  tempMarker.setMap(map);
  setupTempPinDrag(content, tempMarker);

  setTimeout(() => {
    openAddSheet();
    setTimeout(() => {
      document.getElementById('add-name').value = r.place_name;
      document.getElementById('add-addr').textContent = r.road_address_name || r.address_name;
    }, 20);
    map.panBy(0, 80);
  }, 350);
}

// ── 이벤트 리스너 ─────────────────────────────────────────────────────────────
function setupListeners() {
  const sinp = document.getElementById('search-input');
  sinp.addEventListener('input', e => {
    const v = e.target.value;
    document.getElementById('btn-sc').classList.toggle('hidden', !v);
    doSearch(v);
  });
  sinp.addEventListener('keydown', e => {
    if (e.key === 'Escape') clearSearch();
    if (e.key === 'Enter' && searchResults.length) selectResult(0);
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('search-wrap').contains(e.target)) hideDrop();
  });

  const ytEl = document.getElementById('add-yt');
  ytEl.addEventListener('input', debounce(previewYt, 600));
  ytEl.addEventListener('paste', () => setTimeout(previewYt, 80));

  document.getElementById('file-inp').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0], 'file-prev', 's-upzone');
  });
  document.getElementById('s-upzone').addEventListener('click', () =>
    document.getElementById('file-inp').click()
  );

  const zone = document.getElementById('s-upzone');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], 'file-prev', 's-upzone');
  });

  document.getElementById('cam-inp').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0], 'cam-prev', null);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('sheet').classList.contains('is-open')) closeSheet();
      else if (addMode) cancelAddMode();
    }
  });

  setupSheetDrag();
}

function setupSheetDrag() {
  const dragEl = document.getElementById('sheet-drag');
  const sheet  = document.getElementById('sheet');

  const onStart = e => {
    sheetStartY = (e.touches || [e])[0].clientY;
    sheetDrag   = true;
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
    sheet.style.transform  = '';
    if (dy > 90) closeSheet();
  };

  dragEl.addEventListener('touchstart', onStart, { passive: true });
  dragEl.addEventListener('touchmove',  onMove,  { passive: true });
  dragEl.addEventListener('touchend',   onEnd,   { passive: true });
  dragEl.addEventListener('mousedown',  onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onEnd);
}

// ── 탭 전환 ──────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  const isMap  = tab === 'map';
  const isFeed = tab === 'feed';
  const isColl = tab === 'collections';

  document.getElementById('map').style.display       = isMap ? '' : 'none';
  document.getElementById('btn-fab').style.display   = isMap ? '' : 'none';
  document.querySelector('.btn-myloc').style.display = isMap ? '' : 'none';
  document.querySelector('.zoom-ctrl').style.display = isMap ? '' : 'none';
  document.getElementById('search-wrap').classList.toggle('hidden', !isMap);

  if (!isMap && addMode) cancelAddMode();

  document.getElementById('feed-view').classList.toggle('hidden', !isFeed);
  document.getElementById('coll-view').classList.toggle('hidden', !isColl);

  document.getElementById('tab-map').classList.toggle('active', isMap);
  document.getElementById('tab-feed').classList.toggle('active', isFeed);
  document.getElementById('tab-coll').classList.toggle('active', isColl);

  if (isFeed)      renderFeed();
  else if (isColl) renderCollectionsView();
  else             setTimeout(() => map && map.relayout(), 50);
}

// ── 지역 추출 (카카오 주소 → 시/구 단위) ──────────────────────────────────────
function extractRegion(addr) {
  if (!addr) return '기타';
  const parts = addr.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '기타';

  const p1 = parts[1];
  const p2 = parts[2] || '';

  // 도 > 시 > 구 구조 (경기 성남시 분당구)
  if (/시$/.test(p1) && /구$/.test(p2)) return `${p1} ${p2}`;
  // 광역시/특별시 > 구/군 구조 (서울 강남구) or 도 > 시 구조 (경기 수원시)
  if (/[구군시]$/.test(p1)) return `${parts[0]} ${p1}`;

  return parts[0];
}

// 저장된 region 필드가 없는 구 데이터는 address에서 파생
function cardRegion(card) {
  return card.region || extractRegion(card.address);
}

// ── 피드 렌더링 ───────────────────────────────────────────────────────────────
function renderFeed() {
  renderRegionChips();
  renderFeedList();
}

function renderRegionChips() {
  const regions = [...new Set(cards.map(cardRegion))].sort((a, b) =>
    a.localeCompare(b, 'ko')
  );
  const wrap = document.getElementById('region-chips');
  wrap.innerHTML = '';

  const addChip = (label, value) => {
    const btn = document.createElement('button');
    btn.className = `chip${feedRegion === value ? ' active' : ''}`;
    btn.textContent = label;
    btn.onclick = () => { feedRegion = value; renderFeed(); };
    wrap.appendChild(btn);
  };

  addChip('전체', 'all');
  regions.forEach(r => addChip(r, r));
}

function renderFeedList() {
  const list = document.getElementById('feed-list');
  const items = feedRegion === 'all'
    ? [...cards]
    : cards.filter(c => cardRegion(c) === feedRegion);

  if (!items.length) {
    list.innerHTML = '<p class="feed-empty">아직 산책 기록이 없어요 🐾</p>';
    return;
  }

  // 지역별 그룹핑 (삽입 순 유지)
  const groups = new Map();
  items.forEach(c => {
    const r = cardRegion(c);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });

  list.innerHTML = [...groups.entries()].map(([region, group]) => `
    <div class="fs">
      <div class="fs-head">
        <span class="fs-region">${esc(region)}</span>
        <span class="fs-count">${group.length}곳</span>
      </div>
      ${group.map(feedCard).join('')}
    </div>
  `).join('');
}

function feedCard(card) {
  const cat = CATS[card.category] || CATS.park;
  const col = card.collectionId ? myCollections.find(c => c.id === card.collectionId) : null;
  const byOther = card.userId !== currentUser?.id;

  let media = '';
  if (card.mediaType === 'youtube' && card.mediaId) {
    media = `<div class="fc-media">
      <img class="fc-thumb"
           src="https://img.youtube.com/vi/${esc(card.mediaId)}/mqdefault.jpg"
           alt="" loading="lazy">
    </div>`;
  } else if (card.mediaType === 'video') {
    media = `<div class="fc-media fc-vid-icon">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>
      </svg>
      <span>동영상</span>
    </div>`;
  }

  return `<div class="fc" onclick="openFromFeed('${card.id}')">
    ${media}
    <div class="fc-body">
      <div class="fc-top-row">
        <span class="fc-cat" style="color:${cat.color}">${cat.emoji} ${cat.label}</span>
        ${col ? `<span class="fc-coll"># ${esc(col.name)}</span>` : ''}
      </div>
      <div class="fc-name">${esc(card.name)}</div>
      ${card.address ? `<div class="fc-addr">${esc(card.address)}</div>` : ''}
      ${card.date    ? `<div class="fc-date">📅 ${card.date}</div>`     : ''}
      ${card.memo    ? `<div class="fc-memo">${esc(card.memo)}</div>`   : ''}
      ${byOther      ? `<div class="fc-author">by ${esc(card.userNickname || '?')}</div>` : ''}
    </div>
  </div>`;
}

function openFromFeed(id) {
  switchTab('map');
  setTimeout(() => openViewSheet(id), 120);
}

// ── 컬렉션 UI ────────────────────────────────────────────────────────────────
function renderCollectionsView() {
  const list = document.getElementById('coll-list');
  if (!list) return;

  if (!myCollections.length) {
    list.innerHTML = '<p class="coll-empty">아직 컬렉션이 없어요.<br>새 컬렉션을 만들거나 초대 링크로 참여해보세요.</p>';
    return;
  }

  list.innerHTML = myCollections.map(col => {
    const placeCount = cards.filter(c => c.collectionId === col.id).length;
    const isOwner    = col.ownerId === currentUser.id;
    return `<div class="coll-item">
      <div class="ci-body">
        <div class="ci-name">${esc(col.name)}</div>
        <div class="ci-meta">
          <span>${col.members.length}명 · ${placeCount}곳</span>
          ${!isOwner ? '<span class="ci-badge">참여중</span>' : ''}
        </div>
      </div>
      <div class="ci-btns">
        <button class="ci-btn ci-share" onclick="shareCollection('${col.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg>
          초대
        </button>
        ${isOwner
          ? `<button class="ci-btn ci-del" onclick="deleteCollection('${col.id}')">삭제</button>`
          : `<button class="ci-btn ci-leave" onclick="leaveCollection('${col.id}')">나가기</button>`}
      </div>
    </div>`;
  }).join('');
}

function updateCollectionSelector() {
  const sel = document.getElementById('add-collection');
  if (!sel) return;
  sel.innerHTML = '<option value="">개인 기록</option>' +
    myCollections.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function showCreateCollection() {
  document.getElementById('coll-name-inp').value = '';
  document.getElementById('create-coll-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('coll-name-inp').focus(), 80);
}

function closeCreateCollection() {
  document.getElementById('create-coll-modal').classList.add('hidden');
}

async function saveCollection() {
  const name = document.getElementById('coll-name-inp').value.trim();
  if (!name) { toast('컬렉션 이름을 입력해주세요'); return; }

  const id         = uid();
  const inviteCode = Math.random().toString(36).slice(2, 10).toUpperCase();
  const col = {
    id, name, inviteCode,
    ownerId:       currentUser.id,
    ownerNickname: currentUser.nickname,
    members:       [currentUser.id],
    createdAt:     new Date().toISOString(),
  };

  try {
    await db.collection('collections').doc(id).set(col);
    closeCreateCollection();
    toast(`"${name}" 컬렉션을 만들었어요 ✓`);
  } catch (e) {
    toast('만들기에 실패했어요');
  }
}

async function shareCollection(colId) {
  const col = myCollections.find(c => c.id === colId);
  if (!col) return;
  const link = `${location.origin}${location.pathname}?invite=${col.inviteCode}`;
  if (navigator.share) {
    try { await navigator.share({ title: col.name, url: link }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  await navigator.clipboard.writeText(link).catch(() => {});
  toast('초대 링크가 복사됐어요 ✓');
}

async function deleteCollection(colId) {
  const col = myCollections.find(c => c.id === colId);
  if (!col || col.ownerId !== currentUser.id) return;
  if (!confirm(`"${col.name}" 컬렉션을 삭제할까요?`)) return;
  try {
    await db.collection('collections').doc(colId).delete();
    toast('컬렉션이 삭제됐어요');
  } catch (e) {
    toast('삭제에 실패했어요');
  }
}

async function leaveCollection(colId) {
  const col = myCollections.find(c => c.id === colId);
  if (!col) return;
  if (!confirm(`"${col.name}" 컬렉션에서 나갈까요?`)) return;
  try {
    await db.collection('collections').doc(colId).update({
      members: firebase.firestore.FieldValue.arrayRemove(currentUser.id),
    });
    toast('컬렉션에서 나왔어요');
  } catch (e) {
    toast('처리에 실패했어요');
  }
}

// ── 초대 수락 ─────────────────────────────────────────────────────────────────
async function handlePendingInvite() {
  const code = localStorage.getItem('placelog_pending_invite');
  if (!code) return;
  localStorage.removeItem('placelog_pending_invite');
  try {
    const snap = await db.collection('collections')
      .where('inviteCode', '==', code).limit(1).get();
    if (snap.empty) { toast('유효하지 않은 초대 링크예요'); return; }
    const col = snap.docs[0].data();
    if (col.members.includes(currentUser.id)) {
      toast(`이미 "${col.name}" 컬렉션의 멤버예요`); return;
    }
    pendingInviteCol = col;
    const msg = document.getElementById('invite-msg');
    if (msg) msg.innerHTML =
      `<strong>${esc(col.ownerNickname)}</strong>님의 <strong>${esc(col.name)}</strong> 컬렉션에 초대됐어요. 참여할까요?`;
    document.getElementById('invite-modal')?.classList.remove('hidden');
  } catch (e) {
    toast('초대 링크 확인 중 오류가 발생했어요');
  }
}

async function acceptInvite() {
  if (!pendingInviteCol) return;
  const btn = document.getElementById('btn-accept-invite');
  btn.disabled = true;
  try {
    await db.collection('collections').doc(pendingInviteCol.id).update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.id),
    });
    document.getElementById('invite-modal').classList.add('hidden');
    toast(`"${pendingInviteCol.name}" 컬렉션에 참여했어요! 🎉`);
    pendingInviteCol = null;
  } catch (e) {
    toast('참여에 실패했어요. 다시 시도해주세요');
  } finally {
    btn.disabled = false;
  }
}

function declineInvite() {
  pendingInviteCol = null;
  document.getElementById('invite-modal').classList.add('hidden');
}

function updateBadge() {
  document.getElementById('pin-badge').textContent = `🐾 ${cards.length}곳`;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 카카오 주소: "서울 강남구 역삼동 123" → "강남구 역삼동"
function shortName(addr) {
  if (!addr) return '새 장소';
  const parts = addr.trim().split(/\s+/);
  // 광역시/도 제외, 구/동 수준 2개
  return parts.slice(1, 3).join(' ') || parts[0] || '새 산책 장소';
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
