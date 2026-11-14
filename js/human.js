// 住民の体: 断面をつないだ人の形（男女の2体型）と、歩く動きを頂点シェーダーで付ける材料
//  形は 身長およそ 1.75m・足元が原点・前が +z の立ち姿で作り、頂点ごとに「どの骨について動くか」を持たせる
//  毎フレーム JS から渡すのは、脚・膝・腕・肘の角度と、体の上下・左右の揺れ・前傾・ひねりだけ
//  服の色・髪型・袖や丈の長さなどは 1人ごとの値で切り替える（形は男女で2つだけ）
(function () {
  'use strict';
  const COL = window.COL, TAU = Math.PI * 2, V = COL.V;

  // 骨の番号（左 = x が負の側）
  const PELVIS = 0, CHEST = 1, HEAD = 2, THIGH = [3, 6], SHIN = [4, 7], FOOT = [5, 8], UARM = [9, 11], FARM = [10, 12];
  // 部位の番号（色の決め方）
  const RG = { TORSO: 0, ARM: 1, HAND: 2, LEG: 3, SHOE: 4, HEAD: 5, HAIR: 6, LONG: 7, SKIRT: 8, BAG: 9, EYE: 10 };
  // 関節の位置（右側。左は x を反転）。シェーダーの J_* と同じ値
  const J = { hip: [0.090, 0.93, 0.0], knee: [0.095, 0.51, 0.012], ankle: [0.100, 0.085, -0.012], sh: [0.180, 1.415, -0.012], elbow: [0.205, 1.12, -0.03], wrist: [0.215, 0.86, -0.005] };
  const EYE_Y = 1.638, EYE_X = 0.0315, EYE_R = 0.0118;

  const sm = function (x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
  const spow = function (v, e) { return Math.sign(v) * Math.pow(Math.abs(v), e); };
  // 表 [x, 値1, 値2, ...] をなめらかにつなぐ（Catmull-Rom）
  function crInterp(T, x) {
    const n = T.length;
    if (x <= T[0][0]) return T[0].slice(1);
    if (x >= T[n - 1][0]) return T[n - 1].slice(1);
    let k = 0;
    while (k < n - 2 && x > T[k + 1][0]) k++;
    const p0 = T[Math.max(0, k - 1)], p1 = T[k], p2 = T[k + 1], p3 = T[Math.min(n - 1, k + 2)];
    const t = (x - p1[0]) / (p2[0] - p1[0]), t2 = t * t, t3 = t2 * t, out = [];
    for (let c = 1; c < p1.length; c++) {
      // 端の区間で行き過ぎないよう、となりの点の傾きは区間の幅でならす
      const m1 = (p2[c] - p0[c]) / (p2[0] - p0[0] || 1) * (p2[0] - p1[0]);
      const m2 = (p3[c] - p1[c]) / (p3[0] - p1[0] || 1) * (p2[0] - p1[0]);
      out.push((2 * t3 - 3 * t2 + 1) * p1[c] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[c] + (t3 - t2) * m2);
    }
    return out;
  }

  // ---- 形を作る道具 ----
  function Geo() { this.P = []; this.N = []; this.B = []; this.UV = []; this.I = []; }
  // 輪（断面）の列から面を作る。rows[k][j] = { p, b: [骨A, 骨B, 骨Bの重み], uv }
  //  closed: 輪が閉じている, twoSided: 裏表の両方を作る（スカート・長い髪）
  Geo.prototype.grid = function (rows, region, closed, twoSided, outFn) {
    const NR = rows.length, NS = rows[0].length;
    const cen = rows.map(function (r) { let c = [0, 0, 0]; r.forEach(function (q) { c = V.add(c, q.p); }); return V.mul(c, 1 / r.length); });
    const sides = twoSided ? [1, -1] : [1];
    const self = this;
    sides.forEach(function (sg) {
      const base = self.P.length / 3, nrm = [];
      for (let k = 0; k < NR; k++) for (let j = 0; j < NS; j++) {
        const r = rows[k], q = r[j];
        const jp = closed ? (j + 1) % NS : Math.min(NS - 1, j + 1), jm = closed ? (j - 1 + NS) % NS : Math.max(0, j - 1);
        const kp = Math.min(NR - 1, k + 1), km = Math.max(0, k - 1);
        let n = V.cross(V.sub(r[jp].p, r[jm].p), V.sub(rows[kp][j].p, rows[km][j].p));
        const ref = outFn ? outFn(q.p, k, j) : V.sub(q.p, cen[k]);
        if (V.len(n) < 1e-10) n = k === 0 ? V.sub(cen[0], cen[1]) : V.sub(cen[NR - 1], cen[NR - 2]);
        n = V.norm(n);
        if (V.dot(n, ref) < 0) n = V.mul(n, -1);
        n = V.mul(n, sg);
        nrm.push(n);
        self.P.push(q.p[0], q.p[1], q.p[2]); self.N.push(n[0], n[1], n[2]);
        self.B.push(q.b[0], q.b[1], q.b[2], region); self.UV.push(q.uv[0], q.uv[1]);
      }
      // 三角形の向きを、その点の法線にそろえる（表だけ描く）
      const J2 = closed ? NS : NS - 1;
      for (let k = 0; k < NR - 1; k++) for (let j = 0; j < J2; j++) {
        const a = k * NS + j, b = k * NS + (j + 1) % NS, c = (k + 1) * NS + j, d = (k + 1) * NS + (j + 1) % NS;
        const pa = rows[k][j].p, pb = rows[k][(j + 1) % NS].p, pc = rows[k + 1][j].p, pd = rows[k + 1][(j + 1) % NS].p;
        let g = V.cross(V.sub(pc, pa), V.sub(pb, pa));
        if (V.len(g) < 1e-12) g = V.cross(V.sub(pc, pb), V.sub(pd, pb));
        const nn = V.add(V.add(nrm[a], nrm[b]), V.add(nrm[c], nrm[d]));
        if (V.dot(g, nn) >= 0) self.I.push(base + a, base + c, base + b, base + b, base + c, base + d);
        else self.I.push(base + a, base + b, base + c, base + b, base + d, base + c);
      }
    });
  };
  Geo.prototype.build = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('bone', new THREE.Float32BufferAttribute(this.B, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setIndex(this.I);
    return g;
  };

  // 折れ線 pts に沿った筒。sec: [[t, 横の半径, 前後の半径, 前後のずれ], ...]（t は全長に対する位置。負や 1 超えは延長）
  //  opt: { n 周の分割, step 長さ方向の間隔[m], e 断面の角ばり（1 で楕円）, ref 前の向き, bone(t, p), uvx(t, p), region }
  function tube(G, pts, sec, opt) {
    const segL = [], N = opt.n || 14;
    let L = 0;
    for (let k = 1; k < pts.length; k++) { const l = V.len(V.sub(pts[k], pts[k - 1])); segL.push(l); L += l; }
    const at = function (s) {
      if (s <= 0) return V.add(pts[0], V.mul(V.norm(V.sub(pts[1], pts[0])), s));
      for (let k = 0; k < segL.length; k++) {
        if (s <= segL[k] || k === segL.length - 1) return V.add(pts[k], V.mul(V.norm(V.sub(pts[k + 1], pts[k])), s));
        s -= segL[k];
      }
    };
    const t0 = sec[0][0], t1 = sec[sec.length - 1][0], cnt = Math.max(4, Math.ceil((t1 - t0) * L / (opt.step || 0.02)));
    const ref = opt.ref || [0, 0, 1], e = opt.e || 1, rows = [];
    for (let k = 0; k <= cnt; k++) {
      const t = t0 + (t1 - t0) * k / cnt, s = t * L, C = at(s);
      const dir = V.norm(V.sub(at(s + 0.025), at(s - 0.025)));
      const Zf = V.norm(V.sub(ref, V.mul(dir, V.dot(ref, dir)))), X = V.cross(dir, Zf);
      const r = crInterp(sec, t), row = [];
      for (let j = 0; j < N; j++) {
        const a = j / N * TAU, ce = spow(Math.cos(a), e), se = spow(Math.sin(a), e);
        const p = V.add(C, V.add(V.mul(X, r[0] * ce), V.mul(Zf, r[2] + r[1] * se)));
        row.push({ p: p, b: opt.bone(t, p), uv: [opt.uvx ? opt.uvx(t, p) : t, 0] });
      }
      rows.push(row);
    }
    G.grid(rows, opt.region, true, false);
  }
  // 球（目玉）。前 (+z) が極
  function ball(G, c, r, region, bone, NS, NR) {
    const rows = [];
    for (let k = 0; k <= NR; k++) {
      const ph = k / NR * Math.PI, row = [];
      for (let j = 0; j < NS; j++) {
        const th = j / NS * TAU;
        row.push({ p: [c[0] + r * Math.sin(ph) * Math.cos(th), c[1] + r * Math.sin(ph) * Math.sin(th), c[2] + r * Math.cos(ph)], b: bone, uv: [0, 0] });
      }
      rows.push(row);
    }
    G.grid(rows, region, true, false);
  }
  // 骨の重み: 骨 a から骨 b へ、x が lo → hi の間でなめらかに移る
  const blend = function (a, b, x, lo, hi) { return [a, b, sm((x - lo) / (hi - lo))]; };

  // ---- 胴（腰から首まで） [y, 横の半分, 前, 後, 前後の中心] ----
  const TORSO_M = [
    [0.785, 0.020, 0.020, 0.020, 0.0], [0.80, 0.100, 0.070, 0.080, 0.0], [0.84, 0.150, 0.095, 0.105, -0.005], [0.90, 0.166, 0.100, 0.115, -0.008],
    [0.96, 0.166, 0.098, 0.110, -0.005], [1.02, 0.153, 0.095, 0.100, 0.0], [1.08, 0.147, 0.098, 0.095, 0.005], [1.16, 0.155, 0.105, 0.095, 0.008],
    [1.24, 0.167, 0.112, 0.100, 0.006], [1.31, 0.176, 0.112, 0.105, 0.0], [1.37, 0.188, 0.100, 0.105, -0.008], [1.415, 0.176, 0.085, 0.090, -0.012],
    [1.445, 0.128, 0.070, 0.075, -0.014], [1.465, 0.075, 0.058, 0.060, -0.014], [1.48, 0.054, 0.051, 0.053, -0.014], [1.51, 0.051, 0.049, 0.051, -0.012],
    [1.54, 0.049, 0.047, 0.050, -0.008], [1.57, 0.047, 0.045, 0.048, -0.004]];
  const TORSO_F = [
    [0.785, 0.020, 0.020, 0.020, 0.0], [0.80, 0.105, 0.070, 0.085, 0.0], [0.84, 0.160, 0.095, 0.115, -0.008], [0.90, 0.176, 0.100, 0.122, -0.010],
    [0.96, 0.170, 0.095, 0.112, -0.006], [1.02, 0.146, 0.088, 0.095, 0.0], [1.08, 0.130, 0.088, 0.088, 0.004], [1.16, 0.138, 0.095, 0.088, 0.006],
    [1.24, 0.150, 0.098, 0.092, 0.004], [1.31, 0.158, 0.096, 0.098, 0.0], [1.37, 0.168, 0.090, 0.098, -0.008], [1.415, 0.158, 0.078, 0.084, -0.012],
    [1.445, 0.114, 0.064, 0.068, -0.014], [1.465, 0.066, 0.052, 0.055, -0.014], [1.48, 0.047, 0.045, 0.047, -0.014], [1.51, 0.045, 0.043, 0.045, -0.012],
    [1.54, 0.043, 0.042, 0.044, -0.008], [1.57, 0.042, 0.040, 0.043, -0.004]];
  // ---- 頭 [y, 横の半分, 前, 後, 前後の中心] ----
  const HEAD_T = [
    [1.523, 0.006, 0.006, 0.006, 0.068], [1.530, 0.024, 0.018, 0.028, 0.066], [1.540, 0.034, 0.030, 0.045, 0.058], [1.555, 0.045, 0.042, 0.060, 0.044],
    [1.575, 0.056, 0.056, 0.078, 0.030], [1.598, 0.0655, 0.072, 0.092, 0.020], [1.620, 0.073, 0.082, 0.099, 0.015], [1.640, 0.0755, 0.086, 0.103, 0.012],
    [1.662, 0.0770, 0.087, 0.106, 0.008], [1.690, 0.0745, 0.081, 0.103, 0.002], [1.715, 0.0650, 0.067, 0.090, -0.004], [1.738, 0.0450, 0.043, 0.063, -0.008],
    [1.752, 0.0170, 0.016, 0.024, -0.010], [1.7575, 0.001, 0.001, 0.001, -0.010]];
  const HEAD_E = 0.88;
  // 頭の表面の点。a: 周の角度（π/2 が正面）。face: 鼻や目のくぼみを付ける
  function headPt(y, a, face, fem) {
    const s = crInterp(HEAD_T, y);
    let hw = s[0], df = s[1], db = s[2];
    if (fem) { const j = sm((1.59 - y) / 0.06); hw *= 1 - 0.06 * j; df *= 0.98; db *= 0.98; }
    const c = Math.cos(a), sn = Math.sin(a);
    const he = HEAD_E + (1 - HEAD_E) * sm((1.62 - y) / 0.06);       // あごの方は丸く
    let x = hw * spow(c, he), z = s[3] + (sn > 0 ? df : db) * spow(sn, he);
    if (face && sn > 0) {
      const fk = sm((z - 0.035) / 0.04), ax = Math.abs(x);
      // 鼻: 先は y=1.592、付け根は y=1.648。小鼻は横に広がる
      let pr = 0;
      if (y < 1.592) pr = 0.020 * sm((y - 1.578) / 0.014);
      else if (y < 1.652) pr = 0.020 + (0.004 - 0.020) * ((y - 1.592) / 0.060);
      const nw = 0.0085 + 0.007 * sm((1.604 - y) / 0.02);
      z += pr * Math.exp(-Math.pow(x / nw, 2)) * fk;
      // 目のくぼみ、まゆの骨、ほお骨、唇、あご
      z -= 0.0105 * Math.exp(-Math.pow((ax - EYE_X) / 0.017, 2) - Math.pow((y - EYE_Y) / 0.013, 2)) * fk;
      z += 0.004 * Math.exp(-Math.pow((ax - 0.030) / 0.025, 2) - Math.pow((y - 1.657) / 0.006, 2)) * fk;
      z += 0.004 * Math.exp(-Math.pow((ax - 0.050) / 0.018, 2) - Math.pow((y - 1.614) / 0.014, 2)) * fk;
      z += 0.0042 * Math.exp(-Math.pow(x / 0.021, 2) - Math.pow((y - 1.5665) / 0.0055, 2)) * fk;
      z -= 0.0022 * Math.exp(-Math.pow(x / 0.02, 2) - Math.pow((y - 1.554) / 0.004, 2)) * fk;
      z += 0.0045 * Math.exp(-Math.pow(x / 0.02, 2) - Math.pow((y - 1.539) / 0.009, 2)) * fk;
    }
    return [x, y, z];
  }
  // 周の角度: 正面の近くを細かく分ける（鼻・目・口のため）
  const headAng = function (u) { const t = 2 * u - 1; return Math.PI / 2 + Math.PI * t * (0.45 + 0.55 * Math.abs(t)); };
  // 生え際の高さ（正面からの角度 φ ごと）
  const HAIRLINE = [[0, 1.700], [0.45, 1.694], [0.75, 1.682], [1.05, 1.662], [1.25, 1.628], [1.40, 1.632], [1.57, 1.672], [1.85, 1.665], [2.2, 1.610], [2.6, 1.585], [3.1416, 1.572]];

  function humanGeo(fem) {
    const G = new Geo();
    // ---- 胴: 腰〜首。上は頭の中まで ----
    const TT = fem ? TORSO_F : TORSO_M, rows = [], NS = 32;
    for (let y = 0.785; y <= 1.5701; y += 0.0157) {
      const s = crInterp(TT, Math.min(1.57, y)), row = [];
      for (let j = 0; j < NS; j++) {
        const a = j / NS * TAU, c = Math.cos(a), sn = Math.sin(a), e = y > 1.45 ? 1 : 0.82;
        let x = s[0] * spow(c, e), z = s[3] + (sn > 0 ? s[1] : s[2]) * spow(sn, e);
        const ax = Math.abs(x);
        if (sn > 0) {
          if (fem) z += 0.034 * Math.exp(-Math.pow((ax - 0.064) / 0.044, 2) - Math.pow((y - 1.262) / 0.048, 2)) * sn;     // 胸
          else z += 0.008 * Math.exp(-Math.pow((ax - 0.07) / 0.05, 2) - Math.pow((y - 1.30) / 0.05, 2)) * sn;
        } else {
          z -= (fem ? 0.026 : 0.018) * Math.exp(-Math.pow((ax - 0.065) / 0.06, 2) - Math.pow((y - 0.905) / 0.06, 2)) * -sn;   // お尻
          z -= 0.008 * Math.exp(-Math.pow((ax - 0.08) / 0.05, 2) - Math.pow((y - 1.32) / 0.06, 2)) * -sn;                   // 肩甲骨
        }
        const b = y < 1.45 ? blend(PELVIS, CHEST, y, 0.98, 1.12) : blend(CHEST, HEAD, y, 1.475, 1.545);
        row.push({ p: [x, y, z], b: b, uv: [0, 0] });
      }
      rows.push(row);
    }
    G.grid(rows, RG.TORSO, true, false);

    // ---- 脚: 腰の中から足首まで（膝で2本の骨に分かれる） ----
    const lk = fem ? 0.95 : 1;
    for (let e = 0; e < 2; e++) {
      const sd = e ? 1 : -1, X = function (p) { return [p[0] * sd, p[1], p[2]]; };
      const pts = [X([0.088, 0.99, 0.0]), X(J.knee), X([0.100, 0.06, -0.012])];
      const L1 = V.len(V.sub(pts[1], pts[0])), L = L1 + V.len(V.sub(pts[2], pts[1])), tk = L1 / L;
      tube(G, pts, [[0.0, 0.070, 0.078, 0.0], [0.08, 0.084 * lk, 0.090, 0.0], [0.25, 0.077 * lk, 0.082, 0.004], [0.40, 0.063 * lk, 0.067, 0.006],
                    [tk - 0.04, 0.053, 0.056, 0.008], [tk, 0.050, 0.054, 0.010], [tk + 0.05, 0.046, 0.049, 0.002], [tk + 0.15, 0.050 * lk, 0.055 * lk, -0.013],
                    [tk + 0.26, 0.042 * lk, 0.045, -0.008], [0.88, 0.031, 0.035, -0.002], [0.96, 0.027, 0.032, 0.0], [1.0, 0.026, 0.031, 0.0]],
        { n: 14, step: 0.03, region: RG.LEG, e: 0.95,
          bone: function (t) { return blend(THIGH[e], SHIN[e], t, tk - 0.05, tk + 0.04); },
          uvx: function (t) { return t; } });
      // 靴: かかとからつま先まで、横に切った断面をつなぐ [z, 横の半分, 上, 下]
      const SHOE = [[-0.084, 0.012, 0.055, 0.012], [-0.077, 0.034, 0.088, 0.002], [-0.052, 0.043, 0.104, 0.0], [-0.012, 0.046, 0.112, 0.0], [0.030, 0.048, 0.092, 0.0],
                    [0.080, 0.050, 0.070, 0.0], [0.130, 0.049, 0.057, 0.0], [0.168, 0.044, 0.049, 0.002], [0.198, 0.032, 0.041, 0.006], [0.214, 0.012, 0.031, 0.013]];
      const srows = [];
      for (let k = 0; k <= 18; k++) {
        const z = -0.084 + (0.214 + 0.084) * k / 18, s = crInterp(SHOE, z), row = [];
        for (let j = 0; j < 12; j++) {
          const a = j / 12 * TAU, cy = (s[1] + s[2]) / 2, hy = (s[1] - s[2]) / 2;
          const p = [sd * (0.103 + 0.004 * z / 0.2) + s[0] * spow(Math.cos(a), 0.55), cy + hy * spow(Math.sin(a), 0.55), z];
          row.push({ p: p, b: p[1] > 0.10 ? blend(FOOT[e], SHIN[e], p[1], 0.10, 0.115) : [FOOT[e], FOOT[e], 0], uv: [0, 0] });
        }
        srows.push(row);
      }
      G.grid(srows, RG.SHOE, true, false);
    }

    // ---- 腕: 肩の上（丸く閉じる）から手首まで。肘で2本の骨に分かれる ----
    const ak = fem ? 0.88 : 1, ax0 = fem ? -0.012 : 0;
    for (let e = 0; e < 2; e++) {
      const sd = e ? 1 : -1, X = function (p) { return [(p[0] + ax0) * sd, p[1], p[2]]; };
      const pts = [X([0.172, 1.398, -0.012]), X(J.elbow), X(J.wrist)];
      const L1 = V.len(V.sub(pts[1], pts[0])), L = L1 + V.len(V.sub(pts[2], pts[1])), te = L1 / L;
      tube(G, pts, [[-0.046, 0.004, 0.004, 0.0], [-0.030, 0.029 * ak, 0.032 * ak, 0.0], [0.0, 0.044 * ak, 0.048 * ak, 0.0], [0.07, 0.050 * ak, 0.053 * ak, 0.002],
                    [0.16, 0.048 * ak, 0.050 * ak, 0.0], [0.32, 0.043 * ak, 0.045 * ak, -0.002], [te - 0.06, 0.037 * ak, 0.039 * ak, 0.0], [te, 0.035 * ak, 0.037 * ak, -0.004],
                    [te + 0.10, 0.038 * ak, 0.042 * ak, 0.004], [0.86, 0.029 * ak, 0.033 * ak, 0.002], [0.97, 0.022 * ak, 0.029 * ak, 0.0], [1.0, 0.021 * ak, 0.028 * ak, 0.0]],
        { n: 12, step: 0.026, region: RG.ARM,
          bone: function (t) { return t < 0.2 ? blend(CHEST, UARM[e], t, -0.04, 0.03) : blend(UARM[e], FARM[e], t, te - 0.05, te + 0.04); },
          uvx: function (t) { return Math.max(0, t); } });
      // 手: 指を軽く曲げ、手のひらは内側（太もも）を向く。親指は前
      const w = J.wrist, hp = [X(w), X([w[0] + 0.004, 0.762, 0.004]), X([w[0] - 0.008, 0.690, 0.030])];
      tube(G, hp, [[-0.04, 0.017 * ak, 0.026 * ak, 0.0], [0.0, 0.019 * ak, 0.030 * ak, 0.0], [0.18, 0.019 * ak, 0.040 * ak, 0.002], [0.50, 0.018 * ak, 0.044 * ak, 0.0],
                   [0.66, 0.015 * ak, 0.041 * ak, 0.0], [0.86, 0.011 * ak, 0.033 * ak, 0.0], [1.0, 0.004, 0.012, 0.0]],
        { n: 10, step: 0.018, region: RG.HAND,
          bone: function () { return [FARM[e], FARM[e], 0]; } });
      tube(G, [X([w[0] - 0.006, 0.835, 0.026]), X([w[0] - 0.014, 0.770, 0.046])], [[-0.1, 0.004, 0.004, 0], [0.05, 0.010 * ak, 0.011 * ak, 0], [0.8, 0.008 * ak, 0.009 * ak, 0], [1.08, 0.002, 0.002, 0]],
        { n: 8, step: 0.012, region: RG.HAND, bone: function () { return [FARM[e], FARM[e], 0]; } });
    }

    // ---- 頭: 断面をつなぎ、正面に鼻・目のくぼみ・唇・あごを付ける ----
    const hrows = [], HN = 38;
    for (let y = 1.523; y <= 1.7576; y += 0.0062) {
      const row = [];
      for (let j = 0; j < HN; j++) row.push({ p: headPt(Math.min(y, 1.7575), headAng(j / HN), true, fem), b: [HEAD, HEAD, 0], uv: [0, 0] });
      hrows.push(row);
    }
    G.grid(hrows, RG.HEAD, true, false);
    // 耳
    for (let e = 0; e < 2; e++) {
      const sd = e ? 1 : -1;
      tube(G, [[sd * 0.0785, 1.656, -0.012], [sd * 0.0805, 1.596, -0.002]], [[-0.12, 0.002, 0.004, 0], [0.0, 0.006, 0.014, -0.002], [0.35, 0.007, 0.017, 0.0], [0.8, 0.006, 0.013, 0.001], [1.1, 0.002, 0.003, 0]],
        { n: 10, step: 0.008, region: RG.HEAD, ref: [0, 0, 1], bone: function () { return [HEAD, HEAD, 0]; } });
    }
    // 目玉（まぶたはシェーダーで描く）
    const zE = headPt(EYE_Y, Math.acos(Math.min(1, Math.pow(EYE_X / 0.0768, 1 / HEAD_E))), true, fem)[2] - EYE_R * 0.42;
    for (let e = 0; e < 2; e++) ball(G, [(e ? 1 : -1) * EYE_X, EYE_Y, zE], EYE_R, RG.EYE, [HEAD, HEAD, 0], 12, 8);

    // ---- 髪: 生え際から頭頂までを覆う殻（厚みは人ごとに頂点シェーダーで足す） ----
    const crow = [], HK = 11;
    for (let k = 0; k <= HK; k++) {
      const kk = k / HK, row = [];
      for (let j = 0; j < HN; j++) {
        const a = headAng(j / HN);
        let ph = Math.abs(((a - Math.PI / 2) % TAU + TAU + Math.PI) % TAU - Math.PI);
        const yh = crInterp(HAIRLINE, ph)[0], y = yh + (1.7575 - yh) * (1 - Math.pow(1 - kk, 1.6));
        const p = headPt(Math.min(y, 1.7575), a, false, fem), cH = [0, 1.635, -0.01];
        const th = 0.0008 + 0.0135 * sm(kk / 0.30) + 0.004 * sm((ph - 1.6) / 1.2);
        row.push({ p: V.add(p, V.mul(V.norm(V.sub(p, cH)), th)), b: [HEAD, HEAD, 0], uv: [ph, kk] });
      }
      crow.push(row);
    }
    G.grid(crow, RG.HAIR, true, false, function (p) { return V.sub(p, [0, 1.635, -0.01]); });

    // ---- 長い髪: 後頭部から背中へ垂れる（裏表あり） ----
    const lrows = [], LN = 18, LK = 12;
    for (let j = 0; j <= LN; j++) {
      const ph = -1.75 + 3.5 * j / LN, a = 1.5 * Math.PI + ph, row = [];
      const yEnd = 1.30 + 0.20 * Math.pow(Math.abs(ph) / 1.75, 2);
      for (let k = 0; k <= LK; k++) {
        const kk = k / LK, y = 1.705 + (yEnd - 1.705) * kk, yc = Math.max(y, 1.585);
        let p = headPt(Math.min(yc, 1.7575), a, false, fem);
        const cH = [0, 1.635, -0.01], rad = V.norm([p[0], 0, p[2] - cH[2]]);
        p = V.add(p, V.mul(rad, 0.020 + 0.006 * kk));
        if (y < 1.585) {
          const d = 1.585 - y;
          p = [p[0] * (1 + d * 0.9), y, p[2] - d * 0.32];
        }
        p[2] += 0.004 * Math.sin(ph * 9 + kk * 5) * kk;
        row.push({ p: p, b: blend(HEAD, CHEST, -y, -1.60, -1.50), uv: [ph, kk] });
      }
      lrows.push(row);
    }
    // 行と列を入れかえて（輪 = 高さごと）面にする
    const lr2 = [];
    for (let k = 0; k <= LK; k++) { const row = []; for (let j = 0; j <= LN; j++) row.push(lrows[j][k]); lr2.push(row); }
    G.grid(lr2, RG.LONG, false, true, function (p) { return [p[0], 0, p[2] + 0.02]; });

    // ---- スカート（はく人だけ見せる）。すそは太ももに少し引かれる ----
    const krows = [];
    for (let k = 0; k <= 8; k++) {
      const kk = k / 8, y = 1.065 - 0.50 * kk, row = [];
      const hw = 0.150 + 0.100 * kk, df = 0.100 + 0.105 * kk, db = 0.118 + 0.090 * kk;
      for (let j = 0; j < 36; j++) {
        const a = j / 36 * TAU, pl = 1 + 0.035 * Math.sin(a * 9) * kk;
        const x = hw * Math.cos(a) * pl, z = -0.006 + (Math.sin(a) > 0 ? df : db) * Math.sin(a) * pl;
        row.push({ p: [x, y, z], b: [PELVIS, x < 0 ? THIGH[0] : THIGH[1], 0.72 * sm(kk * 1.2) * Math.min(1, Math.abs(x) / 0.05)], uv: [0, kk] });
      }
      krows.push(row);
    }
    G.grid(krows, RG.SKIRT, true, true);

    // ---- リュック（背負う人だけ見せる） ----
    const brows = [], BT = [[1.08, 0], [1.09, 0.85], [1.11, 1], [1.40, 1], [1.425, 0.88], [1.435, 0]];
    for (let k = 0; k < BT.length; k++) {
      const y = BT[k][0], sc = BT[k][1], row = [];
      for (let j = 0; j < 20; j++) {
        const a = j / 20 * TAU;
        row.push({ p: [0.125 * sc * spow(Math.cos(a), 0.35), y, -0.182 + 0.058 * sc * spow(Math.sin(a), 0.35) + (y - 1.25) * 0.08], b: [CHEST, CHEST, 0], uv: [0, 0] });
      }
      brows.push(row);
    }
    G.grid(brows, RG.BAG, true, false);
    return { geo: G.build(), eyeZ: zE };
  }

  // ---- 骨の動き（描く材料と影の材料で共通） ----
  const SKIN_GLSL = `
    attribute vec4 bone;              // x: 骨A, y: 骨B, z: 骨Bの重み, w: 部位
    attribute vec4 pA, pB, pC;        // 脚の角度(左,右), 膝(左,右) / 腕(左,右), 肘(左,右) / 上下, 左右, 前傾, ひねり
    attribute vec4 cA, cB, cC;        // 色（肌・髪・上着・下）/ 靴の色, 印, 髪の量, 乱数 / 頭の大きさ, 鞄の色, ネクタイの色, 瞳の色
    const vec3 J_HIP = vec3(0.090, 0.93, 0.0), J_KNEE = vec3(0.095, 0.51, 0.012), J_ANK = vec3(0.100, 0.085, -0.012);
    const vec3 J_WAIST = vec3(0.0, 1.04, 0.0), J_NECK = vec3(0.0, 1.51, -0.012);
    const vec3 J_SH = vec3(0.180, 1.415, -0.012), J_ELB = vec3(0.205, 1.12, -0.03);
    float bitF(float f, float D) { return mod(floor(f / D + 0.001), 2.0); }
    vec3 swingX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c + v.z * s, -v.y * s + v.z * c); }
    vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
    vec3 sideJ(vec3 j, float sd) { return vec3(j.x * sd, j.y, j.z); }
    vec3 chestX(vec3 v, float d) { v = swingX(v - J_WAIST * d, pC.z) + J_WAIST * d; return rotY(v, pC.w); }
    // 骨 b に付いた点（d=1）か向き（d=0）を動かす
    vec3 boneX(float b, vec3 p, float d) {
      if (b < 0.5) return rotY(p, -pC.w * 0.5);
      if (b < 1.5) return chestX(p, d);
      if (b < 2.5) return rotY(chestX(p, d), -pC.w * 0.6);
      if (b < 8.5) {
        float sd = b < 5.5 ? -1.0 : 1.0, k = b < 5.5 ? b - 3.0 : b - 6.0;
        float a = sd < 0.0 ? pA.x : pA.y, kn = sd < 0.0 ? pA.z : pA.w;
        vec3 H = sideJ(J_HIP, sd) * d, K = sideJ(J_KNEE, sd) * d, A = sideJ(J_ANK, sd) * d, v = p;
        if (k > 1.5) v = swingX(v - A, kn - a) + A;          // 足の裏は地面と平らに保つ
        if (k > 0.5) v = swingX(v - K, -kn) + K;
        v = swingX(v - H, a) + H;
        return rotY(v, -pC.w * 0.5);
      }
      float sd = b < 10.5 ? -1.0 : 1.0, fore = (b > 9.5 && b < 10.5) || b > 11.5 ? 1.0 : 0.0;
      float a = sd < 0.0 ? pB.x : pB.y, el = sd < 0.0 ? pB.z : pB.w;
      vec3 S = sideJ(J_SH, sd) * d, E = sideJ(J_ELB, sd) * d, v = p;
      if (fore > 0.5) v = swingX(v - E, el) + E;
      v = swingX(v - S, a) + S;
      return chestX(v, d);
    }
    // 部位が見えるか（スカート・長い髪・リュックは人による）
    float partOn(float reg, float fl) {
      if (abs(reg - 7.0) < 0.5) return bitF(fl, 16.0);
      if (abs(reg - 8.0) < 0.5) return bitF(fl, 8.0);
      if (abs(reg - 9.0) < 0.5) return bitF(fl, 32.0);
      return 1.0;
    }
    // 頭の大きさ（子どもは大きめ）と髪の量を付けた、動かす前の位置
    vec3 restPos(vec3 p, vec3 n, float reg) {
      if (abs(reg - 6.0) < 0.5) p += n * cB.z * smoothstep(0.0, 0.6, uv.y);
      if (abs(reg - 7.0) < 0.5) p += vec3(p.x, 0.0, p.z + 0.01) * cB.z * 2.0;
      float hk = (abs(bone.x - 2.0) < 0.5 ? 1.0 - bone.z : 0.0) + (abs(bone.y - 2.0) < 0.5 ? bone.z : 0.0);
      return J_NECK + (p - J_NECK) * mix(1.0, cC.x, hk);
    }
    vec3 skinPos(vec3 p) {
      return mix(boneX(bone.x, p, 1.0), boneX(bone.y, p, 1.0), bone.z) + vec3(pC.y, pC.x, 0.0);
    }`;

  const humanVS = COL.GL.VS_HEAD + SKIN_GLSL + `
    varying vec3 vWorld, vN, vObj, vColA, vColB, vColC;
    varying vec4 vInfo;
    vec3 unpackC(float f) { float r = floor(f / 65536.0), g = floor((f - r * 65536.0) / 256.0); return vec3(r, g, f - r * 65536.0 - g * 256.0) / 255.0; }
    void main() {
      float reg = bone.w, fl = cB.y;
      vec3 p = restPos(position, normal, reg);
      if (partOn(reg, fl) < 0.5) p = vec3(0.0);
      vec3 q = skinPos(p);
      vec3 n = normalize(mix(boneX(bone.x, normal, 0.0), boneX(bone.y, normal, 0.0), bone.z));
      mat4 m = modelMatrix * instanceMatrix;
      vec4 wp = m * vec4(q, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(m) * n);
      vObj = position;
      vec3 skin = unpackC(cA.x), hair = unpackC(cA.y), top = unpackC(cA.z), bot = unpackC(cA.w), shoe = unpackC(cB.x);
      float sleeve = mod(fl, 4.0), cut = 1.0;
      vec3 A = skin, B = skin;
      if (reg < 0.5) {
        // 胴: 上着と、腰から下（ズボン・スカート）。裾を出している人は上着が長い
        A = top; B = bot; cut = position.y - (bitF(fl, 256.0) > 0.5 || bitF(fl, 64.0) > 0.5 ? 0.925 : 1.0);
      } else if (reg < 1.5) {
        // 腕: 袖（0 半袖, 1 長袖, 2 袖なし, 3 七分）
        float sl = sleeve < 0.5 ? 0.30 : sleeve < 1.5 ? 1.02 : sleeve < 2.5 ? -0.05 : 0.68;
        A = top; B = skin; cut = sl - uv.x;
      } else if (reg < 2.5) {
        A = skin; B = skin;                                   // 手
      } else if (reg < 3.5) {
        // 脚: ズボンの丈（半ズボン・七分・長ズボン）。スカートの人は素足
        float pl = bitF(fl, 8.0) > 0.5 ? -1.0 : bitF(fl, 4.0) > 0.5 ? 0.40 : bitF(fl, 1024.0) > 0.5 ? 0.78 : 1.1;
        A = bot; B = skin; cut = pl - uv.x;
      } else if (reg < 4.5) {
        // 靴: 白っぽい靴は底も白、ほかは黒い底
        A = shoe; B = dot(shoe, vec3(0.33)) > 0.6 ? shoe * 0.92 : vec3(0.10, 0.09, 0.085); cut = position.y - 0.021;
      } else if (reg < 5.5) {
        A = skin; B = hair;                                   // 頭（まゆは髪の色）
      } else if (reg < 7.5) {
        A = hair; B = hair; cut = uv.y;                      // 髪: 生え際（毛先）からの位置
      } else if (reg < 8.5) {
        A = bot; B = bot;                                     // スカート
      } else if (reg < 9.5) {
        A = unpackC(cC.y); B = A;                             // リュック
      } else {
        A = unpackC(cC.w); B = skin;                          // 目（瞳の色）
      }
      vColA = A; vColB = B; vColC = skin;
      vInfo = vec4(reg, cut, cB.w, fl);
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + COL.GL.VS_TAIL + `
    }`;

  const humanFS = COL.GL.FS_HEAD + COL.GL.COMMON + COL.GL.NOISE2 + COL.GL.SHADOW + `
    uniform vec3 eyeC;
    varying vec3 vWorld, vN, vObj, vColA, vColB, vColC;
    varying vec4 vInfo;
    float bitF(float f, float D) { return mod(floor(f / D + 0.001), 2.0); }
    float band(float x, float c, float hw, float aa) { return 1.0 - smoothstep(hw - aa, hw + aa, abs(x - c)); }
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vWorld), up = normalize(vec3(-vWorld.xy, 1e-3)), ld = sunDirAt(vWorld);
      int reg = int(vInfo.x + 0.5);
      float fl = vInfo.w, seed = vInfo.z;
      vec3 o = vObj;
      float ax = abs(o.x), aa = fwidth(o.y) + 1e-5;
      float ac = fwidth(vInfo.y) + 1e-4;
      float isA = smoothstep(-ac, ac, vInfo.y);
      vec3 col = mix(vColB, vColA, isA);
      vec3 skin = vColC;
      float skinK = 0.0, hairK = 0.0, gloss = 0.0, fabric = 1.0, ao = 1.0, eyeK = 0.0;
      if (reg == 0) {
        // ---- 胴 ----
        // 首まわり: 丸首。Vネックの人は胸元が開く
        float neckY = 1.474 - 0.020 * smoothstep(0.0, 0.05, o.z);
        float bare = smoothstep(neckY - aa, neckY + aa, o.y);
        if (bitF(fl, 128.0) > 0.5) bare = max(bare, step(0.0, o.z) * smoothstep(-aa, aa, (o.y - 1.345) * 0.42 - ax) * step(o.y, 1.47));
        if (abs(mod(fl, 4.0) - 2.0) < 0.5) bare = max(bare, smoothstep(0.128, 0.142, ax) * smoothstep(1.32, 1.34, o.y));   // 袖なし
        // 上着を羽織る人: 前が開いて中のシャツとネクタイが見える
        if (bitF(fl, 64.0) > 0.5 && o.z > 0.0 && o.y > 0.93) {
          float open = 0.012 + max(0.0, o.y - 1.20) * 0.42;
          float inner = smoothstep(open + aa, open - aa, ax);
          vec3 shirt = vec3(0.90, 0.91, 0.92) * (0.96 + 0.04 * seed);
          float tie = band(o.x, 0.0, 0.009 + 0.006 * smoothstep(1.40, 1.12, o.y), aa) * step(1.06, o.y) * step(o.y, 1.445) * bitF(fl, 2048.0);
          vec3 tieC = fract(seed * 7.0) < 0.4 ? vec3(0.42, 0.06, 0.09) : fract(seed * 7.0) < 0.75 ? vec3(0.08, 0.12, 0.30) : vec3(0.30, 0.30, 0.33);
          tieC *= 1.0 - 0.25 * step(0.5, fract((o.y - o.x) * 40.0)) * step(0.6, fract(seed * 11.0));
          col = mix(col, mix(shirt, tieC, tie), inner);
          col *= 1.0 - 0.35 * band(ax, open, 0.003, aa) * step(1.0, o.y);
          // ボタン
          col = mix(col, col * 0.4, step(o.y, 1.20) * band(ax, open + 0.012, 0.004, aa) * band(fract(o.y / 0.07), 0.5, 0.06, 0.04));
        } else if (bitF(fl, 256.0) < 0.5 && bitF(fl, 512.0) > 0.5) {
          // ベルト（裾を入れている人）
          float belt = smoothstep(0.996 - aa, 0.996 + aa, o.y) * smoothstep(1.028 + aa, 1.028 - aa, o.y);
          col = mix(col, vec3(0.13, 0.09, 0.07), belt);
          col = mix(col, vec3(0.72, 0.68, 0.55), belt * band(o.x, 0.0, 0.016, aa) * step(0.0, o.z));
        }
        // 縫い目（肩・脇）と、ズボンの前あき
        col *= 1.0 - 0.12 * band(o.z, -0.012, 0.0025, aa) * step(1.0, o.y) * smoothstep(0.10, 0.16, ax);
        // リュックの肩ひも
        if (bitF(fl, 32.0) > 0.5) {
          float strap = band(ax, 0.092 - 0.02 * smoothstep(1.43, 1.15, o.y) * step(0.0, o.z), 0.013, aa) * step(1.10, o.y) * step(o.y, 1.47);
          col = mix(col, vec3(0.10, 0.10, 0.11), strap);
        }
        skinK = bare;
        col = mix(col, skin, bare);
        // 脇の下・首の下・股は暗く
        ao *= 1.0 - 0.25 * smoothstep(0.075, 0.03, ax) * smoothstep(0.88, 0.80, o.y);
        ao *= 1.0 - 0.28 * smoothstep(0.12, 0.17, ax) * step(o.y, 1.38) * step(1.0, o.y);
        ao *= 1.0 - 0.30 * smoothstep(1.50, 1.545, o.y) * smoothstep(0.0, 0.03, o.z);
      } else if (reg == 1) {
        // ---- 腕: 袖口の折り返し ----
        col *= 1.0 - 0.22 * band(vInfo.y, 0.0, 0.006, ac * 2.0) * isA;
        skinK = 1.0 - isA;
      } else if (reg == 2) {
        // ---- 手: 指の間の線 ----
        float fz = (o.z + 0.012) / 0.0135;
        col *= 1.0 - 0.30 * step(o.y, 0.758) * band(fract(fz), 0.0, 0.08, fwidth(fz) + 0.02) * step(-0.01, o.z) * step(o.z, 0.035);
        skinK = 1.0;
      } else if (reg == 3) {
        // ---- 脚: すその折り目。素足の人は短い靴下 ----
        col *= 1.0 - 0.20 * band(vInfo.y, 0.0, 0.006, ac * 2.0) * isA;
        float sock = (1.0 - isA) * step(o.y, 0.125) * step(0.5, fract(seed * 3.7));
        col = mix(col, vec3(0.88, 0.88, 0.86), sock);
        skinK = (1.0 - isA) * (1.0 - sock);
        ao *= 1.0 - 0.25 * smoothstep(0.075, 0.04, ax) * step(0.75, o.y);
      } else if (reg == 4) {
        // ---- 靴: 底は別の色。運動靴は ひも ----
        gloss = dot(vColA, vec3(0.33)) < 0.2 ? 0.45 : 0.10;
        float lace = step(0.07, o.y) * step(0.0, o.z) * step(o.z, 0.09) * band(ax, 0.103, 0.014, 0.002) * band(fract(o.z / 0.018), 0.5, 0.18, 0.05);
        col = mix(col, vec3(0.92), lace * step(0.3, dot(vColA, vec3(0.33))) * step(0.5, seed));
      } else if (reg == 5) {
        // ---- 頭: まゆ・唇・鼻の穴・目のまわりの陰 ----
        skinK = 1.0;
        if (o.z > 0.04) {
          float bx = clamp((ax - 0.013) / 0.040, 0.0, 1.0);
          float by = 1.6545 + 0.0055 * sin(bx * 2.6) - 0.002 * bx;
          float brow = band(o.y, by, 0.0028 * (1.0 - 0.6 * bx), aa) * step(0.013, ax) * step(ax, 0.054);
          col = mix(col, vColB * 0.85, brow * 0.9);
          vec2 lp = vec2(o.x / 0.0205, (o.y - 1.5665) / 0.0062);
          float lip = smoothstep(1.0 + 0.08, 1.0 - 0.08, length(lp)) * smoothstep(-0.001, 0.003, o.z - 0.08);
          col = mix(col, skin * vec3(0.86, 0.60, 0.58), lip * 0.55);
          col *= 1.0 - 0.28 * band(o.y, 1.5665, 0.0006, aa) * smoothstep(0.021, 0.012, ax);
          col *= 1.0 - 0.30 * band(o.y, 1.5805, 0.0012, aa) * band(ax, 0.0058, 0.0022, aa) * step(o.z, 0.105);
          float sock = exp(-pow((ax - 0.0315) / 0.019, 2.0) - pow((o.y - 1.643) / 0.012, 2.0));
          col *= 1.0 - 0.18 * sock;
          col = mix(col, col * vec3(1.05, 0.90, 0.88), 0.25 * exp(-pow((ax - 0.045) / 0.02, 2.0) - pow((o.y - 1.604) / 0.015, 2.0)));
        }
        ao *= 1.0 - 0.25 * smoothstep(1.555, 1.528, o.y);
      } else if (reg == 6 || reg == 7) {
        // ---- 髪: 毛の流れの筋 ----
        hairK = 1.0;
        float a = atan(o.x, o.z);
        // 生え際・毛先は、毛の束ごとに長さが違う（すき間を抜く）
        float tuft = vnoise(vec2(a * (reg == 6 ? 70.0 : 45.0), seed * 17.0));
        if (reg == 6 && vInfo.y < tuft * 0.12) discard;
        if (reg == 7 && vInfo.y > 0.88 + 0.12 * tuft) discard;
        col *= 0.80 + 0.30 * vnoise(vec2(a * 40.0, o.y * 6.0 + seed * 9.0)) + 0.10 * vnoise(vec2(a * 120.0, o.y * 3.0));
        if (reg == 7) col *= 0.85 + 0.15 * smoothstep(0.0, 0.3, abs(vObj.x));
      } else if (reg == 8) {
        // ---- スカート: ひだの陰 ----
        float a = atan(o.x, o.z);
        col *= 0.88 + 0.12 * sin(a * 9.0) * smoothstep(1.05, 0.70, o.y);
      } else if (reg == 9) {
        col *= 0.92 + 0.08 * step(1.40, o.y);
        col *= 1.0 - 0.3 * band(o.y, 1.33, 0.003, aa);
        gloss = 0.15;
      } else {
        // ---- 目: 白目・虹彩・瞳。上下はまぶた（肌色）、まつげの線 ----
        vec3 c = vec3(sign(o.x) * eyeC.x, eyeC.y, eyeC.z), d = normalize(o - c);
        float lidT = 0.52 - 0.12 * clamp(d.x * sign(o.x), -1.0, 1.0), lidB = -0.60;
        float ir = smoothstep(0.86, 0.88, d.z), pu = smoothstep(0.955, 0.965, d.z);
        col = mix(vec3(0.90, 0.88, 0.85), vColA * (0.8 + 0.4 * smoothstep(0.88, 0.95, d.z)), ir);
        col = mix(col, vec3(0.02), pu);
        col *= 1.0 - 0.35 * band(d.z, 0.875, 0.012, 0.01);
        float lid = smoothstep(lidT - 0.04, lidT + 0.04, d.y) + smoothstep(lidB + 0.04, lidB - 0.04, d.y);
        float lash = band(d.y, lidT, 0.06, 0.03);
        col = mix(col, skin, clamp(lid, 0.0, 1.0));
        col = mix(col, vec3(0.04, 0.03, 0.03), lash * 0.9);
        eyeK = 1.0 - clamp(lid, 0.0, 1.0);
        skinK = 1.0 - eyeK;
      }
      // 布の織り目とむら
      float fabK = (1.0 - skinK) * (1.0 - hairK) * (1.0 - eyeK) * (reg == 4 ? 0.3 : 1.0);
      col *= 1.0 + fabK * ((vnoise(o.xy * vec2(55.0, 30.0) + seed * 13.0) - 0.5) * 0.10 + (vnoise(o.zy * vec2(200.0, 120.0)) - 0.5) * 0.05);
      // ---- 光 ----
      float sh = shadowAt(vWorld, N, 0.10);
      float nl = dot(N, ld);
      vec3 amb = ambCol * (0.72 + 0.28 * dot(N, up)) * ao;
      vec3 diff = sunCol * sh * max(nl, 0.0);
      // 肌: 光が少し回り込み、影の境目が赤みを帯びる
      diff += sunCol * sh * skinK * vec3(0.30, 0.12, 0.08) * max(0.0, 1.0 - abs(nl + 0.05) * 3.0);
      vec3 H = normalize(ld + V);
      float spec = 0.0;
      spec += skinK * 0.10 * pow(max(dot(N, H), 0.0), 30.0);
      spec += gloss * pow(max(dot(N, H), 0.0), 50.0);
      spec += eyeK * 1.4 * pow(max(dot(N, H), 0.0), 300.0);
      if (hairK > 0.5) {
        // 髪: 毛の向き（上下）に沿って伸びる照り
        vec3 T = normalize(up - N * dot(up, N));
        float th = dot(T, H);
        spec += 0.16 * pow(sqrt(max(0.0, 1.0 - th * th)), 80.0);
      }
      float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
      vec3 c = col * (amb + diff) + sunCol * sh * spec + (ambCol * 0.6 + sunCol * 0.15) * fres * 0.10 * (fabK + skinK * 0.5);
      gl_FragColor = vec4(c, 1.0);
      #include <fog_fragment>
    }`;

  // 影を撮るときの材料（同じ動きで深さだけ書く）
  const depthVS = `
    #include <common>
    ` + SKIN_GLSL + `
    varying vec2 vZW;
    void main() {
      vec3 p = restPos(position, normal, bone.w);
      if (partOn(bone.w, cB.y) < 0.5) p = vec3(0.0);
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(skinPos(p), 1.0);
      vZW = gl_Position.zw;
    }`;
  const depthFS = `
    #include <packing>
    varying vec2 vZW;
    void main() { gl_FragColor = packDepthToRGBA(0.5 * vZW.x / vZW.y + 0.5); }`;

  const packC = function (c) { return Math.round(Math.min(1, c[0]) * 255) * 65536 + Math.round(Math.min(1, c[1]) * 255) * 256 + Math.round(Math.min(1, c[2]) * 255); };
  let shapes = null;
  // n 人ぶんの体を描くメッシュ。fem: 女性の体型
  function create(scene, n, fem) {
    if (!shapes) shapes = [humanGeo(false), humanGeo(true)];
    const S = shapes[fem ? 1 : 0], base = S.geo, g = new THREE.BufferGeometry();
    for (const a in base.attributes) g.setAttribute(a, base.attributes[a]);
    g.setIndex(base.index);
    const attr = {};
    ['pA', 'pB', 'pC', 'cA', 'cB', 'cC'].forEach(function (k) {
      attr[k] = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      if (k[0] === 'p') attr[k].setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(k, attr[k]);
    });
    const mat = COL.GL.material(humanVS, humanFS, { eyeC: { value: new THREE.Vector3(EYE_X, EYE_Y, S.eyeZ) } });
    mat.userData.depth = new THREE.ShaderMaterial({ vertexShader: depthVS, fragmentShader: depthFS });
    const mesh = new THREE.InstancedMesh(g, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.array.fill(0);
    mesh.frustumCulled = false;
    mesh.layers.enable(1);
    scene.add(mesh);
    return {
      mesh: mesh, m: mesh.instanceMatrix.array, a: attr,
      // 見た目（色・服・髪）を決める
      look: function (k, o) {
        const set = function (name, v) { const ar = attr[name].array; ar[k * 4] = v[0]; ar[k * 4 + 1] = v[1]; ar[k * 4 + 2] = v[2]; ar[k * 4 + 3] = v[3]; attr[name].needsUpdate = true; };
        set('cA', [packC(o.skin), packC(o.hair), packC(o.top), packC(o.bottom)]);
        set('cB', [packC(o.shoe), o.flags, o.hairVol, o.seed]);
        set('cC', [o.headScale, packC(o.bag), packC(o.tie), packC(o.iris)]);
      },
      // 姿勢: 脚・膝・腕・肘（左右）と、体の上下・左右・前傾・ひねり
      pose: function (k, legL, legR, kneeL, kneeR, armL, armR, elL, elR, bob, sway, lean, twist) {
        const a = attr.pA.array, b = attr.pB.array, c = attr.pC.array, q = k * 4;
        a[q] = legL; a[q + 1] = legR; a[q + 2] = kneeL; a[q + 3] = kneeR;
        b[q] = armL; b[q + 1] = armR; b[q + 2] = elL; b[q + 3] = elR;
        c[q] = bob; c[q + 1] = sway; c[q + 2] = lean; c[q + 3] = twist;
      },
      flush: function () {
        mesh.instanceMatrix.needsUpdate = true;
        attr.pA.needsUpdate = attr.pB.needsUpdate = attr.pC.needsUpdate = true;
      },
    };
  }
  // 服や髪の印（シェーダーの bitF と同じ並び）
  const FLAG = { LONG_SLEEVE: 1, SLEEVELESS: 2, THREE_Q: 3, SHORTS: 4, SKIRT: 8, LONG_HAIR: 16, BAG: 32, JACKET: 64, VNECK: 128, UNTUCKED: 256, BELT: 512, CAPRI: 1024, TIE: 2048 };
  // 脚の長さ（腰〜膝、膝〜足首）と、立った時の腰から足首までの高さ
  const LEG = { TH: 0.42, SH: 0.426 };
  COL.Human = { create: create, FLAG: FLAG, LEG: LEG };
})();
