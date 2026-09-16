(() => {
  'use strict';

  const SAVE_KEY = 'hammerClimbDeluxe_save_v1';
  const SOUND_KEY = 'hammerClimbDeluxe_sound_v1';

  const GRAVITY = 2200;
  const BODY_RADIUS = 22;
  const TIP_RADIUS = 13;
  const HAMMER_LEN = 150;
  const SUBSTEPS = 4;
  const MAX_SPEED = 2600;
  const PULL_STIFFNESS = 34;
  const MAX_PULL_PER_SUB = 20;
  const PUSH_STIFFNESS = 16;
  const MAX_PUSH_PER_SUB = 22;
  const SHOULDER_OFFSET = { x: 0, y: -6 };

  const terrain = Terrain.create();

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  let DPR = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  let cssW = 0, cssH = 0;
  let camScale = 1;

  function resize() {
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    DPR = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    canvas.width = Math.round(cssW * DPR);
    canvas.height = Math.round(cssH * DPR);
    camScale = Math.max(0.6, Math.min(1.3, cssW / 560));
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  function anchorScreen() {
    return { x: cssW * 0.5, y: cssH * 0.6 };
  }

  // ---------- 状態 ----------
  const body = { x: terrain.start.x + 20, y: terrain.start.y - 55, vx: 0, vy: 0 };
  let tipPos = { x: body.x, y: body.y };
  let grounded = false;
  let furthestY = body.y;
  let elapsedMs = 0;
  let hasWon = false;
  let gameState = 'title'; // title | playing | paused | win
  let soundOn = true;
  try { soundOn = localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) {}

  const camera = { x: body.x, y: body.y };
  let hammerAngle = -0.95;

  const goal = (() => {
    const s = terrain.summit;
    return { x: s.x - 70, y: s.y - 30, r: 75 };
  })();

  // ---------- 入力 ----------
  // ハンマーは「今指(カーソル)がある方向」を常に直接向く(長さは固定)。
  // ドラッグ量ではなく絶対位置から角度を決めるので、狙った場所に素直にハンマーが伸びる。
  function handlePointerAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const a = anchorScreen();
    const dx = (clientX - rect.left) - a.x;
    const dy = (clientY - rect.top) - a.y;
    if (dx * dx + dy * dy < 4) return; // カーソルが体のすぐ上にある間は角度を変えない(atan2の不定を避ける)
    hammerAngle = Math.atan2(dy, dx);
  }
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    handlePointerAt(e.clientX, e.clientY);
    ensureAudio();
  }, { passive: true });
  window.addEventListener('pointermove', (e) => {
    if (gameState !== 'playing') return;
    handlePointerAt(e.clientX, e.clientY);
  }, { passive: true });

  // ---------- 音 ----------
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx || !soundOn) return;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  function playClang(strength) {
    if (!soundOn || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const vol = Math.max(0.05, Math.min(0.5, strength));
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520 + Math.random() * 120, t0);
    osc.frequency.exponentialRampToValueAtTime(140, t0 + 0.09);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.13);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.14);
  }
  function playWin() {
    if (!soundOn || !audioCtx) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      const t0 = audioCtx.currentTime + i * 0.11;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.22, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
  }

  // ---------- 物理 ----------
  let wasGrounded = false;

  function physicsStep(dt) {
    const sub = dt / SUBSTEPS;
    const dirx = Math.cos(hammerAngle), diry = Math.sin(hammerAngle);

    for (let i = 0; i < SUBSTEPS; i++) {
      body.vy += GRAVITY * sub;

      const shoulderX = body.x + SHOULDER_OFFSET.x;
      const shoulderY = body.y + SHOULDER_OFFSET.y;
      const desiredTipX = shoulderX + dirx * HAMMER_LEN;
      const desiredTipY = shoulderY + diry * HAMMER_LEN;

      const hit = terrain.resolveCircle(desiredTipX, desiredTipY, TIP_RADIUS);
      let curTipX, curTipY;
      if (hit) {
        curTipX = desiredTipX + hit.nx * hit.pen;
        curTipY = desiredTipY + hit.ny * hit.pen;
        grounded = true;
      } else {
        curTipX = desiredTipX;
        curTipY = desiredTipY;
        grounded = false;
      }

      if (grounded) {
        // ハンマーが地形にめり込もうとした反力(ポールを突いて体を押し出す)
        const diffx = desiredTipX - curTipX;
        const diffy = desiredTipY - curTipY;
        const diffLen = Math.hypot(diffx, diffy);
        if (diffLen > 0.01) {
          const capped = Math.min(diffLen, MAX_PUSH_PER_SUB);
          body.vx -= (diffx / diffLen) * capped * PUSH_STIFFNESS;
          body.vy -= (diffy / diffLen) * capped * PUSH_STIFFNESS;
        }

        // 出っ張りに引っかかり、腕の長さを超えた分だけ体を引き寄せる(フック)
        const tx = curTipX - shoulderX, ty = curTipY - shoulderY;
        const dist = Math.hypot(tx, ty);
        if (dist > HAMMER_LEN) {
          const excess = Math.min(MAX_PULL_PER_SUB, dist - HAMMER_LEN);
          const pdx = tx / dist, pdy = ty / dist;
          body.vx += pdx * excess * PULL_STIFFNESS;
          body.vy += pdy * excess * PULL_STIFFNESS;
        }
      }

      const speed = Math.hypot(body.vx, body.vy);
      if (speed > MAX_SPEED) {
        body.vx = (body.vx / speed) * MAX_SPEED;
        body.vy = (body.vy / speed) * MAX_SPEED;
      }

      body.x += body.vx * sub;
      body.y += body.vy * sub;

      const bodyHit = terrain.resolveCircle(body.x, body.y, BODY_RADIUS);
      if (bodyHit) {
        body.x += bodyHit.nx * bodyHit.pen;
        body.y += bodyHit.ny * bodyHit.pen;
        const vn = body.vx * bodyHit.nx + body.vy * bodyHit.ny;
        if (vn < 0) {
          body.vx -= vn * bodyHit.nx;
          body.vy -= vn * bodyHit.ny;
        }
        const f = bodyHit.friction;
        const tanx = -bodyHit.ny, tany = bodyHit.nx;
        const vnAfter = body.vx * bodyHit.nx + body.vy * bodyHit.ny;
        const vtAfter = body.vx * tanx + body.vy * tany;
        body.vx = bodyHit.nx * vnAfter + tanx * vtAfter * f;
        body.vy = bodyHit.ny * vnAfter + tany * vtAfter * f;
      }

      tipPos.x = curTipX;
      tipPos.y = curTipY;
    }

    if (grounded && !wasGrounded) {
      const impactSpeed = Math.hypot(body.vx, body.vy);
      if (impactSpeed > 60) playClang(impactSpeed / 1400);
    }
    wasGrounded = grounded;

    if (body.y < furthestY) {
      const improved = furthestY - body.y;
      furthestY = body.y;
      if (improved > 4) maybeShowMilestone();
    }

    if (body.y > terrain.start.y + 600 || body.x < terrain.start.x - 800) {
      body.x = terrain.start.x + 20;
      body.y = terrain.start.y - 55;
      body.vx = 0; body.vy = 0;
      showToast('落ちすぎた…スタート地点に戻る');
    }
  }

  // ---------- 進捗 ----------
  function progressPercentOf(y) {
    const p = ((terrain.start.y - y) / terrain.totalRise) * 100;
    return Math.max(0, Math.min(100, p));
  }

  const milestones = [
    { p: 8, msg: 'まずは足慣らし' },
    { p: 22, msg: 'ここから斜面がキツくなる…' },
    { p: 38, msg: 'いいペース！' },
    { p: 50, msg: '折り返し地点' },
    { p: 63, msg: 'げっ、滑る坂だ…慎重に' },
    { p: 78, msg: 'かなり登ってきた' },
    { p: 90, msg: 'あと少し！山頂が見える' },
  ];
  let nextMilestoneIdx = 0;
  function maybeShowMilestone() {
    const p = progressPercentOf(furthestY);
    while (nextMilestoneIdx < milestones.length && p >= milestones[nextMilestoneIdx].p) {
      showToast(milestones[nextMilestoneIdx].msg);
      nextMilestoneIdx++;
    }
  }
  function syncMilestoneIndexFromFurthest() {
    const p = progressPercentOf(furthestY);
    nextMilestoneIdx = 0;
    while (nextMilestoneIdx < milestones.length && p >= milestones[nextMilestoneIdx].p) nextMilestoneIdx++;
  }

  let toastTimer = null;
  const toastEl = document.getElementById('toast');
  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  // ---------- セーブ ----------
  function saveGame() {
    try {
      const data = {
        x: body.x, y: body.y, vx: body.vx, vy: body.vy,
        furthestY, elapsedMs, savedAt: Date.now(),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {}
  }
  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  function applySave(data) {
    body.x = data.x; body.y = data.y; body.vx = data.vx || 0; body.vy = data.vy || 0;
    furthestY = data.furthestY != null ? data.furthestY : data.y;
    elapsedMs = data.elapsedMs || 0;
    syncMilestoneIndexFromFurthest();
  }

  function resetToStart() {
    body.x = terrain.start.x + 20; body.y = terrain.start.y - 55;
    body.vx = 0; body.vy = 0;
    furthestY = body.y;
    elapsedMs = 0;
    hasWon = false;
    nextMilestoneIdx = 0;
  }

  let autosaveTimer = null;
  function startAutosave() {
    stopAutosave();
    autosaveTimer = setInterval(() => { if (gameState === 'playing') saveGame(); }, 4000);
  }
  function stopAutosave() { if (autosaveTimer) clearInterval(autosaveTimer); autosaveTimer = null; }

  window.addEventListener('visibilitychange', () => { if (document.hidden && gameState === 'playing') saveGame(); });
  window.addEventListener('pagehide', () => { if (gameState === 'playing') saveGame(); });

  // ---------- 描画 ----------
  function skyColors(p) {
    const stops = [
      [0, [255, 214, 140], [255, 170, 130]],
      [30, [255, 224, 170], [140, 190, 235]],
      [60, [170, 210, 245], [70, 130, 210]],
      [85, [70, 100, 190], [20, 30, 80]],
      [100, [15, 15, 45], [3, 3, 15]],
    ];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (p >= stops[i][0] && p <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const t = b[0] === a[0] ? 0 : (p - a[0]) / (b[0] - a[0]);
    const lerp = (u, v) => u.map((c, i) => Math.round(c + (v[i] - c) * t));
    return { top: lerp(a[1], b[1]), bottom: lerp(a[2], b[2]) };
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const p = progressPercentOf(body.y);
    const sky = skyColors(p);
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, `rgb(${sky.top.join(',')})`);
    grad.addColorStop(1, `rgb(${sky.bottom.join(',')})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    // 遠景の星(高高度で表示)
    if (p > 55) {
      const starAlpha = Math.min(1, (p - 55) / 25);
      ctx.fillStyle = `rgba(255,255,255,${starAlpha * 0.8})`;
      for (let i = 0; i < 60; i++) {
        const sx = (i * 97 + (camera.x * 0.02)) % cssW;
        const sy = (i * 53) % (cssH * 0.7);
        ctx.fillRect((sx + cssW) % cssW, sy, 1.6, 1.6);
      }
    }

    const a = anchorScreen();
    ctx.translate(a.x, a.y);
    ctx.scale(camScale, camScale);
    ctx.translate(-camera.x, -camera.y);

    // 地形
    ctx.beginPath();
    const poly = terrain.fillPolygon;
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    const rockGrad = ctx.createLinearGradient(0, terrain.summit.y, 0, terrain.start.y);
    rockGrad.addColorStop(0, '#5b5468');
    rockGrad.addColorStop(1, '#7a5c46');
    ctx.fillStyle = rockGrad;
    ctx.fill();

    ctx.beginPath();
    const pts = terrain.pts;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 3 / camScale;
    ctx.stroke();

    // ゴール旗
    ctx.save();
    ctx.translate(goal.x, goal.y);
    ctx.strokeStyle = '#3a2a1a';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(0, -70); ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.moveTo(0, -70); ctx.lineTo(46, -58); ctx.lineTo(0, -44); ctx.closePath(); ctx.fill();
    ctx.restore();

    drawCharacter();

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function drawCharacter() {
    const bx = body.x, by = body.y;
    const shoulderX = bx + SHOULDER_OFFSET.x, shoulderY = by + SHOULDER_OFFSET.y;

    // 柄
    ctx.strokeStyle = '#8a6236';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(tipPos.x, tipPos.y);
    ctx.stroke();

    // ハンマー頭
    const ang = Math.atan2(tipPos.y - shoulderY, tipPos.x - shoulderX);
    ctx.save();
    ctx.translate(tipPos.x, tipPos.y);
    ctx.rotate(ang);
    ctx.fillStyle = grounded ? '#d8d8de' : '#b7b7c2';
    ctx.strokeStyle = '#3a3a44';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-11, -16, 22, 32, 5);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 壺
    ctx.save();
    ctx.translate(bx, by);
    const potGrad = ctx.createLinearGradient(-BODY_RADIUS, 0, BODY_RADIUS, 0);
    potGrad.addColorStop(0, '#8a4a2c');
    potGrad.addColorStop(0.5, '#b96b3e');
    potGrad.addColorStop(1, '#8a4a2c');
    ctx.fillStyle = potGrad;
    ctx.strokeStyle = '#5c3018';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-BODY_RADIUS + 3, -2);
    ctx.quadraticCurveTo(-BODY_RADIUS - 6, BODY_RADIUS + 4, 0, BODY_RADIUS + 10);
    ctx.quadraticCurveTo(BODY_RADIUS + 6, BODY_RADIUS + 4, BODY_RADIUS - 3, -2);
    ctx.quadraticCurveTo(0, -12, -BODY_RADIUS + 3, -2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 顔
    ctx.fillStyle = '#f3caa0';
    ctx.beginPath();
    ctx.arc(0, -14, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#5c3018';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.arc(-4, -15, 1.6, 0, Math.PI * 2);
    ctx.arc(4, -15, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, -11, 3, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    ctx.restore();
  }

  // ---------- HUD / UI ----------
  const heightBadge = document.getElementById('heightBadge');
  function updateHud() {
    const live = progressPercentOf(body.y);
    const best = progressPercentOf(furthestY);
    heightBadge.innerHTML = `高度 <b>${live.toFixed(1)}%</b><span class="best">ベスト ${best.toFixed(1)}%</span>`;
  }

  const titleScreen = document.getElementById('titleScreen');
  const pauseScreen = document.getElementById('pauseScreen');
  const winScreen = document.getElementById('winScreen');
  const confirmDialog = document.getElementById('confirmDialog');
  const confirmText = document.getElementById('confirmText');
  const continueRow = document.getElementById('continueRow');
  const saveHeightEl = document.getElementById('saveHeight');
  const pauseBtn = document.getElementById('pauseBtn');
  const hud = document.getElementById('hud');

  function showOnly(el) {
    [titleScreen, pauseScreen, winScreen, confirmDialog].forEach((e) => e.classList.add('hidden'));
    if (el) el.classList.remove('hidden');
  }

  function goPlaying() {
    gameState = 'playing';
    showOnly(null);
    hud.classList.remove('hidden');
    startAutosave();
  }

  function startNewGame() {
    resetToStart();
    clearSave();
    goPlaying();
  }

  function startContinue() {
    const data = loadSave();
    if (data) applySave(data);
    goPlaying();
  }

  const existingSave = loadSave();
  if (existingSave) {
    continueRow.classList.remove('hidden');
    saveHeightEl.textContent = progressPercentOf(existingSave.furthestY != null ? existingSave.furthestY : existingSave.y).toFixed(1) + '%';
  }

  document.getElementById('newGameBtn').addEventListener('click', () => {
    if (loadSave()) {
      askConfirm('セーブデータを消して最初から始めます。よろしいですか？', startNewGame);
    } else {
      startNewGame();
    }
  });
  document.getElementById('continueBtn').addEventListener('click', startContinue);

  pauseBtn.addEventListener('click', () => {
    if (gameState !== 'playing') return;
    gameState = 'paused';
    saveGame();
    showOnly(pauseScreen);
  });
  document.getElementById('resumeBtn').addEventListener('click', () => { goPlaying(); });
  document.getElementById('restartCheckpointBtn').addEventListener('click', () => {
    const data = loadSave();
    if (data) applySave(data);
    goPlaying();
  });
  document.getElementById('restartAllBtn').addEventListener('click', () => {
    askConfirm('最初からやり直します。よろしいですか？', () => { resetToStart(); clearSave(); goPlaying(); });
  });
  document.getElementById('freeRoamBtn').addEventListener('click', () => { goPlaying(); });
  document.getElementById('restartAllBtn2').addEventListener('click', () => {
    resetToStart(); clearSave(); goPlaying();
  });

  let confirmCb = null;
  function askConfirm(text, cb) {
    confirmText.textContent = text;
    confirmCb = cb;
    showOnly(confirmDialog);
  }
  document.getElementById('confirmYes').addEventListener('click', () => {
    const cb = confirmCb; confirmCb = null;
    if (cb) cb();
  });
  document.getElementById('confirmNo').addEventListener('click', () => {
    confirmCb = null;
    showOnly(gameState === 'paused' ? pauseScreen : titleScreen);
  });

  function setSoundUI() {
    document.querySelectorAll('.soundToggle input').forEach((el) => { el.checked = soundOn; });
  }
  setSoundUI();
  document.querySelectorAll('.soundToggle input').forEach((el) => {
    el.addEventListener('change', (e) => {
      soundOn = e.target.checked;
      try { localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch (err) {}
      setSoundUI();
      if (soundOn) ensureAudio();
    });
  });

  const winTimeEl = document.getElementById('winTime');
  function checkWin() {
    if (hasWon) return;
    const dx = body.x - goal.x, dy = body.y - goal.y;
    if (Math.hypot(dx, dy) < goal.r) {
      hasWon = true;
      gameState = 'win';
      clearSave();
      playWin();
      const totalSec = Math.round(elapsedMs / 1000);
      const mm = Math.floor(totalSec / 60), ss = totalSec % 60;
      winTimeEl.textContent = `クリアタイム ${mm}分${ss.toString().padStart(2, '0')}秒`;
      showOnly(winScreen);
    }
  }

  // ---------- メインループ ----------
  let lastT = performance.now();
  function frame(now) {
    let dt = (now - lastT) / 1000;
    lastT = now;
    dt = Math.min(dt, 1 / 30);

    if (gameState === 'playing') {
      physicsStep(dt);
      elapsedMs += dt * 1000;
      const lerpK = 1 - Math.exp(-dt * 10);
      camera.x += (body.x - camera.x) * lerpK;
      camera.y += (body.y - camera.y) * lerpK;
      updateHud();
      checkWin();
    }

    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
