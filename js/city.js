// 街の作り込み: 建物・樹木・街灯・公園・ビーチ、近くの影、建物の当たり判定
//  - 建物の本体（遠くからも見える大きな形）は起動時に全部作り、同じ形の使い回し（インスタンス描画）で軽く描く
//  - 屋上の設備・街灯・樹木・パラソルなどの細かい物は、近くの 250m 区画だけ生成して表示する
//  - 窓・壁・夜の明かりは画像を使わず、シェーダーで描く
(function () {
  'use strict';
  const COL = window.COL, GL = COL.GL, U = GL.U, R = COL.R, B = COL.BLOCK;
  const TAU = Math.PI * 2;

  // ================= シェーダー =================
  const cityVS = GL.VS_HEAD + `
    attribute vec4 iparm;           // x: 壁の種類, y: 乱数の種, z: 発光の強さ（住まいの壁ではバルコニー面の向き 1: ±Z 面, 2: ±X 面）, w: 発光色の番号
    varying vec3 vWorld, vN, vCol, vT, vB, vSize;
    varying vec2 vUV, vTop;
    varying vec4 vParm;
    varying float vRoof;
    void main() {
      mat4 m = modelMatrix * instanceMatrix;
      vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vec4 wp = m * vec4(position, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(m) * (normal / (sc * sc)));
      // vUV: 壁に沿った長さ [m]。vT: その横向き, vB: 上向き。vSize: 面の半分の幅, 部品の高さ, バルコニー面なら 1
      #ifdef CAR
        // 車: uv.x に部品の番号（0 塗装, 1 ガラス, 2 黒い樹脂・タイヤ, 3 前の光の帯, 4 後ろの光の帯, 5 ホイール, 6 飾りの光の線）、uv.y に継ぎ目の位置の倍率
        vUV = position.zy;
        vec3 tO = vec3(0.0, 0.0, 1.0);
        vSize = vec3(uv.x, 1.0, uv.y);
      #elif defined(ROUND)
        vUV = vec2(uv.x * 3.14159265 * sc.x, position.y * sc.y);
        vec3 tO = vec3(normal.z, 0.0, -normal.x) + vec3(1e-4, 0.0, 0.0);
        vSize = vec3(1e4, sc.y, 0.0);
      #else
        bool fx = abs(normal.x) > 0.5;
        vUV = vec2(fx ? position.z * sc.z : position.x * sc.x, position.y * sc.y);
        vec3 tO = fx ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        float bal = ((iparm.z > 0.5 && iparm.z < 1.5 && abs(normal.z) > 0.5) || (iparm.z > 1.5 && fx)) ? 1.0 : 0.0;
        vSize = vec3((fx ? sc.z : sc.x) * 0.5, sc.y, bal);
      #endif
      vT = normalize(mat3(m) * tO);
      vB = normalize(mat3(m) * vec3(0.0, 1.0, 0.0));
      vTop = position.xz * sc.xz;
      vRoof = normal.y;
      vCol = vec3(1.0);
      #ifdef USE_INSTANCING_COLOR
        vCol = instanceColor;
      #endif
      vParm = iparm;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + GL.VS_TAIL + `
    }`;
  // 壁の種類: 0 オフィス（ガラス張り） 1 住まい（窓とバルコニー） 2 SF（暗いガラスと発光ライン）
  //           3 無地 4 低層部（1階は店のガラス） 5 発光体 6 戸建て（板張り） 7 車両（窓の帯） 8 自動車（部品ごとに塗装・ガラス・灯り）
  const cityFS = GL.FS_HEAD + GL.COMMON + GL.NOISE2 + GL.ULTRA + GL.SHADOW + `
    uniform float fx;
    varying vec3 vWorld, vN, vCol, vT, vB, vSize;
    varying vec2 vUV, vTop;
    varying vec4 vParm;
    varying float vRoof;
    // 整数の組から乱数（大きな値でも崩れない式）
    float h21(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    // 窓の奥の部屋（実際の部屋は作らず、窓の中に奥行きを描く）
    //  p: 窓の面の上での位置 [m], rs: 部屋の幅と天井の高さ [m], d: 部屋の中へ向かう視線（x: 壁ぞい, y: 上, z: 奥）
    //  kind: 0 事務所, 1 住まい, 2 店。戻り値 rgb: 部屋の色, a: 天井の照明なら 1
    vec4 room(vec2 p, vec2 rs, vec3 d, float r, float r2, float kind) {
      float D = 3.5 + 3.5 * r2;
      float tx = d.x > 1e-4 ? (rs.x - p.x) / d.x : (d.x < -1e-4 ? -p.x / d.x : 1e5);
      float ty = d.y > 1e-4 ? (rs.y - p.y) / d.y : (d.y < -1e-4 ? -p.y / d.y : 1e5);
      float tz = D / max(d.z, 1e-3);
      float t = min(min(tx, ty), tz);
      vec3 h = vec3(p, 0.0) + d * t;
      float dep = clamp(h.z / D, 0.0, 1.0);
      vec3 wallC = kind < 0.5 ? mix(vec3(0.80, 0.81, 0.82), vec3(0.68, 0.72, 0.76), r)
                 : kind < 1.5 ? mix(vec3(0.88, 0.82, 0.72), vec3(0.76, 0.82, 0.78), r)
                 : 0.6 + 0.4 * cos(6.2831853 * (r + vec3(0.0, 0.33, 0.67)));
      vec3 c;
      float lamp = 0.0;
      if (t == tz) {
        vec2 q = h.xy / rs;
        c = wallC;
        // 机・棚・ソファの影
        float fur = step(q.y, 0.28 + 0.14 * r2) * step(abs(q.x - 0.2 - 0.6 * r), 0.16 + 0.12 * r2);
        c = mix(c, c * 0.38, fur);
        // 壁の絵・ホワイトボード
        float art = step(abs(q.y - 0.58), 0.10) * step(abs(q.x - 0.75 + 0.5 * r2), 0.10);
        c = mix(c, kind < 0.5 ? vec3(0.92) : 0.5 + 0.4 * cos(6.2831853 * (r2 + vec3(0.1, 0.4, 0.7))), art);
        if (kind > 1.5) {
          // 店の棚: 色とりどりの商品
          float shelf = step(q.y, 0.78) * step(0.08, fract(q.y * 3.0));
          c = mix(c, 0.45 + 0.45 * cos(6.2831853 * (h21(floor(h.xy * vec2(2.5, 3.0))) + vec3(0.0, 0.33, 0.67))), shelf * 0.8);
        }
      } else if (t == ty) {
        if (d.y > 0.0) {
          c = vec3(0.88);
          vec2 lq = vec2(h.x / rs.x, h.z / D);
          float rows = kind < 0.5 ? 2.0 : 1.0;
          lamp = step(abs(lq.x - 0.5), kind < 0.5 ? 0.38 : 0.12) * step(abs(fract(lq.y * rows) - 0.5), kind < 0.5 ? 0.08 : 0.12);
        } else {
          c = kind < 0.5 ? vec3(0.40, 0.42, 0.45) : kind < 1.5 ? vec3(0.56, 0.41, 0.28) : vec3(0.78, 0.77, 0.74);
        }
      } else {
        c = wallC * 0.80;
      }
      c *= 1.0 - 0.45 * dep;
      return vec4(c, lamp);
    }
    // 品物などの落ち着いた色（彩度をおさえ、明るさに幅を持たせる）
    vec3 goodsC(float h) {
      vec3 c = 0.5 + 0.42 * cos(6.2831853 * (h + vec3(0.0, 0.33, 0.67)));
      return mix(vec3(dot(c, vec3(0.333))), c, 0.62) * (0.55 + 0.55 * fract(h * 7.3));
    }
    // 店の中（実際の部屋は作らず、窓の奥に描く）: 奥の壁の棚・吊るした服・カウンターとメニュー板、床のタイル、天井の照明、手前の陳列台
    //  p: 窓の面の上での位置 [m], rs: 店の幅と天井の高さ, d: 店の中へ向かう視線。戻り値 rgb: 色, a: 天井の照明なら 1
    vec4 shopRoom(vec2 p, vec2 rs, vec3 d, float r, float r2) {
      float D = 5.0 + 3.0 * r2;
      float typ = floor(fract(r * 7.13) * 3.0);               // 0 品物の棚, 1 服の店, 2 カフェ
      vec3 dd = mix(vec3(1e-4), d, step(1e-4, abs(d)));
      vec3 inv = 1.0 / dd, o = vec3(p, 0.0);
      float tx = d.x > 1e-4 ? (rs.x - p.x) / d.x : (d.x < -1e-4 ? -p.x / d.x : 1e5);
      float ty = d.y > 1e-4 ? (rs.y - p.y) / d.y : (d.y < -1e-4 ? -p.y / d.y : 1e5);
      float tz = D / max(d.z, 1e-3);
      float t = min(min(tx, ty), tz);
      // 手前の陳列台（カフェはカウンター席の台）
      vec3 bmin = vec3(rs.x * (0.24 + 0.12 * r2), 0.0, D * 0.30), bmax = vec3(rs.x * (0.60 + 0.12 * r2), typ > 1.5 ? 1.05 : 0.82, D * 0.46);
      vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv, tn = min(t0, t1), tf = max(t0, t1);
      float tin = max(max(tn.x, tn.y), tn.z), tout = min(min(tf.x, tf.y), tf.z);
      vec3 wallC = mix(vec3(0.90, 0.89, 0.86), vec3(0.93, 0.91, 0.88) * (0.85 + 0.15 * goodsC(r2 * 3.1)), 0.35);
      if (fract(r2 * 5.7) > 0.6) wallC = vec3(0.56, 0.42, 0.30);              // 板張りの壁の店
      if (typ > 1.5 && fract(r2 * 3.3) > 0.5) wallC = vec3(0.30, 0.31, 0.32);  // 黒っぽい壁のカフェ
      vec3 c;
      float lamp = 0.0, dep;
      if (tin < tout && tin > 0.0 && tin < t) {
        vec3 h = o + d * tin;
        dep = clamp(h.z / D, 0.0, 1.0);
        vec3 wood = typ > 1.5 ? vec3(0.36, 0.24, 0.16) : vec3(0.86, 0.85, 0.82);
        if (abs(h.y - bmax.y) < 0.01) {
          // 台の上: 並べた品物
          vec2 g = floor(h.xz * vec2(5.0, 4.0));
          float hh = h21(g + r * 31.0);
          c = mix(wood * 1.05, goodsC(hh), step(0.35, hh) * (typ > 1.5 ? 0.0 : 1.0));
        } else c = wood * 0.72;
        return vec4(c * (1.0 - 0.25 * dep), 0.0);
      }
      vec3 h = o + d * t;
      dep = clamp(h.z / D, 0.0, 1.0);
      if (t == tz || t == tx) {
        // 奥の壁と横の壁（横の壁は奥行きを横の位置として描く）
        vec2 q = t == tz ? h.xy : vec2(h.z + (h.x > rs.x * 0.5 ? 13.0 : 0.0), h.y);
        float side = t == tz ? 1.0 : 0.82;
        c = wallC;
        if (typ < 0.5) {
          // 品物の棚: 1m ごとの縦の支柱、40cm ごとの棚板、その間に高さのそろわない品物
          float rowY = 0.40, row = floor((q.y - 0.12) / rowY), fy = fract((q.y - 0.12) / rowY);
          float onShelf = step(0.0, row) * step(row, 4.0);
          float cell = floor(q.x * 7.0), hh = h21(vec2(cell, row) + r * 17.0);
          float item = step(fy, 0.18 + 0.70 * hh) * step(0.10, fract(q.x * 7.0)) * step(0.18, hh);
          c = mix(c, vec3(0.20, 0.20, 0.21), onShelf * 0.8);
          c = mix(c, goodsC(hh * 3.7 + row), onShelf * item);
          c = mix(c, vec3(0.88, 0.88, 0.86), onShelf * step(fy, 0.07));
          c = mix(c, vec3(0.30, 0.31, 0.33), onShelf * step(fract(q.x), 0.04));
        } else if (typ < 1.5) {
          // 服の店: 棒に吊るした服と、上の棚にたたんだ服
          float cell = floor(q.x * 13.0), hh = h21(vec2(cell, 3.0) + r * 9.0);
          float bot = 0.70 + 0.45 * hh, hang = step(bot, q.y) * step(q.y, 1.55) * step(0.25, hh) * step(0.08, fract(q.x * 13.0));
          c = mix(c, goodsC(r2 + 0.12 * floor(hh * 4.0)) * (0.8 + 0.3 * hh), hang);
          c = mix(c, vec3(0.55, 0.56, 0.58), step(abs(q.y - 1.58), 0.015));
          float fold = step(abs(q.y - 2.05), 0.08) * step(0.3, h21(vec2(floor(q.x * 3.0), 7.0) + r)) * step(0.15, fract(q.x * 3.0));
          c = mix(c, goodsC(h21(vec2(floor(q.x * 3.0), 9.0) + r)), fold);
          c = mix(c, wallC * 0.7, step(abs(q.y - 1.96), 0.012));
        } else {
          // カフェ: カウンター、後ろの棚の器、上のメニュー板
          float counter = step(q.y, 1.0) * side;
          c = mix(c, vec3(0.30, 0.20, 0.13), counter);
          c = mix(c, vec3(0.85, 0.83, 0.80), counter * step(0.96, q.y));
          float shelf = step(abs(q.y - 1.40), 0.13) * step(0.5, fract(q.x * 6.0)) * step(0.35, h21(vec2(floor(q.x * 6.0), 2.0) + r));
          c = mix(c, vec3(0.92, 0.91, 0.88), shelf * (1.0 - counter));
          vec2 mb = vec2(fract(q.x / 1.6), q.y);
          float board = step(1.75, q.y) * step(q.y, 2.55) * step(0.08, mb.x) * step(mb.x, 0.92) * side;
          float txt = step(0.55, fract(q.y * 9.0)) * step(0.2, mb.x) * step(mb.x, 0.2 + 0.6 * h21(vec2(floor(q.y * 9.0), floor(q.x / 1.6)) + r));
          c = mix(c, mix(vec3(0.10, 0.11, 0.10), vec3(0.85, 0.84, 0.78), txt), board);
        }
        c *= side;
      } else if (d.y > 0.0) {
        // 天井: 丸い照明が並ぶ
        c = vec3(0.86);
        vec2 lq = vec2(h.x, h.z) / 1.4;
        lamp = 1.0 - step(0.16, length(fract(lq) - 0.5));
      } else {
        // 床: タイル（または板張り）
        vec2 fq = vec2(h.x, h.z);
        bool plank = fract(r * 3.9) > 0.55;
        c = plank ? vec3(0.52, 0.38, 0.26) * (0.85 + 0.25 * h21(floor(fq * vec2(1.0, 6.0)) + r)) : vec3(0.80, 0.79, 0.76);
        vec2 gq = abs(fract(plank ? fq * vec2(1.0, 6.0) : fq / 0.6) - 0.5);
        c *= 1.0 - 0.18 * step(0.46, max(gq.x, gq.y));
      }
      c *= 1.0 - 0.28 * dep;
      return vec4(c, lamp);
    }
    // 看板の字（それらしい形）: 縦横の線を組み合わせる。f: 字の枠の中の位置 (0..1), h: 字ごとの乱数
    float glyph(vec2 f, float h) {
      vec2 p = (f - vec2(0.14, 0.0)) / vec2(0.72, 1.0);
      if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;
      float t = 0.18, m = 0.0;
      float b0 = step(0.4, fract(h * 13.7)), b1 = step(0.45, fract(h * 29.3)), b2 = step(0.4, fract(h * 47.1)), b3 = step(0.3, fract(h * 61.9));
      float b4 = step(0.5, fract(h * 83.3)), b5 = step(0.45, fract(h * 97.1)), b6 = step(0.5, fract(h * 7.9)), b7 = step(0.8, fract(h * 113.0));
      m = max(m, b0 * step(1.0 - t, p.y));
      m = max(m, b1 * step(abs(p.y - 0.5), t * 0.5));
      m = max(m, b2 * step(p.y, t));
      m = max(m, b3 * step(p.x, t) * step(0.5, p.y));
      m = max(m, max(b3, b4) * step(p.x, t) * step(p.y, 0.5));
      m = max(m, b5 * step(1.0 - t, p.x) * step(0.5, p.y));
      m = max(m, b6 * step(1.0 - t, p.x) * step(p.y, 0.5));
      m = max(m, b7 * step(abs(p.x - p.y), t * 0.7));
      m = max(m, (1.0 - b3) * (1.0 - b5) * step(abs(p.x - 0.5), t * 0.5));
      return m;
    }
    // 看板の地の色（落ち着いた色）と字の色
    vec3 fasciaC(float h) {
      return h < 0.18 ? vec3(0.13, 0.13, 0.14) : h < 0.32 ? vec3(0.10, 0.17, 0.30) : h < 0.44 ? vec3(0.12, 0.26, 0.19)
           : h < 0.56 ? vec3(0.40, 0.10, 0.12) : h < 0.70 ? vec3(0.88, 0.86, 0.80) : h < 0.82 ? vec3(0.45, 0.31, 0.20) : vec3(0.93, 0.93, 0.92);
    }
    vec3 letterC(vec3 bg, float h) {
      return dot(bg, vec3(0.333)) > 0.5 ? (fract(h * 5.1) < 0.5 ? vec3(0.10, 0.10, 0.11) : vec3(0.55, 0.12, 0.10))
                                         : (fract(h * 5.1) < 0.6 ? vec3(0.96, 0.95, 0.90) : vec3(0.90, 0.74, 0.42));
    }
    // 字の並び。q: 看板の中心からの位置 [m]（x 横, y 縦 0..1 で字の高さ）, n: 字の数, w: 字の幅 [m]
    float signText(vec2 q, float n, float w, float h) {
      float k = floor(q.x / w + n * 0.5);
      if (k < 0.0 || k >= n || q.y < 0.0 || q.y > 1.0) return 0.0;
      return glyph(vec2(fract(q.x / w + n * 0.5), q.y), h21(vec2(k, h * 97.0)));
    }
    // 向き n の面に当たる光。宇宙港ドックの中（z < 0）は昼夜に関係なく照明で明るい
    vec3 shade(vec3 n, vec3 up, vec3 ld, float sh) {
      vec3 l = ambCol * (0.76 + 0.24 * dot(n, up)) + sunCol * max(dot(n, ld), 0.0) * sh;
      return mix(l, vec3(0.80, 0.83, 0.90) * (0.66 + 0.34 * dot(n, up)), step(vWorld.z, 0.5));
    }
    // ガラスや車体に映る景色: 空と、地平の近くに並ぶ建物の影絵
    vec3 cityEnv(vec3 rf, vec3 up, float seed) {
      vec3 c = envSky(vWorld, rf);
      vec3 east = vec3(up.y, -up.x, 0.0);
      float e = dot(rf, up), az = atan(dot(rf, east), rf.z);
      float sky = 0.03 + 0.20 * vnoise(vec2(az * 7.0 + seed, seed * 0.37)) * vnoise(vec2(az * 2.3, seed + 4.0)) * 2.0;
      vec3 bld = (ambCol * 0.62 + sunCol * 0.30) * mix(vec3(0.46, 0.48, 0.52), vec3(0.66, 0.64, 0.60), vnoise(vec2(az * 11.0, seed)));
      bld += vec3(1.0, 0.85, 0.6) * night * 0.35 * step(0.72, vnoise(vec2(az * 60.0, e * 90.0)));
      return mix(c, bld, smoothstep(sky + 0.015, sky - 0.015, e) * smoothstep(-0.30, -0.02, e));
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN), V = normalize(cameraPosition - vWorld);
      if (!gl_FrontFacing) N = -N;
      vec3 up = normalize(vec3(-vWorld.xy, 1e-3)), ld = sunDirAt(vWorld);
      float sh = shadowAt(vWorld, N, 0.7);
      vec3 light = shade(N, up, ld, sh);
      int st = int(vParm.x + 0.5);
      float seed = floor(vParm.y + 0.5);
      vec3 glowCol = vParm.w < 0.5 ? vec3(0.25, 0.90, 1.0) : vParm.w < 1.5 ? vec3(1.0, 0.35, 0.80) : vec3(1.0, 0.72, 0.28);
      vec3 col;
      if (st == 5) {
        col = vCol * (0.30 + 0.55 * light) + vCol * vParm.z * (0.30 + 1.0 * night);
      } else if (st == 3) {
        vec2 q = vRoof > 0.9 ? vTop : vUV;
        col = vCol * (0.90 + 0.20 * vnoise(q / 1.6 + seed)) * light;
      } else if (st == 8) {
        // ---- 自動車: 艶のある塗装・ガラス・タイヤ・灯り ----
        int part = int(vSize.x + 0.5);
        vec3 rf = reflect(-V, N);
        vec3 env = cityEnv(rf, up, seed);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        float spec = pow(max(dot(rf, ld), 0.0), 240.0) * sh;
        // 車の横の面か（ドアの継ぎ目を描く所）
        float sideK = step(abs(dot(N, vB)), 0.6) * step(abs(dot(N, vT)), 0.5);
        float on = vParm.z;                                   // 走っている車は 1、止めてある車は 0
        vec3 accent = mix(vec3(0.30, 0.90, 1.0), vec3(1.0, 0.62, 0.25), step(0.82, fract(seed * 0.618)));
        if (part == 0) {
          // 見る角度で色味が少し変わる塗装
          vec3 pc = mix(vCol, vCol.brg * 0.55 + vec3(0.10, 0.12, 0.16), 0.30 * pow(1.0 - max(dot(N, V), 0.0), 2.0));
          vec3 base = pc * light + pc * sunCol * sh * pow(max(dot(rf, ld), 0.0), 10.0) * 0.30;
          col = base * (1.0 - 0.30 * fres) + env * (0.08 + 0.62 * fres) + sunCol * spec * 2.6;
          // ドアの継ぎ目（細い線）
          float dl = min(abs(vUV.x + 0.80 * vSize.z), abs(vUV.x - 0.42 * vSize.z));
          col *= 1.0 - 0.55 * sideK * (1.0 - smoothstep(0.003, 0.010, dl)) * step(0.30, vUV.y) * clamp(1.0 - fwidth(vUV.x) / 0.03, 0.0, 1.0);
        } else if (part == 1) {
          // 色の付いたガラス: 上から見るほど暗く、浅い角度では景色を映す
          col = (vec3(0.035, 0.055, 0.075) + vCol * 0.04) * light + env * (0.20 + 0.75 * fres) + sunCol * spec * 3.2;
        } else if (part == 2) {
          col = vec3(0.045, 0.045, 0.05) * light * (0.85 + 0.30 * vnoise(vUV * 40.0));
        } else if (part == 3) {
          col = vec3(0.55, 0.60, 0.66) * light * 0.6 + env * 0.25 + vec3(0.86, 0.95, 1.0) * on * (0.9 + 1.9 * night);
        } else if (part == 4) {
          col = vec3(0.42, 0.02, 0.03) * light + vec3(1.0, 0.07, 0.06) * on * (0.55 + 1.5 * night);
        } else if (part == 5) {
          col = vec3(0.16, 0.17, 0.19) * light + env * 0.40 + sunCol * spec * 1.2;
        } else {
          col = accent * 0.25 * light + accent * (0.30 + 0.70 * on) * (0.35 + 1.5 * night);
        }
      } else if (st == 9) {
        // 店の看板の板: 落ち着いた色の地に字（夜は字が光る）。ふちは金属の枠
        vec2 q = vUV;
        float H = vSize.y, hw = vSize.x, lh = H * 0.60, w = lh * 0.74, n = min(8.0, floor(hw * 1.7 / w));
        float txt = (vRoof < 0.5 && vRoof > -0.5 && hw > 1.0) ? signText(vec2(q.x, (q.y - H * 0.20) / lh), n, w, seed) : 0.0;
        float edge = step(min(hw - abs(q.x), min(q.y, H - q.y)), 0.07) * step(abs(vRoof), 0.5);
        vec3 lc = letterC(vCol, seed);
        col = mix(mix(vCol, lc, txt), vec3(0.24, 0.25, 0.26), edge) * light + lc * txt * (0.12 + 1.1 * night);
      } else if (st == 10) {
        // 日よけの布: 店によって縞。布のたるみの陰
        float q = vRoof > 0.5 ? vTop.x : vUV.x;
        float striped = step(0.45, fract(dot(vCol, vec3(3.1, 7.7, 1.3))));
        float s = step(0.5, fract(q / 0.30));
        vec3 base = mix(vCol, mix(vCol, vec3(0.93, 0.91, 0.85), s), striped);
        col = base * (0.93 + 0.07 * cos(q / 0.30 * 3.14159265)) * (0.96 + 0.08 * vnoise(vec2(q, vUV.y) * 9.0)) * light;
      } else if (vRoof > 0.9) {
        // 屋上: 防水シートの継ぎ目とむら
        float rk = clamp(1.0 - fwidth(vTop.x) / 0.5, 0.0, 1.0);
        vec2 gq = abs(fract(vTop / 4.0) - 0.5) * 4.0;
        float seam = 1.0 - smoothstep(0.03, 0.09, min(gq.x, gq.y));
        col = mix(vec3(0.40, 0.41, 0.43), vCol, 0.2) * (0.84 + 0.30 * vnoise(vTop / 2.5 + seed)) * (1.0 - 0.18 * seam * rk) * light;
        if (ultra > 0.5) {
          // 最高画質: 砂利の粒と、水のたまった跡
          float rf2 = clamp(1.0 - fwidth(vTop.x) / 0.06, 0.0, 1.0);
          col *= 1.0 + (hash(floor(vTop * 45.0) + seed) - 0.5) * 0.22 * rf2;
          col *= 1.0 - 0.16 * rk * smoothstep(0.62, 0.80, vnoise(vTop / 6.0 + seed * 1.7));
        }
      } else {
        // ---- 壁と窓 ----
        vec2 uv = vUV;
        float H = vSize.y, halfW = vSize.x;
        float fineK = clamp(1.0 - fwidth(vUV.y) / 0.8, 0.0, 1.0);     // 近いほど 1（細かい模様を描く）
        float thinK = clamp(1.0 - fwidth(vUV.y) / 0.12, 0.0, 1.0);    // 窓枠など、ごく細い線用
        float roomK = clamp(1.0 - fwidth(vUV.y) / 0.25, 0.0, 1.0) * step(0.5, fx);    // 部屋の奥行きを描く距離
        vec2 cs = vec2(3.0, 3.75), lo = vec2(0.0, 0.30), hi = vec2(1.0, 0.97);
        float margin = 0.45, trans = 0.55, kind = 0.0, dayLit = 0.75, nightLit = 0.45, mull = 1.5, recess = 0.0, span = 4.0, refl = 0.22;
        vec3 wall = vCol * (0.94 + 0.12 * vnoise(uv / 1.9 + seed));
        vec3 tint = vCol * 0.20 + vec3(0.03, 0.07, 0.10);
        vec3 sign = vec3(0.0);
        if (st == 4 && uv.y < min(5.2, H)) {
          // 1階の店: 大きなガラスと看板
          cs = vec2(6.0, min(5.2, H)); lo = vec2(0.05, 0.06); hi = vec2(0.95, 0.74);
          margin = 0.6; trans = 0.9; kind = 2.0; dayLit = 1.0; nightLit = 0.85; mull = 0.0; span = 1.0; refl = 0.15;
          // 店ごとの看板: 落ち着いた色の板に、字を並べる（夜は字が光る）
          vec2 sid = floor(uv / cs);
          float fy = fract(uv.y / cs.y), fxx = fract(uv.x / cs.x), sh2 = h21(sid + vec2(seed, 3.0));
          float band = step(0.79, fy) * step(fy, 0.96) * step(0.06, fxx) * step(fxx, 0.94);
          vec3 bg = fasciaC(sh2);
          float nL = 3.0 + floor(fract(sh2 * 7.7) * 6.0), lw = 0.40;
          float txt = signText(vec2((fxx - 0.5) * cs.x, (fy - 0.835) / 0.09), nL, lw, sh2) * band;
          vec3 lc = letterC(bg, sh2);
          float trim = band * (1.0 - step(0.80, fy) * step(fy, 0.95));
          vec3 fas = mix(mix(bg, lc, txt * fineK + 0.18 * txt * (1.0 - fineK)), bg * 0.6, trim);
          wall = mix(wall, fas, band);
          sign = lc * txt * fineK * 1.1 + bg * band * 0.10;
        } else if (st == 4) {
          uv.y -= 5.2; H -= 5.2;
          cs = vec2(3.0, 3.6); lo = vec2(0.10, 0.30); hi = vec2(0.90, 0.92); margin = 0.6; mull = 0.0; recess = 1.0; span = 1.0;
        } else if (st == 2) {
          cs = vec2(2.0, 4.0); lo = vec2(0.03, 0.05); hi = vec2(0.97, 0.98); trans = 0.30; nightLit = 0.18; mull = 0.0; margin = 0.2; span = 6.0; refl = 0.28;
          tint = vec3(0.02, 0.05, 0.09) + vCol * 0.12;
        } else if (st == 1) {
          cs = vec2(4.2, 3.1); margin = 0.9; trans = 0.8; kind = 1.0; dayLit = 0.06; nightLit = 0.5; mull = 0.0; recess = 1.0; span = 1.0; refl = 0.10;
          if (vSize.z > 0.5) { lo = vec2(0.10, 0.04); hi = vec2(0.90, 0.86); }     // バルコニー側は掃き出し窓
          else { lo = vec2(0.22, 0.32); hi = vec2(0.78, 0.88); }
        } else if (st == 6) {
          cs = vec2(3.4, 2.8); lo = vec2(0.24, 0.30); hi = vec2(0.76, 0.86); margin = 0.5; trans = 0.8; kind = 1.0; dayLit = 0.04; nightLit = 0.55; mull = 0.0; recess = 1.0; span = 1.0; refl = 0.10;
          wall *= 1.0 - 0.07 * thinK * step(0.80, fract(uv.y / 0.21));      // 板張りの外壁
        } else if (st == 7) {
          cs = vec2(1.6, H); lo = vec2(0.06, 0.42); hi = vec2(0.94, 0.86); margin = 0.5; trans = 0.85; dayLit = 1.0; nightLit = 1.0; mull = 0.0; span = 1.0; refl = 0.12;
        } else if (h21(vec2(seed, 1.0)) < 0.35) {
          // オフィスの一部は、石張りの壁に窓をあけた形
          lo = vec2(0.12, 0.30); hi = vec2(0.88, 0.90); mull = 0.0; margin = 0.8; recess = 1.0;
        }
        if (st == 0 && mull > 0.0) wall = mix(wall, tint * 1.8 + vec3(0.04), 0.45);   // ガラス張りの階の間の帯
        // 外壁の汚れ: 足元・雨だれ・大きなむら
        wall *= (1.0 - 0.20 * exp(-vUV.y / 1.6)) * (1.0 - 0.10 * fineK * smoothstep(0.6, 0.95, vnoise(vec2(uv.x * 1.7, uv.y * 0.04 + seed))))
              * (0.93 + 0.14 * vnoise(vUV / 11.0 + seed * 3.1));
        vec3 wallLight = light;
        if (ultra > 0.5 && fineK > 0.01) {
          // 最高画質: 壁のざらつきと目地の凹凸（光の当たり方が細かく変わる）と、弱い照り返し
          vec2 jd = (0.5 - abs(fract(uv / cs) - 0.5)) * cs;
          float hW = vnoise(vUV * 4.0 + seed) * 0.014 + vnoise(vUV * 17.0 + seed) * 0.004 + smoothstep(0.0, 0.035, min(jd.x, jd.y)) * 0.012;
          if (st == 6) hW += fract(uv.y / 0.21) * 0.014;
          vec2 hg = hgrad(vUV, hW) * fineK;
          vec3 Nw = normalize(N - vT * hg.x - vB * hg.y);
          wallLight = shade(Nw, up, ld, sh) + sunCol * sh * pow(max(dot(reflect(-V, Nw), ld), 0.0), 18.0) * 0.10;
          wall *= 1.0 + (vnoise(vUV * 9.0 + seed) - 0.5) * 0.08 * fineK;
        }
        // 窓のマス。面の端で切れるマスと、屋根で切れる最上階のマスには窓を入れない
        vec2 g = uv / cs, id = floor(g), f = g - id;
        float ok = step(abs(id.x * cs.x), halfW - margin) * step(abs((id.x + 1.0) * cs.x), halfW - margin)
                 * step(0.0, id.y) * step((id.y + 1.0) * cs.y, H + 0.02);
        vec2 fw = fwidth(g) + 1e-5;
        vec2 a = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
        float m = mix(a.x * a.y, (hi.x - lo.x) * (hi.y - lo.y), clamp(max(fw.x, fw.y) * 2.5 - 0.6, 0.0, 1.0)) * ok;
        // 部屋ごとの乱数（事務所は span マスで1部屋。明かりは階ごとにそろいやすい）
        vec2 rid = vec2(floor(id.x / span), id.y);
        float r = h21(rid + vec2(seed * 7.0, seed)), r3 = h21(rid + vec2(seed + 11.0, 29.0));
        float r2 = (kind < 0.5 && st != 7) ? mix(h21(vec2(id.y, seed + 9.0)), h21(rid + vec2(seed * 3.0, 17.0)), 0.3)
                                            : h21(rid + vec2(seed * 3.0 + 5.0, 17.0));
        float farK = clamp(max(fw.x, fw.y) * 3.0 - 0.45, 0.0, 1.0);          // 窓のマスが数画素より小さいほど 1
        float lit = mix(step(r2, mix(dayLit, nightLit, night)), mix(dayLit, nightLit, night), farK);
        r = mix(r, 0.5, farK);
        float glowK = 1.0 + 0.8 * night;                                  // 夜は部屋の明かりが際立つ
        vec3 lampC = kind < 0.5 ? vec3(0.95, 0.97, 1.0) : mix(vec3(1.0, 0.82, 0.58), vec3(1.0, 0.93, 0.80), r);
        vec3 inLight = ambCol * 0.42 + sunCol * 0.10 + lit * lampC * (0.55 + 0.30 * r) * glowK;
        vec2 wf = clamp((f - lo) / (hi - lo), 0.0, 1.0), win = (hi - lo) * cs;
        vec3 inside = vec3(0.55) * inLight;
        if (roomK > 0.01 && m > 0.001) {
          vec3 dl = vec3(dot(-V, vT), dot(-V, vB), dot(-V, -N));
          vec2 rp = vec2((mod(id.x, span) + f.x) * cs.x, f.y * cs.y);
          vec4 rm = kind > 1.5 ? shopRoom(rp, vec2(span * cs.x, cs.y), dl, r, r2) : room(rp, vec2(span * cs.x, cs.y), dl, r, r2, kind);
          inside = mix(vec3(0.55), rm.rgb, roomK) * inLight + rm.a * lit * lampC * 1.3 * roomK;
        }
        if (kind < 0.5 && st != 7) {
          // ブラインド（上から途中まで下ろしてある窓もある）
          float bl = step(0.68, r3) * step(1.0 - (0.15 + 0.75 * fract(r3 * 13.0)), wf.y) * step(0.3, roomK);
          vec3 blC = vec3(0.82, 0.82, 0.80) * (light * 0.45 + lit * lampC * 0.55 * glowK) * (0.92 + 0.08 * step(0.5, fract(wf.y * win.y * 8.0)) * thinK);
          inside = mix(inside, blC, bl);
        } else if (kind > 0.5 && kind < 1.5) {
          // カーテン（両脇）とレース
          float cw = 0.10 + 0.20 * r3;
          float cur = (1.0 - step(cw, wf.x) * step(wf.x, 1.0 - cw)) * step(0.3, roomK);
          vec3 cc = mix(vec3(0.88, 0.82, 0.70), vec3(0.62, 0.70, 0.82), fract(r3 * 7.0));
          cc = mix(cc, vec3(0.85, 0.60, 0.60), step(0.8, fract(r3 * 5.3)));
          cc *= 1.0 - 0.10 * thinK * (0.5 + 0.5 * sin(wf.x * win.x * 40.0));
          inside = mix(inside, cc * (light * 0.45 + lit * lampC * 0.85 * glowK), cur);
          inside = mix(inside, vec3(0.92) * (light * 0.45 + lit * lampC * 0.7), step(0.55, fract(r3 * 3.7)) * 0.55 * (1.0 - cur));
        }
        // ガラス: 外の景色の映り込み・中の透け・太陽の照り返し
        vec3 rf = reflect(-V, N);
        vec3 sky = ambCol * 1.3 + sunCol * 0.3;
        #ifdef USE_FOG
          sky = fogColor;
        #endif
        vec3 env = sky * mix(0.40, 1.22, clamp(dot(rf, up) * 0.6 + 0.5, 0.0, 1.0));
        if (ultra > 0.5) {
          // 最高画質: 空・雲・まわりの建物を映す。ガラス1枚ごとにわずかに傾きが違う（映り込みが少しずつずれる）
          rf = reflect(-V, normalize(N + (vT * (h21(id + seed) - 0.5) + vB * (h21(id.yx + seed + 5.0) - 0.5)) * 0.035 * roomK));
          env = cityEnv(rf, up, seed);
        }
        float fres = refl + (1.0 - refl) * pow(1.0 - max(dot(V, N), 0.0), 4.0);
        // 夜は外が暗いので、明かりの点いた部屋は色付きガラス越しでも明るく見える
        vec3 glass = mix(tint * light * 0.5, inside, mix(trans, 0.95, night * lit)) * (1.0 - fres * (1.0 - 0.6 * night * lit)) + env * fres + sunCol * sh * pow(max(dot(rf, ld), 0.0), 60.0) * 1.2;
        // 窓のくぼみの影（上の方）と、窓枠・方立て
        vec2 wm = wf * win;
        glass *= 1.0 - recess * 0.35 * (1.0 - smoothstep(0.0, 0.35, win.y - wm.y)) * fineK;
        float frame = 1.0 - step(0.05, min(min(wm.x, win.x - wm.x), min(wm.y, win.y - wm.y)));
        if (mull > 0.0) frame = max(frame, step((0.5 - abs(fract(uv.x / mull) - 0.5)) * mull, 0.045));
        vec3 frameC = mix(vec3(0.26, 0.27, 0.29), vec3(0.80, 0.81, 0.82), step(0.5, fract(seed * 0.37))) * light;
        if (kind > 1.5) {
          // 店先のガラス: 欄間の横桟・縦の方立て・扉（太い枠と金属の取っ手）
          float ds = floor(h21(id + vec2(seed, 41.0)) * 3.0), third = win.x / 3.0, dx0 = ds * third;
          float doorH = min(2.55, win.y - 0.3);
          float tr = step(abs(wm.y - doorH), 0.045);
          float v1 = step(abs(wm.x - third), 0.035), v2 = step(abs(wm.x - 2.0 * third), 0.035);
          float inDoor = step(dx0, wm.x) * step(wm.x, dx0 + third) * step(wm.y, doorH);
          float dEdge = min(min(wm.x - dx0, dx0 + third - wm.x), doorH - wm.y);
          frame = max(frame, max(tr, max(v1, v2)) * fineK);
          frame = max(frame, inDoor * step(dEdge, 0.09) * fineK);
          frameC = mix(vec3(0.13, 0.13, 0.14), vec3(0.42, 0.36, 0.28), step(0.7, fract(seed * 0.53))) * light;
          float hx = ds < 1.5 ? dx0 + third - 0.22 : dx0 + 0.22;
          float handle = inDoor * step(abs(wm.x - hx), 0.022) * step(abs(wm.y - 1.10), 0.40) * fineK;
          glass = mix(glass, vec3(0.75, 0.76, 0.78) * light + sunCol * sh * 0.3, handle);
          glass *= 1.0 - 0.10 * inDoor * fineK;
        }
        glass = mix(glass, frameC, frame * thinK);
        col = mix(wall * wallLight + sign * night, glass, m);
        if (st == 2) {
          float fx = fwidth(vUV.x) + 1e-4, fy = fwidth(vUV.y) + 1e-4;
          float gl = (1.0 - smoothstep(0.16 - fx, 0.30 + fx, abs(fract(vUV.x / 13.0) - 0.5) * 13.0)) * clamp(0.3 / fx, 0.0, 1.0);
          float belt = (1.0 - smoothstep(0.25 - fy, 0.45 + fy, abs(fract(vUV.y / 42.0) - 0.5) * 42.0)) * clamp(0.45 / fy, 0.0, 1.0);
          col += glowCol * max(gl, belt) * (0.45 + 0.95 * night);
        }
      }
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`;

  // 樹木: 葉の板（模様の透明な所は捨てる）と、幹・枝・中の濃い葉（模様なし）を同じ材料で描く
  //  uv.x < 0 の頂点は模様を使わない。uv.y < -1.5 なら樹皮、それ以外は茂み
  const treeVS = GL.VS_HEAD + `
    varying vec3 vWorld, vN, vCol;
    varying vec2 vUv;
    uniform float time;
    void main() {
      mat4 m = modelMatrix * instanceMatrix;
      vec4 wp = m * vec4(position, 1.0);
      if (uv.x < 0.0 && uv.y < -2.5) {
        // 海の中の やわらかい物（海草・イソギンチャク・ウミウチワ）: 波に合わせて ゆっくり揺れる。先ほど大きく
        float w = -uv.y - 3.0, ph = time * 1.3 + wp.x * 0.31 + wp.z * 0.43;
        vec3 upd = normalize(vec3(-wp.xy, 1e-4)), east = vec3(upd.y, -upd.x, 0.0);
        wp.xyz += (east * sin(ph) + vec3(0.0, 0.0, 1.0) * sin(ph * 0.73 + 1.3) * 0.7) * 0.13 * w * length(m[1].xyz);
      }
      vWorld = wp.xyz;
      vN = normalize(mat3(m) * normal);
      vCol = color;
      #ifdef USE_INSTANCING_COLOR
        vCol *= instanceColor;
      #endif
      vUv = uv;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + GL.VS_TAIL + `
    }`;
  const treeFS = GL.FS_HEAD + GL.COMMON + GL.SHADOW + GL.CAUSTIC + `
    uniform sampler2D leafMap;
    varying vec3 vWorld, vN, vCol;
    varying vec2 vUv;
    float th31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float tn3(vec3 p) {
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(th31(i), th31(i + vec3(1, 0, 0)), f.x), mix(th31(i + vec3(0, 1, 0)), th31(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(th31(i + vec3(0, 0, 1)), th31(i + vec3(1, 0, 1)), f.x), mix(th31(i + vec3(0, 1, 1)), th31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN), V = normalize(cameraPosition - vWorld);
      vec3 up = normalize(vec3(-vWorld.xy, 1e-3)), ld = sunDirAt(vWorld);
      vec3 col = vCol;
      float leaf = 0.0;
      if (vUv.x >= 0.0) {
        // 葉の板: 遠くで葉がやせないよう、縮小の度合いに応じて残しやすくする
        vec4 t = texture2D(leafMap, vUv);
        vec2 g = vUv * 1024.0, dx = dFdx(g), dy = dFdy(g);
        float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
        if (t.a * (1.0 + 0.4 * lod) < 0.5) discard;
        col *= t.rgb * 1.15;
        leaf = 1.0;
      } else {
        if (!gl_FrontFacing) N = -N;
        vec3 q = mod(vWorld, 512.0);
        float k = clamp(1.0 - length(fwidth(vWorld)) * 1.5, 0.0, 1.0);
        if (vUv.y < -1.5) col *= mix(1.0, 0.78 + 0.44 * tn3(q * 4.0), k);                                   // 樹皮
        else if (vUv.y < -1.1) {
          // サンゴ: 表面の細かい粒（ポリプ）。ノウサンゴは迷路のような溝
          float k2 = clamp(1.0 - length(fwidth(vWorld)) * 9.0, 0.0, 1.0);
          col *= mix(1.0, 0.86 + 0.28 * tn3(q * 3.0), k);
          if (vUv.y < -1.3) {
            float mz = min(abs(tn3(q * 10.0) - 0.5), abs(tn3(q * 17.0 + 7.0) - 0.5) + 0.01);
            col *= mix(1.0, 0.55 + 0.60 * smoothstep(0.0, 0.07, mz), k);
          } else {
            col *= mix(1.0, 0.93 + 0.16 * smoothstep(0.45, 0.65, tn3(q * 70.0)), k2);
          }
        }
        else col *= mix(1.0, 0.55 + 0.9 * (tn3(q * 2.2) * 0.6 + tn3(q * 6.5) * 0.4), k);                    // 茂みのむら
      }
      float sh = shadowAt(vWorld, N, 0.5);
      float ndl = dot(N, ld);
      vec3 light = ambCol * (0.70 + 0.30 * dot(N, up))
                 + sunCol * sh * mix(max(ndl, 0.0), 0.25 + 0.75 * max(ndl * 0.7 + 0.3, 0.0), leaf);
      // 逆光で葉が透けて光る
      light += leaf * sunCol * sh * pow(max(dot(-V, ld), 0.0), 3.0) * 0.6 * vec3(1.0, 1.1, 0.7);
      // 海の中（サンゴ）: 水面の揺らぎの光の網目
      float dpt = length(vWorld.xy) - COL_R;
      if (dpt > 0.15) {
        float ck = smoothstep(0.15, 1.0, dpt) * exp(-dpt / 16.0) * clamp(1.0 - length(fwidth(vWorld)) * 2.0, 0.0, 1.0);
        light += sunCol * sh * caustic(vWorld.xz / 9.0, time * 0.7) * ck * 0.7;
        light *= mix(vec3(1.0), exp(-dpt * vec3(0.09, 0.03, 0.02)), smoothstep(0.0, 0.6, dpt));   // 水の中で少し青みがかる
      }
      gl_FragColor = vec4(col * light, 1.0);
      #include <fog_fragment>
    }`;
  // 影を撮るとき用: 葉の模様の透明な所は影を落とさない
  const leafDepthVS = `
    varying vec2 vUv;
    varying vec2 vZW;
    void main() {
      vUv = uv;
      #include <begin_vertex>
      #include <project_vertex>
      vZW = gl_Position.zw;
    }`;
  const leafDepthFS = `
    #include <packing>
    uniform sampler2D leafMap;
    varying vec2 vUv;
    varying vec2 vZW;
    void main() {
      if (vUv.x >= 0.0 && texture2D(leafMap, vUv).a < 0.5) discard;
      gl_FragColor = packDepthToRGBA(0.5 * vZW.x / vZW.y + 0.5);
    }`;

  // ================= 部品の形 =================
  const UNIT = {}, MAT = {}, V = COL.V;
  let leafTex = null, leafDepth = null;
  function geoFrom(buf) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(buf.c, 3));
    if (buf.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    return g;
  }

  // ---- 葉の模様（画像ファイルは使わず、ここで描く） ----
  //  1024×1024 を4つに分ける: 左上・右上 広葉樹の枝先, 左下 針葉樹の枝, 右下 ヤシの葉
  const ATLAS = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];
  function leafAtlas(renderer) {
    const S = 1024, Q = 512, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d'), rnd = COL.rng(31337);
    const rgb = function (r, gg, b) { return 'rgb(' + Math.round(Math.min(255, r)) + ',' + Math.round(Math.min(255, gg)) + ',' + Math.round(Math.min(255, b)) + ')'; };
    const leaf = function (x, y, len, wid, ang, col) {
      g.save(); g.translate(x, y); g.rotate(ang); g.fillStyle = col;
      g.beginPath(); g.moveTo(-len / 2, 0);
      g.quadraticCurveTo(0, -wid, len / 2, 0); g.quadraticCurveTo(0, wid, -len / 2, 0);
      g.fill(); g.restore();
    };
    const line = function (x, y, a, l) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); };
    g.lineCap = 'round';
    // 広葉樹の枝先 2種類: 小枝 → 奥の暗い葉 → 中ほど → 手前の明るい葉 の順に重ねる
    for (let q = 0; q < 2; q++) {
      const cx = q * Q + Q / 2, cy = Q / 2;
      g.strokeStyle = 'rgb(64,48,34)'; g.lineWidth = 5;
      for (let k = 0; k < 7; k++) line(cx, cy, rnd() * TAU, 120 + rnd() * 80);
      const n = q ? 300 : 240, L0 = q ? 30 : 40;
      for (let pass = 0; pass < 3; pass++) for (let k = 0; k < n * (pass === 1 ? 1 : 0.5); k++) {
        const a = rnd() * TAU, rr = 205 * Math.pow(rnd(), 0.8);
        const sh = [0.50, 0.78, 1.05][pass] * (0.85 + 0.3 * rnd()), hue = rnd(), L = L0 + rnd() * 16;
        leaf(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.92, L, L * 0.36, rnd() * TAU,
             rgb((52 + 46 * hue) * sh, (98 + 34 * hue) * sh, (30 + 16 * hue) * sh));
      }
    }
    // 針葉樹の枝: 左が付け根、右が先。小枝に針のような葉
    {
      const y0 = Q + Q / 2, x0 = 18, x1 = Q - 18;
      for (let k = 0; k < 40; k++) {
        const t = (k + 0.5) / 40, x = x0 + (x1 - x0) * t;
        const half = 205 * Math.pow(1 - t, 0.7) * Math.min(1, 0.25 + t * 5);
        for (let sd = -1; sd <= 1; sd += 2) {
          const ex = x + half * 0.55, ey = y0 + sd * half, ang = Math.atan2(ey - y0, ex - x);
          g.strokeStyle = 'rgb(58,44,30)'; g.lineWidth = 2.5; line(x, y0, ang, Math.hypot(ex - x, ey - y0));
          const steps = Math.max(2, Math.round(half / 9));
          g.lineWidth = 4;
          for (let j = 0; j < steps; j++) {
            const s = (j + 0.5) / steps, px = x + (ex - x) * s, py = y0 + (ey - y0) * s, sh = 0.7 + 0.5 * rnd(), nl = 14 + 8 * rnd();
            g.strokeStyle = rgb(30 * sh, (68 + 20 * rnd()) * sh, 38 * sh);
            line(px, py, ang + 0.9 + rnd() * 0.3, nl); line(px, py, ang - 0.9 - rnd() * 0.3, nl); line(px, py, ang + 0.2, nl * 0.8);
          }
        }
      }
      g.strokeStyle = 'rgb(62,46,30)'; g.lineWidth = 6; line(x0, y0, 0, x1 - x0);
    }
    // ヤシの葉: 左が付け根、右が先。中央の軸から細長い小葉が並ぶ
    {
      const y0 = Q + Q / 2, x0 = Q + 14, x1 = 2 * Q - 14;
      for (let k = 0; k < 70; k++) {
        const t = (k + 0.5) / 70, x = x0 + (x1 - x0) * t;
        const Lf = 215 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.98)), 0.7) * (1 - 0.3 * t);
        for (let sd = -1; sd <= 1; sd += 2) {
          const ang = sd * (1.05 - 0.45 * t) + (rnd() - 0.5) * 0.12, sh = 0.75 + 0.4 * rnd();
          leaf(x + Math.cos(ang) * Lf / 2, y0 + Math.sin(ang) * Lf / 2, Lf, 7 + 3 * rnd(), ang,
               rgb((72 + 30 * rnd()) * sh, (118 + 26 * rnd()) * sh, (38 + 10 * rnd()) * sh));
        }
      }
      g.strokeStyle = 'rgb(150,140,78)'; g.lineWidth = 6; line(x0, y0, 0, x1 - x0);
    }
    // 透明な所の色を、その区画の葉の平均色にしておく（縮小したときに縁が黒ずまないように）
    const img = g.getImageData(0, 0, S, S), d = img.data;
    for (let q = 0; q < 4; q++) {
      const ox = (q & 1) * Q, oy = (q >> 1) * Q;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = oy; y < oy + Q; y += 2) for (let x = ox; x < ox + Q; x += 2) {
        const o = (y * S + x) * 4;
        if (d[o + 3] > 200) { sr += d[o]; sg += d[o + 1]; sb += d[o + 2]; n++; }
      }
      n = Math.max(1, n);
      for (let y = oy; y < oy + Q; y++) for (let x = ox; x < ox + Q; x++) {
        const o = (y * S + x) * 4;
        if (d[o + 3] === 0) { d[o] = sr / n; d[o + 1] = sg / n; d[o + 2] = sb / n; }
      }
    }
    const tex = new THREE.DataTexture(new Uint8Array(d.buffer), S, S, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    return tex;
  }

  // ---- 木の形を組み立てる道具 ----
  function TB() { this.p = []; this.n = []; this.c = []; this.uv = []; }
  TB.prototype.vert = function (p, n, c, u, v) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.c.push(c[0], c[1], c[2]); this.uv.push(u, v);
  };
  // 管（幹・枝）: 点の列と、それぞれの太さ
  TB.prototype.tube = function (pts, rads, sides, colFn) {
    let prev = null;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], dir = V.norm(V.sub(b, a));
      const e1 = V.norm(V.cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = V.cross(dir, e1), ring = [];
      for (let j = 0; j <= sides; j++) {
        const t = j / sides * TAU, nn = V.add(V.mul(e1, Math.cos(t)), V.mul(e2, Math.sin(t)));
        ring.push({ p: V.add(pts[k], V.mul(nn, rads[k])), n: nn });
      }
      if (prev) {
        const col = colFn(k);
        for (let j = 0; j < sides; j++) {
          const q = [prev[j], prev[j + 1], ring[j + 1], prev[j], ring[j + 1], ring[j]];
          for (let e = 0; e < 6; e++) this.vert(q[e].p, q[e].n, col, -1, -2);
        }
      }
      prev = ring;
    }
  };
  // three.js の形をそのまま足す（模様なし）。tf(p, n): 位置と法線を変える関数
  TB.prototype.mesh = function (geo, colFn, flag, tf) {
    const g = geo.index ? geo.toNonIndexed() : geo, P = g.attributes.position, Nn = g.attributes.normal;
    for (let k = 0; k < P.count; k++) {
      const p0 = [P.getX(k), P.getY(k), P.getZ(k)], n0 = [Nn.getX(k), Nn.getY(k), Nn.getZ(k)];
      const r = tf ? tf(p0, n0) : { p: p0, n: n0 };
      this.vert(r.p, r.n, colFn(r.p), -1, flag);
    }
  };
  // 4つの角を指定した葉の板。uvs はその模様の中での位置(0〜1)、q は模様の番号。nf(p): 光の当たり方を決める法線, cf(p): 明るさ
  TB.prototype.quad = function (pts, uvs, q, nf, cf) {
    const A = ATLAS[q], self = this;
    [0, 1, 2, 0, 2, 3].forEach(function (k) {
      const p = pts[k], u = uvs[k];
      self.vert(p, nf(p), cf(p), A[0] + 0.5 * (0.01 + 0.98 * u[0]), A[1] + 0.5 * (0.01 + 0.98 * u[1]));
    });
  };
  // 中心 c、向き nrm、一辺 size の正方形の葉の板（板の中での回転はでたらめ）
  TB.prototype.card = function (c, nrm, size, q, nf, cf, rnd) {
    let t1 = V.cross(nrm, [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
    if (V.len(t1) < 1e-3) t1 = V.cross(nrm, [1, 0, 0]);
    t1 = V.norm(t1);
    const t2 = V.cross(nrm, t1), h = size / 2;
    const P = function (a, b) { return V.add(c, V.add(V.mul(t1, a * h), V.mul(t2, b * h))); };
    this.quad([P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)], [[0, 0], [1, 0], [1, 1], [0, 1]], q, nf, cf);
  };
  TB.prototype.geo = function () { return geoFrom({ p: this.p, n: this.n, c: this.c, uv: this.uv }); };
  const randDir = function (rnd) {
    for (;;) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], l = V.len(v); if (l > 0.05 && l <= 1) return V.mul(v, 1 / l); }
  };

  // 広葉樹 2種類。cl: 葉の固まり [x, y, z, 半径], trunk: 幹の高さ, c: 樹冠の中心の高さ, rx, ry: 樹冠の半径, lo: 遠く用の固まり
  const BARK = [0.34, 0.27, 0.21];
  const BROAD = {
    broad: { seed: 11, trunk: 3.6, c: 5.4, rx: 3.3, ry: 2.8,
             cl: [[0, 5.3, 0, 2.7], [1.5, 4.5, 0.6, 1.9], [-1.3, 4.7, -0.8, 2.0], [0.2, 6.9, 0.3, 1.7]],
             lo: [[0, 5.2, 0, 3.1], [0.2, 6.6, 0.2, 2.1]] },
    broad2: { seed: 23, trunk: 4.4, c: 6.3, rx: 3.0, ry: 3.3,       // 縦長（ケヤキのような形）
              cl: [[0, 6.5, 0, 2.4], [1.3, 5.4, 0.5, 1.9], [-1.2, 5.6, -0.6, 1.9], [0.2, 8.2, 0.1, 1.7], [0.4, 4.9, -1.3, 1.6], [-0.5, 5.1, 1.4, 1.6]],
              lo: [[0, 5.9, 0, 2.9], [0.1, 7.8, 0.1, 2.2]] },
  };
  function broadleafGeo(sp, lo) {
    const b = new TB(), rnd = COL.rng(sp.seed), C = [0, sp.c, 0];
    const barkCol = function () { const s = 0.9 + 0.2 * rnd(); return [BARK[0] * s, BARK[1] * s, BARK[2] * s]; };
    b.tube([[0, -0.3, 0], [0.04, 0.5, 0], [0.10, sp.trunk * 0.55, 0.04], [0.14, sp.trunk, 0.06]], [0.42, 0.25, 0.21, 0.17], lo ? 4 : 6, barkCol);
    if (lo) {
      sp.lo.forEach(function (q, bi) {
        b.mesh(new THREE.IcosahedronGeometry(1, 0), function (p) {
          const s = 0.75 + 0.45 * Math.min(1, Math.max(0, (p[1] - sp.c + sp.ry) / (2 * sp.ry)));
          return [0.17 * s, 0.34 * s, 0.11 * s];
        }, -1, function (p) {
          const rr = q[3] * (0.85 + 0.3 * COL.noise2(p[0] * 2.1 + p[1] * 3.3 + bi * 7, p[2] * 2.1 - p[1] * 1.7, 9));
          return { p: [q[0] + p[0] * rr, q[1] + p[1] * rr * 0.85, q[2] + p[2] * rr], n: V.norm(p) };
        });
      });
      return b.geo();
    }
    // 枝: 幹の上から葉の固まりへ
    sp.cl.forEach(function (q) {
      const s0 = [0.1, sp.trunk * (0.8 + 0.2 * rnd()), 0.05], e = [q[0] * 0.8, q[1] - q[3] * 0.25, q[2] * 0.8];
      b.tube([s0, V.add(V.lerp(s0, e, 0.5), [0, 0.3, 0]), e], [0.13, 0.08, 0.04], 4, barkCol);
    });
    // 中の濃い葉（板のすき間から見える）
    sp.cl.forEach(function (q) {
      if (q[3] < 1.75) return;
      b.mesh(new THREE.IcosahedronGeometry(1, 1), function () { return [0.13, 0.25, 0.09]; }, -1, function (p) {
        const rr = q[3] * 0.45;
        return { p: [q[0] + p[0] * rr, q[1] + p[1] * rr * 0.85, q[2] + p[2] * rr], n: V.norm(p) };
      });
    });
    // 葉の板: 光の当たり方は樹冠全体の丸みに合わせ、外側ほど明るく、下側は暗く
    const cf = function (p) {
      const rel = Math.hypot((p[0] - C[0]) / sp.rx, (p[1] - C[1]) / sp.ry, (p[2] - C[2]) / sp.rx);
      const bot = Math.min(1, Math.max(0, (p[1] - (C[1] - sp.ry)) / (2 * sp.ry)));
      const a = (0.55 + 0.5 * Math.min(1.1, rel)) * (0.82 + 0.25 * bot);
      return [a, a, a];
    };
    sp.cl.forEach(function (q) {
      const nf = function (p) {
        const t = V.norm([(p[0] - C[0]) / (sp.rx * sp.rx), (p[1] - C[1]) / (sp.ry * sp.ry), (p[2] - C[2]) / (sp.rx * sp.rx)]);
        return V.norm(V.add(V.mul(t, 0.7), V.mul(V.norm(V.sub(p, [q[0], q[1], q[2]])), 0.3)));
      };
      const n = Math.round(11 * Math.pow(q[3] / 2.2, 2));
      for (let k = 0; k < n; k++) {
        let d = randDir(rnd);
        d = V.norm([d[0], d[1] * 0.8 + 0.25, d[2]]);
        const pos = [q[0] + d[0] * q[3] * (0.5 + 0.45 * rnd()), q[1] + d[1] * q[3] * 0.85 * (0.5 + 0.45 * rnd()), q[2] + d[2] * q[3] * (0.5 + 0.45 * rnd())];
        b.card(pos, V.norm(V.add(V.mul(d, 0.5), V.mul(randDir(rnd), 0.5))), q[3] * (0.8 + 0.35 * rnd()), rnd() < 0.5 ? 0 : 1, nf, cf, rnd);
      }
    });
    return b.geo();
  }
  // 針葉樹: 細い幹、暗い円すいの芯、下向きにしなる枝の板を段々に（高さ 約9m）
  function coniferGeo(lo) {
    const b = new TB(), rnd = COL.rng(77), UP = [0, 1, 0];
    b.tube([[0, -0.3, 0], [0, 4.5, 0], [0, 9.2, 0]], [0.26, 0.15, 0.04], lo ? 4 : 6, function () { return [0.30, 0.22, 0.16]; });
    if (lo) {
      b.mesh(new THREE.CylinderGeometry(0, 2.3, 7.6, 6, 1, true), function (p) { const s = 0.75 + 0.4 * (p[1] - 1.2) / 7.6; return [0.08 * s, 0.22 * s, 0.11 * s]; }, -1,
        function (p, n) { return { p: [p[0], p[1] + 5.0, p[2]], n: n }; });
      return b.geo();
    }
    b.mesh(new THREE.CylinderGeometry(0, 1.45, 6.8, 8, 1, true), function () { return [0.05, 0.13, 0.07]; }, -1,
      function (p, n) { return { p: [p[0], p[1] + 4.9, p[2]], n: n }; });
    for (let y = 1.3, tier = 0; y < 8.7; y += 0.6, tier++) {
      const t = (y - 1.2) / 7.6, Rr = 2.4 * Math.pow(1 - t, 0.85) + 0.35, nC = Rr > 1.2 ? 7 : 5;
      for (let k = 0; k < nC; k++) {
        const a = k / nC * TAU + tier * 2.4 + rnd() * 0.5, h = [Math.cos(a), 0, Math.sin(a)];
        const droop = 0.30 + 0.30 * rnd(), dir = V.add(V.mul(h, Math.cos(droop)), V.mul(UP, -Math.sin(droop)));
        const roll = (rnd() - 0.5) * 1.1, side = V.add(V.mul([-h[2], 0, h[0]], Math.cos(roll)), V.mul(UP, Math.sin(roll)));
        const base = V.add([0, y, 0], V.mul(h, 0.12)), tip = V.add(base, V.mul(dir, Rr * 1.08)), w = Rr * 0.9 + 0.35;
        const nn = V.norm(V.add(h, V.mul(UP, 0.8)));
        b.quad([V.sub(base, V.mul(side, w / 2)), V.add(base, V.mul(side, w / 2)), V.add(tip, V.mul(side, w / 2)), V.sub(tip, V.mul(side, w / 2))],
               [[0, 0], [0, 1], [1, 1], [1, 0]], 2, function () { return nn; },
               function (p) { const s = (0.55 + 0.45 * t) * (0.75 + 0.4 * Math.min(1, Math.hypot(p[0], p[2]) / Rr)); return [s, s, s]; });
      }
    }
    return b.geo();
  }
  // ヤシ: しなった幹、実、小葉の模様を貼った葉（高さ 約8m）
  function palmGeo(lo) {
    const b = new TB(), SEG = lo ? 3 : 7, pts = [], rads = [], UP = [0, 1, 0];
    for (let k = 0; k <= SEG; k++) { const t = k / SEG; pts.push([1.0 * t * t, 7.2 * t - 0.2, 0]); rads.push(0.25 - 0.10 * t); }
    b.tube(pts, rads, lo ? 4 : 6, function (k) { return k % 2 ? [0.47, 0.40, 0.30] : [0.40, 0.33, 0.24]; });
    const top = [1.0, 7.1, 0];
    if (!lo) for (let k = 0; k < 4; k++) {
      const a = k / 4 * TAU;
      b.mesh(new THREE.IcosahedronGeometry(0.17, 0), function () { return [0.30, 0.24, 0.10]; }, -1, function (p) {
        return { p: [top[0] + Math.cos(a) * 0.22 + p[0], top[1] - 0.25 + p[1], top[2] + Math.sin(a) * 0.22 + p[2]], n: V.norm(p) };
      });
    }
    const frond = function (az, len, rise, droop) {
      const h = [Math.cos(az), 0, Math.sin(az)], side = [-h[2], 0, h[0]], N = lo ? 2 : 6, W = 2.3, fold = lo ? 0 : 0.28, row = [];
      for (let j = 0; j <= N; j++) {
        const t = j / N, c = V.add(top, V.add(V.mul(h, len * t), V.mul(UP, rise * t - droop * t * t)));
        // 小葉は軸から少し垂れ下がる（へ の字の断面）
        row.push([V.add(V.sub(c, V.mul(side, W / 2)), V.mul(UP, -fold)), c, V.add(V.add(c, V.mul(side, W / 2)), V.mul(UP, -fold))]);
      }
      const nn = V.norm(V.add(UP, V.mul(h, 0.35))), nf = function () { return nn; };
      for (let j = 0; j < N; j++) {
        const t0 = j / N, t1 = (j + 1) / N, s = 0.75 + 0.35 * (t0 + t1) / 2, cf = function () { return [s, s, s]; };
        b.quad([row[j][0], row[j][1], row[j + 1][1], row[j + 1][0]], [[t0, 0], [t0, 0.5], [t1, 0.5], [t1, 0]], 3, nf, cf);
        b.quad([row[j][1], row[j][2], row[j + 1][2], row[j + 1][1]], [[t0, 0.5], [t0, 1], [t1, 1], [t1, 0.5]], 3, nf, cf);
      }
    };
    const n1 = lo ? 7 : 11, n2 = lo ? 0 : 6;
    for (let k = 0; k < n1; k++) frond(k / n1 * TAU + 0.2 * Math.sin(k * 5.1), 3.9, 0.9, 3.2);
    for (let k = 0; k < n2; k++) frond(k / n2 * TAU + 0.5, 2.9, 2.3, 1.6);
    return b.geo();
  }
  // 低木（高さ 約1.4m）
  function shrubGeo(lo) {
    const b = new TB(), rnd = COL.rng(5);
    b.mesh(new THREE.IcosahedronGeometry(1, 0), function (p) { const s = 0.7 + 0.5 * Math.min(1, p[1] / 1.4); return [0.12 * s, 0.25 * s, 0.09 * s]; }, -1,
      function (p) { return { p: [p[0] * 0.85, 0.75 + p[1] * 0.62, p[2] * 0.85], n: V.norm(p) }; });
    if (lo) return b.geo();
    const nf = function (p) { return V.norm([p[0] / 0.8, (p[1] - 0.75) / 0.6, p[2] / 0.8]); };
    const cf = function (p) { const a = 0.6 + 0.45 * Math.min(1, Math.max(0, p[1] / 1.4)); return [a, a, a]; };
    for (let k = 0; k < 10; k++) {
      let d = randDir(rnd);
      d = V.norm([d[0], Math.abs(d[1]) * 0.7 + 0.15, d[2]]);
      b.card([d[0] * 0.75, 0.75 + d[1] * 0.55, d[2] * 0.75], V.norm(V.add(d, V.mul(randDir(rnd), 0.6))), 1.1 + 0.4 * rnd(), rnd() < 0.5 ? 0 : 1, nf, cf, rnd);
    }
    return b.geo();
  }
  // 刈り込んだ生垣（大きさは置くときに決める）
  function hedgeGeo() {
    const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
    const n = g.attributes.position.count, c = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { c[k * 3] = 0.15; c[k * 3 + 1] = 0.30; c[k * 3 + 2] = 0.11; uv[k * 2] = -1; uv[k * 2 + 1] = -1; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }
  // ---- サンゴ礁（色は置くときに付ける。頂点の明るさは根元を暗く、先を白っぽく） ----
  //  uv.y の印: -1.25 表面に細かい粒（ポリプ）, -1.35 迷路のような溝（ノウサンゴ）, -3 − w 波で揺れる（w: 揺れの大きさ 0〜1）
  const coralShade = function (y, top) { const s = 0.50 + 0.55 * Math.min(1, Math.max(0, y / top)); return [s, s, s]; };
  const TIP = [1.30, 1.28, 1.18];
  // 管を、印 flag を付けて足す（flagFn(k) で点ごとに変えられる）
  const tubeF = function (b, pts, rads, sides, colFn, flagFn) {
    const n0 = b.uv.length / 2;
    b.tube(pts, rads, sides, colFn);
    // tube は 区間ごとに sides × 6 頂点を出す。区間 k（1〜）の頂点は、手前側と先側が混ざるので、高さの近い方の印を付ける
    const per = sides * 6;
    for (let v = n0; v < b.uv.length / 2; v++) {
      const seg = Math.floor((v - n0) / per), e = (v - n0) % 6, far = (e === 2 || e === 4 || e === 5) ? 1 : 0;
      b.uv[v * 2 + 1] = flagFn(seg + far);
    }
  };
  const POLYP = function () { return -1.25; };
  function coralBrain() {           // 丸いノウサンゴ（半径 1m、高さ 0.7m）。こぶがいくつか寄り集まった形
    const b = new TB();
    [[0, 0, 0, 1], [0.55, -0.05, 0.35, 0.55], [-0.5, -0.08, -0.4, 0.5]].forEach(function (L, li) {
      b.mesh(new THREE.IcosahedronGeometry(1, li === 0 ? 2 : 1), function (p) { return coralShade(p[1] + 0.2, 0.8); }, -1.35, function (p) {
        const k = L[3] * (0.88 + 0.24 * COL.noise2(p[0] * 3 + p[2] * 2 + li * 9, p[1] * 3, 11));
        return { p: [L[0] + p[0] * k, Math.max(-0.2, L[1] + p[1] * 0.72 * k), L[2] + p[2] * k], n: V.norm([p[0], p[1] * 1.4, p[2]]) };
      });
    });
    return b.geo();
  }
  function coralBranch() {          // 枝サンゴ（高さ 約1.2m）: 3段に枝分かれして、先は白っぽい
    const b = new TB(), rnd = COL.rng(17);
    const grow = function (base, dir, len, rad, lvl) {
      const end = V.add(base, V.mul(dir, len)), mid = V.add(V.lerp(base, end, 0.5), V.mul(randDir(rnd), len * 0.06));
      const tip = lvl === 2;
      if (lvl === 0) tubeF(b, [base, mid, end], [rad, rad * 0.82, rad * 0.66], 5, function (j) { return coralShade(end[1] * (0.4 + 0.3 * j), 1.1); }, POLYP);
      else tubeF(b, [base, end], [rad, tip ? rad * 0.42 : rad * 0.66], 4, function () { return tip ? TIP : coralShade(end[1] * 0.8, 1.1); }, POLYP);
      if (tip) return;
      const n = 2;
      for (let k = 0; k < n; k++) {
        const side = V.norm(V.cross(dir, randDir(rnd)));
        const d2 = V.norm(V.add(V.add(V.mul(dir, 0.75), V.mul(side, 0.65)), [0, 0.35, 0]));
        grow(V.lerp(mid, end, 0.3 + 0.7 * k / Math.max(1, n - 1)), d2, len * (0.62 + 0.2 * rnd()), rad * 0.66, lvl + 1);
      }
    };
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * TAU + rnd() * 0.6, tilt = 0.25 + 0.5 * rnd();
      grow([Math.cos(a) * 0.06, -0.1, Math.sin(a) * 0.06], [Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)], 0.50 + 0.15 * rnd(), 0.085, 0);
    }
    return b.geo();
  }
  function coralTable() {           // テーブルサンゴ（直径 2m）: ふちが波打つ薄い棚が、ずれて何枚か重なる
    const b = new TB();
    [[0, 0.55, 0, 1.0], [0.45, 0.34, 0.30, 0.62], [-0.50, 0.24, -0.20, 0.50]].forEach(function (T, ti) {
      tubeF(b, [[T[0] * 0.5, -0.1, T[2] * 0.5], [T[0], T[1] - 0.04, T[2]]], [0.13 * T[3] + 0.03, 0.10 * T[3] + 0.03], 5, function () { return coralShade(0.25, 1); }, POLYP);
      b.mesh(new THREE.CylinderGeometry(1, 0.80, 0.07, 14, 1, false), function (p) {
        const rr = Math.hypot(p[0] - T[0], p[2] - T[2]) / T[3];
        return rr > 0.9 ? TIP : coralShade(0.45 + 0.5 * rr, 1);
      }, -1.25, function (p, n) {
        const a = Math.atan2(p[2], p[0]), rr = Math.hypot(p[0], p[2]);
        const k = T[3] * (1 + 0.13 * Math.sin(a * 5 + ti * 2) * rr + 0.07 * Math.sin(a * 11 + ti));
        return { p: [T[0] + p[0] * k, T[1] + p[1] + 0.07 * rr * rr * T[3] + 0.03 * Math.sin(a * 4 + ti) * rr, T[2] + p[2] * k], n: n };
      });
    });
    return b.geo();
  }
  function coralTube() {            // 筒の形の海綿（高さ 0.5〜1.1m）: 口が少し開き、中は暗い
    const b = new TB();
    [[0, 0, 1.1, 0.14], [0.30, 0.1, 0.75, 0.12], [-0.22, 0.24, 0.6, 0.11], [0.05, -0.29, 0.88, 0.13], [-0.30, -0.12, 0.48, 0.10]].forEach(function (t) {
      const lean = [t[0] * 0.35, 0, t[1] * 0.35];
      b.mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 2, true), function (p) { return p[1] > t[2] - 0.14 ? TIP : coralShade(p[1], t[2]); }, -1.25, function (p, n) {
        const h = p[1] + 0.5, rr = t[3] * (0.72 + 0.20 * Math.sin(h * 2.6) + 0.22 * h * h * h);
        return { p: [t[0] + lean[0] * h + p[0] * rr, h * t[2] - 0.1, t[1] + lean[2] * h + p[2] * rr], n: n };
      });
      b.mesh(new THREE.CircleGeometry(1, 8), function () { return [0.10, 0.10, 0.10]; }, -1, function (p) {
        return { p: [t[0] + lean[0] * 0.9 + p[0] * t[3] * 0.95, t[2] * 0.88 - 0.1, t[1] + lean[2] * 0.9 - p[1] * t[3] * 0.95], n: [0, 1, 0] };
      });
    });
    return b.geo();
  }
  function coralFan() {             // ウミウチワ（高さ 約1.2m）: 1枚の面の中で細かく枝分かれした網。波で揺れる
    const b = new TB(), rnd = COL.rng(23);
    const sway = function (y) { return -3 - Math.min(1, Math.max(0, y / 1.2)); };
    const grow = function (base, ang, len, rad, lvl) {
      const end = [base[0] + Math.sin(ang) * len, base[1] + Math.cos(ang) * len, (rnd() - 0.5) * 0.03];
      const ys = [base[1], end[1]];
      tubeF(b, [base, end], [rad, rad * 0.7], 3, function () { return lvl >= 2 ? TIP : coralShade(end[1], 1.1); }, function (k) { return sway(ys[Math.min(1, k)]); });
      if (lvl >= 2) return;
      const n = lvl === 0 ? 3 : 2;
      for (let k = 0; k < n; k++) grow(V.lerp(base, end, 0.45 + 0.55 * (k + 1) / n), ang + (k % 2 ? 1 : -1) * (0.35 + 0.35 * rnd()) + (rnd() - 0.5) * 0.2, len * 0.66, rad * 0.72, lvl + 1);
    };
    tubeF(b, [[0, -0.1, 0], [0, 0.12, 0]], [0.06, 0.05], 4, function () { return coralShade(0.2, 1); }, POLYP);
    for (let k = 0; k < 5; k++) grow([0, 0.10, 0], (k - 2) * 0.42 + (rnd() - 0.5) * 0.15, 0.50 + 0.10 * rnd(), 0.034, 0);
    return b.geo();
  }
  function anemoneGeo() {           // イソギンチャク（直径 0.9m）: たくさんの触手が波で揺れる
    const b = new TB(), rnd = COL.rng(29);
    tubeF(b, [[0, -0.1, 0], [0, 0.10, 0], [0, 0.20, 0]], [0.30, 0.34, 0.27], 9, function () { return coralShade(0.3, 1); }, POLYP);
    for (let k = 0; k < 18; k++) {
      const a = rnd() * TAU, rr = 0.26 * Math.sqrt(rnd()), base = [Math.cos(a) * rr, 0.19, Math.sin(a) * rr];
      const out = 0.10 + 0.9 * rr, L = 0.30 + 0.22 * rnd();
      const mid = V.add(base, [Math.cos(a) * out * 0.35, L * 0.55, Math.sin(a) * out * 0.35]), tip = V.add(base, [Math.cos(a) * out, L, Math.sin(a) * out]);
      tubeF(b, [base, mid, tip], [0.040, 0.030, 0.02], 3, function (j) { return j === 2 ? TIP : coralShade(0.9, 1); }, function (j) { return -3 - [0, 0.45, 1][j]; });
    }
    return b.geo();
  }
  function rockGeo() {              // 岩（半径 1m、平たい）
    const b = new TB();
    b.mesh(new THREE.IcosahedronGeometry(1, 1), function (p) { return coralShade(p[1] + 0.3, 0.8); }, -1, function (p) {
      const k = 0.72 + 0.34 * COL.noise2(p[0] * 2.2, p[2] * 2.2 + p[1], 23) + 0.20 * COL.noise2(p[0] * 6 + p[1] * 3, p[2] * 6, 37);
      return { p: [p[0] * k, p[1] * 0.55 * k, p[2] * k], n: V.norm([p[0], p[1] * 1.6, p[2]]) };
    });
    return b.geo();
  }
  function coralSoft() {            // やわらかいサンゴ（高さ 約1m）: 太い茎の先に、ふさふさした房。波で揺れる
    const b = new TB(), rnd = COL.rng(61);
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * TAU + rnd(), tilt = k === 0 ? 0.05 : 0.35 + 0.3 * rnd(), L = k === 0 ? 0.75 : 0.45 + 0.25 * rnd();
      const d = [Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)], end = V.add([0, -0.1, 0], V.mul(d, L + 0.1));
      tubeF(b, [[0, -0.1, 0], V.mul(d, L * 0.5), end], [0.10, 0.075, 0.06], 5, function () { return coralShade(0.5, 1); }, function (j) { return -3 - [0, 0.3, 0.7][j]; });
      for (let q = 0; q < 4; q++) {
        const o = V.add(end, V.mul(randDir(rnd), 0.12)), rr = 0.12 + 0.06 * rnd();
        b.mesh(new THREE.IcosahedronGeometry(1, 0), function (p) { return p[1] > o[1] ? TIP : [1.05, 1.05, 1.05]; }, -3 - Math.min(1, 0.6 + o[1] * 0.4), function (p) {
          return { p: [o[0] + p[0] * rr, o[1] + p[1] * rr, o[2] + p[2] * rr], n: V.norm(p) };
        });
      }
    }
    return b.geo();
  }
  function coralLeaf() {            // 葉の形のサンゴ（直径 1.6m）: 波打つ薄い板が、ばらの花のように渦を巻く
    const b = new TB(), rnd = COL.rng(71), N = 7;
    for (let k = 0; k < 9; k++) {
      const a0 = k * 2.4, r0 = 0.10 + 0.085 * k, arc = 1.5 + 0.5 * rnd(), H = 0.34 + 0.05 * k + 0.1 * rnd(), flare = 0.25 + 0.05 * k, row = [];
      for (let j = 0; j <= N; j++) {
        const a = a0 + arc * (j / N - 0.5), edge = Math.sin(j / N * Math.PI), hh = H * (0.55 + 0.45 * edge) + 0.035 * Math.sin(j * 2.3 + k);
        const c = Math.cos(a), sn = Math.sin(a);
        row.push([[c * r0, -0.08, sn * r0], [c * (r0 + flare * 0.5), hh * 0.6, sn * (r0 + flare * 0.5)], [c * (r0 + flare), hh, sn * (r0 + flare)], [c, 0.5, sn]]);
      }
      for (let j = 0; j < N; j++) for (let e = 0; e < 2; e++) {
        const A = row[j], Bq = row[j + 1];
        [[A[e], Bq[e], Bq[e + 1]], [A[e], Bq[e + 1], A[e + 1]]].forEach(function (t) {
          t.forEach(function (q) { b.vert(q, V.norm([q[0] * 0.5, 0.8, q[2] * 0.5]), q[1] > H * 0.5 ? TIP : coralShade(q[1] + 0.1, 0.5), -1, -1.25); });
        });
      }
    }
    return b.geo();
  }
  function clamGeo() {              // 大きなシャコガイ（幅 1m）: 波打つ2枚の殻と、その間の青い外とう膜
    const b = new TB(), NU = 14, NV = 5;
    const shell = function (u, v, sd) {          // u: 殻の長さ方向 0〜1, v: ちょうつがい 0 → ふち 1
      const x = (u - 0.5) * 1.0, open = 0.16 + 0.34 * v, wave = 0.06 * Math.sin(u * Math.PI * 5) * v;
      const rr = 0.42 * Math.sin(Math.PI * (0.08 + 0.84 * u)) * (0.35 + 0.65 * Math.sin(v * Math.PI * 0.5));
      return [x, 0.02 + rr * Math.cos(open) + wave + 0.08, sd * (rr * Math.sin(open) + 0.03 * v)];
    };
    for (let sd = -1; sd <= 1; sd += 2) for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const q = [shell(i / NU, j / NV, sd), shell((i + 1) / NU, j / NV, sd), shell((i + 1) / NU, (j + 1) / NV, sd), shell(i / NU, (j + 1) / NV, sd)];
      [0, 1, 2, 0, 2, 3].forEach(function (k) {
        const sh = 0.55 + 0.25 * Math.abs(Math.sin((i + (k === 1 || k === 2 ? 1 : 0)) / NU * Math.PI * 5));
        b.vert(q[k], V.norm([0, 0.4, sd]), [sh, sh * 0.97, sh * 0.9], -1, -1);
      });
    }
    // 外とう膜（殻のふちの内側。あざやかな青緑）
    for (let i = 0; i < NU; i++) {
      const m = function (u, sd) { const pe = shell(u, 1, sd); return [pe[0], pe[1] - 0.03, pe[2] * 0.82]; };
      const q = [m(i / NU, -1), m((i + 1) / NU, -1), m((i + 1) / NU, 1), m(i / NU, 1)];
      [0, 1, 2, 0, 2, 3].forEach(function (k) {
        const t = Math.abs(q[k][2]) * 4;
        b.vert(q[k], [0, 1, 0], [0.10 + 0.25 * t, 0.45 + 0.5 * t, 1.25 - 0.3 * t], -1, -1.25);
      });
    }
    return b.geo();
  }
  function seaweedGeo() {           // 海草（高さ 約1.3m）: 細長い葉の束。波で大きく揺れる
    const b = new TB(), rnd = COL.rng(83), NSEG = 5;
    for (let k = 0; k < 9; k++) {
      const a = rnd() * TAU, rr = 0.22 * Math.sqrt(rnd()), H = 0.7 + 0.7 * rnd(), w = 0.045 + 0.03 * rnd(), lean = 0.15 + 0.25 * rnd();
      const c = Math.cos(a), sn = Math.sin(a), row = [];
      for (let j = 0; j <= NSEG; j++) {
        const t = j / NSEG, cx = c * (rr + lean * t * t * H), cz = sn * (rr + lean * t * t * H), ww = w * (1 - 0.75 * t * t);
        row.push([[cx - sn * ww, H * t - 0.05, cz + c * ww], [cx + sn * ww, H * t - 0.05, cz - c * ww], t]);
      }
      for (let j = 0; j < NSEG; j++) {
        const A = row[j], Bq = row[j + 1];
        [[A[0], A[2]], [A[1], A[2]], [Bq[1], Bq[2]], [A[0], A[2]], [Bq[1], Bq[2]], [Bq[0], Bq[2]]].forEach(function (e) {
          const sh = 0.55 + 0.6 * e[1];
          b.vert(e[0], V.norm([c, 0.5, sn]), [sh, sh, sh], -1, -3 - e[1] * e[1]);
        });
      }
    }
    return b.geo();
  }
  // 遠く用: 何も描かない（サンゴは近くだけ）
  function emptyGeo() { return geoFrom({ p: [], n: [], c: [], uv: [] }); }

  // 切妻屋根: 底 1×1、高さ 1 の三角柱（棟は X 方向）
  function gableGeo() {
    const buf = { p: [], n: [], c: [] };
    const A = [-0.5, 0, -0.5], Bq = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5], E = [-0.5, 1, 0], F = [0.5, 1, 0];
    const tri = function (a, b, c) {
      const nn = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
      [a, b, c].forEach(function (q) { buf.p.push(q[0], q[1], q[2]); buf.n.push(nn[0], nn[1], nn[2]); buf.c.push(1, 1, 1); });
    };
    tri(A, E, F); tri(A, F, Bq); tri(C, F, E); tri(C, E, D); tri(D, E, A); tri(Bq, F, C);
    return geoFrom(buf);
  }


  // ---- 自動車（未来の電気自動車）: 流線形の車体・ガラスの屋根・覆いのかかったタイヤ・光の帯（前が +Z、地面が y = 0、単位は m） ----
  //  車体は、前後に並べた断面（片側 10 点）をつないで作る。uv.x に部品の番号を入れる（色と艶はシェーダーで決める）
  //   0 塗装（色は置くときに決める）, 1 ガラス, 2 黒い樹脂・タイヤ, 3 前の光の帯, 4 後ろの光の帯, 5 ホイール, 6 飾りの光の線
  //  uv.y にはドアの継ぎ目の位置の倍率を入れる
  const CAR_SPECS = {
    // keys: [z, 半分の幅, 床の高さ, 窓の下の高さ, 屋根の高さ]
    //  cover: タイヤの覆い（車軸より上に何 m まで開けるか。前, 後ろ）  roofPaint: 屋根を塗装にする z の範囲（無ければ屋根もガラス）
    // carA: 低い流線形のクーペ。前から後ろまでひと続きのガラスの屋根
    carA: { keys: [[-2.30, 0.70, 0.50, 0.78, 0.82], [-2.20, 0.84, 0.36, 0.87, 0.93], [-1.85, 0.90, 0.25, 0.91, 1.04], [-1.20, 0.92, 0.20, 0.91, 1.21],
                   [-0.50, 0.92, 0.20, 0.89, 1.31], [0.20, 0.92, 0.20, 0.86, 1.29], [0.90, 0.91, 0.20, 0.81, 1.10], [1.50, 0.90, 0.22, 0.74, 0.84],
                   [1.95, 0.86, 0.26, 0.66, 0.69], [2.22, 0.78, 0.31, 0.57, 0.585], [2.32, 0.66, 0.37, 0.52, 0.53]],
            wheelR: 0.34, arch: 0.42, cover: [0.17, 0.03], wz: [1.42, -1.36], head: 0.455, tail: 0.70, tallMin: 0.10, roofPaint: null, seam: 1 },
    // carB: 箱型の自動運転の車。前後が同じ形で、大きな窓
    carB: { keys: [[-2.10, 0.74, 0.50, 0.82, 1.02], [-2.02, 0.88, 0.34, 0.86, 1.46], [-1.74, 0.94, 0.26, 0.85, 1.71], [-0.60, 0.95, 0.24, 0.83, 1.78],
                   [0.60, 0.95, 0.24, 0.83, 1.78], [1.74, 0.94, 0.26, 0.85, 1.71], [2.02, 0.88, 0.34, 0.86, 1.46], [2.10, 0.74, 0.50, 0.82, 1.02]],
            wheelR: 0.36, arch: 0.44, cover: [0.10, 0.10], wz: [1.30, -1.30], head: 0.70, tail: 0.70, tallMin: 0.15, roofPaint: [-1.15, 1.15], seam: 1 },
    // carC: 小さな1〜2人乗り。丸いガラスの屋根
    carC: { keys: [[-1.50, 0.56, 0.46, 0.74, 0.80], [-1.41, 0.68, 0.32, 0.80, 1.06], [-1.00, 0.72, 0.24, 0.80, 1.41], [-0.20, 0.72, 0.22, 0.78, 1.52],
                   [0.50, 0.72, 0.22, 0.74, 1.42], [1.05, 0.71, 0.24, 0.68, 1.02], [1.38, 0.66, 0.30, 0.60, 0.70], [1.52, 0.54, 0.40, 0.53, 0.55]],
            wheelR: 0.30, arch: 0.37, cover: [0.12, 0.04], wz: [0.92, -0.92], head: 0.475, tail: 0.66, tallMin: 0.12, roofPaint: null, seam: 0.55 },
  };
  function carGeo(spec) {
    const buf = { p: [], n: [], c: [], uv: [] };
    const out = function (a, na, part) { buf.p.push(a[0], a[1], a[2]); buf.n.push(na[0], na[1], na[2]); buf.c.push(1, 1, 1); buf.uv.push(part, spec.seam); };
    const K = spec.keys, zMin = K[0][0], zMax = K[K.length - 1][0], axle = spec.wheelR;
    // 断面を取る位置: 形の変わり目と、タイヤのまわり（車輪の入るくぼみを切る）。屋根がなめらかに曲がるよう、間も細かく割る
    let zs = K.map(function (k) { return k[0]; });
    for (let k = 0; k + 1 < K.length; k++) { const n = Math.ceil((K[k + 1][0] - K[k][0]) / 0.24); for (let q = 1; q < n; q++) zs.push(K[k][0] + (K[k + 1][0] - K[k][0]) * q / n); }
    spec.wz.forEach(function (zc) {
      [-1, -0.85, -0.6, -0.3, 0, 0.3, 0.6, 0.85, 1].forEach(function (t) { zs.push(zc + t * spec.arch); });
      zs.push(zc - spec.arch - 0.03, zc + spec.arch + 0.03);
    });
    zs = zs.filter(function (z) { return z >= zMin && z <= zMax; }).sort(function (a, b) { return a - b; })
           .filter(function (z, k, l) { return k === 0 || z - l[k - 1] > 0.012; });
    if (zs[zs.length - 1] < zMax - 1e-6) zs.push(zMax);
    // 断面の間は、角が立たないよう なめらかな曲線（キャットムル・ロム）でつなぐ
    const L = function (z, j) {
      let k = 0;
      while (k < K.length - 2 && K[k + 1][0] < z) k++;
      const f = Math.min(1, Math.max(0, (z - K[k][0]) / (K[k + 1][0] - K[k][0])));
      const p1 = K[k][j], p2 = K[k + 1][j], p0 = K[Math.max(0, k - 1)][j], p3 = K[Math.min(K.length - 1, k + 2)][j];
      const v = 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
      return Math.min(Math.max(p1, p2), Math.max(Math.min(p1, p2), v));
    };
    const ring = function (z) {
      const w = L(z, 1), y0 = L(z, 2), belt = L(z, 3), roof = Math.max(L(z, 4), belt + 0.01);
      let a = 0;
      spec.wz.forEach(function (zc, wi) {
        if (Math.abs(z - zc) <= spec.arch + 1e-6) a = axle + Math.min(spec.cover[wi], Math.sqrt(Math.max(0, spec.arch * spec.arch - (z - zc) * (z - zc))));
      });
      const wi = a > 0 ? w - 0.27 : w * 0.90, ys = a > 0 ? Math.max(a, y0 + 0.09) : y0 + 0.09;
      const t = Math.min(1, Math.max(0, (roof - belt) / 0.45)), wg = w * (0.985 - 0.045 * t), wr = w * (0.985 - 0.24 * t);
      return { tall: roof - belt > spec.tallMin, pts: [[0, y0], [wi, y0], [wi, ys], [w, ys], [w + 0.012, (ys + belt) / 2], [w * 0.985, belt], [wg, belt + Math.min(0.015, (roof - belt) * 0.3)],
                                                       [wr, roof - 0.07 * t], [wr * 0.80, roof - 0.012 * t], [0, roof + 0.02 + 0.03 * t]] };
    };
    const rings = zs.map(ring);
    const GROUP = [0, 1, 2, 3, 3, 4, 5, 5, 5];
    // 1回目: 面の向きを集めて、なめらかにつながる面どうしで法線をならす
    const acc = new Map(), quads = [];
    const key = function (k, j, g) { return k * 1000 + j * 10 + g; };
    for (let k = 0; k < zs.length - 1; k++) for (let j = 0; j < 9; j++) {
      const A = rings[k], Bq = rings[k + 1], g = GROUP[j];
      const P = [[A.pts[j][0], A.pts[j][1], zs[k]], [Bq.pts[j][0], Bq.pts[j][1], zs[k + 1]], [Bq.pts[j + 1][0], Bq.pts[j + 1][1], zs[k + 1]], [A.pts[j + 1][0], A.pts[j + 1][1], zs[k]]];
      let nn = V.cross(V.sub(P[2], P[0]), V.sub(P[3], P[1]));
      const cen = V.mul(V.add(V.add(P[0], P[1]), V.add(P[2], P[3])), 0.25);
      let flip = false;
      if (V.dot(nn, V.sub(cen, [0, (A.pts[0][1] + A.pts[9][1] + Bq.pts[0][1] + Bq.pts[9][1]) / 4, cen[2]])) < 0) { nn = V.mul(nn, -1); flip = true; }
      const tall = A.tall && Bq.tall, painted = spec.roofPaint && cen[2] > spec.roofPaint[0] && cen[2] < spec.roofPaint[1];
      const part = j < 3 ? 2 : j < 6 ? 0 : !tall ? 0 : j === 6 ? 1 : (painted ? 0 : 1);
      const ks = [key(k, j, g), key(k + 1, j, g), key(k + 1, j + 1, g), key(k, j + 1, g)];
      if (V.len(nn) > 1e-9) ks.forEach(function (q) { const o = acc.get(q) || [0, 0, 0]; acc.set(q, V.add(o, nn)); });
      quads.push({ P: P, ks: ks, part: part, flip: flip });
    }
    // 2回目: 右半分と、それを左右に写した左半分を出す
    quads.forEach(function (q) {
      const nr = q.ks.map(function (kk) { const o = acc.get(kk); return o && V.len(o) > 1e-9 ? V.norm(o) : [0, 1, 0]; });
      const order = q.flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (let sd = 1; sd >= -1; sd -= 2) {
        const idx = sd > 0 ? order : order.slice().reverse();
        idx.forEach(function (v) { out([q.P[v][0] * sd, q.P[v][1], q.P[v][2]], [nr[v][0] * sd, nr[v][1], nr[v][2]], q.part); });
      }
    });
    // 前後の端をふさぐ
    [[0, -1], [zs.length - 1, 1]].forEach(function (e) {
      const pts = rings[e[0]].pts, z = zs[e[0]], c = [0, (pts[0][1] + pts[9][1]) / 2, z], nz = [0, 0, e[1]];
      for (let j = 0; j < 9; j++) for (let sd = 1; sd >= -1; sd -= 2) {
        const a = [pts[j][0] * sd, pts[j][1], z], b = [pts[j + 1][0] * sd, pts[j + 1][1], z];
        const ccw = (sd > 0) === (e[1] > 0);
        out(c, nz, 0); out(ccw ? a : b, nz, 0); out(ccw ? b : a, nz, 0);
      }
    });
    // 箱（光の帯）
    const box = function (cx, cy, cz, sx, sy, sz, part) {
      const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed(), P = g.attributes.position, N = g.attributes.normal;
      for (let k = 0; k < P.count; k++) out([P.getX(k) + cx, P.getY(k) + cy, P.getZ(k) + cz], [N.getX(k), N.getY(k), N.getZ(k)], part);
    };
    const kf = K[K.length - 1], kr = K[0];
    box(0, spec.head, zMax - 0.025, kf[1] * 1.86, 0.034, 0.09, 3);            // 前: 車幅いっぱいの白い光の帯
    box(0, spec.tail, zMin + 0.025, kr[1] * 1.90, 0.040, 0.09, 4);            // 後ろ: 赤い光の帯
    box(0, kf[2] + 0.035, zMax - 0.10, kf[1] * 1.5, 0.05, 0.24, 2);           // 前の下の黒い空気取り入れ口
    box(0, kr[2] + 0.04, zMin + 0.09, kr[1] * 1.6, 0.07, 0.22, 2);            // 後ろの下の黒い整流板
    // 車体の横の下の、細い光の線（前後のタイヤの間）
    const sz0 = spec.wz[1] + spec.arch + 0.10, sz1 = spec.wz[0] - spec.arch - 0.10, zm = (sz0 + sz1) / 2, rm = ring(zm);
    for (let sd = -1; sd <= 1; sd += 2) box(sd * (rm.pts[3][0] + 0.004), rm.pts[3][1] + 0.07, zm, 0.016, 0.026, sz1 - sz0, 6);
    // タイヤとホイール（薄いタイヤ、平らな円盤のホイール、光る輪）
    const NS = 20, R1 = spec.wheelR, R0 = R1 * 0.80, G0 = R1 * 0.56, G1 = R1 * 0.64;
    spec.wz.forEach(function (zc) {
      for (let sd = -1; sd <= 1; sd += 2) {
        const xo = sd * (ring(zc).pts[3][0] - 0.03), xi = xo - sd * 0.24, xd = xo - sd * 0.018, xg = xo - sd * 0.008;
        const P = function (x, r, a) { return [x, axle + Math.sin(a) * r, zc + Math.cos(a) * r]; };
        // 表向きになる並びで三角形を出す（面の向き want に合わせる）
        const tri = function (A, na, Bv, nb, C, nc, part, want) {
          const fn = V.cross(V.sub(Bv, A), V.sub(C, A));
          if (V.dot(fn, want) >= 0) { out(A, na, part); out(Bv, nb, part); out(C, nc, part); } else { out(A, na, part); out(C, nc, part); out(Bv, nb, part); }
        };
        for (let q = 0; q < NS; q++) {
          const a0 = q / NS * TAU, a1 = (q + 1) / NS * TAU, n0 = [0, Math.sin(a0), Math.cos(a0)], n1 = [0, Math.sin(a1), Math.cos(a1)], nx = [sd, 0, 0];
          const nm = [0, Math.sin((a0 + a1) / 2), Math.cos((a0 + a1) / 2)];
          tri(P(xi, R1, a0), n0, P(xo, R1, a0), n0, P(xo, R1, a1), n1, 2, nm); tri(P(xi, R1, a0), n0, P(xo, R1, a1), n1, P(xi, R1, a1), n1, 2, nm);      // 踏面
          tri(P(xo, R1, a0), nx, P(xo, R0, a0), nx, P(xo, R0, a1), nx, 2, nx); tri(P(xo, R1, a0), nx, P(xo, R0, a1), nx, P(xo, R1, a1), nx, 2, nx);      // 側面
          tri(P(xd, R0, a0), nx, [xd, axle, zc], nx, P(xd, R0, a1), nx, 5, nx);                                                                          // ホイール
          tri(P(xg, G1, a0), nx, P(xg, G0, a0), nx, P(xg, G0, a1), nx, 6, nx); tri(P(xg, G1, a0), nx, P(xg, G0, a1), nx, P(xg, G1, a1), nx, 6, nx);      // 光る輪
        }
      }
    });
    return geoFrom(buf);
  }
  // 遠く用の車: 箱2つ（車体と窓まわり）
  function carGeoLo(spec) {
    const buf = { p: [], n: [], c: [], uv: [] };
    const K = spec.keys, zMin = K[0][0], zMax = K[K.length - 1][0], mid = K[Math.floor(K.length / 2)];
    const box = function (x0, x1, y0, y1, z0, z1, part) {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed(), P = g.attributes.position, N = g.attributes.normal;
      for (let k = 0; k < P.count; k++) {
        buf.p.push(P.getX(k) + (x0 + x1) / 2, P.getY(k) + (y0 + y1) / 2, P.getZ(k) + (z0 + z1) / 2);
        buf.n.push(N.getX(k), N.getY(k), N.getZ(k)); buf.c.push(1, 1, 1); buf.uv.push(part, 0);
      }
    };
    box(-mid[1], mid[1], 0.22, mid[3], zMin, zMax, 0);
    box(-mid[1] * 0.86, mid[1] * 0.86, mid[3], mid[4], zMin + (zMax - zMin) * 0.20, zMin + (zMax - zMin) * 0.66, 1);
    return geoFrom(buf);
  }

  const CORALS = { coralBrain: coralBrain, coralBranch: coralBranch, coralTable: coralTable, coralTube: coralTube, coralFan: coralFan, anemone: anemoneGeo, rock: rockGeo,
                   coralSoft: coralSoft, coralLeaf: coralLeaf, clam: clamGeo, seaweed: seaweedGeo };
  const TREE_KINDS = ['broad', 'broadLo', 'broad2', 'broad2Lo', 'palm', 'palmLo', 'conifer', 'coniferLo', 'shrub', 'shrubLo', 'hedge'];
  function initParts(renderer) {
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const taper = new THREE.BoxGeometry(1, 1, 1); taper.translate(0, 0.5, 0);
    const tp = taper.attributes.position;
    for (let k = 0; k < tp.count; k++) if (tp.getY(k) > 0.5) tp.setXYZ(k, tp.getX(k) * 0.58, 1, tp.getZ(k) * 0.58);
    const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 28, 1, false); cyl.translate(0, 0.5, 0);
    const cone = new THREE.CylinderGeometry(0.0, 0.5, 1, 20, 1, false); cone.translate(0, 0.5, 0);
    const ring = new THREE.TorusGeometry(0.5, 0.014, 6, 48); ring.rotateX(Math.PI / 2);
    const dome = new THREE.SphereGeometry(0.5, 24, 8, 0, TAU, 0, Math.PI / 2);
    UNIT.box = box; UNIT.taper = taper; UNIT.cyl = cyl; UNIT.cone = cone; UNIT.ring = ring; UNIT.dome = dome;
    leafTex = leafAtlas(renderer);
    UNIT.broad = broadleafGeo(BROAD.broad, false); UNIT.broadLo = broadleafGeo(BROAD.broad, true);
    UNIT.broad2 = broadleafGeo(BROAD.broad2, false); UNIT.broad2Lo = broadleafGeo(BROAD.broad2, true);
    UNIT.palm = palmGeo(false); UNIT.palmLo = palmGeo(true);
    UNIT.conifer = coniferGeo(false); UNIT.coniferLo = coniferGeo(true);
    UNIT.shrub = shrubGeo(false); UNIT.shrubLo = shrubGeo(true);
    UNIT.hedge = hedgeGeo();
    const empty = emptyGeo();
    for (const k in CORALS) { UNIT[k] = CORALS[k](); UNIT[k + 'Lo'] = empty; TREE_KINDS.push(k, k + 'Lo'); }
    UNIT.gable = gableGeo();
    // すり鉢（スタジアム）: 外壁 → 上の縁 → 客席の斜面 → グラウンド
    const prof = [[0.001, 0.15], [0.30, 0.15], [0.46, 1], [0.5, 1], [0.5, 0]].map(function (q) { return new THREE.Vector2(q[0], q[1]); });
    UNIT.bowl = new THREE.LatheGeometry(prof, 48);
    const flat = GL.material(cityVS, cityFS, null, {});
    const round = GL.material(cityVS, cityFS, null, { defines: { ROUND: 1 } });
    const tree = GL.material(treeVS, treeFS, { leafMap: { value: null } }, { vertexColors: true, side: THREE.DoubleSide });
    tree.uniforms.leafMap.value = leafTex;
    tree.userData.leafy = true;
    leafDepth = new THREE.ShaderMaterial({ uniforms: { leafMap: { value: leafTex } }, vertexShader: leafDepthVS, fragmentShader: leafDepthFS, side: THREE.DoubleSide });
    MAT.box = flat; MAT.taper = flat; MAT.cyl = round; MAT.cone = round; MAT.ring = round; MAT.dome = round;
    TREE_KINDS.forEach(function (k) { MAT[k] = tree; });
    MAT.gable = flat;
    const carMat = GL.material(cityVS, cityFS, null, { defines: { CAR: 1 } });
    for (const k in CAR_SPECS) { UNIT[k] = carGeo(CAR_SPECS[k]); UNIT[k + 'Lo'] = carGeoLo(CAR_SPECS[k]); MAT[k] = MAT[k + 'Lo'] = carMat; }
    MAT.bowl = GL.material(cityVS, cityFS, null, { defines: { ROUND: 1 }, side: THREE.DoubleSide });
  }

  // ================= 部品を集めてまとめて描く =================
  function Bag() { this.k = {}; }
  // 陸地 i の (u, z)、高さ y に、大きさ (sx, sy, sz) の部品を置く。yaw は上向きの軸まわりの回転
  Bag.prototype.add = function (kind, i, u, z, y, sx, sy, sz, col, style, seed, glow, gi, yaw) {
    const e = this.k[kind] || (this.k[kind] = { m: [], c: [], p: [] });
    const th = COL.landTheta(i, u), f = COL.frameAt(th), p = COL.toWorld(th, z, y);
    const c = Math.cos(yaw || 0), s = Math.sin(yaw || 0), E = f.east, Up = f.up;
    // X' = east*c - north*s, Z' = east*s + north*c
    e.m.push((E[0] * c) * sx, (E[1] * c) * sx, -s * sx, 0,
             Up[0] * sy, Up[1] * sy, 0, 0,
             (E[0] * s) * sz, (E[1] * s) * sz, c * sz, 0,
             p[0], p[1], p[2], 1);
    e.c.push(col[0], col[1], col[2]);
    e.p.push(style || 0, seed || 0, glow || 0, gi || 0);
  };
  // まとめて描くメッシュを作る。木は「近く用」と「遠く用」の2つを作り、戻り値の lod に入れて返す
  // 位置と向きを行列（列優先の16個の数）で直接指定して置く
  Bag.prototype.addM = function (kind, m16, col, style, seed, glow, gi) {
    const e = this.k[kind] || (this.k[kind] = { m: [], c: [], p: [] });
    for (let k = 0; k < 16; k++) e.m.push(m16[k]);
    e.c.push(col[0], col[1], col[2]);
    e.p.push(style || 0, seed || 0, glow || 0, gi || 0);
  };
  Bag.prototype.build = function (parent, cast, mats) {
    const lod = [];
    for (const kind in this.k) {
      const e = this.k[kind], n = e.c.length / 3;
      const im = new THREE.InstancedBufferAttribute(new Float32Array(e.m), 16);
      const ic = new THREE.InstancedBufferAttribute(new Float32Array(e.c), 3);
      const ip = new THREE.InstancedBufferAttribute(new Float32Array(e.p), 4);
      const make = function (name) {
        const base = UNIT[name], g = new THREE.BufferGeometry();
        for (const a in base.attributes) g.setAttribute(a, base.attributes[a]);
        g.setIndex(base.index);
        g.setAttribute('iparm', ip);
        const mesh = new THREE.InstancedMesh(g, (mats || MAT)[name], n);
        mesh.instanceMatrix = im;
        mesh.instanceColor = ic;
        mesh.frustumCulled = false;
        if (cast) mesh.layers.enable(1);
        parent.add(mesh);
        return mesh;
      };
      const hi = make(kind);
      if (UNIT[kind + 'Lo']) lod.push({ hi: hi, lo: make(kind + 'Lo'), car: kind.slice(0, 3) === 'car', reef: !!CORALS[kind] });
    }
    return lod;
  };

  // ================= 当たり判定（建物の本体・桟橋） =================
  const solids = new Map();
  function addSolid(i, u0, u1, z0, z1, bottom, top) {
    const s = { u0: u0, u1: u1, z0: z0, z1: z1, bottom: bottom, top: top };
    for (let a = Math.floor(u0 / B); a <= Math.floor(u1 / B); a++) for (let b = Math.floor(z0 / B); b <= Math.floor(z1 / B); b++) {
      const key = i + ',' + a + ',' + b;
      if (!solids.has(key)) solids.set(key, []);
      solids.get(key).push(s);
    }
    return s;
  }
  // 当たり判定を一時的に外す（ホテルの部屋の中にいる間、その建物の本体など）。COL.solidSkip(s) が true なら無いものとする
  const skip = function (s) { return COL.solidSkip ? COL.solidSkip(s) : false; };
  const solidsAt = function (i, u, z) { return solids.get(i + ',' + Math.floor(u / B) + ',' + Math.floor(z / B)); };
  // 足元の高さ h から 1m 以内で乗れる面（屋上・低層部の上・桟橋）の高さ
  COL.solidTop = function (theta, z, h) {
    const lc = COL.landCoord(theta);
    if (!lc) return -1e9;
    const list = solidsAt(lc.index, lc.u, z);
    let best = -1e9;
    if (list) for (let k = 0; k < list.length; k++) {
      const s = list[k];
      if (lc.u > s.u0 && lc.u < s.u1 && z > s.z0 && z < s.z1 && s.top <= h + 1.0 && s.top > best && !skip(s)) best = s.top;
    }
    return best;
  };
  // 足元の高さ h の人の頭の上にある、一番低い天井（当たり判定の下面）の高さ
  COL.solidCeil = function (theta, z, h) {
    const lc = COL.landCoord(theta);
    if (!lc) return 1e9;
    const list = solidsAt(lc.index, lc.u, z);
    let best = 1e9;
    if (list) for (let k = 0; k < list.length; k++) {
      const s = list[k];
      if (lc.u > s.u0 - 0.3 && lc.u < s.u1 + 0.3 && z > s.z0 - 0.3 && z < s.z1 + 0.3 && s.bottom >= h + 1.8 && s.bottom < best && !skip(s)) best = s.bottom;
    }
    return best;
  };
  // 壁の中に入っていたら、一番近い面の外へ押し出す
  COL.pushOut = function (pos) {
    const r = Math.hypot(pos[0], pos[1]), lc = COL.landCoord(Math.atan2(pos[1], pos[0]));
    if (!lc) return;
    const list = solidsAt(lc.index, lc.u, pos[2]);
    if (!list) return;
    const h = R - r, PAD = 0.45;
    let u = lc.u, z = pos[2], moved = false;
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      if (h >= s.top - 1.0 || h + 1.8 <= s.bottom || skip(s)) continue;
      const a = u - (s.u0 - PAD), b = (s.u1 + PAD) - u, c = z - (s.z0 - PAD), d = (s.z1 + PAD) - z;
      if (a <= 0 || b <= 0 || c <= 0 || d <= 0) continue;
      const m = Math.min(a, b, c, d);
      if (m === a) u -= a; else if (m === b) u += b; else if (m === c) z -= c; else z += d;
      moved = true;
    }
    if (moved) {
      const th = COL.landTheta(lc.index, u);
      pos[0] = r * Math.cos(th); pos[1] = r * Math.sin(th); pos[2] = z;
    }
  };

  // ================= 街区の計画 =================
  const FRAME = [[0.62, 0.66, 0.70], [0.50, 0.56, 0.60], [0.72, 0.70, 0.64], [0.42, 0.46, 0.52], [0.62, 0.54, 0.44], [0.80, 0.82, 0.84]];
  const RESI = [[0.86, 0.83, 0.76], [0.78, 0.70, 0.60], [0.72, 0.74, 0.76], [0.80, 0.62, 0.50], [0.90, 0.90, 0.88]];
  const SFC = [[0.20, 0.24, 0.30], [0.26, 0.28, 0.34], [0.16, 0.20, 0.24], [0.32, 0.33, 0.36]];
  const STONE = [[0.76, 0.74, 0.70], [0.68, 0.68, 0.68], [0.80, 0.77, 0.70]];
  const GLOW = [[0.25, 0.90, 1.0], [1.0, 0.35, 0.80], [1.0, 0.72, 0.28]];
  const GREY = [0.50, 0.51, 0.53], DARK = [0.20, 0.21, 0.23], WHITE = [0.93, 0.93, 0.91], RED = [0.90, 0.16, 0.12];
  // 店の看板の地の色（落ち着いた色。シェーダーの fasciaC と同じ系統）
  const FASCIA = [[0.13, 0.13, 0.14], [0.10, 0.17, 0.30], [0.12, 0.26, 0.19], [0.40, 0.10, 0.12], [0.88, 0.86, 0.80], [0.45, 0.31, 0.20], [0.93, 0.93, 0.92]];
  const HOUSE = [[0.90, 0.87, 0.80], [0.84, 0.78, 0.66], [0.78, 0.82, 0.84], [0.88, 0.80, 0.72], [0.74, 0.70, 0.62], [0.93, 0.92, 0.88]];
  const ROOF = [[0.46, 0.22, 0.18], [0.28, 0.30, 0.34], [0.36, 0.27, 0.21], [0.24, 0.33, 0.31], [0.52, 0.30, 0.20]];
  const SHED = [[0.72, 0.72, 0.70], [0.55, 0.62, 0.70], [0.70, 0.62, 0.52], [0.60, 0.66, 0.60]];
  const CONT = [[0.75, 0.22, 0.16], [0.16, 0.36, 0.62], [0.20, 0.50, 0.32], [0.85, 0.62, 0.14], [0.55, 0.56, 0.58], [0.80, 0.80, 0.78]];
  const CARC = [[0.80, 0.13, 0.10], [0.93, 0.94, 0.95], [0.08, 0.09, 0.11], [0.14, 0.32, 0.72], [0.70, 0.72, 0.75], [0.90, 0.62, 0.10], [0.10, 0.55, 0.60], [0.86, 0.88, 0.92]];
  const BIGARCH = { office: 1, resi: 1, mid: 1, sf: 1, sf2: 1, hotel: 1 };
  const pick = function (list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; };

  // 建物1棟の形を、積み重ねる塊のリストにする。y は建物の基準面からの高さ
  function massing(b) {
    const r = COL.rng(Math.floor(b.seed * 1e6)), M = [], w = b.w, d = b.d, H = b.h;
    const add = function (kind, sw, sd, y, h, style, col, solid, ox, oz, glow, gi) {
      M.push({ kind: kind, w: sw, d: sd, y: y, h: h, style: style, col: col, solid: solid !== false, ox: ox || 0, oz: oz || 0, glow: glow || 0, gi: gi || 0 });
    };
    const stone = pick(STONE, r()), gi = Math.floor(r() * 3);
    if (b.arche === 'office') {
      const hp = 9 + r() * 4, c = pick(FRAME, r()), v = r();
      add('box', w, d, 0, hp, 4, stone);
      if (v < 0.35) {
        add('box', w * 0.80, d * 0.80, hp, H, 0, c);
      } else if (v < 0.75) {
        add('box', w * 0.80, d * 0.80, hp, H * 0.60, 0, c);
        add('box', w * 0.62, d * 0.62, hp + H * 0.60, H * 0.27, 0, c);
        add('box', w * 0.44, d * 0.44, hp + H * 0.87, H * 0.13, 0, c);
      } else {
        add('box', w * 0.78, d * 0.78, hp, H * 0.72, 0, c);
        add('taper', w * 0.78, d * 0.78, hp + H * 0.72, H * 0.28, 0, c);
      }
    } else if (b.arche === 'resi') {
      add('box', w, d, 0, 4.6, 4, stone);
      add('box', w * 0.90, d * 0.86, 4.6, H, 1, pick(RESI, r()), true, 0, 0, w * 0.90 >= d * 0.86 ? 1 : 2);
    } else if (b.arche === 'mid') {
      add('box', w, d, 0, 5.2, 4, stone);
      const s1 = r() < 0.5 ? 0 : 1, c1 = r() < 0.5 ? pick(FRAME, r()) : pick(RESI, r());
      add('box', w * 0.96, d * 0.96, 5.2, H, s1, c1, true, 0, 0, s1 === 1 ? (w >= d ? 1 : 2) : 0);
    } else if (b.arche === 'sf') {
      const c = pick(SFC, r()), dia = w * 0.72, v = r();
      add('cyl', w, w, 0, 10, 4, stone);
      add('cyl', dia, dia, 10, H, 2, c, true, 0, 0, 0, gi);
      const nr = H > 150 ? 3 : 2;
      for (let k = 0; k < nr; k++) add('ring', dia + 9 + 4 * (k % 2), dia + 9 + 4 * (k % 2), 10 + H * (0.40 + 0.24 * k), dia + 9, 5, GLOW[gi], false, 0, 0, 1.3, gi);
      if (v < 0.5) {
        add('cone', dia, dia, 10 + H, H * 0.20, 2, c, false, 0, 0, 0, gi);
      } else {
        add('dome', dia, dia, 10 + H, dia, 2, c, false, 0, 0, 0, gi);   // ドームの h は縦の倍率（高さはその半分）
        add('cone', 2.4, 2.4, 10 + H + dia * 0.45, H * 0.16, 5, GLOW[gi], false, 0, 0, 1.0, gi);
      }
      // 張り出した発着パッド
      const a = Math.floor(r() * 4) * Math.PI / 2, off = dia / 2 + 8, py = 10 + H * 0.56;
      add('cyl', 20, 20, py, 0.9, 3, [0.30, 0.32, 0.35], false, Math.cos(a) * off, Math.sin(a) * off);
      add('ring', 15, 15, py + 0.95, 15, 5, GLOW[gi], false, Math.cos(a) * off, Math.sin(a) * off, 1.2, gi);
    } else if (b.arche === 'houseA') {          // 戸建てA: 切妻屋根
      add('box', w, d, 0, 5.6, 6, pick(HOUSE, r()));
      add('gable', w + 0.9, d + 0.9, 5.6, 2.4 + r(), 3, pick(ROOF, r()), false);
      if (d > w) { const g = M[M.length - 1]; g.yaw = Math.PI / 2; g.w = d + 0.9; g.d = w + 0.9; }
    } else if (b.arche === 'houseB') {          // 戸建てB: 陸屋根のモダン住宅
      const c = r() < 0.6 ? WHITE : pick(HOUSE, r());
      add('box', w, d, 0, 3.5, 6, c);
      add('box', w * 0.62, d * 0.9, 3.5, 3.0, 6, c, true, -w * 0.19, 0);
      add('box', w * 0.68, d * 0.96, 6.5, 0.3, 3, DARK, false, -w * 0.19, 0);
    } else if (b.arche === 'apart') {           // 低層アパート・校舎
      add('box', w, d, 0, H, 1, b.col || pick(RESI, r()), true, 0, 0, w >= d ? 1 : 2);
      add('box', w + 0.8, d + 0.8, H, 0.45, 3, GREY, false);
      add('box', 4, 4, H, 3, 3, GREY, false, w * 0.3, 0);
    } else if (b.arche === 'shop') {            // 小型店舗
      add('box', w, d, 0, 5.6, 4, stone);
      add('box', w * 0.6, 0.4, 5.6, 1.5, 9, pick(FASCIA, r()), false, 0, -d / 2 + 0.3, 0);       // 屋上の看板（字は描き方 9 で）
    } else if (b.arche === 'mall') {            // ショッピングモール
      add('box', w, d, 0, 15, 4, stone);
      add('box', w * 0.7, d * 0.6, 15, 6, 3, [0.80, 0.80, 0.78]);
      add('box', 4, 4, 0, 36, 5, GLOW[gi], false, -w / 2 + 4, -d / 2 + 4, 0.5, gi);
    } else if (b.arche === 'hotel') {           // ホテル
      add('box', w, d, 0, 9, 4, stone);
      add('box', w * 0.86, d * 0.42, 9, H, 1, r() < 0.5 ? WHITE : pick(RESI, r()), true, 0, 0, 1);
      add('box', w * 0.4, 1.2, 9 + H, 4.5, 5, GLOW[gi], false, 0, 0, 0.9, gi);
    } else if (b.arche === 'hospital') {        // 病院
      add('box', w, d * 0.34, 0, 30, 1, WHITE);
      add('box', w * 0.27, d, 0, 20, 1, WHITE, true, -w * 0.355, 0);
      add('box', w * 0.27, d, 0, 20, 1, WHITE, true, w * 0.355, 0);
      add('box', 9, 2.6, 30, 0.6, 5, RED, false, 0, 0, 1.0);
      add('box', 2.6, 9, 30, 0.6, 5, RED, false, 0, 0, 1.0);
      add('cyl', 16, 16, 30, 0.5, 3, [0.30, 0.32, 0.35], false, w * 0.25, 0);
      add('ring', 12, 12, 30.55, 12, 5, GLOW[2], false, w * 0.25, 0, 1.0, 2);
    } else if (b.arche === 'cityhall') {        // 行政庁舎
      add('box', w, d, 0, 14, 0, STONE[0]);
      add('box', w * 0.34, d * 0.42, 14, 62, 0, STONE[0]);
      add('dome', w * 0.34, w * 0.34, 76, w * 0.34, 3, [0.36, 0.62, 0.52], false);
      add('cone', 2.0, 2.0, 76 + w * 0.15, 22, 5, GLOW[2], false, 0, 0, 0.9, 2);
    } else if (b.arche === 'museum') {          // 博物館・ドーム
      add('cyl', w, w, 0, 12, 3, stone);
      add('dome', w * 0.92, w * 0.92, 12, w * 0.92, 2, SFC[0], false, 0, 0, 0, gi);
      add('box', 26, 12, 0, 14, 3, stone, true, 0, -w / 2);
    } else if (b.arche === 'stadium') {         // スタジアム
      add('bowl', w, d, 0, 24, 3, [0.78, 0.78, 0.76]);
      add('cyl', w * 0.57, d * 0.57, 0, 4.0, 3, [0.22, 0.55, 0.22], false);
      add('ring', w + 2, d + 2, 24.6, w, 5, WHITE, false, 0, 0, 1.4);
    } else if (b.arche === 'factory') {         // 工場: のこぎり屋根と煙突
      add('box', w, d, 0, 12, 3, pick(SHED, r()));
      for (let k = 0; k < 5; k++) add('gable', w, d / 5, 12, 3.2, 3, GREY, false, 0, (k - 2) * d / 5);
      for (let k = 0; k < 2; k++) {
        const cx = w * (0.38 - 0.18 * k), cz2 = d / 2 + 6;
        add('cyl', 3.4, 3.4, 0, 42, 3, [0.74, 0.72, 0.70], false, cx, cz2);
        add('cyl', 3.6, 3.6, 37, 3, 5, RED, false, cx, cz2, 0.35);
      }
      add('box', 22, 12, 0, 9, 0, pick(FRAME, r()), true, -w * 0.3, -d / 2 - 6);
    } else if (b.arche === 'shed') {            // 倉庫
      add('box', w, d, 0, 9, 3, pick(SHED, r()));
      add('gable', w + 1, d + 1, 9, 2.6, 3, pick(ROOF, r()), false);
      if (d > w) { const g = M[M.length - 1]; g.yaw = Math.PI / 2; g.w = d + 1; g.d = w + 1; }
    } else if (b.arche === 'tank') {            // 水処理のタンク
      add('cyl', w, w, 0, H, 3, r() < 0.5 ? WHITE : [0.70, 0.80, 0.86]);
      add('dome', w, w, H, w * 0.5, 3, [0.80, 0.82, 0.84], false);
    } else if (b.arche === 'pool') {            // 沈殿池
      add('cyl', w, w, 0, 1.9, 3, [0.62, 0.62, 0.60], false);
      add('cyl', w - 2, w - 2, 0, 2.0, 5, [0.20, 0.45, 0.55], false, 0, 0, 0.12);
    } else if (b.arche === 'stack') {           // 積んだコンテナ
      for (let k = 0; k < H; k++) add('box', w, d, k * 2.6, 2.6, 3, pick(CONT, r()));
    } else if (b.arche === 'greenhouse') {      // 農業温室
      add('box', w, d, 0, 3.4, 0, [0.92, 0.94, 0.92]);
      add('gable', w, d, 3.4, 2.2, 0, [0.92, 0.94, 0.92], false);
      if (d > w) { const g = M[M.length - 1]; g.yaw = Math.PI / 2; g.w = d; g.d = w; }
    } else if (b.arche === 'barn') {            // 納屋とサイロ
      add('box', w, d, 0, 6, 3, [0.62, 0.22, 0.18]);
      add('gable', w + 1, d + 1, 6, 4, 3, GREY, false);
      add('cyl', 5, 5, 0, 13, 3, [0.80, 0.80, 0.82], true, w / 2 + 4.5, 0);
      add('dome', 5, 5, 13, 5, 3, [0.70, 0.72, 0.74], false, w / 2 + 4.5, 0);
    } else if (b.arche === 'wtower') {          // 大気・気象制御塔
      add('box', 34, 34, 0, 18, 3, stone);
      add('cyl', 10, 10, 18, H, 3, [0.90, 0.91, 0.93]);
      for (let k = 0; k < 4; k++) add('ring', 22 + 6 * (k % 2), 22 + 6 * (k % 2), 18 + H * (0.3 + 0.2 * k), 22, 5, GLOW[0], false, 0, 0, 1.3, 0);
      add('dome', 30, 30, 18 + H, 30, 2, SFC[0], false, 0, 0, 0, 0);
      add('cone', 2.5, 2.5, 18 + H + 14, 40, 5, GLOW[0], false, 0, 0, 1.0, 0);
    } else {                                    // 'sf2': 先細りの塔
      const c = pick(SFC, r());
      add('box', w, d, 0, 8, 4, stone);
      add('box', w * 0.80, d * 0.80, 8, H * 0.35, 2, c, true, 0, 0, 0, gi);
      add('taper', w * 0.80, d * 0.80, 8 + H * 0.35, H * 0.65, 2, c, true, 0, 0, 0, gi);
      add('cone', 3.0, 3.0, 8 + H, H * 0.18, 5, GLOW[gi], false, 0, 0, 1.0, gi);
    }
    return M;
  }

  let bseed = 12345;
  function makeBuilding(i, arche, u, z, w, d, h, seed, col) {
    // 床の高さ: 敷地の一番高い所より少しだけ下（高い側が埋まるのは 0.35m まで）。低い側にできる すき間は基礎の台でふさぐ
    let lo = 1e9, hi = -1e9;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const g = COL.groundH(COL.landTheta(i, u + a * w / 2), z + c * d / 2);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
    }
    const b = { arche: arche, u: u, z: z, w: w, d: d, h: h, base: Math.max(lo, hi - 0.35) - 0.05, lo: lo, seed: seed, col: col };
    b.M = massing(b);
    return b;
  }

  const plans = new Map();
  // 陸地 i の (u, z) から r 以内に建つ建物（街区の計画から。ホテルなど、決まった建物を探すのに使う）
  COL.buildingsNear = function (i, u, z, r) {
    const out = [];
    for (let a = Math.floor((u - r) / B); a <= Math.floor((u + r) / B); a++) for (let c = Math.floor((z - r) / B); c <= Math.floor((z + r) / B); c++) {
      const plan = planBlock(i, a, c);
      if (plan) plan.b.forEach(function (b) { if (Math.hypot(b.u - u, b.z - z) < r) out.push(b); });
    }
    return out;
  };
  function planBlock(i, bu, bz) {
    const key = i + ',' + bu + ',' + bz;
    if (plans.has(key)) return plans.get(key);
    const info = COL.blockInfo(i, bu, bz), type = info ? info.type : null;
    let plan = null;
    if (type) {
      const r = COL.rng((Math.imul(bu, 73856093) ^ Math.imul(bz, 19349663) ^ Math.imul(i + 1, 83492791)) >>> 0);
      const cu = (bu + 0.5) * B, cz = (bz + 0.5) * B;
      const core = Math.exp(-Math.pow((cz - 12000) / 2300, 2)) * Math.max(0, 1 - Math.pow(cu / 1700, 2));
      const maxH = 55 + 330 * core;
      plan = { type: type, i: i, cu: cu, cz: cz, b: [], seed: r() };
      plan.zone = info.zone;
      plan.palm = info.zone === 'resort' || (info.zone === 'harbor' && cz > 24000);
      const mk = function (arche, u, z, w, d, h, col) {
        const b = makeBuilding(i, arche, u, z, w, d, h, r(), col);
        plan.b.push(b);
        return b;
      };
      // 街区の内側（約98m角）を nx × nz の敷地に分ける
      const lots = function (nx, nz, fn) {
        for (let a = 0; a < nx; a++) for (let b2 = 0; b2 < nz; b2++) fn(cu + ((a + 0.5) / nx - 0.5) * 98, cz + ((b2 + 0.5) / nz - 0.5) * 98, a, b2);
      };
      if (type === 'tower') {
        const w = 50 + r() * 10;
        mk(r() < 0.5 ? 'sf' : 'office', cu, cz, w, w, maxH * (0.70 + 0.45 * r()) + 30);
      } else if (type === 'quad') {
        for (let q = 0; q < 4; q++) {
          const v = r(), arche = v < 0.35 ? 'office' : v < 0.60 ? 'resi' : v < 0.76 ? 'sf2' : 'mid';
          const h = arche === 'mid' ? 16 + r() * 26 : 28 + maxH * (0.20 + 0.60 * r() * r());
          mk(arche, cu + (q & 1 ? 27 : -27), cz + (q & 2 ? 27 : -27), 36 + r() * 8, 36 + r() * 8, h);
        }
      } else if (type === 'twin') {
        const alongU = r() < 0.5, v = r();
        if (v < 0.32) {
          const h = 60 + maxH * (0.45 + 0.4 * r());
          const a = mk('sf', cu - (alongU ? 27 : 0), cz - (alongU ? 0 : 27), 42, 42, h);
          const c = mk('sf', cu + (alongU ? 27 : 0), cz + (alongU ? 0 : 27), 42, 42, h * (0.75 + 0.2 * r()));
          plan.bridge = { alongU: alongU, y: Math.min(a.base, c.base) + 10 + c.h * 0.48, y2: Math.min(a.base, c.base) + 10 + c.h * 0.80 };
        } else {
          const arche = v < 0.66 ? 'resi' : 'office';
          for (let q = 0; q < 2; q++) {
            const o = q ? 27 : -27;
            mk(arche, cu + (alongU ? 0 : o), cz + (alongU ? o : 0), alongU ? 92 : 38, alongU ? 38 : 92, 30 + maxH * (0.22 + 0.45 * r()));
          }
        }
      } else if (type === 'houses') {
        plan.small = true;
        lots(4, 4, function (u, z) {
          if (r() < 0.12) return;
          const w = 8 + r() * 3.5, d = 7 + r() * 2.5, sw = r() < 0.5;
          mk(r() < 0.65 ? 'houseA' : 'houseB', u + (r() - 0.5) * 5, z + (r() - 0.5) * 5, sw ? d : w, sw ? w : d, 0);
        });
      } else if (type === 'villas') {
        plan.small = true;
        lots(3, 3, function (u, z) { if (r() < 0.85) mk('houseB', u + (r() - 0.5) * 6, z + (r() - 0.5) * 6, 12 + r() * 3, 10 + r() * 2, 0); });
      } else if (type === 'apart') {
        lots(2, 2, function (u, z, a, b2) { const o = (a + b2) % 2; mk('apart', u, z, o ? 16 : 40, o ? 40 : 16, 3.1 * (3 + Math.floor(r() * 3))); });
      } else if (type === 'mansion') {
        mk('resi', cu - 25, cz, 38, 34, 55 + r() * 60);
        mk('resi', cu + 25, cz, 38, 34, 55 + r() * 60);
      } else if (type === 'shops') {
        plan.small = true;
        for (let k = 0; k < 4; k++) { mk('shop', cu - 37 + k * 24.6, cz - 38, 22, 16, 0); mk('shop', cu - 37 + k * 24.6, cz + 38, 22, 16, 0); }
      } else if (type === 'school') {
        const cream = [0.90, 0.86, 0.74];
        mk('apart', cu, cz + 38, 84, 14, 12.4, cream);
        mk('apart', cu - 38, cz - 4, 14, 58, 12.4, cream);
        mk('shed', cu + 28, cz - 28, 34, 24, 0);
      } else if (type === 'midrise') {
        for (let q = 0; q < 4; q++) mk('mid', cu + (q & 1 ? 27 : -27), cz + (q & 2 ? 27 : -27), 38 + r() * 6, 38 + r() * 6, 16 + r() * 30);
      } else if (type === 'mall') {
        mk('mall', cu, cz, 94, 80, 0);
      } else if (type === 'hotel') {
        mk('hotel', cu, cz + 10, 90, 70, 40 + r() * 55);
      } else if (type === 'hospital') {
        mk('hospital', cu, cz, 92, 80, 0);
      } else if (type === 'museum') {
        mk('museum', cu, cz + 6, 70, 70, 0);
      } else if (type === 'cityhall') {
        mk('cityhall', cu, cz, 92, 76, 0);
      } else if (type === 'stadium') {
        mk('stadium', cu, cz, 96, 98, 0);
      } else if (type === 'factory') {
        mk('factory', cu, cz - 2, 84, 58, 0);
      } else if (type === 'tanks') {
        for (let k = 0; k < 3; k++) mk('tank', cu - 32 + k * 30, cz + 28, 24, 24, 10 + r() * 5);
        mk('pool', cu - 28, cz - 26, 32, 32, 0);
        mk('pool', cu + 10, cz - 26, 32, 32, 0);
        mk('apart', cu + 40, cz - 28, 14, 24, 7, WHITE);
      } else if (type === 'warehouse') {
        const alongU = r() < 0.5;
        for (let q = 0; q < 2; q++) {
          const o = q ? 26 : -26;
          mk('shed', cu + (alongU ? 0 : o), cz + (alongU ? o : 0), alongU ? 92 : 40, alongU ? 40 : 92, 0);
        }
      } else if (type === 'yard') {
        plan.small = true;
        for (let a = 0; a < 6; a++) for (let b2 = 0; b2 < 5; b2++) {
          if (r() < 0.72) mk('stack', cu - 40 + a * 16, cz - 40 + b2 * 20, 2.5, 12.2, 1 + Math.floor(r() * 3));
        }
      }
    }
    plans.set(key, plan);
    return plan;
  }

  // 建物の本体（遠くからも見える形）と当たり判定
  const CORNICE = { office: 1, resi: 1, mid: 1, hotel: 1, mall: 1, hospital: 1, cityhall: 1 };
  function emitBuilding(i, b, bag) {
    b.M.forEach(function (m) {
      if (CORNICE[b.arche] && m.kind === 'box' && m.solid && m.h > 3 && (m.style === 0 || m.style === 1 || m.style === 4)) {
        // 軒: 壁の外側を囲む細い枠（屋上の面とは重ならないようにする）
        const cc = [m.col[0] * 0.86, m.col[1] * 0.86, m.col[2] * 0.86], t = 0.3, hh = 0.55, y = b.base + m.y + m.h - hh, cu = b.u + m.ox, cz = b.z + m.oz;
        bag.add('box', i, cu, cz - m.d / 2 - t / 2, y, m.w + 2 * t, hh, t, cc, 3, 33);
        bag.add('box', i, cu, cz + m.d / 2 + t / 2, y, m.w + 2 * t, hh, t, cc, 3, 33);
        bag.add('box', i, cu - m.w / 2 - t / 2, cz, y, t, hh, m.d, cc, 3, 33);
        bag.add('box', i, cu + m.w / 2 + t / 2, cz, y, t, hh, m.d, cc, 3, 33);
      }
      // 基礎の台: 地面が床より低い所を、壁の下から地面の中までふさぐ
      if (m.solid && m.y === 0 && (m.kind === 'box' || m.kind === 'cyl') && b.base - b.lo > 0.02) {
        const fh = b.base - b.lo + 0.4, fc = [0.52, 0.51, 0.49];
        bag.add(m.kind, i, b.u + m.ox, b.z + m.oz, b.base - fh, m.w + 0.06, fh, m.d + 0.06, fc, 3, 34, 0, 0, m.yaw || 0);
      }
      const sy = m.kind === 'ring' ? m.w : m.kind === 'dome' ? m.h : m.h;
      bag.add(m.kind, i, b.u + m.ox, b.z + m.oz, b.base + m.y, m.w, m.kind === 'dome' ? m.h : sy, m.d, m.col, m.style, Math.floor(b.seed * 50), m.glow, m.gi, m.yaw || 0);
      if (m.solid) {
        const k = m.kind === 'cyl' ? 0.42 : m.kind === 'taper' ? 0.40 : 0.5;
        addSolid(i, b.u + m.ox - m.w * k, b.u + m.ox + m.w * k, b.z + m.oz - m.d * k, b.z + m.oz + m.d * k, b.base + m.y, b.base + m.y + m.h);
      }
    });
  }
  // 四角形のまわりを囲む4本の細い箱（out: 壁から外へ出す量、t: 厚み）
  function ring4(bag, i, cu, cz, y, w, d, out, t, hh, col, style, seed, glow, gi) {
    const ow = w / 2 + out - t / 2, od = d / 2 + out - t / 2;
    bag.add('box', i, cu, cz - od, y, w + 2 * out, hh, t, col, style, seed, glow, gi);
    bag.add('box', i, cu, cz + od, y, w + 2 * out, hh, t, col, style, seed, glow, gi);
    bag.add('box', i, cu - ow, cz, y, t, hh, d + 2 * out - 2 * t, col, style, seed, glow, gi);
    bag.add('box', i, cu + ow, cz, y, t, hh, d + 2 * out - 2 * t, col, style, seed, glow, gi);
  }
  const GARDEN = [0.26, 0.46, 0.22];
  // 高い建物の頂部の飾り（当たり判定なし。建物の形は変えない）
  function emitCrown(i, b, bag) {
    if (!(b.arche === 'office' || b.arche === 'resi' || b.arche === 'hotel') || b.h < 40) return;
    let top = null;
    b.M.forEach(function (m) { if (m.solid && (m.kind === 'box' || m.kind === 'taper')) top = m; });
    if (!top) return;
    const r = COL.rng(Math.floor(b.seed * 1e6) + 911), v = r(), gi = Math.floor(r() * 3), band = r() < 0.55;
    const y = b.base + top.y + top.h, cu = b.u + top.ox, cz = b.z + top.oz, w = top.w, d = top.d, mn = Math.min(w, d);
    const metal = FRAME[5];
    if (top.kind === 'taper') {
      // 先細りの頂部: 光る台座と細い尖塔
      bag.add('box', i, cu, cz, y, w * 0.58 + 0.8, 0.6, d * 0.58 + 0.8, GLOW[gi], 5, 0, 0.9, gi);
      bag.add('taper', i, cu, cz, y + 0.6, 2.4, b.h * 0.10 + 6, 2.4, metal, 3, 3);
      return;
    }
    if (b.arche === 'office') {
      if (band) ring4(bag, i, cu, cz, y - 1.15, w, d, 0.22, 0.22, 0.38, GLOW[gi], 5, 0, 0.85, gi);        // 屋上の縁の下の光の帯
      if (v < 0.28) {
        // 開いた枠の冠: 四隅の柱と、その上をつなぐ梁
        const ch = 6 + mn * 0.12;
        for (let q = 0; q < 4; q++) bag.add('box', i, cu + (q & 1 ? 1 : -1) * (w / 2 - 0.5), cz + (q & 2 ? 1 : -1) * (d / 2 - 0.5), y, 1.0, ch, 1.0, metal, 3, 36);
        ring4(bag, i, cu, cz, y + ch - 0.9, w, d, 0, 1.0, 0.9, metal, 3, 36);
        ring4(bag, i, cu, cz, y + ch * 0.5, w, d, -0.25, 0.3, 0.3, metal, 3, 36);
        bag.add('box', i, cu, cz, y, w * 0.5, ch * 0.6, d * 0.5, [0.42, 0.44, 0.47], 3, 37);
      } else if (v < 0.52) {
        // 斜めに絞ったガラスの冠と尖塔
        const ch = 5 + mn * 0.18;
        bag.add('taper', i, cu, cz, y, w * 0.92, ch, d * 0.92, top.col, 0, Math.floor(b.seed * 50));
        bag.add('box', i, cu, cz, y + ch, w * 0.92 * 0.58 + 0.5, 0.45, d * 0.92 * 0.58 + 0.5, GLOW[gi], 5, 0, 0.8, gi);
        if (b.h > 110) bag.add('taper', i, cu, cz, y + ch + 0.45, 1.8, 14 + b.h * 0.08, 1.8, metal, 3, 3);
      } else if (v < 0.74 && mn > 18) {
        // ヘリポート
        const pr = mn * 0.56;
        bag.add('cyl', i, cu, cz, y + 1.6, pr, 0.5, pr, [0.30, 0.32, 0.35], 3, 6);
        bag.add('cyl', i, cu, cz, y, pr * 0.35, 1.6, pr * 0.35, [0.46, 0.47, 0.50], 3, 6);
        bag.add('ring', i, cu, cz, y + 2.15, pr * 0.86, pr * 0.86, pr * 0.86, GLOW[2], 5, 0, 1.0, 2);
        bag.add('box', i, cu, cz, y + 2.1, pr * 0.34, 0.06, pr * 0.07, WHITE, 5, 0, 0.5);
        bag.add('box', i, cu - pr * 0.14, cz, y + 2.1, pr * 0.07, 0.06, pr * 0.34, WHITE, 5, 0, 0.5);
        bag.add('box', i, cu + pr * 0.14, cz, y + 2.1, pr * 0.07, 0.06, pr * 0.34, WHITE, 5, 0, 0.5);
      } else {
        // 機械室の塔屋と、横に張り出した ひさしの屋根
        const ch = 4.5 + r() * 3;
        bag.add('box', i, cu, cz, y, w * 0.56, ch, d * 0.56, [0.50, 0.52, 0.55], 3, 37);
        bag.add('box', i, cu, cz, y + ch, w * 0.74, 0.4, d * 0.74, metal, 3, 38);
        ring4(bag, i, cu, cz, y + ch - 0.5, w * 0.74, d * 0.74, 0, 0.18, 0.3, GLOW[gi], 5, 0, 0.7, gi);
      }
    } else if (b.arche === 'resi') {
      // マンション: 屋上の庭（芝・木立・あずまや）か、最上階のペントハウス
      if (v < 0.5) {
        bag.add('box', i, cu, cz, y + 0.02, w * 0.78, 0.22, d * 0.66, GARDEN, 3, 39);
        for (let q = 0; q < 5; q++) {
          const s = 3.2 + r() * 2.6, tu = cu + (r() - 0.5) * w * 0.66, tz = cz + (r() - 0.5) * d * 0.5;
          bag.add('box', i, tu, tz, y, 0.35, s * 0.5, 0.35, [0.36, 0.27, 0.20], 3, 39);
          bag.add('shrubLo', i, tu, tz, y + s * 0.25, s * 0.62, s * 0.62, s * 0.62, [1.0 + 0.3 * r(), 1.05, 0.9], 0, 0, 0, 0, r() * TAU);      // 遠くからも見えるので、面の少ない形で
        }
        bag.add('box', i, cu + w * 0.28, cz, y + 2.7, 4.6, 0.2, 3.6, WHITE, 3, 38);
        for (let q = 0; q < 4; q++) bag.add('box', i, cu + w * 0.28 + (q & 1 ? 2 : -2), cz + (q & 2 ? 1.5 : -1.5), y, 0.18, 2.7, 0.18, WHITE, 3, 38);
      } else {
        bag.add('box', i, cu - w * 0.12, cz, y, w * 0.52, 3.3, d * 0.62, WHITE, 6, Math.floor(b.seed * 50) + 3);
        bag.add('box', i, cu - w * 0.12, cz, y + 3.3, w * 0.60, 0.3, d * 0.78, DARK, 3, 38);
        bag.add('box', i, cu + w * 0.30, cz, y + 0.02, w * 0.26, 0.2, d * 0.6, [0.52, 0.40, 0.28], 3, 39);
      }
    } else {
      // ホテル: 屋上のプールとデッキ
      bag.add('box', i, cu, cz, y + 0.02, w * 0.8, 0.25, d * 0.7, [0.60, 0.50, 0.38], 3, 39);
      bag.add('box', i, cu - w * 0.12, cz, y + 0.1, w * 0.42, 0.22, d * 0.36, [0.20, 0.62, 0.80], 5, 0, 0.30);
      if (band) ring4(bag, i, cu, cz, y - 1.15, w, d, 0.22, 0.22, 0.38, GLOW[2], 5, 0, 0.8, 2);
    }
  }
  function emitMajor(plan, bag) {
    const i = plan.i;
    plan.b.forEach(function (b) { emitBuilding(i, b, bag); emitCrown(i, b, bag); });
    if (plan.bridge) {
      const g = plan.bridge, col = FRAME[5];
      [g.y, g.y2].forEach(function (y) {
        bag.add('box', i, plan.cu, plan.cz, y, g.alongU ? 30 : 6, 4.5, g.alongU ? 6 : 30, col, 0, 3, 0, 0, 0);
        bag.add('box', i, plan.cu, plan.cz, y - 0.5, g.alongU ? 30 : 6.6, 0.5, g.alongU ? 6.6 : 30, GLOW[0], 5, 0, 0.9, 0, 0);
      });
    }
  }

  const TREE_TINT = [[1, 1, 1], [0.92, 1.05, 0.85], [1.1, 1.0, 0.8], [0.85, 0.95, 0.9], [1.25, 0.95, 0.55]];
  function addTree(bag, r, i, u, z, kind, scale) {
    if (!kind || kind === 'broad') kind = r() < 0.4 ? 'broad2' : 'broad';
    const s = (scale || 1) * (0.8 + 0.6 * r());
    bag.add(kind || 'broad', i, u, z, COL.groundH(COL.landTheta(i, u), z) - 0.15, s, s * (0.9 + 0.3 * r()), s, pick(TREE_TINT, r() * r()), 0, 0, 0, 0, r() * TAU);
  }
  function addLamp(bag, i, u, z, du, dz, h) {
    const y = COL.groundH(COL.landTheta(i, u), z);
    bag.add('box', i, u, z, y - 0.2, 0.24, h + 0.2, 0.24, DARK, 3, 1);
    bag.add('box', i, u + du * 1.1, z + dz * 1.1, y + h - 0.1, du ? 2.4 : 0.2, 0.16, dz ? 2.4 : 0.2, DARK, 3, 1);
    bag.add('box', i, u + du * 2.0, z + dz * 2.0, y + h - 0.32, du ? 1.0 : 0.45, 0.2, dz ? 1.0 : 0.45, [1.0, 0.86, 0.62], 5, 0, 1.5);
  }
  function addBench(bag, i, u, z, yaw) {
    const y = COL.groundH(COL.landTheta(i, u), z);
    bag.add('box', i, u, z, y + 0.35, 2.0, 0.1, 0.6, [0.50, 0.36, 0.22], 3, 2, 0, 0, yaw);
    bag.add('box', i, u, z, y, 1.7, 0.36, 0.12, DARK, 3, 2, 0, 0, yaw);
  }

  const SHRUB_TINT = [[1, 1, 1], [0.9, 1.08, 0.85], [1.1, 1.0, 0.75], [0.85, 0.95, 1.0]];
  function addShrub(bag, r, i, u, z, scale, y) {
    const s = (scale || 1) * (0.7 + 0.6 * r());
    bag.add('shrub', i, u, z, (y === undefined ? COL.groundH(COL.landTheta(i, u), z) : y) - 0.1, s, s * (0.8 + 0.4 * r()), s, pick(SHRUB_TINT, r()), 0, 0, 0, 0, r() * TAU);
  }
  // 傾けて置く（屋根の太陽光パネルなど）。yaw で向きを決めてから、pitch だけ前を持ち上げる
  function addTilted(bag, kind, i, u, z, y, sx, sy, sz, yaw, pitch, col, style, seed) {
    const th = COL.landTheta(i, u), f = COL.frameAt(th), p = COL.toWorld(th, z, y), E = f.east, Up = f.up;
    const c = Math.cos(yaw), s = Math.sin(yaw), X = [E[0] * c, E[1] * c, -s], Z = [E[0] * s, E[1] * s, c];
    const cp = Math.cos(pitch), sp = Math.sin(pitch), Z2 = V.add(V.mul(Z, cp), V.mul(Up, sp)), Y2 = V.sub(V.mul(Up, cp), V.mul(Z, sp));
    bag.addM(kind, [X[0] * sx, X[1] * sx, X[2] * sx, 0, Y2[0] * sy, Y2[1] * sy, Y2[2] * sy, 0, Z2[0] * sz, Z2[1] * sz, Z2[2] * sz, 0, p[0], p[1], p[2], 1], col, style, seed);
  }

  // ---- 建物の外壁の作り込み（近くだけ）: マンションの連続バルコニー、オフィスの縦ルーバー ----
  const SLAB = [0.82, 0.82, 0.80], FINC = [0.80, 0.81, 0.82];
  const PARAPET = [[0.86, 0.86, 0.84], [0.66, 0.75, 0.80], [0.80, 0.78, 0.74], [0.56, 0.60, 0.64]];
  const AWNING = [[0.74, 0.20, 0.17], [0.14, 0.36, 0.30], [0.18, 0.28, 0.52], [0.86, 0.80, 0.68], [0.88, 0.56, 0.14], [0.24, 0.24, 0.27], [0.55, 0.16, 0.30]];
  const GLASSR = [0.70, 0.82, 0.86];
  // 建物の飾り（近くだけ）: 段々になった所の空中庭園、日よけの横の庇、1階の店のひさし・袖看板・柱、角の付け柱、バルコニーの植木
  function emitOrnament(i, b, bag, fin) {
    const r = COL.rng(Math.floor(b.seed * 1e6) + 577);
    const big = !!BIGARCH[b.arche], stoneC = [0.80, 0.78, 0.73];
    for (let k = 0; k < b.M.length; k++) {
      const m = b.M[k];
      if (!m.solid || m.kind !== 'box') continue;
      const y0 = b.base + m.y, cu = b.u + m.ox, cz = b.z + m.oz, yt = y0 + m.h;
      // ---- 上の階が引っ込んでいる所: 空中庭園（芝・生垣・木立）とガラスの手すり ----
      const up = b.M[k + 1];
      if (up && up.solid && (up.kind === 'box' || up.kind === 'taper' || up.kind === 'cyl') && Math.abs(up.y - (m.y + m.h)) < 0.01 && !up.ox && !up.oz && m.h > 4) {
        const lw = (m.w - up.w) / 2, ld = (m.d - up.d) / 2;
        if (lw > 1.6 && ld > 1.6) {
          ring4(bag, i, cu, cz, yt, m.w, m.d, -0.12, 0.08, 1.1, GLASSR, 3, 45);
          ring4(bag, i, cu, cz, yt + 1.1, m.w, m.d, -0.08, 0.16, 0.06, [0.30, 0.31, 0.33], 3, 45);
          const gw = Math.min(lw - 0.9, 2.2), gd = Math.min(ld - 0.9, 2.2);
          // 生垣の帯（上の階の壁ぞい）
          bag.add('hedge', i, cu, cz - up.d / 2 - 0.5 - gd / 2, yt - 0.05, up.w, 0.75, gd, [1, 1, 1], 0, 0);
          bag.add('hedge', i, cu, cz + up.d / 2 + 0.5 + gd / 2, yt - 0.05, up.w, 0.75, gd, [1, 1, 1], 0, 0);
          bag.add('hedge', i, cu - up.w / 2 - 0.5 - gw / 2, cz, yt - 0.05, gw, 0.75, up.d, [1, 1, 1], 0, 0);
          bag.add('hedge', i, cu + up.w / 2 + 0.5 + gw / 2, cz, yt - 0.05, gw, 0.75, up.d, [1, 1, 1], 0, 0);
          // 四隅の木と、ところどころの低木
          if (lw > 3 && ld > 3) for (let q = 0; q < 4; q++) {
            const tu = cu + (q & 1 ? 1 : -1) * (m.w / 2 - lw / 2), tz = cz + (q & 2 ? 1 : -1) * (m.d / 2 - ld / 2), s = Math.min(1.0, 0.28 + lw * 0.06);
            bag.add('box', i, tu, tz, yt, Math.min(lw, ld) * 0.62, 0.5, Math.min(lw, ld) * 0.62, [0.70, 0.69, 0.66], 3, 6);
            // 木は重いので、いちばん下の段の対角の2か所だけ。ほかは大きめの低木
            if (k === 0 && (q === 0 || q === 3)) bag.add(r() < 0.5 ? 'broad' : 'broad2', i, tu, tz, yt + 0.3, s, s, s, pick(TREE_TINT, r() * r()), 0, 0, 0, 0, r() * TAU);
            else bag.add('shrub', i, tu, tz, yt + 0.35, 1.5, 1.6, 1.5, pick(SHRUB_TINT, r()), 0, 0, 0, 0, r() * TAU);
          }
          for (let q = 0; q < 4; q++) {
            const side = q % 4, al = (r() - 0.5) * 0.8, s = 0.7 + 0.5 * r();
            const su = side < 2 ? cu + al * m.w : cu + (side === 2 ? 1 : -1) * (m.w / 2 - 1.0), sz = side < 2 ? cz + (side ? 1 : -1) * (m.d / 2 - 1.0) : cz + al * m.d;
            bag.add('shrub', i, su, sz, yt - 0.1, s, s, s, pick(SHRUB_TINT, r()), 0, 0, 0, 0, r() * TAU);
          }
        }
      }
      // ---- 事務所の塔: 数階ごとの日よけの横の庇（縦のルーバーの無い建物） ----
      if (m.style === 0 && !fin && m.h > 24 && big && b.arche !== 'cityhall') {
        const stepH = 3.75 * (m.h > 120 ? 6 : 4);
        for (let yy = stepH; yy < m.h - 6; yy += stepH) ring4(bag, i, cu, cz, y0 + yy - 0.14, m.w, m.d, 0.55, 0.55, 0.22, FINC, 3, 35);
      }
      // ---- 角の付け柱（中層の建物と、石張りの事務所） ----
      if ((b.arche === 'mid' || (b.arche === 'office' && fin)) && (m.style === 0 || m.style === 1) && m.h > 9 && !(m.style === 1 && m.glow > 0)) {
        const pc = [m.col[0] * 0.80, m.col[1] * 0.80, m.col[2] * 0.80];
        for (let q = 0; q < 4; q++) bag.add('box', i, cu + (q & 1 ? 1 : -1) * (m.w / 2 + 0.05), cz + (q & 2 ? 1 : -1) * (m.d / 2 + 0.05), y0, 1.1, m.h - 0.6, 1.1, pc, 3, 33);
      }
      // ---- 1階が店の建物: ひさし・袖看板・柱 ----
      if (m.style === 4 && m.y === 0) {
        const shopH = Math.min(5.2, m.h), tall = m.h >= 8.5;
        for (let face = 0; face < 4; face++) {
          const alongX = face < 2, sd = face % 2 ? 1 : -1, len = alongX ? m.w : m.d, half = len / 2, out = (alongX ? m.d : m.w) / 2;
          const yaw = alongX ? (sd > 0 ? 0 : Math.PI) : (sd > 0 ? Math.PI / 2 : -Math.PI / 2);
          const N = Math.floor((half - 0.6) / 6);
          const at = function (x, o) { return alongX ? [cu + x, cz + sd * (out + o)] : [cu + sd * (out + o), cz + x]; };
          for (let c = -N; c < N; c++) {
            const xc = (c + 0.5) * 6, rv = r(), rv2 = r(), rv3 = r();
            const door = big && alongX && sd < 0 && Math.abs(xc) < Math.min(12, b.w * 0.3) / 2 + 3;      // 正面の入口のまわりは空ける
            if (!door && rv < 0.6) {
              const q = at(xc, 0.72), col = pick(AWNING, rv2);
              addTilted(bag, 'box', i, q[0], q[1], y0 + shopH * 0.735, 5.2, 0.07, 1.5, yaw, -0.30, col, 10, 60);
              const q2 = at(xc, 1.44);
              if (alongX) bag.add('box', i, q2[0], q2[1], y0 + shopH * 0.735 - 0.52, 5.2, 0.24, 0.05, col, 10, 60);
              else bag.add('box', i, q2[0], q2[1], y0 + shopH * 0.735 - 0.52, 0.05, 0.24, 5.2, col, 10, 60);
            }
            if (!door && rv3 < 0.22 && m.h >= 6.6) {
              // 袖看板（壁から突き出た縦長の看板。夜に光る）
              const q = at(c * 6, 0.62), sc = [0.5 + 0.5 * Math.cos(6.28 * rv2), 0.5 + 0.5 * Math.cos(6.28 * rv2 + 2), 0.5 + 0.5 * Math.cos(6.28 * rv2 + 4)];
              const sh = Math.min(3.0, m.h - shopH - 0.9);
              if (sh > 1.2) {
                if (alongX) bag.add('box', i, q[0], q[1], y0 + shopH + 0.3, 0.16, sh, 0.9, sc, 5, 0, 0.75);
                else bag.add('box', i, q[0], q[1], y0 + shopH + 0.3, 0.9, sh, 0.16, sc, 5, 0, 0.75);
              }
            }
            if (!door && rv > 0.82) {
              // 店先の植木鉢
              const q = at(xc + 2.2, 0.55), g0 = COL.groundH(COL.landTheta(i, q[0]), q[1]);
              bag.add('box', i, q[0], q[1], g0 - 0.1, 0.62, 0.7, 0.62, [0.58, 0.44, 0.34], 3, 61);
              bag.add('shrubLo', i, q[0], q[1], g0 + 0.45, 0.55, 0.6, 0.55, pick(SHRUB_TINT, rv2), 0, 0, 0, 0, rv3 * TAU);
            }
          }
          // 高い低層部: 店の間の柱（列柱）
          if (tall) for (let c = -N; c <= N; c++) {
            const q = at(c * 6, 0.32);
            bag.add('box', i, q[0], q[1], y0, 0.8, m.h - 0.6, 0.8, stoneC, 3, 62);
          }
        }
      }
      // ---- マンションのバルコニーの植木（ところどころ） ----
      if (m.style === 1 && m.glow > 0 && m.h > 9) {
        const nf = Math.floor(m.h / 3.1 + 0.01), ax = m.glow, len = ax === 1 ? m.w : m.d, depth = ax === 1 ? m.d : m.w, n = Math.min(24, Math.floor(nf * len / 40));
        for (let q = 0; q < n; q++) {
          const fl = 1 + Math.floor(r() * (nf - 1)), al = (r() - 0.5) * (len - 3), sd = r() < 0.5 ? -1 : 1, o = depth / 2 + 1.0;
          const pu = ax === 1 ? cu + al : cu + sd * o, pz = ax === 1 ? cz + sd * o : cz + al, s = 0.32 + 0.2 * r();
          bag.add('shrubLo', i, pu, pz, y0 + fl * 3.1 - 0.05, s, s * 1.1, s, pick(SHRUB_TINT, r()), 0, 0, 0, 0, r() * TAU);
        }
      }
    }
    // ---- 大きな建物の正面玄関: ひさしを支える柱、ガラスの風除室、両脇の光る柱 ----
    if (big) {
      const cw = Math.min(12, b.w * 0.3), front = b.z - b.d / 2, yb = b.base;
      for (let sd = -1; sd <= 1; sd += 2) {
        const pu = b.u + sd * (cw / 2 - 0.4), g0 = COL.groundH(COL.landTheta(i, pu), front - 3.2);
        bag.add('box', i, pu, front - 3.2, g0 - 0.1, 0.42, yb + 4.4 - g0 + 0.1, 0.42, [0.62, 0.63, 0.66], 3, 63);
        bag.add('box', i, b.u + sd * (cw / 2 + 1.2), front - 0.5, g0 - 0.1, 0.5, 3.4, 0.5, DARK, 3, 63);
        bag.add('box', i, b.u + sd * (cw / 2 + 1.2), front - 0.78, g0 + 0.5, 0.3, 2.6, 0.06, [1.0, 0.92, 0.75], 5, 0, 0.8);
      }
      bag.add('box', i, b.u, front - 0.9, b.base - 0.05, Math.min(5, cw * 0.6), 3.0, 1.7, GLASSR, 3, 64);
      bag.add('box', i, b.u, front - 0.9, b.base + 2.95, Math.min(5, cw * 0.6) + 0.3, 0.16, 2.0, [0.30, 0.31, 0.33], 3, 64);
    }
  }
  function emitFacade(i, b, bag, r) {
    const fin = (b.arche === 'office' || b.arche === 'mid') && r() < 0.45;
    emitOrnament(i, b, bag, fin);
    const pc = pick(PARAPET, r()), front = r() < 0.5 ? 1 : -1;
    b.M.forEach(function (m) {
      if (!m.solid || m.kind !== 'box') return;
      const y0 = b.base + m.y, cu = b.u + m.ox, cz = b.z + m.oz;
      if (m.style === 1 && m.glow > 0 && m.h > 5) {
        // 階ごとの床（スラブ）と手すり壁。表は手すりの色を変え、住戸の仕切りを入れる。裏は共用廊下
        const nf = Math.floor(m.h / 3.1 + 0.01), ax = m.glow;
        if (nf < 2) return;
        const len = ax === 1 ? m.w : m.d, depth = ax === 1 ? m.d : m.w, bl = len - 1.6, off = depth / 2 + 0.7;
        for (let sd = -1; sd <= 1; sd += 2) {
          const isFront = sd === front || b.arche === 'hotel';
          const put = function (along, out, y, sl, sh, so, col, seed) {
            if (ax === 1) bag.add('box', i, cu + along, cz + sd * out, y, sl, sh, so, col, 3, seed);
            else bag.add('box', i, cu + sd * out, cz + along, y, so, sh, sl, col, 3, seed);
          };
          for (let k = 1; k < nf; k++) {
            const y = y0 + k * 3.1;
            put(0, off, y - 0.2, bl, 0.2, 1.4, SLAB, 30);
            put(0, off + 0.64, y, bl, isFront ? 1.05 : 1.15, 0.12, isFront ? pc : SLAB, 31);
          }
          if (isFront) {
            const n = Math.max(1, Math.round(bl / 8.4));
            for (let j = 0; j <= n; j++) put(-bl / 2 + bl * j / n, off - 0.075, y0 + 2.9, 0.16, (nf - 2) * 3.1 + 2.6, 1.25, SLAB, 32);
          }
        }
      }
      if (fin && m.style === 0 && m.h > 15 && m !== b.clearView) {
        // 縦のルーバー: 窓のマスの境目（3m ごと）に（ホテルの部屋のある段は、景色が見えるよう付けない）
        for (let face = 0; face < 4; face++) {
          const alongX = face < 2, sd = face % 2 ? 1 : -1, len = alongX ? m.w : m.d, off = (alongX ? m.d : m.w) / 2 + 0.3;
          for (let x = -Math.floor((len / 2 - 0.45) / 3) * 3; x <= len / 2 - 0.45; x += 3) {
            if (alongX) bag.add('box', i, cu + x, cz + sd * off, y0, 0.22, m.h - 0.7, 0.6, FINC, 3, 35);
            else bag.add('box', i, cu + sd * off, cz + x, y0, 0.6, m.h - 0.7, 0.22, FINC, 3, 35);
          }
        }
      }
    });
  }

  // ---- 戸建ての作り込み（近くだけ）: 玄関・室外機・ベランダ・塀か生垣・太陽光パネル・庭木 ----
  const DOORC = [[0.34, 0.23, 0.15], [0.22, 0.22, 0.24], [0.56, 0.43, 0.30], [0.72, 0.72, 0.70], [0.42, 0.18, 0.14]];
  const BLOCKW = [0.73, 0.72, 0.69], PANEL = [0.11, 0.15, 0.28];
  function emitHouse(plan, b, bag, r, tk, carSide) {
    const i = plan.i, gy = function (u, z) { return COL.groundH(COL.landTheta(i, u), z); };
    const fz = b.z >= plan.cz ? 1 : -1, zf = b.z + fz * b.d / 2;              // 正面（街区の外側＝道路側）
    // 玄関: ドア、ひさし、明かり、段
    const doorU = b.u + (r() - 0.5) * Math.max(0, b.w - 3.5);
    bag.add('box', i, doorU, zf + fz * 0.04, b.base + 0.45, 0.95, 2.05, 0.1, pick(DOORC, r()), 3, 40);
    bag.add('box', i, doorU, zf + fz * 0.5, b.base + 2.75, 1.7, 0.1, 1.0, r() < 0.5 ? DARK : [0.86, 0.86, 0.84], 3, 41);
    bag.add('box', i, doorU + 0.75, zf + fz * 0.06, b.base + 2.2, 0.14, 0.2, 0.1, [1.0, 0.88, 0.62], 5, 0, 1.2);
    const sz = zf + fz * 0.6, sg = gy(doorU, sz);
    bag.add('box', i, doorU, sz, sg - 0.1, 1.6, Math.max(0.2, b.base + 0.45 - sg + 0.1), 1.1, [0.66, 0.65, 0.62], 3, 42);
    // 室外機
    const sx = r() < 0.5 ? -1 : 1, acz = b.z + (r() - 0.5) * b.d * 0.5, acu = b.u + sx * (b.w / 2 + 0.22);
    bag.add('box', i, acu, acz, gy(acu, acz), 0.3, 0.62, 0.82, [0.90, 0.90, 0.87], 3, 43);
    if (b.arche === 'houseA') {
      // 2階のベランダ
      if (r() < 0.55) {
        const bw = Math.min(b.w - 1.2, 3.5 + r() * 3), bu = b.u + (r() - 0.5) * (b.w - bw - 1);
        bag.add('box', i, bu, zf + fz * 0.55, b.base + 2.65, bw, 0.15, 1.1, [0.80, 0.80, 0.78], 3, 44);
        bag.add('box', i, bu, zf + fz * 1.08, b.base + 2.8, bw, 1.0, 0.06, r() < 0.5 ? [0.30, 0.31, 0.33] : [0.72, 0.80, 0.84], 3, 45);
      }
      // 太陽光パネル: 正面側の屋根の斜面に
      if (r() < 0.35) {
        const g = b.M[1], rh = g.h, p = Math.atan2(rh, g.d / 2), pl = Math.min(g.w * 0.62, 6.5), pw = Math.hypot(rh, g.d / 2) * 0.55, py = b.base + 5.6 + rh / 2 + 0.12;
        if (!g.yaw) addTilted(bag, 'box', i, b.u, b.z + fz * g.d / 4, py, pl, 0.06, pw, fz > 0 ? Math.PI : 0, p, PANEL, 3, 48);
        else { const s2 = r() < 0.5 ? 1 : -1; addTilted(bag, 'box', i, b.u + s2 * g.d / 4, b.z, py, pl, 0.06, pw, -s2 * Math.PI / 2, p, PANEL, 3, 48); }
      }
    } else {
      // 陸屋根の家: 下の屋根の空いた所はルーフバルコニー（ガラスの手すり）、上に太陽光パネル
      bag.add('box', i, b.u + b.w * 0.31, zf - fz * 0.1, b.base + 3.5, b.w * 0.36, 1.0, 0.06, [0.72, 0.82, 0.86], 3, 45);
      if (r() < 0.35) addTilted(bag, 'box', i, b.u - b.w * 0.19, b.z, b.base + 6.95, b.w * 0.45, 0.06, b.d * 0.4, fz > 0 ? Math.PI : 0, 0.25, PANEL, 3, 48);
    }
    // 塀か生垣: 道路側と両脇。門と、車のある側の出入り口は空ける
    const half = b.w / 2 + 3.6, fzz = b.z + fz * (b.d / 2 + 3.0), back = b.z - fz * (b.d / 2 + 1.0), hedge = r() < 0.5;
    const seg = function (u, z, lu, lz) {
      const g0 = gy(u, z);
      if (hedge) bag.add('hedge', i, u, z, g0 - 0.1, Math.max(lu, 0.7), 1.05, Math.max(lz, 0.7), [1, 1, 1], 0, 0);
      else {
        bag.add('box', i, u, z, g0 - 0.1, Math.max(lu, 0.15), 1.25, Math.max(lz, 0.15), BLOCKW, 3, 46);
        bag.add('box', i, u, z, g0 + 1.15, Math.max(lu, 0.15) + 0.06, 0.08, Math.max(lz, 0.15) + 0.06, [0.62, 0.61, 0.58], 3, 47);
      }
    };
    let pieces = [[b.u - half, b.u + half]];
    const cutOut = function (a, c) {
      const out = [];
      pieces.forEach(function (p) { if (c <= p[0] || a >= p[1]) out.push(p); else { if (a > p[0]) out.push([p[0], a]); if (c < p[1]) out.push([c, p[1]]); } });
      pieces = out;
    };
    cutOut(doorU - 1.4, doorU + 1.4);
    if (carSide) { const cu2 = b.u + carSide * (b.w / 2 + 2.2); cutOut(cu2 - 1.8, cu2 + 1.8); }
    pieces.forEach(function (p) { if (p[1] - p[0] > 0.5) seg((p[0] + p[1]) / 2, fzz, p[1] - p[0], 0); });
    const sl = Math.abs(fzz - back);
    seg(b.u - half, (fzz + back) / 2, 0, sl);
    seg(b.u + half, (fzz + back) / 2, 0, sl);
    // 庭の低木
    for (let k = 0; k < 2; k++) {
      const su = b.u + (carSide ? -carSide : (k ? 1 : -1)) * (b.w / 2 + 1.6), szz = fzz - fz * (1.0 + 2.5 * k);
      addShrub(bag, r, i, su, szz, 0.8);
    }
    // ---- 追加の作り込み: 出窓・煙突・ウッドデッキ・カーポート・門柱の明かり・郵便受け ----
    const q2 = COL.rng(Math.floor(b.seed * 1e6) + 333), WOOD = [0.50, 0.37, 0.25], TRIM = [0.93, 0.93, 0.91];
    // 出窓（玄関から離れた側の正面）
    if (b.w > 7 && q2() < 0.6) {
      const bu = b.u + (doorU > b.u ? -1 : 1) * Math.min(b.w / 2 - 1.6, Math.abs(doorU - b.u) + 2.6);
      if (Math.abs(bu - doorU) > 2.1) {
        bag.add('box', i, bu, zf + fz * 0.30, b.base + 1.25, 2.3, 1.75, 0.6, TRIM, 3, 50);
        bag.add('box', i, bu, zf + fz * 0.34, b.base + 1.42, 1.95, 1.40, 0.6, [0.40, 0.55, 0.66], 3, 50);
        bag.add('box', i, bu, zf + fz * 0.36, b.base + 1.42, 0.07, 1.40, 0.6, TRIM, 3, 50);
        bag.add('box', i, bu, zf + fz * 0.38, b.base + 3.0, 2.6, 0.12, 0.85, [0.30, 0.31, 0.33], 3, 50);
        bag.add('box', i, bu, zf + fz * 0.42, b.base + 0.95, 2.1, 0.28, 0.36, WOOD, 3, 50);
        bag.add('shrub', i, bu, zf + fz * 0.44, b.base + 1.05, 0.34, 0.3, 0.2, [1.3, 0.8, 0.7], 0, 0, 0, 0, 0);
      }
    }
    // 煙突（切妻屋根の家）
    if (b.arche === 'houseA' && q2() < 0.4) {
      const g = b.M[1];
      bag.add('box', i, b.u + (q2() - 0.5) * b.w * 0.5, b.z - fz * b.d * 0.12, b.base + 5.6 + g.h * 0.35, 0.75, g.h * 0.65 + 0.9, 0.75, [0.56, 0.36, 0.30], 3, 51);
    }
    // 裏庭のウッドデッキと手すり、日よけの屋根
    if (q2() < 0.5) {
      const dw = Math.min(b.w * 0.6, 5.5), dz = b.z - fz * (b.d / 2 + 1.5), du = b.u + (q2() - 0.5) * (b.w - dw), g0 = gy(du, dz);
      bag.add('box', i, du, dz, g0 - 0.1, dw, Math.max(0.3, b.base + 0.4 - g0 + 0.1), 2.8, WOOD, 3, 52);
      bag.add('box', i, du, dz - fz * 1.36, b.base + 0.4, dw, 0.9, 0.06, [0.42, 0.31, 0.21], 3, 52);
      if (q2() < 0.5) {
        bag.add('box', i, du, dz, b.base + 2.9, dw + 0.3, 0.1, 3.0, TRIM, 3, 52);
        for (let k = 0; k < 2; k++) bag.add('box', i, du + (k ? 1 : -1) * (dw / 2 - 0.1), dz - fz * 1.3, b.base + 0.4, 0.12, 2.5, 0.12, TRIM, 3, 52);
      }
    }
    // カーポート（車のある家）
    if (carSide && q2() < 0.65) {
      const cu2 = b.u + carSide * (b.w / 2 + 2.2), g0 = gy(cu2, b.z);
      bag.add('box', i, cu2, b.z, g0 + 2.35, 3.3, 0.1, 6.6, [0.80, 0.84, 0.86], 3, 53);
      bag.add('box', i, cu2, b.z, g0 + 2.25, 3.4, 0.1, 0.12, [0.30, 0.31, 0.33], 3, 53);
      for (let k = 0; k < 4; k++) bag.add('box', i, cu2 + carSide * 1.5, b.z + (k - 1.5) * 2.0, g0 - 0.1, 0.12, 2.5, 0.12, [0.30, 0.31, 0.33], 3, 53);
    }
    // 門柱と明かり、郵便受け
    for (let k = -1; k <= 1; k += 2) {
      const gu = doorU + k * 1.4, g0 = gy(gu, fzz);
      bag.add('box', i, gu, fzz, g0 - 0.1, 0.38, 1.55, 0.38, hedge ? [0.70, 0.69, 0.66] : BLOCKW, 3, 54);
      bag.add('box', i, gu, fzz, g0 + 1.45, 0.24, 0.24, 0.24, [1.0, 0.88, 0.62], 5, 0, 1.0);
    }
    bag.add('box', i, doorU + 1.4, fzz + fz * 0.24, gy(doorU + 1.4, fzz) + 0.75, 0.36, 0.26, 0.12, [0.70, 0.16, 0.14], 3, 55);
  }

  // 建物まわりの細かい物（屋上の設備、アンテナ、入口のひさし、広場の木）
  function emitDetail(plan, bag) {
    const i = plan.i, r = COL.rng(Math.floor(plan.seed * 1e9));
    const tk = plan.palm ? 'palm' : 'broad';
    plan.b.forEach(function (b) {
      emitFacade(i, b, bag, r);
      if (!BIGARCH[b.arche]) return;
      let top = null;
      b.M.forEach(function (m) { if (m.solid) top = m; });
      const y = b.base + top.y + top.h, k = top.kind === 'cyl' ? 0.30 : top.kind === 'taper' ? 0.22 : 0.42;
      if (b.arche !== 'sf') {
        const n = 2 + Math.floor(r() * 4);
        for (let q = 0; q < n; q++) {
          const s = 2 + r() * 4;
          bag.add('box', i, b.u + (r() * 2 - 1) * top.w * k * 0.8, b.z + (r() * 2 - 1) * top.d * k * 0.8, y, s, 1.4 + r() * 2.4, 2 + r() * 3, GREY, 3, q);
        }
        // 屋上の縁の立ち上がり
        if (top.kind === 'box') {
          const hw = top.w / 2, hd = top.d / 2;
          bag.add('box', i, b.u, b.z - hd + 0.2, y, top.w, 1.1, 0.4, GREY, 3, 7);
          bag.add('box', i, b.u, b.z + hd - 0.2, y, top.w, 1.1, 0.4, GREY, 3, 7);
          bag.add('box', i, b.u - hw + 0.2, b.z, y, 0.4, 1.1, top.d - 0.8, GREY, 3, 7);
          bag.add('box', i, b.u + hw - 0.2, b.z, y, 0.4, 1.1, top.d - 0.8, GREY, 3, 7);
        }
        if (b.arche === 'resi') {
          bag.add('cyl', i, b.u + top.w * 0.2, b.z, y, 3.2, 3.6, 3.2, [0.72, 0.74, 0.76], 3, 3);
          bag.add('cyl', i, b.u - top.w * 0.2, b.z, y, 3.2, 3.6, 3.2, [0.72, 0.74, 0.76], 3, 3);
        }
        if (b.arche === 'office' && b.h > 90) {
          const ah = 14 + r() * 24;
          bag.add('box', i, b.u, b.z, y, 0.5, ah, 0.5, DARK, 3, 4);
          bag.add('box', i, b.u, b.z, y + ah, 0.9, 0.9, 0.9, [1.0, 0.15, 0.10], 5, 0, 2.0);
        }
      }
      // 入口のひさしと、足元の明かり
      const front = b.z - b.d / 2 - 1.6;
      bag.add('box', i, b.u, front, b.base + 4.4, Math.min(12, b.w * 0.3), 0.35, 4.0, DARK, 3, 5);
      bag.add('box', i, b.u, front - 1.9, b.base + 4.2, Math.min(12, b.w * 0.3), 0.15, 0.15, [1.0, 0.9, 0.7], 5, 0, 1.4);
      for (let sd = -1; sd <= 1; sd += 2) {
        const pu = b.u + sd * (Math.min(12, b.w * 0.3) / 2 + 4.0), pz = b.z - b.d / 2 - 0.9, g0 = COL.groundH(COL.landTheta(i, pu), pz);
        bag.add('box', i, pu, pz, g0 - 0.2, 5.5, 0.75, 1.6, [0.66, 0.65, 0.62], 3, 34);
        bag.add('hedge', i, pu, pz, g0 + 0.5, 5.0, 0.7, 1.2, [1, 1, 1], 0, 0);
      }
    });
    if (plan.type === 'tower') {
      // 塔のまわりの広場: 四辺の並木と植え込み
      for (let q = 0; q < 16; q++) {
        const a = q / 16 * TAU, e = 45 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
        addTree(bag, r, i, plan.cu + Math.cos(a) * e, plan.cz + Math.sin(a) * e, 'broad', 0.85);
      }
      for (let q = 0; q < 4; q++) {
        const u = plan.cu + (q & 1 ? 40 : -40), z = plan.cz + (q & 2 ? 40 : -40);
        bag.add('cyl', i, u, z, COL.groundH(COL.landTheta(i, u), z) - 0.2, 7, 0.75, 7, [0.70, 0.69, 0.66], 3, 6);
        bag.add('cyl', i, u, z, COL.groundH(COL.landTheta(i, u), z) + 0.5, 6.2, 0.12, 6.2, [0.30, 0.52, 0.24], 3, 6);
        const gp = COL.groundH(COL.landTheta(i, u), z) + 0.6;
        addShrub(bag, r, i, u, z, 1.2, gp);
        for (let k = 0; k < 4; k++) addShrub(bag, r, i, u + Math.cos(k * 1.57 + 0.4) * 2.0, z + Math.sin(k * 1.57 + 0.4) * 2.0, 0.8, gp);
      }
    } else if (plan.type === 'park') {
      const u0 = plan.cu, z0 = plan.cz, y0 = COL.groundH(COL.landTheta(i, u0), z0);
      // 中央の広場と噴水
      bag.add('cyl', i, u0, z0, y0 - 0.9, 34, 1.0, 34, [0.74, 0.72, 0.67], 3, 8);
      bag.add('cyl', i, u0, z0, y0, 15, 0.85, 15, [0.80, 0.79, 0.76], 3, 9);
      bag.add('cyl', i, u0, z0, y0 + 0.3, 13.6, 0.5, 13.6, [0.25, 0.55, 0.70], 5, 0, 0.25);
      bag.add('cyl', i, u0, z0, y0, 2.4, 2.6, 2.4, [0.80, 0.79, 0.76], 3, 9);
      bag.add('cone', i, u0, z0, y0 + 2.6, 1.6, 3.2, 1.6, [0.85, 0.95, 1.0], 5, 0, 0.5);
      for (let q = 0; q < 8; q++) {
        const a = q / 8 * TAU + 0.39;
        addBench(bag, i, u0 + Math.cos(a) * 13.5, z0 + Math.sin(a) * 13.5, -a + Math.PI / 2);
      }
      // 花壇
      const FL = [[0.90, 0.25, 0.30], [0.98, 0.80, 0.20], [0.95, 0.55, 0.75], [0.60, 0.40, 0.85]];
      for (let q = 0; q < 4; q++) {
        const u = u0 + (q & 1 ? 25 : -25), z = z0 + (q & 2 ? 25 : -25), y = COL.groundH(COL.landTheta(i, u), z);
        bag.add('cyl', i, u, z, y - 0.3, 9, 0.7, 9, [0.62, 0.58, 0.50], 3, 10);
        bag.add('dome', i, u, z, y + 0.35, 8.2, 2.2, 8.2, FL[q], 3, 11);
        addLamp(bag, i, u0 + (q & 1 ? 17 : -17), z0 + (q & 2 ? 17 : -17), 0, 0, 4.2);
      }
      for (let sdd = 0; sdd < 4; sdd++) for (let hh = -1; hh <= 1; hh += 2) {
        const along = hh * 27.5, edge = sdd % 2 ? 47.5 : -47.5;
        const u = sdd < 2 ? u0 + along : u0 + edge, z = sdd < 2 ? z0 + edge : z0 + along;
        bag.add('hedge', i, u, z, COL.groundH(COL.landTheta(i, u), z) - 0.15, sdd < 2 ? 39 : 0.9, 1.0, sdd < 2 ? 0.9 : 39, [1, 1, 1], 0, 0);
      }
      for (let q = 0; q < 18; q++) {
        const u = u0 + (r() * 2 - 1) * 44, z = z0 + (r() * 2 - 1) * 44;
        if (Math.hypot(u - u0, z - z0) > 19) addShrub(bag, r, i, u, z, 1.0);
      }
      for (let q = 0; q < 46; q++) {
        const u = u0 + (r() * 2 - 1) * 47, z = z0 + (r() * 2 - 1) * 47;
        if (Math.hypot(u - u0, z - z0) < 21 || (Math.abs(Math.abs(u - u0) - 25) < 6 && Math.abs(Math.abs(z - z0) - 25) < 6)) continue;
        addTree(bag, r, i, u, z, tk, 1.1);
      }
    } else if (plan.type === 'bank') {
      // 川岸の緑地: 水際を避けて木立とベンチ
      for (let q = 0; q < 26; q++) {
        const u = plan.cu + (r() * 2 - 1) * 48, z = plan.cz + (r() * 2 - 1) * 48, d = COL.waterSdf(i, u, z);
        if (d < 9) continue;
        if (d < 16 && q % 3 === 0) addBench(bag, i, u, z, r() * TAU); else addTree(bag, r, i, u, z, 'broad', 1.15);
      }
    } else {
      emitBlockExtras(plan, bag, r, tk);
    }
  }

  function addCar(bag, r, i, u, z, yaw) {
    const y = COL.groundH(COL.landTheta(i, u), z);
    const rv = r();
    const kd = (rv * CARC.length) % 1;
    bag.add(kd < 0.30 ? 'carB' : kd < 0.52 ? 'carC' : 'carA', i, u, z, y, 1, 1, 1, pick(CARC, rv), 8, Math.floor(rv * 97), 0, 0, yaw);
  }
  // 中心市街以外の街区の細かい物: 庭木、車、プール、校庭、配管など
  function emitBlockExtras(plan, bag, r, tk) {
    const i = plan.i, t = plan.type, cu = plan.cu, cz = plan.cz;
    const gy = function (u, z) { return COL.groundH(COL.landTheta(i, u), z); };
    if (t === 'houses' || t === 'villas') {
      plan.b.forEach(function (b) {
        const sd = r() < 0.5 ? -1 : 1, car = r() < 0.55;
        if (r() < 0.8) addTree(bag, r, i, b.u + sd * (b.w / 2 + 1.8 + r() * 1.2), b.z + (r() - 0.5) * 6, tk, 0.55);
        if (car) addCar(bag, r, i, b.u - sd * (b.w / 2 + 2.2), b.z + (r() - 0.5) * 3, 0);
        emitHouse(plan, b, bag, r, tk, car ? -sd : 0);
        if (t === 'villas') bag.add('box', i, b.u + sd * 2, b.z - b.d / 2 - 5, gy(b.u + sd * 2, b.z - b.d / 2 - 5) - 0.1, 8, 0.3, 4, [0.20, 0.60, 0.80], 5, 0, 0.25);
      });
      return;
    }
    if (t === 'yard') {
      for (let k = 0; k < 3; k++) if (r() < 0.6) {
        const u = cu - 30 + k * 30 + 8, z = cz + (r() - 0.5) * 60, y = gy(u, z);
        bag.add('box', i, u, z, y + 0.6, 2.6, 2.9, 9, WHITE, 3, 2);
        bag.add('box', i, u, z - 5.7, y + 0.6, 2.5, 2.4, 2.2, pick(CARC, r()), 3, 2);
      }
      return;
    }
    // 街区の縁の木
    const ntree = (t === 'factory' || t === 'warehouse' || t === 'tanks') ? 6 : 14;
    for (let q = 0; q < ntree; q++) {
      const a = (q + r() * 0.6) / ntree * TAU, e = 46 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      addTree(bag, r, i, cu + Math.cos(a) * e, cz + Math.sin(a) * e, tk, 0.85);
    }
    if (t === 'shops' || t === 'apart' || t === 'mall' || t === 'hospital' || t === 'school') {
      // 駐車場の車（建物と重ならない場所だけ）
      const zs = t === 'shops' ? [cz - 8, cz + 8] : [cz - 46, cz + 46];
      zs.forEach(function (z) {
        for (let k = 0; k < 13; k++) {
          const u = cu - 39 + k * 6.5;
          if (r() < 0.6 && COL.solidTop(COL.landTheta(i, u), z, 1e6) < -1e8) addCar(bag, r, i, u, z, 0);
        }
      });
    }
    if (t === 'school') {
      const u = cu + 6, z = cz - 2, y = gy(u, z);
      bag.add('cyl', i, u, z, y - 0.7, 46, 0.8, 64, [0.66, 0.38, 0.28], 3, 3);
      bag.add('cyl', i, u, z, y - 0.7, 36, 0.85, 54, [0.30, 0.58, 0.26], 3, 3);
    } else if (t === 'hotel' && plan.palm) {
      const u = cu, z = cz - 32, y = gy(u, z);
      bag.add('box', i, u, z, y - 0.7, 34, 0.8, 16, [0.86, 0.84, 0.78], 3, 4);
      bag.add('box', i, u, z, y - 0.7, 28, 0.85, 11, [0.20, 0.62, 0.82], 5, 0, 0.25);
      for (let k = 0; k < 6; k++) {
        bag.add('cyl', i, u - 15 + k * 6, z - 9, y - 0.2, 0.08, 2.7, 0.08, WHITE, 3, 16);
        bag.add('cone', i, u - 15 + k * 6, z - 9, y + 2.1, 3.4, 0.7, 3.4, pick(PARASOL, r()), 3, 17);
      }
    } else if (t === 'tanks') {
      const y = gy(cu, cz);
      bag.add('box', i, cu, cz + 12, y + 1.0, 80, 0.7, 0.7, GREY, 3, 5);
      for (let k = 0; k < 3; k++) bag.add('box', i, cu - 32 + k * 30, cz + 14, y + 1.0, 0.7, 0.7, 5, GREY, 3, 5);
      bag.add('box', i, cu - 9, cz - 6, y + 1.0, 0.7, 0.7, 36, GREY, 3, 5);
    } else if (t === 'factory' || t === 'warehouse') {
      for (let k = 0; k < 3; k++) if (r() < 0.7) {
        const u = cu - 36 + k * 9, z = cz - 45, y = gy(u, z);
        bag.add('box', i, u, z, y + 0.6, 2.6, 2.9, 9, WHITE, 3, 2, 0, 0, Math.PI / 2);
        bag.add('box', i, u - 5.7, z, y + 0.6, 2.2, 2.4, 2.5, pick(CARC, r()), 3, 2);
      }
    }
  }

  // ---- 街区の外: 森・草原・山・公園ゾーン・農地の木 ----
  const NATURE = { forest: 0.5, meadow: 0.025, mountain: 0.10, park: 0.16, farm: 0.006 };
  function emitNature(i, cu, cz, bag, r) {
    const u0 = cu * 250, z0 = cz * 250;
    let any = false;
    for (let k = 0; k < 9 && !any; k++) if (NATURE[COL.zoneOf(i, u0 + (k % 3) * 125, z0 + Math.floor(k / 3) * 125)]) any = true;
    if (!any) return;
    for (let a = 0; a < 250; a += 12.5) for (let b = 0; b < 250; b += 12.5) {
      const u = u0 + a + r() * 9, z = z0 + b + r() * 9, v = r();
      if (Math.abs(u) > COL.LAND_HW - 30 || z < COL.TERRAIN_Z0 + 60 || z > COL.L - 10) continue;
      const zone = COL.zoneOf(i, u, z);
      let dens = NATURE[zone];
      if (!dens) continue;
      if (zone === 'park') dens *= COL.noise2(u / 90, z / 90, 71) > 0.45 ? 1.7 : 0.12;
      else if (zone === 'forest') dens *= 0.55 + 0.9 * COL.noise2(u / 160, z / 160, 72);
      if (v > dens || COL.waterSdf(i, u, z) < 6) continue;
      if (zone === 'mountain' && COL.groundH(COL.landTheta(i, u), z) > 300) continue;
      const con = (zone === 'forest' || zone === 'mountain') && COL.noise2(u / 220, z / 220, 73) + (zone === 'mountain' ? 0.25 : 0) > 0.45;
      addTree(bag, r, i, u, z, con ? 'conifer' : 'broad', con ? 1.35 : 1.15);
    }
  }

  // 道路ぞいの街灯と並木（区画の中を通る線のぶん）
  function emitStreets(i, cu, cz, bag, r) {
    const u0 = cu * 250, z0 = cz * 250;
    for (let a = 0; a < 2; a++) {
      const ave = a === 0, hw = ave ? 9 : 5;
      // z 方向へ走る道（u = 一定）と、u 方向へ走る道（z = 一定）
      for (let dir = 0; dir < 2; dir++) {
        const line = (dir === 0 ? u0 : z0) + a * B, start = dir === 0 ? z0 : u0;
        for (let s = 3; s < 250; s += 7) {
          const t = start + s, near = Math.abs(((t % B) + B) % B - B / 2);      // 交差点からの近さ（62.5 = 交差点の真上）
          if (near > B / 2 - 15) continue;
          const lampHere = s % 42 === 3, treeHere = ave && s % 14 === 10;
          if (!lampHere && !treeHere) continue;
          const side = lampHere ? ((Math.floor(s / 42) + a) % 2 ? 1 : -1) : 0;
          for (let sd = -1; sd <= 1; sd += 2) {
            if (lampHere && sd !== side) continue;
            const off = sd * (hw + (lampHere ? 1.2 : 2.3));
            const u = dir === 0 ? line + off : t, z = dir === 0 ? t : line + off;
            if (!COL.isUrban(i, u, z)) continue;
            if (lampHere) addLamp(bag, i, u, z, dir === 0 ? -sd : 0, dir === 0 ? 0 : -sd, 8.5);
            else addTree(bag, r, i, u, z, 'broad', 0.75);
          }
        }
      }
    }
  }

  // ---- サンゴ礁: 浜辺の前の浅い海に、群落ごとにまとまって ----
  const CORAL_C = [[1.0, 0.45, 0.55], [0.98, 0.55, 0.25], [0.68, 0.38, 0.88], [0.98, 0.85, 0.35], [0.35, 0.82, 0.76], [0.92, 0.30, 0.32], [0.88, 0.82, 0.70], [0.45, 0.62, 0.98]];
  const CORAL_KIND = [['coralBrain', 0.15], ['coralBranch', 0.20], ['coralTable', 0.11], ['coralTube', 0.07], ['coralFan', 0.08], ['anemone', 0.06], ['rock', 0.08],
                      ['coralSoft', 0.08], ['coralLeaf', 0.09], ['clam', 0.02], ['seaweed', 0.06]];
  COL.reefAt = function (u, z) { return COL.fbm2(u / 38, z / 38, 3, 501); };   // 0〜1。大きいほどサンゴが多い（魚の群れも使う）
  function emitReef(i, cu, cz, bag, r) {
    if (i !== 0 || (cz + 1) * 250 < 24300) return;
    const u0 = cu * 250, z0 = cz * 250;
    if (COL.waterSdf(0, u0 + 125, z0 + 125) > 260) return;
    for (let a = 0; a < 250; a += 2.6) for (let b = 0; b < 250; b += 2.6) {
      const u = u0 + a + r() * 2.4, z = z0 + b + r() * 2.4, v = r(), v2 = r(), v3 = r(), v4 = r(), v5 = r(), v6 = r();
      if (Math.abs(u) > COL.LAND_HW - 200 || z > COL.L - 15) continue;
      const g = COL.groundH(COL.landTheta(0, u), z), dep = -g;
      if (dep < 1.0 || dep > 24 || COL.waterSdf(0, u, z) > -6) continue;
      if (v > Math.min(0.92, Math.max(0, COL.reefAt(u, z) - 0.47) * 6.0) * (dep < 2 ? 0.5 : 1)) continue;   // 群落の中ほど密に
      let kind = 'rock', acc = 0;
      for (let k = 0; k < CORAL_KIND.length; k++) { acc += CORAL_KIND[k][1]; if (v2 < acc) { kind = CORAL_KIND[k][0]; break; } }
      let s0 = 1;
      const s = (kind === 'coralTable' ? 0.7 + 1.0 * v3 : 0.55 + 1.0 * v3) * Math.min(1, dep / 2.6);   // 浅い所は小さく（海面から出ない）
      if (kind === 'rock') s0 = 0.6;
      if (kind === 'clam') s0 = 0.8;
      if (kind === 'coralLeaf') s0 = 0.65;
      const col = kind === 'rock' ? [0.74, 0.70, 0.62] : kind === 'anemone' ? [0.95, 0.80, 0.55] : kind === 'clam' ? [0.92, 0.90, 0.84]
                : kind === 'seaweed' ? [0.22 + 0.2 * v4, 0.62, 0.22] : pick(CORAL_C, v4);
      bag.add(kind, 0, u, z, g - 0.05, s * s0, s * s0 * (0.8 + 0.4 * v5), s * s0, col, 0, 0, 0, 0, v6 * TAU);
      // 大きなサンゴの足元には岩の土台を、まわりには小さなサンゴや海草を寄せる（大小が混ざった群落になる）
      if (kind !== 'rock' && kind !== 'seaweed' && s > 1.12) {
        bag.add('rock', 0, u + (v5 - 0.5) * 0.5, z + (v6 - 0.5) * 0.5, g - 0.25, s * 0.95, s * 0.55, s * 0.95, [0.62, 0.58, 0.52], 0, 0, 0, 0, v4 * TAU);
        const k2 = v5 < 0.35 ? 'coralBranch' : v5 < 0.6 ? 'coralLeaf' : v5 < 0.8 ? 'seaweed' : 'coralSoft';
        bag.add(k2, 0, u + Math.cos(v4 * TAU) * s * 0.9, z + Math.sin(v4 * TAU) * s * 0.9, g - 0.05, s * 0.4, s * 0.4, s * 0.4,
                k2 === 'seaweed' ? [0.25, 0.62, 0.22] : pick(CORAL_C, v6), 0, 0, 0, 0, v3 * TAU);
      }
    }
  }

  // ---- ビーチ: パラソルと寝椅子、ヤシの並木、桟橋 ----
  const PARASOL = [[0.92, 0.26, 0.22], [0.22, 0.52, 0.92], [0.97, 0.82, 0.22], [0.96, 0.96, 0.96], [0.20, 0.72, 0.62], [0.97, 0.52, 0.20]];
  let piers = null;
  function pierList() {
    if (piers) return piers;
    piers = [-640, 20, 650].map(function (u) {
      let z = 24500;
      while (COL.waterSdf(0, u, z) > 0 && z < 26500) z += 2;
      const p = { u: u, z0: z - 14, len: 150, top: 1.3 };
      addSolid(0, u - 2.5, u + 2.5, p.z0, p.z0 + p.len, p.top - 0.35, p.top);
      addSolid(0, u - 7, u + 7, p.z0 + p.len - 1, p.z0 + p.len + 13, p.top - 0.35, p.top);
      // 柵（ジャンプでも越えられないよう、見えている柵より高く判定する）
      const zA = p.z0, zB = p.z0 + p.len - 1, zC = p.z0 + p.len + 13, T = 0.2;
      const rail = function (u0, u1, z0, z1) { addSolid(0, u0, u1, z0, z1, p.top - 0.1, p.top + 3); };
      for (let sd = -1; sd <= 1; sd += 2) {
        rail(u + sd * 2.4 - T, u + sd * 2.4 + T, zA, zB);               // 通路の両側
        rail(u + sd * 7 - T, u + sd * 7 + T, zB, zC);                   // 先端の広場の両側
        rail(sd > 0 ? u + 2.4 : u - 7, sd > 0 ? u + 7 : u - 2.4, zB - T, zB + T);   // 広場の手前（通路の両脇）
      }
      rail(u - 7, u - 1.6, zC - T, zC + T); rail(u + 1.6, u + 7, zC - T, zC + T);   // 先端（まん中は飛込み板のために開ける）
      addSolid(0, u - 0.6, u + 0.6, zC - 0.3, zC + 4.2, p.top - 0.1, p.top + 0.12);   // 飛込み板
      return p;
    });
    return piers;
  }
  function emitPier(p, bag) {
    const i = 0, WOOD = [0.52, 0.40, 0.28], WHITE = [0.93, 0.93, 0.90], zc = p.z0 + p.len / 2, ze = p.z0 + p.len + 6;
    bag.add('box', i, p.u, zc, p.top - 0.35, 5, 0.35, p.len, WOOD, 3, 12);
    for (let s = 6; s < p.len; s += 12) for (let sd = -1; sd <= 1; sd += 2) {
      const z = p.z0 + s, g = COL.groundH(COL.landTheta(i, p.u + sd * 2.1), z) - 0.5;
      bag.add('cyl', i, p.u + sd * 2.1, z, g, 0.45, p.top - 0.3 - g, 0.45, [0.36, 0.30, 0.24], 3, 13);
    }
    for (let sd = -1; sd <= 1; sd += 2) {
      bag.add('box', i, p.u + sd * 2.4, zc, p.top + 1.0, 0.09, 0.09, p.len, WHITE, 3, 14);
      bag.add('box', i, p.u + sd * 2.4, zc, p.top + 0.5, 0.06, 0.06, p.len, WHITE, 3, 14);
      for (let s = 0; s <= p.len; s += 3) bag.add('box', i, p.u + sd * 2.4, p.z0 + s, p.top, 0.09, 1.05, 0.09, WHITE, 3, 14);
    }
    for (let s = 20; s < p.len; s += 30) {
      bag.add('box', i, p.u - 2.3, p.z0 + s, p.top, 0.16, 4.0, 0.16, DARK, 3, 1);
      bag.add('box', i, p.u - 2.3, p.z0 + s, p.top + 4.0, 0.5, 0.5, 0.5, [1.0, 0.88, 0.66], 5, 0, 1.6);
    }
    // 先端のあずまや
    bag.add('box', i, p.u, ze, p.top - 0.35, 14, 0.35, 14, WOOD, 3, 12);
    {
      const zB = p.z0 + p.len - 1, zC = p.z0 + p.len + 13, post = function (uu, zz) { bag.add('box', i, uu, zz, p.top, 0.09, 1.05, 0.09, WHITE, 3, 14); };
      const run = function (ua, ub, za, zb) {        // 手すり（上と中ほどの2本）と、3m ごとの支柱
        const uc = (ua + ub) / 2, zc2 = (za + zb) / 2, lu = Math.abs(ub - ua), lz = Math.abs(zb - za);
        bag.add('box', i, uc, zc2, p.top + 1.0, Math.max(lu, 0.09), 0.09, Math.max(lz, 0.09), WHITE, 3, 14);
        bag.add('box', i, uc, zc2, p.top + 0.5, Math.max(lu, 0.06), 0.06, Math.max(lz, 0.06), WHITE, 3, 14);
        const n = Math.max(1, Math.round(Math.max(lu, lz) / 3));
        for (let k = 0; k <= n; k++) post(ua + (ub - ua) * k / n, za + (zb - za) * k / n);
      };
      for (let sd = -1; sd <= 1; sd += 2) {
        run(p.u + sd * 7, p.u + sd * 7, zB, zC);
        run(sd > 0 ? p.u + 2.4 : p.u - 7, sd > 0 ? p.u + 7 : p.u - 2.4, zB, zB);
      }
      run(p.u - 7, p.u - 1.6, zC, zC); run(p.u + 1.6, p.u + 7, zC, zC);
      // 飛込み板: 先端に向かって少し反らせ、先の端に滑り止め
      bag.add('box', i, p.u, zC + 1.9, p.top, 1.2, 0.12, 4.5, [0.92, 0.93, 0.95], 3, 14);
      bag.add('box', i, p.u, zC + 3.7, p.top + 0.12, 1.2, 0.03, 1.0, [0.20, 0.55, 0.85], 3, 14);
      bag.add('box', i, p.u, zC - 0.2, p.top - 0.05, 1.0, 0.12, 0.9, [0.55, 0.56, 0.60], 3, 1);
    }
    for (let q = 0; q < 6; q++) {
      const a = q / 6 * TAU;
      bag.add('cyl', i, p.u + Math.cos(a) * 5.4, ze + Math.sin(a) * 5.4, p.top, 0.3, 3.4, 0.3, WHITE, 3, 14);
    }
    bag.add('cone', i, p.u, ze, p.top + 3.4, 13.5, 3.2, 13.5, [0.80, 0.34, 0.26], 3, 15);
    for (let s = 2; s < 14; s += 4) {
      const g = COL.groundH(COL.landTheta(i, p.u), ze) - 0.5;
      bag.add('cyl', i, p.u + (s - 7), ze + 4, g, 0.5, p.top - 0.3 - g, 0.5, [0.36, 0.30, 0.24], 3, 13);
      bag.add('cyl', i, p.u + (s - 7), ze - 4, g, 0.5, p.top - 0.3 - g, 0.5, [0.36, 0.30, 0.24], 3, 13);
    }
  }
  function emitBeach(i, cu, cz, bag, r) {
    if (i !== 0 || (cz + 1) * 250 < 24200) return;
    const u0 = cu * 250, z0 = cz * 250, dc = COL.waterSdf(0, u0 + 125, z0 + 125);
    if (dc > 330 || dc < -210) return;
    pierList().forEach(function (p) {
      if (Math.floor(p.u / 250) === cu && Math.floor((p.z0 + 20) / 250) === cz) emitPier(p, bag);
    });
    for (let a = 0; a < 250; a += 9) for (let b = 0; b < 250; b += 9) {
      const u = u0 + a + r() * 6, z = z0 + b + r() * 6, v = r(), v2 = r(), v3 = r();
      if (Math.abs(u) > COL.LAND_HW - 215 || z > COL.L - 12) continue;
      const d = COL.waterSdf(0, u, z);
      if (d < 12 || d > 125) continue;
      const th = COL.landTheta(0, u), y = COL.groundH(th, z);
      if (d < 60) {
        if (v > 0.16 || pierList().some(function (p) { return Math.abs(u - p.u) < 7; })) continue;
        // パラソル1本と寝椅子2つ
        const col = pick(PARASOL, v2), yaw = v3 * TAU;
        bag.add('cyl', i, u, z, y - 0.3, 0.08, 2.75, 0.08, [0.85, 0.85, 0.82], 3, 16);
        bag.add('cone', i, u, z, y + 2.05, 3.6, 0.75, 3.6, col, 3, 17);
        for (let sd = -1; sd <= 1; sd += 2) {
          const ou = Math.cos(yaw) * 0.9 * sd, oz = -Math.sin(yaw) * 0.9 * sd;
          bag.add('box', i, u + ou, z + oz, y + 0.22, 0.7, 0.10, 1.9, [0.96, 0.96, 0.94], 3, 18, 0, 0, yaw);
          bag.add('box', i, u + ou, z + oz, y, 0.6, 0.22, 1.6, [0.70, 0.60, 0.45], 3, 18, 0, 0, yaw);
        }
      } else if (v < (d < 92 ? 0.20 : 0.10)) {
        addTree(bag, r, 0, u, z, 'palm', 1.15);
      }
    }
  }

  // ================= 近くの区画だけ細かい物を出す =================
  const QUALITY = [
    // life: 住民・車・鳥・魚の数の割合 / res: 解像度の上限 / fx: 窓の部屋・水中の光の網目 / whales: クジラの有無
    // car: 車を細かい形で描く距離 / sres: 影の画像の細かさ / ultra: 細かな凹凸・映り込み・画面全体の仕上げ（js/post.js）
    { name: '最軽量', near: 260, shadow: 0, small: 400, life: 0.15, res: 0.5, fx: 0, whales: 0, far: 1000, tree: 90, car: 0, sres: 2048, ultra: 0 },
    { name: '低', near: 380, shadow: 0, small: 2200, life: 0.5, res: 1, fx: 1, whales: 1, far: 0, tree: 160, car: 0, sres: 2048, ultra: 0 },
    { name: '中', near: 650, shadow: 300, small: 3600, life: 1, res: 1, fx: 1, whales: 1, far: 0, tree: 210, car: 90, sres: 2048, ultra: 0 },
    { name: '高', near: 1000, shadow: 440, small: 6000, life: 1, res: 1, fx: 1, whales: 1, far: 0, tree: 210, car: 140, sres: 2048, ultra: 0 },
    { name: '最高', near: 1000, shadow: 440, small: 6000, life: 1, res: 1, fx: 1, whales: 1, far: 0, tree: 240, car: 200, sres: 2048, ultra: 1 },
  ];
  COL.QUALITIES = QUALITY;
  let qi = 2, sceneRef = null, rendererRef = null, tick = 1, started = false;
  COL.qualityName = function () { return QUALITY[qi].name + (QUALITY[qi].shadow ? '・影あり' : '・影なし'); };
  function applyQuality() {
    const Q = QUALITY[qi];
    U.ultra.value = Q.ultra; COL.postOn = !!Q.ultra; COL.carDist = Q.car;
    U.fx.value = Q.fx; COL.lifeScale = Q.life; COL.whalesOn = Q.whales; COL.resCap = Q.res;
    COL.drawFar = Q.far; COL.liteFog = Q.far ? 1.9 / Q.far : 0;              // 描く距離の端でほぼ霧になる濃さ
    if (COL.setClouds) COL.setClouds(!Q.far);
    if (COL.onQuality) COL.onQuality(Q);
  }
  COL.setQuality = function (n) { qi = Math.max(0, Math.min(QUALITY.length - 1, n)); tick = 1; applyQuality(); };
  COL.getQuality = function () { return qi; };
  COL.cycleQuality = function () { COL.setQuality((qi + 1) % QUALITY.length); };

  const chunks = new Map();          // 'i,cu,cz' → Group（中身が無い区画は null）
  const regionList = [];             // 建物の本体のまとまり（陸地 × 軸方向 1km）
  function makeChunk(i, cu, cz) {
    const bag = new Bag(), r = COL.rng((Math.imul(cu, 92837111) ^ Math.imul(cz, 689287499) ^ (i * 7919)) >>> 0);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const plan = planBlock(i, cu * 2 + a, cz * 2 + b);
      if (plan) emitDetail(plan, bag);
    }
    emitStreets(i, cu, cz, bag, r);
    emitBeach(i, cu, cz, bag, r);
    emitNature(i, cu, cz, bag, r);
    emitReef(i, cu, cz, bag, r);
    let any = false;
    for (const k in bag.k) any = true;
    if (!any) return null;
    const grp = new THREE.Group();
    grp.userData.lod = bag.build(grp, true);
    grp.children.forEach(function (m) { m.renderOrder = -20; });
    sceneRef.add(grp);
    return grp;
  }
  function stream(cam) {
    const Q = QUALITY[qi], c = COL.toCyl([cam.x, cam.y, cam.z]), want = new Map();
    let budget = started ? 2 : 60;
    for (let i = 0; i < 3; i++) {
      let du = c.theta - COL.landCenter(i);
      du = (du - Math.round(du / TAU) * TAU) * R;
      if (Math.abs(du) > COL.LAND_HW + Q.near) continue;
      for (let cu = Math.floor((du - Q.near) / 250); cu <= Math.floor((du + Q.near) / 250); cu++) {
        if (cu < -7 || cu > 6) continue;
        for (let cz = Math.floor((c.z - Q.near) / 250); cz <= Math.floor((c.z + Q.near) / 250); cz++) {
          const dist = Math.hypot(du - (cu + 0.5) * 250, c.z - (cz + 0.5) * 250, Math.max(0, c.h - 60));
          if (dist > Q.near) continue;
          const key = i + ',' + cu + ',' + cz;
          if (!chunks.has(key)) {
            if (budget <= 0) continue;
            budget--;
            chunks.set(key, makeChunk(i, cu, cz));
          }
          want.set(key, dist);
        }
      }
    }
    chunks.forEach(function (grp, key) {
      if (!grp) return;
      const dist = want.get(key);
      grp.visible = dist !== undefined;
      if (!grp.visible) return;
      grp.userData.dist = dist;
      // 木は 210m より先では簡略な形にする
      const lod = grp.userData.lod;
      for (let k = 0; k < lod.length; k++) { const lim = lod[k].car ? Q.car : lod[k].reef ? Math.min(Q.tree, 160) : Q.tree; lod[k].hi.visible = dist < lim; lod[k].lo.visible = dist >= lim; }
    });
    // 建物の本体は近いまとまりから先に描く（奥のまとまりの、隠れた画素を計算しないで済む）
    for (let k = 0; k < regionList.length; k++) {
      const g = regionList[k];
      let du = c.theta - COL.landCenter(g.i);
      du = (du - Math.round(du / TAU) * TAU) * R;
      g.dist = Math.hypot(Math.max(0, Math.abs(du) - COL.LAND_HW), c.z - g.z);
      // まとまりの一番近い所までの距離（最軽量で、描く距離より遠いまとまりを隠すのに使う）
      g.edge = Math.hypot(Math.max(0, Math.abs(du - g.u) - COL.LAND_HW / 3), Math.max(0, Math.abs(c.z - g.z) - 500), Math.max(0, c.h - 300));
      const ro = -10 + Math.min(9, Math.floor(g.dist / 500));
      for (let m = 0; m < g.grp.children.length; m++) g.grp.children[m].renderOrder = ro;
      for (let m = 0; m < g.small.children.length; m++) g.small.children[m].renderOrder = ro;
      g.small.visible = g.dist < Q.small;        // 戸建てなどの小さな建物は、遠くでは描かない
      g.grp.visible = !Q.far || g.edge < Q.far;
      if (!g.grp.visible) g.small.visible = false;
    }
    COL.updateTerrainLod(cam);
    started = true;
  }

  // ================= 影（近くの建物と木だけ） =================
  let shadowRT = null, shadowCam = null, depthMat = null;
  const _c = new THREE.Vector3(), _bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const _clear = new THREE.Color(), _swap = [];
  function renderShadow(camera) {
    const Q = QUALITY[qi], sun = U.sunCol.value;
    if (!Q.shadow || sun.r + sun.g + sun.b < 0.06) { U.shadowOn.value = 0; return; }
    const S = Q.shadow, p = camera.position;
    // 太陽（ミラー）の向き: world.js の sunDirAt と同じ式
    const k = Math.floor((Math.atan2(p.y, p.x) - COL.THETA0) / COL.STRIP), thc = COL.THETA0 + (k + 0.5) * COL.STRIP;
    const el = Math.round(U.sunElev.value / 0.004) * 0.004, cs = Math.cos(thc), sn = Math.sin(thc);
    const ld = [-cs * Math.sin(el), -sn * Math.sin(el), -Math.cos(el)], east = [-sn, cs, 0], w = COL.V.cross(ld, east);
    // 影の模様がちらつかないよう、撮る位置を1画素の大きさに丸める
    if (shadowRT.width !== Q.sres) shadowRT.setSize(Q.sres, Q.sres);
    U.shadowRes.value = Q.sres;
    const texel = 2 * S / Q.sres, P = [p.x, p.y, p.z];
    const ce = COL.V.dot(P, east), cw = COL.V.dot(P, w);
    const de = ce - Math.round(ce / texel) * texel, dw = cw - Math.round(cw / texel) * texel;
    _c.set(P[0] - east[0] * de - w[0] * dw, P[1] - east[1] * de - w[1] * dw, P[2] - east[2] * de - w[2] * dw);
    if (shadowCam.right !== S) {
      shadowCam.left = -S; shadowCam.right = S; shadowCam.top = S; shadowCam.bottom = -S;
      shadowCam.updateProjectionMatrix();
    }
    shadowCam.position.set(_c.x + ld[0] * 1200, _c.y + ld[1] * 1200, _c.z + ld[2] * 1200);
    shadowCam.up.set(east[0], east[1], east[2]);
    shadowCam.lookAt(_c);
    shadowCam.updateMatrixWorld();
    shadowCam.matrixWorldInverse.copy(shadowCam.matrixWorld).invert();
    U.shadowMat.value.copy(_bias).multiply(shadowCam.projectionMatrix).multiply(shadowCam.matrixWorldInverse);

    // 影の範囲から遠い区画・まとまりは、撮るあいだだけ隠す
    const hidden = [];
    chunks.forEach(function (grp) { if (grp && grp.visible && grp.userData.dist > S + 180) { grp.visible = false; hidden.push(grp); } });
    regionList.forEach(function (g) {
      if (g.dist <= S + 900) return;
      g.grp.visible = false; hidden.push(g.grp);
      if (g.small.visible) { g.small.visible = false; hidden.push(g.small); }
    });
    const bg = sceneRef.background, alpha = rendererRef.getClearAlpha();
    rendererRef.getClearColor(_clear);
    sceneRef.background = null;
    _swap.length = 0;
    sceneRef.traverseVisible(function (o) {
      if (!o.isMesh || !o.layers.test(shadowCam.layers)) return;
      _swap.push(o, o.material);
      o.material = o.material.userData.depth || (o.material.userData.leafy ? leafDepth : depthMat);
    });
    rendererRef.setRenderTarget(shadowRT);
    rendererRef.setClearColor(0xffffff, 1);
    rendererRef.clear();
    rendererRef.render(sceneRef, shadowCam);
    rendererRef.setRenderTarget(null);
    rendererRef.setClearColor(_clear, alpha);
    for (let k = 0; k < _swap.length; k += 2) _swap[k].material = _swap[k + 1];
    sceneRef.background = bg;
    for (let k = 0; k < hidden.length; k++) hidden[k].visible = true;
    U.shadowOn.value = 1;
  }

  COL.buildCity = function (scene, renderer) {
    sceneRef = scene; rendererRef = renderer;
    initParts(renderer);
    COL.CityKit = { Bag: Bag, UNIT: UNIT, MAT: MAT, cityVS: cityVS, cityFS: cityFS, GLOW: GLOW, CONT: CONT, addSolid: addSolid };
    // 建物の本体を全部作る（軸方向 1km ごとにまとめる）
    const regions = new Map(), BAND = 2 * COL.LAND_HW / 3;
    const reg = function (i, u, z) {
      const bu = Math.max(0, Math.min(2, Math.floor((u + COL.LAND_HW) / BAND)));
      const key = i + ',' + bu + ',' + Math.floor(z / 1000);
      if (!regions.has(key)) regions.set(key, { main: new Bag(), small: new Bag(), i: i, u: -COL.LAND_HW + (bu + 0.5) * BAND, z: Math.floor(z / 1000) * 1000 + 500 });
      return regions.get(key);
    };
    // 街区の建物
    for (let i = 0; i < 3; i++) for (let bz = 14; bz < 240; bz++) for (let bu = -14; bu < 14; bu++) {
      const plan = planBlock(i, bu, bz);
      if (!plan || !plan.b.length) continue;
      const g = reg(i, plan.cu, plan.cz);
      emitMajor(plan, plan.small ? g.small : g.main);
    }
    const HW = COL.LAND_HW;
    for (let i = 0; i < 3; i++) {
      // 農地: 温室のまとまりと農家
      for (let cz = 8; cz < 120; cz++) for (let cu = -7; cu < 7; cu++) {
        const u = cu * 250 + 125, z = cz * 250 + 125;
        if (Math.abs(u) > HW - 160 || COL.zoneOf(i, u, z) !== 'farm' || COL.waterSdf(i, u, z) < 70) continue;
        const h = COL.noise2(cu * 7.3 + 0.5, cz * 3.1 + 0.5, 333 + i), r = COL.rng((cu * 131 + cz * 7 + 99991) >>> 0), bag = reg(i, u, z).small;
        if (h < 0.22) {
          for (let k = 0; k < 6; k++) emitBuilding(i, makeBuilding(i, 'greenhouse', u, z - 35 + k * 14, 70, 10, 0, r()), bag);
        } else if (h < 0.30) {
          emitBuilding(i, makeBuilding(i, 'barn', u - 14, z, 16, 11, 0, r()), bag);
          emitBuilding(i, makeBuilding(i, 'houseA', u + 16, z + 6, 11, 8, 0, r()), bag);
        }
      }
      // 大気・気象制御塔: 陸地の両縁に2本ずつ
      [8000, 22000].forEach(function (z) {
        [-1, 1].forEach(function (sd) {
          const u = sd * (HW - 140);
          if (COL.waterSdf(i, u, z) > 40) emitBuilding(i, makeBuilding(i, 'wtower', u, z, 34, 34, 230, (z + sd + i) % 1000 / 1000), reg(i, u, z).main);
        });
      });
      // 橋: u 方向の道路が川・運河を横切る所
      for (let k = 15; k < 240; k++) {
        const z = k * B, hw = (k % 2 === 0 ? 9 : 5) + 3.2;
        let start = null;
        for (let u = -HW + 200; u <= HW - 200; u += 3) {
          const wet = COL.waterSdf(i, u, z) < 0;
          if (wet && start === null) start = u;
          if (!wet && start !== null) {
            const u0 = start - 9, u1 = u + 6;
            start = null;
            if (u1 - u0 > 130 || !COL.isUrban(i, u0 - 4, z) || !COL.isUrban(i, u1 + 4, z)) continue;
            const top = Math.max(COL.groundH(COL.landTheta(i, u0), z), COL.groundH(COL.landTheta(i, u1), z)) + 0.2, uc = (u0 + u1) / 2, len = u1 - u0;
            const bag = reg(i, uc, z).main;
            bag.add('box', i, uc, z, top - 1.1, len, 1.1, hw * 2, [0.24, 0.25, 0.27], 3, 21);
            for (let sd = -1; sd <= 1; sd += 2) {
              bag.add('box', i, uc, z + sd * (hw - 0.2), top, len, 1.1, 0.35, [0.78, 0.78, 0.76], 3, 22);
              bag.add('box', i, uc, z + sd * (hw - 1.9), top, len, 0.18, 3.0, [0.66, 0.65, 0.62], 3, 22);
            }
            for (let q = 1; q <= 2; q++) {
              const up = u0 + len * q / 3, g = COL.groundH(COL.landTheta(i, up), z) - 1;
              bag.add('cyl', i, up, z, g, 2.6, top - 1.0 - g, hw * 1.4, [0.60, 0.60, 0.58], 3, 23);
            }
            addSolid(i, u0, u1, z - hw, z + hw, top - 1.1, top);
          }
        }
      }
    }
    regions.forEach(function (g) {
      const grp = new THREE.Group(), small = new THREE.Group();
      g.main.build(grp, true);
      g.small.build(small, true);
      // 画面の外のまとまりは描かない（まとまり全体を包む球で判定）
      const c = COL.toWorld(COL.landTheta(g.i, g.u), g.z, 150), sphere = new THREE.Sphere(new THREE.Vector3(c[0], c[1], c[2]), 1000);
      grp.children.concat(small.children).forEach(function (m) { m.geometry.boundingSphere = sphere; m.frustumCulled = true; });
      scene.add(grp); scene.add(small);
      regionList.push({ grp: grp, small: small, i: g.i, u: g.u, z: g.z, dist: 0, edge: 0 });
    });
    pierList();

    shadowRT = new THREE.WebGLRenderTarget(2048, 2048, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 2600);
    shadowCam.layers.set(1);
    depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    U.shadowMap.value = shadowRT.texture;
  };

  COL.updateCity = function (dt, scene, camera) {
    if (COL.QUALITY_START !== undefined) { COL.setQuality(COL.QUALITY_START); COL.QUALITY_START = undefined; }
    tick += dt;
    if (tick > 0.15) { tick = 0; stream(camera.position); }
    renderShadow(camera);
  };
})();
