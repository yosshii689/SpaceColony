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
  //  uv: 胴体は (体のまわりの位置 0〜1, 尾 0 → 頭 1)。模様・のどの畝・口・目はこれを使ってシェーダーで描く。ひれ・こぶは uv.x = -1
  function whaleGeo() {
    const pos = [], nrm = [], col = [], uvs = [];
    const DARK = [0.115, 0.135, 0.17], WHITE = [0.84, 0.85, 0.86];
    const mixc = function (a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
    // 断面の列（どの列も同じ点の数。最後の点は最初の点と同じ位置）をつないで、なめらかな面にする
    const loft = function (rows) {
      const K = rows.length, J = rows[0].length, M = J - 1;
      const cen = rows.map(function (r) { let c = [0, 0, 0]; for (let j = 0; j < M; j++) c = V.add(c, r[j].p); return V.mul(c, 1 / M); });
      const nr = rows.map(function (r, k) {
        return r.map(function (q, j) {
          const jj = j % M, dR = V.sub(r[(jj + 1) % M].p, r[(jj + M - 1) % M].p);
          const dA = V.sub(rows[Math.min(K - 1, k + 1)][j].p, rows[Math.max(0, k - 1)][j].p);
          let n = V.cross(dR, dA);
          const out = V.sub(q.p, cen[k]);
          if (V.len(n) < 1e-14) n = V.len(out) > 1e-9 ? out : dA;
          if (V.len(n) < 1e-14) n = [0, 1, 0];
          n = V.norm(n);
          return V.dot(n, out) < 0 ? V.mul(n, -1) : n;
        });
      });
      const put = function (q, n) { pos.push(q.p[0], q.p[1], q.p[2]); nrm.push(n[0], n[1], n[2]); col.push(q.c[0], q.c[1], q.c[2]); uvs.push(q.uv[0], q.uv[1]); };
      for (let k = 0; k + 1 < K; k++) for (let j = 0; j < M; j++) {
        put(rows[k][j], nr[k][j]); put(rows[k + 1][j], nr[k + 1][j]); put(rows[k][j + 1], nr[k][j + 1]);
        put(rows[k][j + 1], nr[k][j + 1]); put(rows[k + 1][j], nr[k + 1][j]); put(rows[k + 1][j + 1], nr[k + 1][j + 1]);
      }
    };
    // 列を、その中心へ縮めた列（先をふさぐ用）
    const shrink = function (row, f) {
      let c = [0, 0, 0];
      for (let j = 0; j + 1 < row.length; j++) c = V.add(c, row[j].p);
      c = V.mul(c, 1 / (row.length - 1));
      return row.map(function (q) { return { p: V.add(c, V.mul(V.sub(q.p, c), f)), c: q.c, uv: q.uv }; });
    };
    // ---- 胴体: 尾の付け根(0) → 頭(1) の太さ。ザトウクジラらしく、尾の付け根は細長く、頭は平たくて下あごが大きい ----
    const PROF = [[0, 0.085], [0.12, 0.13], [0.28, 0.38], [0.42, 0.75], [0.56, 0.98], [0.68, 1.0], [0.80, 0.93], [0.90, 0.76], [0.96, 0.54], [0.99, 0.33], [1.0, 0.16]];
    const RM = 0.105, NR = 64, NS = 36;
    const prof = function (t) {
      for (let k = 1; k < PROF.length; k++) if (t <= PROF[k][0]) {
        const a = PROF[k - 1], b = PROF[k], q = smooth((t - a[0]) / (b[0] - a[0]));
        return a[1] + (b[1] - a[1]) * q;
      }
      return PROF[PROF.length - 1][1];
    };
    const mouthPhi = function (t) { return -0.10 + 0.52 * smooth((t - 0.74) / 0.26); };     // 口の線の高さ（シェーダーと同じ式）
    const bodyPt = function (t, a) {
      const sn = Math.sin(a), cs = Math.cos(a), r = RM * prof(t), z = -0.5 + t;
      const head = smooth((t - 0.70) / 0.22), ped = 1 - smooth(t / 0.30);
      const top = (0.82 - 0.22 * head) * (1 + 0.30 * ped), bot = (0.74 + 0.24 * head * (1 - 0.5 * smooth((t - 0.93) / 0.07))) * (1 + 0.30 * ped);
      let wid = (0.95 + 0.05 * head) * (1 - 0.45 * ped);
      // 上あごは細く平たいふた、下あごは幅が広い
      const mp = mouthPhi(t);
      wid *= 1 + head * (sn < mp ? 0.07 * smooth((mp - sn) / 0.25) * smooth((sn + 1) / 0.5) : -0.13 * smooth((sn - mp) / 0.35));
      let y = r * sn * (sn > 0 ? top : bot) - r * 0.06;
      // 上あごの平たさ: 真上のあたりを低く
      if (sn > 0) y -= r * 0.10 * head * Math.pow(sn, 4);
      // 背中のこぶ（背びれの土台）と、尾の付け根の背と腹の峰
      y += RM * 0.085 * Math.exp(-Math.pow((t - 0.335) / 0.05, 2)) * Math.pow(Math.max(0, sn), 6);
      y += r * 0.22 * ped * Math.pow(Math.abs(sn), 8) * Math.sign(sn);
      return [r * cs * wid, y, z];
    };
    const rows = [];
    for (let k = 0; k <= NR; k++) {
      const t = k / NR, row = [];
      for (let j = 0; j <= NS; j++) {
        const a = (j % NS) / NS * TAU, sh = 0.92 + 0.16 * COL.noise2(Math.cos(a) * 2.3 + t * 9, Math.sin(a) * 2.3, 5);
        row.push({ p: bodyPt(t, a), c: [sh, sh, sh], uv: [j / NS, t] });
      }
      rows.push(row);
    }
    rows.unshift(shrink(rows[0], 0.02));
    rows.push(shrink(rows[rows.length - 1], 0.45).map(function (q) { return { p: V.add(q.p, [0, 0, 0.006]), c: q.c, uv: q.uv }; }));
    rows.push(shrink(rows[rows.length - 1], 0.02).map(function (q) { return { p: V.add(q.p, [0, 0, 0.002]), c: q.c, uv: q.uv }; }));
    loft(rows);
    // ---- 頭のこぶ（上あごに3列、下あごの先にも）----
    const knob = function (t, a, rad) {
      const c = bodyPt(t, a), g = new THREE.IcosahedronGeometry(1, 1), P = g.attributes.position;
      const out = V.norm([Math.cos(a), Math.sin(a) * 1.3, 0.25]);
      for (let k = 0; k < P.count; k++) {
        const d = [P.getX(k), P.getY(k), P.getZ(k)];
        const q = V.add(V.add(c, V.mul(out, -rad * 0.35)), [d[0] * rad, d[1] * rad, d[2] * rad * 1.25]);
        pos.push(q[0], q[1], q[2]); nrm.push(d[0], d[1], d[2]); col.push(DARK[0] * 1.15, DARK[1] * 1.15, DARK[2] * 1.15); uvs.push(-1, 2);
      }
    };
    const kr = COL.rng(77);
    for (let k = 0; k < 8; k++) { const t = 0.795 + k * 0.026; knob(t, Math.PI / 2, 0.0034 + 0.0010 * kr()); }
    for (let k = 0; k < 7; k++) for (let sd = -1; sd <= 1; sd += 2) { const t = 0.80 + k * 0.027; knob(t, Math.PI / 2 + sd * (0.62 - 0.02 * k), 0.0030 + 0.0010 * kr()); }
    for (let k = 0; k < 5; k++) for (let sd = -1; sd <= 1; sd += 2) knob(0.90 + k * 0.02, -Math.PI / 2 + sd * (0.75 - 0.10 * k), 0.0030 + 0.0012 * kr());
    knob(0.992, -Math.PI / 2, 0.0050);
    // ---- 胸びれ（とても長い。体長の 3 分の 1）: 厚みのある翼の形。前のふちに でこぼこ、上は黒白のまだら、下は白 ----
    for (let sd = -1; sd <= 1; sd += 2) {
      const root = [sd * RM * 0.78, -RM * 0.36, 0.165], dir = V.norm([sd * 1.0, -0.40, -0.52]), back = [0, 0, -1], nn = V.norm(V.cross(dir, back));
      const L = 0.315, NK = 18, NA = 12, fr = [];
      for (let k = 0; k <= NK; k++) {
        const t = k / NK, c = V.add(V.add(root, V.mul(dir, L * t)), [0, -0.022 * t * t, -0.02 * t * t]);
        const ch = (0.074 * (1 - Math.pow(t, 1.7)) + 0.010) * (0.62 + 0.38 * smooth(t / 0.14));
        const bump = 0.0055 * Math.max(0, Math.sin(t * Math.PI * 9.5)) * (1 - 0.6 * t) * smooth((t - 0.08) / 0.1);
        const th = ch * 0.12 * (1 - 0.45 * t), le = V.add(c, V.mul(back, -(ch * 0.36 + bump))), row = [];
        for (let j = 0; j <= NA; j++) {
          const ph = (j % NA) / NA * TAU, xc = 0.5 - 0.5 * Math.cos(ph), yy = Math.sin(ph) * th * (1.25 - 0.75 * xc);
          const pp = V.add(V.add(le, V.mul(back, xc * (ch + bump))), V.mul(nn, yy));
          const topSide = Math.sin(ph) * sd > 0, nz = COL.noise2(t * 7 + sd * 3, xc * 3, 41);
          const cc = topSide ? mixc(DARK, WHITE, smooth((nz - 0.42) / 0.12) * (0.25 + 0.75 * t) + (xc < 0.12 ? 0.5 : 0)) : WHITE;
          row.push({ p: pp, c: [Math.min(0.86, cc[0]), Math.min(0.87, cc[1]), Math.min(0.88, cc[2])], uv: [-1, 0] });
        }
        fr.push(row);
      }
      fr.push(shrink(fr[fr.length - 1], 0.03));
      loft(fr);
    }
    // ---- 尾びれ（水平）: 厚みのある翼の形。真ん中に切れ込み、後ろのふちは ぎざぎざ。裏は白い模様 ----
    for (let sd = -1; sd <= 1; sd += 2) {
      const z0 = -0.5, NK = 16, NA = 10, fr = [];
      for (let k = 0; k <= NK; k++) {
        const t = k / NK, le = 0.034 - 0.119 * Math.pow(t, 1.15);
        const te = Math.min(le - 0.0025, -0.040 - 0.042 * smooth(t / 0.45) - 0.003 * t + 0.0030 * Math.sin(t * 44) * smooth(t / 0.15) * (1 - t));
        const th = 0.0105 * Math.pow(1 - t, 0.8) + 0.0012, row = [];
        for (let j = 0; j <= NA; j++) {
          const ph = (j % NA) / NA * TAU, xc = 0.5 - 0.5 * Math.cos(ph), up = Math.sin(ph);
          const nz = COL.noise2(t * 5 + sd * 9, xc * 4, 53);
          const cc = up < 0 ? mixc(DARK, WHITE, smooth((nz - 0.35) / 0.15) * smooth((t - 0.08) / 0.2) * (1 - smooth((xc - 0.7) / 0.25))) : DARK;
          row.push({ p: [sd * 0.172 * t, up * th * (1.2 - 0.7 * xc) + 0.004 * t * t, z0 + le - xc * (le - te)], c: cc, uv: [-1, 1] });
        }
        fr.push(row);
      }
      fr.push(shrink(fr[fr.length - 1], 0.03));
      loft(fr);
    }
    // ---- 背びれ（こぶの上の、後ろへ反った小さなひれ）----
    {
      const NK = 7, NA = 10, fr = [], yb = Math.min(bodyPt(0.365, Math.PI / 2)[1], bodyPt(0.285, Math.PI / 2)[1]) - 0.002, H = RM * 0.21;
      for (let k = 0; k <= NK; k++) {
        const t = k / NK, le = -0.150 - 0.050 * Math.pow(t, 0.7), te = Math.min(le - 0.004, -0.215 - 0.014 * t), th = 0.0055 * (1 - t) + 0.0008, row = [];
        for (let j = 0; j <= NA; j++) {
          const ph = (j % NA) / NA * TAU, xc = 0.5 - 0.5 * Math.cos(ph);
          row.push({ p: [Math.sin(ph) * th * (1.2 - 0.6 * xc), yb + H * t, le - xc * (le - te)], c: DARK, uv: [-1, 1] });
        }
        fr.push(row);
      }
      fr.push(shrink(fr[fr.length - 1], 0.03));
      loft(fr);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeBoundingSphere();
    g.boundingSphere.radius *= 1.4;
    return g;
  }

  // 尾に向かってしなる（尾の先ほど大きく上下する）
  const whaleVS = GL.VS_HEAD + `
    uniform float phase, amp, len;
    varying vec3 vWorld, vN, vCol, vObj, vAxis;
    varying vec2 vUv;
    void main() {
      vec3 p = position;
      float back = clamp((0.1 - p.z) / 0.6, 0.0, 1.0);
      float k = back * back;
      p.y += amp / len * sin(phase - back * 2.2) * k;
      vec4 wp = modelMatrix * vec4(p, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      vAxis = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
      vCol = color;
      vObj = position;
      vUv = uv;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + GL.VS_TAIL + `
    }`;
  const whaleFS = GL.FS_HEAD + GL.COMMON + GL.NOISE2 + GL.CAUSTIC + `
    uniform float seed, len;
    varying vec3 vWorld, vN, vCol, vObj, vAxis;
    varying vec2 vUv;
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vWorld), ld = sunDirAt(vWorld);
      vec3 base = vCol;
      vec3 q = vObj * len;                                       // 体の上の位置 [m]（泳いでも模様がずれない）
      float nearK = clamp(1.0 - length(fwidth(q)) * 3.0, 0.0, 1.0);
      if (vUv.x >= 0.0) {
        float a = vUv.x * 6.2831853, s = sin(a), c = cos(a), v = vUv.y;
        // 背は黒く、腹は白い（境目は個体ごとに違う、入り組んだ形）
        float n1 = vnoise(vec2(c * 2.6 + v * 13.0 + seed, s * 2.6 - seed * 0.7));
        float thr = mix(0.80, 0.34, smoothstep(0.38, 0.62, v));
        float belly = smoothstep(thr - 0.10, thr + 0.10, -s + (n1 - 0.5) * 0.75);
        base = mix(vec3(0.15, 0.17, 0.21), vec3(0.80, 0.81, 0.82), belly) * vCol;
        // のどの畝（下あごから へそ まで、縦に走る溝）
        float phiM = -0.10 + 0.52 * smoothstep(0.74, 1.0, v);
        float pk = smoothstep(0.50, 0.60, v) * (1.0 - smoothstep(0.975, 0.997, v)) * smoothstep(0.03, 0.20, phiM - s);
        float fineK = clamp(1.0 - fwidth(vUv.x) * 46.0 * 1.6, 0.0, 1.0);
        float groove = pow(0.5 - 0.5 * cos(a * 46.0), 3.0);
        vec3 T = normalize(cross(vAxis, N));
        N = normalize(N + T * sin(a * 46.0) * 0.60 * pk * fineK);
        base *= 1.0 - 0.50 * groove * pk * fineK;
        // 口の線
        float ml = (1.0 - smoothstep(0.010, 0.028, abs(s - phiM))) * smoothstep(0.740, 0.748, v) * clamp(1.0 - fwidth(s) / 0.03, 0.0, 1.0);
        base *= 1.0 - 0.78 * ml;
        // 目（口の線の終わりのすぐ下）
        float er = length(vec2(v - 0.733, (s + 0.22) * 0.085));
        base = mix(base, base * 1.5 + 0.04, (1.0 - smoothstep(0.0042, 0.0062, er)) * 0.6);
        base = mix(base, vec3(0.015), 1.0 - smoothstep(0.0028, 0.0036, er));
        // 噴気孔（頭の上の2本の切れ目）
        float bh = (1.0 - smoothstep(0.0010, 0.0020, abs(abs(vObj.x) - 0.0042 - (v - 0.795) * 0.12))) * (1.0 - smoothstep(0.008, 0.010, abs(v - 0.795))) * step(0.5, s);
        base *= 1.0 - 0.85 * bh;
      }
      // 皮膚のまだら・古い傷あと・フジツボの白い点
      float n = vnoise(q.xz * 1.1 + q.y * 0.3 + seed) * 0.5 + vnoise(q.zy * 2.7 - seed) * 0.5;
      vec3 col = base * (0.80 + 0.40 * n);
      float scar = (1.0 - smoothstep(0.0, 0.035, abs(vnoise(q.zy * vec2(0.35, 1.6) + seed * 2.0) - 0.5))) * step(0.62, vnoise(q.zx * 0.21 + seed)) * nearK;
      col = mix(col, vec3(0.62, 0.64, 0.66), scar * 0.45);
      float bn = step(0.78, vnoise(q.zy * 9.0 + seed)) * smoothstep(0.66, 0.82, vnoise(q.zx * 0.55 + q.y * 0.4 + seed * 3.0)) * nearK;
      col = mix(col, vec3(0.86, 0.85, 0.78), bn * 0.85);
      vec3 light = lightAt(vWorld, N);
      // 水の中: 光の網目と、青みがかり
      float dpt = length(vWorld.xy) - COL_R;
      if (dpt > 0.1) {
        float ck = smoothstep(0.1, 1.0, dpt) * exp(-dpt / 16.0);
        light += sunCol * caustic(vWorld.xz / 9.0, time * 0.7) * ck * 0.7 * max(dot(N, -normalize(vec3(vWorld.xy, 0.0))), 0.0);
        light *= mix(vec3(1.0), exp(-dpt * vec3(0.09, 0.03, 0.02)), smoothstep(0.0, 0.6, dpt));
      }
      // ぬれた肌のつや（水の上では空も映す）
      float wetK = 1.0 - smoothstep(0.0, 1.5, dpt);
      float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
      col = col * light + sunCol * pow(max(dot(reflect(-ld, N), V), 0.0), 60.0) * (0.25 + 1.1 * wetK)
          + (ambCol * 1.1 + sunCol * 0.2) * (0.05 + 0.60 * fres) * wetK;
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
    WHALES.forEach(function (W, wi) {
      const mat = GL.material(whaleVS, whaleFS, { phase: { value: 0 }, amp: { value: W.amp }, len: { value: W.len }, seed: { value: 3.7 + wi * 17.3 } }, { vertexColors: true, side: THREE.DoubleSide });
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
    const on = COL.whalesOn !== 0;                  // 軽い画質ではクジラを出さず、動きの計算もしない
    for (let i = 0; i < whales.length; i++) whales[i].mesh.visible = on;
    pMat.visible = on;
    if (!on) return;
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
