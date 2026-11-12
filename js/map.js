// 全体マップ（M キー）: コロニーを周方向に開いた地図。クリックした場所へ移動できる
//  横 = 軸方向（左が宇宙港、右がガラスの端）、縦 = 周方向（陸地A → 窓A → 陸地B → 窓B → 陸地C → 窓C）
(function () {
  'use strict';
  const COL = window.COL, R = COL.R, L = COL.L, TAU = Math.PI * 2, CIRC = TAU * R;
  const ZCOL = {
    downtown: '#8e9299', commercial: '#a39f93', residential: '#8fb573', harbor: '#9d9a8c', suburb: '#93bd76',
    industry: '#8c8b86', warehouse: '#96918a', park: '#5fae4e', forest: '#2f6b34', meadow: '#74b455',
    mountain: '#7d8f68', resort: '#86c27a', beach: '#e6d9a8', water: '#3f79c4', farm: '#b9b560',
  };
  let cv = null, ctx = null, base = null, open = false, box = null, playerRef = null, hover = null;
  COL.mapOpen = function () { return open; };

  // 下絵（ゾーンの色分け）は最初に開いたときに一度だけ作る。1マス 100m
  function makeBase() {
    base = document.createElement('canvas');
    base.width = 300; base.height = Math.round(CIRC / 100);
    const g = base.getContext('2d');
    g.fillStyle = '#0b1020'; g.fillRect(0, 0, base.width, base.height);
    for (let i = 0; i < 3; i++) for (let a = 0; a < 34; a++) for (let zi = 18; zi < 300; zi++) {
      const u = -COL.LAND_HW + (a + 0.5) * 100, z = zi * 100 + 50;
      if (Math.abs(u) > COL.LAND_HW) continue;
      g.fillStyle = ZCOL[COL.zoneOf(i, u, z)] || '#888';
      g.fillRect(zi, Math.round((i * 2 * COL.STRIP * R + (a) * 100) / 100), 1, 1);
    }
    // 宇宙港側の山
    g.fillStyle = '#7b7f78';
    for (let i = 0; i < 3; i++) g.fillRect(0, Math.round(i * 2 * COL.STRIP * R / 100), 18, 34);
  }
  function layout() {
    const W = window.innerWidth, H = window.innerHeight, sc = Math.min(W * 0.92 / L, H * 0.80 / CIRC);
    box = { x: (W - L * sc) / 2, y: (H - CIRC * sc) / 2 + 10, w: L * sc, h: CIRC * sc, sc: sc };
    cv.width = W; cv.height = H;
  }
  const toXY = function (theta, z) {
    const arc = ((theta - COL.THETA0) % TAU + TAU) % TAU * R;
    return [box.x + z * box.sc, box.y + arc * box.sc];
  };
  function draw() {
    if (!open) return;
    const rl = COL.rail(), p = playerRef;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(6, 12, 24, 0.82)'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, box.x, box.y, box.w, box.h);
    ctx.strokeStyle = '#5a6a86'; ctx.lineWidth = 1; ctx.strokeRect(box.x, box.y, box.w, box.h);
    // モノレール
    ctx.strokeStyle = '#19d98a'; ctx.lineWidth = 2; ctx.beginPath();
    let px = null;
    for (let k = 0; k <= rl.N; k += 8) {
      const a = rl.at(k * rl.ds), xy = toXY(COL.THETA0 + a.x / R, a.z);
      if (px === null || Math.abs(xy[1] - px) > box.h / 2) ctx.moveTo(xy[0], xy[1]); else ctx.lineTo(xy[0], xy[1]);
      px = xy[1];
    }
    ctx.stroke();
    hover = null;
    rl.stations.forEach(function (st, j) {
      const a = rl.at(st.s), xy = toXY(COL.THETA0 + a.x / R, a.z);
      const near = mouse && Math.hypot(mouse[0] - xy[0], mouse[1] - xy[1]) < 9;
      if (near) hover = { j: j, xy: xy, name: st.name };
      ctx.fillStyle = near ? '#fff' : '#eafff5'; ctx.strokeStyle = '#0a7a4c'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], near ? 6 : 4, 0, TAU); ctx.fill(); ctx.stroke();
    });
    // エレベーターの駅
    ctx.fillStyle = '#39c8ff';
    for (let i = 0; i < 3; i++) { const xy = toXY(COL.landCenter(i), 2050); ctx.fillRect(xy[0] - 4, xy[1] - 4, 8, 8); }
    // 文字
    ctx.fillStyle = '#eef4fb'; ctx.font = '14px "Yu Gothic UI", Meiryo, sans-serif'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 3; i++) {
      const y = box.y + (i * 2 + 0.5) * COL.STRIP * R * box.sc;
      ctx.textAlign = 'right'; ctx.fillText(COL.LAND_NAMES[i], box.x - 8, y);
      ctx.fillStyle = '#7f8ba3'; ctx.fillText('窓' + 'ABC'[i], box.x - 8, y + COL.STRIP * R * box.sc); ctx.fillStyle = '#eef4fb';
    }
    ctx.textAlign = 'left'; ctx.fillText('← 宇宙港', box.x, box.y - 14);
    ctx.textAlign = 'right'; ctx.fillText('ガラスの端 →', box.x + box.w, box.y - 14);
    ctx.textAlign = 'center';
    ctx.fillText('クリックした場所へ移動（緑の丸 = モノレールの駅、水色の四角 = 宇宙港エレベーター）　M か Esc で閉じる', cv.width / 2, box.y + box.h + 22);
    // 現在地と向き
    const c = COL.toCyl(p.pos), xy = toXY(c.theta, Math.max(0, c.z)), f = COL.frameAt(c.theta);
    const ang = Math.atan2(COL.V.dot(p.fwd, f.east), COL.V.dot(p.fwd, f.north));
    ctx.save(); ctx.translate(xy[0], xy[1]); ctx.rotate(ang);
    ctx.fillStyle = '#ff4d3d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, 6); ctx.lineTo(-3, 0); ctx.lineTo(-7, -6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (hover) {
      ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(0,0,0,0.75)';
      const w = ctx.measureText(hover.name).width + 14;
      ctx.fillRect(hover.xy[0] - w / 2, hover.xy[1] - 30, w, 20);
      ctx.fillStyle = '#fff'; ctx.fillText(hover.name, hover.xy[0], hover.xy[1] - 20);
    }
  }
  let mouse = null;

  COL.initMap = function (player, onClose) {
    playerRef = player;
    cv = document.getElementById('map');
    ctx = cv.getContext('2d');
    cv.addEventListener('mousemove', function (e) { mouse = [e.clientX, e.clientY]; draw(); });
    cv.addEventListener('click', function (e) {
      const mx = e.clientX, my = e.clientY;
      if (mx < box.x || mx > box.x + box.w || my < box.y || my > box.y + box.h) return;
      const p = playerRef;
      if (hover) { COL.warpToStation(p, hover.j); COL.toggleMap(); onClose(); return; }
      const z = Math.max(COL.TERRAIN_Z0 + 20, Math.min(L - 20, (mx - box.x) / box.sc)), theta = COL.THETA0 + (my - box.y) / box.sc / R;
      // 乗り物からは降ろして、地面（水の上なら水面）へ
      COL.driving = false; COL.onTrain = null; COL.ride = null;
      const w = COL.waterAt(theta, z), np = COL.createPlayer(theta, z, Math.max(COL.groundH(theta, z), w ? w.level - 1.4 : -1e9) + 0.1);
      p.pos = np.pos; p.vel = [0, 0, 0]; p.up = np.up; p.fwd = np.fwd; p.pitch = 0; p.fly = false;
      if (COL.pushOut) {                              // 建物の中に出てしまったら屋上へ
        const top = COL.solidTop(theta, z, 1e6);
        if (top > -1e8) { const q = COL.toWorld(theta, z, top + 0.1); p.pos = q; }
      }
      COL.stepPlayer(p, {}, 0);
      COL.toggleMap(); onClose();
    });
    window.addEventListener('resize', function () { if (open) { layout(); draw(); } });
  };
  COL.toggleMap = function () {
    open = !open;
    cv.style.display = open ? 'block' : 'none';
    if (open) { if (!base) makeBase(); layout(); mouse = null; draw(); }
    return open;
  };
})();
