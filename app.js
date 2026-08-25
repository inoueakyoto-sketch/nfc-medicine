(() => {
  'use strict';

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbwy1VKCy0ud87bkvtomzsNkLrwJWE8LUI10IssxVPGr2GIgKaB1Xn1m8YDcLngC5xYywA/exec';
  const TZ = 'Asia/Tokyo';
  const WALLET_KEY = 'medicine-medal-arcade-wallet-v2';
  const ADHERENCE_KEY = 'medicine-medal-weekly-adherence-v1';
  const DEBUG_KEY = 'medicine-medal-arcade-debug-v1';
  const PARENT_SETTINGS_KEY = 'medicine-medal-parent-settings-v1';
  const PARENT_PIN_KEY = 'medicine-medal-parent-pin-v1';
  const PARENT_PIN_LOCK_KEY = 'medicine-medal-parent-pin-lock-v1';
  const DEFAULT_GAME_DAYS = [0]; // 0=日, 1=月 ... 6=土

  const state = { currentSelectedMedId: null, medList: [], currentGameId: null, parentSettingsAuthorized:false, pinMode:'verify', pinAfter:null };
  const $ = id => document.getElementById(id);

  // Production shell must never inherit prototype Sunday overrides.
  localStorage.removeItem(DEBUG_KEY);

  const loadingTimeout = setTimeout(() => {
    const loading = $('loading-view');
    if (loading && loading.classList.contains('active-view')) showError('通信タイムアウト。設定を確認してください。');
  }, 12000);

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('storage', e => {
    if ([WALLET_KEY, ADHERENCE_KEY, PARENT_SETTINGS_KEY].includes(e.key)) refreshRewardUI();
  });
  window.addEventListener('pageshow', refreshRewardUI);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRewardUI(); });
  window.addEventListener('online', updateNetworkUI);
  window.addEventListener('offline', updateNetworkUI);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=1.6', { updateViaCache: 'none' }).catch(() => {}));
  }

  async function init() {
    bindStaticEvents();
    updateNetworkUI();
    const params = new URLSearchParams(location.search);
    if (params.has('reset')) {
      localStorage.clear();
      alert('✅ リセットしました！');
      location.replace(location.origin + location.pathname);
      return;
    }
    if (params.has('id')) state.currentSelectedMedId = params.get('id');
    renderTodayLabel();
    refreshRewardUI();
    await loadMedicationList();
  }

  function bindStaticEvents() {
    document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $('open-parent-settings').addEventListener('click', requestParentSettingsAccess);
    $('open-arcade-btn').addEventListener('click', openArcade);
    $('complete-arcade-btn').addEventListener('click', openArcade);
    $('complete-back-btn').addEventListener('click', goTask);
    $('close-game-btn').addEventListener('click', closeGame);
    $('error-retry-btn').addEventListener('click', () => location.reload());
    $('camera-input').addEventListener('change', onCameraChange);
    $('save-game-day').addEventListener('click', saveGameDaySetting);
    $('change-parent-pin').addEventListener('click', () => openPinModal('setup', 'change'));
    $('pin-form').addEventListener('submit', onPinSubmit);
    document.querySelectorAll('[data-pin-cancel]').forEach(el => el.addEventListener('click', closePinModal));
  }

  function switchView(viewId) {
    const leavingParentSettings = $('nfc-setup-view')?.classList.contains('active-view') && viewId !== 'nfc-setup-view';
    if (leavingParentSettings) state.parentSettingsAuthorized = false;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
    const target = $(viewId);
    if (target) target.classList.add('active-view');
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (viewId === 'task-view') { renderMedicationList(); refreshRewardUI(); }
    if (viewId === 'arcade-view') renderArcade();
  }

  function showError(message) {
    clearTimeout(loadingTimeout);
    const details = $('error-details');
    details.textContent = message || '不明なエラー';
    details.style.display = 'block';
    switchView('error-view');
  }

  async function loadMedicationList() {
    try {
      const fetchUrl = `${GAS_URL}?action=getList&t=${Date.now()}`;
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('通信タイムアウト')), 8000));
      const fetchPromise = fetch(fetchUrl, { method: 'GET', mode: 'cors' }).then(res => {
        if (!res.ok) throw new Error(`通信エラー (${res.status})`);
        return res.json();
      });
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      clearTimeout(loadingTimeout);
      if (!response || response.status !== 'success' || !Array.isArray(response.data)) throw new Error('お薬リストを読み込めませんでした。');

      state.medList = response.data;
      renderMedicationList();

      if (state.currentSelectedMedId) {
        const selected = state.medList.find(m => String(m.id) === String(state.currentSelectedMedId));
        if (selected) {
          const currentCount = getMedicineCount(selected.id);
          const limitCount = parseInt(selected.limitCount || '0', 10);
          if (limitCount > 0 && currentCount >= limitCount) {
            alert('きょうは もう おしまい！✨');
            state.currentSelectedMedId = null;
            cleanUrl();
          } else {
            openCameraView(selected.id, selected.title);
            return;
          }
        }
      }
      switchView('task-view');
    } catch (error) {
      showError(error.message);
    }
  }

  function renderMedicationList() {
    const container = $('med-list-container');
    if (!container) return;
    container.innerHTML = '';

    let recordedTotal = 0;
    let remainingKnown = 0;
    let hasKnownLimit = false;

    if (!state.medList.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-card';
      empty.textContent = '今日のおくすりは登録されていません。';
      container.appendChild(empty);
      updateTodayProgress(0, 0, false);
      return;
    }

    state.medList.forEach(med => {
      const currentCount = getMedicineCount(med.id);
      const limitCount = parseInt(med.limitCount || '0', 10);
      const done = limitCount > 0 && currentCount >= limitCount;
      recordedTotal += currentCount;
      if (limitCount > 0) {
        hasKnownLimit = true;
        remainingKnown += Math.max(0, limitCount - currentCount);
      }

      const card = document.createElement('section');
      card.className = `med-card${done ? ' done' : ''}`;

      const head = document.createElement('div');
      head.className = 'med-card-head';
      const titleWrap = document.createElement('div');
      titleWrap.className = 'med-card-title';
      const icon = document.createElement('div');
      icon.className = 'med-status-icon';
      icon.textContent = done ? '✓' : '薬';
      icon.setAttribute('aria-hidden','true');
      const textWrap = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = med.title;
      const time = document.createElement('p');
      time.className = 'med-time';
      time.textContent = med.time || '時間指定なし';
      textWrap.append(title, time);
      titleWrap.append(icon, textWrap);
      const badge = document.createElement('span');
      badge.className = 'count-badge';
      if (done) badge.textContent = '完了';
      else if (limitCount > 0) badge.textContent = `${currentCount}/${limitCount}回`;
      else badge.textContent = `${currentCount}回記録`;
      head.append(titleWrap, badge);
      card.appendChild(head);

      if (done) {
        const doneCopy = document.createElement('p');
        doneCopy.className = 'done-copy';
        doneCopy.textContent = '今日の予定分を記録しました。';
        card.appendChild(doneCopy);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-camera';
        btn.textContent = '写真で服薬を記録する';
        btn.setAttribute('aria-label', `${med.title}を写真で服薬記録する`);
        btn.addEventListener('click', () => openCameraView(med.id, med.title));
        card.appendChild(btn);
      }
      container.appendChild(card);
    });

    updateTodayProgress(recordedTotal, remainingKnown, hasKnownLimit);
  }

  function renderTodayLabel() {
    const el = $('today-label');
    if (!el) return;
    const text = new Intl.DateTimeFormat('ja-JP', {
      timeZone: TZ, month:'long', day:'numeric', weekday:'short'
    }).format(new Date());
    el.textContent = text;
  }

  function updateTodayProgress(recordedTotal, remainingKnown, hasKnownLimit) {
    const progress = $('today-progress');
    const note = $('today-progress-note');
    if (progress) progress.textContent = `記録 ${recordedTotal}回`;
    if (!note) return;
    if (hasKnownLimit && remainingKnown === 0 && state.medList.length) {
      note.textContent = '今日の予定分はすべて記録できています。';
    } else if (hasKnownLimit) {
      note.textContent = `あと ${remainingKnown}回。のんだら、写真で記録しよう。`;
    } else {
      note.textContent = 'のんだら、写真で記録しよう。';
    }
  }

  async function requestParentSettingsAccess() {
    if (state.parentSettingsAuthorized) { renderParentSettings(); return; }
    if (!getStoredPin()) openPinModal('setup', 'open');
    else openPinModal('verify', 'open');
  }

  function renderParentSettings() {
    if (!state.parentSettingsAuthorized) return;
    renderGameDaySetting();
    renderNfcSetupList();
    switchView('nfc-setup-view');
  }

  function renderNfcSetupList() {
    const container = $('nfc-url-container');
    container.innerHTML = '';
    const baseUrl = location.origin + location.pathname;
    state.medList.forEach(med => {
      const card = document.createElement('section');
      card.className = 'med-card';
      const h = document.createElement('h3');
      h.textContent = `💊 ${med.title}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'url-input';
      input.value = `${baseUrl}?id=${encodeURIComponent(med.id)}`;
      input.readOnly = true;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn copy-btn';
      btn.textContent = 'コピー';
      btn.addEventListener('click', () => copyText(input));
      card.append(h, input, btn);
      container.appendChild(card);
    });
  }

  function normalizeGameDays(value, legacyDay) {
    const source = Array.isArray(value) ? value : (Number.isInteger(Number(legacyDay)) ? [Number(legacyDay)] : DEFAULT_GAME_DAYS);
    const days = [...new Set(source.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    return days.length ? days : [...DEFAULT_GAME_DAYS];
  }

  function getParentSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(PARENT_SETTINGS_KEY) || '{}');
      return { ...raw, gameDays:normalizeGameDays(raw.gameDays, raw.gameDay) };
    } catch (_) { return { gameDays:[...DEFAULT_GAME_DAYS] }; }
  }

  function renderGameDaySetting() {
    const settings = getParentSettings();
    document.querySelectorAll('#game-day-checkboxes input[type="checkbox"]').forEach(input => {
      input.checked = settings.gameDays.includes(Number(input.value));
    });
    const current = $('current-game-days');
    if (current) current.textContent = gameDaysText(settings.gameDays, false);
    const help = $('game-day-help');
    if (help) help.textContent = `ゲームの日：${gameDaysText(settings.gameDays)}。選んだ曜日のうち、直近7日間すべて服薬記録がある日に遊べます。`;
    const error = $('game-day-error');
    if (error) error.textContent = '';
  }

  function saveGameDaySetting() {
    if (!state.parentSettingsAuthorized) return requestParentSettingsAccess();
    const days = [...document.querySelectorAll('#game-day-checkboxes input[type="checkbox"]:checked')].map(input => Number(input.value));
    const error = $('game-day-error');
    if (!days.length) {
      if (error) error.textContent = 'ゲームの日を1つ以上選んでください。';
      return;
    }
    const current = getParentSettings();
    const next = { ...current, gameDays:normalizeGameDays(days) };
    delete next.gameDay;
    localStorage.setItem(PARENT_SETTINGS_KEY, JSON.stringify(next));
    renderGameDaySetting();
    refreshRewardUI();
    showToast(`ゲームの日を「${gameDaysText(next.gameDays, false)}」に変更しました`);
  }

  function gameDayName(day) {
    return ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'][day] || '日曜日';
  }

  function gameDaysText(days=getParentSettings().gameDays, long=true) {
    const order=[1,2,3,4,5,6,0];
    const selected=new Set(days);
    return order.filter(d=>selected.has(d)).map(d=>long?gameDayName(d):['日','月','火','水','木','金','土'][d]).join('・');
  }

  function nextGameDayName() {
    const todayDay=dayOfWeek(currentDateKey());
    const days=getParentSettings().gameDays;
    let best=null;
    for(const d of days){const delta=(d-todayDay+7)%7||7;if(best===null||delta<best.delta)best={day:d,delta};}
    return best?gameDayName(best.day):'日曜日';
  }

  function getStoredPin() {
    try { return JSON.parse(localStorage.getItem(PARENT_PIN_KEY) || 'null'); } catch (_) { return null; }
  }

  function openPinModal(mode='verify', after='open') {
    state.pinMode = mode;
    state.pinAfter = after;
    const modal = $('parent-pin-modal');
    const isSetup = mode === 'setup';
    $('pin-modal-title').textContent = isSetup ? (after === 'change' ? 'PINを変更' : 'はじめにPINを決める') : 'おうちのかた用PIN';
    $('pin-modal-copy').textContent = isSetup
      ? '子どもが設定を変更できないように、4桁の数字を決めてください。'
      : '設定を開くには、4桁のPINを入力してください。';
    $('pin-confirm-wrap').hidden = !isSetup;
    $('pin-submit').textContent = isSetup ? 'PINを保存' : '設定を開く';
    $('pin-input').value = '';
    $('pin-confirm-input').value = '';
    $('pin-error').textContent = '';
    modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => $('pin-input').focus(), 50);
  }

  function closePinModal() {
    $('parent-pin-modal').hidden = true;
    document.body.classList.remove('modal-open');
    $('pin-error').textContent = '';
  }

  async function onPinSubmit(e) {
    e.preventDefault();
    const pin = $('pin-input').value.trim();
    const confirm = $('pin-confirm-input').value.trim();
    const error = $('pin-error');
    if (!/^\d{4}$/.test(pin)) { error.textContent = '4桁の数字を入力してください。'; return; }

    const lock = getPinLock();
    if (state.pinMode === 'verify' && lock.lockedUntil > Date.now()) {
      const sec = Math.ceil((lock.lockedUntil - Date.now()) / 1000);
      error.textContent = `入力を続けるには${sec}秒待ってください。`;
      return;
    }

    if (state.pinMode === 'setup') {
      if (pin !== confirm) { error.textContent = '2回のPINが一致しません。'; return; }
      await storePin(pin);
      localStorage.removeItem(PARENT_PIN_LOCK_KEY);
      closePinModal();
      showToast(state.pinAfter === 'change' ? 'PINを変更しました' : 'PINを設定しました');
      if (state.pinAfter === 'open') { state.parentSettingsAuthorized = true; renderParentSettings(); }
      return;
    }

    const ok = await verifyPin(pin);
    if (!ok) {
      const result = registerPinFailure();
      error.textContent = result.locked ? '5回間違えたため、1分間ロックしました。' : `PINが違います。あと${5-result.failCount}回で一時ロックします。`;
      $('pin-input').select();
      return;
    }
    localStorage.removeItem(PARENT_PIN_LOCK_KEY);
    state.parentSettingsAuthorized = true;
    closePinModal();
    renderParentSettings();
  }

  function getPinLock() {
    try {
      const v = JSON.parse(localStorage.getItem(PARENT_PIN_LOCK_KEY) || '{}');
      return { failCount:Number(v.failCount)||0, lockedUntil:Number(v.lockedUntil)||0 };
    } catch (_) { return { failCount:0, lockedUntil:0 }; }
  }

  function registerPinFailure() {
    const current = getPinLock();
    let failCount = current.lockedUntil > Date.now() ? current.failCount : current.failCount + 1;
    let lockedUntil = current.lockedUntil > Date.now() ? current.lockedUntil : 0;
    let locked = false;
    if (failCount >= 5) { failCount = 0; lockedUntil = Date.now() + 60000; locked = true; }
    localStorage.setItem(PARENT_PIN_LOCK_KEY, JSON.stringify({ failCount, lockedUntil }));
    return { failCount, lockedUntil, locked };
  }

  async function storePin(pin) {
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const salt = Array.from(saltBytes, b => b.toString(16).padStart(2,'0')).join('');
    const hash = await hashPin(pin, salt);
    localStorage.setItem(PARENT_PIN_KEY, JSON.stringify({ salt, hash, version:1 }));
  }

  async function verifyPin(pin) {
    const saved = getStoredPin();
    if (!saved?.salt || !saved?.hash) return false;
    return (await hashPin(pin, saved.salt)) === saved.hash;
  }

  async function hashPin(pin, salt) {
    const bytes = new TextEncoder().encode(`${salt}:${pin}`);
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
    }
    let h = 2166136261;
    for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8,'0');
  }

  async function copyText(input) {
    try {
      await navigator.clipboard.writeText(input.value);
      showToast('URLをコピーしました');
    } catch (_) {
      input.select();
      document.execCommand('copy');
      showToast('URLをコピーしました');
    }
  }

  function openCameraView(medId, medTitle) {
    state.currentSelectedMedId = medId;
    $('target-med-title').textContent = medTitle;
    switchView('camera-view');
  }

  async function onCameraChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    switchView('sending-view');
    try {
      const base64Image = await resizeAndConvertImage(file);
      const payload = { action:'log', id:state.currentSelectedMedId, name:'ユーザー', image:base64Image };
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000));
      const fetchPromise = fetch(GAS_URL, {
        method:'POST', mode:'no-cors', headers:{ 'Content-Type':'text/plain' }, body:JSON.stringify(payload)
      });
      await Promise.race([fetchPromise, timeoutPromise]);

      incrementMedicineCount(state.currentSelectedMedId);
      const reward = recordMedicationReward();
      state.currentSelectedMedId = null;
      cleanUrl();
      renderMedicationList();
      showComplete(reward);
    } catch (error) {
      showError(error.message);
    } finally {
      e.target.value = '';
    }
  }

  function resizeAndConvertImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
      reader.onload = e => {
        const img = new Image();
        img.onerror = () => reject(new Error('画像を開けませんでした。'));
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width, height = img.height;
          const max = 800;
          if (width > height && width > max) { height *= max / width; width = max; }
          else if (height >= width && height > max) { width *= max / height; height = max; }
          canvas.width = Math.round(width); canvas.height = Math.round(height);
          const c = canvas.getContext('2d');
          c.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', .5).split(',')[1]);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function showComplete(reward) {
    renderMiniWeek($('complete-week-progress'));
    const status = $('complete-arcade-status');
    const arcadeBtn = $('complete-arcade-btn');
    if (reward.unlocked) {
      status.textContent = `7日達成！ 今日はゲームの日。メダルは ${reward.wallet}枚あります。`;
      arcadeBtn.hidden = false;
    } else {
      const count = weekDoneCount();
      status.textContent = `直近7日間は ${count}/7日。ゲームの日は ${gameDaysText()} です。`;
      arcadeBtn.hidden = true;
    }
    switchView('complete-view');
    successSound();
    if (navigator.vibrate) navigator.vibrate([70,40,110]);
  }

  function goTask() {
    cleanUrl();
    switchView('task-view');
  }

  // ---- Medal / weekly adherence ----
  function recordMedicationReward() {
    const wallet = getWallet() + 1;
    localStorage.setItem(WALLET_KEY, String(wallet));
    const adherence = getAdherence();
    adherence.doneDates[currentDateKey()] = true;
    localStorage.setItem(ADHERENCE_KEY, JSON.stringify(adherence));
    refreshRewardUI();
    return { wallet, unlocked:isArcadeUnlocked() };
  }

  function getWallet() {
    const n = parseInt(localStorage.getItem(WALLET_KEY) || '0', 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  function getAdherence() {
    try {
      const v = JSON.parse(localStorage.getItem(ADHERENCE_KEY) || '{}');
      return { ...v, doneDates:{ ...(v.doneDates || {}) } };
    } catch (_) {
      return { doneDates:{} };
    }
  }

  function isArcadeUnlocked() { return isGameDay() && weekComplete(); }
  function weekComplete() { const d = getAdherence().doneDates; return weekKeys().every(k => !!d[k]); }
  function weekDoneCount() { const d = getAdherence().doneDates; return weekKeys().filter(k => !!d[k]).length; }
  function isGameDay() { return getParentSettings().gameDays.includes(dayOfWeek(currentDateKey())); }

  function refreshRewardUI() {
    const wallet = getWallet();
    ['task-medal-count','arcade-medal-count','game-frame-medal-count'].forEach(id => { const el=$(id); if(el) el.textContent=wallet; });
    renderMiniWeek($('task-week-progress'));
    const taskStatus = $('task-arcade-status');
    if (taskStatus) taskStatus.textContent = accessStatusText();
    renderAccessBadges();
    if ($('arcade-view')?.classList.contains('active-view')) renderArcade();
  }

  function renderMiniWeek(container) {
    if (!container) return;
    const names=['日','月','火','水','木','金','土'];
    const keys=weekKeys(), today=currentDateKey(), done=getAdherence().doneDates;
    container.innerHTML='';
    keys.forEach((k,i) => {
      const d=document.createElement('div');
      d.className='mini-day'+(done[k]?' done':'')+(k===today?' today':'');
      d.innerHTML=`${names[dayOfWeek(k)]}<div class="mini-dot">${done[k]?'✓':'・'}</div>`;
      container.appendChild(d);
    });
  }

  function accessStatusText() {
    const count=weekDoneCount(), wallet=getWallet();
    if (isArcadeUnlocked()) return `7日連続達成。今日はゲームの日。${wallet}枚のメダルで遊べます。`;
    if (isGameDay()) return `直近7日間は ${count}/7日。7日そろうと今日アーケードが開きます。`;
    return `直近7日間は ${count}/7日。ゲームの日：${gameDaysText()}。次は${nextGameDayName()}です。`;
  }

  function renderAccessBadges() {
    const unlocked = isArcadeUnlocked();
    ['task-access-badge','arcade-access-badge'].forEach(id => {
      const el=$(id); if(!el) return;
      el.textContent = unlocked ? 'OPEN' : 'LOCK';
      el.classList.toggle('open', unlocked);
    });
  }

  // ---- Arcade hub ----
  function openArcade() { renderArcade(); switchView('arcade-view'); }

  function renderArcade() {
    refreshWalletOnly();
    renderMiniWeek($('arcade-week-progress'));
    $('arcade-access-status').textContent = accessStatusText();
    const arcadeNote=$('arcade-note');
    if (arcadeNote) arcadeNote.textContent=`メダルは使わなければ消えません。ゲームの日は ${gameDaysText()}。選んだ曜日のうち、直近7日間の記録がそろった日に遊べます。`;
    renderAccessBadges();
    const root=$('game-grid');
    root.innerHTML='';
    const unlocked=isArcadeUnlocked();
    const games=Array.isArray(window.ARCADE_GAMES)?window.ARCADE_GAMES:[];

    const sections = [
      {
        title:'スコアチャレンジ',
        note:'1枚消費のみ・BESTを更新',
        games:games.filter(g=>g.kind==='score')
      },
      {
        title:'ミニゲーム',
        note:'短時間で1プレイ',
        games:games.filter(g=>g.kind!=='score')
      }
    ];

    sections.forEach(section => {
      if (!section.games.length) return;
      const wrap=document.createElement('section');
      wrap.className='game-section';
      const head=document.createElement('div');
      head.className='game-section-head';
      head.innerHTML=`<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.note)}</p>`;
      const grid=document.createElement('div');
      grid.className='game-grid-inner';
      section.games.forEach(game => grid.appendChild(createGameCard(game, unlocked)));
      wrap.append(head, grid);
      root.appendChild(wrap);
    });
  }

  function createGameCard(game, unlocked) {
    const btn=document.createElement('button');
    btn.type='button';
    btn.className=`game-card${game.kind==='score'?' score-card':''}`;
    btn.disabled=!unlocked;
    const modeLabel = game.kind==='score'
      ? 'BEST CHALLENGE'
      : (game.reward==='win' ? '勝つと +1メダル' : '1 PLAY');
    btn.innerHTML=`
      <div class="game-card-top">
        <div class="game-icon">${escapeHtml(game.icon||'•')}</div>
        <span class="game-cost">M × ${Number(game.cost||1)}</span>
      </div>
      <strong>${escapeHtml(game.title)}</strong>
      <small>${escapeHtml(game.subtitle||'')}</small>
      <p>${escapeHtml(game.description||'')}</p>
      <span class="game-mode">${escapeHtml(modeLabel)}</span>
      ${unlocked?'':'<span class="game-lock">LOCK</span>'}`;
    btn.addEventListener('click', () => openGame(game.id));
    return btn;
  }

  function openGame(gameId) {
    if (!isArcadeUnlocked()) return;
    const game=(window.ARCADE_GAMES||[]).find(g=>g.id===gameId);
    if (!game) return;
    state.currentGameId=gameId;
    $('game-frame-title').textContent=game.title;
    $('game-frame').src=`${game.path}?embed=1&v=1.5.1`;
    refreshWalletOnly();
    switchView('arcade-game-view');
  }

  function closeGame() {
    $('game-frame').src='about:blank';
    state.currentGameId=null;
    refreshRewardUI();
    switchView('arcade-view');
  }

  function refreshWalletOnly() {
    const wallet=getWallet();
    ['task-medal-count','arcade-medal-count','game-frame-medal-count'].forEach(id=>{const el=$(id);if(el)el.textContent=wallet;});
  }

  // ---- Date / medicine count helpers ----
  function currentDateKey() {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const p=Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function weekKeys(){const today=currentDateKey(),start=addDaysKey(today,-6);return Array.from({length:7},(_,i)=>addDaysKey(start,i));}
  function weekStartKey(k){const d=parseKey(k),off=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-off);return keyFromDate(d);}
  function addDaysKey(k,n){const d=parseKey(k);d.setUTCDate(d.getUTCDate()+n);return keyFromDate(d);}
  function dayOfWeek(k){return parseKey(k).getUTCDay();}
  function parseKey(k){return new Date(k+'T00:00:00Z');}
  function keyFromDate(d){return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}

  function countKey(medId){return `count_${medId}_${currentDateKey()}`;}
  function getMedicineCount(medId){const n=parseInt(localStorage.getItem(countKey(medId))||'0',10);return Number.isFinite(n)?n:0;}
  function incrementMedicineCount(medId){localStorage.setItem(countKey(medId),String(getMedicineCount(medId)+1));}

  function cleanUrl() {
    if (location.search) history.replaceState({}, '', location.pathname + location.hash);
  }

  function escapeHtml(value='') {
    return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function updateNetworkUI() {
    const banner = $('network-banner');
    if (!banner) return;
    banner.hidden = navigator.onLine !== false;
  }

  let toastTimer = 0;
  function showToast(message) {
    const toast = $('toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
  }

  function successSound() {
    try {
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC)return;
      const a=new AC();
      [523,659,784].forEach((f,i)=>{
        const o=a.createOscillator(),g=a.createGain(),t=a.currentTime+i*.08;
        o.type='triangle';o.frequency.value=f;g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.03,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+.12);o.connect(g);g.connect(a.destination);o.start(t);o.stop(t+.14);
      });
      setTimeout(()=>a.close(),600);
    } catch (_) {}
  }
})();
