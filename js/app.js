// 起動・入力・メインループ
//  タイトル画面を先に表示してから、重い準備を始める（準備中もボタンが反応するように）
function appMain() {
  'use strict';
  const COL = window.COL, V = COL.V, BOOT = window.COL_BOOT;
  const $ = function (id) { return document.getElementById(id); };

  const q = new URLSearchParams(location.search);
  // GPU の名前（画質の自動選択と、画質設定の画面に出す）。WebGL が使えなければここで止める
  const GPU = (function () {
    try {
      const c = document.createElement('canvas'), gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const n = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return n;
    } catch (e) { return null; }
  })();
  if (GPU === null) throw new Error('WebGL（3D 描画）が使えません。ブラウザの設定で「ハードウェアアクセラレーション（グラフィック アクセラレーション）」を有効にしてください。');
  function detectQuality() {
    if (/SwiftShader|llvmpipe|softpipe|Basic Render|Software/i.test(GPU)) return 0;     // GPU を使えていない
    if (/NVIDIA|GeForce|Radeon RX|Radeon Pro|Arc\(?TM\)? [AB]\d/i.test(GPU)) return 3;
    if (/Intel/i.test(GPU) && /HD Graphics|UHD Graphics 6\d\d|Iris.*(5\d\d|6[0-3]\d)|Mesa (DRI )?Intel/i.test(GPU)) return 1;   // 古い内蔵 GPU
    return 2;
  }
  let savedMode = 'auto';
  try { savedMode = localStorage.getItem('colQualityMode') || 'auto'; } catch (e) {}
  if (!/^(auto|[0-4])$/.test(savedMode)) savedMode = 'auto';
  // 軽い画質（最軽量・低）では、縁のギザギザを消す処理（アンチエイリアス）を使わない。これは作るときにしか決められない
  const resolveMode = function (m) { return m === 'auto' ? detectQuality() : parseInt(m, 10); };
  const AA = q.get('q') ? parseInt(q.get('q'), 10) >= 2 : resolveMode(savedMode) >= 2;

  // 奥行きの対数バッファは「隠れた画素も全部計算する」原因になるので使わない（?logz=1 で元に戻せる）
  const renderer = new THREE.WebGLRenderer({ antialias: AA, logarithmicDepthBuffer: q.get('logz') === '1', powerPreference: 'high-performance' });
  const baseDpr = AA ? Math.min(window.devicePixelRatio || 1, 2) : 1;
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
  // お金と持ち物。セーブデータはタイトル画面で選ぶ（それまでは何も持っていない状態で作っておく）
  //  確認用: ?money=金額 &own=1 &lamps=0|1（?auto=1 のときはセーブデータを使わず、保存もしない）
  COL.loadSave();
  if (q.get('money') !== null) COL.save.money = parseFloat(q.get('money')) || 0;
  if (q.get('own') === '1') COL.save.owned = true;
  if (q.get('lamps') !== null) for (let k = 0; k < COL.save.lamps.length; k++) COL.save.lamps[k] = q.get('lamps') === '1' ? 1 : 0;
  COL.buildSpace(scene);
  COL.buildMansion(scene);
  COL.buildHotel(scene);

  // ---- 画質の設定（タイトル画面で選ぶ。localStorage に覚える） ----
  let qAuto = true;
  const QNOTE = {
    auto: 'パソコンに合わせて選び、重いときは自動で軽くします。',
    0: '遠くを描かず、影・窓の中・水中の光の網目を切り、人や車を大きく減らし、クジラ・鳥・魚を出しません。解像度も下げます。',
    1: '描く距離を短くし、影を切り、人や車を半分にします。',
    2: '標準の画質です。',
    3: '遠くまで描き、影も広く出します。',
    4: '高性能なパソコン向け。砂・芝・壁の細かな凹凸、ガラスや車体・濡れた砂への映り込み、波打ち際の泡、物の隅の陰り、光のにじみを加えます。',
  };
  function chooseQuality(mode) {
    qAuto = mode === 'auto';
    try { localStorage.setItem('colQualityMode', String(mode)); } catch (e) {}
    COL.setQuality(resolveMode(String(mode)));
    refreshQButtons();
  }
  function refreshQButtons() {
    const cur = qAuto ? 'auto' : String(COL.getQuality());
    const bs = document.querySelectorAll('#qpanel [data-q]');
    for (let k = 0; k < bs.length; k++) bs[k].classList.toggle('sel', bs[k].getAttribute('data-q') === cur);
    $('qnote').textContent = QNOTE[cur] + '\n（このパソコンの GPU: ' + GPU + '）';
  }
  const qbs = document.querySelectorAll('#qpanel [data-q]');
  for (let k = 0; k < qbs.length; k++) {
    const b = qbs[k];
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      const m = b.getAttribute('data-q');
      // アンチエイリアスの有無が変わるときは、作り直すためにページを読み込み直す
      if ((resolveMode(m) >= 2) !== AA) {
        try { localStorage.setItem('colQualityMode', m); } catch (err) {}
        $('qnote').textContent = '画質を切り替えています…';
        setTimeout(function () { location.reload(); }, 50);
        return;
      }
      chooseQuality(m);
    });
  }
  // 遊び方のモード: 開発者モード（キーで移動・高速飛行ができる）／ 普通にプレイ（歩く・車・乗り物だけ）
  //  確認用: ?auto=1 のときは開発者モード。?mode=normal で普通にプレイ
  function setMode(dev) {
    COL.devMode = dev;
    document.body.classList.toggle('dev', dev);
    if (!dev) player.fly = COL.inHubZone(player.pos);
  }
  // 選んだセーブデータを世界に反映する: モード・豪邸・最後にいた場所・時刻
  function applySave() {
    const s = COL.save;
    setMode(!!s.dev);
    COL.syncMansion();
    COL.clock = s.clock;
    if (s.pos) {
      const c = COL.toCyl(s.pos.p);
      player.pos = s.pos.p.slice(); player.vel = [0, 0, 0]; player.up = COL.frameAt(c.theta).up;
      player.fwd = s.pos.f.slice(); player.pitch = s.pos.pitch;
      player.fly = COL.devMode ? s.pos.fly : COL.inHubZone(player.pos);
      COL.stepPlayer(player, {}, 0);
    }
  }
  // 今いる場所を覚える（乗り物・採掘船に乗っている間は、乗る前の場所のまま）
  function recordPos() {
    if (!COL.saveId) return;
    COL.save.clock = COL.clock;
    if (COL.pilot || COL.ride || COL.driving || COL.onTrain || COL.isFading()) return;
    COL.save.pos = { p: player.pos.slice(), f: player.fwd.slice(), pitch: player.pitch, fly: !!player.fly };
  }
  // 保存のしかた: お金・家・明かりが変わったときは、その場で自動で保存する（場所と時刻は書き換えない）。
  //  場所と時刻も含めた全部は、一時停止の画面の「上書き保存」で保存する
  const two = function (n) { return ('0' + n).slice(-2); };
  function showSaved() {
    const t = COL.save.updated ? new Date(COL.save.updated) : null;
    $('saveNote').textContent = !COL.saveId ? '（確認用の起動なので保存しません）'
      : '「' + COL.save.name + '」のセーブデータ　最後の保存 ' + (t ? (t.getMonth() + 1) + '/' + t.getDate() + ' ' + two(t.getHours()) + ':' + two(t.getMinutes()) : '—');
  }
  function manualSave() {
    if (!COL.saveId) return false;
    recordPos();
    const ok = COL.storeSave();
    showSaved();
    COL.toast(ok ? '上書き保存しました' : '保存できませんでした（ブラウザの保存領域がいっぱいかもしれません）', 3);
    return ok;
  }
  BOOT.start = function () {
    applySave();
    BOOT.titleOn = false;
    $('title').style.display = 'none';
    COL.initSound(); renderer.domElement.requestPointerLock();
  };
  // 最軽量: 描く距離の先は霧で隠し、カメラもそこまでしか描かない
  COL.onQuality = function (Q) {
    reapplyRes();
    const far = Q.far ? Q.far * 1.15 : 60000;
    if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
  };

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
  // 確認用: ?pilot=1&sx=&sy=&sz=&syaw=&spitch=&rare=1&cargo=数 / ?home=1
  if (q.get('pilot') === '1') COL.debugPilot(player, { pos: q.get('sz') !== null ? [num('sx', 0), num('sy', 0), num('sz', -2000)] : null, yaw: num('syaw', 0) * rad, pitch: num('spitch', 0) * rad, rare: q.get('rare') === '1', cargo: num('cargo', 0) });
  if (q.get('home') === '1') COL.goHome(player);
  if (q.get('hotel') === '1') COL.goHotel(player);              // 確認用: ホテルの部屋から始める
  if (q.get('whale') === '1') COL.debugWhale(player, num('wt', 0), num('wd', 40), num('wh', 3), num('ws', 0) * rad);

  // ---- 入力 ----
  const keys = {};
  let mouseX = 0, mouseY = 0, jumpQueued = false, usePressed = false, callPressed = false, skipPressed = false, uiHidden = false, shotQueued = false;
  // 二回押し: W を素早く2回 → 2回目を押している間ずっと高速。Space を素早く2回 → 飛行と徒歩の切り替え
  const DOUBLE_TAP = 0.3;
  let lastW = -9, lastSpace = -9, sprint = false;
  const locked = function () { return document.pointerLockElement === renderer.domElement; };
  window.addEventListener('keydown', function (e) {
    if (BOOT.titleOn || (e.target && e.target.tagName === 'INPUT')) return;      // タイトル画面で名前を打っている間など
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    const t = performance.now() / 1000;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') {
      if (t - lastW < DOUBLE_TAP) sprint = true;
      lastW = t;
    }
    if (e.code === 'Space') {
      if (t - lastSpace < DOUBLE_TAP && !COL.pilot && COL.devMode) { player.fly = !player.fly; lastSpace = -9; }
      else { jumpQueued = true; lastSpace = t; }
    }
    if (e.code === 'KeyF' && !COL.pilot && COL.devMode) { player.fly = !player.fly; }
    if (e.code === 'KeyV') { qAuto = false; COL.cycleQuality(); try { localStorage.setItem('colQualityMode', String(COL.getQuality())); } catch (err) {} }
    if (e.code === 'KeyR') { resMode = (resMode + 1) % RES_MODES.length; applyRes(RES_MODES[resMode] || 1); resCeil = 1; }
    // 数字キーで見どころへ移動
    if (e.code === 'KeyE') usePressed = true;
    if (e.code === 'KeyC' && !COL.pilot) callPressed = true;
    if (e.code === 'KeyQ') skipPressed = true;                // 時間を飛ばす（モノレール・ベッド）
    if (COL.pilot && /^Digit\d$/.test(e.code)) return;       // 操縦中は場所の移動をしない
    // H: 自宅へ。普通にプレイでは豪邸を買ってから
    if (e.code === 'KeyH' && !COL.pilot && !COL.isFading()) {
      if (COL.devMode || COL.save.owned) { COL.ride = null; COL.driving = false; COL.onTrain = null; COL.goHome(player); }
      else COL.toast('H キーで帰れるのは、豪邸を買ってからです\n売地は M の地図の黄色い家のところです', 4);
    }
    COL.initSound();
    if (e.code === 'KeyN') COL.toggleMute();
    // 撮影: P で画面の文字を消す／戻す、K で今の画面を画像として保存
    if (e.code === 'KeyP') { uiHidden = !uiHidden; document.body.classList.toggle('photo', uiHidden); }
    if (e.code === 'KeyK') shotQueued = true;
    if (e.code === 'KeyM' || (e.code === 'Escape' && COL.mapOpen())) {
      if (COL.toggleMap()) document.exitPointerLock(); else renderer.domElement.requestPointerLock();
    }
    if (!COL.devMode) return;                                 // ここから下は開発者モードだけ（キーで移動）
    // 8: 一番近い駅のホームへ、9: 次の駅へ、0: 前の駅へ
    if (e.code === 'Digit8') COL.stationWarp(player, 'near');
    if (e.code === 'Digit9') COL.stationWarp(player, 1);
    if (e.code === 'Digit0') COL.stationWarp(player, -1);
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
  $('start').style.display = 'none';
  // 一時停止の画面から: 上書き保存 ／ タイトルへ（別のプレイヤーに替わるとき）
  $('saveBtn').addEventListener('click', function (e) { e.stopPropagation(); manualSave(); });
  $('toTitle').addEventListener('click', function (e) {
    e.stopPropagation();
    if (COL.saveId && !confirm('タイトルにもどります。\n上書き保存していない「今いる場所と時刻」は元に戻ります（お金・家・明かりは保存済みです）。')) return;
    location.href = location.pathname;
  });
  $('start').addEventListener('click', function () { COL.initSound(); renderer.domElement.requestPointerLock(); });
  renderer.domElement.addEventListener('click', function () { if (!locked()) renderer.domElement.requestPointerLock(); });
  document.addEventListener('pointerlockchange', function () {
    $('start').style.display = (locked() || COL.mapOpen() || $('title').style.display !== 'none') ? 'none' : '';
    if ($('start').style.display === '') showSaved();
  });
  setMode(q.get('mode') !== 'normal');
  if (q.get('auto') === '1') { $('start').style.display = 'none'; $('title').style.display = 'none'; BOOT.titleOn = false; }

  // ---- 解像度の自動調整: fps が足りないときは描く画素数を減らす（R キーで 自動 / 100% / 75% / 50%） ----
  const RES_MODES = [0, 1, 0.75, 0.5];           // 0 = 自動
  let resMode = q.get('auto') === '1' ? 1 : 0, resScale = 1, resCeil = 1, resHold = 0, accT = 0, accN = 0;
  function reapplyRes() {                        // 画質の上限が変わったとき
    const cur = resMode === 0 ? Math.max(resScale, 0.5) : RES_MODES[resMode];
    resScale = -1; resCeil = 1; applyRes(cur);
  }
  function applyRes(sc) {
    sc = Math.min(sc, COL.resCap || 1);
    if (sc === resScale) return;
    resScale = sc;
    renderer.setPixelRatio(baseDpr * resScale);
  }
  let lowStreak = 0;
  function autoRes(rawDt) {
    if (rawDt > 0.5 || !locked()) { accT = accN = 0; return; }
    accT += rawDt; accN++;
    if (accT < 1) return;
    const f = accN / accT;
    accT = accN = 0;
    // 画質が「自動」で、解像度を下げ切っても 30fps に届かない状態が続くなら、画質をひとつ軽くする
    if (qAuto && f < 30 && (resMode !== 0 || resScale <= 0.62 * (COL.resCap || 1) + 0.02) && COL.getQuality() > 0) {
      if (++lowStreak >= 4) { lowStreak = 0; COL.setQuality(COL.getQuality() - 1); }
    } else lowStreak = 0;
    if (resMode !== 0) return;
    resHold--;
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

  chooseQuality(savedMode);

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
      (COL.saveId ? 'プレイヤー ' + COL.save.name + '\n' : '') +
      '所持金 ' + COL.fmtCr(COL.save.money) + (COL.save.owned ? '　（' + COL.save.day + ' 日目）' : '') + '\n' +
      '場所　 ' + (c.z < -COL.DOCK_LEN || c.r > COL.R + 80 ? '宇宙' : c.z < 0 ? '宇宙港ドック' : st.name + (st.land ? '・' + COL.placeName(c.theta, c.z) : '')) + (COL.ride ? '（エレベーター）' : '') + '\n' +
      '周方向 ' + deg.toFixed(1) + '°（' + (deg / 360 * 2 * Math.PI * COL.R / 1000).toFixed(2) + ' km）\n' +
      '軸方向 ' + (c.z / 1000).toFixed(2) + ' km / 30 km\n' +
      '標高　 ' + c.h.toFixed(Math.abs(c.h) < 100 ? 1 : 0) + ' m（地面から ' + Math.max(0, c.h - COL.groundH(c.theta, c.z)).toFixed(0) + ' m）\n' +
      '重力　 ' + (COL.gravityAt(c.r) / COL.G).toFixed(2) + ' G\n' +
      '速度　 ' + sp.toFixed(0) + ' km/h\n' +
      '時刻　 ' + ('0' + Math.floor(COL.clock)).slice(-2) + ':' + ('0' + Math.floor(COL.clock % 1 * 60)).slice(-2) + '\n' +
      '描画　 ' + COL.qualityName() + (qAuto ? '（自動）' : '') + '（V）　解像度 ' + (resMode === 0 ? '自動 ' : '') + Math.round(resScale * 100) + '%（R）\n' +
      '負荷　 ' + (renderer.info.render.triangles / 1e6).toFixed(2) + ' 百万三角形・' + renderer.info.render.calls + ' 回\n' +
      (COL.devMode ? '［開発者］' : '') + 'モード ' + (COL.vehicleNoteSpace() || COL.vehicleSpeedNote() || (player.fly ? '飛行' : player.swim ? '水泳' : '徒歩')) + (sprint ? '（高速）' : '') + '　' + fps.toFixed(0) + ' fps';
  }

  const _look = new THREE.Vector3();
  function updateCamera() {
    if (COL.pilot) { COL.pilotCamera(camera); return; }
    const e = COL.eyePos(player), d = COL.lookDir(player);
    camera.position.set(e[0], e[1], e[2]);
    // 高く飛ぶほど手前の描画限界を遠ざけて、遠景の奥行きの精度をかせぐ
    //  （足もとの高さは、地面か、屋上・ホテルの部屋の床など乗れる面の高い方から測る）
    const ce = COL.toCyl(e), floor = Math.max(COL.groundH(ce.theta, ce.z), COL.solidTop ? COL.solidTop(ce.theta, ce.z, ce.h) : -1e9);
    const near = COL.onTrain ? 0.15 : Math.min(12, 0.35 + 0.03 * Math.max(0, ce.h - floor));
    if (Math.abs(near - camera.near) > 0.02) { camera.near = near; camera.updateProjectionMatrix(); }
    camera.up.set(player.up[0], player.up[1], player.up[2]);
    camera.lookAt(_look.set(e[0] + d[0], e[1] + d[1], e[2] + d[2]));
  }

  let last = performance.now();
  let benchN = 0, benchT = 0;
  function frame(now) {
    if (BOOT.titleOn) { last = now; requestAnimationFrame(frame); return; }
    if (q.get('bench')) {                                 // 確認用: 1フレームの実時間を測る（?bench=1）
      if (++benchN === 1) {
        for (let k = 0; k < 4; k++) { COL.updateCity(0.2, scene, camera); COL.updateLife(0.05, player); COL.updateWhales(0.05, player, camera, renderer); }
        const gl = renderer.getContext(), px = new Uint8Array(4);
        benchT = performance.now();
        for (let k = 0; k < 8; k++) { renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;right:10px;top:10px;background:#000;color:#ff0;font:20px monospace;padding:6px;z-index:99';
        d.textContent = 'BENCH ' + ((performance.now() - benchT) / 8).toFixed(1) + ' ms/frame ' + renderer.info.render.calls + ' calls ' + (renderer.info.render.triangles / 1e6).toFixed(2) + ' Mtri';
        document.body.appendChild(d); console.log(d.textContent);
        if (q.get('bench') === '2') {                     // 部品ごとの重さ（その部品だけを描いた時間）
          const kids = scene.children.filter(function (c) { return c.visible; }), vis = kids.map(function () { return true; }), res = [];
          kids.forEach(function (c) { c.visible = false; });
          const t0 = performance.now(); for (let k = 0; k < 3; k++) { renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
          const base = (performance.now() - t0) / 3;
          kids.forEach(function (c, i) {
            c.visible = true;
            const t1 = performance.now(); for (let k = 0; k < 3; k++) { renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
            res.push([(performance.now() - t1) / 3 - base, i, c.type, c.name || '', c.children.length, renderer.info.render.triangles]);
            c.visible = false;
          });
          kids.forEach(function (c, i) { c.visible = vis[i]; });
          res.sort(function (a, b) { return b[0] - a[0]; });
          console.log('BENCHPARTS base ' + base.toFixed(1) + ' | ' + res.slice(0, 14).map(function (r) { return r[0].toFixed(1) + 'ms #' + r[1] + ' ' + r[2] + ' ch' + r[4] + ' tri' + r[5]; }).join(' | '));
        }
      }
    }
    autoRes((now - last) / 1000);
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    const inp = readInput();
    if (COL.pilot) COL.pilotStep(player, inp, dt);
    else if (COL.ride) COL.rideStep(player, inp, dt);
    else if (COL.driving) COL.driveStep(player, inp, dt);
    else if (COL.onTrain) COL.trainStep(player, inp, dt);
    else if (COL.devMode) COL.stepPlayer(player, inp, dt);
    else {
      // 普通にプレイ: 飛べない。ただし宇宙港の無重力の区域では漂って動け、そこから外へは出られない
      const zin = COL.inHubZone(player.pos), old = player.pos.slice();
      player.fly = zin;
      COL.stepPlayer(player, inp, dt);
      if (zin && !COL.inHubZone(player.pos)) { player.pos = old; player.vel = [0, 0, 0]; }
    }
    // E キーは、車 → モノレール → エレベーターの順で、当てはまる物に使う
    const vh = COL.updateVehicles(dt, player, usePressed, callPressed, player.pos, skipPressed);
    const busy = COL.driving || COL.onTrain;
    const pt = COL.updatePort(dt, player, usePressed && !vh.used && !busy);
    // 続いて採掘船、豪邸（看板・スイッチ・ベッド）
    const sp = COL.updateSpace(dt, player, usePressed && !vh.used && !busy && !pt, camera);
    const free = !vh.used && !busy && !pt && !sp.used && !sp.text;
    const ht = COL.updateHotel(dt, player, usePressed && free, skipPressed && free);
    const mn = COL.updateMansion(dt, player, usePressed && free && !ht.used, skipPressed && free && !ht.used);
    COL.updateToast(dt);
    $('prompt').textContent = vh.text || (busy ? '' : pt) || sp.text || ht.text || mn.text || '';
    usePressed = callPressed = skipPressed = false;
    const eye = COL.toCyl(COL.eyePos(player)), wat = COL.waterAt(eye.theta, eye.z);
    COL.underwater = !!wat && eye.h < wat.level;
    COL.underwaterSea = COL.underwater && wat.kind === '海';
    const clock0 = COL.clock;
    COL.updateEnv(dt, keys.KeyT ? 90 : 1);                // T を押している間は時刻を早送り
    if (COL.clock < clock0) { COL.save.day++; COL.storeSave(); }     // 0時をまたいだら日付を進める
    updateCamera();
    COL.updateLife(dt, player);
    COL.updateWhales(dt, player, camera, renderer);
    COL.updateSound(dt, player);
    COL.updateCity(dt, scene, camera);
    // 最高画質は、画面全体の仕上げ（js/post.js）を通して描く
    if (COL.postOn && COL.renderPost) COL.renderPost(renderer, scene, camera);
    else { renderer.info.autoReset = true; renderer.render(scene, camera); }
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
  // 準備の終わり: シェーダーを先に作っておく（始めた直後に固まらないように）
  updateCamera();
  try { renderer.compile(scene, camera); } catch (e) {}
  BOOT.ready = true;
  if (!BOOT.errors.length) $('tstat').textContent = '準備ができました';
  requestAnimationFrame(frame);
}
setTimeout(function () {
  try { appMain(); } catch (e) { window.COL_BOOT.fail(e && e.message ? e.message : e); }
}, 30);
