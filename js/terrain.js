// 地形・水域・ゾーンの定義（描画に依存しない）
//  - 陸地ごとの座標 (u, z): u は陸地の中央からの周方向の距離 [m]（-HW〜+HW）、z は軸方向 [m]
//  - 高さは「基準の円筒面（半径 R）からの高さ h」。水底は h < 0 になることもある
//  - 陸地ごとに水域は1系統（同じ水位）。A: 海 + 運河、B: 湖4つ + 川、C: 川 + ため池
//  - 見た目の地形メッシュと当たり判定を一致させるため、25m 格子に焼いた高さを両方で使う
(function (g) {
  'use strict';
  const COL = g.COL;
  const R = COL.R, L = COL.L;
  const HW = COL.STRIP * R / 2;            // 陸地の半幅（約1702m）
  const TAU = Math.PI * 2;
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const gauss = (x, c, s) => Math.exp(-((x - c) / s) * ((x - c) / s));

  COL.LAND_HW = HW;
  COL.TERRAIN_Z0 = COL.CAP_DEPTH;          // 地形の始まり（宇宙港側の山のすそ）

  // ---- ノイズ（整数ハッシュ。環境によらず同じ値になる） ----
  function hash2(i, j, seed) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  function fbm(x, y, oct, seed) {
    let s = 0, a = 0.5, n = 0;
    for (let i = 0; i < oct; i++) { s += a * vnoise(x, y, seed + i * 17); n += a; a *= 0.5; x *= 2.03; y *= 2.03; }
    return s / n;
  }
  COL.noise2 = vnoise;
  COL.fbm2 = fbm;

  // θ → { index: 陸地番号, u: 中央からの距離[m] }。窓の上なら null
  COL.landCoord = function (theta) {
    const a = mod(theta - COL.THETA0, TAU), i = Math.floor(a / COL.STRIP) % 6;
    if (i % 2) return null;
    return { index: i / 2, u: (a - (i + 0.5) * COL.STRIP) * R };
  };
  COL.landTheta = function (index, u) { return COL.landCenter(index) + u / R; };

  // ---- 水域 ----
  // 各陸地: level 水位, depth 最大水深, lam 深くなる速さ, shoreW 岸のなだらかな帯の幅, slope 岸の勾配
  const WATER = [
    { level: 0,  depth: 35, lam: 220, shoreW: 260, slope: 0.030 },
    { level: 20, depth: 22, lam: 90,  shoreW: 450, slope: 0.045 },
    { level: 3,  depth: 10, lam: 60,  shoreW: 200, slope: 0.030 },
  ];
  COL.WATER = WATER;
  const SEA_Z = 25000;                      // 海の手前の岸のおおよその位置

  // 川の中心線 u = c(z)
  const mB = (z) => gauss(z, 16000, 3000);  // 陸地Bの山脈のある範囲
  const RIVER = [
    { z0: 2700, z1: 25600, hw: 30, c: (z) => -520 + 250 * Math.sin(z / 1400) + 110 * Math.sin(z / 530 + 1) },
    { z0: 5000, z1: 27300, hw: 34, c: (z) => -330 - 600 * mB(z) + 250 * Math.sin(z / 1100) + 100 * Math.sin(z / 430 + 2) },
    { z0: 3000, z1: 28800, hw: 26, c: (z) => 480 + 300 * Math.sin(z / 1700 + 1) + 100 * Math.sin(z / 600) },
  ];
  // 湖・池（川の上に置く）: z 位置, 川からのずれ du, 半径 a(周方向) b(軸方向)
  const LAKES = [
    [{ z: 2700, du: 0, a: 130, b: 150 }],
    [{ z: 5000, du: 120, a: 450, b: 800 }, { z: 9800, du: -80, a: 380, b: 560 },
     { z: 21800, du: 150, a: 560, b: 950 }, { z: 27300, du: 60, a: 420, b: 650 }],
    [{ z: 3000, du: 0, a: 140, b: 160 }, { z: 10000, du: 40, a: 300, b: 450 },
     { z: 15000, du: -30, a: 220, b: 300 }, { z: 28800, du: 0, a: 330, b: 380 }],
  ];
  LAKES.forEach(function (list, i) { list.forEach(function (k) { k.u = RIVER[i].c(k.z) + k.du; }); });

  let lastKind = '';                        // 直前の waterSdf で一番近かった水域の種類
  // 水際までの距離 [m]（負 = 水の中）
  function waterSdf(i, u, z) {
    const rv = RIVER[i];
    const dz = 1e-3 + 0.5, slope = (rv.c(z + dz) - rv.c(z - dz)) / (2 * dz);
    let d = Math.abs(u - rv.c(z)) / Math.sqrt(1 + slope * slope) - rv.hw;
    d = Math.max(d, rv.z0 - z, z - rv.z1);
    lastKind = '川';
    const lakes = LAKES[i];
    for (let k = 0; k < lakes.length; k++) {
      const q = lakes[k], m = Math.min(q.a, q.b);
      const e = (Math.hypot((u - q.u) / q.a, (z - q.z) / q.b) - 1) * m + (vnoise(u / 260, z / 260, 40 + i) - 0.5) * 0.35 * m;
      if (e < d) { d = e; lastKind = m < 250 ? '池' : '湖'; }
    }
    if (i === 0) {
      // 人工の海: 幅 約2.4km、ガラスの端まで続く
      const qx = Math.abs(u) - (1200 - 500), qz = Math.abs(z - 28200) - (3200 - 500);
      let e = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - 500;
      e += (vnoise(u / 400, z / 400, 7) - 0.5) * 160;
      if (e < d) { d = e; lastKind = '海'; }
    }
    return d;
  }
  COL.waterSdf = waterSdf;

  // ---- 水を考えない素の地形 ----
  function mountainB(u, z) {
    const lat = (c, w) => { const t = (u - c) / w; return Math.max(0, 1 - t * t); };
    // 尾根: なだらかなうねりに、稜線の立つ折り返しノイズを重ねる
    const crest = 1 - Math.abs(2 * fbm(u / 420 + 1, z / 420, 3, 23) - 1);
    const ridge = (0.5 + 0.5 * fbm(u / 650 + 3, z / 650, 4, 21)) * (0.72 + 0.42 * crest);
    const main = 640 * mB(z) * lat(420, 1250) * ridge * (0.75 + 0.25 * Math.sin(z / 700 + u / 500));
    const north = 150 * gauss(z, 7600, 1500) * lat(650, 900) * ridge;
    const south = 190 * gauss(z, 24300, 1300) * lat(-450, 1000) * ridge;
    return main + north + south;
  }
  function baseHeight(i, u, z) {
    if (i === 0) return 5 + 6 * fbm(u / 900, z / 900, 3, 1) + 1.2 * vnoise(u / 140, z / 140, 2);
    if (i === 1) {
      const hills = fbm(u / 1100 + 9, z / 1100, 4, 11);
      return 23 + 70 * hills * hills + 5 * vnoise(u / 120, z / 120, 12) + mountainB(u, z);
    }
    return 6 + 5 * fbm(u / 1000, z / 1000, 3, 31) + 1.2 * vnoise(u / 140, z / 140, 32) + 26 * gauss(z, 14800, 900) * fbm(u / 500, z / 500, 3, 33);
  }

  // 格子に焼く前の、式どおりの高さ
  COL.terrainRaw = function (i, u, z) {
    const w = WATER[i], d = waterSdf(i, u, z), kind = lastKind;
    let h;
    if (d < 0 && kind === '海') {
      // 南国の遠浅のラグーン: 岸から約 120m までは水深 3m ほどの浅瀬、その先で深くなる（最深 35m）
      const e = -d;
      h = w.level - (3.2 * (1 - Math.exp(-e / 22)) + (w.depth - 3.2) * sstep(120, 420, e));
    } else if (d < 0) {
      h = w.level - w.depth * (1 - Math.exp(d / w.lam));
    } else {
      const b = baseHeight(i, u, z);
      h = b + (w.level + d * w.slope - b) * (1 - sstep(0, w.shoreW, d));
    }
    if (h > 0) h *= sstep(0, 200, HW - Math.abs(u)) * sstep(COL.TERRAIN_Z0, COL.TERRAIN_Z0 + 500, z);
    return h;
  };

  // ---- 25m 格子 ----
  const NU = 136, NZ = 1128;
  const DU = 2 * HW / NU, DZ = (L - COL.TERRAIN_Z0) / NZ;
  COL.GRID = { NU: NU, NZ: NZ, DU: DU, DZ: DZ };
  const grids = [null, null, null];
  // 陸地 i の格子: H 高さ, D 水際までの距離。添字は ju + jz * (NU + 1)
  COL.landGrid = function (i) {
    if (grids[i]) return grids[i];
    const W = NU + 1, H = new Float32Array(W * (NZ + 1)), D = new Float32Array(W * (NZ + 1));
    for (let jz = 0; jz <= NZ; jz++) {
      const z = COL.TERRAIN_Z0 + jz * DZ;
      for (let ju = 0; ju <= NU; ju++) {
        const u = -HW + ju * DU, k = ju + jz * W;
        H[k] = (ju === 0 || ju === NU || jz === 0) ? 0 : COL.terrainRaw(i, u, z);
        D[k] = waterSdf(i, u, z);
      }
    }
    return (grids[i] = { H: H, D: D, W: W });
  };

  // 地面の高さ（地形メッシュの三角形と同じ補間）。窓の上は 0
  COL.groundH = function (theta, z) {
    const lc = COL.landCoord(theta);
    if (!lc || z <= COL.TERRAIN_Z0) return 0;
    const gr = COL.landGrid(lc.index);
    let fu = (lc.u + HW) / DU, fz = (Math.min(z, L) - COL.TERRAIN_Z0) / DZ;
    let ju = Math.min(NU - 1, Math.max(0, Math.floor(fu))), jz = Math.min(NZ - 1, Math.max(0, Math.floor(fz)));
    fu -= ju; fz -= jz;
    const k = ju + jz * gr.W, a = gr.H[k], b = gr.H[k + 1], c = gr.H[k + gr.W], d = gr.H[k + gr.W + 1];
    return fu + fz <= 1 ? a + (b - a) * fu + (c - a) * fz : d + (c - d) * (1 - fu) + (b - d) * (1 - fz);
  };

  // その場所の水。水域の中なら { level, depth, kind }、外なら null
  COL.waterAt = function (theta, z) {
    const lc = COL.landCoord(theta);
    if (!lc || z <= COL.TERRAIN_Z0) return null;
    const d = waterSdf(lc.index, lc.u, Math.min(z, L)), kind = lastKind;
    if (d > 15) return null;
    const level = WATER[lc.index].level, depth = level - COL.groundH(theta, z);
    return depth > 0 ? { level: level, depth: depth, kind: kind } : null;
  };

  // ---- ゾーン ----
  COL.ZONES = {
    downtown: '中心市街', commercial: '商業区', residential: '住宅街', harbor: '港町', suburb: '郊外住宅',
    farm: '農地', industry: '工業区', warehouse: '倉庫街', park: '公園', forest: '森', meadow: '草原',
    mountain: '山岳', resort: 'リゾート', beach: '砂浜', water: '水域', window: '窓',
  };
  // 陸地 i の (u, z) のゾーン id。水の中は 'water'
  COL.zoneOf = function (i, u, z) {
    const d = waterSdf(i, u, z), kind = lastKind;
    if (d < 0) return 'water';
    const zz = z + (vnoise(u / 500, z / 700, 50 + i) - 0.5) * 700;
    if (i === 0) {
      if (kind === '海' && d < 90) return 'beach';
      if (z > SEA_Z - 300 && kind === '海' && d < 600) return u > 0 ? 'resort' : 'harbor';
      if (zz < 5000) return 'residential';
      if (zz < 9000) return 'commercial';
      if (zz < 15000) return 'downtown';
      if (zz < 20500) return 'residential';
      return 'harbor';
    }
    if (i === 1) {
      if (mountainB(u, z) > 70) return 'mountain';
      if (zz < 4200) return 'meadow';
      if (zz > 27600) return 'resort';
      return vnoise(u / 330, z / 330, 60) > 0.70 ? 'meadow' : 'forest';
    }
    if (zz < 6000) return 'suburb';
    if (zz < 13500) return 'farm';
    if (zz < 16200) return 'park';
    if (zz < 23500) return 'industry';
    if (zz < 27500) return 'warehouse';
    return 'park';
  };
  // ---- 街区（道路は u, z とも 125m ごとの格子。偶数番の線は大通り） ----
  COL.BLOCK = 125;
  const blockCache = new Map();
  // 街区 (bu, bz) = u: bu*125〜(bu+1)*125, z: bz*125〜(bz+1)*125 の使い道。
  //   中心市街: 'park' 公園 / 'tower' 大きな塔1棟 / 'quad' 4棟 / 'twin' 2棟。ほかのゾーンは BLOCK_TABLE のとおり。
  //   水際にかかる街区は 'bank'（川岸の緑地）
  // 道路の格子を敷くゾーンと、街区の使い道の割合
  const GRID_ZONES = COL.GRID_ZONES = { downtown: 1, residential: 1, commercial: 1, harbor: 1, suburb: 1, industry: 1, warehouse: 1, resort: 1 };
  const BLOCK_TABLE = {
    downtown: [['park', 0.15], ['tower', 0.25], ['quad', 0.40], ['twin', 0.20]],
    residential: [['houses', 0.52], ['apart', 0.18], ['mansion', 0.08], ['shops', 0.08], ['school', 0.04], ['park', 0.10]],
    suburb: [['houses', 0.68], ['shops', 0.08], ['park', 0.12], ['apart', 0.07], ['school', 0.05]],
    commercial: [['midrise', 0.36], ['mall', 0.12], ['hotel', 0.10], ['shops', 0.12], ['hospital', 0.05], ['museum', 0.04], ['park', 0.09], ['quad', 0.12]],
    harbor: [['warehouse', 0.32], ['shops', 0.14], ['hotel', 0.10], ['apart', 0.16], ['midrise', 0.16], ['park', 0.12]],
    resort: [['hotel', 0.30], ['villas', 0.40], ['park', 0.30]],
    industry: [['factory', 0.38], ['tanks', 0.20], ['warehouse', 0.24], ['yard', 0.18]],
    warehouse: [['warehouse', 0.58], ['yard', 0.24], ['shops', 0.06], ['park', 0.12]],
  };
  // 場所を決めて置く一点物
  const SPECIAL = { '0,2,96': 'cityhall', '0,5,56': 'stadium', '2,-4,40': 'stadium' };
  // 街区の情報 { type, zone }。街区でなければ null
  COL.blockInfo = function (i, bu, bz) {
    const key = i + ',' + bu + ',' + bz;
    if (blockCache.has(key)) return blockCache.get(key);
    const B = COL.BLOCK, u0 = bu * B, z0 = bz * B;
    let info = null;
    if (Math.abs(u0 + B / 2) < HW - 190 && z0 > COL.TERRAIN_Z0 + 600 && z0 + B < L - 50) {
      const zone = COL.zoneOf(i, u0 + B / 2, z0 + B / 2);
      if (GRID_ZONES[zone]) {
        let ok = 0, wet = false;
        for (let k = 0; k < 9; k++) {
          const u = u0 + 12 + (k % 3) * (B - 24) / 2, z = z0 + 12 + Math.floor(k / 3) * (B - 24) / 2;
          if (GRID_ZONES[COL.zoneOf(i, u, z)]) ok++;
          if (waterSdf(i, u, z) < 22) wet = true;
        }
        if (ok === 9) {
          let type = 'bank';
          if (!wet) {
            type = SPECIAL[key];
            if (!type) {
              let h = hash2(bu, bz, 900 + i);
              const tab = BLOCK_TABLE[zone];
              type = tab[tab.length - 1][0];
              for (let k = 0; k < tab.length; k++) { if (h < tab[k][1]) { type = tab[k][0]; break; } h -= tab[k][1]; }
            }
          }
          info = { type: type, zone: zone };
        }
      }
    }
    blockCache.set(key, info);
    return info;
  };
  COL.blockType = function (i, bu, bz) { const b = COL.blockInfo(i, bu, bz); return b ? b.type : null; };
  COL.blockTypeAt = function (i, u, z) { return COL.blockType(i, Math.floor(u / COL.BLOCK), Math.floor(z / COL.BLOCK)); };
  // 道路を描く場所か（中心市街で、水際から離れている）
  COL.isUrban = function (i, u, z) {
    return Math.abs(u) < HW - 200 && waterSdf(i, u, z) > 9 && !!GRID_ZONES[COL.zoneOf(i, u, z)];
  };

  // 画面表示用の名前
  COL.placeName = function (theta, z) {
    const lc = COL.landCoord(theta);
    if (!lc) return '窓';
    if (z < 0) return '宇宙港ドック';
    if (z <= COL.TERRAIN_Z0) return '宇宙港の山';
    const w = COL.waterAt(theta, z);
    if (w) return w.kind;
    const id = COL.zoneOf(lc.index, lc.u, Math.min(z, L));
    return id === 'water' ? '水辺' : COL.ZONES[id];
  };
})(typeof window !== 'undefined' ? window : globalThis);
