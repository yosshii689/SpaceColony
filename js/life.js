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
  let carD = null, limbD = null, ballD = null, shoeD = null;
  const cars = [], people = [];

  function buildAgents(scene) {
    carD = dynMesh(scene, CARS * CAR_PARTS, true);
    for (let n = 0; n < CARS; n++) {
      const c = { on: false, speed: 11 + (n % 5) * 1.2, long: n % 9 === 0 };
      cars.push(c);
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
      if (!c.on) { hide(carD, n * 4, 4); continue; }
      const f = agentFrame(c), len = c.long ? 7.5 : 4.3, hgt = c.long ? 2.3 : 0.62;
      put(carD, n * 4, f.P, f.X, f.Y, f.Z, 0, 0.28, 0, c.long ? 2.3 : 1.8, hgt, len);
      put(carD, n * 4 + 1, f.P, f.X, f.Y, f.Z, 0, 0.28 + hgt, c.long ? len / 2 - 1.1 : -0.3, c.long ? 2.2 : 1.6, c.long ? 0.05 : 0.52, c.long ? 1.6 : 2.2);
      put(carD, n * 4 + 2, f.P, f.X, f.Y, f.Z, 0, 0.55, len / 2, 1.5, 0.14, 0.06);
      put(carD, n * 4 + 3, f.P, f.X, f.Y, f.Z, 0, 0.58, -len / 2, 1.5, 0.12, 0.06);
    }
    carD.mesh.instanceMatrix.needsUpdate = true;
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
  //  群れごとに種類を決め、サンゴの多い浅い所を輪を描くように泳ぐ。体と尾びれを別に動かして、尾を振って泳ぐ
  const SCHOOLS = 10, FPER = 10;
  const FISH = [
    { name: 'キイロハギ', body: [1.0, 0.86, 0.10], tail: [1.0, 0.86, 0.10], s: 0.34, n: 8 },
    { name: 'ナンヨウハギ', body: [0.10, 0.32, 0.95], tail: [1.0, 0.82, 0.12], s: 0.36, n: 7 },
    { name: 'カクレクマノミ', body: [1.0, 0.45, 0.08], tail: [1.0, 1.0, 1.0], s: 0.22, n: 4 },
    { name: 'ブダイ', body: [0.25, 0.78, 0.72], tail: [0.95, 0.45, 0.72], s: 0.55, n: 3 },
    { name: 'ギンガメアジ', body: [0.80, 0.84, 0.90], tail: [0.62, 0.66, 0.74], s: 0.48, n: 10 },
    { name: 'チョウチョウウオ', body: [0.98, 0.95, 0.80], tail: [0.98, 0.80, 0.10], s: 0.28, n: 6 },
  ];
  let fishB = null, fishT = null;
  const schools = [];
  // 頂点の列から、外向きの法線をつけた形を作る
  function faceted(tris, center) {
    const pos = [], nrm = [];
    for (let k = 0; k < tris.length; k += 3) {
      let a = tris[k], b = tris[k + 1], c = tris[k + 2], nn = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
      const m = V.mul(V.add(V.add(a, b), c), 1 / 3);
      if (center && V.dot(nn, V.sub(m, center)) < 0) { const t = b; b = c; c = t; nn = V.mul(nn, -1); }
      [a, b, c].forEach(function (q) { pos.push(q[0], q[1], q[2]); nrm.push(nn[0], nn[1], nn[2]); });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  }
  function buildFish(scene) {
    // 体: 横に平たいひし形（長さ 1、鼻先が +Z）
    const Nz = [0, 0, 0.5], Tz = [0, 0, -0.32], Up = [0, 0.24, 0.03], Dn = [0, -0.2, 0.03], Lf = [-0.075, 0, 0.06], Rt = [0.075, 0, 0.06];
    const body = faceted([Nz, Up, Rt, Nz, Rt, Dn, Nz, Dn, Lf, Nz, Lf, Up, Tz, Rt, Up, Tz, Dn, Rt, Tz, Lf, Dn, Tz, Up, Lf], [0, 0, 0.05]);
    // 尾びれ: 付け根が原点、後ろ（-Z）へ広がる三角形を両面
    const a = [0, 0, 0], b = [0, 0.2, -0.26], c = [0, -0.2, -0.26];
    const tail = faceted([a, b, c, a, c, b], null);
    fishB = dynMesh(scene, SCHOOLS * FPER, false, body, Kit.MAT.box);
    fishT = dynMesh(scene, SCHOOLS * FPER, false, tail, Kit.MAT.box);
    for (let k = 0; k < SCHOOLS; k++) schools.push({ on: false });
    for (let n = 0; n < SCHOOLS * FPER; n++) { setLook(fishB, n, [1, 1, 1], 3); setLook(fishT, n, [1, 1, 1], 3); }
  }
  function updateFish(dt, lc, pz, ph) {
    const near = lc && lc.index === 0 && pz > 23800 && COL.waterSdf(0, lc.u, pz) < 220;
    for (let k = 0; k < SCHOOLS; k++) {
      const sc = schools[k];
      if (!near) { if (sc.on) { hide(fishB, k * FPER, FPER); hide(fishT, k * FPER, FPER); sc.on = false; } continue; }
      if (!sc.on || Math.hypot(sc.u - lc.u, sc.z - pz) > 140) {
        // 近くの、サンゴの多い浅い所に群れを置き直す
        sc.on = false;
        for (let t = 0; t < 8 && !sc.on; t++) {
          const ang = rand() * TAU, rr = 10 + rand() * 80, u = lc.u + Math.cos(ang) * rr, z = pz + Math.sin(ang) * rr;
          const g = COL.groundH(COL.landTheta(0, u), z), dep = -g;
          if (dep < 1.6 || dep > 20 || COL.waterSdf(0, u, z) > -8 || COL.reefAt(u, z) < 0.45) continue;
          const sp = FISH[(k + Math.floor(rand() * 3)) % FISH.length];
          sc.on = true; sc.u = u; sc.z = z; sc.sp = sp; sc.cnt = Math.min(FPER, sp.n + Math.floor(rand() * 3));
          sc.rad = 1.5 + rand() * (sp.n > 6 ? 6 : 3); sc.w = (0.25 + rand() * 0.3) * (rand() < 0.5 ? 1 : -1) * (sp.s > 0.45 ? 0.6 : 1);
          sc.ph = rand() * TAU; sc.y = g + 0.6 + rand() * Math.min(4, dep - 1.6);
          for (let f = 0; f < FPER; f++) { setLook(fishB, k * FPER + f, sp.body, 3); setLook(fishT, k * FPER + f, sp.tail, 3); }
          fishB.mesh.instanceColor.needsUpdate = fishT.mesh.instanceColor.needsUpdate = true;
        }
        if (!sc.on) { hide(fishB, k * FPER, FPER); hide(fishT, k * FPER, FPER); continue; }
      }
      const sg = Math.sign(sc.w), sp = sc.sp;
      for (let f = 0; f < FPER; f++) {
        const n = k * FPER + f;
        if (f >= sc.cnt) { hide(fishB, n, 1); hide(fishT, n, 1); continue; }
        const a = sc.ph + clock * sc.w - f * 0.22 * sg + Math.sin(f * 2.3) * 0.15;
        const rad = sc.rad * (0.7 + 0.3 * Math.sin(f * 1.9)) + Math.sin(clock * 0.6 + f) * 0.3;
        const u = sc.u + Math.cos(a) * rad, z = sc.z + Math.sin(a) * rad, th = COL.landTheta(0, u), fr = COL.frameAt(th);
        const y = Math.min(-0.45, sc.y + Math.sin(f * 1.7) * 0.5 + Math.sin(clock * 0.8 + f) * 0.25);
        // 進む向き（輪の接線）に、体を少しくねらせる
        const wag = Math.sin(clock * (sp.s > 0.45 ? 6 : 10) + f * 1.3), Zc = V.norm(V.add(V.mul(fr.east, -Math.sin(a) * sg), [0, 0, Math.cos(a) * sg]));
        const Xc = V.cross(fr.up, Zc), Zb = V.norm(V.add(Zc, V.mul(Xc, wag * 0.08))), Xb = V.cross(fr.up, Zb);
        const Zt = V.norm(V.add(Zc, V.mul(Xc, -wag * 0.45))), Xt = V.cross(fr.up, Zt);
        const s = sp.s * (0.85 + 0.3 * Math.abs(Math.sin(f * 3.7))), P = COL.toWorld(th, z, y);
        put(fishB, n, P, Xb, fr.up, Zb, 0, 0, 0, s, s, s);
        put(fishT, n, V.add(P, V.mul(Zb, -0.31 * s)), Xt, fr.up, Zt, 0, 0, 0, s, s, s);
      }
    }
    fishB.mesh.instanceMatrix.needsUpdate = true;
    fishT.mesh.instanceMatrix.needsUpdate = true;
  }

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
