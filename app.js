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
  const DEVICE_ID_KEY = 'medicine-medal-device-id-v1';
  const PARENT_LINK_KEY = 'medicine-medal-parent-link-v1';
  const PENDING_APPROVALS_KEY = 'medicine-medal-pending-approvals-v1';
  const CLAIMED_APPROVALS_KEY = 'medicine-medal-claimed-approvals-v1';
  const MIGRATION_MODE_KEY = 'medicine-medal-parent-approval-mode-v1';
  const MIGRATION_NOTICE_DISMISSED_KEY = 'medicine-medal-parent-approval-notice-dismissed-v1';
  const DEFAULT_GAME_DAYS = [0]; // 0=日, 1=月 ... 6=土

  const state = { currentSelectedMedId: null, medList: [], currentGameId: null, parentSettingsAuthorized:false, pinMode:'verify', pinAfter:null, parentLink:null, approvalPollTimer:0 };
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
  window.addEventListener('pageshow', () => {
    refreshRewardUI();
    renderMigrationNotice();
    refreshParentLinkStatus({ showOnboarding:false }).then(() => syncPendingApprovals({ silent:true })).catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshRewardUI();
      renderMigrationNotice();
      refreshParentLinkStatus({ showOnboarding:false }).then(() => syncPendingApprovals({ silent:true })).catch(() => {});
    }
  });
  window.addEventListener('online', updateNetworkUI);
  window.addEventListener('offline', updateNetworkUI);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=1.12', { updateViaCache: 'none' }).catch(() => {}));
  }

  async function init() {
    bindStaticEvents();
    updateNetworkUI();
    const params = new URLSearchParams(location.search);
    if (params.has('reset')) {
      // Production migration safety: never erase existing user data from a URL parameter.
      params.delete('reset');
      const query = params.toString();
      history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`);
    }
    if (params.has('id')) state.currentSelectedMedId = params.get('id');
    renderTodayLabel();
    initializeMigrationMode();
    ensureDeviceId();
    refreshRewardUI();
    await loadMedicationList();
    await refreshParentLinkStatus({ showOnboarding:isParentSetupRequired() });
    await syncPendingApprovals({ silent:true });
    renderMigrationNotice();
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
    $('today-correction-list').addEventListener('click', onTodayCorrectionClick);
    $('send-parent-verification')?.addEventListener('click', () => sendParentVerification('onboarding'));
    $('check-parent-verification')?.addEventListener('click', async () => { await refreshParentLinkStatus({ showOnboarding:true, forceToast:true }); });
    $('change-onboarding-email')?.addEventListener('click', resetOnboardingEmailForm);
    $('onboarding-later')?.addEventListener('click', () => {
      localStorage.setItem(MIGRATION_NOTICE_DISMISSED_KEY, '1');
      switchView('task-view');
      renderMigrationNotice();
    });
    $('migration-start-parent')?.addEventListener('click', () => showParentOnboarding());
    $('migration-later')?.addEventListener('click', () => {
      localStorage.setItem(MIGRATION_NOTICE_DISMISSED_KEY, '1');
      renderMigrationNotice();
    });
    $('settings-send-parent-verification')?.addEventListener('click', () => sendParentVerification('settings'));
    $('check-approval-btn')?.addEventListener('click', async () => { await syncPendingApprovals({ silent:false }); });
    $('pending-back-btn')?.addEventListener('click', () => switchView('task-view'));
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
    if (viewId === 'task-view') { renderMedicationList(); refreshRewardUI(); renderMigrationNotice(); }
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
      const pendingCount = getPendingApprovalCount(med.id);
      const effectiveCount = currentCount + pendingCount;
      const limitCount = parseInt(med.limitCount || '0', 10);
      const done = limitCount > 0 && currentCount >= limitCount;
      const waiting = pendingCount > 0;
      recordedTotal += currentCount;
      if (limitCount > 0) {
        hasKnownLimit = true;
        remainingKnown += Math.max(0, limitCount - effectiveCount);
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
      else if (waiting) badge.textContent = `確認待ち ${pendingCount}`;
      else if (limitCount > 0) badge.textContent = `${currentCount}/${limitCount}回`;
      else badge.textContent = `${currentCount}回記録`;
      head.append(titleWrap, badge);
      card.appendChild(head);

      if (waiting && !done) {
        const pendingNote = document.createElement('p');
        pendingNote.className = 'med-pending-note';
        pendingNote.textContent = 'おうちの人の確認を待っています。';
        card.appendChild(pendingNote);
      }

      if (done || (limitCount > 0 && effectiveCount >= limitCount)) {
        const doneCopy = document.createElement('p');
        doneCopy.className = 'done-copy';
        doneCopy.textContent = done ? '今日の予定分を記録しました。' : '確認待ちの記録があります。';
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
    renderParentEmailSetting();
    refreshParentLinkStatus({ showOnboarding:false });
    renderGameDaySetting();
    renderTodayCorrections();
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

  function renderTodayCorrections() {
    const container = $('today-correction-list');
    if (!container) return;
    container.innerHTML = '';

    const records = state.medList
      .map(med => ({ med, count:getMedicineCount(med.id) }))
      .filter(item => item.count > 0);

    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'correction-empty';
      empty.textContent = '今日、取り消せる服薬記録はありません。';
      container.appendChild(empty);
      return;
    }

    records.forEach(({med, count}) => {
      const row = document.createElement('div');
      row.className = 'correction-row';
      const text = document.createElement('div');
      text.className = 'correction-row-text';
      const title = document.createElement('strong');
      title.textContent = med.title;
      const meta = document.createElement('small');
      meta.textContent = `今日の記録 ${count}回`;
      text.append(title, meta);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'correction-cancel-btn';
      btn.dataset.cancelMedId = String(med.id);
      btn.textContent = '1回取り消す';
      btn.setAttribute('aria-label', `${med.title}の今日の記録を1回取り消す`);
      row.append(text, btn);
      container.appendChild(row);
    });
  }

  function onTodayCorrectionClick(e) {
    const btn = e.target.closest('[data-cancel-med-id]');
    if (!btn) return;
    cancelTodayMedicationRecord(btn.dataset.cancelMedId);
  }

  function cancelTodayMedicationRecord(medId) {
    if (!state.parentSettingsAuthorized) return requestParentSettingsAccess();
    const med = state.medList.find(m => String(m.id) === String(medId));
    if (!med) return;
    const currentCount = getMedicineCount(medId);
    if (currentCount <= 0) {
      renderTodayCorrections();
      showToast('取り消せる記録がありません');
      return;
    }

    const ok = confirm(
      `今日の「${med.title}」の記録を1回取り消しますか？\n\n` +
      '・この端末の今日の記録回数を1回減らします。\n' +
      '・未使用のメダルがあれば1枚取り消します。\n' +
      '・Google Driveへ送信済みの写真とスプレッドシートの記録は自動では削除されません。'
    );
    if (!ok) return;

    setMedicineCount(medId, currentCount - 1);

    const wallet = getWallet();
    if (wallet > 0) localStorage.setItem(WALLET_KEY, String(wallet - 1));

    const adherence = getAdherence();
    const today = currentDateKey();
    if (totalMedicineRecordsForDate(today) === 0) delete adherence.doneDates[today];
    localStorage.setItem(ADHERENCE_KEY, JSON.stringify(adherence));

    writeCorrectionLog({
      date:today,
      medId:String(med.id),
      medTitle:String(med.title || ''),
      action:'cancel_one_local_record',
      walletBefore:wallet,
      walletAfter:getWallet(),
      at:new Date().toISOString()
    });

    renderMedicationList();
    renderTodayCorrections();
    refreshRewardUI();
    showToast(`${med.title}の記録を1回取り消しました`);
  }

  function writeCorrectionLog(entry) {
    const key = 'medicine-medal-correction-log-v1';
    try {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      const next = Array.isArray(list) ? list.slice(-49) : [];
      next.push(entry);
      localStorage.setItem(key, JSON.stringify(next));
    } catch (_) {}
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
    if (help) help.textContent = `ゲームの日：${gameDaysText(settings.gameDays)}。チェックした曜日はアーケードが開きます。服薬でためたメダルを使って遊べます。`;
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
    if (isParentSetupRequired() || (usesApprovalFlow() && !isParentVerified())) {
      state.currentSelectedMedId = medId;
      showParentOnboarding();
      return;
    }
    state.currentSelectedMedId = medId;
    $('target-med-title').textContent = medTitle;
    switchView('camera-view');
  }

  async function onCameraChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (isParentSetupRequired() || (usesApprovalFlow() && !isParentVerified())) {
      e.target.value = '';
      showParentOnboarding();
      return;
    }
    switchView('sending-view');
    try {
      const base64Image = await resizeAndConvertImage(file);

      if (!usesApprovalFlow()) {
        const payload = { action:'log', id:state.currentSelectedMedId, name:'ユーザー', image:base64Image };
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 12000));
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
        return;
      }

      const requestId = makeRequestId();
      const med = state.medList.find(m => String(m.id) === String(state.currentSelectedMedId));
      const pendingEntry = {
        requestId,
        medId:String(state.currentSelectedMedId),
        medTitle:String(med?.title || 'おくすり'),
        date:currentDateKey(),
        createdAt:new Date().toISOString()
      };
      addPendingApproval(pendingEntry);
      const payload = {
        action:'log',
        id:state.currentSelectedMedId,
        name:'ユーザー',
        image:base64Image,
        deviceId:getDeviceId(),
        requestId
      };
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 12000));
      const fetchPromise = fetch(GAS_URL, {
        method:'POST', mode:'no-cors', headers:{ 'Content-Type':'text/plain' }, body:JSON.stringify(payload)
      });
      await Promise.race([fetchPromise, timeoutPromise]);

      state.currentSelectedMedId = null;
      cleanUrl();
      renderMedicationList();
      showApprovalPending();
      startApprovalPolling();
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
      status.textContent = `今日はゲームの日！ メダルは ${reward.wallet}枚あります。`;
      arcadeBtn.hidden = false;
    } else {
      const count = weekDoneCount();
      status.textContent = `直近7日間は ${count}/7日。ゲームの日は ${gameDaysText()} です。次のゲームの日まで記録を続けよう。`;
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


  // ---- Parent email verification / approval flow v1.12 ----
  function hasLegacyFootprint() {
    const directKeys = [WALLET_KEY, ADHERENCE_KEY, PARENT_SETTINGS_KEY, PARENT_PIN_KEY, PARENT_PIN_LOCK_KEY, 'medicine-medal-correction-log-v1'];
    if (directKeys.some(key => localStorage.getItem(key) !== null)) return true;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || '';
      if (key.startsWith('count_')) return true;
    }
    return false;
  }

  function initializeMigrationMode() {
    const existing = localStorage.getItem(MIGRATION_MODE_KEY);
    if (['legacy','approval-required','approval'].includes(existing)) return existing;
    const link = getParentLink();
    const mode = link?.verified ? 'approval' : (hasLegacyFootprint() ? 'legacy' : 'approval-required');
    localStorage.setItem(MIGRATION_MODE_KEY, mode);
    return mode;
  }

  function getMigrationMode() { return initializeMigrationMode(); }

  function setMigrationMode(mode) {
    if (!['legacy','approval-required','approval'].includes(mode)) return;
    localStorage.setItem(MIGRATION_MODE_KEY, mode);
    renderMigrationNotice();
    renderParentEmailSetting();
  }

  function usesApprovalFlow() { return getMigrationMode() === 'approval'; }
  function isParentSetupRequired() { return getMigrationMode() === 'approval-required'; }

  function renderMigrationNotice() {
    const card = $('migration-notice');
    if (!card) return;
    const show = getMigrationMode() === 'legacy' && !isParentVerified() && localStorage.getItem(MIGRATION_NOTICE_DISMISSED_KEY) !== '1';
    card.hidden = !show;
  }

  function ensureDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  function getDeviceId() { return ensureDeviceId(); }

  function getParentLink() {
    try { return JSON.parse(localStorage.getItem(PARENT_LINK_KEY) || 'null'); } catch (_) { return null; }
  }

  function setParentLink(link) {
    state.parentLink = link || null;
    if (link) localStorage.setItem(PARENT_LINK_KEY, JSON.stringify(link));
    else localStorage.removeItem(PARENT_LINK_KEY);
  }

  function isParentVerified() {
    const link = state.parentLink || getParentLink();
    return !!link?.verified;
  }

  function showParentOnboarding() {
    const link = state.parentLink || getParentLink();
    const wait = $('parent-verification-wait');
    const formCard = $('send-parent-verification')?.closest('.settings-card');
    const emailInput = $('onboarding-parent-email');
    const laterBtn = $('onboarding-later');
    if (laterBtn) laterBtn.hidden = getMigrationMode() !== 'legacy';
    if (link?.pending) {
      if (formCard) formCard.hidden = true;
      if (wait) wait.hidden = false;
      if ($('parent-verification-wait-copy')) $('parent-verification-wait-copy').textContent = `${link.pendingMaskedEmail || '登録したメール'} に確認メールを送りました。メール内の「このメールアドレスを登録」を押してください。`;
    } else {
      if (formCard) formCard.hidden = false;
      if (wait) wait.hidden = true;
      if (emailInput) emailInput.value = '';
    }
    switchView('parent-onboarding-view');
  }

  function resetOnboardingEmailForm() {
    const link = state.parentLink || getParentLink() || {};
    setParentLink({ ...link, pending:false, pendingMaskedEmail:'' });
    showParentOnboarding();
  }

  async function sendParentVerification(source='onboarding') {
    const input = source === 'settings' ? $('settings-parent-email') : $('onboarding-parent-email');
    const error = source === 'settings' ? $('settings-parent-email-error') : $('onboarding-parent-error');
    const email = String(input?.value || '').trim();
    if (error) error.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (error) error.textContent = 'メールアドレスを確認してください。';
      return;
    }
    const btn = source === 'settings' ? $('settings-send-parent-verification') : $('send-parent-verification');
    if (btn) btn.disabled = true;
    try {
      const payload = { action:'registerParent', deviceId:getDeviceId(), email };
      await fetch(GAS_URL, { method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload) });
      const current = state.parentLink || getParentLink() || {};
      setParentLink({ ...current, pending:true, pendingMaskedEmail:maskEmail(email) });
      if (source === 'onboarding') showParentOnboarding();
      else {
        renderParentEmailSetting();
        showToast('確認メールを送りました');
      }
    } catch (_) {
      if (error) error.textContent = '確認メールを送れませんでした。通信環境を確認してください。';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshParentLinkStatus({ showOnboarding=false, forceToast=false }={}) {
    try {
      const url = `${GAS_URL}?action=getParentStatus&deviceId=${encodeURIComponent(getDeviceId())}&t=${Date.now()}`;
      const res = await fetch(url, { method:'GET', mode:'cors', cache:'no-store' });
      if (!res.ok) throw new Error('status');
      const data = await res.json();
      if (data?.status !== 'success') throw new Error(data?.message || 'status');
      const link = {
        verified:!!data.verified,
        maskedEmail:String(data.maskedEmail || ''),
        pending:!!data.pending,
        pendingMaskedEmail:String(data.pendingMaskedEmail || '')
      };
      const before = isParentVerified();
      setParentLink(link);
      renderParentEmailSetting();
      if (link.verified) {
        setMigrationMode('approval');
        localStorage.removeItem(MIGRATION_NOTICE_DISMISSED_KEY);
        if ($('parent-onboarding-view')?.classList.contains('active-view')) switchView('task-view');
        if (forceToast || !before) showToast('保護者メールの登録を確認しました。これからは確認後にメダルがもらえます');
        return true;
      }
      if (showOnboarding && isParentSetupRequired()) showParentOnboarding();
      if (forceToast) showToast('まだメールの確認が完了していません');
      renderMigrationNotice();
      return false;
    } catch (_) {
      const cached = getParentLink();
      state.parentLink = cached;
      if (showOnboarding && isParentSetupRequired() && !cached?.verified) showParentOnboarding();
      renderMigrationNotice();
      return !!cached?.verified;
    }
  }

  function renderParentEmailSetting() {
    const status = $('parent-email-status');
    if (!status) return;
    const link = state.parentLink || getParentLink() || {};
    const strong = status.querySelector('strong');
    if (link.verified) {
      strong.textContent = `登録済み ${link.maskedEmail || ''}`.trim();
    } else if (link.pending) {
      strong.textContent = `確認待ち ${link.pendingMaskedEmail || ''}`.trim();
    } else {
      strong.textContent = '未登録';
    }
    const mode = $('approval-mode-summary');
    if (mode) {
      if (usesApprovalFlow()) mode.textContent = '保護者確認方式：有効（確認後にメダル付与）';
      else if (isParentSetupRequired()) mode.textContent = '初回設定が必要です。保護者メールを登録してください。';
      else mode.textContent = '移行期間中：従来方式で利用中。メール確認完了後に新方式へ切り替わります。';
    }
  }

  function maskEmail(email) {
    const [local, domain] = String(email || '').split('@');
    if (!local || !domain) return '';
    const shown = local.length <= 2 ? local[0] || '*' : local.slice(0,2);
    return `${shown}${'*'.repeat(Math.max(2, Math.min(6, local.length - shown.length)))}@${domain}`;
  }

  function makeRequestId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function getPendingApprovals() {
    try { const v=JSON.parse(localStorage.getItem(PENDING_APPROVALS_KEY)||'[]'); return Array.isArray(v)?v:[]; } catch (_) { return []; }
  }

  function savePendingApprovals(list) {
    localStorage.setItem(PENDING_APPROVALS_KEY, JSON.stringify((Array.isArray(list)?list:[]).slice(-30)));
  }

  function addPendingApproval(entry) {
    const list=getPendingApprovals().filter(x=>x.requestId!==entry.requestId);
    list.push(entry);
    savePendingApprovals(list);
  }

  function getPendingApprovalCount(medId, dateKey=currentDateKey()) {
    return getPendingApprovals().filter(x=>String(x.medId)===String(medId) && x.date===dateKey).length;
  }

  function getClaimedApprovals() {
    try { const v=JSON.parse(localStorage.getItem(CLAIMED_APPROVALS_KEY)||'[]'); return Array.isArray(v)?v:[]; } catch (_) { return []; }
  }

  function rememberClaimedApproval(requestId) {
    const list=getClaimedApprovals().filter(x=>x!==requestId);
    list.push(requestId);
    localStorage.setItem(CLAIMED_APPROVALS_KEY, JSON.stringify(list.slice(-100)));
  }

  function showApprovalPending() {
    const status=$('approval-pending-status');
    if(status) status.textContent='確認待ち';
    switchView('approval-pending-view');
  }

  function startApprovalPolling() {
    clearInterval(state.approvalPollTimer);
    state.approvalPollTimer=setInterval(()=>syncPendingApprovals({silent:true}),15000);
  }

  async function syncPendingApprovals({ silent=true }={}) {
    const pending=getPendingApprovals();
    if (!pending.length) return {approved:0,rejected:0};
    let approved=0,rejected=0;
    const keep=[];
    for (const item of pending) {
      try {
        const url=`${GAS_URL}?action=getRequestStatus&deviceId=${encodeURIComponent(getDeviceId())}&requestId=${encodeURIComponent(item.requestId)}&t=${Date.now()}`;
        const res=await fetch(url,{method:'GET',mode:'cors',cache:'no-store'});
        if(!res.ok) throw new Error('status');
        const data=await res.json();
        if(data?.status!=='success') throw new Error(data?.message||'status');
        if(data.requestStatus==='approved') {
          if(!getClaimedApprovals().includes(item.requestId)) {
            setMedicineCount(item.medId, getMedicineCount(item.medId, item.date) + 1, item.date);
            const reward=recordMedicationReward(item.date);
            rememberClaimedApproval(item.requestId);
            approved++;
            fetch(GAS_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify({action:'markRewarded',deviceId:getDeviceId(),requestId:item.requestId})}).catch(()=>{});
            if ($('approval-pending-view')?.classList.contains('active-view')) showComplete(reward);
          }
        } else if(data.requestStatus==='rewarded') {
          // サーバー側ですでに報酬処理済み。二重付与を避けるため保留一覧から外す。
        } else if(data.requestStatus==='rejected') {
          rejected++;
          if ($('approval-pending-view')?.classList.contains('active-view')) {
            const st=$('approval-pending-status'); if(st) st.textContent='撮り直してください';
          }
        } else {
          keep.push(item);
        }
      } catch (_) {
        keep.push(item);
      }
    }
    savePendingApprovals(keep);
    renderMedicationList();
    renderTodayCorrections();
    refreshRewardUI();
    if(!silent) {
      if(approved) showToast(`確認されました。メダル +${approved}`);
      else if(rejected) showToast('撮り直しになった記録があります');
      else showToast('まだ確認待ちです');
    }
    return {approved,rejected};
  }

  // ---- Medal / weekly adherence ----
  function recordMedicationReward(dateKey=currentDateKey()) {
    const wallet = getWallet() + 1;
    localStorage.setItem(WALLET_KEY, String(wallet));
    const adherence = getAdherence();
    adherence.doneDates[dateKey] = true;
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

  function isArcadeUnlocked() { return isGameDay(); }
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
      const gameDay=getParentSettings().gameDays.includes(dayOfWeek(k));
      d.className='mini-day'+(done[k]?' done':'')+(k===today?' today':'')+(gameDay?' game-day':'');
      d.title=gameDay?'ゲームの日':'';
      d.innerHTML=`<span class="mini-day-name">${names[dayOfWeek(k)]}${gameDay?'<span class="game-day-mark" aria-hidden="true">★</span>':''}</span><div class="mini-dot">${done[k]?'✓':'・'}</div>`;
      container.appendChild(d);
    });
  }

  function accessStatusText() {
    const count=weekDoneCount(), wallet=getWallet();
    if (isArcadeUnlocked()) return wallet > 0 ? `今日はゲームの日。${wallet}枚のメダルで遊べます。` : '今日はゲームの日。服薬を記録すると、ためたメダルで遊べます。';
    return `直近7日間は ${count}/7日。★はゲームの日。次は${nextGameDayName()}です。`;
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
    if (arcadeNote) arcadeNote.textContent=`メダルは使わなければ消えません。ゲームの日は ${gameDaysText()}。チェックした曜日はアーケードが開きます。`;
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
    $('game-frame').src=`${game.path}?embed=1&v=1.12`;
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

  function countKey(medId,dateKey=currentDateKey()){return `count_${medId}_${dateKey}`;}
  function getMedicineCount(medId,dateKey=currentDateKey()){const n=parseInt(localStorage.getItem(countKey(medId,dateKey))||'0',10);return Number.isFinite(n)?Math.max(0,n):0;}
  function setMedicineCount(medId,count,dateKey=currentDateKey()){const n=Math.max(0,parseInt(count||'0',10)||0);if(n===0)localStorage.removeItem(countKey(medId,dateKey));else localStorage.setItem(countKey(medId,dateKey),String(n));}
  function incrementMedicineCount(medId){setMedicineCount(medId,getMedicineCount(medId)+1);}
  function totalMedicineRecordsForDate(dateKey=currentDateKey()){return state.medList.reduce((sum,med)=>sum+getMedicineCount(med.id,dateKey),0);}

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
