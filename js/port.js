// 宇宙港: 中心軸のドック（無重力）、発着する宇宙船、スポーク状のエレベーター
//  - ドックは宇宙港側の山の頂上から外へ伸びる円筒（半径 300m、z = -900〜0）。奥の口の先は宇宙
//  - 宇宙船は時刻から位置を決める（見ていなくても同じ時刻表で動き続ける）
//  - エレベーターは陸地ごとに1本。麓の駅とドック入口を約55秒で結ぶ
(function () {
  'use strict';
  const COL = window.COL, GL = COL.GL, U = GL.U, V = COL.V;
  const R = COL.R, HUB = COL.HUB_R, DL = COL.DOCK_LEN, TAU = Math.PI * 2;
  const clamp01 = function (x) { return Math.min(1, Math.max(0, x)); };
  const smooth = function (x) { x = clamp01(x); return x * x * (3 - 2 * x); };
  const WHITE = [0.90, 0.91, 0.93], GREY = [0.50, 0.52, 0.55], DARK = [0.18, 0.19, 0.22], YELLOW = [0.95, 0.75, 0.12];
  let Kit = null, shipMats = null, clock = 0;

  // 列ベクトル X, Y, Z（大きさ込み）と位置 P から行列を作る
  const m16 = function (X, Y, Z, P) { return [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, P[0], P[1], P[2], 1]; };

  // ドックの内壁に物を置く。th: 周方向の角度, z: 軸方向, hgt: 壁からの高さ。X=周方向, Y=軸へ向かう向き, Z=軸方向
  function dockPart(bag, kind, th, z, hgt, sx, sy, sz, col, style, seed, glow, gi) {
    const f = COL.frameAt(th), rho = HUB - hgt;
    bag.addM(kind, m16(V.mul(f.east, sx), V.mul(f.up, sy), [0, 0, sz], [rho * Math.cos(th), rho * Math.sin(th), z]), col, style, seed, glow, gi);
  }
  // 船の部品。船の座標は X=右, Y=上, Z=前。along=true のときは部品の縦軸を前後方向に寝かせる
  function shipPart(bag, kind, x, y, z, sx, sy, sz, col, style, glow, gi, along) {
    const m = along ? m16([sx, 0, 0], [0, 0, sy], [0, -sz, 0], [x, y, z]) : m16([sx, 0, 0], [0, sy, 0], [0, 0, sz], [x, y, z]);
    bag.addM(kind, m, col, style, 3, glow, gi);
  }

  // ================= 宇宙船 4種 =================
  const SHIP_TYPES = {
    shuttle: { clear: 4.5, build: function (b) {
      shipPart(b, 'cyl', 0, 0, -8, 4.6, 16, 4.6, WHITE, 3, 0, 0, true);
      shipPart(b, 'cone', 0, 0, 8, 4.6, 6.5, 4.6, WHITE, 3, 0, 0, true);
      shipPart(b, 'box', 0, 1.3, 5.5, 2.6, 1.2, 3.4, [0.10, 0.14, 0.20], 2, 0, 0);
      shipPart(b, 'box', 0, -1.6, -7, 15, 0.45, 6.5, DARK, 3);
      shipPart(b, 'box', 0, 1.8, -8.5, 0.4, 4.2, 4.0, WHITE, 3);
      for (let s = -1; s <= 1; s += 2) {
        shipPart(b, 'cyl', s * 2.4, -0.3, -10.6, 1.8, 3.2, 1.8, GREY, 3, 0, 0, true);
        shipPart(b, 'cyl', s * 2.4, -0.3, -10.9, 1.4, 0.4, 1.4, [0.4, 0.8, 1.0], 5, 2.0, 0, true);
        shipPart(b, 'box', s * 7.2, -1.3, -7, 0.3, 0.3, 0.3, s < 0 ? [1, 0.1, 0.1] : [0.1, 1, 0.2], 5, 2.0);
      }
    } },
    cargo: { clear: 8, build: function (b) {
      shipPart(b, 'box', 0, -1.5, -8, 3.2, 3.2, 62, GREY, 3);
      for (let k = 0; k < 5; k++) for (let s = -1; s <= 1; s += 2) {
        shipPart(b, 'box', s * 5.4, -3.5, -24 + k * 11.2, 7, 7, 10, Kit.CONT[(k * 2 + (s > 0 ? 1 : 0)) % Kit.CONT.length], 3);
      }
      shipPart(b, 'box', 0, -3, 24, 9, 7, 9, WHITE, 0);
      shipPart(b, 'taper', 0, 4, 24, 7, 3, 7, WHITE, 3);
      shipPart(b, 'box', 0, -5, -36, 12, 11, 7, DARK, 3);
      for (let k = 0; k < 4; k++) {
        const x = (k & 1 ? 3 : -3), y = (k & 2 ? 3.2 : -2.2);
        shipPart(b, 'cyl', x, y, -37.2, 3.6, 1.2, 3.6, [1.0, 0.6, 0.25], 5, 2.0, 2, true);
      }
    } },
    liner: { clear: 15, build: function (b) {
      shipPart(b, 'cyl', 0, 0, -45, 16, 86, 16, WHITE, 0, 0, 0, true);
      shipPart(b, 'cone', 0, 0, 41, 16, 20, 16, WHITE, 0, 0, 0, true);
      shipPart(b, 'cyl', 0, 0, -53, 11, 8, 11, GREY, 3, 0, 0, true);
      shipPart(b, 'ring', 0, 0, 5, 44, 44, 44, Kit.GLOW[2], 5, 1.2, 2, true);
      shipPart(b, 'ring', 0, 0, -18, 30, 30, 30, Kit.GLOW[0], 5, 1.2, 0, true);
      shipPart(b, 'box', 0, 0, 5, 44, 1.4, 1.4, GREY, 3);
      shipPart(b, 'box', 0, -22, 5, 1.4, 44, 1.4, GREY, 3);
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * TAU;
        shipPart(b, 'cyl', Math.cos(a) * 3.2, Math.sin(a) * 3.2, -54, 4.2, 1.0, 4.2, [0.4, 0.8, 1.0], 5, 2.2, 0, true);
      }
    } },
    pod: { clear: 3, build: function (b) {
      shipPart(b, 'box', 0, -2, -2.5, 4, 4, 5, YELLOW, 3);
      shipPart(b, 'dome', 0, 0, 2.5, 3.6, 5, 3.6, [0.10, 0.14, 0.20], 2, 0, 0, true);
      for (let s = -1; s <= 1; s += 2) {
        shipPart(b, 'box', s * 2.6, -0.2, 0.5, 0.3, 0.3, 5.5, DARK, 3);
        shipPart(b, 'box', s * 2.6, -0.3, 6, 0.9, 0.5, 0.5, GREY, 3);
        shipPart(b, 'box', s * 1.6, 1.9, 1.5, 0.4, 0.3, 0.4, [1, 0.95, 0.8], 5, 2.5);
      }
      shipPart(b, 'cyl', 0, 0, -3.0, 1.6, 0.5, 1.6, [0.4, 0.8, 1.0], 5, 2.0, 0, true);
    } },
  };
  // 停泊場所 8か所: 周方向の角度, 軸方向の位置, 船の種類
  const BERTHS = [
    [0, -300, 'liner'], [45, -620, 'cargo'], [90, -300, 'shuttle'], [135, -620, 'shuttle'],
    [180, -300, 'cargo'], [225, -620, 'pod'], [270, -300, 'shuttle'], [315, -620, 'pod'],
  ];
  const ships = [];
  const FAR_Z = -5200;               // ここまで離れたら見えなくする

  // 船 k の時刻 t での様子: { r: 軸からの距離, z, psi: 機首の向き（0=外向き, π=奥向き）, vis }
  function shipPose(s, t) {
    const wait = s.wait, P = wait + 12 + 44 + s.gap + 44 + 12;
    let tau = ((t + s.phase) % P + P) % P;
    const rb = HUB - s.clear, rl = s.lane, zb = s.z;
    if (tau < wait) return { r: rb, z: zb, psi: 0, vis: true };
    tau -= wait;
    if (tau < 12) return { r: rb + (rl - rb) * smooth(tau / 12), z: zb, psi: 0, vis: true };        // 離床
    tau -= 12;
    if (tau < 44) { const q = tau / 44; return { r: rl, z: zb + (FAR_Z - zb) * q * q, psi: 0, vis: true }; }   // 出航
    tau -= 44;
    if (tau < s.gap) return { r: rl, z: FAR_Z, psi: 0, vis: false };
    tau -= s.gap;
    if (tau < 44) { const q = 1 - tau / 44; return { r: rl, z: zb + (FAR_Z - zb) * q * q, psi: Math.PI, vis: true }; }  // 入港
    tau -= 44;
    const q = smooth(tau / 12);
    return { r: rl + (rb - rl) * q, z: zb, psi: Math.PI * (1 - q), vis: true };                      // 回頭しながら着床
  }
  function placeShip(s, pose) {
    const th = s.th, up = [-Math.cos(th), -Math.sin(th), 0], east = [-Math.sin(th), Math.cos(th), 0];
    const cp = Math.cos(pose.psi), sp = Math.sin(pose.psi);
    const Z = [east[0] * sp, east[1] * sp, -cp], X = V.cross(up, Z);
    s.grp.visible = pose.vis;
    s.grp.matrix.set(X[0], up[0], Z[0], pose.r * Math.cos(th),
                     X[1], up[1], Z[1], pose.r * Math.sin(th),
                     X[2], up[2], Z[2], pose.z,
                     0, 0, 0, 1);
    s.grp.matrixWorldNeedsUpdate = true;
  }

  // ================= ドック =================
  const wallVS = GL.VS_HEAD + `
    varying vec3 vWorld;
    varying vec2 vUv;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vUv = uv;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + GL.VS_TAIL + `
    }`;
  const wallFS = GL.FS_HEAD + GL.NOISE2 + `
    varying vec3 vWorld;
    varying vec2 vUv;
    void main() {
      #include <logdepthbuf_fragment>
      #ifdef FLAT
        vec2 p = vWorld.xy;
      #else
        vec2 p = vec2(vUv.x * 1884.96, vWorld.z);          // 周方向の長さ [m], 軸方向 [m]
      #endif
      vec3 col = vec3(0.46, 0.49, 0.54) * (0.88 + 0.24 * vnoise(p / 7.0));
      vec2 g = abs(fract(p / 15.0 - 0.5) - 0.5) * 15.0;
      col *= 1.0 - 0.35 * (1.0 - smoothstep(0.08, 0.25, min(g.x, g.y)));     // パネルの継ぎ目
      #ifdef FLAT
        col *= 0.80;
      #else
        // 軸方向に走る照明12本と、停泊位置の警戒色の帯
        float sd = abs(fract(vUv.x * 12.0 - 0.5) - 0.5) * 157.08;
        float line = 1.0 - smoothstep(0.9, 1.3, sd);
        float bz = min(abs(vWorld.z + 300.0), abs(vWorld.z + 620.0));
        float band = (1.0 - smoothstep(2.0, 2.3, abs(bz - 30.0))) * (1.0 - line);
        vec3 hz = mix(vec3(0.95, 0.75, 0.10), vec3(0.08), step(0.5, fract((p.x + p.y) / 4.0)));
        col = mix(col, hz, band);
        col = col * (0.52 + 0.55 * exp(-sd / 24.0)) + vec3(1.0, 0.97, 0.90) * line * 1.3;
      #endif
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`;

  function buildDock(scene) {
    const wall = new THREE.CylinderGeometry(HUB - 0.3, HUB - 0.3, DL, 96, 1, true);
    wall.rotateX(Math.PI / 2);
    const wm = new THREE.Mesh(wall, GL.material(wallVS, wallFS, null, { side: THREE.BackSide }));
    wm.position.z = -DL / 2;
    scene.add(wm);
    // 奥の壁（口の半径 200m）
    const end = new THREE.Mesh(new THREE.RingGeometry(200, HUB, 96), GL.material(wallVS, wallFS, null, { side: THREE.DoubleSide, defines: { FLAT: 1 } }));
    end.position.z = -DL;
    scene.add(end);

    // 口の気密フィールド（うっすら光る膜）
    const fieldFS = `
      uniform float time;
      varying vec3 vWorld;
      void main() {
        float r = length(vWorld.xy);
        float edge = smoothstep(150.0, 200.0, r);
        float wave = 0.5 + 0.5 * sin(r * 0.35 - time * 2.0);
        gl_FragColor = vec4(vec3(0.20, 0.70, 1.0) * (0.03 + 0.20 * edge + 0.05 * wave * edge), 1.0);
      }`;
    const fieldVS = `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`;
    const field = new THREE.Mesh(new THREE.CircleGeometry(200, 64), new THREE.ShaderMaterial({
      uniforms: { time: U.time }, vertexShader: fieldVS, fragmentShader: fieldFS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    field.position.z = -DL + 1;
    field.renderOrder = 11;
    scene.add(field);

    // 宇宙（口の向こうに見える星空・太陽・地球）。カメラを中心にした大きな球の内側に描く
    const skyVS = `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position.z = gl_Position.w * 0.99999;
      }`;
    const skyFS = GL.COMMON + GL.SPACE + `
      varying vec3 vDir;
      void main() { gl_FragColor = vec4(spaceColor(normalize(vDir), 1.0), 1.0); }`;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 16), GL.material(skyVS, skyFS, null, { fog: false, side: THREE.BackSide, depthWrite: false }));
    sky.frustumCulled = false;
    sky.renderOrder = 9;
    scene.add(sky);
    COL.spaceSky = sky;

    // 壁に据え付ける物: 入口の光る輪、管制塔、停泊場所の台と腕、貨物
    const bag = new Kit.Bag(), rand = COL.rng(60606);
    bag.addM('ring', m16([604, 0, 0], [0, 0, 604], [0, -604, 0], [0, 0, 0]), Kit.GLOW[0], 5, 0, 1.0, 0);
    bag.addM('ring', m16([408, 0, 0], [0, 0, 408], [0, -408, 0], [0, 0, -DL + 2]), Kit.GLOW[2], 5, 0, 1.0, 2);
    // 管制塔: 壁から立ち上がる柱の上のガラスの部屋
    const tth = Math.PI * 0.375;
    dockPart(bag, 'box', tth, -120, 0, 9, 46, 9, GREY, 3, 1);
    dockPart(bag, 'box', tth, -120, 46, 34, 9, 26, WHITE, 0, 2);
    dockPart(bag, 'box', tth, -120, 55, 36, 1.2, 28, DARK, 3, 2);
    dockPart(bag, 'box', tth, -120, 56.2, 0.6, 16, 0.6, DARK, 3, 2);
    dockPart(bag, 'box', tth, -120, 72, 1.2, 1.2, 1.2, [1, 0.15, 0.1], 5, 0, 2.0);
    BERTHS.forEach(function (bt, k) {
      const th = bt[0] * Math.PI / 180, z = bt[1], type = SHIP_TYPES[bt[2]];
      const len = bt[2] === 'liner' ? 110 : bt[2] === 'cargo' ? 74 : bt[2] === 'shuttle' ? 26 : 12, w = Math.min(30, len * 0.5);
      dockPart(bag, 'box', th, z, 0, w, 0.8, len, [0.36, 0.38, 0.42], 3, 4);                       // 台
      for (let s = -1; s <= 1; s += 2) {
        dockPart(bag, 'box', th + s * (w / 2 - 0.3) / HUB, z, 0.8, 0.5, 0.25, len, YELLOW, 5, 0, 0.6);   // 縁の灯り
        dockPart(bag, 'box', th + s * (w / 2 + 3) / HUB, z + len * 0.25, 0, 2.2, type.clear + 3, 2.2, GREY, 3, 5);  // つかむ腕
        dockPart(bag, 'box', th + s * (w / 2 + 3) / HUB, z + len * 0.25, type.clear + 3, 2.6, 1.0, 2.6, [0.3, 1.0, 0.5], 5, 0, 1.2);
      }
      // 貨物船のそばにはコンテナの山
      if (bt[2] === 'cargo') for (let q = 0; q < 26; q++) {
        const dth = (24 + rand() * 30) / HUB * (rand() < 0.5 ? -1 : 1), dz = (rand() - 0.5) * 80, n = 1 + Math.floor(rand() * 3);
        for (let e = 0; e < n; e++) dockPart(bag, 'box', th + dth, z + dz, e * 2.6, 2.5, 2.6, 12.2, Kit.CONT[Math.floor(rand() * Kit.CONT.length)], 3, q);
      }
    });
    // 入口まわりの手すり代わりの灯り
    for (let k = 0; k < 24; k++) dockPart(bag, 'box', k / 24 * TAU, -6, 0, 1.2, 3.0, 1.2, k % 2 ? [1.0, 0.9, 0.6] : [0.3, 0.9, 1.0], 5, 0, 1.4);
    const grp = new THREE.Group();
    bag.build(grp, false);
    scene.add(grp);

    // 宇宙船
    BERTHS.forEach(function (bt, k) {
      const type = SHIP_TYPES[bt[2]], b = new Kit.Bag(), grp2 = new THREE.Group();
      type.build(b);
      b.build(grp2, false, shipMats);
      grp2.matrixAutoUpdate = false;
      scene.add(grp2);
      ships.push({ grp: grp2, th: bt[0] * Math.PI / 180, z: bt[1], clear: type.clear, lane: 45 + (k % 4) * 28,
                   wait: 55 + (k * 37) % 70, gap: 30 + (k * 53) % 60, phase: k * 61.7 });
    });
  }

  // ================= エレベーター =================
  const RIDE_TIME = 55, spokes = [];
  function buildElevators(scene) {
    const bag = new Kit.Bag();
    for (let i = 0; i < 3; i++) {
      const th = COL.landCenter(i), f = COL.frameAt(th), zB = 2050, zH = 70;
      const Bp = COL.toWorld(th, zB, COL.groundH(th, zB) + 7), Hp = COL.toWorld(th, zH, R - (HUB + 36));
      const d = V.sub(Hp, Bp), len = V.len(d), dir = V.norm(d), side = f.east, nrm = V.cross(side, dir);
      // レール（太い管）と、200m ごとの支えの輪
      bag.addM('cyl', m16(V.mul(side, 3), V.mul(dir, len), V.mul(nrm, 3), Bp), [0.72, 0.74, 0.78], 3, 1);
      for (let q = 200; q < len - 100; q += 200) {
        bag.addM('ring', m16(V.mul(side, 16), V.mul(dir, 16), V.mul(nrm, 16), V.add(Bp, V.mul(dir, q))), Kit.GLOW[0], 5, 0, 0.9, 0);
      }
      // 麓の駅: 乗り場の台、屋根、柱、光る看板
      const g = COL.groundH(th, zB);
      bag.add('box', i, 0, zB, g - 1, 34, 1.6, 34, [0.70, 0.70, 0.68], 3, 2);
      bag.add('box', i, 0, zB, g + 9.5, 38, 0.8, 38, DARK, 3, 2);
      bag.add('box', i, 0, zB, g + 10.3, 38.6, 0.3, 38.6, Kit.GLOW[0], 5, 0, 0.8, 0);
      for (let q = 0; q < 4; q++) bag.add('cyl', i, (q & 1 ? 15 : -15), zB + (q & 2 ? 15 : -15), g, 1.2, 9.6, 1.2, WHITE, 3, 2);
      bag.add('box', i, 0, zB + 19, g + 0.6, 10, 3.2, 0.6, Kit.GLOW[2], 5, 0, 0.9, 2);
      // ドック入口側の駅: 山の頂の小さな乗り場
      bag.addM('box', m16(V.mul(f.east, 26), V.mul(f.up, 1.2), [0, 0, 26], V.add(Hp, V.mul(f.up, -8))), [0.70, 0.70, 0.68], 3, 2);
      bag.addM('box', m16(V.mul(f.east, 27), V.mul(f.up, 0.4), [0, 0, 27], V.add(Hp, V.mul(f.up, -6.8))), Kit.GLOW[0], 5, 0, 0.8, 0);

      // かご（ガラス張り）
      const cb = new Kit.Bag(), cab = new THREE.Group();
      shipPart(cb, 'box', 0, -0.4, 0, 6.4, 0.4, 10.4, DARK, 3);
      shipPart(cb, 'box', 0, 0, 0, 6, 4.2, 10, WHITE, 0);
      shipPart(cb, 'box', 0, 4.2, 0, 6.6, 0.4, 10.6, DARK, 3);
      shipPart(cb, 'box', 0, 4.6, 0, 6.8, 0.2, 10.8, Kit.GLOW[0], 5, 1.0, 0);
      shipPart(cb, 'box', 0, -3.4, 0, 1.0, 3.0, 1.0, GREY, 3);
      cb.build(cab, false);
      cab.matrixAutoUpdate = false;
      scene.add(cab);
      spokes.push({ i: i, th: th, f: f, B: Bp, H: Hp, dir: dir, len: len, cab: cab, zB: zB });
    }
    const grp = new THREE.Group();
    bag.build(grp, false);
    scene.add(grp);
  }
  // かごの位置（s: 0=麓, 1=ドック入口）。床はレールの少し上
  function cabPos(sp, s) { return V.add(V.add(sp.B, V.mul(sp.dir, sp.len * s)), V.mul(sp.f.up, 5)); }
  function placeCab(sp, s) {
    const p = cabPos(sp, s), f = sp.f;
    sp.cab.matrix.set(f.east[0], f.up[0], 0, p[0], f.east[1], f.up[1], 0, p[1], f.east[2], f.up[2], 1, p[2], 0, 0, 0, 1);
    sp.cab.matrixWorldNeedsUpdate = true;
  }
  // 乗っていないときの時刻表: 麓で25秒 → 上り55秒 → 上で25秒 → 下り55秒
  function timetable(sp, t) {
    const tau = (t + sp.i * 53) % 160;
    if (tau < 25) return 0;
    if (tau < 80) return smooth((tau - 25) / RIDE_TIME);
    if (tau < 105) return 1;
    return 1 - smooth((tau - 105) / RIDE_TIME);
  }

  COL.ride = null;                   // 乗車中: { sp, up: 上りか, t }
  // 乗っているあいだは、かごと一緒に動く（視点だけ動かせる）
  COL.rideStep = function (p, inp, dt) {
    const rd = COL.ride;
    rd.t += dt;
    const q = smooth(rd.t / RIDE_TIME), s = rd.up ? q : 1 - q;
    p.pos = V.add(cabPos(rd.sp, s), V.mul(rd.sp.f.up, 0.05));
    p.vel = [0, 0, 0];
    p.fly = true;
    COL.stepPlayer(p, { yaw: inp.yaw, pitch: inp.pitch }, 0);
    if (rd.t < RIDE_TIME + 1) return;
    // 到着: 上では無重力なので飛行のまま降ろす。麓では駅前の地面に立たせる
    const sp = rd.sp;
    COL.ride = null;
    if (rd.up) {
      p.pos = V.add(sp.H, V.add(V.mul(sp.f.up, 30), [0, 0, 20]));
    } else {
      const z = sp.zB + 26;
      p.pos = COL.toWorld(sp.th, z, COL.groundH(sp.th, z) + 0.1);
      p.fly = false;
    }
    COL.stepPlayer(p, {}, 0);
  };

  // 確認用: 乗車の途中から始める（URL の ?ride=経過秒 で使う）
  COL.startRide = function (i, up, t) { COL.ride = { sp: spokes[i], up: up, t: t || 0 }; };

  COL.buildPort = function (scene) {
    Kit = COL.CityKit;
    Kit.m16 = m16; Kit.localPart = shipPart;      // 乗り物（vehicles.js）でも使う
    // 宇宙船は霞をかけない（口の外の宇宙でも色が変わらないように）
    const flat = GL.material(Kit.cityVS, Kit.cityFS, null, { fog: false });
    const round = GL.material(Kit.cityVS, Kit.cityFS, null, { fog: false, defines: { ROUND: 1 } });
    shipMats = { box: flat, taper: flat, gable: flat, cyl: round, cone: round, ring: round, dome: round };
    Kit.shipMats = shipMats;                      // 採掘船（space.js）でも使う
    buildDock(scene);
    buildElevators(scene);
  };

  // 毎フレーム: 船とかごを動かす。乗れる場所にいれば案内の文を返し、use（E キー）で乗る
  COL.updatePort = function (dt, p, use) {
    clock += dt;
    for (let k = 0; k < ships.length; k++) placeShip(ships[k], shipPose(ships[k], clock));
    // 宇宙の球は、ドックの口が見える距離のときだけ描く
    COL.spaceSky.visible = p.pos[2] < 4000;
    let prompt = '';
    for (let k = 0; k < spokes.length; k++) {
      const sp = spokes[k], rd = COL.ride && COL.ride.sp === sp ? COL.ride : null;
      placeCab(sp, rd ? (rd.up ? smooth(rd.t / RIDE_TIME) : 1 - smooth(rd.t / RIDE_TIME)) : timetable(sp, clock));
      if (COL.ride) continue;
      const atBase = V.len(V.sub(p.pos, sp.B)) < 32, atHub = V.len(V.sub(p.pos, sp.H)) < 60;
      if (!atBase && !atHub) continue;
      prompt = atBase ? 'E: エレベーターで宇宙港へ（約55秒）' : 'E: エレベーターで' + COL.LAND_NAMES[sp.i] + 'へ降りる（約55秒）';
      if (use) { COL.ride = { sp: sp, up: atBase, t: 0 }; prompt = ''; }
    }
    if (COL.ride) prompt = '';
    return prompt;
  };
})();
