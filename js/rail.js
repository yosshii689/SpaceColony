// 環状モノレールの路線・駅・時刻表（描画に依存しない）
//  路線: 陸地A東側(上り) → 奥で窓Aを渡る → 陸地B西側(下り) → 手前で窓Bを渡る → 陸地C(上り)
//        → 奥で窓Cを渡る → 陸地A西側(下り) → 手前で折り返して出発点へ。一周 約128km
//  列車の位置は時刻から計算する（見ていない場所でも全編成が時刻表どおりに走る）
(function (g) {
  'use strict';
  const COL = g.COL, R = COL.R, sw = COL.STRIP * R;
  const ZN = 2500, ZF = 29500, RC = 250, STEP = 10;
  const V_MAX = 120 / 3.6, ACC = 1.0, DWELL = 15, HEADWAY = 120;
  let rail = null;

  COL.rail = function () {
    if (rail) return rail;
    // ---- 路線の形: 周方向に開いた平面 (x = 周方向の長さ, z) 上の折れ線。角は半径 250m で丸める ----
    const xA1 = 0.5 * sw + 1250, xB = 2.5 * sw - 1350, xC = 4.5 * sw - 1000, xA2 = 6.5 * sw - 1250, WRAP = 6 * sw;
    const P = [[xA1, ZN], [xA1, ZF], [xB, ZF], [xB, ZN], [xC, ZN], [xC, ZF], [xA2, ZF], [xA2, ZN], [xA1 + WRAP, ZN]];
    const dir = [];
    for (let i = 0; i < 8; i++) { const dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], l = Math.hypot(dx, dz); dir.push([dx / l, dz / l]); }
    const pts = [[P[0][0] + dir[0][0] * RC, P[0][1] + dir[0][1] * RC]];
    for (let i = 1; i <= 8; i++) {
      const din = dir[i - 1], dout = dir[i % 8], ta = [P[i][0] - din[0] * RC, P[i][1] - din[1] * RC];
      pts.push(ta);
      const c = [ta[0] + dout[0] * RC, ta[1] + dout[1] * RC];
      for (let q = 1; q <= 40; q++) {
        const ph = q / 40 * Math.PI / 2, cs = Math.cos(ph), sn = Math.sin(ph);
        pts.push([c[0] - dout[0] * RC * cs + din[0] * RC * sn, c[1] - dout[1] * RC * cs + din[1] * RC * sn]);
      }
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const len = cum[cum.length - 1], N = Math.round(len / STEP), ds = len / N;
    // 等間隔に取り直す
    const X = new Float64Array(N), Z = new Float64Array(N), H = new Float32Array(N);
    for (let k = 0, j = 0; k < N; k++) {
      const s = k * ds;
      while (j < pts.length - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      X[k] = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f; Z[k] = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
    }
    // ---- 桁の高さ: 地面（水面・窓）から約13m。前後 250m でならし、地面には近づきすぎない ----
    const G = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const th = COL.THETA0 + X[k] / R, w = COL.waterAt(th, Z[k]);
      G[k] = Math.max(COL.groundH(th, Z[k]), w ? w.level : -1e9, 0);
    }
    for (let k = 0; k < N; k++) {
      let sum = 0, mx = -1e9;
      for (let q = -25; q <= 25; q++) { const v = G[(k + q + N) % N]; sum += v; if (Math.abs(q) <= 4 && v > mx) mx = v; }
      H[k] = Math.max(sum / 51 + 13, mx + 9);
    }
    for (let pass = 0; pass < 3; pass++) {                      // 仕上げのならし（勾配の折れを消す）
      const T = Float32Array.from(H);
      for (let k = 0; k < N; k++) H[k] = (T[(k - 2 + N) % N] + T[(k - 1 + N) % N] + T[k] + T[(k + 1) % N] + T[(k + 2) % N]) / 5;
    }

    // 距離 s の位置: { x, z, tx, tz（進む向き）, h（桁の上面の高さ）, g（地面の高さ） }
    const at = function (s) {
      s = ((s % len) + len) % len;
      const fk = s / ds, k = Math.floor(fk) % N, kn = (k + 1) % N, f = fk - Math.floor(fk);
      const x1 = X[kn] + (kn === 0 ? WRAP : 0), dx = x1 - X[k], dz = Z[kn] - Z[k], l = Math.hypot(dx, dz) || 1;
      return { x: X[k] + dx * f, z: Z[k] + dz * f, tx: dx / l, tz: dz / l, h: H[k] + (H[kn] - H[k]) * f, g: G[k] };
    };
    // ワールド座標での位置と向き。lat: 進行方向の右への距離, up: 桁の上面からの高さ
    const world = function (s, lat, up) {
      const a = at(s), th = COL.THETA0 + (a.x + a.tz * (lat || 0)) / R, z = a.z - a.tx * (lat || 0), h = a.h + (up || 0);
      const f = COL.frameAt(th);
      return { pos: COL.toWorld(th, z, h), theta: th, z: z, h: h, g: a.g, a: a, up: f.up,
               T: [f.east[0] * a.tx, f.east[1] * a.tx, a.tz], Rw: [f.east[0] * a.tz, f.east[1] * a.tz, -a.tx] };
    };

    // ---- 駅 ----
    const want = [];
    [[xA1, '陸地A'], [xB, '陸地B'], [xC, '陸地C'], [xA2, '陸地A']].forEach(function (ln) {
      for (let j = 0; j < 9; j++) want.push([ln[0], 3500 + j * 3125, null]);
    });
    want.push([6.5 * sw, ZN, '陸地A・宇宙港エレベーター前']);
    want.push([2.5 * sw, ZN, '陸地B・宇宙港エレベーター前']);
    want.push([4.5 * sw, ZF, '陸地C・ガラスの端 展望']);
    const stations = want.map(function (w) {
      let best = 0, bd = 1e18;
      for (let k = 0; k < N; k++) {
        let dx = X[k] - w[0]; dx -= Math.round(dx / WRAP) * WRAP;
        const d = dx * dx + (Z[k] - w[1]) * (Z[k] - w[1]);
        if (d < bd) { bd = d; best = k; }
      }
      const th = COL.THETA0 + X[best] / R;
      const name = w[2] || (COL.stripAt(th).name + '・' + COL.placeName(th, Z[best]) + '（' + (Z[best] / 1000).toFixed(1) + 'km）');
      return { s: best * ds, name: name + '駅', alongZ: Math.abs(at(best * ds).tz) > 0.7 };
    }).sort(function (a, b) { return a.s - b.s; });

    // ---- 時刻表: 駅 i に着く時刻 A[i]（一周の中での秒）。加速 → 巡航 120km/h → 減速 → 15秒停車 ----
    const n = stations.length, A = [0], D = [];
    for (let i = 0; i < n; i++) {
      const d = (i + 1 < n ? stations[i + 1].s : stations[0].s + len) - stations[i].s;
      D.push(d);
      A.push(A[i] + DWELL + d / V_MAX + V_MAX / ACC);
    }
    const lap = A[n], trains = Math.round(lap / HEADWAY), headway = lap / trains;
    // 一周の中の時刻 tau での、路線上の距離
    const distAt = function (tau) {
      tau = ((tau % lap) + lap) % lap;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (A[m] <= tau) lo = m; else hi = m - 1; }
      const i = lo, u = tau - A[i] - DWELL, d = D[i], ta = V_MAX / ACC, T = d / V_MAX + ta;
      if (u <= 0) return stations[i].s;
      if (u < ta) return stations[i].s + 0.5 * ACC * u * u;
      if (u < T - ta) return stations[i].s + 0.5 * V_MAX * ta + V_MAX * (u - ta);
      return stations[i].s + d - 0.5 * ACC * (T - u) * (T - u);
    };
    // 列車 k（rev: 逆回り）の時刻 t での距離。逆回りは同じ時刻表を時間をさかのぼる向きにたどり（同じ駅に止まる）、半間隔ずらす
    const trainDist = function (rev, k, t) {
      return rev ? distAt(-(t + k * headway + headway / 2)) % len : distAt(t + k * headway) % len;
    };
    // 駅 j の状況: { present: 停車中の列車の番号（いなければ -1）, wait: 次の到着までの秒, left: 発車までの秒 }
    const stationInfo = function (j, rev, t) {
      const mod = function (x) { return ((x % headway) + headway) % headway; };
      if (!rev) {
        const ph = mod(t - A[j]);
        if (ph >= DWELL) return { present: -1, wait: headway - ph, left: 0 };
        const k = Math.round((A[j] + ph - t) / headway);
        return { present: ((k % trains) + trains) % trains, wait: 0, left: DWELL - ph };
      }
      const ph = mod(-(t + headway / 2) - A[j]);       // 逆回りでは時間とともに減っていく
      if (ph >= DWELL) return { present: -1, wait: ph - DWELL, left: 0 };
      const k = Math.round((-(t + headway / 2) - A[j] - ph) / headway);
      return { present: ((k % trains) + trains) % trains, wait: 0, left: ph };
    };

    rail = { len: len, N: N, ds: ds, X: X, Z: Z, H: H, WRAP: WRAP, at: at, world: world, stations: stations,
             lap: lap, trains: trains, headway: headway, distAt: distAt, trainDist: trainDist, stationInfo: stationInfo, DWELL: DWELL };
    return rail;
  };
})(typeof window !== 'undefined' ? window : globalThis);
