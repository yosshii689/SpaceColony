// クジラ: 海の一番奥（ガラスの端の近く）を泳ぐ、巨大なザトウクジラの親子（大人2頭 56m・52m、子ども1頭 24m）
//  - 大きな輪を描いて泳ぎ、ときどき浮上して潮を吹く。潜るときは尾びれを水面の上へ上げる
//  - 体は尾に向かってしなり、尾びれを上下に振る（頂点シェーダーで曲げる）
//  - 潮吹きは霧の粒（点の集まり）
(function () {
  'use strict';
  const COL = window.COL, GL = COL.GL, V = COL.V, TAU = Math.PI * 2;
  const smooth = function (x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

  // 群れの通り道: 陸地A の u = 0, z = 29100 を中心にした楕円（水深はどこも 35m）
  const POD = { cu: 0, cz: 29050, ru: 700, rz: 500, speed: 3.6, a0: 0.4 };
  // len: 体長, lat / back: 群れの中での位置（右へ / 前へ）, period: 息つぎの周期, off: ずらし, blows: 潮を吹く時刻
  // surf: 水面にいる時間, dive: 潜るのにかかる時間, rise: 浮上にかかる時間, depth: 泳ぐ深さ
  // pmax: 上下の傾きの最大, arch: 潜り始めに前へ傾ける量（水深 35m の海底に頭が当たらないように）, puffs: 1回の潮吹きの霧の粒の数
  const WHALES = [
    { len: 56, lat: 0, back: 0, period: 150, off: 0, blows: [3, 11, 19], surf: 24, dive: 14, rise: 20, depth: -14, freq: 0.11, amp: 2.2, spout: 26, size: 9, pmax: 0.35, arch: 0.25, puffs: 110 },
    { len: 52, lat: 85, back: -50, period: 150, off: 52, blows: [4, 12, 20], surf: 24, dive: 14, rise: 20, depth: -15, freq: 0.10, amp: 2.1, spout: 24, size: 8.5, pmax: 0.35, arch: 0.25, puffs: 100 },
    { len: 24, lat: -26, back: -10, period: 75, off: 5, blows: [3, 10], surf: 14, dive: 8, rise: 12, depth: -8, freq: 0.22, amp: 1.2, spout: 14, size: 4.5, pmax: 0.45, arch: 0.35, puffs: 60 },
  ];

  // ================= 体の形 =================
  //  体の軸は +Z（頭）。体長 1 で作って、置くときに体長倍する
  function whaleGeo() {
    const pos = [], nrm = [], col = [];
    const DARK = [0.13, 0.15, 0.19], BELLY = [0.80, 0.81, 0.82], FIN = [0.72, 0.73, 0.74];
    const tri = function (a, b, c, na, nb, nc, ca, cb, cc) {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      nrm.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
      col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    };
    // 胴体: 尾の付け根(0) → 頭(1) の太さ。ザトウクジラらしく、尾の付け根は細長い
    const PROF = [[0, 0.05], [0.12, 0.12], [0.28, 0.38], [0.42, 0.75], [0.56, 0.98], [0.68, 1.0], [0.80, 0.90], [0.90, 0.68], [0.96, 0.42], [1.0, 0.08]];
    const RM = 0.105, NR = 26, NS = 16;
    const prof = function (t) {
      for (let k = 1; k < PROF.length; k++) if (t <= PROF[k][0]) {
        const a = PROF[k - 1], b = PROF[k], q = smooth((t - a[0]) / (b[0] - a[0]));
        return a[1] + (b[1] - a[1]) * q;
      }
      return PROF[PROF.length - 1][1];
    };
    const ring = function (t) {
      const r = RM * prof(t), z = -0.5 + t, out = [];
      for (let j = 0; j <= NS; j++) {
        const a = j / NS * TAU, s = Math.sin(a), c = Math.cos(a);
        const y = r * s * (s > 0 ? (t > 0.85 ? 0.68 : 0.82) : 0.74) - r * 0.06;
        const belly = Math.max(0, Math.min(1, (-s - 0.15) * 1.6)) * (t > 0.45 ? 1 : 0.4);
        const shade = 0.9 + 0.2 * COL.noise2(j * 0.7, t * 9, 5);
        const cc = [(DARK[0] + (BELLY[0] - DARK[0]) * belly) * shade, (DARK[1] + (BELLY[1] - DARK[1]) * belly) * shade, (DARK[2] + (BELLY[2] - DARK[2]) * belly) * shade];
        out.push({ p: [r * c * 0.95, y, z], n: V.norm([c, s * 1.15, 0]), c: cc });
      }
      return out;
    };
    let prev = ring(0);
    for (let k = 1; k <= NR; k++) {
      const cur = ring(k / NR);
      for (let j = 0; j < NS; j++) {
        const a = prev[j], b = prev[j + 1], c = cur[j], d = cur[j + 1];
        tri(a.p, c.p, b.p, a.n, c.n, b.n, a.c, c.c, b.c);
        tri(b.p, c.p, d.p, b.n, c.n, d.n, b.c, c.c, d.c);
      }
      prev = cur;
    }
    // 頭の先と尾の先をふさぐ
    [[0, [0, -RM * 0.006, -0.5], [0, 0, -1]], [1, [0, -RM * 0.006, 0.5], [0, 0, 1]]].forEach(function (e) {
      const rg = ring(e[0]);
      for (let j = 0; j < NS; j++) tri(e[1], rg[j].p, rg[j + 1].p, e[2], e[2], e[2], DARK, rg[j].c, rg[j + 1].c);
    });
    // 板の形（胸びれ・尾びれ・背びれ）: 点の列 top を上下両面に
    const plate = function (pts, n, c) { for (let k = 1; k + 1 < pts.length; k++) tri(pts[0], pts[k], pts[k + 1], n, n, n, c, c, c); };
    // 胸びれ（とても長い。体長の 3 分の 1）
    for (let sd = -1; sd <= 1; sd += 2) {
      const root = [sd * RM * 0.8, -RM * 0.35, 0.16], dir = V.norm([sd * 1.0, -0.38, -0.5]), back = V.norm([0, 0, -1]);
      const L = 0.31, pts = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6, ch = 0.075 * (1 - t) + 0.02, c = V.add(root, V.mul(dir, L * t));
        pts.push({ f: V.add(c, V.mul(back, -ch * 0.35)), b: V.add(c, V.mul(back, ch * 0.65)) });
      }
      const nn = V.norm(V.cross(dir, back)), cc = FIN;
      for (let k = 0; k < 6; k++) {
        tri(pts[k].f, pts[k + 1].f, pts[k].b, nn, nn, nn, cc, cc, cc);
        tri(pts[k].b, pts[k + 1].f, pts[k + 1].b, nn, nn, nn, cc, cc, cc);
      }
    }
    // 尾びれ（水平。左右の葉の真ん中に切れ込み）
    for (let sd = -1; sd <= 1; sd += 2) {
      const z0 = -0.5;
      plate([[0, 0, z0 + 0.03], [sd * 0.05, 0, z0 - 0.0], [sd * 0.16, 0, z0 - 0.06], [sd * 0.17, 0, z0 - 0.085], [sd * 0.08, 0, z0 - 0.075], [0, 0, z0 - 0.04]], [0, 1, 0], DARK);
    }
    // 背びれ（小さなこぶ）
    plate([[0, RM * 0.75, -0.14], [0, RM * 0.95, -0.17], [0, RM * 0.62, -0.22]], [1, 0, 0], DARK);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    g.boundingSphere.radius *= 1.4;
    return g;
  }

  // 尾に向かってしなる（尾の先ほど大きく上下する）
  const whaleVS = GL.VS_HEAD + `
    uniform float phase, amp, len;
    varying vec3 vWorld, vN, vCol;
    void main() {
      vec3 p = position;
      float back = clamp((0.1 - p.z) / 0.6, 0.0, 1.0);
      float k = back * back;
      p.y += amp / len * sin(phase - back * 2.2) * k;
      vec4 wp = modelMatrix * vec4(p, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      vCol = color;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + GL.VS_TAIL + `
    }`;
  const whaleFS = GL.FS_HEAD + GL.COMMON + GL.NOISE2 + GL.CAUSTIC + `
    varying vec3 vWorld, vN, vCol;
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN);
      if (!gl_FrontFacing) N = -N;
      vec3 V = normalize(cameraPosition - vWorld), ld = sunDirAt(vWorld);
      vec3 light = lightAt(vWorld, N);
      // 皮膚のまだら模様
      vec3 q = mod(vWorld, 512.0);
      float n = vnoise(q.xz * 1.1 + q.y * 0.3) * 0.5 + vnoise(q.zy * 2.7) * 0.5;
      vec3 col = vCol * (0.82 + 0.36 * n);
      // 水の中: 光の網目と、青みがかり
      float dpt = length(vWorld.xy) - COL_R;
      if (dpt > 0.1) {
        float ck = smoothstep(0.1, 1.0, dpt) * exp(-dpt / 16.0);
        light += sunCol * caustic(vWorld.xz / 9.0, time * 0.7) * ck * 0.7 * max(dot(N, -normalize(vec3(vWorld.xy, 0.0))), 0.0);
        light *= mix(vec3(1.0), exp(-dpt * vec3(0.09, 0.03, 0.02)), smoothstep(0.0, 0.6, dpt));
      }
      // ぬれた肌のつや
      col = col * light + sunCol * pow(max(dot(reflect(-ld, N), V), 0.0), 30.0) * 0.25;
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`;

  // 潮吹きの霧の粒
  const spoutVS = GL.VS_HEAD + `
    attribute float alpha;
    attribute float size;
    uniform float pscale;
    varying float vA;
    void main() {
      vA = alpha;
      vec4 mvPosition = viewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = size * pscale / max(-mvPosition.z, 0.1);` + GL.VS_TAIL + `
    }`;
  const spoutFS = GL.FS_HEAD + GL.COMMON + `
    varying float vA;
    void main() {
      #include <logdepthbuf_fragment>
      float d = length(gl_PointCoord - 0.5);
      float a = vA * (1.0 - smoothstep(0.12, 0.5, d));
      if (a < 0.01) discard;
      gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * (ambCol * 1.05 + sunCol * 0.85), a);
      #include <fog_fragment>
    }`;

  // ================= 動き =================
  let wclock = 0;
  const whales = [];
  const NP = 420;
  const parts = [];
  let pGeo = null, pMat = null;

  // 息つぎの周期の中の状態: h 体の中心の高さ（水面 = 0）、arch 潜り始めに体を傾ける度合い
  function diveState(w, t) {
    const P = w.period, tt = ((t + w.off) % P + P) % P;
    const r = w.len * 0.105, hs = -r * 0.45;
    const S = w.surf, D = S + w.dive, A = P - w.rise;
    let h, arch = 0;
    if (tt < S) h = hs + Math.sin(tt * 1.3) * 0.08;                                                           // 水面で息をする
    else if (tt < D) { const q = (tt - S) / w.dive; h = hs + (w.depth - hs) * smooth(q); arch = Math.sin(Math.PI * Math.min(1, q * 1.3)); }   // 尾を上げて潜る
    else if (tt < A) h = w.depth + Math.sin(tt * 0.15 + w.off) * 1.5;                                          // 深い所を泳ぐ
    else h = w.depth + (hs - w.depth) * smooth((tt - A) / w.rise);                                             // 浮上
    return { h: h, arch: arch, tt: tt };
  }
  // 時刻 t のクジラ i の位置と向き
  function pose(i, t) {
    const w = WHALES[i], om = POD.speed / ((POD.ru + POD.rz) / 2), a = POD.a0 + t * om;
    let du = -POD.ru * Math.sin(a), dz = POD.rz * Math.cos(a);
    const dl = Math.hypot(du, dz); du /= dl; dz /= dl;
    const lat = w.lat + Math.sin(t * 0.05 + i * 2.1) * w.len * 0.2, back = w.back + Math.sin(t * 0.07 + i) * w.len * 0.15;
    const u = POD.cu + POD.ru * Math.cos(a) + dz * lat + du * back, z = POD.cz + POD.rz * Math.sin(a) - du * lat + dz * back;
    const ds = diveState(w, t), d1 = diveState(w, t + 0.5).h, d0 = diveState(w, t - 0.5).h;
    const pitch = Math.max(-w.pmax, Math.min(w.pmax, Math.atan2(d1 - d0, POD.speed))) - ds.arch * w.arch;
    return { u: u, z: z, h: ds.h, du: du, dz: dz, pitch: pitch, ds: ds };
  }
  function placeWhale(i, P) {
    const w = whales[i], th = COL.landTheta(0, P.u), f = COL.frameAt(th);
    const F = V.norm(V.add(V.mul(f.east, P.du), [0, 0, P.dz]));
    const cp = Math.cos(P.pitch), sp = Math.sin(P.pitch);
    const Z = V.add(V.mul(F, cp), V.mul(f.up, sp)), Y = V.sub(V.mul(f.up, cp), V.mul(F, sp)), X = V.cross(Y, Z);
    const L = WHALES[i].len, c = COL.toWorld(th, P.z, P.h);
    w.mesh.matrix.set(X[0] * L, Y[0] * L, Z[0] * L, c[0], X[1] * L, Y[1] * L, Z[1] * L, c[1], X[2] * L, Y[2] * L, Z[2] * L, c[2], 0, 0, 0, 1);
    w.mesh.matrixWorldNeedsUpdate = true;
    w.Y = Y; w.Z = Z; w.c = c; w.up = f.up;
  }
  // 潮を吹く: 頭の上の噴気孔から霧の粒を吹き上げる
  function blow(i) {
    const W = WHALES[i], w = whales[i], L = W.len;
    const hole = V.add(w.c, V.add(V.mul(w.Z, 0.27 * L), V.mul(w.Y, 0.105 * 0.7 * L)));
    let made = 0;
    for (let k = 0; k < NP && made < W.puffs; k++) {
      const p = parts[k];
      if (p.age < p.life) continue;
      const side = V.norm(V.cross(w.up, [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]));
      p.age = -made * 0.8 / W.puffs; p.life = 2.6 + Math.random() * 2.0;
      p.p = V.add(hole, V.mul(side, Math.random() * W.size * 0.08));
      p.v = V.add(V.mul(w.up, W.spout * (0.45 + 0.8 * Math.random())), V.mul(side, (0.2 + Math.random() * 0.8) * W.size * 0.3));
      p.up = w.up; p.s1 = W.size * (0.45 + 0.6 * Math.random());
      made++;
    }
    if (COL.whaleBlowSound) COL.whaleBlowSound(V.len(V.sub(hole, camPos)));
  }
  let camPos = [0, 0, 0];

  COL.buildWhales = function (scene) {
    const geo = whaleGeo();
    WHALES.forEach(function (W) {
      const mat = GL.material(whaleVS, whaleFS, { phase: { value: 0 }, amp: { value: W.amp }, len: { value: W.len } }, { vertexColors: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      whales.push({ mesh: mesh, mat: mat, phase: Math.random() * TAU, prevTT: -1 });
    });
    for (let k = 0; k < NP; k++) parts.push({ age: 1, life: 0, p: [0, 0, 0], v: [0, 0, 0], up: [0, 1, 0], s1: 1 });
    pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
    pGeo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(NP), 1));
    pGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(NP), 1));
    pMat = GL.material(spoutVS, spoutFS, { pscale: { value: 600 } }, { transparent: true, depthWrite: false });
    const pts = new THREE.Points(pGeo, pMat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    scene.add(pts);
  };

  // 1ステップ進める（位置・潮吹き・霧の粒）
  function stepWhales(dt, p) {
    wclock += dt;
    camPos = p.pos;
    let nearest = 1e9;
    for (let i = 0; i < WHALES.length; i++) {
      const W = WHALES[i], w = whales[i], P = pose(i, wclock);
      placeWhale(i, P);
      // 尾びれの振り: 潜る・浮上するときは大きく速く
      const busy = P.ds.arch > 0 || Math.abs(P.pitch) > 0.1 ? 1 : 0;
      w.phase += dt * TAU * W.freq * (1 + 0.6 * busy);
      w.mat.uniforms.phase.value = w.phase;
      w.mat.uniforms.amp.value = W.amp * (1 + 0.8 * busy) * (P.ds.tt < W.surf ? 0.5 : 1);
      // 潮を吹く時刻を過ぎたら吹く
      const tt = P.ds.tt;
      W.blows.forEach(function (b) { if (w.prevTT >= 0 && w.prevTT < b && tt >= b) blow(i); });
      w.prevTT = tt;
      nearest = Math.min(nearest, V.len(V.sub(w.c, p.pos)));
    }
    COL.whaleDist = nearest;
    // 霧の粒: 上へ吹き上がり、空気の抵抗で止まって広がり、薄れて消える
    const P3 = pGeo.attributes.position.array, A = pGeo.attributes.alpha.array, S = pGeo.attributes.size.array;
    for (let k = 0; k < NP; k++) {
      const q = parts[k];
      if (q.age >= q.life) { A[k] = 0; continue; }
      q.age += dt;
      if (q.age < 0) { A[k] = 0; continue; }
      q.v = V.add(V.mul(q.v, Math.exp(-dt * 1.2)), V.mul(q.up, -9.81 * 0.3 * dt));
      q.p = V.add(q.p, V.mul(q.v, dt));
      const f = q.age / q.life;
      P3[k * 3] = q.p[0]; P3[k * 3 + 1] = q.p[1]; P3[k * 3 + 2] = q.p[2];
      A[k] = smooth(f / 0.06) * Math.pow(1 - f, 1.3) * 0.75;
      S[k] = 0.3 + (q.s1 - 0.3) * f;
    }
    pGeo.attributes.position.needsUpdate = pGeo.attributes.alpha.needsUpdate = pGeo.attributes.size.needsUpdate = true;
  }
  COL.updateWhales = function (dt, p, camera, renderer) {
    stepWhales(dt, p);
    pMat.uniforms.pscale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
  };

  // 確認用: クジラの時計を進め、親クジラの横から見る位置に立つ（?whale=1&wt=秒&wd=距離&wh=高さ&ws=横向きの角度）
  COL.debugWhale = function (p, t, dist, hgt, side) {
    // 指定の時刻の 1.5 秒前から動かしておく（潮吹きの霧が見えるように）
    wclock = t - 1.5;
    for (let i = 0; i < whales.length; i++) whales[i].prevTT = -1;
    for (let k = 0; k < 45; k++) stepWhales(1 / 30, p);
    wclock = t - 1 / 30;
    const P = pose(0, t), th = COL.landTheta(0, P.u), f = COL.frameAt(th);
    const F = V.norm(V.add(V.mul(f.east, P.du), [0, 0, P.dz])), Rt = V.cross(F, f.up);
    const a = side || 0, dir = V.add(V.mul(Rt, Math.cos(a)), V.mul(F, Math.sin(a)));
    const c = COL.toWorld(th, P.z, P.h), at = V.add(c, V.add(V.mul(dir, dist), V.mul(f.up, hgt - P.h)));
    const ac = COL.toCyl(at);
    p.pos = COL.toWorld(ac.theta, ac.z, ac.h); p.vel = [0, 0, 0]; p.fly = true;
    COL.stepPlayer(p, {}, 0);
    p.fwd = V.norm(V.sub(V.sub(c, at), V.mul(p.up, V.dot(V.sub(c, at), p.up))));
  };
})();
