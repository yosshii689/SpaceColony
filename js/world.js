// コロニーの見た目を組み立てる
//  - 陸地3枚と窓3枚の外殻。窓の向こうはミラーに映った太陽と、自転で流れる星空
//  - 宇宙港側の端は山、反対側の端は全面ガラス
//  - 起伏のある地形（陸地3枚）と、海・湖・川の水面
//  - 霞・雲・昼夜
(function () {
  'use strict';
  const COL = window.COL;
  const R = COL.R, L = COL.L;

  COL.HAZE = 0.000138;              // 霞の濃さ（対岸 6.5km が半分ほどかすむ値）

  // 全シェーダー共通の値（毎フレーム COL.updateEnv が書き換える）
  const U = COL.U = {
    spin: { value: 0 },                              // 自転の角度（星空を回す）
    sunElev: { value: 1 },                           // 太陽の高さ [rad]（0=宇宙港側の地平, π/2=真上）
    mirrorTan: { value: 1 },                         // ミラーの開き角の tan
    sunVis: { value: 1 },                            // ミラーが太陽を映しているか
    sunCol: { value: new THREE.Color(1, 1, 1) },     // 太陽光の色と強さ
    ambCol: { value: new THREE.Color(0.5, 0.55, 0.65) }, // 環境光
    cloudT: { value: 0 },                            // 雲の流れ
    time: { value: 0 },                              // 経過秒（水面のゆらぎ）
    fx: { value: 1 },                                // 1=窓の部屋・水中の光の網目を描く / 0=描かない（軽い画質用）
    night: { value: 0 },                             // 夜の度合い（0=昼, 1=夜）。窓明かり・街灯
    shadowMap: { value: null },                      // 近くの建物と木の影（city.js が描く）
    shadowMat: { value: new THREE.Matrix4() },
    shadowOn: { value: 0 },
    shadowRes: { value: 2048 },                      // 影の画像の一辺の画素数
    ultra: { value: 0 },                             // 1=最高画質（細かな凹凸・映り込み・濡れた砂など）
    camSurf: { value: new THREE.Vector2() },         // カメラの真下の地表の位置（周方向の距離, 軸方向）。細かい模様を崩さず描くための基準
    camMod: { value: new THREE.Vector2() },          // 上の値を 64m で割った余り
    noiseTex: { value: null },                       // 繰り返しのノイズ模様（4色それぞれ別の模様。雲と、最高画質の細かい質感に使う）
  };

  const GLSL_COMMON = `
    uniform float spin, sunElev, mirrorTan, sunVis, cloudT, time, night, ultra;
    uniform vec3 sunCol, ambCol;
    const float COL_R = ${R.toFixed(1)};
    const float COL_L = ${L.toFixed(1)};
    const float THETA0 = ${COL.THETA0.toFixed(8)};
    const float STRIP = ${COL.STRIP.toFixed(8)};
    // その場所に届く光。太陽光は「向かいの窓の外のミラー」から来るので、帯ごとに向きが決まる
    // その場所から見た太陽（向かいの窓の外のミラー）の向き
    vec3 sunDirAt(vec3 wp) {
      float k = floor((atan(wp.y, wp.x) - THETA0) / STRIP);
      float thc = THETA0 + (k + 0.5) * STRIP;
      return -vec3(cos(thc), sin(thc), 0.0) * sin(sunElev) - vec3(0.0, 0.0, cos(sunElev));
    }
    vec3 lightAt(vec3 wp, vec3 n) {
      vec3 up = normalize(vec3(-wp.xy, 1e-4));
      vec3 ld = sunDirAt(wp);
      return ambCol * (0.76 + 0.24 * dot(n, up)) + sunCol * max(dot(n, ld), 0.0);
    }`;

  // 宇宙（星・天の川・地球・月・太陽）と、ミラー越しの見え方
  const GLSL_SPACE = `
    float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float n3(vec3 p) {
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    void planet(inout vec3 col, vec3 q, vec3 E, float rad, float kind) {
      float c = dot(q, E), sr = sin(rad);
      vec3 t = q - E * c;
      float rho = length(t) / sr;
      if (c > 0.0 && rho < 1.0) {
        vec3 n = t / sr - E * sqrt(1.0 - rho * rho);
        float lit = clamp(dot(n, vec3(0.0, 0.0, -1.0)) * 1.3 + 0.12, 0.0, 1.0);
        vec3 sc;
        if (kind < 0.5) {
          float land = smoothstep(0.50, 0.58, n3(n * 2.6 + 3.0) * 0.6 + n3(n * 7.0) * 0.4);
          sc = mix(vec3(0.05, 0.20, 0.55), vec3(0.22, 0.42, 0.18), land);
          float cl = smoothstep(0.48, 0.72, n3(n * 4.0 + 9.0) * 0.6 + n3(n * 11.0) * 0.4);
          sc = mix(sc, vec3(0.95), cl);
          sc += vec3(0.25, 0.45, 0.90) * pow(rho, 6.0) * 0.6;
        } else {
          sc = vec3(0.62, 0.60, 0.57) * (0.7 + 0.6 * n3(n * 6.0));
        }
        col = sc * lit;
      }
    }
    // 向き d に見える宇宙の色。sunAmt: 太陽を描く強さ
    vec3 spaceColor(vec3 d, float sunAmt) {
      float cs = cos(spin), sn = sin(spin);
      vec3 q = vec3(cs * d.x - sn * d.y, sn * d.x + cs * d.y, d.z);
      vec3 col = vec3(0.004, 0.006, 0.014);
      vec3 p = q * 230.0, ip = floor(p), fp = fract(p) - 0.5;
      float h = h31(ip);
      float st = step(0.988, h) * (1.0 - smoothstep(0.08, 0.30, length(fp)));
      col += st * mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.9, 0.75), fract(h * 37.0)) * (0.5 + fract(h * 91.0) * 0.9);
      float band = exp(-pow(dot(q, normalize(vec3(0.3, 0.9, 0.3))) * 4.0, 2.0));
      col += vec3(0.020, 0.022, 0.036) * band * (0.5 + n3(q * 6.0));
      planet(col, q, normalize(vec3(0.38, 0.0, 1.0)), 0.052, 0.0);      // 地球
      planet(col, q, normalize(vec3(-0.50, 0.45, 0.75)), 0.016, 1.0);   // 月
      float s = max(dot(d, vec3(0.0, 0.0, -1.0)), 0.0);
      col += sunAmt * (vec3(1.0, 0.97, 0.88) * smoothstep(0.99970, 0.99985, s) * 30.0
                     + vec3(1.0, 0.90, 0.70) * (pow(s, 900.0) * 1.6 + pow(s, 40.0) * 0.25));
      return col;
    }
    // 窓（中央の角度 thc）を通して o から d の向きを見たときの色。ミラーに当たれば反射した先を映す
    vec3 windowView(vec3 o, vec3 d, float thc) {
      vec3 nr = vec3(cos(thc), sin(thc), 0.0), e = vec3(-nr.y, nr.x, 0.0);
      float den = dot(d, nr) + d.z * mirrorTan;
      float t = (COL_R * 0.9 + (COL_L - o.z) * mirrorTan - dot(o, nr)) / den;
      vec3 hit = o + d * t;
      if (den > 1e-4 && t > 0.0 && abs(dot(hit, e)) < 2600.0) {
        vec3 r = reflect(d, normalize(nr + vec3(0.0, 0.0, mirrorTan)));
        return spaceColor(r, sunVis) * 0.92 + vec3(0.008, 0.010, 0.016);
      }
      return spaceColor(d, 1.0);
    }`;

  // 影: 太陽の向きから撮った深度（近くだけ）と比べる
  const GLSL_SHADOW = `
    #include <packing>
    uniform sampler2D shadowMap;
    uniform mat4 shadowMat;
    uniform float shadowOn, shadowRes;
    float shadowTap(vec2 uv, float z) { return step(z, unpackRGBAToDepth(texture2D(shadowMap, uv))); }
    // 隣り合う4画素の結果をなめらかに混ぜて、輪郭のギザギザを消す
    float shadowSoft(vec2 xy, float z) {
      vec2 st = xy * shadowRes - 0.5, i = floor(st), f = st - i;
      return mix(mix(shadowTap((i + vec2(0.5, 0.5)) / shadowRes, z), shadowTap((i + vec2(1.5, 0.5)) / shadowRes, z), f.x),
                 mix(shadowTap((i + vec2(0.5, 1.5)) / shadowRes, z), shadowTap((i + vec2(1.5, 1.5)) / shadowRes, z), f.x), f.y);
    }
    // off: 面から浮かせて調べる距離 [m]（影を落とす側の面は、自分の影を拾わないよう大きめにする）
    float shadowAt(vec3 wp, vec3 n, float off) {
      if (shadowOn < 0.5) return 1.0;
      vec4 sc = shadowMat * vec4(wp + n * off, 1.0);
      vec3 c = sc.xyz;
      if (c.x < 0.004 || c.y < 0.004 || c.x > 0.996 || c.y > 0.996 || c.z > 0.999 || c.z < 0.0) return 1.0;
      float z = c.z - 0.00025, s = shadowSoft(c.xy, z);
      vec2 e = min(c.xy, 1.0 - c.xy);
      return mix(1.0, s, smoothstep(0.004, 0.08, min(e.x, e.y)));
    }`;

  // 水面の揺らぎが海底に落とす光の網目。uv は 1 で一周する
  const GLSL_CAUSTIC = `
    uniform float fx;
    float caustic(vec2 uv, float t) {
      if (fx < 0.5) return 0.0;
      vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
      vec2 i = p;
      float c = 1.0, inten = 0.005;
      for (int n = 0; n < 4; n++) {
        float tt = t * (1.0 - (3.5 / float(n + 1)));
        i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
        c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
      }
      c /= 4.0;
      c = 1.17 - pow(c, 1.4);
      return pow(abs(c), 8.0);
    }`;

  const VS_HEAD = `
    #include <common>
    #include <fog_pars_vertex>
    #include <logdepthbuf_pars_vertex>`;
  const VS_TAIL = `
      #include <logdepthbuf_vertex>
      #include <fog_vertex>`;
  const FS_HEAD = `
    #include <common>
    #include <fog_pars_fragment>
    #include <logdepthbuf_pars_fragment>`;

  function material(vs, fs, extra, opts) {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, extra || {}]);
    for (const k in U) uniforms[k] = U[k];        // 共通の値は同じ実体を共有する
    return new THREE.ShaderMaterial(Object.assign({
      uniforms: uniforms, vertexShader: vs, fragmentShader: fs, fog: true, extensions: { derivatives: true },
    }, opts || {}));
  }

  // ---- 外殻の窓3枚（陸地は buildTerrain が作る） ----
  const GLSL_NOISE2 = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }`;
  // 最高画質用の部品（GLSL_COMMON と GLSL_NOISE2 の後に入れる）
  const GLSL_ULTRA = `
    uniform sampler2D noiseTex;
    // 面の上の位置 p [m] のノイズ（4種類）。cell: 模様1マスの大きさ [m]。計算ではなく画像から読むので軽い
    vec4 tnoise(vec2 p, float cell) { return texture2D(noiseTex, p / (cell * 16.0)); }
    // per マスで繰り返すノイズ（64m で折り返す座標で使っても継ぎ目が出ない）
    float pnoise(vec2 p, float per) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      vec2 a = mod(i, per), b = mod(i + 1.0, per);
      return mix(mix(hash(a), hash(vec2(b.x, a.y)), f.x), mix(hash(vec2(a.x, b.y)), hash(b), f.x), f.y);
    }
    // 面の上の位置 uv [m] での高さ h の傾き（細かな凹凸で法線を曲げるのに使う）
    vec2 hgrad(vec2 uv, float h) {
      vec2 dx = dFdx(uv), dy = dFdy(uv);
      float hx = dFdx(h), hy = dFdy(h), det = dx.x * dy.y - dx.y * dy.x;
      if (abs(det) < 1e-12) return vec2(0.0);
      return clamp(vec2(hx * dy.y - hy * dx.y, hy * dx.x - hx * dy.x) / det, -1.5, 1.5);
    }
    // 向き d に見える空（映り込み用）: 霞んだ空・雲・太陽のまぶしさ。地平より下は暗い地面
    vec3 envSky(vec3 wp, vec3 d) {
      vec3 up = normalize(vec3(-wp.xy, 1e-3)), east = vec3(up.y, -up.x, 0.0);
      float e = dot(d, up);
      vec3 hz = ambCol * 1.3 + sunCol * 0.3;
      #ifdef USE_FOG
        hz = fogColor;
      #endif
      vec3 c = mix(hz * 1.06, hz * vec3(0.66, 0.78, 0.98), smoothstep(0.0, 0.85, e));
      vec2 q = vec2(dot(d, east), d.z) / (abs(e) + 0.4);
      float cl = smoothstep(0.50, 0.78, vnoise(q * 1.9 + cloudT * 8.0) * 0.6 + vnoise(q * 4.7) * 0.4) * smoothstep(0.04, 0.35, e);
      c = mix(c, ambCol * 1.15 + sunCol * 0.85, cl * 0.6);
      float s = max(dot(d, sunDirAt(wp)), 0.0);
      c += sunCol * (pow(s, 700.0) * 7.0 + pow(s, 28.0) * 0.30);
      return mix(c, hz * 0.42 + ambCol * 0.10, smoothstep(0.02, -0.22, e));
    }`;
  const surfVS = VS_HEAD + `
    attribute vec2 surf;            // x: 周方向の距離[m], y: 軸方向の位置[m]
    varying vec2 vSurf;
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vSurf = vec2(surf.x, wp.z);
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + VS_TAIL + `
    }`;
  const windowFS = FS_HEAD + GLSL_COMMON + GLSL_SPACE + `
    varying vec2 vSurf;
    varying vec3 vWorld;
    // period[m] ごとの格子線（太さ w[m]）。遠くでは細く薄くなる
    float grid(vec2 p, float period, float w) {
      vec2 d = abs(fract(p / period - 0.5) - 0.5) * period;
      vec2 fw = fwidth(p) + 1e-4;
      vec2 a = (1.0 - smoothstep(vec2(w * 0.5) - fw, vec2(w * 0.5) + fw, d)) * clamp(w / fw, 0.0, 1.0);
      return max(a.x, a.y);
    }
    void main() {
      #include <logdepthbuf_fragment>
      float sw = STRIP * COL_R;
      float strip = floor((vSurf.x - 0.5 * sw) / (2.0 * sw)) * 2.0 + 1.0;   // 窓は奇数番の帯
      vec3 up = normalize(vec3(-vWorld.xy, 0.0));
      vec3 light = lightAt(vWorld, up);
      vec3 d = normalize(vWorld - cameraPosition);
      vec3 col = windowView(cameraPosition, d, THETA0 + (strip + 0.5) * STRIP);
      col = mix(col, vec3(0.55, 0.58, 0.62) * light, grid(vSurf, 250.0, 7.0));
      // 陸地との境目の縁取り
      float e = abs(fract(vSurf.x / sw - 0.5) - 0.5) * sw;
      col = mix(col, vec3(0.70, 0.71, 0.73) * light, 1.0 - smoothstep(6.0, 6.0 + fwidth(vSurf.x) * 1.5, e));
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`;

  function buildShell(scene) {
    const SEG_LEN = 1000, N = 120;           // 軸方向 1km ごと、周方向 0.5° 刻み
    const mat = material(surfVS, windowFS, null, { side: THREE.DoubleSide });
    for (let w = 0; w < 3; w++) {
      const a0 = (w * 2 + 1) * COL.STRIP;
      const pos = new Float32Array((N + 1) * 2 * 3), surf = new Float32Array((N + 1) * 2 * 2), idx = [];
      for (let i = 0; i <= N; i++) {
        const a = a0 + i / N * COL.STRIP, t = COL.THETA0 + a, c = Math.cos(t), s = Math.sin(t);
        for (let j = 0; j < 2; j++) {
          const k = i * 2 + j, zl = (j - 0.5) * SEG_LEN;
          pos[k * 3] = R * c; pos[k * 3 + 1] = R * s; pos[k * 3 + 2] = zl;
          surf[k * 2] = a * R; surf[k * 2 + 1] = zl;
        }
        if (i < N) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      for (let z = SEG_LEN / 2; z < L; z += SEG_LEN) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = z;
        mesh.renderOrder = 8;
        scene.add(mesh);
      }
    }
  }

  // ---- 地形（陸地3枚）: terrain.js の 25m 格子をそのままメッシュにする ----
  const terrainVS = VS_HEAD + GLSL_COMMON + `
    attribute vec2 surf;
    attribute vec3 gcol;
    attribute float urban;
    attribute float seaD;           // 南国の海の水深（それ以外は 0）
    attribute vec2 gmat;            // x: 砂なら 1, y: 水面からの高さ [m]
    uniform vec2 camSurf;
    varying vec2 vSurf, vLoc, vMat;
    varying vec3 vColor, vAmb, vSun, vWorld, vN;
    varying float vUrban, vSea;
    void main() {
      vSea = seaD;
      vMat = gmat;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vSurf = vec2(surf.x, wp.z);
      vLoc = vSurf - camSurf;         // カメラの近くで小さな値になる座標（細かい模様の計算が粗くならない）
      vColor = gcol;
      vUrban = urban;
      vec3 n = normalize(normal), up = normalize(vec3(-wp.xy, 1e-4));
      vN = n;
      vAmb = ambCol * (0.76 + 0.24 * dot(n, up));
      vSun = sunCol * max(dot(n, sunDirAt(wp.xyz)), 0.0);
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + VS_TAIL + `
    }`;
  const terrainFS = FS_HEAD + GLSL_COMMON + GLSL_NOISE2 + GLSL_ULTRA + GLSL_SHADOW + GLSL_CAUSTIC + `
    uniform vec2 camMod;
    varying vec2 vSurf, vLoc, vMat;
    varying vec3 vColor, vAmb, vSun, vWorld, vN;
    varying float vUrban, vSea;
    // 街の道路: 125m ごとの格子。偶数番は大通り（幅18m）、奇数番は通り（幅10m）
    vec3 roads(vec3 col, vec2 p, float amt, out float lamp, out float paved) {
      vec2 g = p / 125.0, idx = floor(g + 0.5);
      vec2 f = abs(g - idx) * 125.0;                    // 一番近い線までの距離（x: z方向に走る道, y: u方向に走る道）
      vec2 ave = 1.0 - mod(idx, 2.0);
      vec2 hw = 5.0 + 4.0 * ave;
      vec2 fw = fwidth(p) + 1e-4;
      vec2 rd = 1.0 - smoothstep(hw - fw, hw + fw, f);
      vec2 sw = 1.0 - smoothstep(hw + 3.6 - fw, hw + 3.6 + fw, f);
      float road = max(rd.x, rd.y), walk = max(sw.x, sw.y);
      float fine = clamp(1.0 - max(fw.x, fw.y) / 0.5, 0.0, 1.0);
      vec3 pave = vec3(0.66, 0.65, 0.62) * (0.94 + 0.10 * vnoise(p / 1.7));
      // 歩道の目地
      vec2 tl = abs(fract(p / 2.0) - 0.5);
      pave *= 1.0 - 0.10 * fine * step(0.47, max(tl.x, tl.y));
      vec3 asph = vec3(0.19, 0.195, 0.21) * (0.90 + 0.20 * vnoise(p / 2.3));
      // 中央線（破線）と横断歩道
      float inX = step(hw.y + 1.0, f.y), inZ = step(hw.x + 1.0, f.x);
      float cl = (1.0 - smoothstep(0.10, 0.10 + fw.x, f.x)) * step(fract(p.y / 9.0), 0.5) * inX * rd.x
               + (1.0 - smoothstep(0.10, 0.10 + fw.y, f.y)) * step(fract(p.x / 9.0), 0.5) * inZ * rd.y;
      float zx = step(hw.y + 1.2, f.y) * step(f.y, hw.y + 4.4) * step(fract(p.x / 1.3), 0.5) * rd.x
               + step(hw.x + 1.2, f.x) * step(f.x, hw.x + 4.4) * step(fract(p.y / 1.3), 0.5) * rd.y;
      // 大通りの車線
      float ln = ave.x * rd.x * inX * (1.0 - smoothstep(0.07, 0.07 + fw.x, abs(f.x - 4.5))) * step(fract(p.y / 12.0), 0.4)
               + ave.y * rd.y * inZ * (1.0 - smoothstep(0.07, 0.07 + fw.y, abs(f.y - 4.5))) * step(fract(p.x / 12.0), 0.4);
      asph = mix(asph, vec3(0.86, 0.86, 0.82), clamp(cl + zx + ln, 0.0, 1.0) * fine * 0.9);
      col = mix(col, pave, walk * amt);
      col = mix(col, asph, road * amt);
      paved = max(walk, road) * amt;
      // 街灯の明かり（42m おき）
      vec2 sp = (fract(p.yx / 42.0) - 0.5) * 42.0;
      lamp = amt * max(exp(-(sp.x * sp.x + f.x * f.x) / 160.0) * step(f.x, hw.x + 8.0),
                       exp(-(sp.y * sp.y + f.y * f.y) / 160.0) * step(f.y, hw.y + 8.0));
      return col;
    }
    void main() {
      #include <logdepthbuf_fragment>
      // 近くだけ見える細かな色むら
      float k = clamp(1.0 - (fwidth(vSurf.x) + fwidth(vSurf.y)) / 6.0, 0.0, 1.0);
      float n = vnoise(vSurf / 5.0) * 0.6 + vnoise(vSurf / 23.0) * 0.4;
      vec3 col = vColor * (1.0 + (n - 0.5) * 0.22 * k);
      float lamp = 0.0, paved = 0.0;
      if (vUrban > 0.01) col = roads(col, vSurf, smoothstep(0.35, 0.65, vUrban), lamp, paved);
      vec3 up = normalize(vec3(-vWorld.xy, 0.0));
      float sh = shadowAt(vWorld, up, 0.12);
      vec3 amb = vAmb, sun = vSun, extra = vec3(0.0);
      if (ultra > 0.5) {
        // ---- 最高画質: 砂の風紋・粒・きらめき、波打ち際の濡れた砂、芝のむら、舗装のざらつき ----
        vec2 pp = vLoc + camMod, pl = mod(pp, 64.0);
        float fp = fwidth(vLoc.x) + fwidth(vLoc.y);
        float nearK = clamp(1.0 - fp / 0.45, 0.0, 1.0), fineK = clamp(1.0 - fp / 0.07, 0.0, 1.0);
        float sandK = vMat.x * (1.0 - paved);
        float grassK = (1.0 - vMat.x) * (1.0 - paved) * smoothstep(0.03, 0.14, col.g - max(col.r, col.b));
        vec3 N = normalize(vN), ld = sunDirAt(vWorld), V = normalize(cameraPosition - vWorld);
        if (nearK > 0.0) {
          vec4 n0 = tnoise(pp, 2.0), n1 = tnoise(pp + 3.7, 0.5), n2 = tnoise(pp + 1.3, 0.11), n3 = tnoise(pp, 0.03);
          float rip = sin((pl.y + n0.r * 2.4 + pl.x * 0.3) * 9.8175) * 0.5 + 0.5;
          float hS = rip * 0.034 * smoothstep(0.30, 0.55, n0.g) + n1.r * 0.035 + n2.r * 0.007;
          float hG = n1.g * 0.06 + n2.g * 0.022;
          float hP = n2.b * 0.004 + n3.r * 0.0015;
          vec2 g = hgrad(vLoc, (sandK * hS + grassK * hG + paved * hP) * nearK);
          vec3 east = vec3(up.y, -up.x, 0.0);
          N = normalize(N - east * g.x - vec3(0.0, 0.0, 1.0) * g.y);
          amb = ambCol * (0.76 + 0.24 * dot(N, up));
          sun = sunCol * max(dot(N, ld), 0.0);
          // 色のむら
          col *= 1.0 + sandK * ((n1.a - 0.5) * 0.12 * nearK + (n3.g - 0.5) * 0.16 * fineK);
          col = mix(col, col * vec3(0.76, 0.90, 0.68), grassK * nearK * smoothstep(0.38, 0.70, n1.b) * 0.55);
          col = mix(col, col * vec3(1.14, 1.10, 0.84), grassK * nearK * smoothstep(0.55, 0.80, n0.b) * 0.35);
          col *= 1.0 + (grassK * 0.34 + paved * 0.12) * fineK * (n3.b - 0.5);
          // 乾いた砂のきらめき（粒ごとに向きの違う、ごく小さな鏡）
          if (sandK * fineK > 0.0 && vMat.y > 0.0) {
            vec2 cell = floor(mat2(0.8, -0.6, 0.6, 0.8) * pl * 73.0);
            vec3 p3 = fract(vec3(cell.xyx) * 0.1031);          // 大きな値でも偏らない乱数
            p3 += dot(p3, p3.yzx + 33.33);
            float hs = fract((p3.x + p3.y) * p3.z);
            vec3 gn = normalize(N + (fract(hs * vec3(13.1, 37.7, 91.3)) - 0.5) * 1.1);
            extra += sandK * fineK * step(0.88, hs) * sunCol * sh * pow(max(dot(reflect(-ld, gn), V), 0.0), 40.0) * 2.4;
          }
        }
        // 波打ち際: 波が引いたあとの濡れた砂（暗くなり、空と太陽を映す）
        float swash = 0.16 + 0.10 * sin(time * 0.6 + pnoise(pl * 0.0625, 4.0) * 6.2831853);
        float wet = sandK * (1.0 - smoothstep(swash, swash + 0.24, vMat.y)) * step(-0.03, vMat.y);
        vec3 rf = reflect(-V, N);
        if (wet > 0.001) {
          col *= mix(1.0, 0.60, wet);
          float fres = 0.03 + 0.55 * pow(1.0 - max(dot(V, N), 0.0), 4.0);
          extra = extra * (1.0 - wet) + wet * (envSky(vWorld, rf) * fres + sunCol * sh * pow(max(dot(rf, ld), 0.0), 120.0) * 1.6);
        }
        // 舗装の照り返し
        extra += paved * sunCol * sh * pow(max(dot(rf, ld), 0.0), 26.0) * 0.10;
      }
      vec3 light = amb + sun * sh + vec3(1.0, 0.82, 0.55) * lamp * night * 0.55;
      if (vSea > 0.05) {
        // 海底の光の網目（浅いほど強い。遠くでは消す）と、砂の小さな波紋
        float ck = smoothstep(0.15, 1.2, vSea) * exp(-vSea / 16.0) * clamp(1.0 - (fwidth(vSurf.x) + fwidth(vSurf.y)) / 2.5, 0.0, 1.0);
        light += vSun * sh * (caustic(vSurf / 9.0, time * 0.7) * 0.6 + caustic(vSurf / 5.3 + 0.37, time * 0.9) * 0.3) * ck;
        // 水の中では赤い光から先に弱まる（深いほど青緑に）
        light *= mix(vec3(1.0), exp(-vSea * vec3(0.16, 0.05, 0.035)), smoothstep(0.0, 0.6, vSea));
        col *= 1.0 - 0.06 * ck * (0.5 + 0.5 * sin(vSurf.y * 2.2 + vnoise(vSurf / 3.0) * 4.0));
      }
      gl_FragColor = vec4(col * light + extra, 1.0);
      #include <fog_fragment>
    }`;

  const ZONE_COL = {
    downtown: [0.56, 0.57, 0.58], commercial: [0.60, 0.60, 0.57], residential: [0.47, 0.62, 0.36], harbor: [0.60, 0.59, 0.55],
    suburb: [0.46, 0.64, 0.35], industry: [0.55, 0.55, 0.53], warehouse: [0.58, 0.56, 0.53], park: [0.36, 0.64, 0.30],
    forest: [0.17, 0.40, 0.19], meadow: [0.42, 0.66, 0.30], mountain: [0.36, 0.54, 0.29], resort: [0.48, 0.68, 0.40],
    beach: [0.90, 0.85, 0.66],
  };
  const FARM_COL = [[0.72, 0.68, 0.32], [0.42, 0.64, 0.28], [0.52, 0.42, 0.28], [0.60, 0.76, 0.36], [0.33, 0.55, 0.25]];
  const URBAN = { downtown: 1, commercial: 1, harbor: 1, industry: 1, warehouse: 1 };
  const SAND = [0.86, 0.81, 0.62], BED = [0.14, 0.27, 0.30], SHORE = [0.62, 0.58, 0.44];
  const TROPIC_Z = 23800;           // 陸地A のこれより奥の水は南国の海
  const PLAZA = [0.64, 0.63, 0.60], ROCK = [0.55, 0.53, 0.47], PALE = [0.74, 0.73, 0.70], FRAME = [0.70, 0.71, 0.73], LAWN = [0.40, 0.62, 0.32];
  const GARDEN = [0.44, 0.60, 0.34], YARD = [0.53, 0.53, 0.51];
  const BLOCK_GROUND = { park: LAWN, bank: LAWN, houses: GARDEN, villas: GARDEN, school: GARDEN, apart: GARDEN, mansion: GARDEN,
                         factory: YARD, tanks: YARD, warehouse: YARD, yard: YARD };
  const clamp01 = function (x) { return Math.min(1, Math.max(0, x)); };
  const _gc = [0, 0, 0];
  function mixTo(c, t, k) { c[0] += (t[0] - c[0]) * k; c[1] += (t[1] - c[1]) * k; c[2] += (t[2] - c[2]) * k; }
  // 地面の色: ゾーン・水深・傾き・標高で決める
  function groundColor(i, u, z, h, d, slope) {
    const c = _gc, level = COL.WATER[i].level;
    if (d < 0 && h < level) {
      c[0] = SAND[0]; c[1] = SAND[1]; c[2] = SAND[2];
      if (i === 0 && z > TROPIC_Z) {
        const dp = level - h;
        c[0] = 0.86; c[1] = 0.84; c[2] = 0.72;
        if (dp > 1.2 && COL.fbm2(u / 60, z / 60, 3, 611) > 0.62) mixTo(c, [0.30, 0.46, 0.26], 0.6);   // 海草の茂み
        mixTo(c, [0.55, 0.80, 0.76], 0.55 * clamp01(dp / 7));
        mixTo(c, [0.05, 0.24, 0.44], clamp01((dp - 5) / 22));
        return c;
      }
      mixTo(c, BED, clamp01((level - h) / 9));
      return c;
    }
    const id = COL.zoneOf(i, u, z);
    let b = ZONE_COL[id] || SAND;
    let inBlock = false;
    if (COL.GRID_ZONES[id]) {                    // 街区ごと: 公園・住宅の庭は芝、工場や倉庫は土間、それ以外は舗装
      const bt = COL.blockTypeAt(i, u, z);
      if (bt) { inBlock = true; b = BLOCK_GROUND[bt] || PLAZA; }
    }
    if (id === 'farm') b = FARM_COL[Math.floor(COL.noise2(Math.floor(u / 140), Math.floor(z / 220), 77) * FARM_COL.length) % FARM_COL.length];
    c[0] = b[0]; c[1] = b[1]; c[2] = b[2];
    if (URBAN[id] && !inBlock && COL.fbm2(u / 210, z / 210, 2, 81) > 0.60) mixTo(c, LAWN, 0.8);   // 街なかの緑地
    const v = 0.88 + 0.24 * COL.noise2(u / 90, z / 90, 82);
    c[0] *= v; c[1] *= v; c[2] *= v;
    if (id !== 'beach' && d < 14) mixTo(c, SHORE, 1 - Math.max(0, d) / 14);              // 水際
    mixTo(c, ROCK, clamp01((slope - 0.34) / 0.36));                                      // 急斜面は岩
    if (h > 330) mixTo(c, PALE, 0.7 * clamp01((h - 330) / 140));                         // 高い峰
    if (COL.LAND_HW - Math.abs(u) < 10) mixTo(c, FRAME, 1);                              // 窓との境の縁
    return c;
  }

  const terrainChunks = [];
  // カメラから遠い地形は粗い格子に切り替える
  COL.updateTerrainLod = function (cam) {
    {
      // カメラの真下の地表の位置（一番近い陸地の座標で）
      const th = Math.atan2(cam.y, cam.x);
      let bi = 0, bu = 1e9;
      for (let i = 0; i < 3; i++) {
        let du = th - COL.landCenter(i);
        du = (du - Math.round(du / (2 * Math.PI)) * 2 * Math.PI) * R;
        if (Math.abs(du) < Math.abs(bu)) { bu = du; bi = i; }
      }
      const cx = Math.round(bu + bi * 5000), cz = Math.round(cam.z);
      U.camSurf.value.set(cx, cz);
      U.camMod.value.set(((cx % 64) + 64) % 64, ((cz % 64) + 64) % 64);
    }
    for (let k = 0; k < terrainChunks.length; k++) {
      const t = terrainChunks[k], d = Math.hypot(t.x - cam.x, t.y - cam.y, t.z - cam.z);
      const g = d > 3800 ? t.far : t.near;
      if (t.mesh.geometry !== g) t.mesh.geometry = g;
      t.mesh.visible = !COL.drawFar || d < COL.drawFar + 2000;     // 最軽量: 遠くの地形は描かない
    }
  };

  function buildTerrain(scene) {
    const G = COL.GRID, HW = COL.LAND_HW, NU = G.NU, NZ = G.NZ, W = NU + 1, ROWS = 47;   // 1128 = 47 × 24 枚
    // 地面に置いた物（広場の舗装・水面など）が遠くでちらつかないよう、地面を奥行き方向へわずかに下げて描く
    const mat = material(terrainVS, terrainFS, null, { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    const idx = [];
    for (let jz = 0; jz < ROWS; jz++) for (let ju = 0; ju < NU; ju++) {
      const a = ju + jz * W, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, b, c, b, d, c);              // 対角線 b–c で分ける（COL.groundH の補間と同じ）
    }
    const index = new THREE.BufferAttribute(new Uint16Array(idx), 1);
    // 遠景用: 2マスを1マスとして張る（三角形は約1/4）
    const idx2 = [];
    for (let jz = 0; jz < ROWS; jz += 2) {
      const step = Math.min(2, ROWS - jz);
      for (let ju = 0; ju < NU; ju += 2) {
        const a = ju + jz * W, b = a + 2, c = a + step * W, d = c + 2;
        idx2.push(a, b, c, b, d, c);
      }
    }
    const indexFar = new THREE.BufferAttribute(new Uint16Array(idx2), 1);
    for (let i = 0; i < 3; i++) {
      const gr = COL.landGrid(i), H = gr.H, D = gr.D;
      for (let z0 = 0; z0 < NZ; z0 += ROWS) {
        const n = W * (ROWS + 1);
        const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), colr = new Float32Array(n * 3), surf = new Float32Array(n * 2), urb = new Float32Array(n), sea = new Float32Array(n), gmat = new Float32Array(n * 2);
        const level = COL.WATER[i].level;
        const zBase = COL.TERRAIN_Z0 + z0 * G.DZ;
        for (let r = 0; r <= ROWS; r++) {
          const jz = z0 + r, z = COL.TERRAIN_Z0 + jz * G.DZ;
          for (let ju = 0; ju <= NU; ju++) {
            const k = ju + jz * W, v = ju + r * W, u = -HW + ju * G.DU, h = H[k];
            const th = COL.landTheta(i, u), cs = Math.cos(th), sn = Math.sin(th), rr = R - h;
            pos[v * 3] = rr * cs; pos[v * 3 + 1] = rr * sn; pos[v * 3 + 2] = z - zBase;
            // 傾き（格子の中央差分）→ 法線
            const ka = ju > 0 ? k - 1 : k, kb = ju < NU ? k + 1 : k, kc = jz > 0 ? k - W : k, kd = jz < NZ ? k + W : k;
            const sx = (H[kb] - H[ka]) / ((kb - ka) * G.DU * rr / R), sz = (H[kd] - H[kc]) / ((kd - kc) / W * G.DZ);
            const il = 1 / Math.hypot(sx, 1, sz);
            // east = (-sn, cs, 0), up = (-cs, -sn, 0), north = (0, 0, 1)
            nrm[v * 3] = (sn * sx - cs) * il; nrm[v * 3 + 1] = (-cs * sx - sn) * il; nrm[v * 3 + 2] = -sz * il;
            const c = groundColor(i, u, z, h, D[k], Math.hypot(sx, sz));
            colr[v * 3] = c[0]; colr[v * 3 + 1] = c[1]; colr[v * 3 + 2] = c[2];
            surf[v * 2] = u + i * 5000; surf[v * 2 + 1] = 0;
            urb[v] = COL.isUrban(i, u, z) ? 1 : 0;
            sea[v] = (i === 0 && z > TROPIC_Z && D[k] < 8 && h < 0) ? -h : 0;
            gmat[v * 2] = ((D[k] < 0 && h < level) || COL.zoneOf(i, u, z) === 'beach') ? 1 : 0;
            gmat[v * 2 + 1] = Math.max(-5, Math.min(20, h - level));
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        geo.setAttribute('gcol', new THREE.BufferAttribute(colr, 3));
        geo.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
        geo.setAttribute('urban', new THREE.BufferAttribute(urb, 1));
        geo.setAttribute('seaD', new THREE.BufferAttribute(sea, 1));
        geo.setAttribute('gmat', new THREE.BufferAttribute(gmat, 2));
        geo.setIndex(index);
        geo.computeBoundingSphere();
        const far = new THREE.BufferGeometry();
        for (const an in geo.attributes) far.setAttribute(an, geo.attributes[an]);
        far.setIndex(indexFar);
        far.boundingSphere = geo.boundingSphere;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = zBase;
        mesh.renderOrder = 5;
        scene.add(mesh);
        const thc = COL.landCenter(i);
        terrainChunks.push({ mesh: mesh, near: geo, far: far, x: R * Math.cos(thc), y: R * Math.sin(thc), z: zBase + ROWS * G.DZ / 2 });
      }
    }
  }

  // ---- 水面（海・湖・川）: 水位の高さの円筒面。水域にかかる格子のマスだけ張る ----
  const waterVS = VS_HEAD + `
    attribute vec2 surf;
    attribute float depth;
    attribute float tropic;
    uniform vec2 camSurf;
    varying vec2 vSurf, vLoc;
    varying vec3 vWorld;
    varying float vDepth, vTrop;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vSurf = surf;
      vLoc = surf - camSurf;
      vDepth = depth;
      vTrop = tropic;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + VS_TAIL + `
    }`;
  const waterFS = FS_HEAD + GLSL_COMMON + GLSL_NOISE2 + GLSL_ULTRA + `
    uniform vec2 camMod;
    varying vec2 vSurf, vLoc;
    varying vec3 vWorld;
    varying float vDepth, vTrop;
    void main() {
      #include <logdepthbuf_fragment>
      if (vDepth < -0.03) discard;               // 地面の下にもぐった部分は描かない（岸の形は地形と正確に一致する）
      vec3 up = normalize(vec3(-vWorld.xy, 0.0)), east = vec3(up.y, -up.x, 0.0);
      vec3 v = normalize(cameraPosition - vWorld);
      // さざ波（遠くでは消す）
      float k = clamp(1.0 - (fwidth(vSurf.x) + fwidth(vSurf.y)) / 5.0, 0.0, 1.0);
      vec2 q = vSurf / 4.0;
      float nx = vnoise(q + vec2(time * 0.45, time * 0.20)) + vnoise(q * 2.7 - vec2(time * 0.30, time * 0.55)) * 0.5 - 0.75;
      float nz = vnoise(q + vec2(31.7 - time * 0.25, 9.2 + time * 0.40)) + vnoise(q * 2.7 + vec2(time * 0.50, 4.1 - time * 0.35)) * 0.5 - 0.75;
      vec2 pp = vLoc + camMod;
      if (ultra > 0.5) {
        // 最高画質: 細かいさざ波を重ねる
        float k2 = clamp(1.0 - (fwidth(vLoc.x) + fwidth(vLoc.y)) / 0.9, 0.0, 1.0);
        vec4 w1 = tnoise(pp + vec2(time * 0.6, -time * 0.4), 0.7), w2 = tnoise(pp - vec2(time * 0.33, time * 0.2), 0.25);
        nx += ((w1.r - 0.5) * 0.9 + (w2.g - 0.5) * 0.5) * k2;
        nz += ((w1.b - 0.5) * 0.9 + (w2.a - 0.5) * 0.5) * k2;
      }
      vec3 n = normalize(up + (east * nx + vec3(0.0, 0.0, nz)) * 0.16 * k);
      float cv = abs(dot(v, n));
      float fres = 0.04 + 0.90 * pow(1.0 - cv, 4.0);
      float dk = 1.0 - exp(-max(vDepth, 0.0) / 2.5);
      vec3 body = mix(vec3(0.22, 0.66, 0.68), vec3(0.03, 0.19, 0.40), dk) * (ambCol * 0.95 + sunCol * 0.60);
      vec3 sky = ambCol * 1.2 + sunCol * 0.25;
      #ifdef USE_FOG
        sky = fogColor * 1.06;
      #endif
      float a = max(mix(0.45, 0.96, dk), fres);
      if (vTrop > 0.5) {
        float dt = 1.0 - exp(-max(vDepth, 0.0) / 9.0);
        body = mix(vec3(0.16, 0.82, 0.78), vec3(0.02, 0.30, 0.66), dt) * (ambCol * 0.9 + sunCol * 0.75);
        a = max(mix(0.26, 0.88, 1.0 - exp(-max(vDepth, 0.0) / 14.0)), fres * 0.85);
      }
      vec3 ld = sunDirAt(vWorld);
      if (ultra > 0.5) sky = envSky(vWorld, reflect(-v, n * sign(dot(v, up)))) * 1.02;
      vec3 col = mix(body, sky, fres);
      // 太陽のきらめき
      col += sunCol * (pow(max(dot(reflect(-ld, n), v), 0.0), 180.0) * 2.2 * k + pow(max(dot(reflect(-ld, up), v), 0.0), 24.0) * 0.20);
      if (ultra > 0.5) {
        // 波打ち際の白い泡（ごく浅い所。寄せては返す）
        float sw = 0.5 + 0.5 * sin(time * 0.6 + pnoise(mod(pp, 64.0) * 0.0625, 4.0) * 6.2831853);
        float edge = 1.0 - smoothstep(0.0, 0.10 + 0.22 * sw, vDepth);
        float lace = 0.0;
        if (edge > 0.0) lace = smoothstep(0.35, 0.75, tnoise(pp + vec2(time * 0.08, -time * 0.05), 0.5).r * 0.6 + tnoise(pp - vec2(time * 0.07), 0.17).g * 0.4 + edge * 0.45);
        float foam = edge * lace * clamp(1.0 - (fwidth(vLoc.x) + fwidth(vLoc.y)) / 3.0, 0.0, 1.0);
        col = mix(col, vec3(0.94, 0.97, 0.98) * (ambCol * 0.95 + sunCol * 0.75), foam * 0.85);
        a = max(a, foam * 0.85);
      }
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
    }`;

  function buildWater(scene) {
    const G = COL.GRID, HW = COL.LAND_HW, NU = G.NU, NZ = G.NZ, W = NU + 1;
    const mat = material(waterVS, waterFS, null, { side: THREE.DoubleSide, transparent: true, depthWrite: false });
    for (let i = 0; i < 3; i++) {
      const gr = COL.landGrid(i), H = gr.H, D = gr.D, level = COL.WATER[i].level, rr = R - level;
      const map = new Int32Array(W * (NZ + 1)).fill(-1);
      const pos = [], surf = [], dep = [], trop = [], idx = [];
      const vert = function (k) {
        if (map[k] >= 0) return map[k];
        const ju = k % W, jz = (k - ju) / W, u = -HW + ju * G.DU, z = COL.TERRAIN_Z0 + jz * G.DZ, th = COL.landTheta(i, u);
        pos.push(rr * Math.cos(th), rr * Math.sin(th), z);
        surf.push(u + i * 5000, z);
        dep.push(level - H[k]);
        trop.push(i === 0 && z > TROPIC_Z ? 1 : 0);
        return (map[k] = pos.length / 3 - 1);
      };
      for (let jz = 0; jz < NZ; jz++) for (let ju = 0; ju < NU; ju++) {
        const a = ju + jz * W, b = a + 1, c = a + W, d = c + 1;
        if (D[a] >= 0 && D[b] >= 0 && D[c] >= 0 && D[d] >= 0) continue;
        const va = vert(a), vb = vert(b), vc = vert(c), vd = vert(d);
        idx.push(va, vb, vc, vb, vd, vc);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('surf', new THREE.Float32BufferAttribute(surf, 2));
      geo.setAttribute('depth', new THREE.Float32BufferAttribute(dep, 1));
      geo.setAttribute('tropic', new THREE.Float32BufferAttribute(trop, 1));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      scene.add(mesh);
    }
  }

  // ---- 立体物（建物・山など）: 帯ごとの太陽光 + 環境光で陰影をつける ----
  const objectVS = VS_HEAD + GLSL_COMMON + `
    uniform vec3 tint;
    varying vec3 vColor;
    void main() {
      mat4 m = modelMatrix;
      #ifdef USE_INSTANCING
        m = modelMatrix * instanceMatrix;
      #endif
      vec4 wp = m * vec4(position, 1.0);
      vec3 wn = normalize(mat3(m) * normal);
      vColor = tint * lightAt(wp.xyz, wn);
      #ifdef USE_COLOR
        vColor *= color;
      #endif
      #ifdef USE_INSTANCING_COLOR
        vColor *= instanceColor;
      #endif
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + VS_TAIL + `
    }`;
  const objectFS = FS_HEAD + `
    varying vec3 vColor;
    void main() {
      #include <logdepthbuf_fragment>
      gl_FragColor = vec4(vColor, 1.0);
      #include <fog_fragment>
    }`;
  COL.objectMaterial = function (tint, opts) {
    return material(objectVS, objectFS, { tint: { value: new THREE.Color(tint === undefined ? 0xffffff : tint) } }, opts);
  };

  // (θ, z) の地表に、底面を置くための行列。X=周方向, Y=上, Z=軸方向
  const _m = new THREE.Matrix4(), _s = new THREE.Matrix4();
  COL.placeMatrix = function (theta, z, sx, sy, sz, sink) {
    const f = COL.frameAt(theta), p = COL.toWorld(theta, z, -(sink || 0));
    _m.set(f.east[0], f.up[0], 0, p[0],
           f.east[1], f.up[1], 0, p[1],
           0,         0,       1, p[2],
           0,         0,       0, 1);
    _s.makeScale(sx, sy, sz);
    return _m.clone().multiply(_s);
  };

  // ---- 宇宙港側の端: 中心へせり上がる山 ----
  function noise2(x, y) {
    const h = function (i, j) { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
    const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return (h(xi, yi) * (1 - fx) + h(xi + 1, yi) * fx) * (1 - fy) + (h(xi, yi + 1) * (1 - fx) + h(xi + 1, yi + 1) * fx) * fy;
  }
  function buildPortCap(scene) {
    const NT = 240, NR = 48, hub = COL.HUB_R;
    const pos = [], colr = [], idx = [];
    const c = new THREE.Color(), grass = new THREE.Color(0x4f8a3a), rock = new THREE.Color(0x8d8778), pale = new THREE.Color(0xb9b6ad);
    for (let i = 0; i <= NR; i++) {
      const s = i / NR, r = hub + (R - hub) * s;
      for (let j = 0; j <= NT; j++) {
        const jj = j % NT, th = jj / NT * Math.PI * 2;
        // 尾根と谷。すそ（s=1）と頂上（s=0）ではなだらかに戻す
        const n = noise2(jj / NT * 36 + 5, s * 9) * 0.6 + noise2(jj / NT * 90, s * 22 + 7) * 0.4;
        const bump = (n - 0.5) * 520 * Math.sin(Math.PI * Math.min(1, s * 1.15)) * (0.35 + 0.65 * (1 - s));
        pos.push(r * Math.cos(th), r * Math.sin(th), Math.max(0, COL.capZ(r) + bump));
        const t = Math.min(1, Math.max(0, (1 - s) * 1.7 - 0.25 + (n - 0.5) * 0.5));
        c.copy(grass).lerp(rock, Math.min(1, t * 1.6)).lerp(pale, Math.max(0, t - 0.6) * 1.5);
        c.multiplyScalar(0.85 + 0.3 * n);
        colr.push(c.r, c.g, c.b);
      }
    }
    const W = NT + 1;
    for (let i = 0; i < NR; i++) for (let j = 0; j < NT; j++) {
      const a = i * W + j, b = a + 1, d = a + W, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    geo.setIndex(idx);
    geo = geo.toNonIndexed();                 // 面ごとの法線にして、ローポリの岩肌に見せる
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    let sum = 0; for (let i = 0; i < nrm.count; i++) sum += nrm.getZ(i);
    if (sum < 0) for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    const capMesh = new THREE.Mesh(geo, COL.objectMaterial(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
    capMesh.renderOrder = 6;
    scene.add(capMesh);
  }

  // ---- 反対側の端: 全面ガラス ----
  function buildGlassCap(scene) {
    const vs = VS_HEAD + `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;` + VS_TAIL + `
      }`;
    const fs = FS_HEAD + GLSL_COMMON + GLSL_SPACE + `
      varying vec3 vWorld;
      float lineAt(float x, float period, float w) {
        float d = abs(fract(x / period - 0.5) - 0.5) * period, fw = fwidth(x) + 1e-4;
        return (1.0 - smoothstep(w * 0.5 - fw, w * 0.5 + fw, d)) * clamp(w / fw, 0.0, 1.0);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 d = normalize(vWorld - cameraPosition);
        vec3 col = spaceColor(d, 1.0);
        float r = length(vWorld.xy), arc = atan(vWorld.y, vWorld.x) * max(r, 400.0);
        float spokes = 24.0, sp = 6.2831853 * max(r, 400.0) / spokes;
        float frame = max(lineAt(r, 406.25, 9.0), lineAt(arc + sp * 0.5, sp, 9.0));
        col = mix(col, vec3(0.50, 0.53, 0.57) * (ambCol + sunCol * 0.3), frame);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`;
    // 海底（基準面より下）の向こうも塞ぐよう、少し大きめにする
    const glass = new THREE.Mesh(new THREE.CircleGeometry(R + 60, 128), material(vs, fs, null, { side: THREE.DoubleSide }));
    glass.position.z = L;
    glass.renderOrder = 8;
    scene.add(glass);
  }

  // ---- 雲: 地表から約1.3〜1.6km の高さに浮かぶ筒状の層 ----
  // 繰り返しても継ぎ目の出ないノイズ模様（雲用）。16マス周期
  function noiseTexture() {
    const N = 256, CELLS = 16, data = new Uint8Array(N * N * 4);
    for (let ch = 0; ch < 4; ch++) {
      const rand = COL.rng(4242 + ch * 977), g = [];
      for (let k = 0; k < CELLS * CELLS; k++) g.push(rand());
      const at = function (i, j) { return g[(i % CELLS) + (j % CELLS) * CELLS]; };
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / N * CELLS, fy = y / N * CELLS, xi = Math.floor(fx), yi = Math.floor(fy);
        let tx = fx - xi, ty = fy - yi;
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        const v = (at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx) * (1 - ty) + (at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx) * ty;
        data[(y * N + x) * 4 + ch] = Math.round(v * 255);
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }
  U.noiseTex.value = noiseTexture();

  function buildClouds(scene) {
    const vs = VS_HEAD + `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vUv = uv;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;` + VS_TAIL + `
      }`;
    const fs = FS_HEAD + GLSL_COMMON + `
      uniform sampler2D noiseMap;
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        #include <logdepthbuf_fragment>
        // 周方向は一周でちょうど1回繰り返す（継ぎ目なし）。軸方向へゆっくり流れる
        vec2 p = vec2(vUv.x + length(vWorld.xy) * 0.0007, vWorld.z / 20000.0 + cloudT * 0.0425);
        float n = texture2D(noiseMap, p).r * 0.5 + texture2D(noiseMap, p * 2.0 + 0.37).r * 0.25
                + texture2D(noiseMap, p * 4.0 + 0.71).r * 0.125 + texture2D(noiseMap, p * 8.0 + 0.13).r * 0.0625;
        float a = smoothstep(0.50, 0.66, n) * 0.88;
        a *= smoothstep(1800.0, 4200.0, vWorld.z) * smoothstep(0.0, 1800.0, COL_L - vWorld.z);
        a *= smoothstep(30.0, 350.0, distance(vWorld, cameraPosition));   // 雲の中を通り抜けるときは薄く
        if (a < 0.01) discard;
        vec3 col = (ambCol * 1.15 + sunCol * 0.85) * mix(0.78, 1.0, smoothstep(0.5, 0.85, n));
        gl_FragColor = vec4(col, a);
        #include <fog_fragment>
      }`;
    const geo = new THREE.CylinderGeometry(1, 1, 1, 128, 30, true);
    geo.rotateX(Math.PI / 2);
    const mat = material(vs, fs, { noiseMap: { value: null } }, { side: THREE.DoubleSide, transparent: true, depthWrite: false });
    mat.uniforms.noiseMap.value = U.noiseTex.value;
    const clouds = [];
    COL.setClouds = function (on) { clouds.forEach(function (m) { m.visible = on; }); };
    [R - 1300, R - 1560].forEach(function (r) {
      const m = new THREE.Mesh(geo, mat);
      clouds.push(m);
      m.scale.set(r, r, L);
      m.position.z = L / 2;
      m.rotation.z = 0.6;                    // 筒の継ぎ目を窓の上へずらす
      m.renderOrder = 2;
      scene.add(m);
    });
  }

  // 距離感をつかむための目印: 道路の無い場所に 1km ごとの標柱
  function buildLandmarks(scene) {
    const rand = COL.rng(20261111);
    const list = [];
    const col = new THREE.Color();
    const POST = [0xe2574c, 0x4c8fe2, 0xe2b84c];
    for (let a = 0; a < 3; a++) {
      const th = COL.landCenter(a);
      for (let km = 2; km <= 30; km++) {
        const z = Math.min(L - 15, km * 1000);
        if (COL.waterAt(th, z) || COL.GRID_ZONES[COL.zoneOf(a, 0, z)]) continue;
        const big = km % 5 === 0;
        list.push({ m: COL.placeMatrix(th, z, big ? 16 : 8, big ? 120 : 50, big ? 16 : 8, 0.5 - COL.groundH(th, z)), c: POST[a] });
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(box, COL.objectMaterial(), list.length);
    list.forEach(function (o, i) { mesh.setMatrixAt(i, o.m); mesh.setColorAt(i, col.setHex(o.c)); });
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // ---- 時刻と空 ----
  COL.clock = 10;                    // コロニー内の時刻 [時]
  COL.HOURS_PER_SEC = 1 / 60;        // 現実の1分 = コロニーの1時間（1日 = 24分）
  let elapsed = 0, sceneRef = null;
  const smooth = function (a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const C_DAY = new THREE.Color(0x9cc4ee), C_DUSK = new THREE.Color(0xe9a878), C_NIGHT = new THREE.Color(0x080d1c);
  const S_LOW = new THREE.Color(1.0, 0.52, 0.24), S_HIGH = new THREE.Color(1.0, 0.96, 0.88);
  const A_DAY = new THREE.Color(0.60, 0.65, 0.74), A_NIGHT = new THREE.Color(0.10, 0.13, 0.21);
  const C_WATER = new THREE.Color(0.05, 0.30, 0.38), C_SEA = new THREE.Color(0.07, 0.46, 0.58);
  COL.underwaterSea = false;         // 南国の海の中か
  const _c = new THREE.Color();
  COL.underwater = false;            // 目が水面より下にあるか（app.js が毎フレーム決める）

  // dt: 現実の経過秒。timeScale: 時刻を進める倍率（早送り用）
  COL.updateEnv = function (dt, timeScale) {
    elapsed += dt;
    COL.clock = (COL.clock + dt * COL.HOURS_PER_SEC * (timeScale || 1)) % 24;
    const h = COL.clock;
    // 6時に宇宙港側から昇り、12時に真上、18時にガラスの端の側へ沈む
    const phi = Math.PI * (h - 6) / 12;
    const e = (h > 6 && h < 18) ? Math.sin(phi) : 0;
    const day = smooth(0, 0.30, e);
    U.spin.value = -COL.OMEGA * elapsed;
    U.cloudT.value = elapsed * 0.004;
    U.time.value = elapsed % 3600;
    U.night.value = 1 - day;
    U.sunElev.value = e > 0 ? phi : Math.PI / 2;
    U.sunVis.value = smooth(0, 0.04, e);
    U.mirrorTan.value = e > 0 ? Math.tan(Math.min(1.48, Math.max(0.09, phi / 2))) : 1;
    U.sunCol.value.copy(S_LOW).lerp(S_HIGH, smooth(0.08, 0.5, e)).multiplyScalar(0.66 * day);
    U.ambCol.value.copy(A_NIGHT).lerp(A_DAY, day);
    _c.copy(C_DUSK).lerp(C_DAY, smooth(0.08, 0.55, e));
    sceneRef.fog.color.copy(C_NIGHT).lerp(_c, day);
    // 水の中では近くしか見えない
    if (COL.underwater) sceneRef.fog.color.copy(COL.underwaterSea ? C_SEA : C_WATER).multiplyScalar(0.2 + 0.8 * day);
    sceneRef.fog.density = COL.underwater ? (COL.underwaterSea ? 0.014 : 0.045) : (COL.liteFog || COL.HAZE);
    sceneRef.background.copy(sceneRef.fog.color);
  };

  // city.js から使うシェーダーの部品
  COL.GL = { U: U, material: material, COMMON: GLSL_COMMON, SHADOW: GLSL_SHADOW, NOISE2: GLSL_NOISE2, ULTRA: GLSL_ULTRA, SPACE: GLSL_SPACE, CAUSTIC: GLSL_CAUSTIC,
             VS_HEAD: VS_HEAD, VS_TAIL: VS_TAIL, FS_HEAD: FS_HEAD };

  COL.buildWorld = function (scene) {
    sceneRef = scene;
    scene.background = new THREE.Color(0x9cc4ee);
    scene.fog = new THREE.FogExp2(0x9cc4ee, COL.HAZE);
    buildShell(scene);
    buildTerrain(scene);
    buildWater(scene);
    buildPortCap(scene);
    buildGlassCap(scene);
    buildLandmarks(scene);
    buildClouds(scene);
    COL.updateEnv(0);
  };
})();
