// ホテルのスイートルーム: 陸地A・中心市街（12.9km）駅の南どなりにある、段々の高い事務所の塔
//  - 1階の正面玄関で E を押し、1泊ぶん（10,000 Cr）払うとエレベーターで最上段の屋上のすぐ下の階へ上がる
//  - その階をまるごと1室にする: 居間（ソファ・大きなテレビ）、食堂とバー、寝室（ベッドで時間を進める）、ジャグジーのある浴室
//  - 四方の壁は床から天井までのガラス。外から見える塔の壁は内側から描かれないので、実際の街の景色がそのまま見える
//  - 部屋の中にいる間は、塔の本体の当たり判定を外し、部屋の床・壁・家具の当たり判定だけを使う
//  - 座標は x: 周方向（東）, y: 床から上, z: 軸方向（ガラスの端の側が +）。原点は塔の中心・部屋の床
(function () {
  'use strict';
  const COL = window.COL, GL = COL.GL, V = COL.V;
  const PRICE = 10000;
  const NEAR = [-1187, 12813];                   // 塔のおおよその位置（陸地A の u, z）
  const CH = 4.2;                                // 天井の高さ

  let Kit = null, sceneRef = null, tower = null, ok = false;
  let U0 = 0, Z0 = 0, Y0 = 0, HS = 12, E = null, UP = null, O = null, TH0 = 0, front = 0;
  const U = { lamp: { value: 1 }, tv: { value: 0 }, bub: { value: 1 } };
  const spots = [];                              // E で使う物 { kind, p: [x, y, z], r }
  let signPos = null, spotBub = true;

  // ================= 材料 =================
  const VS = GL.VS_HEAD + `
    attribute vec4 iparm;           // x: 模様, y: 乱数の種, w: 光る強さ
    varying vec3 vWorld, vLocal, vN, vNL, vCol;
    varying vec4 vParm;
    void main() {
      vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vec4 lp = instanceMatrix * vec4(position, 1.0);
      vLocal = lp.xyz;
      vNL = normalize(mat3(instanceMatrix) * (normal / (sc * sc)));
      vec4 wp = modelMatrix * lp;
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * vNL);
      vCol = vec3(1.0);
      #ifdef USE_INSTANCING_COLOR
        vCol = instanceColor;
      #endif
      vParm = iparm;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;` + GL.VS_TAIL + `
    }`;
  // 模様: 0 無地 / 1 床（場所に合わせて大理石・板張り・石のタイル）と天井 / 2 浴室のタイル / 3 照明 / 4 いつも光る / 5 酒の棚
  //       6 テレビの画面 / 7 大理石 / 8 布（ソファ・ベッド） / 9 木の板張りの壁
  const FS = GL.FS_HEAD + GL.COMMON + GL.NOISE2 + `
    uniform float lamp, tv;
    varying vec3 vWorld, vLocal, vN, vNL, vCol;
    varying vec4 vParm;
    vec3 marble(vec2 p, vec3 c) {
      float v = vnoise(p * 1.3) + 0.5 * vnoise(p * 3.1 + 7.0) + 0.25 * vnoise(p * 7.7);
      float vein = 1.0 - smoothstep(0.0, 0.02, abs(fract(v * 2.2) - 0.5));
      return c * (0.95 + 0.07 * vnoise(p * 0.7)) * (1.0 - 0.12 * vein * (0.5 + 0.5 * vnoise(p * 0.5 + 3.0)));
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN), NL = normalize(vNL), Vv = normalize(cameraPosition - vWorld);
      if (!gl_FrontFacing) { N = -N; NL = -NL; }
      int pat = int(vParm.x + 0.5);
      vec3 q = vLocal;
      float fk = clamp(1.0 - (fwidth(q.x) + fwidth(q.z) + fwidth(q.y)) * 5.0, 0.0, 1.0);
      vec3 base = vCol * (0.96 + 0.08 * vnoise(q.xz * 0.9 + q.y * 1.7 + vParm.y));
      float gloss = 0.0;
      if (pat == 1 && NL.y > 0.5) {
        if (q.x < -3.2 && q.z > 4.4) {
          // 浴室: 濃い灰色の石のタイル
          vec2 g = abs(fract(q.xz / 0.9) - 0.5) * 0.9;
          base = vec3(0.30, 0.30, 0.31) * (0.9 + 0.2 * hash(floor(q.xz / 0.9))) * (1.0 - 0.35 * fk * (1.0 - smoothstep(0.0, 0.01, 0.45 - max(g.x, g.y))));
          gloss = 0.5;
        } else if (q.x > 3.2 && q.z > 4.4) {
          // 寝室: 板張り
          float row = floor(q.z / 0.19), off = hash(vec2(row, 3.0)) * 2.0, seg = floor((q.x + off) / 2.1);
          vec2 e = vec2(fract(q.z / 0.19), fract((q.x + off) / 2.1));
          float gap = 1.0 - step(0.05, e.x) * step(0.006, e.y);
          base = vec3(0.50, 0.35, 0.23) * (0.82 + 0.30 * hash(vec2(row, seg))) * (0.94 + 0.12 * vnoise(vec2(q.x * 9.0, row))) * (1.0 - 0.30 * gap * fk);
          gloss = 0.25;
        } else {
          // 居間・食堂・玄関: 大きな大理石の板
          vec2 g = abs(fract(q.xz / 1.2) - 0.5) * 1.2;
          base = marble(q.xz, vec3(0.80, 0.79, 0.76)) * (1.0 - 0.25 * fk * (1.0 - smoothstep(0.0, 0.006, 0.6 - max(g.x, g.y))));
          gloss = 0.8;
        }
      } else if (pat == 1) {
        base = vec3(0.93, 0.93, 0.92);
      } else if (pat == 2) {
        vec2 p = abs(NL.y) > 0.5 ? q.xz : vec2(q.x + q.z, q.y);
        vec2 g = abs(fract(p / 0.3) - 0.5) * 0.3;
        base *= (0.95 + 0.08 * hash(floor(p / 0.3))) * (1.0 - 0.25 * fk * (1.0 - smoothstep(0.0, 0.01, 0.15 - max(g.x, g.y))));
        gloss = 0.4;
      } else if (pat == 5 && abs(NL.y) < 0.5) {
        // 酒の棚: 段ごとに並んだ瓶（色とりどり）、裏から照らす
        vec2 p = vec2(q.x + q.z, q.y);
        float shelf = step(0.05, fract(p.y / 0.45));
        vec2 id = vec2(floor(p.x / 0.11), floor(p.y / 0.45));
        float h = hash(id), bh = 0.20 + 0.18 * h;
        float bottle = step(fract(p.y / 0.45) * 0.45, bh) * step(0.18, fract(p.x / 0.11)) * step(fract(p.x / 0.11), 0.82) * step(0.25, h);
        vec3 bc = mix(vec3(0.35, 0.22, 0.10), mix(vec3(0.12, 0.30, 0.16), vec3(0.75, 0.72, 0.62), step(0.6, hash(id + 3.0))), step(0.45, h));
        base = mix(vCol * 0.5, bc, bottle * shelf * fk) + vec3(1.0, 0.85, 0.6) * 0.25 * shelf * (1.0 - bottle) * lamp;
      } else if (pat == 7) {
        base = marble(abs(NL.y) > 0.5 ? q.xz * 1.7 : vec2(q.x + q.z, q.y) * 1.7, vCol);
        gloss = 0.7;
      } else if (pat == 8) {
        base *= 0.92 + 0.08 * vnoise(vec2(q.x + q.z, q.y) * 60.0) * fk;
      } else if (pat == 9) {
        vec2 p = vec2(q.x + q.z, q.y);
        base = vCol * (0.86 + 0.18 * vnoise(vec2(p.x * 3.0, p.y * 40.0))) * (1.0 - 0.35 * fk * step(fract(p.x / 0.6), 0.012));
        gloss = 0.2;
      }
      // ---- 光: 窓から入る昼の光（影なし）と、部屋の照明 ----
      vec3 up = normalize(vec3(-vWorld.xy, 1e-3)), ld = sunDirAt(vWorld);
      vec3 day = (ambCol * 0.40 + sunCol * 0.13) * (0.82 + 0.18 * NL.y) + sunCol * max(dot(N, ld), 0.0) * 0.12;
      vec3 lit = lamp * vec3(1.0, 0.86, 0.68) * (0.40 + 0.14 * max(NL.y, 0.0));
      vec3 col = base * (day + lit);
      // 磨いた床・石: 窓の明るさと照明の照り返し
      float fres = pow(1.0 - max(dot(N, Vv), 0.0), 4.0);
      col += gloss * (fres * 0.18 + 0.015) * (ambCol * 0.6 + sunCol * 0.2 + lamp * vec3(0.9, 0.78, 0.6) * 0.3);
      if (pat == 3) col = base * (day * 0.5) + lamp * vec3(1.0, 0.92, 0.78) * 1.1;
      else if (pat == 4) col = base * day * 0.6 + base * vParm.w * (0.5 + 0.8 * night);
      else if (pat == 6) {
        // テレビ: つけると、ゆっくり流れる景色（空・山・海）
        vec2 s = vec2(q.x + q.z, q.y) * 0.6;
        float t = time * 0.05;
        vec3 sky = mix(vec3(0.95, 0.62, 0.35), vec3(0.25, 0.45, 0.85), smoothstep(1.4, 1.9, q.y));
        float hill = 1.25 + 0.18 * vnoise(vec2(s.x * 2.0 + t * 4.0, 1.0)) + 0.08 * vnoise(vec2(s.x * 7.0 + t * 9.0, 2.0));
        vec3 img = mix(vec3(0.10, 0.28, 0.22) * (0.7 + 0.5 * vnoise(s * 9.0 + t * 6.0)), sky, smoothstep(hill - 0.01, hill + 0.01, q.y));
        img = mix(img, vec3(0.10, 0.30, 0.55) * (0.8 + 0.4 * vnoise(vec2(s.x * 20.0 + t * 30.0, s.y * 60.0))), step(q.y, 1.05));
        col = mix(vec3(0.015, 0.016, 0.02) + (ambCol * 0.4 + sunCol * 0.1) * fres * 0.6, img * 0.9, tv);
      }
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`;
  // ガラス（窓・仕切り・シャワー）と水面（ジャグジー）。模様 1: 水面, 2: すりガラス
  const GFS = GL.FS_HEAD + GL.COMMON + GL.NOISE2 + `
    uniform float lamp, bub;
    varying vec3 vWorld, vLocal, vN, vNL, vCol;
    varying vec4 vParm;
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN), Vv = normalize(cameraPosition - vWorld);
      float fres = 0.04 + 0.96 * pow(1.0 - abs(dot(N, Vv)), 5.0);
      vec3 sky = ambCol * 1.25 + sunCol * 0.35;
      vec3 col; float a;
      if (vParm.x > 1.5) {
        // すりガラス: 向こうがぼんやり見える
        col = vec3(0.85, 0.88, 0.88) * (ambCol * 0.7 + sunCol * 0.2 + lamp * vec3(0.7, 0.62, 0.5));
        a = 0.62;
      } else if (vParm.x > 0.5) {
        // ジャグジーの水面: 波と泡
        vec2 p = vLocal.xz;
        float w = 0.85 + 0.15 * sin(p.x * 7.0 + time * 3.0 * (0.4 + bub)) * sin(p.y * 6.0 - time * 2.6 * (0.4 + bub));
        float foam = bub * smoothstep(0.62, 0.80, vnoise(p * 9.0 + vec2(time * 1.7, -time * 1.3)) * 0.6 + vnoise(p * 23.0 - time * 2.3) * 0.4);
        vec3 water = vec3(0.12, 0.55, 0.70) * w * (ambCol * 0.8 + sunCol * 0.3 + vec3(0.35, 0.75, 0.85) * (0.4 + 0.5 * night));
        col = mix(mix(water, sky, fres * 0.5), vec3(0.92, 0.95, 0.96) * (ambCol + sunCol * 0.3 + lamp * 0.4), foam);
        a = mix(0.70 + 0.25 * fres, 0.95, foam);
      } else {
        // 窓ガラス: ほぼ透明。浅い角度と夜は部屋の明かりを少し映す
        col = mix(vec3(0.02, 0.03, 0.035), sky, fres) + lamp * night * vec3(1.0, 0.85, 0.65) * 0.05;
        a = 0.05 + 0.50 * fres + lamp * night * 0.05;
      }
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
    }`;

  // ================= 建てる =================
  function build() {
    const bag = new Kit.Bag(), glass = new Kit.Bag();
    let seed = 0;
    const m16 = function (x0, x1, y0, y1, z0, z1) { return [x1 - x0, 0, 0, 0, 0, y1 - y0, 0, 0, 0, 0, z1 - z0, 0, (x0 + x1) / 2, y0, (z0 + z1) / 2, 1]; };
    const B = function (x0, x1, y0, y1, z0, z1, col, pat, glow) { bag.addM('box', m16(x0, x1, y0, y1, z0, z1), col, pat || 0, (seed++) % 97, 0, glow || 0); };
    const C = function (kind, x, y, z, d, h, col, pat, glow) {           // 円柱・半球（dome は h が高さ）
      bag.addM(kind, [d, 0, 0, 0, 0, kind === 'dome' ? h * 2 : h, 0, 0, 0, 0, d, 0, x, y, z, 1], col, pat || 0, (seed++) % 97, 0, glow || 0);
    };
    const G = function (x0, x1, y0, y1, z0, z1, kind) { glass.addM('box', m16(x0, x1, y0, y1, z0, z1), [0.6, 0.7, 0.75], kind || 0, 0, 0, 0); };
    const S = function (x0, x1, y0, y1, z0, z1) { const s = Kit.addSolid(0, U0 + x0, U0 + x1, Z0 + z0, Z0 + z1, Y0 + y0, Y0 + y1); s.keep = true; };
    const BS = function (x0, x1, y0, y1, z0, z1, col, pat, glow) { B(x0, x1, y0, y1, z0, z1, col, pat, glow); S(x0, x1, y0, y1, z0, z1); };
    const H = HS;
    const FRAME = [0.16, 0.16, 0.17], WALNUT = [0.36, 0.24, 0.16], CREAM = [0.90, 0.87, 0.80], WHITE = [0.95, 0.95, 0.94];
    const STONEW = [0.86, 0.84, 0.80], DARK = [0.10, 0.10, 0.11], BRASS = [0.78, 0.62, 0.34], LEATHER = [0.40, 0.28, 0.20];
    const SOFA = [0.80, 0.78, 0.74], SOFA2 = [0.22, 0.30, 0.36], GREEN = [0.20, 0.42, 0.22];

    // ---- 床・天井・柱 ----
    BS(-H - 0.3, H + 0.3, -0.5, 0, -H - 0.3, H + 0.3, WHITE, 1);
    BS(-H - 0.3, H + 0.3, CH, CH + 0.4, -H - 0.3, H + 0.3, WHITE, 1);
    for (let k = 0; k < 4; k++) {                                        // 四隅の柱
      const x = (k & 1 ? 1 : -1) * (H - 0.35), z = (k & 2 ? 1 : -1) * (H - 0.35);
      BS(x - 0.45, x + 0.45, 0, CH, z - 0.45, z + 0.45, STONEW, 7);
    }
    // ---- 四方の窓: 床から天井までのガラスと細い方立て（当たり判定は壁として） ----
    const NM = 10;
    for (let sd = 0; sd < 4; sd++) {
      const alongX = sd < 2, c = (sd % 2 ? 1 : -1) * (H - 0.02);
      const W = function (a0, a1, y0, y1, d0, d1, col, pat) { if (alongX) B(a0, a1, y0, y1, c + d0, c + d1, col, pat); else B(c + d0, c + d1, y0, y1, a0, a1, col, pat); };
      if (alongX) { G(-H, H, 0.08, CH - 0.08, c - 0.015, c + 0.015); S(-H, H, 0, CH, c - 0.1, c + 0.1); }
      else { G(c - 0.015, c + 0.015, 0.08, CH - 0.08, -H, H); S(c - 0.1, c + 0.1, 0, CH, -H, H); }
      W(-H, H, 0, 0.08, -0.06, 0.06, FRAME); W(-H, H, CH - 0.12, CH, -0.06, 0.06, FRAME);
      for (let k = 1; k < NM; k++) { const a = -H + 2 * H * k / NM; W(a - 0.04, a + 0.04, 0, CH, -0.06, 0.06, FRAME); }
      // 窓ぎわの天井の間接照明
      W(-H + 0.8, H - 0.8, CH - 0.06, CH, (sd % 2 ? -1 : 1) * 0.55 - 0.1, (sd % 2 ? -1 : 1) * 0.55 + 0.1, [1, 0.93, 0.8], 3);
    }

    // ---- 中央の芯（エレベーター・テレビの壁・洗面台・酒の棚） ----
    const cx = 3.2, cz = 2.6;
    BS(-cx, cx, 0, CH, -cz, cz, WALNUT, 9);
    // 南: エレベーターの扉2枚（金色の枠）と呼びボタン
    for (let k = 0; k < 2; k++) {
      const x = k ? 1.6 : -1.6;
      B(x - 0.75, x + 0.75, 0, 2.45, -cz - 0.03, -cz, [0.62, 0.62, 0.60], 0);
      B(x - 0.01, x + 0.01, 0, 2.45, -cz - 0.04, -cz, DARK);
      B(x - 0.85, x + 0.85, 2.45, 2.6, -cz - 0.05, -cz, BRASS);
      B(x - 0.85, x - 0.75, 0, 2.45, -cz - 0.05, -cz, BRASS); B(x + 0.75, x + 0.85, 0, 2.45, -cz - 0.05, -cz, BRASS);
      B(x - 0.25, x + 0.25, 2.7, 2.85, -cz - 0.04, -cz, [1.0, 0.85, 0.55], 4, 0.6);          // 階の表示
    }
    B(-0.12, 0.12, 1.1, 1.4, -cz - 0.04, -cz, BRASS); B(-0.05, 0.05, 1.2, 1.3, -cz - 0.05, -cz - 0.04, [1, 0.9, 0.6], 4, 1.0);
    spots.push({ kind: 'lift', p: [0, 1.2, -cz - 0.8], r: 2.4 });
    // 照明のスイッチ（エレベーターの横）
    B(2.75, 2.95, 1.15, 1.35, -cz - 0.03, -cz, [0.95, 0.94, 0.90]);
    spots.push({ kind: 'lamp', p: [2.85, 1.25, -cz - 0.3], r: 1.4 });
    // 西: 大きなテレビと、その下の低い棚
    B(-cx - 0.08, -cx, 0.95, 2.75, -1.65, 1.65, DARK); B(-cx - 0.09, -cx - 0.08, 1.0, 2.7, -1.6, 1.6, [1, 1, 1], 6);
    BS(-cx - 0.5, -cx, 0, 0.45, -2.3, 2.3, WALNUT, 9); B(-cx - 0.52, -cx, 0.45, 0.48, -2.32, 2.32, [0.85, 0.84, 0.82], 7);
    spots.push({ kind: 'tv', p: [-6.5, 1.2, 0], r: 3.6 });
    // 北: 洗面台（大理石の天板・2つの鉢・鏡と明かり）
    BS(-2.9, 2.9, 0, 0.85, cz, cz + 0.6, WALNUT, 9); B(-2.95, 2.95, 0.85, 0.9, cz, cz + 0.65, [0.92, 0.91, 0.88], 7);
    for (let k = 0; k < 2; k++) { const x = k ? 1.3 : -1.3; C('cyl', x, 0.9, cz + 0.32, 0.45, 0.14, WHITE); B(x - 0.02, x + 0.02, 0.9, 1.15, cz + 0.05, cz + 0.1, BRASS); }
    B(-2.6, 2.6, 1.15, 2.35, cz, cz + 0.03, [0.70, 0.78, 0.82], 4, 0.18);
    B(-2.7, 2.7, 2.4, 2.48, cz, cz + 0.05, [1, 0.93, 0.8], 3);
    // 東: 酒の棚とバーカウンター、背の高い椅子
    B(cx, cx + 0.04, 0.9, 2.6, -2.2, 2.2, [0.30, 0.20, 0.14], 5);
    BS(cx + 0.9, cx + 1.5, 0, 1.05, -2.0, 2.0, WALNUT, 9); B(cx + 0.85, cx + 1.6, 1.05, 1.1, -2.1, 2.1, [0.12, 0.12, 0.13], 7);
    B(cx + 1.5, cx + 1.52, 0.2, 0.95, -1.9, 1.9, [1, 0.88, 0.62], 3);
    for (let k = 0; k < 3; k++) { const z = -1.3 + k * 1.3; C('cyl', cx + 2.1, 0, z, 0.08, 0.72, BRASS); C('cyl', cx + 2.1, 0.72, z, 0.42, 0.08, LEATHER); }
    // 芯の上の天井まわりの光の帯
    B(-cx - 0.05, cx + 0.05, CH - 0.25, CH - 0.2, -cz - 0.05, cz + 0.05, [1, 0.92, 0.75], 3);

    // ---- 居間（西）: L字のソファ・ひじ掛けいす・大理石の低いテーブル・敷物・床置きの灯り ----
    B(-10.4, -3.8, 0, 0.015, -3.8, 3.8, [0.70, 0.66, 0.58], 8);
    BS(-9.2, -8.2, 0, 0.42, -3.2, 3.2, SOFA, 8); B(-9.2, -8.8, 0.42, 0.95, -3.2, 3.2, SOFA, 8);
    B(-8.8, -8.2, 0.42, 0.56, -3.1, 3.1, [0.86, 0.84, 0.80], 8);
    BS(-9.2, -6.6, 0, 0.42, 2.4, 3.2, SOFA, 8); B(-9.2, -6.6, 0.42, 0.95, 2.8, 3.2, SOFA, 8);
    for (let k = 0; k < 4; k++) { const z = -2.4 + k * 1.3; B(-8.75, -8.6, 0.56, 0.95, z - 0.4, z + 0.4, [0.60, 0.35, 0.28], 8); }   // クッション
    BS(-6.6, -4.9, 0, 0.36, -1.0, 1.0, [0.92, 0.91, 0.88], 7);
    C('cyl', -5.75, 0.36, 0.4, 0.22, 0.25, [0.30, 0.42, 0.50]); C('dome', -5.75, 0.6, 0.4, 0.3, 0.2, [0.85, 0.30, 0.35]);   // 花瓶と花
    BS(-6.2, -5.0, 0, 0.42, -3.3, -2.3, SOFA2, 8); B(-6.2, -5.0, 0.42, 0.9, -3.3, -3.1, SOFA2, 8);          // ひじ掛けいす
    C('cyl', -10.6, 0, -3.6, 0.3, 0.05, BRASS); C('cyl', -10.6, 0.05, -3.6, 0.04, 1.55, BRASS); C('cone', -10.6, 1.55, -3.6, 0.5, 0.35, [1, 0.92, 0.78], 3);
    C('cyl', -10.6, 0, 3.8, 0.3, 0.05, BRASS); C('cyl', -10.6, 0.05, 3.8, 0.04, 1.55, BRASS); C('cone', -10.6, 1.55, 3.8, 0.5, 0.35, [1, 0.92, 0.78], 3);
    // ピアノ（窓ぎわ、南西）
    BS(-10.8, -8.6, 0, 1.0, -9.6, -7.9, DARK, 7); B(-10.75, -8.65, 0.72, 0.76, -7.95, -7.6, WHITE); B(-10.75, -8.65, 0.76, 0.78, -7.95, -7.75, DARK);
    C('cyl', -9.7, 0, -7.1, 0.5, 0.48, LEATHER);

    // ---- 玄関（南）: 丸いテーブルと花 ----
    C('cyl', 0, 0, -6.8, 0.5, 0.75, WALNUT); C('cyl', 0, 0.75, -6.8, 1.3, 0.04, [0.92, 0.91, 0.88], 7);
    C('cyl', 0, 0.79, -6.8, 0.26, 0.38, WHITE);
    [[0, 0, [0.92, 0.88, 0.86]], [0.12, 0.05, [0.85, 0.35, 0.45]], [-0.1, 0.08, [0.95, 0.80, 0.40]], [0.03, -0.12, [0.80, 0.40, 0.55]], [-0.08, -0.07, [0.30, 0.52, 0.28]]].forEach(function (f) {
      C('dome', f[0], 1.12 + Math.abs(f[1]) * 0.6, -6.8 + f[1], 0.22, 0.14, f[2], 8);
    });

    // ---- 食堂（南東）: 8人がけのテーブルと椅子、吊るした灯り ----
    BS(5.0, 10.2, 0.74, 0.79, -8.4, -6.4, [0.20, 0.13, 0.09], 9);
    for (let k = 0; k < 2; k++) B(k ? 9.4 : 5.6, k ? 9.6 : 5.8, 0, 0.74, -7.6, -7.2, [0.20, 0.13, 0.09]);
    for (let k = 0; k < 4; k++) for (let sd = -1; sd <= 1; sd += 2) {
      const x = 5.7 + k * 1.27, z = -7.4 + sd * 1.45;
      BS(x - 0.25, x + 0.25, 0, 0.47, z - 0.25, z + 0.25, CREAM, 8); B(x - 0.25, x + 0.25, 0.47, 1.0, z + sd * 0.19, z + sd * 0.25, CREAM, 8);
    }
    for (let k = 0; k < 3; k++) { const x = 6.0 + k * 1.6; C('cyl', x, 2.6, -7.4, 0.02, CH - 2.6, FRAME); C('cone', x, 2.3, -7.4, 0.55, 0.35, [1, 0.9, 0.7], 3); }
    // 東の窓ぎわ: くつろぐ椅子2脚と小さなテーブル、望遠鏡
    for (let k = 0; k < 2; k++) {
      const z = k ? 1.8 : -1.8;
      BS(9.2, 10.3, 0, 0.4, z - 0.5, z + 0.5, SOFA2, 8); B(8.95, 9.2, 0.25, 1.05, z - 0.5, z + 0.5, SOFA2, 8);
    }
    C('cyl', 9.8, 0, 0, 0.6, 0.5, [0.92, 0.91, 0.88], 7);
    C('cyl', 10.9, 0, -5.5, 0.06, 1.25, FRAME); B(10.75, 11.05, 1.25, 1.45, -5.95, -5.0, [0.85, 0.86, 0.88]);

    // ---- 寝室（北東）: 仕切りの壁、大きなベッド（窓の方を向く）、そで机と灯り、たんす ----
    const pz = 4.4;
    BS(5.0, H - 0.8, 0, CH, pz - 0.12, pz + 0.12, CREAM);
    B(5.0, H - 0.8, 0, 0.1, pz - 0.14, pz + 0.14, WALNUT);
    B(6.6, 10.4, 0.6, 2.2, pz + 0.12, pz + 0.22, [0.48, 0.38, 0.30], 8);                        // 頭板（布張り）
    const bx0 = 7.3, bx1 = 9.7, bz0 = pz + 0.22, bz1 = bz0 + 2.3;
    BS(bx0, bx1, 0, 0.32, bz0, bz1, WALNUT, 9);
    B(bx0 + 0.05, bx1 - 0.05, 0.32, 0.6, bz0 + 0.03, bz1 - 0.05, WHITE, 8);
    B(bx0 - 0.02, bx1 + 0.02, 0.6, 0.68, bz0 + 0.8, bz1 + 0.02, [0.86, 0.84, 0.80], 8);
    B(bx0 - 0.03, bx1 + 0.03, 0.62, 0.7, bz1 - 0.6, bz1 - 0.15, [0.55, 0.40, 0.30], 8);       // 足もとの掛け布
    B(bx0 + 0.15, bx0 + 1.1, 0.6, 0.78, bz0 + 0.1, bz0 + 0.65, WHITE, 8); B(bx1 - 1.1, bx1 - 0.15, 0.6, 0.78, bz0 + 0.1, bz0 + 0.65, WHITE, 8);
    spots.push({ kind: 'bed', p: [(bx0 + bx1) / 2, 0.6, (bz0 + bz1) / 2], r: 2.6 });
    for (let k = 0; k < 2; k++) {
      const x = k ? bx1 + 0.55 : bx0 - 0.55;
      BS(x - 0.35, x + 0.35, 0, 0.55, pz + 0.25, pz + 0.85, WALNUT, 9);
      C('cyl', x, 0.55, pz + 0.55, 0.14, 0.35, BRASS); C('cone', x, 0.85, pz + 0.55, 0.42, 0.3, [1, 0.92, 0.78], 3);
    }
    B(bx0, bx1, 0, 0.45, bz1 + 0.35, bz1 + 0.8, LEATHER, 8);                                   // ベッドの足もとの長いす
    BS(H - 0.75, H - 0.15, 0, 2.3, 6.0, 9.5, WALNUT, 9);                                        // たんす
    B(H - 0.77, H - 0.75, 1.1, 1.2, 7.7, 7.8, BRASS);
    B(6.0, 11.0, 0, 0.012, bz0 - 0.2, bz1 + 1.4, [0.78, 0.74, 0.68], 8);                          // 敷物
    // ---- 浴室（北西）: すりガラスの仕切り、ジャグジー（窓ぎわ）、ガラスのシャワー ----
    G(-H + 0.8, -5.0, 0, 2.4, pz - 0.03, pz + 0.03, 2); S(-H + 0.8, -5.0, 0, CH, pz - 0.1, pz + 0.1);
    B(-H + 0.8, -5.0, 2.4, 2.5, pz - 0.05, pz + 0.05, FRAME); B(-H + 0.8, -5.0, 0, 0.06, pz - 0.05, pz + 0.05, FRAME);
    const jx = -7.6, jz = 8.2;
    C('cyl', jx, 0, jz, 4.6, 0.25, [0.30, 0.30, 0.31], 7); S(jx - 2.3, jx + 2.3, 0, 0.25, jz - 2.3, jz + 2.3);
    // 湯船: 円く並べた縁（中は水）。底は水色のタイル
    C('cyl', jx, 0.25, jz, 3.3, 0.05, [0.55, 0.78, 0.86], 2);
    const NR = 20, RR = 1.68;
    for (let k = 0; k < NR; k++) {
      const a = (k + 0.5) / NR * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a), L = 2 * Math.PI * RR / NR + 0.06, T = 0.24;
      bag.addM('box', [-sn * L, 0, c * L, 0, 0, 0.45, 0, 0, c * T, 0, sn * T, 0, jx + c * RR, 0.25, jz + sn * RR, 1], [0.93, 0.93, 0.92], 7, (seed++) % 97, 0, 0);
    }
    S(jx - 1.8, jx + 1.8, 0.25, 0.70, jz - 1.8, jz + 1.8);
    glass.addM('cyl', [3.2, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 3.2, 0, jx, 0.58, jz, 1], [0.6, 0.7, 0.75], 1, 0, 0, 0);
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; C('cyl', jx + Math.cos(a) * 1.55, 0.4, jz + Math.sin(a) * 1.55, 0.1, 0.06, [0.7, 0.9, 1.0], 4, 0.8); }
    spots.push({ kind: 'jacuzzi', p: [jx, 1.0, jz], r: 3.0 });
    // シャワー（芯の北西の角）: ガラスの囲い、雨のように落ちる大きな頭
    G(-5.0, -5.0 + 0.02, 0, 2.3, pz + 0.1, pz + 2.6); G(-5.0, -3.4, 0, 2.3, pz + 2.6, pz + 2.62);
    S(-5.05, -4.95, 0, CH, pz + 0.1, pz + 2.6); S(-5.0, -3.6, 0, CH, pz + 2.55, pz + 2.65);
    B(-4.9, -3.3, 0, 0.05, pz + 0.15, pz + 2.55, [0.30, 0.30, 0.31], 2);
    B(-4.4, -3.8, CH - 0.25, CH - 0.2, pz + 0.9, pz + 1.5, BRASS);
    B(-3.35, -3.2, 0.05, CH, pz + 0.12, pz + 2.6, [0.88, 0.88, 0.86], 2);
    // タオルの棚と、窓ぎわの大きな鉢植え
    BS(-H + 0.6, -H + 1.1, 0, 1.6, 5.0, 6.4, WALNUT, 9); for (let k = 0; k < 3; k++) B(-H + 0.62, -H + 1.08, 0.3 + k * 0.45, 0.48 + k * 0.45, 5.1, 6.3, WHITE, 8);
    [[-H + 1.2, -H + 1.2], [H - 1.2, -H + 1.2], [-3.9, 3.6], [4.6, -3.4], [H - 1.3, 3.3]].forEach(function (q) {
      C('cyl', q[0], 0, q[1], 0.75, 0.6, [0.85, 0.84, 0.80], 7); C('dome', q[0], 0.6, q[1], 1.3, 1.4, GREEN);
    });
    // 天井の照明（四角い明かりを並べる）
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const x = a * 4.4, z = b * 4.4;
      if (Math.abs(x) < 4 && Math.abs(z) < 3.5) continue;
      B(x - 0.35, x + 0.35, CH - 0.03, CH, z - 0.35, z + 0.35, [1, 0.95, 0.85], 3);
    }

    // ---- まとめて描く ----
    const mat = GL.material(VS, FS, null, {}), gmat = GL.material(VS, GFS, null, { transparent: true, depthWrite: false, side: THREE.DoubleSide });
    for (const k in U) { mat.uniforms[k] = U[k]; gmat.uniforms[k] = U[k]; }
    const grp = new THREE.Group();
    grp.matrixAutoUpdate = false;
    grp.matrix.set(E[0], UP[0], 0, O[0], E[1], UP[1], 0, O[1], E[2], UP[2], 1, O[2], 0, 0, 0, 1);
    bag.build(grp, false, { box: mat, cyl: mat, dome: mat, cone: mat });
    const n0 = grp.children.length;
    glass.build(grp, false, { box: gmat, cyl: gmat });
    for (let k = n0; k < grp.children.length; k++) grp.children[k].renderOrder = 3;
    sceneRef.add(grp);
    grp.updateMatrixWorld(true);
    // テレビの画面（動画）。芯の西の面、黒い枠の中
    COL.addTV(grp, 'hotel', 3.1, 1.62, [-cx - 0.095, 1.85, 0], -Math.PI / 2, V.add(O, V.add(V.mul(E, -cx - 0.1), V.mul(UP, 1.85))));
  }

  // ================= 玄関の案内板 =================
  function buildSign() {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 1024;
    const c = cv.getContext('2d');
    c.fillStyle = '#16181c'; c.fillRect(0, 0, 512, 1024);
    c.strokeStyle = '#c9a25a'; c.lineWidth = 10; c.strokeRect(24, 24, 464, 976);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#e6c27a'; c.font = 'bold 92px serif'; c.fillText('SKY', 256, 170); c.fillText('SUITE', 256, 270);
    c.font = '46px serif'; c.fillText('HOTEL', 256, 360);
    c.fillStyle = '#f2efe6'; c.font = 'bold 44px sans-serif'; c.fillText('最上階スイート', 256, 520);
    c.font = '36px sans-serif'; c.fillText('ワンフロア貸し切り', 256, 580);
    c.fillStyle = '#e6c27a'; c.font = 'bold 62px sans-serif'; c.fillText('1泊 ' + COL.fmtCr(PRICE), 256, 720);
    c.fillStyle = '#cfcac0'; c.font = '34px sans-serif'; c.fillText('E キーでチェックイン', 256, 860);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 8;
    const su = U0 + 9.5, sz = front - 4.0, th = COL.landTheta(0, su), f = COL.frameAt(th), g = COL.groundH(th, sz), p = COL.toWorld(th, sz, g);
    const X = V.mul(f.east, -1), Yv = f.up, Zv = [0, 0, -1];
    const grp = new THREE.Group();
    grp.matrixAutoUpdate = false;
    grp.matrix.set(X[0], Yv[0], Zv[0], p[0], X[1], Yv[1], Zv[1], p[1], X[2], Yv[2], Zv[2], p[2], 0, 0, 0, 1);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 3.0), new THREE.MeshBasicMaterial({ map: tex }));
    board.position.set(0, 1.9, 0.07);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3.3, 0.12), COL.objectMaterial(0x2a2c30));
    back.position.set(0, 1.85, 0);
    grp.add(board); grp.add(back);
    sceneRef.add(grp);
    grp.updateMatrixWorld(true);
    signPos = COL.toWorld(th, sz, g + 1.5);
  }

  // 世界の位置 → 部屋の座標
  function toLocal(w) { const d = V.sub(w, O); return [V.dot(d, E), V.dot(d, UP), d[2]]; }
  function inside(pos) {
    const q = toLocal(pos);
    return Math.abs(q[0]) < HS + 0.6 && Math.abs(q[2]) < HS + 0.6 && q[1] > -1.0 && q[1] < CH + 0.5;
  }

  COL.buildHotel = function (scene) {
    Kit = COL.CityKit; sceneRef = scene;
    // 塔を探す（街区の計画から）。最上段の箱の、屋上のすぐ下の階を部屋にする
    const list = COL.buildingsNear(0, NEAR[0], NEAR[1], 40).filter(function (b) { return b.arche === 'office'; });
    if (!list.length) return;
    tower = list.sort(function (a, b) { return b.h - a.h; })[0];
    let top = null;
    tower.M.forEach(function (m) { if (m.solid && m.kind === 'box' && (!top || m.y > top.y)) top = m; });
    tower.clearView = top;                    // この段の外壁には縦のルーバーを付けない（city.js）
    U0 = tower.u + (top.ox || 0); Z0 = tower.z + (top.oz || 0);
    HS = Math.min(top.w, top.d) / 2 - 0.35;
    Y0 = tower.base + top.y + top.h - CH - 1.6;
    front = tower.z - tower.d / 2;
    TH0 = COL.landTheta(0, U0);
    const f = COL.frameAt(TH0);
    E = f.east; UP = f.up; O = COL.toWorld(TH0, Z0, Y0);
    // 部屋の中にいる間は、塔の本体（部屋を囲む箱）の当たり判定を外す
    COL.solidSkip = function (s) {
      if (s.keep || !(s.u0 < U0 && s.u1 > U0 && s.z0 < Z0 && s.z1 > Z0)) return false;
      return !!COL.player && inside(COL.player.pos);
    };
    build();
    buildSign();
    ok = true;
    COL.hotelInfo = { u: U0, z: Z0, y: Y0, hs: HS, toLocal: toLocal };
  };

  // 部屋へ（エレベーターの前に出る）/ 1階の玄関の前へ
  function moveTo(p, u, z, h, fwd) {
    const th = COL.landTheta(0, u), np = COL.createPlayer(th, z, h);
    p.pos = np.pos; p.vel = [0, 0, 0]; p.up = np.up; p.fwd = fwd; p.pitch = 0; p.fly = false;
    COL.stepPlayer(p, {}, 0);
  }
  function toRoom(p) { moveTo(p, U0, Z0 - 2.6 - 1.6, Y0 + 0.05, [0, 0, -1]); }
  function toLobby(p) { moveTo(p, U0, front - 6, COL.groundH(COL.landTheta(0, U0), front - 6) + 0.1, [0, 0, -1]); }
  COL.goHotel = function (p) { if (ok) toRoom(p); };
  // H キーの行き先「ホテル」: 今夜の宿泊代を払ってあれば部屋へ、まだなら1階の玄関（案内板）の前へ
  COL.hotelTeleport = function (p) {
    if (!ok) return;
    if (COL.save.hotelPaid) toRoom(p);
    else { toLobby(p); COL.toast('スカイスイートホテルの玄関です\n案内板の前で E: チェックイン（1泊 ' + COL.fmtCr(PRICE) + '）', 5); }
  };

  function sleep(wake) {
    COL.fadeThen(function () {
      COL.setClock(wake);
      COL.toast(wake === 7 ? 'おはようございます\n' + COL.save.day + ' 日目の朝 7:00　窓の外は朝の街です'
                           : 'よく眠れました\n' + COL.save.day + ' 日目の夕方 18:00　これから夜景の時間です', 5);
    }, 700);
  }

  // 毎フレーム。use: E キー, alt: Q キー。戻り値 { text: 案内の文, used: E を使ったか }
  COL.updateHotel = function (dt, p, use, alt) {
    const none = { text: '', used: false };
    if (!ok || COL.isFading() || COL.pilot || COL.ride || COL.driving || COL.onTrain) return none;
    U.bub.value += ((spotBub ? 1 : 0) - U.bub.value) * Math.min(1, dt * 1.5);
    const sv = COL.save;
    // ---- 1階の玄関: 払って部屋へ ----
    if (signPos && V.len(V.sub(p.pos, signPos)) < 14) {
      if (sv.hotelPaid) {
        if (use) { COL.fadeThen(function () { toRoom(p); }, 500); return { text: '', used: true }; }
        return { text: 'E: エレベーターで部屋へ上がる（今夜の宿泊代はお支払い済み）', used: false };
      }
      const lack = PRICE - sv.money;
      if (lack > 0) return { text: 'スカイスイートホテル: 1泊 ' + COL.fmtCr(PRICE) + '　（あと ' + COL.fmtCr(lack) + ' 足りません。宇宙港の採掘船で稼げます）', used: false };
      if (use) {
        sv.money -= PRICE; sv.hotelPaid = true; sv.hotelVisited = true; COL.storeSave();
        COL.fadeThen(function () {
          toRoom(p);
          COL.toast('ようこそ スカイスイートへ\n地上 ' + Math.round(Y0 - tower.base) + ' m のワンフロアが今夜のお部屋です\nベッドで E: 朝まで眠る ／ Q: 夕方まで眠る', 9);
        }, 700);
        return { text: '', used: true };
      }
      return { text: 'E: チェックインして最上階のスイートへ（1泊 ' + COL.fmtCr(PRICE) + '）', used: false };
    }
    // ---- 部屋の中 ----
    if (!inside(p.pos)) return none;
    const e = toLocal(COL.eyePos(p));
    let best = null, bd = 1e9;
    for (let k = 0; k < spots.length; k++) {
      const s = spots[k], d = Math.hypot(e[0] - s.p[0], e[2] - s.p[2]);
      if (d < s.r && d < bd) { bd = d; best = s; }
    }
    if (!best) return none;
    if (best.kind === 'lift') {
      if (use) { COL.fadeThen(function () { toLobby(p); }, 500); return { text: '', used: true }; }
      return { text: 'E: エレベーターで1階へ降りる', used: false };
    }
    if (best.kind === 'lamp') {
      const on = U.lamp.value > 0.5;
      if (use) { U.lamp.value = on ? 0 : 1; return { text: '', used: true }; }
      return { text: 'E: 部屋の明かりを' + (on ? '消す' : 'つける'), used: false };
    }
    if (best.kind === 'tv') {
      const on = COL.tvOn('hotel');
      if (use) { COL.setTV('hotel', !on); return { text: '', used: true }; }
      return { text: 'E: テレビを' + (on ? '消す' : 'つける'), used: false };
    }
    if (best.kind === 'jacuzzi') {
      if (use) { spotBub = !spotBub; return { text: '', used: true }; }
      return { text: 'E: ジャグジーの泡を' + (spotBub ? '止める' : '出す'), used: false };
    }
    // ベッド: 宿泊代を払っていれば眠れる（眠ると1泊ぶんを使う。続けて泊まるときは もう一度払う）
    if (!sv.hotelPaid) {
      const lack = PRICE - sv.money;
      if (lack > 0) return { text: 'ベッド: もう1泊するには ' + COL.fmtCr(PRICE) + ' 必要です（あと ' + COL.fmtCr(lack) + '）', used: false };
      if (use || alt) { sv.money -= PRICE; sv.hotelPaid = false; COL.storeSave(); sleep(use ? 7 : 18); return { text: '', used: true }; }
      return { text: 'ベッド（もう1泊 ' + COL.fmtCr(PRICE) + '）　E: 朝 7:00 まで眠る　／　Q: 夕方 18:00 まで眠る', used: false };
    }
    if (use || alt) { sv.hotelPaid = false; COL.storeSave(); sleep(use ? 7 : 18); return { text: '', used: true }; }
    return { text: 'ベッド　E: 朝 7:00 まで眠る　／　Q: 夕方 18:00 まで眠る', used: false };
  };
})();
