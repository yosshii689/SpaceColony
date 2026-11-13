// 乗り物: 召喚式の車と、環状モノレール（桁・橋脚・駅・列車、乗り降り）
(function () {
  'use strict';
  const COL = window.COL, V = COL.V, R = COL.R, TAU = Math.PI * 2;
  const WHITE = [0.92, 0.93, 0.94], GREY = [0.55, 0.57, 0.60], DARK = [0.16, 0.17, 0.20], LINE = [0.20, 0.85, 0.55];
  let Kit = null, clock = 0;

  // ================= 車 =================
  let car = null, carGrp = null, lookYaw = 0, carMsg = '', carMsgT = 0;
  COL.driving = false;

  function buildCar(scene) {
    const b = new Kit.Bag(), P = Kit.localPart, body = [0.80, 0.12, 0.10];
    P(b, 'box', 0, 0.32, 0, 1.9, 0.55, 4.5, body, 3);                         // 車体
    P(b, 'taper', 0, 0.87, -0.35, 1.8, 0.58, 2.6, [0.10, 0.13, 0.18], 0);     // 屋根まわり（ガラス）
    P(b, 'box', 0, 1.45, -0.35, 1.05, 0.05, 1.5, body, 3);
    P(b, 'box', 0, 1.41, -0.35, 1.04, 0.03, 1.5, [0.30, 0.31, 0.33], 3);      // 天井の内張り
    P(b, 'box', 0, 0.86, 1.05, 1.5, 0.10, 0.55, DARK, 3);                     // ダッシュボード
    P(b, 'box', 0, 0.20, 0, 1.96, 0.14, 4.56, DARK, 3);
    for (let s = -1; s <= 1; s += 2) {
      for (let e = -1; e <= 1; e += 2) {
        // タイヤ（円柱を横に寝かせる）
        b.addM('cyl', Kit.m16([0, 0, -0.68], [0.28, 0, 0], [0, -0.68, 0], [s * 0.98 - 0.14, 0.34, e * 1.45]), [0.07, 0.07, 0.08], 3, 1);
      }
      P(b, 'box', s * 0.68, 0.58, 2.24, 0.36, 0.14, 0.06, [1.0, 0.97, 0.85], 5, 2.2);
      P(b, 'box', s * 0.70, 0.60, -2.24, 0.36, 0.12, 0.06, [1.0, 0.10, 0.08], 5, 1.2);
    }
    carGrp = new THREE.Group();
    b.build(carGrp, true);
    carGrp.matrixAutoUpdate = false;
    carGrp.visible = false;
    scene.add(carGrp);
  }
  // 車の見た目を置く。坂では前後の地面の高さに合わせて傾ける
  function placeCarMesh() {
    const c = car, th = Math.atan2(c.pos[1], c.pos[0]);
    const ahead = V.add(c.pos, V.mul(c.fwd, 1.5)), behind = V.sub(c.pos, V.mul(c.fwd, 1.5));
    const gA = COL.groundH(Math.atan2(ahead[1], ahead[0]), ahead[2]), gB = COL.groundH(Math.atan2(behind[1], behind[0]), behind[2]);
    const lc = COL.landCoord(th), slope = lc ? Math.max(-0.5, Math.min(0.5, (gA - gB) / 3)) : 0;
    const Z = V.norm(V.add(c.fwd, V.mul(c.up, slope))), X = V.norm(V.cross(c.up, Z)), Y = V.cross(Z, X);
    carGrp.matrix.set(X[0], Y[0], Z[0], c.pos[0], X[1], Y[1], Z[1], c.pos[1], X[2], Y[2], Z[2], c.pos[2], 0, 0, 0, 1);
    carGrp.matrixWorldNeedsUpdate = true;
  }
  // 車を目の前に呼ぶ
  function summon(p) {
    if (COL.driving || COL.ride || COL.onTrain) return;
    const c = COL.toCyl(p.pos);
    if (c.z < COL.TERRAIN_Z0 + 5 || c.h - COL.groundH(c.theta, c.z) > 3) { carMsg = '車は地上でしか呼べません'; carMsgT = 2.5; return; }
    const at = V.add(p.pos, V.mul(p.fwd, 6)), cc = COL.toCyl(at), w = COL.waterAt(cc.theta, cc.z);
    if (w) { carMsg = '水の上には車を呼べません'; carMsgT = 2.5; return; }
    const pos = COL.toWorld(cc.theta, cc.z, COL.groundH(cc.theta, cc.z));
    if (COL.pushOut) COL.pushOut(pos);
    car = COL.createCar(pos, p.fwd);
    carGrp.visible = true;
    placeCarMesh();
  }
  // 運転中の1ステップ。視点は運転席。マウスで見回せる
  COL.driveStep = function (p, inp, dt) {
    COL.stepCar(car, { throttle: inp.f, steer: inp.s, brake: inp.ud > 0 }, dt);
    lookYaw = Math.max(-2.6, Math.min(2.6, lookYaw + inp.yaw));
    if (Math.abs(car.speed) > 3 && !inp.yaw) lookYaw *= Math.max(0, 1 - dt * 1.2);     // 走っているあいだは少しずつ正面へ戻す
    const right = V.cross(car.fwd, car.up);
    p.up = car.up;
    p.fwd = V.norm(V.add(V.mul(car.fwd, Math.cos(lookYaw)), V.mul(right, Math.sin(lookYaw))));
    p.pitch = Math.max(-1.3, Math.min(1.3, p.pitch + inp.pitch));
    p.pos = V.add(V.add(car.pos, V.mul(car.up, 1.25 - COL.EYE)), V.add(V.mul(right, -0.36), V.mul(car.fwd, 0.30)));
    p.vel = V.mul(car.fwd, car.speed);
    p.fly = false; p.swim = false; p.grounded = true;
    placeCarMesh();
  };
  function leaveCar(p) {
    const right = V.cross(car.fwd, car.up), out = V.sub(car.pos, V.mul(right, 2.3)), c = COL.toCyl(out);
    p.pos = COL.toWorld(c.theta, c.z, Math.max(COL.groundH(c.theta, c.z), COL.R - Math.hypot(car.pos[0], car.pos[1])) + 0.05);
    p.vel = [0, 0, 0]; p.fwd = car.fwd.slice(); p.pitch = 0;
    car.speed = 0;
    COL.driving = false;
    COL.stepPlayer(p, {}, 0);
  }

  // ================= モノレール =================
  //  複線: 線路の中心から +TR に外回り専用、-TR に内回り専用の桁。駅は両側にホーム（外回りは + 側、内回りは - 側）
  //  座標: 路線に沿った距離 s、進行方向の右（Rw の向き）への距離 lat、桁の上面からの高さ
  let rl = null, pool = [];
  COL.onTrain = null;                // 乗車中: { rev, k, lx: 車内の横, ly: 床からの高さ, lz: 編成の中心からの前後, yaw: 電車に対する向き, vy }
  const TR = 2.4, CAR_HW = 1.45, FLOOR = 0.39, CEIL = 3.0, ROOF = 4.9;
  const PLAT_UP = FLOOR, PLAT_IN = TR + CAR_HW + 0.2, PLAT_OUT = PLAT_IN + 4.3, PLAT_HALF = 30, STAIR = PLAT_HALF - 6;
  const DOORS = [-4.0, 4.0];         // 1両の中でのドアの位置（車両の中心から）
  const trackLat = function (rev) { return rev ? -TR : TR; };
  const clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };

  // 桁: 幅 1m × 高さ 1.6m の箱断面を路線に沿って伸ばす（lat だけ横にずらす）
  function buildBeam(scene, lat) {
    const mat = COL.objectMaterial(0xa9aeb6), CH = 400;
    mat.side = THREE.DoubleSide;
    for (let k0 = 0; k0 < rl.N; k0 += CH) {
      const n = Math.min(CH, rl.N - k0), pos = [], nrm = [];
      let prev = null;
      for (let q = 0; q <= n; q++) {
        const w = rl.world((k0 + q) * rl.ds, lat, -0.8), ring = [];
        for (let e = 0; e < 4; e++) {
          const sx = (e === 0 || e === 3) ? -0.5 : 0.5, sy = e < 2 ? 0.8 : -0.8;          // 左上, 右上, 右下, 左下
          ring.push(V.add(w.pos, V.add(V.mul(w.Rw, sx), V.mul(w.up, sy))));
        }
        const N4 = [w.up, w.Rw, V.mul(w.up, -1), V.mul(w.Rw, -1)];
        if (prev) for (let e = 0; e < 4; e++) {
          const a = prev[e], b = prev[(e + 1) % 4], c = ring[e], d = ring[(e + 1) % 4], nn = N4[e];
          [a, c, b, b, c, d].forEach(function (v) { pos.push(v[0], v[1], v[2]); nrm.push(nn[0], nn[1], nn[2]); });
        }
        prev = ring;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);
      trackParts.push({ obj: mesh, c: geo.boundingSphere.center.toArray(), r: geo.boundingSphere.radius });
    }
  }
  // 路線の部品は区間ごとに分けてある。最軽量では、描く距離より遠い区間を描かない
  const trackParts = [];
  function updateTrackLod(p) {
    const far = COL.drawFar;
    for (let k = 0; k < trackParts.length; k++) {
      const t = trackParts[k];
      t.obj.visible = !far || Math.hypot(p[0] - t.c[0], p[1] - t.c[1], p[2] - t.c[2]) - t.r < far;
    }
  }
  // 路線に沿った向きで箱などを置く。X=進行方向の右（Rw）, Y=上, Z=進行方向
  function alongTrack(bag, kind, s, lat, up, sx, sy, sz, col, style, seed, glow, gi) {
    const w = rl.world(s, lat, up);
    bag.addM(kind, Kit.m16(V.mul(w.Rw, sx), V.mul(w.up, sy), V.mul(w.T, sz), w.pos), col, style, seed, glow, gi);
  }
  // 駅の当たり判定を、路線の向きに合わせて置く（lat: 横, al: 前後の範囲、高さは桁の上面から）
  function stationSolid(st, latLo, latHi, alLo, alHi, yLo, yHi) {
    const a = rl.at(st.s), lc = COL.landCoord(COL.THETA0 + a.x / R);
    if (!lc) return;
    let u0 = 1e9, u1 = -1e9, z0 = 1e9, z1 = -1e9;
    [[latLo, alLo], [latHi, alLo], [latLo, alHi], [latHi, alHi]].forEach(function (q) {
      const u = lc.u + a.tz * q[0] + a.tx * q[1], z = a.z - a.tx * q[0] + a.tz * q[1];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    });
    Kit.addSolid(lc.index, u0, u1, z0, z1, a.h + yLo, a.h + yHi);
  }
  const PALE = [0.86, 0.87, 0.88], GLASSC = [0.60, 0.70, 0.76], FLOORC = [0.74, 0.74, 0.72];
  function buildTrackParts(scene) {
    // 区間（3km）ごとに分けて作る（画面の外や遠くの区間を描かずに済む）
    const SEG = 3000, bags = [];
    const bagAt = function (s) { const k = Math.floor(s / SEG); return bags[k] || (bags[k] = new Kit.Bag()); };
    // 橋脚: 50m ごとに1本柱と、2本の桁を支える横梁
    for (let k = 0; k < rl.N; k += 5) {
      const s = k * rl.ds, a = rl.at(s), th = COL.THETA0 + a.x / R, w = COL.waterAt(th, a.z), bag = bagAt(s);
      const g = (w ? COL.groundH(th, a.z) : a.g) - 1, top = a.h - 2.5;
      if (top - g < 2) continue;
      alongTrack(bag, 'box', s, 0, g - a.h, 1.6, top - g, 1.6, [0.66, 0.67, 0.69], 3, 1);
      alongTrack(bag, 'box', s, 0, -2.5, 2 * TR + 1.6, 0.9, 1.8, [0.60, 0.61, 0.63], 3, 1);
    }
    // 駅
    rl.stations.forEach(function (st) {
      const s = st.s, a = rl.at(s), drop = a.g - a.h, L = PLAT_HALF * 2, bag = bagAt(s);
      for (let sd = -1; sd <= 1; sd += 2) {
        const mid = sd * (PLAT_IN + PLAT_OUT) / 2, W = PLAT_OUT - PLAT_IN;
        // ホームの床と、その下の柱
        alongTrack(bag, 'box', s, mid, -0.45, W, PLAT_UP + 0.45, L, FLOORC, 3, 2);
        alongTrack(bag, 'box', s, sd * (PLAT_IN + 0.75), PLAT_UP - 0.03, 0.3, 0.08, L - 2, [0.95, 0.80, 0.15], 3, 2);   // 点字ブロック
        for (let q = -2; q <= 2; q += 2) alongTrack(bag, 'box', s + q * 13, mid, drop - 1, 1.3, -drop + 0.6, 1.3, [0.66, 0.67, 0.69], 3, 1);
        // ホームドア: 固定の柵と、電車のドアの位置の扉（ガラス）
        const doorAt = [];
        [-6.3, 6.3].forEach(function (c) { DOORS.forEach(function (dz) { doorAt.push(c + dz); }); });
        let prev = -PLAT_HALF;
        doorAt.concat([PLAT_HALF + 1.0]).forEach(function (dc) {
          const e0 = prev, e1 = Math.min(PLAT_HALF, dc - 1.0);
          if (e1 - e0 > 0.1) alongTrack(bag, 'box', s + (e0 + e1) / 2, sd * (PLAT_IN + 0.12), PLAT_UP, 0.24, 1.3, e1 - e0, PALE, 3, 3);
          if (dc < PLAT_HALF) {
            alongTrack(bag, 'box', s + dc, sd * (PLAT_IN + 0.12), PLAT_UP, 0.12, 1.25, 2.0, GLASSC, 3, 3);
            alongTrack(bag, 'box', s + dc, sd * (PLAT_IN + 0.12), PLAT_UP + 1.25, 0.26, 0.08, 2.0, [0.3, 0.9, 0.6], 5, 0, 0.6);
          }
          prev = dc + 1.0;
        });
        // 外側の壁: 腰までの壁と、屋根までのガラス。縦の桟は 3m ごと
        alongTrack(bag, 'box', s, sd * (PLAT_OUT + 0.12), PLAT_UP, 0.24, 1.0, L, PALE, 3, 4);
        alongTrack(bag, 'box', s, sd * (PLAT_OUT + 0.12), PLAT_UP + 1.0, 0.08, ROOF - PLAT_UP - 1.0, L, GLASSC, 3, 4);
        for (let q = -PLAT_HALF; q <= PLAT_HALF; q += 3) alongTrack(bag, 'box', s + q, sd * (PLAT_OUT + 0.12), PLAT_UP, 0.2, ROOF - PLAT_UP, 0.16, WHITE, 3, 4);
        alongTrack(bag, 'box', s, sd * (PLAT_OUT - 0.02), 2.6, 0.08, 1.0, 8, LINE, 5, 0, 0.9);                     // 駅名の看板
        alongTrack(bag, 'box', s + STAIR, sd * (PLAT_OUT - 0.02), PLAT_UP, 0.06, 2.3, 2.4, [0.25, 0.27, 0.30], 3, 4); // 階段への出口
        alongTrack(bag, 'box', s + STAIR, sd * (PLAT_OUT - 0.04), PLAT_UP + 2.45, 0.06, 0.35, 2.0, [0.3, 0.9, 0.6], 5, 0, 1.0);
        // ホームの両端の壁
        for (let e = -1; e <= 1; e += 2) {
          alongTrack(bag, 'box', s + e * PLAT_HALF, mid, PLAT_UP, W, 1.0, 0.2, PALE, 3, 4);
          alongTrack(bag, 'box', s + e * PLAT_HALF, mid, PLAT_UP + 1.0, W, ROOF - PLAT_UP - 1.0, 0.08, GLASSC, 3, 4);
        }
        // ベンチ
        for (let q = -1; q <= 1; q++) {
          alongTrack(bag, 'box', s + q * 12, sd * (PLAT_OUT - 0.8), PLAT_UP, 0.5, 0.45, 2.4, [0.25, 0.45, 0.70], 3, 5);
          alongTrack(bag, 'box', s + q * 12, sd * (PLAT_OUT - 0.55), PLAT_UP + 0.45, 0.08, 0.45, 2.4, [0.25, 0.45, 0.70], 3, 5);
        }
        // 階段・昇降機の塔（外側）
        alongTrack(bag, 'box', s + STAIR, sd * (PLAT_OUT + 3.4), drop - 1, 6, -drop + 1 + ROOF + 0.6, 7, WHITE, 0, 5);
        alongTrack(bag, 'box', s + STAIR, sd * (PLAT_OUT + 1.2), PLAT_UP - 0.4, 2.2, ROOF - PLAT_UP + 0.4, 3.0, PALE, 3, 5);
        alongTrack(bag, 'box', s + STAIR, sd * (PLAT_OUT + 3.4), ROOF + 0.4, 6.4, 0.3, 7.4, LINE, 5, 0, 0.8);
        // 照明
        alongTrack(bag, 'box', s, mid, ROOF - 0.3, 1.0, 0.1, L - 2, [1.0, 0.95, 0.85], 5, 0, 0.9);
        // 当たり判定: 床・ホームドア・外側の壁・両端の壁・階段の塔（壁は屋根まで）
        const lo = function (x, y) { return sd > 0 ? x : -y; }, hi = function (x, y) { return sd > 0 ? y : -x; };
        stationSolid(st, lo(PLAT_IN, PLAT_OUT + 0.25), hi(PLAT_IN, PLAT_OUT + 0.25), -PLAT_HALF, PLAT_HALF, -0.45, PLAT_UP);
        stationSolid(st, lo(PLAT_IN - 0.05, PLAT_IN + 0.26), hi(PLAT_IN - 0.05, PLAT_IN + 0.26), -PLAT_HALF, PLAT_HALF, PLAT_UP - 0.05, ROOF);
        stationSolid(st, lo(PLAT_OUT, PLAT_OUT + 0.3), hi(PLAT_OUT, PLAT_OUT + 0.3), -PLAT_HALF - 0.2, PLAT_HALF + 0.2, PLAT_UP - 0.05, ROOF);
        for (let e = -1; e <= 1; e += 2) stationSolid(st, lo(PLAT_IN - 0.05, PLAT_OUT + 0.3), hi(PLAT_IN - 0.05, PLAT_OUT + 0.3), e * PLAT_HALF - 0.15, e * PLAT_HALF + 0.15, PLAT_UP - 0.05, ROOF);
        stationSolid(st, lo(PLAT_OUT + 0.4, PLAT_OUT + 6.4), hi(PLAT_OUT + 0.4, PLAT_OUT + 6.4), STAIR - 3.5, STAIR + 3.5, drop - 1, ROOF + 1.0);
      }
      // 屋根: 両方のホームと線路をまとめて覆う（下から飛んでも抜けられない）
      alongTrack(bag, 'box', s, 0, ROOF, 2 * (PLAT_OUT + 1.2), 0.3, L + 2, DARK, 3, 2);
      alongTrack(bag, 'box', s, 0, ROOF + 0.3, 2 * (PLAT_OUT + 1.4), 0.12, L + 2.4, [0.80, 0.81, 0.82], 3, 2);
      stationSolid(st, -(PLAT_OUT + 1.2), PLAT_OUT + 1.2, -PLAT_HALF - 1, PLAT_HALF + 1, ROOF, ROOF + 0.42);
    });
    bags.forEach(function (bag, k) {
      if (!bag) return;
      const grp = new THREE.Group();
      bag.build(grp, true);
      // 区間を包む球（路線の上の点から求める。柱や駅の塔のぶん少し大きめ）
      const pts = [];
      for (let q = 0; q <= 12; q++) pts.push(rl.world(Math.min(rl.N * rl.ds, (k + q / 12) * SEG), 0, 0).pos);
      const c = [0, 1, 2].map(function (j) { return pts.reduce(function (t, p) { return t + p[j]; }, 0) / pts.length; });
      const r = pts.reduce(function (m, p) { return Math.max(m, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])); }, 0) + 120;
      const sphere = new THREE.Sphere(new THREE.Vector3(c[0], c[1], c[2]), r);
      grp.children.forEach(function (m) { m.geometry.boundingSphere = sphere; m.frustumCulled = true; });
      scene.add(grp);
      trackParts.push({ obj: grp, c: c, r: r });
    });
  }

  // 列車: 1両 12m。外から見た車体と、中から見た内装（壁・窓枠・ドア・座席・手すり・照明）。近くを走る編成のぶんだけ用意して使い回す
  const SEAT = [0.22, 0.36, 0.62], INWALL = [0.88, 0.88, 0.86], DOORIN = [0.66, 0.68, 0.72];
  // ドア 1枚（幅 1.4m）: 窓（幅 0.9m、高さ 1.55〜2.3m）の所は穴
  function doorPanel(P, b, x, dz, th, col) {
    P(b, 'box', x, 0.39, dz, th, 1.16, 1.4, col, 3);
    P(b, 'box', x, 2.3, dz, th, 0.34, 1.4, col, 3);
    P(b, 'box', x, 1.55, dz - 0.575, th, 0.75, 0.25, col, 3);
    P(b, 'box', x, 1.55, dz + 0.575, th, 0.75, 0.25, col, 3);
  }
  function buildTrainCar(P, bb, b) {
    // 外側（車体はいつも描く。細かい部品と内装 b は近くだけ）
    P(bb, 'box', 0, 0.35, 0, 2.9, 2.7, 12, WHITE, 7);
    P(bb, 'box', 0, -1.0, 0, 3.0, 1.35, 11.6, DARK, 3);                   // 桁をまたぐ足まわり
    P(bb, 'box', 0, 3.05, 0, 2.6, 0.28, 11.2, GREY, 3);
    for (let sd = -1; sd <= 1; sd += 2) {
      P(b, 'box', sd * 1.46, 0.75, 0, 0.06, 0.32, 12.04, LINE, 5, 0.25);   // 側面の帯
      DOORS.forEach(function (dz) { doorPanel(P, b, sd * 1.47, dz, 0.04, [0.72, 0.74, 0.77]); });
    }
    P(b, 'box', 0, 2.75, 5.98, 1.6, 0.25, 0.12, [1.0, 0.95, 0.8], 5, 1.6);
    P(b, 'box', 0, 2.75, -5.98, 1.6, 0.25, 0.12, [1.0, 0.95, 0.8], 5, 1.6);
    // 内側: 床・天井・照明・手すり
    P(b, 'box', 0, 0.33, 0, 2.8, 0.06, 11.9, [0.46, 0.47, 0.50], 3);
    P(b, 'box', 0, 3.0, 0, 2.8, 0.05, 11.9, [0.90, 0.91, 0.92], 3);
    for (let sd = -1; sd <= 1; sd += 2) {
      P(b, 'box', sd * 0.6, 2.96, 0, 0.25, 0.04, 10.5, [1.0, 1.0, 0.96], 5, 0.8);
      P(b, 'box', sd * 0.78, 2.62, 0, 0.04, 0.04, 11.0, [0.78, 0.79, 0.80], 3);
      // 壁: 窓の下、窓の上、窓と窓の間の柱（1.6m ごと）、窓の無い端の部分
      P(b, 'box', sd * 1.37, 0.39, 0, 0.06, 1.09, 11.9, INWALL, 3);
      P(b, 'box', sd * 1.37, 2.67, 0, 0.06, 0.33, 11.9, INWALL, 3);
      for (let q = -3; q <= 3; q++) P(b, 'box', sd * 1.37, 1.48, q * 1.6, 0.06, 1.19, 0.2, INWALL, 3);
      for (let e = -1; e <= 1; e += 2) P(b, 'box', sd * 1.37, 1.48, e * 5.37, 0.06, 1.19, 1.15, INWALL, 3);
      // ドア（内側）とドアの窓
      DOORS.forEach(function (dz) { doorPanel(P, b, sd * 1.33, dz, 0.04, DOORIN); });
      // ロングシート（座面と背もたれ）と、その端の手すり
      P(b, 'box', sd * 1.08, 0.39, 0, 0.5, 0.45, 6.0, SEAT, 3);
      P(b, 'box', sd * 1.30, 0.84, 0, 0.08, 0.55, 6.0, SEAT, 3);
      for (let e = -1; e <= 1; e += 2) P(b, 'box', sd * 0.85, 0.39, e * 3.05, 0.05, 2.6, 0.05, [0.80, 0.81, 0.82], 3);
    }
    // 両端の壁: 真ん中に通り抜けの口、その両側に窓
    for (let e = -1; e <= 1; e += 2) {
      const z = e * 5.93;
      for (let sd = -1; sd <= 1; sd += 2) {
        P(b, 'box', sd * 0.93, 0.39, z, 0.96, 1.01, 0.08, INWALL, 3);
        P(b, 'box', sd * 0.48, 1.4, z, 0.1, 1.0, 0.08, INWALL, 3);
        P(b, 'box', sd * 1.36, 1.4, z, 0.1, 1.0, 0.08, INWALL, 3);
      }
      P(b, 'box', 0, 2.4, z, 2.82, 0.6, 0.08, INWALL, 3);
    }
  }
  function buildTrains(scene) {
    for (let n = 0; n < 28; n++) {
      const bb = new Kit.Bag(), b = new Kit.Bag(), grp = new THREE.Group(), det = new THREE.Group();
      buildTrainCar(Kit.localPart, bb, b);
      bb.build(grp, true);
      b.build(det, true);
      grp.add(det);
      grp.userData.detail = det;
      grp.matrixAutoUpdate = false;
      grp.visible = false;
      scene.add(grp);
      pool.push(grp);
    }
  }
  function placeCarOnTrack(grp, s, lat) {
    const w = rl.world(s, lat, 0), X = w.Rw, Y = w.up, Z = w.T, p = w.pos;
    grp.matrix.set(X[0], Y[0], Z[0], p[0], X[1], Y[1], Z[1], p[1], X[2], Y[2], Z[2], p[2], 0, 0, 0, 1);
    grp.matrixWorldNeedsUpdate = true;
    grp.visible = true;
  }
  // 近い編成から順に、用意した車両を割り当てる
  const _near = [];
  function updateTrains(cam) {
    _near.length = 0;
    for (let rev = 0; rev < 2; rev++) for (let k = 0; k < rl.trains; k++) {
      const d = rl.trainDist(!!rev, k, clock), p = rl.world(d, trackLat(!!rev), 0).pos;
      const dist = Math.hypot(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]);
      if (dist < 7000) _near.push({ d: d, dist: dist, lat: trackLat(!!rev) });
    }
    _near.sort(function (a, b) { return a.dist - b.dist; });
    for (let n = 0; n < pool.length / 2; n++) {
      const t = _near[n];
      if (!t) { pool[n * 2].visible = pool[n * 2 + 1].visible = false; continue; }
      placeCarOnTrack(pool[n * 2], t.d + 6.3, t.lat);
      placeCarOnTrack(pool[n * 2 + 1], t.d - 6.3, t.lat);
      // 遠くでは内装やドアを描かない（車体の外壁と重なってちらつくので）
      pool[n * 2].userData.detail.visible = pool[n * 2 + 1].userData.detail.visible = t.dist < 150;
    }
  }
  const wrapD = function (d) { return ((d + rl.len / 2) % rl.len + rl.len) % rl.len - rl.len / 2; };

  // ---- 車内を歩く ----
  //  編成の中の位置 (lx, ly, lz) で動き、毎フレーム電車の位置に合わせて世界の座標へ直す
  const BODY = 0.3, HEAD = 1.85;
  const IN_HW = 1.34 - BODY, IN_LEN = 12.23 - 0.08 - BODY, GANG = 0.3 + 0.08 + BODY, GANG_HW = 0.43 - BODY;
  // 足元の高さ（座席の上なら座面の高さ）
  function seatAt(lx, lz) {
    const cz = Math.abs(lz) - 6.3;
    return Math.abs(cz) < 3.0 && Math.abs(lx) > 0.83 - BODY * 0.5 ? 0.45 : 0;
  }
  COL.trainStep = function (p, inp, dt) {
    const tr = COL.onTrain, t1 = clock + dt;                    // 電車は updateVehicles で clock + dt の位置に置かれる
    const d = rl.trainDist(tr.rev, tr.k, t1), d2 = rl.trainDist(tr.rev, tr.k, t1 + 0.1);
    // 向き（電車に対して）。マウスを右へ動かすと右を向く
    tr.yaw -= inp.yaw || 0;
    p.pitch = clamp(p.pitch + (inp.pitch || 0), -1.5, 1.5);
    // 歩く: 見ている向きに対して前後左右（前 = (cos, sin)、右 = (sin, -cos)。成分は進行方向, Rw の順）
    const fa = Math.cos(tr.yaw), fb = Math.sin(tr.yaw), sp = inp.run ? 9 : 4.5;
    let ma = fa * (inp.f || 0) + fb * (inp.s || 0), mb = fb * (inp.f || 0) - fa * (inp.s || 0);
    const ml = Math.hypot(ma, mb);
    if (ml > 1) { ma /= ml; mb /= ml; }
    let nx = clamp(tr.lx + mb * sp * dt, -IN_HW, IN_HW), nz = clamp(tr.lz + ma * sp * dt, -IN_LEN, IN_LEN);
    // 車両と車両の間は、真ん中の通り抜けの口だけ通れる
    if (Math.abs(nz) < GANG) {
      if (Math.abs(tr.lz) >= GANG && Math.abs(nx) > GANG_HW) nz = Math.sign(tr.lz) * GANG;
      else nx = clamp(nx, -GANG_HW, GANG_HW);
    }
    // 座席: 座面より高く上がる段差は 0.5m まで
    const seat = seatAt(nx, nz);
    if (seat - tr.ly > 0.5) { nx = tr.lx; nz = tr.lz; }
    tr.lx = nx; tr.lz = nz;
    // 跳ぶ・落ちる。天井に頭が当たったら止まる
    const floor = seatAt(tr.lx, tr.lz);
    if (inp.jump && tr.ly <= floor + 0.01) tr.vy = 4.2;
    tr.vy -= COL.G * dt;
    tr.ly += tr.vy * dt;
    if (tr.ly < floor) { tr.ly = floor; tr.vy = 0; }
    const top = CEIL - FLOOR - HEAD;
    if (tr.ly > top) { tr.ly = top; if (tr.vy > 0) tr.vy = 0; }
    const w = rl.world(d + tr.lz, trackLat(tr.rev) + tr.lx, FLOOR + tr.ly);
    p.pos = w.pos; p.up = w.up;
    p.fwd = V.norm(V.add(V.mul(w.T, fa), V.mul(w.Rw, fb)));
    p.fly = true; p.swim = false; p.grounded = true;
    p.vel = V.mul(w.T, wrapD(d2 - d) / 0.1);
  };
  function nearestStation(d) {
    let best = -1, bd = 1e18;
    for (let j = 0; j < rl.stations.length; j++) { const e = Math.abs(wrapD(rl.stations[j].s - d)); if (e < bd) { bd = e; best = j; } }
    return { j: best, dist: bd };
  }
  // 駅 j の side 側のホームへ（along: ホームの中の前後の位置）
  function toPlatform(p, j, side, along) {
    const st = rl.stations[j], w = rl.world(st.s + clamp(along || 0, -PLAT_HALF + 1.5, PLAT_HALF - 1.5), side * (PLAT_IN + 1.3), PLAT_UP + 0.05);
    p.pos = w.pos; p.vel = [0, 0, 0]; p.fly = false;
    COL.stepPlayer(p, {}, 0);
  }
  // 降りる: 駅に止まっていればホームへ、走っている途中なら外側へ飛び降りる
  function leaveTrain(p, j) {
    const tr = COL.onTrain, side = tr.rev ? -1 : 1;
    COL.onTrain = null;
    if (j >= 0) { toPlatform(p, j, side, tr.lz); return; }
    const d = rl.trainDist(tr.rev, tr.k, clock), w = rl.world(d + tr.lz, trackLat(tr.rev) + side * (CAR_HW + 0.9), FLOOR + 0.2);
    p.pos = w.pos; p.vel = [0, 0, 0]; p.fly = false;
    COL.stepPlayer(p, {}, 0);
  }
  function board(p, j, rev, k, along) {
    const st = rl.stations[j], w = rl.world(st.s, 0, 0);
    COL.onTrain = { rev: rev, k: k, lx: 0, ly: 0, vy: 0, lz: clamp(along, -IN_LEN + 0.5, IN_LEN - 0.5),
                    yaw: Math.atan2(V.dot(p.fwd, w.Rw), V.dot(p.fwd, w.T)) };
  }
  COL.warpToStation = function (p, j) { COL.onTrain = null; COL.driving = false; COL.ride = null; toPlatform(p, j, 1); stIndex = j; };
  // 駅のホームへ移動する。how: 'near' = 一番近い駅, +1 / -1 = 路線に沿って次・前の駅
  let stIndex = -1;
  COL.stationWarp = function (p, how) {
    const n = rl.stations.length;
    if (how === 'near' || stIndex < 0) {
      let bd = 1e18;
      for (let j = 0; j < n; j++) { const d = V.len(V.sub(rl.world(rl.stations[j].s, 0, 0).pos, p.pos)); if (d < bd) { bd = d; stIndex = j; } }
    } else stIndex = ((stIndex + how) % n + n) % n;
    COL.warpToStation(p, stIndex);
    carMsg = rl.stations[stIndex].name + '（' + (stIndex + 1) + ' / ' + n + '）'; carMsgT = 3;
  };

  COL.initRailOnly = function () { rl = COL.rail(); };     // テスト用（描画なし）
  COL.buildVehicles = function (scene) {
    Kit = COL.CityKit;
    rl = COL.rail();
    buildCar(scene);
    buildBeam(scene, TR);
    buildBeam(scene, -TR);
    buildTrackParts(scene);
    buildTrains(scene);
  };

  // 毎フレーム。use: E キー, call: C キー。戻り値: { text: 案内の文, used: E を使ったか }
  COL.updateVehicles = function (dt, p, use, call, cam) {
    clock += dt;
    updateTrains(cam);
    updateTrackLod(cam);
    if (call) summon(p);
    if (carMsgT > 0) carMsgT -= dt;
    // ---- 車 ----
    if (COL.driving) {
      if (use) { leaveCar(p); return { text: '', used: true }; }
      return { text: Math.abs(car.speed) < 1 ? 'E: 車を降りる' : '', used: false };
    }
    if (car && carGrp.visible) {
      const dist = V.len(V.sub(p.pos, car.pos));
      if (dist > 220) carGrp.visible = false;                    // 離れたら消える（また呼べる）
      else if (dist < 6 && !COL.ride && !COL.onTrain) {
        if (use) { COL.driving = true; lookYaw = 0; p.pitch = 0; return { text: '', used: true }; }
        return { text: 'E: 車に乗る', used: false };
      }
    }
    if (COL.ride) return { text: '', used: false };
    // ---- モノレール ----
    if (COL.onTrain) {
      const tr = COL.onTrain, d = rl.trainDist(tr.rev, tr.k, clock), ns = nearestStation(d), n = rl.stations.length;
      if (ns.dist < 0.5) {
        if (use) { leaveTrain(p, ns.j); return { text: '', used: true }; }
        return { text: 'E: 降りる（' + rl.stations[ns.j].name + '）', used: false };
      }
      if (use) { leaveTrain(p, -1); return { text: '', used: true }; }
      // 次に止まる駅
      const nj = tr.rev ? (wrapD(rl.stations[ns.j].s - d) < 0 ? ns.j : (ns.j - 1 + n) % n)
                        : (wrapD(rl.stations[ns.j].s - d) > 0 ? ns.j : (ns.j + 1) % n);
      return { text: (tr.rev ? '内回り' : '外回り') + '　次は ' + rl.stations[nj].name + '　／　E: ここで飛び降りる', used: false };
    }
    // 駅の近くか
    const c = COL.toCyl(p.pos);
    let x = (c.theta - COL.THETA0) * R; x -= Math.floor(x / rl.WRAP) * rl.WRAP;
    for (let j = 0; j < rl.stations.length; j++) {
      const st = rl.stations[j], a = rl.at(st.s);
      let dx = x - a.x; dx -= Math.round(dx / rl.WRAP) * rl.WRAP;
      const dz = c.z - a.z, along = dx * a.tx + dz * a.tz, lat = dx * a.tz - dz * a.tx;
      if (Math.abs(along) > 45 || Math.abs(lat) > 30) continue;
      const side = lat >= 0 ? 1 : -1, rev = side < 0, dir = rev ? '内回り' : '外回り';
      const onPlat = Math.abs(c.h - (a.h + PLAT_UP)) < 1.2 && Math.abs(lat) > PLAT_IN - 0.5 && Math.abs(lat) < PLAT_OUT + 0.5 && Math.abs(along) < PLAT_HALF + 1;
      if (!onPlat) {
        if (c.h > a.h - 3) return { text: '', used: false };
        if (use) { toPlatform(p, j, side, along); return { text: '', used: true }; }
        return { text: 'E: ' + dir + 'のホームへ上がる（' + st.name + '）', used: false };
      }
      // 階段の出口の近く: 地上へ降りる
      if (along > STAIR - 4 && Math.abs(lat) > PLAT_OUT - 2.5) {
        if (use) {
          const w = rl.world(st.s + STAIR, side * (PLAT_OUT + 7.5), 0), cc = COL.toCyl(w.pos);
          p.pos = COL.toWorld(cc.theta, cc.z, COL.groundH(cc.theta, cc.z) + 0.1); p.vel = [0, 0, 0]; p.fly = false;
          COL.stepPlayer(p, {}, 0);
          return { text: '', used: true };
        }
        return { text: 'E: 階段で地上へ降りる', used: false };
      }
      const inf = rl.stationInfo(j, rev, clock);
      if (inf.present >= 0) {
        if (use) { board(p, j, rev, inf.present, along); return { text: '', used: true }; }
        return { text: 'E: 乗る（' + dir + '・発車まで ' + Math.ceil(inf.left) + ' 秒）', used: false };
      }
      return { text: st.name + '（' + (j + 1) + ' / ' + rl.stations.length + '）' + dir + 'のホーム　次の列車まで ' + Math.ceil(inf.wait) + ' 秒', used: false };
    }
    return { text: carMsgT > 0 ? carMsg : '', used: false };
  };
  COL.vehicleSpeedNote = function () { return COL.driving ? '運転' : COL.onTrain ? 'モノレール' : ''; };
  // 確認用: 車や列車に乗った状態で始める（?veh=train&st=駅&lz=前後&lx=横&yaw=向き）
  COL.debugVehicle = function (p, what, arg, opt) {
    if (what === 'car') { summon(p); if (car) { COL.driving = true; car.speed = arg || 0; } }
    if (what === 'train') {
      const f = rl.stationInfo(arg || 0, false, clock);
      board(p, arg || 0, false, f.present >= 0 ? f.present : 0, 0);
      if (opt) { COL.onTrain.lz = opt.lz; COL.onTrain.lx = opt.lx; COL.onTrain.yaw = opt.yaw; }
    }
    if (what === 'plat') toPlatform(p, arg || 0, 1);
  };
})();
