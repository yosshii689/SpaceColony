// コロニーの諸元と、円筒世界の座標・移動の計算（描画に依存しない）
// 座標系: 中心軸 = ワールドZ軸（z: 0〜L）。地表は軸からの距離 r = R の円筒面。
//         「上」は常に中心軸の方向。θ = atan2(y, x)。
(function (g) {
  'use strict';
  const COL = g.COL = g.COL || {};

  COL.R = 3250;                 // 半径 [m]
  COL.L = 30000;                // 全長 [m]
  COL.G = 9.81;                 // 地表の重力 [m/s^2]
  COL.OMEGA = Math.sqrt(COL.G / COL.R);          // 自転の角速度 [rad/s]
  COL.PERIOD = 2 * Math.PI / COL.OMEGA;          // 自転周期 [s]（約114秒）
  COL.STRIP = Math.PI / 3;                       // 陸地・窓 1枚ぶんの角度（60°）
  COL.THETA0 = -2 * Math.PI / 3;                 // 陸地Aの始まる角度（陸地Aの中央が真下 -90°）
  COL.EYE = 1.7;                                 // 目の高さ [m]
  COL.LAND_NAMES = ['陸地A', '陸地B', '陸地C'];

  const TAU = Math.PI * 2;
  const mod = (a, n) => ((a % n) + n) % n;

  // ---- 小さなベクトル演算（[x, y, z] の配列） ----
  const V = COL.V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };

  // ---- 円筒座標 ----
  // (θ, z, h) → ワールド座標。h は地表からの高さ。
  COL.toWorld = function (theta, z, h) {
    const r = COL.R - (h || 0);
    return [r * Math.cos(theta), r * Math.sin(theta), z];
  };
  // ワールド座標 → { theta, z, h, r }
  COL.toCyl = function (p) {
    const r = Math.hypot(p[0], p[1]);
    return { theta: Math.atan2(p[1], p[0]), z: p[2], h: COL.R - r, r: r };
  };
  // その場所の基底ベクトル。east = 周方向（θが増える向き）、up = 軸の方向、north = +z
  COL.frameAt = function (theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return { east: [-s, c, 0], up: [-c, -s, 0], north: [0, 0, 1] };
  };
  // θ がどの帯にあるか。{ land: true/false, index: 0〜2, name }
  COL.stripAt = function (theta) {
    const i = Math.floor(mod(theta - COL.THETA0, TAU) / COL.STRIP) % 6;
    const land = i % 2 === 0;
    const index = Math.floor(i / 2);
    return { land: land, index: index, name: land ? COL.LAND_NAMES[index] : '窓' + 'ABC'[index] };
  };
  // 陸地 index の中央の角度
  COL.landCenter = function (index) {
    return COL.THETA0 + COL.STRIP * (index * 2 + 0.5);
  };
  // 宇宙港側の端は、中心へ向かってせり上がる山。軸からの距離 r での山肌の z 位置を返す
  COL.HUB_R = 300;               // 宇宙港ドックの半径 [m]
  COL.DOCK_LEN = 900;            // ドックの奥行き [m]（z = -900〜0。奥の口の先は宇宙）
  COL.CAP_DEPTH = 1800;          // 山のすそ野が張り出す長さ [m]
  COL.capZ = function (r) {
    if (r <= COL.HUB_R) return 0;
    const s = Math.min(1, (r - COL.HUB_R) / (COL.R - COL.HUB_R));
    return COL.CAP_DEPTH * Math.pow(s, 3.5);
  };
  // 軸からの距離 r での重力の強さ [m/s^2]
  COL.gravityAt = function (r) { return COL.G * Math.min(r, COL.R) / COL.R; };

  // シード付き乱数（mulberry32）
  COL.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // ---- プレイヤー ----
  COL.SPEED = { walk: 5, run: 12, swim: 2.5, swimFast: 5, fly: 60, flyFast: 400, dock: 14, dockFast: 45, jump: 5 };

  COL.createPlayer = function (theta, z, h) {
    const f = COL.frameAt(theta);
    return {
      pos: COL.toWorld(theta, z, h || 0),   // 足元の位置
      vel: [0, 0, 0],
      up: f.up,
      fwd: f.north,                          // 水平な向き（上と直交する単位ベクトル）
      pitch: 0,                              // 見上げ角 [rad]
      fly: false,
      grounded: false,
    };
  };

  const PITCH_MAX = Math.PI / 2 - 0.01;

  // 視線の向き（ピッチ込み）
  COL.lookDir = function (p) {
    return V.add(V.mul(p.fwd, Math.cos(p.pitch)), V.mul(p.up, Math.sin(p.pitch)));
  };
  COL.eyePos = function (p) { return V.add(p.pos, V.mul(p.up, COL.EYE)); };

  // 「上」を現在位置に合わせ直し、向きを新しい地面に沿わせる
  function reorient(p, dt) {
    const r = Math.hypot(p.pos[0], p.pos[1]);
    if (r > 0.5) {
      const target = [-p.pos[0] / r, -p.pos[1] / r, 0];
      if (r >= 300) {
        p.up = target;
      } else {
        // 軸のすぐ近くでは「上」が急に反転するので、ゆっくり追従させる。
        // 視線の向きはそのまま保つ（軸をまっすぐ通り抜けられるように）。
        const dir = COL.lookDir(p);
        const k = r / 300;
        const u = V.lerp(p.up, target, k * k);
        if (V.len(u) > 1e-4) p.up = V.norm(u);
        p.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.asin(Math.max(-1, Math.min(1, V.dot(dir, p.up))))));
        const flat = V.sub(dir, V.mul(p.up, V.dot(dir, p.up)));
        if (V.len(flat) > 1e-3) p.fwd = V.norm(flat);
      }
    }
    let f = V.sub(p.fwd, V.mul(p.up, V.dot(p.fwd, p.up)));
    if (V.len(f) < 1e-6) f = V.cross(p.up, [1, 0, 0]);
    if (V.len(f) < 1e-6) f = V.cross(p.up, [0, 1, 0]);
    p.fwd = V.norm(f);
  }

  // 地面の高さと水（terrain.js が無いときは真っ平ら）
  // ドックの中（z < 0）では、ドックの内壁が「地面」になる
  const DOCK_FLOOR = COL.R - (COL.HUB_R - 0.6);
  const terrainAt = function (pos) {
    if (pos[2] < 0) return DOCK_FLOOR;
    return COL.groundH ? COL.groundH(Math.atan2(pos[1], pos[0]), pos[2]) : 0;
  };
  // 立てる面の高さ: 地形か、足元より 1m 以内の高さにある屋上・桟橋（city.js の COL.solidTop）の高い方
  const groundAt = function (pos) {
    if (pos[2] < 0) return DOCK_FLOOR;
    const th = Math.atan2(pos[1], pos[0]), g = COL.groundH ? COL.groundH(th, pos[2]) : 0;
    if (!COL.solidTop) return g;
    return Math.max(g, COL.solidTop(th, pos[2], COL.R - Math.hypot(pos[0], pos[1])));
  };
  const waterAtPos = function (pos) { return COL.waterAt ? COL.waterAt(Math.atan2(pos[1], pos[0]), pos[2]) : null; };
  const MAX_SLOPE = 1.25;        // これより急な上り坂は歩いて登れない（約51°）
  const HEAD = 1.85;            // 足元から頭のてっぺんまで
  const FLOAT_DEPTH = 1.45;      // 泳いでいるときの、水面から足元までの深さ（目が水面の少し上に出る）

  // 1ステップ進める。
  // input: { f: 前後(-1〜1), s: 左右(-1〜1), ud: 上下(-1〜1, 飛行時。水泳中は負で潜る), run, jump, yaw, pitch(このステップの回転量 rad) }
  COL.stepPlayer = function (p, input, dt) {
    // 視点の回転
    if (input.yaw) {
      const right = V.cross(p.fwd, p.up);
      p.fwd = V.norm(V.add(V.mul(p.fwd, Math.cos(input.yaw)), V.mul(right, Math.sin(input.yaw))));
    }
    if (input.pitch) p.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, p.pitch + input.pitch));

    const right = V.cross(p.fwd, p.up);
    const r0 = Math.hypot(p.pos[0], p.pos[1]);
    const gh0 = groundAt(p.pos), h0 = COL.R - r0;
    const wasGrounded = h0 <= gh0 + 1e-3;
    p.grounded = wasGrounded;
    const S = COL.SPEED;
    const old = p.pos;

    // 水泳: 足のつかない深さで、体が水に浸かっているとき
    const water = p.fly ? null : waterAtPos(p.pos);
    const floatH = water ? water.level - FLOAT_DEPTH : 0;
    p.swim = !!water && water.depth > FLOAT_DEPTH && h0 <= floatH + 0.3;
    let jumped = false;

    if (p.fly) {
      // ドックの中と入口付近はゆっくり漂う
      const inDock = p.pos[2] < 40 && r0 < COL.HUB_R + 80;
      const sp = inDock ? (input.run ? S.dockFast : S.dock) : (input.run ? S.flyFast : S.fly);
      const dir = COL.lookDir(p);
      let t = V.add(V.add(V.mul(dir, input.f || 0), V.mul(right, input.s || 0)), V.mul(p.up, input.ud || 0));
      const tl = V.len(t);
      t = tl > 1 ? V.mul(t, sp / tl) : V.mul(t, sp);
      p.vel = V.lerp(p.vel, t, Math.min(1, dt * 6));
    } else {
      const sp = p.swim ? (input.run ? S.swimFast : S.swim) : (input.run ? S.run : S.walk);
      let t = V.add(V.mul(p.fwd, input.f || 0), V.mul(right, input.s || 0));
      const tl = V.len(t);
      t = tl > 1 ? V.mul(t, sp / tl) : V.mul(t, sp);
      let vUp = V.dot(p.vel, p.up);
      const horiz = V.sub(p.vel, V.mul(p.up, vUp));
      const h2 = V.lerp(horiz, t, Math.min(1, dt * (p.swim ? 4 : p.grounded ? 12 : 3)));
      if (p.swim) {
        // 浮力で水面へ戻る。下降キーを押している間は潜る
        const want = (input.ud || 0) < 0 ? -2 : Math.max(-2, Math.min(2, (floatH - h0) * 4));
        vUp += (want - vUp) * Math.min(1, dt * 6);
      } else {
        vUp -= COL.gravityAt(r0) * dt;
        if (p.grounded) {
          if (vUp < 0) vUp = 0;
          if (input.jump) { vUp = S.jump; jumped = true; }
        }
      }
      p.vel = V.add(h2, V.mul(p.up, vUp));
    }

    p.pos = V.add(p.pos, V.mul(p.vel, dt));

    // 両端の壁（地面の判定より先に行う。そうしないと、山肌を突き抜けた瞬間にドックの中へ引き込まれる）
    {
      const r1 = Math.hypot(p.pos[0], p.pos[1]);
      // 宇宙港側: 山肌が壁。中心のドックの口（半径 300m 未満）からは奥まで入れる
      const zMin = (r1 < COL.HUB_R - 0.3 || old[2] < 0) ? -COL.DOCK_LEN + 3 : COL.capZ(Math.min(r1, COL.R)) + 1;
      if (p.pos[2] < zMin) { p.pos[2] = zMin; if (p.vel[2] < 0) p.vel[2] = 0; }
      if (p.pos[2] > COL.L - 1) { p.pos[2] = COL.L - 1; if (p.vel[2] > 0) p.vel[2] = 0; }
    }

    // 天井（駅の屋根・ひさし・橋の下など）に頭が当たったら止まる
    if (COL.solidCeil) {
      const r1 = Math.hypot(p.pos[0], p.pos[1]), ceil = COL.solidCeil(Math.atan2(p.pos[1], p.pos[0]), p.pos[2], h0);
      if (COL.R - r1 + HEAD > ceil) {
        const k = (COL.R - (ceil - HEAD)) / r1;
        p.pos[0] *= k; p.pos[1] *= k;
        const vUp = V.dot(p.vel, p.up);
        if (vUp > 0) p.vel = V.sub(p.vel, V.mul(p.up, vUp));
      }
    }

    // 建物の壁にはめり込まない（壁に沿って横へ押し出す）
    if (COL.pushOut) COL.pushOut(p.pos);

    // 急すぎる上り坂には進めない（その場にとどまり、上下の動きだけ残す）
    const tg = terrainAt(p.pos), tg0 = terrainAt(old);
    if (!p.fly && tg > tg0) {
      const dist = Math.hypot(p.pos[0] - old[0], p.pos[1] - old[1], p.pos[2] - old[2]);
      if (tg - Math.max(tg0, h0) > dist * MAX_SLOPE + 0.05 && COL.R - Math.hypot(p.pos[0], p.pos[1]) < tg) {
        const vUp = V.dot(p.vel, p.up);
        p.vel = V.mul(p.up, vUp);
        p.pos = V.add(old, V.mul(p.vel, dt));
      }
    }
    const gh = groundAt(p.pos);

    // 地面より下へは行けない。下り坂では地面に沿って降りる
    let r = Math.hypot(p.pos[0], p.pos[1]);
    const rg = COL.R - gh;
    let onGround = r >= rg;
    if (!onGround && wasGrounded && !jumped && !p.fly && !p.swim) {
      const dist = Math.hypot(p.pos[0] - old[0], p.pos[1] - old[1], p.pos[2] - old[2]);
      if (rg - r < dist * 1.5 + 0.1) onGround = true;
    }
    if (onGround && r > 1e-6) {
      const k = rg / r;
      p.pos[0] *= k; p.pos[1] *= k;
      r = rg;
    }
    reorient(p, dt);

    if (onGround) {
      const vUp = V.dot(p.vel, p.up);
      if (vUp < 0) p.vel = V.sub(p.vel, V.mul(p.up, vUp));
      p.grounded = true;
    } else {
      p.grounded = false;
    }
    return p;
  };

  // ---- 車（召喚式）----
  COL.CAR_MAX = 50;              // 最高速 180 km/h [m/s]
  COL.createCar = function (pos, fwd) {
    const c = { pos: pos.slice(), up: [0, 0, 1], fwd: fwd.slice(), speed: 0 };
    return COL.stepCar(c, {}, 0);
  };
  // input: { throttle: 前進(+1)〜後退(-1), steer: 右(+1)〜左(-1), brake }
  COL.stepCar = function (c, input, dt) {
    const MAX = COL.CAR_MAX, th = input.throttle || 0;
    let v = c.speed;
    // 向き: 速いほど曲がりにくい。止まっているときは曲がらない
    const r0 = Math.hypot(c.pos[0], c.pos[1]) || 1;
    c.up = [-c.pos[0] / r0, -c.pos[1] / r0, 0];
    let f = V.sub(c.fwd, V.mul(c.up, V.dot(c.fwd, c.up)));
    f = V.len(f) > 1e-6 ? V.norm(f) : [0, 0, 1];
    // 低速では小回り（最小半径 約4m）、最高速でも毎秒 約25°曲がれる
    const w = (input.steer || 0) * Math.min(2.4, 22 / Math.max(Math.abs(v), 2)) * Math.min(1, Math.abs(v) / 0.8) * (v >= 0 ? 1 : -1) * dt;
    if (w) { const right = V.cross(f, c.up); f = V.norm(V.add(V.mul(f, Math.cos(w)), V.mul(right, Math.sin(w)))); }
    c.fwd = f;
    // 加速・減速
    let a;
    if (input.brake) a = -Math.sign(v) * Math.min(Math.abs(v) / Math.max(dt, 1e-6), 16);
    else if (th > 0) a = v >= 0 ? 6.5 * (1 - v / MAX) * th : 14;
    else if (th < 0) a = v > 0.5 ? -14 : -4 * (1 + v / 12);
    else a = -Math.sign(v) * Math.min(Math.abs(v) / Math.max(dt, 1e-6), 1.0 + 0.03 * Math.abs(v));
    v = Math.max(-12, Math.min(MAX, v + a * dt));

    const old = c.pos, h0 = COL.R - r0;
    let np = V.add(old, V.mul(f, v * dt)), hit = false;
    if (COL.pushOut) { const before = np.slice(); COL.pushOut(np); if (np[0] !== before[0] || np[2] !== before[2]) hit = true; }
    // 両端の壁、深い水、急な坂には入れない
    const zMin = COL.capZ(COL.R) + 4;
    if (np[2] < zMin) { np[2] = zMin; hit = true; }
    if (np[2] > COL.L - 4) { np[2] = COL.L - 4; hit = true; }
    const water = waterAtPos(np), dist = Math.hypot(np[0] - old[0], np[1] - old[1], np[2] - old[2]);
    const onDeck = COL.solidTop ? COL.solidTop(Math.atan2(np[1], np[0]), np[2], h0) > -1e8 : false;
    if ((water && water.depth > 0.7 && !onDeck) || terrainAt(np) - terrainAt(old) > dist * 0.9 + 0.3) { np = old.slice(); v = 0; }
    else if (hit) v *= 0.4;
    // 地面（橋の上なども含む）に乗せる
    const r = Math.hypot(np[0], np[1]) || 1, k = (COL.R - groundAt(np)) / r;
    np[0] *= k; np[1] *= k;
    c.pos = np; c.speed = v;
    c.up = [-np[0] / (r * k), -np[1] / (r * k), 0];
    c.fwd = V.norm(V.sub(c.fwd, V.mul(c.up, V.dot(c.fwd, c.up))));
    return c;
  };
})(typeof window !== 'undefined' ? window : globalThis);
