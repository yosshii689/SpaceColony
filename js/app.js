// 起動・入力・メインループ
(function () {
  'use strict';
  const COL = window.COL, V = COL.V;
  const $ = function (id) { return document.getElementById(id); };

  const q = new URLSearchParams(location.search);
  // 奥行きの対数バッファは「隠れた画素も全部計算する」原因になるので使わない（?logz=1 で元に戻せる）
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: q.get('logz') === '1', powerPreference: 'high-performance' });
  const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(baseDpr);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.25, 60000);
  COL.buildWorld(scene);
  COL.buildCity(scene, renderer);
  COL.buildPort(scene);
  COL.buildVehicles(scene);
  COL.buildLife(scene);
  COL.buildWhales(scene);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // 開始位置: 陸地Aの中央、宇宙港側から3km、ガラスの端の方を向く
  // （確認用に URL で上書き可: ?th=度&z=m&h=m&yaw=度&pitch=度&fly=1&auto=1）
  const num = function (k, d) { const v = parseFloat(q.get(k)); return isFinite(v) ? v : d; };
  const rad = Math.PI / 180;
  // h は地面からの高さ
  const player = COL.createPlayer(num('th', -90) * rad, num('z', 3000), num('h', 0) + COL.groundH(num('th', -90) * rad, num('z', 3000)));
  player.fly = q.get('fly') === '1';
  if (q.get('q')) COL.QUALITY_START = parseInt(q.get('q'), 10);
  player.pitch = num('pitch', 0) * rad;
  COL.stepPlayer(player, { yaw: num('yaw', 0) * rad }, 0);
  COL.player = player;
  COL.clock = num('t', 10);
  if (q.get('ride') !== null) COL.startRide(0, q.get('down') !== '1', num('ride', 0));
  COL.initMap(player, function () { renderer.domElement.requestPointerLock(); });
  // 確認用: ?veh=car&spd=40 / ?veh=train&st=3 / ?veh=plat&st=3 / ?map=1
  if (q.get('veh') === 'plat' || q.get('veh') === 'train') COL.debugVehicle(player, 'plat', num('st', 0));
  if (q.get('veh') === 'train') COL.debugVehicle(player, 'train', num('st', 0), { lz: num('lz', 0), lx: num('lx', 0), yaw: num('tyaw', 0) * rad });
  if (q.get('veh') === 'car') COL.debugVehicle(player, 'car', num('spd', 0));
  if (q.get('map') === '1') COL.toggleMap();
  if (q.get('people') === '1') COL.debugPeople = true;
  if (q.get('whale') === '1') COL.debugWhale(player, num('wt', 0), num('wd', 40), num('wh', 3), num('ws', 0) * rad);

  // ---- 入力 ----
  const keys = {};
  let mouseX = 0, mouseY = 0, jumpQueued = false, usePressed = false, callPressed = false, uiHidden = false, shotQueued = false;
  // 二回押し: W を素早く2回 → 2回目を押している間ずっと高速。Space を素早く2回 → 飛行と徒歩の切り替え
  const DOUBLE_TAP = 0.3;
  let lastW = -9, lastSpace = -9, sprint = false;
  const locked = function () { return document.pointerLockElement === renderer.domElement; };
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    const t = performance.now() / 1000;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') {
      if (t - lastW < DOUBLE_TAP) sprint = true;
      lastW = t;
    }
    if (e.code === 'Space') {
      if (t - lastSpace < DOUBLE_TAP) { player.fly = !player.fly; lastSpace = -9; }
      else { jumpQueued = true; lastSpace = t; }
    }
    if (e.code === 'KeyF') { player.fly = !player.fly; }
    if (e.code === 'KeyV') COL.cycleQuality();
    if (e.code === 'KeyR') { resMode = (resMode + 1) % RES_MODES.length; applyRes(RES_MODES[resMode] || 1); resCeil = 1; }
    // 数字キーで見どころへ移動
    if (e.code === 'KeyE') usePressed = true;
    if (e.code === 'KeyC') callPressed = true;
    COL.initSound();
    if (e.code === 'KeyN') COL.toggleMute();
    // 撮影: P で画面の文字を消す／戻す、K で今の画面を画像として保存
    if (e.code === 'KeyP') { uiHidden = !uiHidden; document.body.classList.toggle('photo', uiHidden); }
    if (e.code === 'KeyK') shotQueued = true;
    // 8: 一番近い駅のホームへ、9: 次の駅へ、0: 前の駅へ
    if (e.code === 'Digit8') COL.stationWarp(player, 'near');
    if (e.code === 'Digit9') COL.stationWarp(player, 1);
    if (e.code === 'Digit0') COL.stationWarp(player, -1);
    if (e.code === 'KeyM' || (e.code === 'Escape' && COL.mapOpen())) {
      if (COL.toggleMap()) document.exitPointerLock(); else renderer.domElement.requestPointerLock();
    }
    if (e.code === 'Digit6' || e.code === 'Digit7') {         // 6: 宇宙港ドックの入口、7: エレベーターの麓の駅
      COL.ride = null; COL.driving = false; COL.onTrain = null;
      const th = -90 * rad, hub = e.code === 'Digit6';
      const np = hub ? COL.createPlayer(th, 120, COL.R - 150) : COL.createPlayer(th, 2090, COL.groundH(th, 2090) + 0.1);
      player.pos = np.pos; player.vel = [0, 0, 0]; player.up = np.up; player.fwd = [0, 0, -1]; player.pitch = 0; player.fly = hub;
    }
    const spot = { Digit1: [-90, 12000, 0], Digit2: [-90, 24890, 0], Digit3: [26, 4300, 0], Digit4: [-90, 3000, 0], Digit5: [-90, 11200, 500] }[e.code];
    if (spot) {
      COL.ride = null; COL.driving = false; COL.onTrain = null;
      const th = spot[0] * rad, np = COL.createPlayer(th, spot[1], COL.groundH(th, spot[1]) + spot[2] + 0.1);
      player.pos = np.pos; player.vel = [0, 0, 0]; player.up = np.up; player.fwd = np.fwd; player.pitch = spot[2] ? -0.35 : 0;
      player.fly = spot[2] > 0;
    }
  });
  window.addEventListener('keyup', function (e) {
    keys[e.code] = false;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') sprint = false;
  });
  window.addEventListener('blur', function () { for (const k in keys) keys[k] = false; sprint = false; });
  document.addEventListener('mousemove', function (e) {
    if (!locked()) return;
    mouseX += e.movementX; mouseY += e.movementY;
  });
  $('start').addEventListener('click', function () { COL.initSound(); renderer.domElement.requestPointerLock(); });
  renderer.domElement.addEventListener('click', function () { if (!locked()) renderer.domElement.requestPointerLock(); });
  document.addEventListener('pointerlockchange', function () {
    $('start').style.display = (locked() || COL.mapOpen()) ? 'none' : '';
  });
  if (q.get('auto') === '1') $('start').style.display = 'none';

  // ---- 解像度の自動調整: fps が足りないときは描く画素数を減らす（R キーで 自動 / 100% / 75% / 50%） ----
  const RES_MODES = [0, 1, 0.75, 0.5];           // 0 = 自動
  let resMode = q.get('auto') === '1' ? 1 : 0, resScale = 1, resCeil = 1, resHold = 0, accT = 0, accN = 0;
  function applyRes(sc) {
    if (sc === resScale) return;
    resScale = sc;
    renderer.setPixelRatio(baseDpr * resScale);
  }
  function autoRes(rawDt) {
    if (resMode !== 0 || rawDt > 0.5 || !locked()) { accT = accN = 0; return; }
    accT += rawDt; accN++;
    if (accT < 1) return;
    const f = accN / accT;
    accT = accN = 0; resHold--;
    if (f < 50) {
      // 上げた直後に足りなくなったら、その手前を当面の上限にする
      resCeil = Math.max(0.5, resScale * 0.92);
      applyRes(Math.max(0.5, resScale * (f < 36 ? 0.80 : 0.90)));
      resHold = 6;
    } else if (f > 57.5 && resHold <= 0 && resScale < 1) {
      if (resScale * 1.07 <= resCeil) applyRes(Math.min(1, resScale * 1.07));
      else if (resHold < -30) resCeil = 1;         // しばらく安定していたら、上限を外して試す
      else return;
      resHold = 3;
    }
  }

  const SENS = 0.0022;
  function readInput() {
    const k = keys;
    const inp = {
      f: (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0),
      s: (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0),
      ud: (k.Space ? 1 : 0) - (k.ShiftLeft || k.ShiftRight ? 1 : 0),      // 飛行中: Space 上昇 / Shift 下降
      run: sprint,
      jump: jumpQueued,
      yaw: mouseX * SENS,
      pitch: -mouseY * SENS,
    };
    mouseX = mouseY = 0; jumpQueued = false;
    return inp;
  }

  // ---- 画面表示 ----
  const hud = $('hud');
  let hudT = 0, fps = 60;
  function updateHud(dt) {
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;
    hudT -= dt;
    if (hudT > 0) return;
    hudT = 0.15;
    const c = COL.toCyl(player.pos), st = COL.stripAt(c.theta);
    const deg = ((c.theta - COL.THETA0) * 180 / Math.PI % 360 + 360) % 360;
    const sp = V.len(player.vel) * 3.6;
    hud.textContent =
      '場所　 ' + (c.z < 0 ? '宇宙港ドック' : st.name + (st.land ? '・' + COL.placeName(c.theta, c.z) : '')) + (COL.ride ? '（エレベーター）' : '') + '\n' +
      '周方向 ' + deg.toFixed(1) + '°（' + (deg / 360 * 2 * Math.PI * COL.R / 1000).toFixed(2) + ' km）\n' +
      '軸方向 ' + (c.z / 1000).toFixed(2) + ' km / 30 km\n' +
      '標高　 ' + c.h.toFixed(Math.abs(c.h) < 100 ? 1 : 0) + ' m（地面から ' + Math.max(0, c.h - COL.groundH(c.theta, c.z)).toFixed(0) + ' m）\n' +
      '重力　 ' + (COL.gravityAt(c.r) / COL.G).toFixed(2) + ' G\n' +
      '速度　 ' + sp.toFixed(0) + ' km/h\n' +
      '時刻　 ' + ('0' + Math.floor(COL.clock)).slice(-2) + ':' + ('0' + Math.floor(COL.clock % 1 * 60)).slice(-2) + '\n' +
      '描画　 ' + COL.qualityName() + '（V）　解像度 ' + (resMode === 0 ? '自動 ' : '') + Math.round(resScale * 100) + '%（R）\n' +
      '負荷　 ' + (renderer.info.render.triangles / 1e6).toFixed(2) + ' 百万三角形・' + renderer.info.render.calls + ' 回\n' +
      'モード ' + (COL.vehicleSpeedNote() || (player.fly ? '飛行' : player.swim ? '水泳' : '徒歩')) + (sprint ? '（高速）' : '') + '　' + fps.toFixed(0) + ' fps';
  }

  const _look = new THREE.Vector3();
  function updateCamera() {
    const e = COL.eyePos(player), d = COL.lookDir(player);
    camera.position.set(e[0], e[1], e[2]);
    // 高く飛ぶほど手前の描画限界を遠ざけて、遠景の奥行きの精度をかせぐ
    const ce = COL.toCyl(e), near = COL.onTrain ? 0.15 : Math.min(12, 0.35 + 0.03 * Math.max(0, ce.h - COL.groundH(ce.theta, ce.z)));
    if (Math.abs(near - camera.near) > 0.02) { camera.near = near; camera.updateProjectionMatrix(); }
    camera.up.set(player.up[0], player.up[1], player.up[2]);
    camera.lookAt(_look.set(e[0] + d[0], e[1] + d[1], e[2] + d[2]));
  }

  let last = performance.now();
  function frame(now) {
    autoRes((now - last) / 1000);
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    const inp = readInput();
    if (COL.ride) COL.rideStep(player, inp, dt);
    else if (COL.driving) COL.driveStep(player, inp, dt);
    else if (COL.onTrain) COL.trainStep(player, inp, dt);
    else COL.stepPlayer(player, inp, dt);
    // E キーは、車 → モノレール → エレベーターの順で、当てはまる物に使う
    const vh = COL.updateVehicles(dt, player, usePressed, callPressed, player.pos);
    const busy = COL.driving || COL.onTrain;
    const pt = COL.updatePort(dt, player, usePressed && !vh.used && !busy);
    $('prompt').textContent = vh.text || (busy ? '' : pt) || '';
    usePressed = callPressed = false;
    const eye = COL.toCyl(COL.eyePos(player)), wat = COL.waterAt(eye.theta, eye.z);
    COL.underwater = !!wat && eye.h < wat.level;
    COL.underwaterSea = COL.underwater && wat.kind === '海';
    COL.updateEnv(dt, keys.KeyT ? 90 : 1);                // T を押している間は時刻を早送り
    updateCamera();
    COL.updateLife(dt, player);
    COL.updateWhales(dt, player, camera, renderer);
    COL.updateSound(dt, player);
    COL.updateCity(dt, scene, camera);
    renderer.render(scene, camera);
    if (shotQueued) {                                     // 描いた直後でないと画像を取り出せない
      shotQueued = false;
      renderer.domElement.toBlob(function (blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'colony-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      });
    }
    updateHud(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
