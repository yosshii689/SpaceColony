// 採掘船: 宇宙港のドックから自分で操縦して外へ出て、隕石から鉱石を採って戻る
//  - 船はドックの陸地A側の停泊場所（入口から 110m）に置いてある。E で乗る
//  - 操縦はかんたん式: マウスで向き、W/S 前後、A/D 左右、Space/Shift 上下。手を離すと自動で止まる
//  - 隕石に機首を向けて左クリック（または F）を押し続けると採掘。積めるのは ECON.HOLD 個まで
//  - 停泊場所に戻って E で着艦すると、積み荷が売れる
//  - コロニーの外から見える外殻（円筒と宇宙港側の端の板）もここで作る
(function () {
  'use strict';
  const COL = window.COL, GL = COL.GL, V = COL.V, ECON = COL.ECON;
  const R = COL.R, L = COL.L, HUB = COL.HUB_R, DL = COL.DOCK_LEN, TAU = Math.PI * 2;
  const clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };

  const CLEAR = 3.6;                               // 船の中心から底までの高さ
  const BERTH_Z = -110;
  const REST = [0, -(HUB - 0.8 - CLEAR), BERTH_Z];  // 停泊中の船の位置（陸地Aの真上 = 角度 -90°の壁の上）
  const HOVER = [REST[0], REST[1] + 14, REST[2]];   // 着艦できる範囲の中心
  const MOUTH_R = 180;                             // ドックの口を通れる半径（口の半径は 200m）
  const HULL_TUBE = 322, HULL_R = R + 95, HULL_Z0 = -70, HULL_Z1 = L + 65;   // 外殻の当たり判定
  const SHIP_R = 10;                               // 隕石との当たり判定の半径

  let Kit = null, shipGrp = null, beam = null, spark = null, fieldGrp = null;
  let rockGeos = [], oreMats = [], rareMat = null, deadMat = null;
  let field = [], rareRock = null, mining = false, keyF = false, mouseL = false;
  let hudEl = null, markDock = null, markRare = null;

  // 船の向き。yaw: 左右, pitch: 上下。基準は「機首がドックの口（-z）、上が中心軸の方向（+y）」
  function basis(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const f = [cp * sy, sp, -cp * cy], r = [cy, 0, sy];
    return { f: f, r: r, u: V.cross(r, f) };
  }
  function placeShip(pos, b) {
    // 船の座標は X = 上×前, Y = 上, Z = 前
    shipGrp.matrix.set(-b.r[0], b.u[0], b.f[0], pos[0],
                       -b.r[1], b.u[1], b.f[1], pos[1],
                       -b.r[2], b.u[2], b.f[2], pos[2],
                       0, 0, 0, 1);
    shipGrp.matrixWorldNeedsUpdate = true;
  }

  // ================= 採掘船の形 =================
  function buildShip(scene) {
    const b = new Kit.Bag(), P = Kit.localPart;
    const WHITE = [0.88, 0.89, 0.91], GREY = [0.50, 0.52, 0.55], DARK = [0.18, 0.19, 0.22], ORANGE = [0.92, 0.50, 0.12];
    P(b, 'box', 0, -2.2, -2, 7, 4.4, 18, WHITE, 3);                                  // 胴体
    P(b, 'taper', 0, 0, 7, 7, 6.5, 4.4, WHITE, 3, 0, 0, true);                       // 機首
    P(b, 'box', 0, 2.2, 1.5, 4.4, 1.7, 6.5, [0.10, 0.14, 0.20], 2);                  // 操縦室
    P(b, 'box', 0, 2.2, -6.5, 5.0, 0.9, 8, GREY, 3);
    for (let s = -1; s <= 1; s += 2) {
      P(b, 'box', s * 6.1, -2.7, -3, 5, 5, 12.5, ORANGE, 3);                          // 鉱石を積む箱
      P(b, 'box', s * 6.1, -2.9, -3, 5.3, 0.5, 13, DARK, 3);
      P(b, 'box', s * 6.1, 2.3, -3, 5.3, 0.3, 13, DARK, 3);
      P(b, 'cyl', s * 3.0, 0, -14.2, 3.4, 3.4, 3.4, GREY, 3, 0, 0, true);             // エンジン
      P(b, 'cyl', s * 3.0, 0, -14.6, 2.6, 0.5, 2.6, [0.4, 0.8, 1.0], 5, 2.2, 0, true);
      P(b, 'box', s * 3.2, -3.6, -2, 0.7, 1.2, 15, DARK, 3);                          // 着陸用のそり
      P(b, 'box', s * 8.5, 2.6, -8, 0.4, 0.4, 0.4, s < 0 ? [0.1, 1, 0.2] : [1, 0.1, 0.1], 5, 2.2);
    }
    P(b, 'box', 0, -3.3, 11, 0.9, 0.9, 6.5, DARK, 3);                                // 採掘レーザーの腕
    P(b, 'cyl', 0, -2.85, 17.2, 1.3, 0.8, 1.3, [1.0, 0.6, 0.25], 5, 2.2, 2, true);
    P(b, 'box', 0, 3.9, -1, 0.3, 2.2, 0.3, DARK, 3);                                 // アンテナ
    P(b, 'box', 0, 6.1, -1, 0.5, 0.5, 0.5, [1.0, 0.9, 0.6], 5, 2.2);
    shipGrp = new THREE.Group();
    b.build(shipGrp, false, Kit.shipMats);
    shipGrp.matrixAutoUpdate = false;
    scene.add(shipGrp);
    placeShip(REST, basis(0, 0));

    // 停泊場所の台と目印
    const pad = new Kit.Bag(), th = -Math.PI / 2, f = COL.frameAt(th);
    const part = function (dth, z, hgt, sx, sy, sz, col, style, glow) {
      const t = th + dth, ff = COL.frameAt(t), rho = HUB - hgt;
      pad.addM('box', Kit.m16(V.mul(ff.east, sx), V.mul(ff.up, sy), [0, 0, sz], [rho * Math.cos(t), rho * Math.sin(t), z]), col, style, 4, glow || 0, 0);
    };
    part(0, BERTH_Z, 0, 26, 0.8, 40, [0.36, 0.38, 0.42], 3);
    for (let s = -1; s <= 1; s += 2) {
      part(s * 12.7 / HUB, BERTH_Z, 0.8, 0.5, 0.25, 40, [0.3, 1.0, 0.5], 5, 0.8);
      part(s * 16 / HUB, BERTH_Z + 18, 0, 1.6, 9, 1.6, GREY, 3);
      part(s * 16 / HUB, BERTH_Z + 18, 9, 2.2, 1.0, 2.2, [0.3, 1.0, 0.5], 5, 1.6);
    }
    const grp = new THREE.Group();
    pad.build(grp, false);
    scene.add(grp);
    void f;
  }

  // ================= 隕石 =================
  const rockVS = `
    varying vec3 vN, vObj;
    void main() {
      vObj = position;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`;
  const rockFS = GL.COMMON + GL.SPACE + `
    uniform vec3 oreCol;
    uniform float rare, vein;
    varying vec3 vN, vObj;
    void main() {
      vec3 N = normalize(vN);
      float n = n3(vObj * 2.3) * 0.6 + n3(vObj * 6.0) * 0.4;
      vec3 rock = vec3(0.36, 0.33, 0.30) * (0.55 + 0.9 * n);
      float v = smoothstep(0.52, 0.62, n3(vObj * 3.7 + 11.0)) * vein;
      vec3 col = mix(rock, oreCol, v * 0.9);
      // 太陽は宇宙港の口の先（-z）にある
      float ndl = max(dot(N, vec3(0.0, 0.0, -1.0)), 0.0), fill = max(dot(N, normalize(vec3(0.4, 0.5, 0.6))), 0.0);
      // コロニーの側（+z）からの照り返しも足す（ドックから出ると隕石は逆光になるため）
      float back = max(dot(N, vec3(0.0, 0.0, 1.0)), 0.0);
      vec3 lit = col * (0.16 + 0.95 * ndl + 0.55 * back + 0.12 * fill) + oreCol * v * 0.16;
      lit += oreCol * rare * (v * (0.9 + 0.6 * sin(time * 4.0)) + 0.22);
      gl_FragColor = vec4(lit, 1.0);
    }`;
  function rockGeo(s) {
    const g = new THREE.IcosahedronGeometry(1, 2), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const d = 1 + 0.22 * Math.sin(x * 2.1 + s) * Math.sin(y * 1.7 + 2 * s) + 0.15 * Math.sin(z * 3.3 + 3 * s) * Math.sin(x * 2.9 + s)
                  + 0.09 * Math.sin(y * 5.1 + z * 4.3 + s) + 0.06 * Math.sin(x * 7.7 + y * 6.1 + 2 * s);
      p.setXYZ(i, x * d, y * d, z * d);
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
  function rockMat(col, rare, vein) {
    const m = GL.material(rockVS, rockFS, { oreCol: { value: new THREE.Color(col[0], col[1], col[2]) }, rare: { value: rare }, vein: { value: vein } }, { fog: false });
    return m;
  }
  // 隕石の場を作り直す（出航のたびに並びが変わる）。withRare: レア隕石を1つ混ぜるか
  function makeField(seed, withRare) {
    while (fieldGrp.children.length) fieldGrp.remove(fieldGrp.children[0]);
    field = []; rareRock = null;
    const r = COL.rng(seed >>> 0);
    const add = function (pos, rad, ore, units, rare) {
      const mesh = new THREE.Mesh(rockGeos[field.length % rockGeos.length], rare ? rareMat : oreMats[ore]);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.scale.set(rad * (0.85 + 0.3 * r()), rad * (0.85 + 0.3 * r()), rad * (0.85 + 0.3 * r()));
      mesh.rotation.set(r() * TAU, r() * TAU, r() * TAU);
      fieldGrp.add(mesh);
      const a = { pos: pos, rad: rad, ore: ore, left: units, rare: !!rare, mesh: mesh, spin: (r() - 0.5) * 0.08 };
      field.push(a);
      return a;
    };
    const free = function (pos, rad) {
      for (let k = 0; k < field.length; k++) if (V.len(V.sub(field[k].pos, pos)) < field[k].rad + rad + 30) return false;
      return true;
    };
    for (let k = 0; k < 80; k++) {
      for (let tries = 0; tries < 6; tries++) {
        const z = -1300 - 4500 * r(), rho = 330 + 1700 * Math.sqrt(r()), a = r() * TAU, rad = 20 + 70 * r() * r();
        const pos = [rho * Math.cos(a), rho * Math.sin(a), z];
        if (!free(pos, rad)) continue;
        add(pos, rad, COL.pickOre(r()), clamp(Math.round(rad / 14), 2, 6), false);
        break;
      }
    }
    if (withRare) {
      for (let tries = 0; tries < 30 && !rareRock; tries++) {
        const z = -3000 - 3200 * r(), rho = 500 + 1600 * Math.sqrt(r()), a = r() * TAU;
        const pos = [rho * Math.cos(a), rho * Math.sin(a), z];
        if (free(pos, 14)) rareRock = add(pos, 14, 0, 1, true);
      }
    }
  }

  // ================= コロニーの外殻（外から見たとき用。内側からは見えない） =================
  const hullVS = `
    varying vec3 vWorld, vN;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const hullFS = GL.COMMON + GL.NOISE2 + `
    varying vec3 vWorld, vN;
    void main() {
      vec3 N = normalize(vN);
      float r = length(vWorld.xy), ang = atan(vWorld.y, vWorld.x);
      bool side = abs(N.z) < 0.5;
      vec2 p = side ? vec2(ang * r, vWorld.z) : vWorld.xy;
      float fw = fwidth(p.x) + fwidth(p.y) + 1e-3;
      vec3 col = vec3(0.50, 0.52, 0.56) * (0.78 + 0.34 * vnoise(p / 160.0));
      vec2 gq = abs(fract(p / 240.0 - 0.5) - 0.5) * 240.0;
      col *= 1.0 - 0.18 * (1.0 - smoothstep(1.5, 1.5 + fw, min(gq.x, gq.y))) * clamp(6.0 / fw, 0.0, 1.0);    // 外板の継ぎ目
      float ndl = max(dot(N, vec3(0.0, 0.0, -1.0)), 0.0), fill = max(dot(N, normalize(vec3(0.5, 0.6, -0.3))), 0.0);
      vec3 lit = col * (0.30 + 0.80 * ndl + 0.30 * fill);
      if (side && r > 2000.0) {
        // 窓3枚: 昼は中の空の色、夜は街の明かりがうっすら見える
        float a = mod(ang - THETA0, 6.2831853) / STRIP;
        if (mod(floor(a), 2.0) > 0.5) {
          float e = abs(fract(a) - 0.5);
          vec3 glassC = vec3(0.02, 0.04, 0.08) + vec3(0.30, 0.48, 0.70) * (1.0 - night) * 0.55
                      + vec3(1.0, 0.75, 0.45) * night * 0.12 * step(0.62, vnoise(p / 40.0));
          vec2 fq = abs(fract(p / 250.0 - 0.5) - 0.5) * 250.0;
          float frame = (1.0 - smoothstep(4.0, 4.0 + fw, min(fq.x, fq.y))) * clamp(8.0 / fw, 0.0, 1.0);
          lit = mix(mix(glassC, lit, frame), lit, smoothstep(0.47, 0.49, e));
        }
      }
      gl_FragColor = vec4(lit, 1.0);
    }`;
  function buildHull(scene) {
    const mat = GL.material(hullVS, hullFS, null, { fog: false });
    const add = function (geo, z) { const m = new THREE.Mesh(geo, mat); m.position.z = z; m.frustumCulled = false; scene.add(m); };
    const z0 = -40, z1 = L + 30, RO = R + 60;
    const tube = new THREE.CylinderGeometry(301, 301, DL + z0, 64, 1, true); tube.rotateX(Math.PI / 2);
    add(tube, (-DL + z0) / 2);
    const disc = new THREE.RingGeometry(301, RO, 96, 1); disc.rotateY(Math.PI);
    add(disc, z0);
    const body = new THREE.CylinderGeometry(RO, RO, z1 - z0, 144, 1, true); body.rotateX(Math.PI / 2);
    add(body, (z0 + z1) / 2);
    add(new THREE.CircleGeometry(RO, 96), z1);
  }

  // ================= 操縦 =================
  COL.pilot = null;      // 操縦中: { pos, vel, yaw, pitch, inDock, cargo, mineT, target, note }

  function board(p) {
    COL.pilot = { pos: REST.slice(), vel: [0, 0, 0], yaw: 0, pitch: 0, inDock: true, cargo: COL.newCargo(), mineT: 0, target: null, note: '', t: 0 };
    makeField((Date.now() ^ (COL.save.trips * 7919)) >>> 0, Math.random() < ECON.RARE_CHANCE);
    p.fly = true; p.vel = [0, 0, 0];
    hudEl.style.display = 'block';
    COL.toast('採掘船に乗りました\nSpace で浮き上がり、W で前へ。奥の口から宇宙へ出ます' + (rareRock ? '\nセンサーにレア鉱石の反応があります！' : ''), 6);
  }
  function land(p) {
    const s = COL.pilot, cargo = s.cargo, val = COL.cargoValue(cargo);
    COL.pilot = null;
    placeShip(REST, basis(0, 0));
    beam.visible = spark.visible = false;
    hudEl.style.display = markDock.style.display = markRare.style.display = 'none';
    // 船の横に降ろす（ドックの中は無重力なので飛行のまま）
    p.pos = [REST[0] + 14, REST[1] + 3, REST[2]];
    p.vel = [0, 0, 0]; p.fly = true; p.fwd = [-1, 0, 0]; p.pitch = 0;
    COL.stepPlayer(p, {}, 0);
    if (COL.onQuality) COL.onQuality(COL.QUALITIES[COL.getQuality()]);      // カメラの描く距離を元に戻す
    if (val <= 0) { COL.toast('着艦しました（積み荷はありません）', 3); return; }
    const lines = ['鉱石を売却しました'];
    ECON.ORES.forEach(function (o, k) { if (cargo.counts[k]) lines.push(o.name + ' × ' + cargo.counts[k] + '　' + COL.fmtCr(cargo.counts[k] * o.value)); });
    if (cargo.rare) lines.push('★ ' + ECON.RARE.name + '（レア）　' + COL.fmtCr(ECON.RARE.value));
    COL.save.money += val; COL.save.trips++;
    COL.storeSave();
    lines.push('合計 +' + COL.fmtCr(val) + '　（所持金 ' + COL.fmtCr(COL.save.money) + '）');
    if (!COL.save.owned && COL.save.money >= ECON.PRICE) lines.push(COL.devMode ? '豪邸が買えます！ H キーで売地へ移動できます' : '豪邸が買えます！ 売地は陸地Aのガラスの端寄りの海辺です（M の地図の黄色い家）');
    COL.toast(lines.join('\n'), 9);
  }

  // 船がコロニーの壁を通り抜けないようにする
  function constrain(s, old) {
    const p = s.pos, r = Math.hypot(p[0], p[1]);
    const radial = function (lim, inward) {
      const k = lim / (r || 1);
      p[0] *= k; p[1] *= k;
      const n = [p[0] / lim, p[1] / lim, 0], vr = V.dot(s.vel, n);
      if (inward ? vr > 0 : vr < 0) s.vel = V.sub(s.vel, V.mul(n, vr));
    };
    if (s.inDock) {
      if (p[2] > -30) { p[2] = -30; if (s.vel[2] > 0) s.vel[2] = 0; }
      if (p[2] < -DL) {
        if (r < MOUTH_R) { s.inDock = false; return; }
        p[2] = -DL + 0.1; if (s.vel[2] < 0) s.vel[2] = 0;
      }
      if (r > HUB - 0.8 - CLEAR) radial(HUB - 0.8 - CLEAR, true);
      return;
    }
    // 宇宙側。口の正面からだけドックへ入れる
    if (p[2] > -DL - 6 && p[2] < HULL_Z0 && r < MOUTH_R) { if (p[2] > -DL) s.inDock = true; return; }
    const lim = (p[2] <= -DL - 6 || p[2] >= HULL_Z1) ? 0 : p[2] < HULL_Z0 ? HULL_TUBE : HULL_R;
    if (r >= lim) return;
    if (old[2] <= -DL - 6) { p[2] = -DL - 6; if (s.vel[2] > 0) s.vel[2] = 0; }
    else if (old[2] <= HULL_Z0 && p[2] > HULL_Z0) { p[2] = HULL_Z0; if (s.vel[2] > 0) s.vel[2] = 0; }
    else if (old[2] >= HULL_Z1) { p[2] = HULL_Z1; if (s.vel[2] < 0) s.vel[2] = 0; }
    else radial(lim, false);
  }

  COL.pilotStep = function (p, inp, dt) {
    const s = COL.pilot;
    s.t += dt;
    s.yaw += inp.yaw || 0;
    s.pitch = clamp(s.pitch + (inp.pitch || 0), -1.4, 1.4);
    const b = basis(s.yaw, s.pitch);
    const sp = s.inDock ? (inp.run ? 48 : 26) : (inp.run ? 420 : 140);
    let t = V.add(V.add(V.mul(b.f, inp.f || 0), V.mul(b.r, (inp.s || 0) * 0.7)), V.mul(b.u, (inp.ud || 0) * 0.7));
    const tl = V.len(t);
    t = V.mul(t, tl > 1 ? sp / tl : sp);
    s.vel = V.lerp(s.vel, t, Math.min(1, dt * (s.inDock ? 2.6 : 1.5)));
    const old = s.pos;
    s.pos = V.add(old, V.mul(s.vel, dt));
    constrain(s, old);
    // 隕石にはめり込まない
    if (!s.inDock) for (let k = 0; k < field.length; k++) {
      const a = field[k], d = V.sub(s.pos, a.pos), dist = V.len(d), lim = a.rad * (a.left > 0 ? 1.05 : 0.7) + SHIP_R;
      if (dist < lim && dist > 1e-3) {
        const n = V.mul(d, 1 / dist), vn = V.dot(s.vel, n);
        s.pos = V.add(a.pos, V.mul(n, lim));
        if (vn < 0) s.vel = V.sub(s.vel, V.mul(n, vn));
      }
    }
    // ねらっている隕石: 機首の向きに一番近く、表面まで 170m 以内のもの
    let best = null, bestA = 1e9;
    if (!s.inDock) for (let k = 0; k < field.length; k++) {
      const a = field[k];
      if (a.left <= 0) continue;
      const d = V.sub(a.pos, s.pos), dist = V.len(d);
      if (dist - a.rad > 170) continue;
      const ang = Math.acos(clamp(V.dot(d, b.f) / dist, -1, 1));
      if (ang < Math.atan2(a.rad, dist) + 0.22 && ang < bestA) { best = a; bestA = ang; }
    }
    s.target = best; s.note = '';
    mining = (mouseL && document.pointerLockElement) || keyF;
    let firing = false;
    if (best) {
      const full = !best.rare && COL.cargoCount(s.cargo) >= ECON.HOLD;
      const o = best.rare ? ECON.RARE : ECON.ORES[best.ore];
      if (full) s.note = '積み荷がいっぱいです。宇宙港へ戻って売りましょう';
      else if (!mining) s.note = (best.rare ? '★ ' : '') + o.name + '（1個 ' + COL.fmtCr(o.value) + '）残り ' + best.left + ' 個　／　左クリック長押し（または F）で採掘';
      else {
        firing = true;
        const need = best.rare ? 4 : 1.1;
        s.mineT += dt;
        s.note = (best.rare ? '★ ' : '') + o.name + ' を採掘中 ' + '■'.repeat(Math.min(10, Math.floor(s.mineT / need * 10))) + '□'.repeat(10 - Math.min(10, Math.floor(s.mineT / need * 10)));
        if (s.mineT >= need) {
          s.mineT = 0; best.left--;
          if (best.rare) { s.cargo.rare = true; COL.toast('★ ' + ECON.RARE.name + ' を手に入れた！\n宇宙港へ持ち帰ると ' + COL.fmtCr(ECON.RARE.value) + ' で売れます', 6); }
          else s.cargo.counts[best.ore]++;
          if (best.left <= 0) {                      // 掘り尽くした隕石は小さく、ただの岩になる
            best.mesh.material = deadMat; best.mesh.scale.multiplyScalar(0.7);
            if (best === rareRock) rareRock = null;
          }
        }
      }
    }
    if (!firing) s.mineT = 0;
    // 採掘の光線
    beam.visible = spark.visible = firing;
    if (firing) {
      const from = V.add(V.add(s.pos, V.mul(b.f, 17.5)), V.mul(b.u, -2.5));
      const dir0 = V.norm(V.sub(from, best.pos)), to = V.add(best.pos, V.mul(dir0, best.rad * 0.92));
      const d = V.sub(to, from), len = V.len(d), y = V.mul(d, 1 / len);
      let x = V.cross(y, [0, 1, 0]); if (V.len(x) < 1e-3) x = [1, 0, 0]; x = V.norm(x);
      const z = V.cross(x, y), w = 0.55 + 0.25 * Math.sin(s.t * 40);
      beam.matrix.set(x[0] * w, y[0] * len, z[0] * w, from[0], x[1] * w, y[1] * len, z[1] * w, from[1], x[2] * w, y[2] * len, z[2] * w, from[2], 0, 0, 0, 1);
      beam.matrixWorldNeedsUpdate = true;
      spark.position.set(to[0], to[1], to[2]);
      spark.scale.setScalar(2.2 + 1.2 * Math.sin(s.t * 31));
    }
    placeShip(s.pos, b);
    p.pos = s.pos.slice(); p.vel = s.vel.slice();
  };

  // 画面の上の目印（宇宙港・レア隕石）。画面の外にあるときは、その方向の縁に出す
  const _v = new THREE.Vector3();
  function mark(el, wp, label, camera) {
    _v.set(wp[0], wp[1], wp[2]).applyMatrix4(camera.matrixWorldInverse);
    const behind = _v.z > 0;
    _v.applyMatrix4(camera.projectionMatrix);
    let x = _v.x, y = _v.y;
    if (behind) { x = -x; y = -y; }
    const m = Math.max(Math.abs(x), Math.abs(y));
    if (behind || m > 0.9) { const k = 0.9 / (m || 1); x *= k; y *= k; }
    el.style.display = 'block';
    el.style.left = ((x * 0.5 + 0.5) * 100).toFixed(2) + '%';
    el.style.top = ((-y * 0.5 + 0.5) * 100).toFixed(2) + '%';
    el.textContent = label;
  }
  const km = function (d) { return d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1) + ' km'; };

  // 操縦中のカメラ: 船の後ろ上から追いかける
  COL.pilotCamera = function (camera) {
    const s = COL.pilot, b = basis(s.yaw, s.pitch);
    const cp = V.add(V.add(s.pos, V.mul(b.f, -46)), V.mul(b.u, 13));
    if (cp[2] > -DL && cp[2] < 0) {                   // ドックの壁の外へ出さない
      const r = Math.hypot(cp[0], cp[1]);
      if (r > HUB - 4) { cp[0] *= (HUB - 4) / r; cp[1] *= (HUB - 4) / r; }
    }
    if (s.inDock && cp[2] > -8) cp[2] = -8;
    camera.position.set(cp[0], cp[1], cp[2]);
    camera.up.set(b.u[0], b.u[1], b.u[2]);
    const t = V.add(V.add(s.pos, V.mul(b.f, 60)), V.mul(b.u, 4));
    camera.lookAt(t[0], t[1], t[2]);
    if (camera.near !== 1 || camera.far < 60000) { camera.near = 1; camera.far = Math.max(camera.far, 60000); camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    // 目印
    if (s.inDock) {
      const d = V.len(V.sub(s.pos, HOVER));
      if (d > 70) mark(markDock, HOVER, '▽ 着艦場所 ' + km(d), camera); else markDock.style.display = 'none';
    } else mark(markDock, [0, 0, -DL], '◇ 宇宙港 ' + km(V.len(V.sub(s.pos, [0, 0, -DL]))), camera);
    if (rareRock && !s.inDock) mark(markRare, rareRock.pos, '◆ レア反応 ' + km(V.len(V.sub(s.pos, rareRock.pos))), camera);
    else markRare.style.display = 'none';
  };

  COL.buildSpace = function (scene) {
    Kit = COL.CityKit;
    buildHull(scene);
    buildShip(scene);
    for (let k = 0; k < 5; k++) rockGeos.push(rockGeo(1.3 + k * 2.17));
    oreMats = ECON.ORES.map(function (o) { return rockMat(o.col, 0, 1); });
    rareMat = rockMat(ECON.RARE.col, 1, 1);
    deadMat = rockMat([0.3, 0.3, 0.3], 0, 0);
    fieldGrp = new THREE.Group();
    scene.add(fieldGrp);
    makeField(20261113, false);
    // 採掘の光線と、当たった所の火花
    const bg = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true); bg.translate(0, 0.5, 0);
    const bm = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    beam = new THREE.Mesh(bg, bm); beam.matrixAutoUpdate = false; beam.frustumCulled = false; beam.visible = false; beam.renderOrder = 12;
    spark = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), bm); spark.visible = false; spark.renderOrder = 12;
    scene.add(beam); scene.add(spark);
    hudEl = document.getElementById('shiphud');
    markDock = document.getElementById('markDock');
    markRare = document.getElementById('markRare');
    document.addEventListener('mousedown', function (e) { if (e.button === 0) mouseL = true; });
    document.addEventListener('mouseup', function (e) { if (e.button === 0) mouseL = false; });
    window.addEventListener('keydown', function (e) { if (e.code === 'KeyF') keyF = true; });
    window.addEventListener('keyup', function (e) { if (e.code === 'KeyF') keyF = false; });
    window.addEventListener('blur', function () { keyF = mouseL = false; });
  };

  // 毎フレーム。戻り値 { text: 案内の文, used: E を使ったか }
  let hudT = 0;
  COL.updateSpace = function (dt, p, use, camera) {
    // 隕石は、ドックの口から見える所にいるときだけ描く
    fieldGrp.visible = camera.position.z < 300 || !!COL.pilot;
    if (fieldGrp.visible) for (let k = 0; k < field.length; k++) { const a = field[k]; a.mesh.rotation.y += a.spin * dt; a.mesh.rotation.x += a.spin * 0.6 * dt; }
    const s = COL.pilot;
    if (!s) {
      // ドックの中と入口では、採掘船の場所を目印で示す
      const dist = V.len(V.sub(p.pos, REST));
      if (camera.matrixWorldInverse && p.pos[2] < 200 && Math.hypot(p.pos[0], p.pos[1]) < HUB + 100 && dist > 22 && !COL.ride) mark(markDock, REST, '▽ 採掘船 ' + km(dist), camera);
      else markDock.style.display = 'none';
      if (COL.ride || COL.driving || COL.onTrain || dist > 22) return { text: '', used: false };
      if (use) { board(p); return { text: '', used: true }; }
      return { text: 'E: 採掘船に乗る（隕石の採掘へ出発）', used: false };
    }
    // 船の計器
    hudT -= dt;
    if (hudT <= 0) {
      hudT = 0.15;
      const n = COL.cargoCount(s.cargo), parts = [];
      ECON.ORES.forEach(function (o, k) { if (s.cargo.counts[k]) parts.push(o.name + ' ' + s.cargo.counts[k]); });
      hudEl.textContent =
        '採掘船\n' +
        '積み荷　 ' + n + ' / ' + ECON.HOLD + (parts.length ? '（' + parts.join('・') + '）' : '') + '\n' +
        (s.cargo.rare ? '★ ' + ECON.RARE.name + ' を積んでいます\n' : '') +
        '売値の見込み ' + COL.fmtCr(COL.cargoValue(s.cargo)) + '\n' +
        'レア反応 ' + (s.cargo.rare ? '回収済み' : rareRock ? 'あり（◆ の方向）' : 'なし') + '\n' +
        '速度　　 ' + Math.round(V.len(s.vel)) + ' m/s' + (s.inDock ? '（ドック内は徐行）' : '') + '\n' +
        'W S 前後 ／ A D 左右 ／ Space Shift 上下 ／ W二回押し 高速';
    }
    if (s.inDock && V.len(V.sub(s.pos, HOVER)) < 70) {
      if (use && s.t > 1) { land(p); return { text: '', used: true }; }
      const has = COL.cargoValue(s.cargo) > 0;
      return { text: s.t < 8 && !has ? 'Space で浮き上がり、W で前進（奥の口から宇宙へ）　／　E: 降りる' : 'E: 着艦する' + (has ? '（鉱石を売る）' : ''), used: false };
    }
    return { text: s.note || (s.inDock ? '' : (COL.cargoCount(s.cargo) === 0 && !s.cargo.rare ? '隕石に近づいて機首を向けると採掘できます' : '')), used: false };
  };
  COL.vehicleNoteSpace = function () { return COL.pilot ? (COL.pilot.inDock ? '操縦（ドック内）' : '操縦（宇宙）') : ''; };

  COL.debugField = function () { return field; };
  // 確認用: 操縦中の状態で始める（?pilot=1&sx=&sy=&sz=&syaw=度&spitch=度&rare=1&cargo=数）
  COL.debugPilot = function (p, o) {
    board(p);
    const s = COL.pilot;
    if (o.rare) makeField(777, true);
    if (o.pos) { s.pos = o.pos; s.inDock = o.pos[2] > -DL; }
    s.yaw = o.yaw || 0; s.pitch = o.pitch || 0;
    for (let k = 0; k < (o.cargo || 0); k++) s.cargo.counts[k % ECON.ORES.length]++;
    placeShip(s.pos, basis(s.yaw, s.pitch));
    p.pos = s.pos.slice();
  };
})();
