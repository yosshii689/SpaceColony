// 街の動き: 道路を走る車、歩道を歩く住民、鳥の群れ
//  どれもプレイヤーの近くにだけ出し、離れたものは別の場所に出し直す（数は一定なので負荷は増えない）
(function () {
  'use strict';
  const COL = window.COL, V = COL.V, R = COL.R, B = 125, TAU = Math.PI * 2;
  let Kit = null, rand = null, clock = 0;

  // 毎フレーム位置を書き換える、使い回し描画のメッシュ
  function dynMesh(scene, n, cast, geo, mat) {
    const base = geo || Kit.UNIT.box, g = new THREE.BufferGeometry();
    for (const a in base.attributes) g.setAttribute(a, base.attributes[a]);
    g.setIndex(base.index);
    const parm = new Float32Array(n * 4), col = new Float32Array(n * 3);
    g.setAttribute('iparm', new THREE.InstancedBufferAttribute(parm, 4));
    const mesh = new THREE.InstancedMesh(g, mat || Kit.MAT.box, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    mesh.frustumCulled = false;
    if (cast) mesh.layers.enable(1);
    mesh.instanceMatrix.array.fill(0);
    scene.add(mesh);
    return { mesh: mesh, m: mesh.instanceMatrix.array, parm: parm, col: col };
  }
  function setLook(d, n, col, style, glow) {
    d.col[n * 3] = col[0]; d.col[n * 3 + 1] = col[1]; d.col[n * 3 + 2] = col[2];
    d.parm[n * 4] = style; d.parm[n * 4 + 1] = n % 50; d.parm[n * 4 + 2] = glow || 0;
  }
  // 部品 n を置く。P: 基準の位置, X/Y/Z: 右・上・前（単位ベクトル）, o: その中でのずれ, s: 大きさ
  function put(d, n, P, X, Y, Z, ox, oy, oz, sx, sy, sz) {
    const m = d.m, k = n * 16;
    m[k] = X[0] * sx; m[k + 1] = X[1] * sx; m[k + 2] = X[2] * sx; m[k + 3] = 0;
    m[k + 4] = Y[0] * sy; m[k + 5] = Y[1] * sy; m[k + 6] = Y[2] * sy; m[k + 7] = 0;
    m[k + 8] = Z[0] * sz; m[k + 9] = Z[1] * sz; m[k + 10] = Z[2] * sz; m[k + 11] = 0;
    m[k + 12] = P[0] + X[0] * ox + Y[0] * oy + Z[0] * oz;
    m[k + 13] = P[1] + X[1] * ox + Y[1] * oy + Z[1] * oz;
    m[k + 14] = P[2] + X[2] * ox + Y[2] * oy + Z[2] * oz;
    m[k + 15] = 1;
  }
  function hide(d, n, count) { for (let k = n * 16; k < (n + count) * 16; k++) d.m[k] = 0; }

  // ================= 道路の上を動くもの（車・歩行者） =================
  // a: { i 陸地, dir 0=軸方向に走る道 / 1=周方向に走る道, line 道の位置, sgn 進む向き, t 道に沿った位置, off 道の中心からの横ずれ, on }
  function agentUZ(a) { return a.dir === 0 ? [a.line + a.off, a.t] : [a.t, a.line + a.off]; }
  // プレイヤーの近く（rMin〜rMax）の道路の上に出し直す。walker: 歩道を歩く
  function respawn(a, lc, pz, rMin, rMax, walker) {
    a.on = false;
    if (!lc) return;
    for (let tries = 0; tries < 3; tries++) {
      const dir = rand() < 0.5 ? 0 : 1, ang = rand() * TAU, rr = rMin + rand() * (rMax - rMin);
      const u = lc.u + Math.cos(ang) * rr, z = pz + Math.sin(ang) * rr;
      const idx = Math.round((dir === 0 ? u : z) / B), hw = idx % 2 === 0 ? 9 : 5, sgn = rand() < 0.5 ? 1 : -1;
      a.i = lc.index; a.dir = dir; a.line = idx * B; a.sgn = sgn; a.t = dir === 0 ? z : u;
      if (walker) {
        a.off = (rand() < 0.5 ? 1 : -1) * (hw + 1.2 + rand() * 1.6);
      } else {
        // 左側通行。大通りは片側2車線
        const lane = hw > 6 ? (rand() < 0.5 ? 2.3 : 6.4) : 2.4;
        a.off = (dir === 0 ? -sgn : sgn) * lane;
      }
      const p = agentUZ(a);
      if (!COL.isUrban(a.i, p[0], p[1])) continue;
      if (!walker) {                                  // 交差点の中には出さない
        const m = ((a.t % B) + B) % B;
        if (m < 14 || m > B - 14) continue;
      }
      a.on = true; a.check = rand() * 0.5;
      return;
    }
  }
  function agentFrame(a) {
    const p = agentUZ(a), th = COL.landTheta(a.i, p[0]), f = COL.frameAt(th);
    let g = COL.groundH(th, p[1]);
    const top = COL.solidTop(th, p[1], g + 9);        // 橋の上
    if (top > g) g = top;
    const Z = a.dir === 0 ? [0, 0, a.sgn] : V.mul(f.east, a.sgn);
    return { P: COL.toWorld(th, p[1], g), X: V.cross(f.up, Z), Y: f.up, Z: Z, u: p[0], z: p[1] };
  }

  const CARS = 110, CAR_PARTS = 4, PEOPLE = 40;
  const LIMBS = 11, BALLS = 8, BOXES = 3;        // 1人ぶんの部品の数（筒・球・箱）
  const CARC = [[0.78, 0.12, 0.10], [0.90, 0.90, 0.90], [0.10, 0.10, 0.12], [0.18, 0.30, 0.66], [0.60, 0.60, 0.62], [0.88, 0.74, 0.12], [0.85, 0.85, 0.80], [0.20, 0.45, 0.35]];
  const SHIRT = [[0.80, 0.25, 0.22], [0.22, 0.42, 0.75], [0.90, 0.88, 0.82], [0.25, 0.55, 0.38], [0.90, 0.72, 0.20], [0.50, 0.32, 0.60], [0.15, 0.16, 0.20], [0.85, 0.50, 0.60]];
  const SKIN = [[0.93, 0.78, 0.66], [0.80, 0.62, 0.48], [0.58, 0.42, 0.32], [0.96, 0.84, 0.74]];
  const PANTS = [[0.16, 0.18, 0.26], [0.22, 0.22, 0.24], [0.42, 0.38, 0.30], [0.28, 0.34, 0.46], [0.55, 0.52, 0.46], [0.12, 0.12, 0.14]];
  const HAIR = [[0.08, 0.07, 0.06], [0.20, 0.13, 0.08], [0.36, 0.24, 0.14], [0.62, 0.50, 0.30], [0.55, 0.55, 0.56], [0.14, 0.10, 0.10]];
  let carD = null, carFine = null, limbD = null, ballD = null, shoeD = null;
  const cars = [], people = [];

  function buildAgents(scene) {
    carD = dynMesh(scene, CARS * CAR_PARTS, true);
    // 近くの車は細かい形（流線形の車体・ガラスの屋根・タイヤ・光の帯）で描く。3種類の形を、車ごとにどれか使う
    carFine = ['carA', 'carB', 'carC'].map(function (k) { return dynMesh(scene, CARS, true, Kit.UNIT[k], Kit.MAT[k]); });
    for (let n = 0; n < CARS; n++) {
      const c = { on: false, speed: 11 + (n % 5) * 1.2, long: n % 9 === 0, fine: [0, 1, 0, 2, 1][n % 5] };
      cars.push(c);
      carFine.forEach(function (d) { setLook(d, n, CARC[n % CARC.length], 8, 1); });
      setLook(carD, n * 4, c.long ? [0.92, 0.92, 0.90] : CARC[n % CARC.length], 3);
      setLook(carD, n * 4 + 1, [0.10, 0.12, 0.15], 3);
      setLook(carD, n * 4 + 2, [1.0, 0.96, 0.82], 5, 2.0);
      setLook(carD, n * 4 + 3, [1.0, 0.10, 0.08], 5, 1.2);
    }
    // 住民: 関節のある体。手足は先細りの筒、頭と手は球、靴と鞄は箱
    const limbGeo = new THREE.CylinderGeometry(0.40, 0.5, 1, 8, 1, false); limbGeo.translate(0, 0.5, 0);
    const ballGeo = new THREE.SphereGeometry(0.5, 12, 8); ballGeo.translate(0, 0.5, 0);
    limbD = dynMesh(scene, PEOPLE * LIMBS, true, limbGeo, Kit.MAT.cyl);
    ballD = dynMesh(scene, PEOPLE * BALLS, true, ballGeo, Kit.MAT.cyl);
    shoeD = dynMesh(scene, PEOPLE * BOXES, true);
    const pr = COL.rng(4848), pick = function (list) { return list[Math.floor(pr() * list.length)]; };
    for (let n = 0; n < PEOPLE; n++) {
      const child = pr() < 0.12, female = pr() < 0.5;
      const m = {
        on: false, ph: pr() * TAU, child: child, female: female,
        s: child ? 0.62 + pr() * 0.12 : (female ? 0.90 : 0.97) + pr() * 0.10,       // 身長の倍率（1.0 で約 1.72m）
        build: 0.88 + pr() * 0.30,                                                   // 体格（横幅）
        speed: (child ? 1.0 : 1.25) + pr() * 0.35,
        skirt: female && pr() < 0.4, longHair: female ? pr() < 0.7 : pr() < 0.08,
        shorts: pr() < 0.25, sleeves: pr() < 0.55, bag: pr() < 0.3, idle: pr() < 0.16,
      };
      people.push(m);
      const skin = pick(SKIN), shirt = pick(SHIRT), pants = pick(PANTS), hair = pick(HAIR), L = n * LIMBS, Bq = n * BALLS, S = n * BOXES;
      const leg = m.skirt ? skin : pants, shin = (m.skirt || m.shorts) ? skin : pants;
      setLook(limbD, L, leg, 3); setLook(limbD, L + 1, leg, 3);                     // 太もも 左右
      setLook(limbD, L + 2, shin, 3); setLook(limbD, L + 3, shin, 3);               // すね
      setLook(limbD, L + 4, shirt, 3); setLook(limbD, L + 5, shirt, 3);             // 上腕
      setLook(limbD, L + 6, m.sleeves ? shirt : skin, 3); setLook(limbD, L + 7, m.sleeves ? shirt : skin, 3);   // 前腕
      setLook(limbD, L + 8, shirt, 3);                                              // 胴
      setLook(limbD, L + 9, m.skirt ? pick(SHIRT) : pants, 3);                      // 腰（またはスカート）
      setLook(limbD, L + 10, skin, 3);                                              // 首
      setLook(ballD, Bq, skin, 3); setLook(ballD, Bq + 1, hair, 3); setLook(ballD, Bq + 2, hair, 3);   // 頭、髪（頭頂と前髪）、髪（後ろ）
      setLook(ballD, Bq + 3, skin, 3); setLook(ballD, Bq + 4, skin, 3);             // 手
      setLook(ballD, Bq + 5, [0.07, 0.06, 0.06], 3); setLook(ballD, Bq + 6, [0.07, 0.06, 0.06], 3);   // 目
      setLook(ballD, Bq + 7, [0.62, 0.26, 0.24], 3);                                // 口
      const shoe = pr() < 0.5 ? [0.10, 0.10, 0.11] : pr() < 0.5 ? [0.85, 0.85, 0.83] : [0.35, 0.22, 0.14];
      setLook(shoeD, S, shoe, 3); setLook(shoeD, S + 1, shoe, 3);
      setLook(shoeD, S + 2, pick(PANTS), 3);                                        // 鞄
    }
  }

  // 筒を点 A から点 B へ渡す。X: 太さの基準になる横向き, wx/wz: A 側の太さ
  function seg(d, n, A, Bp, X, wx, wz) {
    const Y = V.sub(Bp, A), Yn = V.norm(Y), Z = V.norm(V.cross(X, Yn)), Xo = V.cross(Yn, Z), m = d.m, k = n * 16;
    m[k] = Xo[0] * wx; m[k + 1] = Xo[1] * wx; m[k + 2] = Xo[2] * wx; m[k + 3] = 0;
    m[k + 4] = Y[0]; m[k + 5] = Y[1]; m[k + 6] = Y[2]; m[k + 7] = 0;
    m[k + 8] = Z[0] * wz; m[k + 9] = Z[1] * wz; m[k + 10] = Z[2] * wz; m[k + 11] = 0;
    m[k + 12] = A[0]; m[k + 13] = A[1]; m[k + 14] = A[2]; m[k + 15] = 1;
  }
  // 1人ぶんの姿勢を作る。f: 足元の位置と向き, m: その人, ph: 歩みの位相
  function pose(n, f, m, ph) {
    const s = m.s, b = m.build, X = f.X, Y = f.Y, Z = f.Z, P = f.P;
    const W = function (x, y, z) { return [P[0] + X[0] * x + Y[0] * y + Z[0] * z, P[1] + X[1] * x + Y[1] * y + Z[1] * z, P[2] + X[2] * x + Y[2] * y + Z[2] * z]; };
    const TH = 0.44 * s, SH = 0.44 * s, FOOT = 0.07 * s, amp = m.idle ? 0 : 0.46;
    // 脚: 太ももを前後に振り、前へ出す側は膝を曲げる
    const legA = [amp * Math.sin(ph), amp * Math.sin(ph + Math.PI)];
    const knee = [0.07 + (m.idle ? 0 : 0.78 * Math.max(0, Math.cos(ph))), 0.07 + (m.idle ? 0 : 0.78 * Math.max(0, Math.cos(ph + Math.PI)))];
    // 腰の高さ: 低い方の足がちょうど地面に着く高さ
    const reach = Math.max(TH * Math.cos(legA[0]) + SH * Math.cos(legA[0] - knee[0]), TH * Math.cos(legA[1]) + SH * Math.cos(legA[1] - knee[1]));
    const hipY = reach + FOOT, sway = m.idle ? Math.sin(clock * 0.7 + m.ph) * 0.012 : Math.sin(ph) * 0.015 * s;
    const L = n * LIMBS, Bq = n * BALLS, S = n * BOXES, hipW = 0.085 * s * b;
    for (let e = 0; e < 2; e++) {
      const sd = e ? 1 : -1, a = legA[e], k = knee[e];
      const hip = W(sd * hipW + sway, hipY, 0);
      const kn = W(sd * hipW + sway, hipY - TH * Math.cos(a), TH * Math.sin(a));
      const an = W(sd * hipW + sway, hipY - TH * Math.cos(a) - SH * Math.cos(a - k), TH * Math.sin(a) + SH * Math.sin(a - k));
      seg(limbD, L + e, hip, kn, X, 0.155 * s * b, 0.165 * s * b);
      seg(limbD, L + 2 + e, kn, an, X, 0.115 * s * b, 0.125 * s * b);
      // 靴: 足首の下、つま先は進む向き
      const fy = hipY - TH * Math.cos(a) - SH * Math.cos(a - k) - FOOT;
      put(shoeD, S + e, P, X, Y, Z, sd * hipW + sway, Math.max(0, fy), TH * Math.sin(a) + SH * Math.sin(a - k) + 0.055 * s, 0.095 * s, 0.075 * s, 0.25 * s);
    }
    // 胴: 肩から腰へ（肩の側が広い）。少し前に傾ける
    const lean = m.idle ? 0 : 0.03 * s, shY = hipY + 0.50 * s, shW = (m.female ? 0.165 : 0.19) * s * b;
    const waist = W(sway, hipY + 0.02 * s, 0), chest = W(sway * 0.5, shY, lean);
    seg(limbD, L + 8, chest, waist, X, shW * 2.05, 0.21 * s * b);
    if (m.skirt) seg(limbD, L + 9, W(sway, hipY - 0.40 * s, 0), W(sway, hipY + 0.10 * s, 0), X, 0.50 * s * b, 0.46 * s * b);
    else seg(limbD, L + 9, W(sway, hipY - 0.10 * s, 0), W(sway, hipY + 0.10 * s, 0), X, 0.33 * s * b, 0.22 * s * b);
    // 腕: 脚と逆に振る。肘は軽く曲げる
    for (let e = 0; e < 2; e++) {
      const sd = e ? 1 : -1, a = m.idle ? 0.04 : -0.75 * legA[e], bend = m.idle ? 0.12 : 0.28 + 0.30 * Math.max(0, Math.sin(ph + (e ? Math.PI : 0) + Math.PI));
      const UA = 0.29 * s, FA = 0.26 * s, x = sd * (shW + 0.035 * s) + sway * 0.5;
      const sh = W(x, shY - 0.03 * s, lean), el = W(x + sd * 0.02 * s, shY - 0.03 * s - UA * Math.cos(a), lean + UA * Math.sin(a));
      const hd = W(x + sd * 0.01 * s, shY - 0.03 * s - UA * Math.cos(a) - FA * Math.cos(a + bend), lean + UA * Math.sin(a) + FA * Math.sin(a + bend));
      seg(limbD, L + 4 + e, sh, el, X, 0.095 * s * b, 0.10 * s * b);
      seg(limbD, L + 6 + e, el, hd, X, 0.075 * s * b, 0.08 * s * b);
      const hl = W(x + sd * 0.01 * s, shY - 0.03 * s - UA * Math.cos(a) - (FA + 0.085 * s) * Math.cos(a + bend), lean + UA * Math.sin(a) + (FA + 0.085 * s) * Math.sin(a + bend));
      put(ballD, Bq + 3 + e, hl, X, Y, Z, 0, 0, 0, 0.07 * s, 0.10 * s, 0.085 * s);
    }
    // 首・頭・髪（子どもは頭が大きめ）
    const hs = (m.child ? 1.22 : 1) * s, nk = W(sway * 0.5, shY, lean), hb = W(sway * 0.5, shY + 0.07 * s, lean + 0.01);
    seg(limbD, L + 10, nk, hb, X, 0.085 * s, 0.085 * s);
    put(ballD, Bq, hb, X, Y, Z, 0, -0.01 * hs, 0, 0.19 * hs, 0.235 * hs, 0.215 * hs);
    // 髪: 頭頂から額の生え際までを覆う（前髪）。長い髪の人は後ろにも垂らす
    put(ballD, Bq + 1, hb, X, Y, Z, 0, 0.080 * hs, -0.012 * hs, 0.214 * hs, 0.175 * hs, 0.252 * hs);
    if (m.longHair) put(ballD, Bq + 2, hb, X, Y, Z, 0, -0.13 * hs, -0.068 * hs, 0.215 * hs, 0.34 * hs, 0.165 * hs);
    else hide(ballD, Bq + 2, 1);
    // 目と口
    put(ballD, Bq + 5, hb, X, Y, Z, -0.040 * hs, 0.098 * hs, 0.089 * hs, 0.030 * hs, 0.026 * hs, 0.022 * hs);
    put(ballD, Bq + 6, hb, X, Y, Z, 0.040 * hs, 0.098 * hs, 0.089 * hs, 0.030 * hs, 0.026 * hs, 0.022 * hs);
    put(ballD, Bq + 7, hb, X, Y, Z, 0, 0.040 * hs, 0.087 * hs, 0.052 * hs, 0.014 * hs, 0.020 * hs);
    // 鞄: 背負うか、持たないか
    if (m.bag) put(shoeD, S + 2, P, X, Y, Z, sway, hipY + 0.14 * s, -0.19 * s * b, 0.26 * s, 0.32 * s, 0.11 * s);
    else hide(shoeD, S + 2, 1);
  }

  function updateAgents(dt, lc, pz, night) {
    // ---- 車 ----
    const sc = COL.lifeScale === undefined ? 1 : COL.lifeScale, carMax = Math.round(CARS * sc);
    for (let n = 0; n < CARS; n++) {
      const c = cars[n];
      if (n >= carMax) c.on = false;
      else if (c.on && lc && c.i === lc.index) {
        c.t += c.speed * c.sgn * dt;
        const p = agentUZ(c), dist = Math.hypot(p[0] - lc.u, p[1] - pz);
        c.check -= dt;
        if (dist > 560) c.on = false;
        else if (c.check <= 0) {                      // 道が終わる手前（水際・街の端）で消える
          c.check = 0.4;
          const q = c.dir === 0 ? [p[0], p[1] + c.sgn * 14] : [p[0] + c.sgn * 14, p[1]];
          if (!COL.isUrban(c.i, q[0], q[1]) && COL.solidTop(COL.landTheta(c.i, q[0]), q[1], COL.groundH(COL.landTheta(c.i, q[0]), q[1]) + 9) < -1e8) c.on = false;
        }
      } else c.on = false;
      if (!c.on && n < carMax) respawn(c, lc, pz, 110, 520, false);
      hide(carFine[0], n, 1); hide(carFine[1], n, 1); hide(carFine[2], n, 1);
      if (!c.on) { hide(carD, n * 4, 4); continue; }
      const f = agentFrame(c), len = c.long ? 7.5 : 4.3, hgt = c.long ? 2.3 : 0.62;
      if (!c.long && COL.carDist && lc && Math.hypot(f.u - lc.u, f.z - pz) < COL.carDist) {
        hide(carD, n * 4, 4);
        put(carFine[c.fine], n, f.P, f.X, f.Y, f.Z, 0, 0, 0, 1, 1, 1);
        continue;
      }
      put(carD, n * 4, f.P, f.X, f.Y, f.Z, 0, 0.28, 0, c.long ? 2.3 : 1.8, hgt, len);
      put(carD, n * 4 + 1, f.P, f.X, f.Y, f.Z, 0, 0.28 + hgt, c.long ? len / 2 - 1.1 : -0.3, c.long ? 2.2 : 1.6, c.long ? 0.05 : 0.52, c.long ? 1.6 : 2.2);
      put(carD, n * 4 + 2, f.P, f.X, f.Y, f.Z, 0, 0.55, len / 2, 1.5, 0.14, 0.06);
      put(carD, n * 4 + 3, f.P, f.X, f.Y, f.Z, 0, 0.58, -len / 2, 1.5, 0.12, 0.06);
    }
    carD.mesh.instanceMatrix.needsUpdate = true;
    carFine.forEach(function (d) { d.mesh.instanceMatrix.needsUpdate = true; });
    // ---- 住民（夜は少ない） ----
    const active = Math.round(PEOPLE * (1 - 0.6 * night) * sc);
    for (let n = 0; n < PEOPLE; n++) {
      const m = people[n];
      if (n >= active) m.on = false;
      else if (m.on && lc && m.i === lc.index) {
        const step = m.idle ? 0 : m.speed * dt;
        m.t += step * m.sgn;
        m.ph += step / (1.56 * m.s) * TAU;            // 歩幅に合わせて脚を動かす（足が滑らない）
        const p = agentUZ(m), dist = Math.hypot(p[0] - lc.u, p[1] - pz);
        m.check -= dt;
        if (dist > 210) m.on = false;
        else if (m.check <= 0) { m.check = 0.7; if (!COL.isUrban(m.i, p[0], p[1])) m.sgn = -m.sgn; }   // 道の端で引き返す
      } else m.on = false;
      if (!m.on && n < active) respawn(m, lc, pz, 25, 190, true);
      if (!m.on) { hide(limbD, n * LIMBS, LIMBS); hide(ballD, n * BALLS, BALLS); hide(shoeD, n * BOXES, BOXES); continue; }
      const f = agentFrame(m);
      if (m.idle) {                                   // 立ち止まっている人は車道の方を向く
        const side = V.mul(f.X, m.off > 0 ? (m.dir === 0 ? -1 : 1) * m.sgn : (m.dir === 0 ? 1 : -1) * m.sgn);
        f.Z = side; f.X = V.cross(f.Y, f.Z);
      }
      pose(n, f, m, m.ph);
    }
    limbD.mesh.instanceMatrix.needsUpdate = true;
    ballD.mesh.instanceMatrix.needsUpdate = true;
    shoeD.mesh.instanceMatrix.needsUpdate = true;
  }

  // ================= 魚（南国の海のサンゴ礁のまわり） =================
  //  群れごとに種類を決め、サンゴの多い浅い所を輪を描くように泳ぐ
  //  体は種類ごとに作る（断面をつないだ胴体・背びれ・しりびれ・尾びれ・胸びれ・腹びれ・目）。体のしなりと尾の振りは頂点シェーダーで
  //  模様（帯・斑点・うろこ）はフラグメントシェーダーで描く。頂点の色 r: 部品（0 胴体, 1 ひれ, 2 目, 3 尾びれ）, g: ひれの付け根 0 → ふち 1, b: 胸びれ（ひらひら動く）
  const SCHOOLS = 12, FPER = 12;
  const FISH = [
    { name: 'キイロハギ', s: 0.34, n: 8 },
    { name: 'ナンヨウハギ', s: 0.36, n: 7 },
    { name: 'カクレクマノミ', s: 0.22, n: 4 },
    { name: 'ブダイ', s: 0.55, n: 3 },
    { name: 'ギンガメアジ', s: 0.48, n: 11 },
    { name: 'チョウチョウウオ', s: 0.28, n: 6 },
  ];
  // 形: prof は [t, 背の高さ, 腹の深さ, 半分の幅]（t: 尾の付け根 0 → 鼻先 1。体長 1 に対して）
  //  dorsal / anal: ひれの [t, 高さ] の列（いくつかに分かれていてよい）。tail: H 尾びれの半分の高さ, L 長さ, fork 切れ込み（負なら丸い）
  //  eye: [t, 高さ, 半径], amp: 尾を振る大きさ, freq: 振る速さ, pect: 胸びれの長さ
  const SHAPE = [
    { prof: [[0, 0.045, 0.045, 0.028], [0.15, 0.14, 0.13, 0.06], [0.35, 0.24, 0.22, 0.08], [0.55, 0.26, 0.23, 0.08], [0.72, 0.22, 0.19, 0.072], [0.86, 0.13, 0.11, 0.055], [0.96, 0.05, 0.045, 0.03], [1, 0.012, 0.012, 0.01]],
      dorsal: [[[0.12, 0.02], [0.30, 0.13], [0.55, 0.12], [0.80, 0.05], [0.86, 0.0]]], anal: [[[0.12, 0.02], [0.30, 0.12], [0.50, 0.10], [0.64, 0.0]]],
      tail: { H: 0.13, L: 0.17, fork: 0.12 }, eye: [0.79, 0.075, 0.028], amp: 0.035, freq: 8, pect: 0.10 },
    { prof: [[0, 0.04, 0.04, 0.03], [0.2, 0.12, 0.11, 0.065], [0.45, 0.19, 0.18, 0.08], [0.65, 0.20, 0.18, 0.08], [0.82, 0.16, 0.14, 0.07], [0.94, 0.09, 0.08, 0.05], [1, 0.02, 0.02, 0.015]],
      dorsal: [[[0.10, 0.02], [0.25, 0.06], [0.70, 0.055], [0.84, 0.0]]], anal: [[[0.10, 0.02], [0.25, 0.05], [0.50, 0.04], [0.60, 0.0]]],
      tail: { H: 0.14, L: 0.18, fork: 0.32 }, eye: [0.83, 0.045, 0.03], amp: 0.05, freq: 9, pect: 0.11 },
    { prof: [[0, 0.05, 0.05, 0.035], [0.2, 0.11, 0.10, 0.07], [0.5, 0.165, 0.15, 0.09], [0.75, 0.16, 0.14, 0.085], [0.9, 0.12, 0.10, 0.07], [0.98, 0.06, 0.05, 0.04], [1, 0.02, 0.015, 0.012]],
      dorsal: [[[0.08, 0.02], [0.20, 0.085], [0.42, 0.07], [0.46, 0.04], [0.55, 0.06], [0.76, 0.04], [0.80, 0.0]]], anal: [[[0.08, 0.02], [0.20, 0.08], [0.40, 0.05], [0.46, 0.0]]],
      tail: { H: 0.10, L: 0.16, fork: -0.35 }, eye: [0.85, 0.045, 0.036], amp: 0.05, freq: 12, pect: 0.10 },
    { prof: [[0, 0.05, 0.05, 0.04], [0.2, 0.11, 0.10, 0.08], [0.5, 0.16, 0.15, 0.10], [0.75, 0.155, 0.14, 0.095], [0.9, 0.12, 0.10, 0.075], [0.98, 0.07, 0.045, 0.05], [1, 0.035, 0.0, 0.03]],
      dorsal: [[[0.10, 0.02], [0.22, 0.05], [0.78, 0.045], [0.82, 0.0]]], anal: [[[0.08, 0.02], [0.18, 0.05], [0.38, 0.04], [0.42, 0.0]]],
      tail: { H: 0.15, L: 0.18, fork: 0.45 }, eye: [0.82, 0.055, 0.026], amp: 0.045, freq: 6, pect: 0.12 },
    { prof: [[0, 0.03, 0.03, 0.025], [0.15, 0.08, 0.075, 0.05], [0.45, 0.17, 0.17, 0.085], [0.7, 0.18, 0.16, 0.085], [0.88, 0.145, 0.10, 0.07], [0.97, 0.08, 0.04, 0.045], [1, 0.03, 0.0, 0.02]],
      dorsal: [[[0.56, 0.0], [0.60, 0.05], [0.68, 0.035], [0.70, 0.0]], [[0.06, 0.015], [0.40, 0.03], [0.47, 0.11], [0.50, 0.0]]],
      anal: [[[0.06, 0.015], [0.33, 0.03], [0.40, 0.09], [0.43, 0.0]]],
      tail: { H: 0.19, L: 0.22, fork: 0.78 }, eye: [0.89, 0.05, 0.034], amp: 0.06, freq: 7, pect: 0.17 },
    { prof: [[0, 0.04, 0.04, 0.025], [0.15, 0.14, 0.13, 0.05], [0.4, 0.25, 0.23, 0.065], [0.6, 0.25, 0.22, 0.065], [0.78, 0.18, 0.15, 0.055], [0.88, 0.07, 0.06, 0.035], [0.97, 0.025, 0.02, 0.016], [1, 0.012, 0.01, 0.01]],
      dorsal: [[[0.06, 0.02], [0.22, 0.10], [0.45, 0.09], [0.78, 0.03], [0.82, 0.0]]], anal: [[[0.06, 0.02], [0.22, 0.09], [0.45, 0.05], [0.55, 0.0]]],
      tail: { H: 0.10, L: 0.13, fork: 0.0 }, eye: [0.74, 0.06, 0.026], amp: 0.04, freq: 9, pect: 0.09 },
  ];
  const fishZ = function (t) { return -0.30 + 0.80 * t; };
  function fishGeo(S) {
    const pos = [], nrm = [], col = [], uvs = [];
    const put1 = function (p, n, c, uv) { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); col.push(c[0], c[1], c[2]); uvs.push(uv[0], uv[1]); };
    const sm = function (x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    const prof = function (t) {
      const P = S.prof;
      for (let k = 1; k < P.length; k++) if (t <= P[k][0] + 1e-9) {
        const a = P[k - 1], b = P[k], q = sm((t - a[0]) / (b[0] - a[0]));
        return [a[1] + (b[1] - a[1]) * q, a[2] + (b[2] - a[2]) * q, a[3] + (b[3] - a[3]) * q];
      }
      const L = P[P.length - 1]; return [L[1], L[2], L[3]];
    };
    // ---- 胴体: 断面をつなぐ。法線は となりの点から求めて、外向きにそろえる ----
    const NR = 26, NS = 16, rows = [];
    for (let k = 0; k <= NR; k++) {
      const t = k / NR, pr = prof(t), row = [];
      for (let j = 0; j <= NS; j++) {
        const a = (j % NS) / NS * TAU, s = Math.sin(a), c = Math.cos(a);
        // 断面は少し角ばった楕円（背と腹は細く、横は ふくらむ）
        const sx = Math.sign(c) * Math.pow(Math.abs(c), 0.85), sy = Math.sign(s) * Math.pow(Math.abs(s), 1.1);
        row.push({ p: [pr[2] * sx, sy > 0 ? pr[0] * sy : pr[1] * sy, fishZ(t)], uv: [t, s] });
      }
      rows.push(row);
    }
    const cen = function (r) { let c = [0, 0, 0]; for (let j = 0; j < NS; j++) c = V.add(c, r[j].p); return V.mul(c, 1 / NS); };
    const nr = rows.map(function (r, k) {
      const c0 = cen(r);
      return r.map(function (q, j) {
        const jj = j % NS, dR = V.sub(r[(jj + 1) % NS].p, r[(jj + NS - 1) % NS].p), dA = V.sub(rows[Math.min(NR, k + 1)][j].p, rows[Math.max(0, k - 1)][j].p);
        let n = V.cross(dR, dA);
        if (V.len(n) < 1e-12) n = V.sub(q.p, c0);
        if (V.len(n) < 1e-12) n = [0, 0, 1];
        n = V.norm(n);
        return V.dot(n, V.sub(q.p, c0)) < 0 && k < NR ? V.mul(n, -1) : (k === NR ? [0, 0, 1] : n);
      });
    });
    for (let k = 0; k < NR; k++) for (let j = 0; j < NS; j++) {
      [[k, j], [k + 1, j], [k, j + 1], [k, j + 1], [k + 1, j], [k + 1, j + 1]].forEach(function (e) {
        put1(rows[e[0]][e[1]].p, nr[e[0]][e[1]], [0, 0, 0], rows[e[0]][e[1]].uv);
      });
    }
    // 尾の付け根の断面をふさぐ
    for (let j = 0; j < NS; j++) [[0, 0, -0.30], rows[0][j + 1].p, rows[0][j].p].forEach(function (p) { put1(p, [0, 0, -1], [0, 0, 0], [0, 0]); });
    // ---- ひれ: 付け根の列とふちの列をつなぐ薄い板（両面描く） ----
    const plate = function (base, edge, nrm0, part, flutter, uvy) {
      const M = 3;
      for (let k = 0; k + 1 < base.length; k++) for (let q = 0; q < M; q++) {
        const f0 = q / M, f1 = (q + 1) / M;
        const A = V.lerp(base[k], edge[k], f0), Bq = V.lerp(base[k + 1], edge[k + 1], f0), C = V.lerp(base[k + 1], edge[k + 1], f1), D = V.lerp(base[k], edge[k], f1);
        const uy = function (kk) { return typeof uvy === 'function' ? uvy(kk) : uvy; };
        [[A, f0, k], [Bq, f0, k + 1], [C, f1, k + 1], [A, f0, k], [C, f1, k + 1], [D, f1, k]].forEach(function (e) { put1(e[0], nrm0, [part, e[1], flutter], [0, uy(e[2])]); });
      }
    };
    const finAlong = function (segs, top) {
      segs.forEach(function (pts) {
        const t0 = pts[0][0], t1 = pts[pts.length - 1][0], M = 12, base = [], edge = [];
        for (let k = 0; k <= M; k++) {
          const t = t0 + (t1 - t0) * k / M;
          let h = 0;
          for (let q = 1; q < pts.length; q++) if (t <= pts[q][0] + 1e-9) { const a = pts[q - 1], b = pts[q]; h = a[1] + (b[1] - a[1]) * (t - a[0]) / Math.max(1e-6, b[0] - a[0]); break; }
          const pr = prof(t), y0 = top ? pr[0] * 0.96 : -pr[1] * 0.96, z = fishZ(t);
          base.push([0, y0, z]);
          edge.push([0, y0 + (top ? h : -h), z - h * 0.35]);
        }
        plate(base, edge, [1, 0, 0], 1, 0, top ? 2 : -2);
      });
    };
    finAlong(S.dorsal, true);
    finAlong(S.anal, false);
    // 尾びれ
    {
      const T = S.tail, hp = prof(0)[0] * 0.95, NV = 12, base = [], edge = [];
      for (let k = 0; k <= NV; k++) {
        const v = -1 + 2 * k / NV, av = Math.abs(v);
        const zEnd = -0.29 - T.L * (1 - T.fork * (1 - Math.pow(av, 1.6)));
        base.push([0, v * hp, -0.285]);
        edge.push([0, v * T.H * (T.fork > 0.5 ? 1 + 0.15 * av : 1), zEnd]);
      }
      plate(base, edge, [1, 0, 0], 3, 0, function (k) { return -1 + 2 * k / NV; });
    }
    // 胸びれ（左右。ひらひら動く）と腹びれ
    for (let sd = -1; sd <= 1; sd += 2) {
      const t = S.eye[0] - 0.13, pr = prof(t), z = fishZ(t), x = pr[2] * 0.92, y0 = -pr[1] * 0.25, L = S.pect;
      // 付け根から扇のように広がる（ふちは丸い）
      const fb = [], fe = [];
      for (let q = 0; q <= 6; q++) {
        const a = q / 6, ang = 0.40 - 0.80 * a, len = L * (0.70 + 0.30 * Math.sin(a * Math.PI) + 0.12 * (1 - a));
        fb.push([sd * x, y0 + 0.022 - 0.04 * a, z - 0.008 * a]);
        fe.push([sd * (x + len * 0.45), y0 + 0.022 - 0.04 * a + Math.sin(ang) * len * 0.55, z - Math.cos(ang) * len]);
      }
      plate(fb, fe, V.norm([sd, 0.2, 0]), 1, 1, 0);
      const t2 = S.eye[0] - 0.20, pr2 = prof(t2), z2 = fishZ(t2), y2 = -pr2[1] * 0.92;
      plate([[sd * pr2[2] * 0.3, y2, z2], [sd * pr2[2] * 0.3, y2 + 0.005, z2 - 0.03]], [[sd * pr2[2] * 0.55, y2 - 0.05, z2 - 0.06], [sd * pr2[2] * 0.5, y2 - 0.03, z2 - 0.08]], [sd, 0, 0], 1, 0, 0);
    }
    // ---- 目: 体の横に少し出た球。g は目の正面からの角度（瞳・虹彩・白目を描き分ける） ----
    const eg = new THREE.IcosahedronGeometry(1, 2), EP = eg.attributes.position;
    for (let sd = -1; sd <= 1; sd += 2) {
      const t = S.eye[0], pr = prof(t), ey = S.eye[1], r = S.eye[2];
      const xs = pr[2] * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(ey) / pr[0], 1 / 1.1 * 2)), 0.5 / 0.85);
      const c = [sd * (xs - r * 0.45), ey, fishZ(t)];
      for (let k = 0; k < EP.count; k++) {
        const d = [EP.getX(k), EP.getY(k), EP.getZ(k)];
        const g = Math.acos(Math.max(-1, Math.min(1, d[0] * sd))) / Math.PI;
        put1([c[0] + d[0] * r * 0.75, c[1] + d[1] * r, c[2] + d[2] * r], d, [2, g, 0], [0, 0]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return geo;
  }

  const fishVS = COL.GL.VS_HEAD + `
    attribute vec4 iparm;           // y: 尾の振りの位相, z: 振る速さ
    uniform float amp, time;
    varying vec3 vWorld, vN, vObj, vInfo, vTint;
    varying vec2 vUv;
    void main() {
      vec3 p = position;
      float ph = time * iparm.z + iparm.y * 6.2831853;
      // 体の後ろほど大きく左右にしなる波。頭は逆へ少し振れる
      float w = pow(clamp((0.22 - p.z) / 0.72, 0.0, 1.0), 1.4);
      p.x += amp * sin(ph - (0.22 - p.z) * 5.5) * w - amp * 0.22 * sin(ph) * clamp((p.z - 0.1) / 0.4, 0.0, 1.0);
      p.x += 0.025 * color.b * color.g * sin(ph * 1.6 + 1.0) * sign(position.x);      // 胸びれ
      mat4 m = modelMatrix * instanceMatrix;
      vec4 wp = m * vec4(p, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(m) * normal);
      vObj = position; vInfo = color; vUv = uv;
      vTint = vec3(1.0);
      #ifdef USE_INSTANCING_COLOR
        vTint = instanceColor;
      #endif
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + COL.GL.VS_TAIL + `
    }`;
  const fishFS = COL.GL.FS_HEAD + COL.GL.COMMON + COL.GL.NOISE2 + COL.GL.CAUSTIC + `
    uniform vec3 eye;               // 目の位置 (z, 高さ, 半径)
    varying vec3 vWorld, vN, vObj, vInfo, vTint;
    varying vec2 vUv;
    float disc(vec2 p, vec2 c, float r, float aa) { return 1.0 - smoothstep(r - aa, r + aa, length(p - c)); }
    float band(float x, float c, float hw, float aa) { return 1.0 - smoothstep(hw - aa, hw + aa, abs(x - c)); }
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN);
      if (!gl_FrontFacing) N = -N;
      vec3 V = normalize(cameraPosition - vWorld), ld = sunDirAt(vWorld);
      int part = int(vInfo.r + 0.5);
      float edge = vInfo.g, z = vObj.z, y = vObj.y, v = vUv.y;
      vec2 q = vec2(z, y);
      float aa = max(fwidth(z), fwidth(y)) * 0.8 + 1e-4;
      bool body = part == 0, fin = part == 1, tail = part == 3;
      vec3 col = vec3(1.0);
      float shine = 0.5, scaleK = 0.5;
      vec3 iris = vec3(0.85, 0.65, 0.15);
      #if SP == 0
        // キイロハギ: 全身あざやかな黄色。尾の付け根に白いとげ
        col = vec3(1.0, 0.74, 0.0) * (0.92 + 0.12 * clamp(v, -1.0, 1.0));
        if (body) col = mix(col, vec3(0.97), disc(q, vec2(-0.25, 0.0), 0.016, aa));
        if (fin || tail) col = vec3(1.0, 0.76, 0.04) * (1.0 + 0.10 * edge);
        scaleK = 0.15; iris = vec3(0.10, 0.10, 0.10);
      #elif SP == 1
        // ナンヨウハギ: 青い体に黒いパレット模様、黄色い尾
        col = vec3(0.06, 0.26, 0.92);
        if (body) {
          float cA = 0.065 + 0.05 * smoothstep(0.36, 0.0, z), hwA = 0.028 + 0.035 * exp(-pow((z - 0.10) / 0.12, 2.0));
          float k = band(y, cA, hwA, aa) * step(-0.22, z) * (1.0 - smoothstep(0.34, 0.38, z));
          float cB = -0.015 + 0.075 * smoothstep(-0.27, -0.04, z);
          k = max(k, band(y, cB, 0.02, aa) * step(-0.29, z) * (1.0 - smoothstep(-0.06, -0.02, z)));
          col = mix(col, vec3(0.02, 0.025, 0.05), k);
        }
        if (fin) col = mix(vec3(0.06, 0.24, 0.85), vec3(0.02), smoothstep(0.72, 0.80, edge));
        if (vInfo.b > 0.5) col = mix(vec3(0.06, 0.26, 0.92), vec3(1.0, 0.82, 0.12), smoothstep(0.5, 0.75, edge));
        if (tail) col = mix(vec3(1.0, 0.82, 0.10), vec3(0.02), smoothstep(0.70, 0.78, abs(v)) + smoothstep(0.12, 0.0, edge) * 0.8);
        scaleK = 0.2; iris = vec3(0.05, 0.10, 0.25);
      #elif SP == 2
        // カクレクマノミ: だいだい色に、黒く縁どられた白い帯が3本
        col = vec3(1.0, 0.40, 0.04);
        float b1 = abs(z - (0.30 - 0.06 * y / 0.15)) - 0.032;
        float b2 = abs(z - (0.02 + 0.05 * (1.0 - pow(y / 0.16, 2.0)))) - 0.04;
        float b3 = abs(z + 0.25) - 0.022;
        float bd = min(min(b1, b2), b3);
        if (body || fin) {
          col = mix(col, vec3(0.02), 1.0 - smoothstep(0.006, 0.006 + aa, bd));
          col = mix(col, vec3(0.97), 1.0 - smoothstep(-aa, 0.0, bd));
        }
        if (fin || tail) col = mix(col, vec3(0.03), smoothstep(0.78, 0.84, edge)) ;
        if (tail) col = mix(vec3(1.0, 0.42, 0.05), vec3(0.03), smoothstep(0.80, 0.86, edge));
        scaleK = 0.25; iris = vec3(0.95, 0.45, 0.05);
      #elif SP == 3
        // ブダイ: 青緑の体に桃色のうろこの縁、くちばし、目のまわりの縞
        col = vec3(0.14, 0.66, 0.58);
        if (body) {
          col = mix(col, vec3(0.42, 0.82, 0.76), smoothstep(0.30, 0.40, z));
          col = mix(col, vec3(0.95, 0.55, 0.62), band(y, -0.02 + (z - 0.34) * 0.35, 0.006, aa) * step(0.34, z));
          col = mix(col, vec3(0.95, 0.55, 0.62), band(y, 0.075 + (z - 0.34) * 0.10, 0.005, aa) * step(0.36, z));
          col = mix(col, vec3(0.85, 0.92, 0.86), smoothstep(0.475, 0.485, z));
        }
        if (fin) col = mix(vec3(0.92, 0.48, 0.60), vec3(0.18, 0.48, 0.95), smoothstep(0.70, 0.80, edge));
        if (tail) col = mix(vec3(0.92, 0.50, 0.62), vec3(0.18, 0.50, 0.95), max(smoothstep(0.62, 0.72, abs(v)), smoothstep(0.80, 0.88, edge)));
        scaleK = 1.0; iris = vec3(0.95, 0.75, 0.25);
      #elif SP == 4
        // ギンガメアジ: 銀色。背は暗く、えらぶたに黒い点、尾の付け根にとげのある うろこ（稜鱗）
        col = mix(vec3(0.84, 0.86, 0.89), vec3(0.20, 0.25, 0.31), smoothstep(0.05, 0.75, v));
        if (body) {
          col = mix(col, vec3(0.03), disc(q, vec2(0.31, 0.075), 0.013, aa));
          col *= 1.0 - 0.30 * band(y, 0.0, 0.010, aa) * (1.0 - smoothstep(-0.10, -0.05, z));
        }
        if (fin) col = vInfo.b > 0.5 ? vec3(0.70, 0.72, 0.70) : mix(vec3(0.22, 0.26, 0.30), vec3(0.08, 0.09, 0.11), edge);
        if (tail) col = vec3(0.20, 0.24, 0.28) * (1.0 - 0.4 * edge);
        shine = 1.6; scaleK = 0.25; iris = vec3(0.80, 0.80, 0.70);
      #else
        // チョウチョウウオ: 前は白、後ろは黄色。目を通る黒い帯、斜めの細い線、背びれの後ろに目玉模様
        col = mix(vec3(0.98, 0.96, 0.88), vec3(1.0, 0.80, 0.08), smoothstep(-0.05, 0.08, -(z - 0.05) - y * 0.6));
        if (body) {
          float ln = band(fract((z * 0.7 - y) * 18.0), 0.5, 0.08, fwidth((z * 0.7 - y) * 18.0)) * smoothstep(0.02, -0.06, -(z - 0.05) - y * 0.6);
          col = mix(col, vec3(0.30, 0.28, 0.25), ln * 0.6);
          col = mix(col, vec3(0.03), band(z, eye.x, 0.022, aa));
          col = mix(col, vec3(0.10), smoothstep(0.50, 0.53, z));
        }
        if (fin || tail) col = mix(vec3(1.0, 0.82, 0.10), vec3(0.05), band(edge, 0.82, 0.04, 0.03));
        if (fin && y > 0.0) {
          float es = length(q - vec2(-0.16, 0.235));
          col = mix(col, vec3(0.98), 1.0 - smoothstep(0.034, 0.036 + aa, es));
          col = mix(col, vec3(0.02), 1.0 - smoothstep(0.026, 0.028 + aa, es));
        }
        scaleK = 0.3; iris = vec3(0.10);
      #endif
      if (part == 2) {
        // 目: 黒い瞳、色のついた虹彩、まわりは体より暗い
        float g = edge;
        col = mix(iris, vec3(0.01), 1.0 - smoothstep(0.20, 0.23, g));
        col = mix(col, vec3(0.08, 0.08, 0.09), smoothstep(0.36, 0.40, g));
        shine = 3.0; scaleK = 0.0;
      }
      // うろこ: 少しずらして並べた丸の縁を暗く（遠くでは消す）
      if (body && scaleK > 0.0) {
        vec2 sq = vec2(z, y) * 70.0;
        sq.y += 0.5 * mod(floor(sq.x), 2.0);
        vec2 f = fract(sq) - vec2(0.0, 0.5);
        float e = smoothstep(0.75, 1.0, length(f * vec2(1.0, 0.9)));
        float k = clamp(1.0 - fwidth(sq.x) * 4.0, 0.0, 1.0);
        #if SP == 3
          col = mix(col, vec3(0.95, 0.55, 0.62), e * k * 0.55);
        #else
          col *= 1.0 - 0.14 * scaleK * e * k;
        #endif
      }
      if (vInfo.b > 0.5 && SP != 1) col = mix(col, col * 1.15 + 0.05, 0.6 * edge);
      // ひれは薄くて光が透ける。ふちほど薄い
      if (fin || tail) col *= 0.88 + 0.12 * edge;
      vec3 light = lightAt(vWorld, N);
      if (fin || tail) light += sunCol * 0.30 * max(dot(-N, ld), 0.0);
      if (vInfo.b > 0.5) light = mix(light, ambCol * 1.05 + sunCol * 0.45, 0.65);      // 胸びれは薄く透けるので、向きで暗くならない
      float dpt = length(vWorld.xy) - COL_R;
      if (dpt > 0.1) {
        float ck = smoothstep(0.1, 1.0, dpt) * exp(-dpt / 16.0);
        light += sunCol * caustic(vWorld.xz / 9.0, time * 0.7) * ck * 0.6 * max(dot(N, -normalize(vec3(vWorld.xy, 0.0))), 0.0);
        light *= mix(vec3(1.0), exp(-dpt * vec3(0.09, 0.03, 0.02)), smoothstep(0.0, 0.6, dpt));
      }
      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      vec3 c = col * vTint * light + sunCol * pow(max(dot(reflect(-ld, N), V), 0.0), 50.0) * 0.5 * shine
             + (ambCol * 0.8 + sunCol * 0.2) * fres * 0.20 * shine;
      gl_FragColor = vec4(c, 1.0);
      #include <fog_fragment>
    }`;

  const schools = [];
  function buildFish(scene) {
    FISH.forEach(function (sp, k) {
      const S = SHAPE[k];
      const mat = COL.GL.material(fishVS, fishFS, { amp: { value: S.amp }, eye: { value: new THREE.Vector3(fishZ(S.eye[0]), S.eye[1], S.eye[2]) } },
                                  { vertexColors: true, side: THREE.DoubleSide, defines: { SP: k } });
      sp.d = dynMesh(scene, SCHOOLS * FPER, false, fishGeo(S), mat);
      sp.d.mesh.count = 0;
      sp.freq = S.freq;
    });
    COL.fishKinds = FISH;
    for (let k = 0; k < SCHOOLS; k++) schools.push({ on: false });
  }
  function updateFish(dt, lc, pz) {
    if (COL.fishFreeze) return;
    const near = lc && lc.index === 0 && pz > 23800 && COL.waterSdf(0, lc.u, pz) < 220;
    const cnt = FISH.map(function () { return 0; });
    for (let k = 0; k < SCHOOLS; k++) {
      const sc = schools[k];
      if (!near) { sc.on = false; continue; }
      if (!sc.on || Math.hypot(sc.u - lc.u, sc.z - pz) > 140) {
        // 近くの、サンゴの多い浅い所に群れを置き直す
        sc.on = false;
        for (let t = 0; t < 8 && !sc.on; t++) {
          const ang = rand() * TAU, rr = 10 + rand() * 80, u = lc.u + Math.cos(ang) * rr, z = pz + Math.sin(ang) * rr;
          const g = COL.groundH(COL.landTheta(0, u), z), dep = -g;
          if (dep < 1.6 || dep > 20 || COL.waterSdf(0, u, z) > -8 || COL.reefAt(u, z) < 0.45) continue;
          const si = (k + Math.floor(rand() * 3)) % FISH.length, sp = FISH[si];
          sc.on = true; sc.u = u; sc.z = z; sc.si = si; sc.cnt = Math.min(FPER, sp.n + Math.floor(rand() * 3));
          sc.rad = 1.5 + rand() * (sp.n > 6 ? 6 : 3); sc.w = (0.25 + rand() * 0.3) * (rand() < 0.5 ? 1 : -1) * (sp.s > 0.45 ? 0.6 : 1);
          sc.ph = rand() * TAU; sc.y = g + 0.6 + rand() * Math.min(4, dep - 1.6);
        }
        if (!sc.on) continue;
      }
      const sg = Math.sign(sc.w), sp = FISH[sc.si], d = sp.d;
      for (let f = 0; f < sc.cnt; f++) {
        const a = sc.ph + clock * sc.w - f * 0.22 * sg + Math.sin(f * 2.3) * 0.15;
        const rad = sc.rad * (0.7 + 0.3 * Math.sin(f * 1.9)) + Math.sin(clock * 0.6 + f) * 0.3;
        const u = sc.u + Math.cos(a) * rad, z = sc.z + Math.sin(a) * rad, th = COL.landTheta(0, u), fr = COL.frameAt(th);
        const dy = Math.cos(clock * 0.8 + f) * 0.2;
        const y = Math.min(-0.45, sc.y + Math.sin(f * 1.7) * 0.5 + Math.sin(clock * 0.8 + f) * 0.25);
        // 進む向き（輪の接線）。浮き沈みに合わせて少し頭を上げ下げし、曲がる内側へ少し傾く
        const Zc = V.norm(V.add(V.mul(fr.east, -Math.sin(a) * sg), [0, 0, Math.cos(a) * sg]));
        const Zp = V.norm(V.add(Zc, V.mul(fr.up, dy * 0.25))), X0 = V.norm(V.cross(fr.up, Zp));
        const bank = 0.18 * sg, Y = V.norm(V.add(V.mul(V.cross(Zp, X0), Math.cos(bank)), V.mul(X0, Math.sin(bank)))), X = V.cross(Y, Zp);
        const s = sp.s * (0.85 + 0.3 * Math.abs(Math.sin(f * 3.7))), P = COL.toWorld(th, z, y), n = cnt[sc.si]++;
        put(d, n, P, X, Y, Zp, 0, 0, 0, s, s, s);
        const id = k * FPER + f;
        d.parm[n * 4 + 1] = (id * 0.6180339) % 1; d.parm[n * 4 + 2] = sp.freq * (0.9 + 0.2 * ((id * 0.37) % 1));
        const tint = 0.9 + 0.2 * ((id * 0.7548777) % 1);
        d.col[n * 3] = d.col[n * 3 + 1] = d.col[n * 3 + 2] = tint;
      }
    }
    FISH.forEach(function (sp, k) {
      const m = sp.d.mesh;
      m.count = cnt[k];
      if (cnt[k]) {
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
        m.geometry.attributes.iparm.needsUpdate = true;
      }
    });
  }
  // 確認用: 目の前に全種類を1匹ずつ横に並べる（?fish=1）
  COL.debugFish = function (p, only) {
    COL.fishFreeze = true;
    const V0 = COL.V, r = V0.cross(p.fwd, p.up);
    FISH.forEach(function (sp, k) {
      const one = only !== undefined, P = V0.add(V0.add(V0.add(p.pos, V0.mul(p.up, COL.EYE)), V0.mul(p.fwd, one ? 0.55 : 2.2)), V0.mul(r, one ? 0 : (k - 2.5) * 0.62));
      if (one && k !== only) { sp.d.mesh.count = 0; return; }
      put(sp.d, 0, P, V0.mul(p.fwd, -1), p.up, V0.mul(r, -1), 0, 0, 0, 0.5, 0.5, 0.5);
      sp.d.parm[2] = sp.freq; sp.d.parm[1] = k * 0.17; sp.d.col[0] = sp.d.col[1] = sp.d.col[2] = 1;
      sp.d.mesh.count = 1;
      sp.d.mesh.instanceMatrix.needsUpdate = sp.d.mesh.instanceColor.needsUpdate = sp.d.mesh.geometry.attributes.iparm.needsUpdate = true;
    });
  };

  // ================= 鳥 =================
  const FLOCKS = 5, PER = 8;
  let birdD = null;
  const flocks = [];
  function buildBirds(scene) {
    birdD = dynMesh(scene, FLOCKS * PER * 2, false);
    for (let k = 0; k < FLOCKS; k++) {
      flocks.push({ on: false });
      for (let b = 0; b < PER * 2; b++) setLook(birdD, k * PER * 2 + b, [0.2, 0.2, 0.22], 3);
    }
  }
  function updateBirds(dt, lc, pz, night) {
    for (let k = 0; k < FLOCKS; k++) {
      const fl = flocks[k];
      if (!lc || night > 0.6) { fl.on = false; hide(birdD, k * PER * 2, PER * 2); continue; }
      if (!fl.on || fl.i !== lc.index || Math.hypot(fl.u - lc.u, fl.z - pz) > 900) {
        // 近くの空に群れを置き直す。水辺の群れは白い鳥
        const ang = rand() * TAU, rr = 150 + rand() * 450;
        fl.i = lc.index; fl.u = Math.max(-COL.LAND_HW + 150, Math.min(COL.LAND_HW - 150, lc.u + Math.cos(ang) * rr));
        fl.z = Math.max(COL.TERRAIN_Z0 + 200, Math.min(COL.L - 150, pz + Math.sin(ang) * rr));
        fl.rad = 50 + rand() * 110; fl.w = (0.10 + rand() * 0.10) * (rand() < 0.5 ? 1 : -1); fl.hh = 28 + rand() * 60; fl.ph = rand() * TAU;
        const white = COL.waterSdf(fl.i, fl.u, fl.z) < 250, col = white ? [0.95, 0.95, 0.93] : [0.16, 0.16, 0.18];
        for (let b = 0; b < PER * 2; b++) setLook(birdD, k * PER * 2 + b, col, 3);
        birdD.mesh.instanceColor.needsUpdate = true;
        fl.on = true;
      }
      for (let b = 0; b < PER; b++) {
        const a = fl.ph + clock * fl.w + b * 0.16 * Math.sign(fl.w) * -1 + Math.sin(b * 2.3) * 0.1;
        const rad = fl.rad + Math.sin(b * 1.7) * 9, u = fl.u + Math.cos(a) * rad, z = fl.z + Math.sin(a) * rad;
        const th = COL.landTheta(fl.i, u), f = COL.frameAt(th);
        const h = Math.max(COL.groundH(th, z), 0) + fl.hh + Math.sin(clock * 0.5 + b) * 4 + Math.cos(b * 3.1) * 5;
        const sg = Math.sign(fl.w);
        const Z = V.norm(V.add(V.mul(f.east, -Math.sin(a) * sg), [0, 0, Math.cos(a) * sg]));
        const X = V.cross(f.up, Z), flap = Math.sin(clock * 9 + b * 1.3) * 0.75, cf = Math.cos(flap), sf = Math.sin(flap);
        const P = COL.toWorld(th, z, h), n = (k * PER + b) * 2;
        // 左右の翼: 胴を軸に上下へ振る
        const XL = V.add(V.mul(X, -cf), V.mul(f.up, sf)), XR = V.add(V.mul(X, cf), V.mul(f.up, sf));
        put(birdD, n, P, XL, f.up, Z, 0.45, 0, 0, 0.9, 0.05, 0.34);
        put(birdD, n + 1, P, XR, f.up, Z, 0.45, 0, 0, 0.9, 0.05, 0.34);
      }
    }
    birdD.mesh.instanceMatrix.needsUpdate = true;
  }

  COL.buildLife = function (scene) {
    Kit = COL.CityKit;
    rand = COL.rng(777);
    buildAgents(scene);
    buildBirds(scene);
    buildFish(scene);
  };
  COL.debugPeople = false;
  COL.updateLife = function (dt, p) {
    clock += dt;
    const c = COL.toCyl(p.pos), lc = c.z > COL.TERRAIN_Z0 ? COL.landCoord(c.theta) : null, night = COL.GL.U.night.value;
    const lite = COL.lifeScale !== undefined && COL.lifeScale < 0.3;       // 最軽量: 鳥と魚は出さない
    updateAgents(dt, lc, c.z, night);
    updateBirds(dt, lc, c.z, lite ? 1 : night);
    updateFish(dt, lite ? null : lc, c.z);
    if (COL.debugPeople && lc) {                       // 目の前に12人を横一列に並べて歩く姿勢を見る
      for (let n = 0; n < 12; n++) {
        const th = COL.landTheta(lc.index, lc.u - 6.6 + n * 1.2), z = c.z + 5.5, f = COL.frameAt(th);
        pose(n, { P: COL.toWorld(th, z, COL.groundH(th, z)), X: V.mul(f.east, -1), Y: f.up, Z: [0, 0, -1] }, people[n], clock * 5 + n * 0.9);
      }
    }
  };
})();
