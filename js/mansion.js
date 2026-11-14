// 豪邸: 陸地A・港町のいちばんガラス寄りの空き区画（砂浜のとなり）に建てる 3階建て + 屋上
//  - 買うまでは「売地」の看板だけ。ECON.PRICE を払うとその場に建つ
//  - 中を歩ける（床・壁・階段・屋上に当たり判定）。部屋ごとの明かりを E でつけたり消したりできる
//  - ベッドで E を押すと眠って、次の日の朝 7:00 になる
//  - 建物は敷地の中心での水平面にまっすぐ建てる。座標は x: 周方向（海の側が +）, y: 上, z: 軸方向（ガラスの端の側が +）
(function () {
  'use strict';
  const COL = window.COL, GL = COL.GL, V = COL.V, ECON = COL.ECON;
  const U0 = -1324, Z0 = 29936;                    // 建物の中心（陸地A の u, z）
  const FH = 3.6, SLAB = 0.3;                      // 階の高さ、床の厚み
  const BAND = 8.6;                                // これより北（z が大きい側）は階段の通路
  const CORR = 6.5;                                // 2・3階: これより北は廊下
  const STAIR_X = [-7, 0.5, 8], STEPS = 18, TREAD = 0.28, RISE = FH / STEPS;
  const ROOMS = ['居間', '台所・食堂', '2階の廊下', '客用寝室', '書斎', '浴室', '3階の廊下', '主寝室', 'ラウンジ', '屋上とテラス'];

  let Kit = null, sceneRef = null, Y0 = 0, TH0 = 0, E = null, UP = null, O = null;
  let signGrp = null, built = false;
  const lampU = { lampA: { value: new THREE.Vector4() }, lampB: { value: new THREE.Vector4() }, lampC: { value: new THREE.Vector4() } };
  const switches = [], beds = [];

  function syncLamps() {
    const l = COL.save.lamps;
    lampU.lampA.value.set(l[0], l[1], l[2], l[3]);
    lampU.lampB.value.set(l[4], l[5], l[6], l[7]);
    lampU.lampC.value.set(l[8], l[9], 0, 0);
  }

  // ================= 材料 =================
  const VS = GL.VS_HEAD + `
    attribute vec4 iparm;           // x: 模様, y: 乱数の種, z: 明かりの部屋を直接指定（部屋番号 + 1。0 なら場所から決める）, w: 光る強さ
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
  // 模様: 0 無地 / 1 床と天井（上面は部屋に合わせて板張り・タイル・石） / 2 タイル / 3 照明（その部屋の明かりで光る） / 4 いつも光る / 5 本棚
  const FS = GL.FS_HEAD + GL.COMMON + GL.NOISE2 + GL.SHADOW + `
    uniform vec4 lampA, lampB, lampC;
    varying vec3 vWorld, vLocal, vN, vNL, vCol;
    varying vec4 vParm;
    float lampOf(float i) {
      if (i < 3.5) return i < 0.5 ? lampA.x : i < 1.5 ? lampA.y : i < 2.5 ? lampA.z : lampA.w;
      if (i < 7.5) return i < 4.5 ? lampB.x : i < 5.5 ? lampB.y : i < 6.5 ? lampB.z : lampB.w;
      return i < 8.5 ? lampC.x : lampC.y;
    }
    // その場所がどの部屋か（外なら -1）
    float roomAt(vec3 q) {
      if (abs(q.x) > 16.0 || abs(q.z) > 11.0 || q.y < 0.0 || q.y > 10.8) return -1.0;
      float f = floor(q.y / 3.6);
      if (f < 0.5) return (q.x > 3.1 && q.z < 6.5) ? 1.0 : 0.0;
      if (f < 1.5) return q.z > 6.5 ? 2.0 : (q.x < -5.2 ? 3.0 : (q.x < 5.2 ? 4.0 : 5.0));
      return q.z > 6.5 ? 6.0 : (q.x < 0.0 ? 7.0 : 8.0);
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN), NL = normalize(vNL);
      if (!gl_FrontFacing) { N = -N; NL = -NL; }
      float room = vParm.z > 0.5 ? vParm.z - 1.0 : roomAt(vLocal + NL * 0.08);
      float lamp = room < -0.5 ? 0.0 : lampOf(room);
      int pat = int(vParm.x + 0.5);
      vec3 base = vCol * (0.95 + 0.10 * vnoise(vLocal.xz * 0.9 + vLocal.y * 1.7 + vParm.y));
      float top = step(0.5, NL.y);
      float fk = clamp(1.0 - (fwidth(vLocal.x) + fwidth(vLocal.z) + fwidth(vLocal.y)) * 5.0, 0.0, 1.0);   // 近いほど 1（細かい線を描く）
      if (pat == 1 && top > 0.5) {
        if (room < -0.5) {
          // 屋上とテラス: 石張り
          vec2 g = abs(fract(vLocal.xz / 1.2) - 0.5) * 1.2;
          base = vec3(0.72, 0.71, 0.68) * (0.92 + 0.14 * hash(floor(vLocal.xz / 1.2 - 0.5)))
               * (1.0 - 0.28 * fk * (1.0 - smoothstep(0.0, 0.03, 0.6 - max(g.x, g.y))));
        } else if (abs(room - 1.0) < 0.5 || abs(room - 5.0) < 0.5) {
          // 台所と浴室: タイル
          vec2 g = abs(fract(vLocal.xz / 0.6) - 0.5) * 0.6;
          base = vec3(0.86, 0.87, 0.88) * (0.95 + 0.08 * hash(floor(vLocal.xz / 0.6 - 0.5)))
               * (1.0 - 0.30 * fk * (1.0 - smoothstep(0.0, 0.015, 0.3 - max(g.x, g.y))));
        } else {
          // 板張りの床
          float row = floor(vLocal.z / 0.16), off = hash(vec2(row, 3.0)) * 2.0;
          float seg = floor((vLocal.x + off) / 1.8);
          vec2 e = vec2(fract(vLocal.z / 0.16), fract((vLocal.x + off) / 1.8));
          float gap = 1.0 - step(0.05, e.x) * step(0.008, e.y);
          base = vec3(0.60, 0.42, 0.27) * (0.80 + 0.35 * hash(vec2(row, seg))) * (1.0 - 0.30 * gap * fk);
        }
      } else if (pat == 2) {
        vec2 p = top > 0.5 ? vLocal.xz : vec2(vLocal.x + vLocal.z, vLocal.y);
        vec2 g = abs(fract(p / 0.3) - 0.5) * 0.3;
        base *= (0.94 + 0.10 * hash(floor(p / 0.3 - 0.5))) * (1.0 - 0.25 * fk * (1.0 - smoothstep(0.0, 0.012, 0.15 - max(g.x, g.y))));
      } else if (pat == 5 && top < 0.5) {
        // 本棚: 色とりどりの背表紙と棚板
        vec2 p = vec2(vLocal.x + vLocal.z, vLocal.y);
        float shelf = step(0.06, fract(p.y / 0.36));
        vec2 id = vec2(floor(p.x / 0.055), floor(p.y / 0.36));
        vec3 book = 0.30 + 0.45 * cos(6.2831853 * (hash(id) + vec3(0.0, 0.33, 0.67)));
        base = mix(vCol, mix(vCol * 0.6, book, step(fract(p.y / 0.36), 0.80 + 0.14 * hash(id + 7.0))), shelf * fk);
      }
      vec3 light;
      if (room < -0.5) {
        vec3 up = normalize(vec3(-vWorld.xy, 1e-3)), ld = sunDirAt(vWorld);
        light = ambCol * (0.76 + 0.24 * dot(N, up)) + sunCol * max(dot(N, ld), 0.0) * shadowAt(vWorld, N, 0.4);
        // 屋上とテラスの明かり
        float nearLamp = min(1.0, step(10.6, vLocal.y) + step(15.9, vLocal.x) * step(vLocal.y, 1.3));
        light += lampC.y * nearLamp * vec3(1.0, 0.82, 0.58) * 0.45 * (0.3 + 0.7 * night);
      } else {
        light = (ambCol * 0.60 + sunCol * 0.20) * (0.85 + 0.15 * NL.y) + lamp * vec3(1.0, 0.88, 0.70) * (0.80 + 0.12 * NL.y);
      }
      vec3 col = base * light;
      if (pat == 3) col = base * light * 0.5 + lamp * vec3(1.0, 0.93, 0.78) * 1.5;
      else if (pat == 4) col = base * light * 0.6 + base * vParm.w * (0.4 + 0.8 * night);
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`;
  // ガラス（窓・手すり）と水面（プール）
  const GFS = GL.FS_HEAD + GL.COMMON + `
    uniform vec4 lampC;
    varying vec3 vWorld, vLocal, vN, vNL, vCol;
    varying vec4 vParm;
    void main() {
      #include <logdepthbuf_fragment>
      vec3 N = normalize(vN), Vv = normalize(cameraPosition - vWorld);
      float fres = 0.05 + 0.95 * pow(1.0 - abs(dot(N, Vv)), 4.0);
      vec3 sky = ambCol * 1.25 + sunCol * 0.35;
      #ifdef USE_FOG
        sky = fogColor;
      #endif
      vec3 col; float a;
      if (vParm.x > 0.5) {
        float w = 0.9 + 0.1 * sin(vLocal.x * 2.3 + time * 1.3) * sin(vLocal.z * 1.9 - time * 1.1);
        col = mix(vec3(0.10, 0.55, 0.72) * w * (ambCol * 0.9 + sunCol * 0.7 + lampC.y * vec3(0.3, 0.7, 0.8) * (0.4 + 0.6 * night)), sky, fres * 0.6);
        a = 0.62 + 0.30 * fres;
      } else {
        col = mix(vCol * 0.25 * (ambCol + sunCol * 0.3), sky, fres);
        a = 0.10 + 0.55 * fres;
      }
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
    }`;

  // ================= 建てる =================
  function build() {
    if (built) return;
    built = true;
    const bag = new Kit.Bag(), glass = new Kit.Bag();
    const WALL = [0.95, 0.94, 0.91], INNER = [0.93, 0.91, 0.87], FRAME = [0.16, 0.17, 0.19], STONE = [0.62, 0.61, 0.58], WOOD = [0.48, 0.33, 0.22];
    const CEIL = [0.95, 0.95, 0.94], GTINT = [0.55, 0.75, 0.85];
    let seed = 0;
    const m16 = function (x0, x1, y0, y1, z0, z1) { return [x1 - x0, 0, 0, 0, 0, y1 - y0, 0, 0, 0, 0, z1 - z0, 0, (x0 + x1) / 2, y0, (z0 + z1) / 2, 1]; };
    // 箱を置く。pat: 模様, room: 明かりの部屋を直接指定するとき, glow: 光る強さ
    const B = function (x0, x1, y0, y1, z0, z1, col, pat, room, glow) {
      bag.addM('box', m16(x0, x1, y0, y1, z0, z1), col, pat || 0, (seed++) % 97, room === undefined ? 0 : room + 1, glow || 0);
    };
    const C = function (kind, x, y, z, d, h, col, pat, room, glow) {       // 円柱・半球（dome は h が高さ）
      bag.addM(kind, [d, 0, 0, 0, 0, kind === 'dome' ? h * 2 : h, 0, 0, 0, 0, d, 0, x, y, z, 1], col, pat || 0, (seed++) % 97, room === undefined ? 0 : room + 1, glow || 0);
    };
    const G = function (x0, x1, y0, y1, z0, z1, water) { glass.addM('box', m16(x0, x1, y0, y1, z0, z1), GTINT, water ? 1 : 0, 0, 0, 0); };
    // 当たり判定（箱）
    const S = function (x0, x1, y0, y1, z0, z1) { Kit.addSolid(0, U0 + x0, U0 + x1, Z0 + z0, Z0 + z1, Y0 + y0, Y0 + y1); };
    const BS = function (x0, x1, y0, y1, z0, z1, col, pat, room, glow) { B(x0, x1, y0, y1, z0, z1, col, pat, room, glow); S(x0, x1, y0, y1, z0, z1); };

    // 壁。axis 'x': x 方向に a0〜a1 へ延び、厚みは z の c0〜c1。axis 'z' はその逆。
    // ops: 開口 { a0, a1, sill: 下端, head: 上端（どちらも壁の下からの高さ）, door: 通れるか }
    const wall = function (axis, c0, c1, a0, a1, yb, yt, ops, col) {
      const put = function (p0, p1, y0, y1, c, d0, d1) {
        if (p1 - p0 < 1e-3 || y1 - y0 < 1e-3) return;
        const e0 = d0 === undefined ? c0 : d0, e1 = d1 === undefined ? c1 : d1;
        if (axis === 'x') B(p0, p1, y0, y1, e0, e1, c); else B(e0, e1, y0, y1, p0, p1, c);
      };
      const sol = function (p0, p1, y0, y1) {
        if (p1 - p0 < 1e-3 || y1 - y0 < 1e-3) return;
        if (axis === 'x') S(p0, p1, y0, y1, c0, c1); else S(c0, c1, y0, y1, p0, p1);
      };
      let cur = a0;
      (ops || []).slice().sort(function (p, q) { return p.a0 - q.a0; }).forEach(function (op) {
        put(cur, op.a0, yb, yt, col); sol(cur, op.a0, yb, yt);
        const lo = yb + (op.sill || 0), hi = yb + op.head;
        put(op.a0, op.a1, yb, lo, col);
        put(op.a0, op.a1, hi, yt, col);
        if (op.door) sol(op.a0, op.a1, hi, yt);
        else {
          sol(op.a0, op.a1, yb, yt);
          const cm = (c0 + c1) / 2;
          if (axis === 'x') G(op.a0, op.a1, lo, hi, cm - 0.02, cm + 0.02); else G(cm - 0.02, cm + 0.02, lo, hi, op.a0, op.a1);
        }
        // 枠と方立て（壁より少し出す）
        const f0 = c0 - 0.025, f1 = c1 + 0.025, t = 0.07;
        put(op.a0, op.a0 + t, lo, hi, FRAME, f0, f1);
        put(op.a1 - t, op.a1, lo, hi, FRAME, f0, f1);
        put(op.a0 + t, op.a1 - t, hi - t, hi, FRAME, f0, f1);
        if (!op.door) {
          put(op.a0 + t, op.a1 - t, lo, lo + t, FRAME, f0, f1);
          const n = Math.ceil((op.a1 - op.a0) / 2.6);
          for (let k = 1; k < n; k++) { const m = op.a0 + (op.a1 - op.a0) * k / n; put(m - t / 2, m + t / 2, lo + t, hi - t, FRAME, f0, f1); }
        }
        cur = op.a1;
      });
      put(cur, a1, yb, yt, col); sol(cur, a1, yb, yt);
    };
    const W = function (a0, a1, sill, head) { return { a0: a0, a1: a1, sill: sill, head: head }; };
    const D = function (a0, a1, head) { return { a0: a0, a1: a1, head: head, door: true }; };

    // ---- 土台とテラス、プール ----
    BS(-17, 16, -4, 0, -12, 12, STONE, 1);
    BS(16, 19, -4, 0, -10, 10, STONE, 1); BS(27, 31, -4, 0, -10, 10, STONE, 1);
    BS(19, 27, -4, 0, -10, -6, STONE, 1); BS(19, 27, -4, 0, 6, 10, STONE, 1);
    BS(19, 27, -4, -1.2, -6, 6, [0.55, 0.80, 0.88], 2);                      // プールの底
    BS(19, 20.3, -1.2, -0.6, -6, -3.4, [0.55, 0.80, 0.88], 2);               // 上がるための段
    G(19, 27, -0.26, -0.2, -6, 6, true);                                     // 水面
    // テラスの手すり（ガラス）
    [[31, 31.08, -10, 10], [16, 31, -10.08, -10], [16, 31, 10, 10.08]].forEach(function (q) {
      G(q[0], q[1], 0, 1.1, q[2], q[3]); S(q[0], q[1], 0, 3.5, q[2], q[3]);   // 判定はジャンプで越えられない高さ
      B(q[0] - 0.02, q[1] + 0.02, 1.1, 1.15, q[2] - 0.02, q[3] + 0.02, FRAME);
    });
    for (let k = 0; k < 2; k++) {                                            // テラスの灯り
      const z = k ? 9.4 : -9.4;
      B(30.3, 30.5, 0, 1.5, z - 0.1, z + 0.1, FRAME);
      B(30.2, 30.6, 1.5, 1.9, z - 0.2, z + 0.2, [1, 0.9, 0.7], 3, 9);
    }
    for (let k = 0; k < 3; k++) {                                            // 寝いす
      const z = -4 + k * 4;
      B(28, 30, 0.25, 0.4, z - 0.4, z + 0.4, [0.92, 0.90, 0.84]); B(29.5, 30.1, 0.4, 0.9, z - 0.4, z + 0.4, [0.92, 0.90, 0.84]);
      B(28.1, 28.2, 0, 0.25, z - 0.35, z + 0.35, FRAME); B(29.8, 29.9, 0, 0.25, z - 0.35, z + 0.35, FRAME);
    }
    // 玄関前: ポーチと階段、ひさし
    BS(-3, 3, -4, 0, -14, -12, STONE, 1);
    for (let k = 1; k <= 9; k++) BS(-3, 3, -4, -0.17 * k, -14 - 0.32 * k, -14 - 0.32 * (k - 1), STONE, 1);
    BS(-2.8, 2.8, 2.95, 3.12, -13.8, -11, FRAME);
    B(-2.6, -2.4, 0, 2.95, -13.6, -13.4, FRAME); B(2.4, 2.6, 0, 2.95, -13.6, -13.4, FRAME);
    B(-2.2, 2.2, 2.9, 2.95, -13.5, -11.2, [1, 0.92, 0.75], 3, 0);
    // 開いたままの玄関ドア
    B(1.3, 1.36, 0, 2.5, -10.7, -9.5, WOOD);

    // ---- 外壁（3階ぶん） ----
    const south = [[W(-14.5, -2.6, 0.3, 2.9), D(-1.3, 1.3, 2.5), W(2.6, 14.5, 0.3, 2.9)],
                   [W(-14.5, -6.5, 0.9, 2.8), W(-4, 4, 0.9, 2.8), W(6.5, 14.5, 0.9, 2.8)],
                   [W(-14.5, -1.5, 0.3, 2.9), W(1.5, 14.5, 0.3, 2.9)]];
    const east = [[W(-9.5, -3.2, 0.3, 2.9), D(-2.2, 0.2, 2.5), W(1.2, 6, 0.3, 2.9)],
                  [W(-9.5, 5.8, 0.9, 2.8)],
                  [W(-9.5, 6, 0.2, 2.9), W(7.2, 10.2, 0.9, 2.8)]];
    const west = [[W(-9.5, -4.5, 0.9, 2.8)], [W(-8, 4, 0.9, 2.8)], [W(-8, -4.5, 0.9, 2.8), W(1, 5, 0.9, 2.8)]];
    const north = [[W(3, 14, 1.0, 2.8)], [W(-14, -8, 1.0, 2.8), W(7, 14, 1.0, 2.8)], [W(-14, -0.5, 1.0, 2.8)]];
    for (let f = 0; f < 3; f++) {
      const yb = f * FH, yt = yb + FH;
      wall('x', -11, -10.7, -16, 16, yb, yt, south[f], WALL);
      wall('x', 10.7, 11, -16, 16, yb, yt, north[f], WALL);
      wall('z', 15.7, 16, -10.7, 10.7, yb, yt, east[f], WALL);
      wall('z', -16, -15.7, -10.7, 10.7, yb, yt, west[f], WALL);
      // 階の境目の帯
      if (f > 0) {
        B(-16.06, 16.06, yb - 0.3, yb, -11.06, -11, FRAME); B(-16.06, 16.06, yb - 0.3, yb, 11, 11.06, FRAME);
        B(16, 16.06, yb - 0.3, yb, -11, 11, FRAME); B(-16.06, -16, yb - 0.3, yb, -11, 11, FRAME);
      }
    }
    // ---- 床（2階・3階・屋上）。階段の上は吹き抜け ----
    for (let lv = 1; lv <= 3; lv++) {
      const yt = lv * FH, yb = yt - SLAB, hx0 = STAIR_X[lv - 1] - 0.3, hx1 = STAIR_X[lv - 1] + STEPS * TREAD;
      BS(-15.7, 15.7, yb, yt, -10.7, BAND, CEIL, 1);
      BS(-15.7, hx0, yb, yt, BAND, 10.7, CEIL, 1);
      BS(hx1, 15.7, yb, yt, BAND, 10.7, CEIL, 1);
      if (lv < 3) {
        // 吹き抜けの手すり
        G(hx0, hx1, yt, yt + 1.1, BAND - 0.08, BAND - 0.02); S(hx0 - 0.1, hx1, yt, yt + 1.1, BAND - 0.1, BAND);
        B(hx0 - 0.1, hx1, yt + 1.1, yt + 1.15, BAND - 0.1, BAND, FRAME);
        G(hx0 - 0.08, hx0 - 0.02, yt, yt + 1.1, BAND, 10.7); S(hx0 - 0.1, hx0, yt, yt + 1.1, BAND, 10.7);
        B(hx0 - 0.1, hx0, yt + 1.1, yt + 1.15, BAND, 10.7, FRAME);
      }
    }
    // ---- 階段 3本（北の壁ぞいに、1階→2階→3階→屋上と順に東へずれていく） ----
    for (let s = 0; s < 3; s++) for (let k = 1; k <= STEPS; k++) {
      const x0 = STAIR_X[s] + (k - 1) * TREAD;
      BS(x0, x0 + TREAD, s * FH, s * FH + k * RISE, BAND, 10.7, k % 2 ? WOOD : [0.52, 0.36, 0.24]);
    }
    // ---- 屋上: 立ち上がりの壁と、階段の出口の小屋 ----
    const RY = 3 * FH;
    wall('x', -11, -10.7, -16, 16, RY, RY + 1.1, null, WALL);
    wall('z', 15.7, 16, -10.7, 10.7, RY, RY + 1.1, null, WALL);
    wall('z', -16, -15.7, -10.7, 10.7, RY, RY + 1.1, null, WALL);
    wall('x', 10.7, 11, -16, 7.4, RY, RY + 1.1, null, WALL);
    wall('x', 10.7, 11, 13.34, 16, RY, RY + 1.1, null, WALL);
    // 屋上の縁の柵は、ジャンプでも越えられないよう高く判定する（外壁の判定は 1.1m までなので、その上に重ねる）
    S(-16, 16, RY + 1.1, RY + 3.5, -11, -10.7); S(-16, 16, RY + 1.1, RY + 3.5, 10.7, 11);
    S(15.7, 16, RY + 1.1, RY + 3.5, -11, 11); S(-16, -15.7, RY + 1.1, RY + 3.5, -11, 11);
    wall('x', 10.7, 11, 7.4, 13.34, RY, RY + 2.6, null, WALL);
    wall('x', BAND - 0.2, BAND, 7.4, 13.04, RY, RY + 2.6, [W(8.6, 11.8, 1.0, 2.2)], WALL);
    wall('z', 7.4, 7.6, BAND, 10.7, RY, RY + 2.6, null, WALL);
    BS(7.2, 13.7, RY + 2.6, RY + 2.8, BAND - 0.4, 11.2, FRAME);
    B(13.1, 13.5, RY + 2.5, RY + 2.6, 9.3, 10.0, [1, 0.92, 0.75], 3, 9);
    // 屋上の灯り・寝いす・ジャグジー・テーブル
    [[-15.85, -10.85], [0, -10.85], [15.85, -10.85], [-15.85, 10.85], [15.85, 10.85], [-15.85, 0], [15.85, 0]].forEach(function (q) {
      B(q[0] - 0.14, q[0] + 0.14, RY + 1.1, RY + 1.5, q[1] - 0.14, q[1] + 0.14, [1, 0.9, 0.7], 3, 9);
    });
    for (let k = 0; k < 4; k++) {
      const x = 5 + k * 2.4;
      BS(x - 0.4, x + 0.4, RY, RY + 0.4, -9.6, -7.6, [0.92, 0.90, 0.84]); B(x - 0.4, x + 0.4, RY + 0.4, RY + 0.9, -8.0, -7.5, [0.92, 0.90, 0.84]);
    }
    C('cyl', -10, RY, -5, 4.2, 0.8, [0.90, 0.90, 0.88]); S(-12.1, -7.9, RY, RY + 0.8, -7.1, -2.9);
    C('cyl', -10, RY + 0.72, -5, 3.6, 0.1, [0.25, 0.70, 0.85], 4, 9, 0.5);
    C('cyl', -4, RY, 2, 1.6, 0.72, [0.30, 0.22, 0.16]); S(-4.8, -3.2, RY, RY + 0.72, 1.2, 2.8);
    C('cyl', -4, RY + 0.72, 2, 0.08, 1.9, FRAME); C('cone', -4, RY + 2.3, 2, 3.6, 0.7, [0.90, 0.30, 0.25]);
    [[-5.4, 2], [-2.6, 2], [-4, 0.6], [-4, 3.4]].forEach(function (q) { B(q[0] - 0.25, q[0] + 0.25, RY, RY + 0.45, q[1] - 0.25, q[1] + 0.25, [0.92, 0.90, 0.84]); });
    // 望遠鏡（ガラスの端の宇宙を眺める）
    C('cyl', 2, RY, 8, 0.12, 1.3, FRAME); B(1.85, 2.15, RY + 1.3, RY + 1.6, 7.4, 8.6, [0.85, 0.86, 0.88]);

    // ---- 間仕切り ----
    wall('z', 3.0, 3.2, -10.7, CORR, 0, 3.3, [D(-3, 0, 2.6)], INNER);
    wall('x', CORR - 0.1, CORR + 0.1, -15.7, 15.7, FH, FH + 3.3, [D(-11.8, -10, 2.3), D(-0.9, 0.9, 2.3), D(9.7, 11.5, 2.3)], INNER);
    wall('z', -5.3, -5.1, -10.7, CORR - 0.1, FH, FH + 3.3, null, INNER);
    wall('z', 5.1, 5.3, -10.7, CORR - 0.1, FH, FH + 3.3, null, INNER);
    wall('x', CORR - 0.1, CORR + 0.1, -15.7, 15.7, 2 * FH, 2 * FH + 3.3, [D(-9.3, -7.5, 2.3), D(9.7, 11.5, 2.3)], INNER);
    wall('z', -0.1, 0.1, -10.7, CORR - 0.1, 2 * FH, 2 * FH + 3.3, null, INNER);

    // ---- 天井の照明 ----
    const lampAt = function (f, x, z) { B(x - 0.5, x + 0.5, f * FH + 3.3 - 0.07, f * FH + 3.3, z - 0.5, z + 0.5, [1, 0.95, 0.85], 3); };
    [[0, -10, -5], [0, -10, 2], [0, -3, -5], [0, -3, 2], [0, -12, 8.2], [0, 9, 8.2], [0, 9, -6], [0, 9, 1],
     [1, -10, 7.5], [1, -1, 7.5], [1, 10, 7.5], [1, -10.5, -2], [1, 0, -2], [1, 10.5, -2],
     [2, -10, 7.5], [2, -1, 7.5], [2, 10, 7.5], [2, -8, -5], [2, -8, 2], [2, 8, -5], [2, 8, 2]].forEach(function (q) { lampAt(q[0], q[1], q[2]); });

    // ---- 明かりのスイッチ（壁の小さな板） ----
    const sw = function (room, x, y, z) {
      B(x - 0.07, x + 0.07, y - 0.1, y + 0.1, z - 0.07, z + 0.07, [0.96, 0.96, 0.94]);
      switches.push({ room: room, p: [x, y, z] });
    };
    sw(0, 1.7, 1.25, -10.68); sw(1, 3.22, 1.25, -3.5);
    sw(2, -2.5, FH + 1.25, CORR + 0.12); sw(3, -9.8, FH + 1.25, CORR - 0.12); sw(4, 1.1, FH + 1.25, CORR - 0.12); sw(5, 11.7, FH + 1.25, CORR - 0.12);
    sw(6, 3, 2 * FH + 1.25, CORR + 0.12); sw(7, -7.3, 2 * FH + 1.25, CORR - 0.12); sw(8, 11.7, 2 * FH + 1.25, CORR - 0.12);
    sw(9, 13.1, RY + 1.25, BAND - 0.22); sw(9, 15.68, 1.25, 0.6);

    // ---- 家具 ----
    const SOFA = [0.80, 0.78, 0.72], DARKW = [0.30, 0.22, 0.16], WHITE = [0.95, 0.95, 0.94];
    const bed = function (x0, y, z0, col) {          // 頭を -x の壁に向けたベッド（幅 2.2 × 長さ 2.3）
      BS(x0, x0 + 2.4, y, y + 0.32, z0, z0 + 2.2, DARKW);
      B(x0 + 0.08, x0 + 2.36, y + 0.32, y + 0.58, z0 + 0.06, z0 + 2.14, WHITE);
      B(x0 + 0.85, x0 + 2.38, y + 0.58, y + 0.66, z0 + 0.04, z0 + 2.16, col);
      B(x0 + 0.15, x0 + 0.7, y + 0.58, y + 0.72, z0 + 0.2, z0 + 1.0, WHITE); B(x0 + 0.15, x0 + 0.7, y + 0.58, y + 0.72, z0 + 1.2, z0 + 2.0, WHITE);
      B(x0 - 0.12, x0, y, y + 1.2, z0 - 0.1, z0 + 2.3, DARKW);
      B(x0 - 0.05, x0 + 0.45, y, y + 0.5, z0 - 0.7, z0 - 0.2, DARKW); B(x0 - 0.05, x0 + 0.45, y, y + 0.5, z0 + 2.4, z0 + 2.9, DARKW);
      beds.push({ p: [x0 + 1.2, y + 0.6, z0 + 1.1] });
    };
    // 1階 居間: ソファとテレビ
    BS(-11.4, -9.4, 0, 0.45, -2.4, 2.4, SOFA); B(-9.9, -9.4, 0.45, 0.95, -2.4, 2.4, SOFA);
    B(-11.4, -9.9, 0.45, 0.7, -2.4, -1.9, SOFA); B(-11.4, -9.9, 0.45, 0.7, 1.9, 2.4, SOFA);
    BS(-13.6, -12.6, 0, 0.4, -0.9, 0.9, DARKW);
    B(-14.6, -8.6, 0, 0.02, -3.4, 3.4, [0.55, 0.30, 0.28]);                                       // 敷物
    B(-15.68, -15.6, 1.0, 2.3, -1.3, 1.3, [0.05, 0.06, 0.08]); B(-15.6, -15.58, 1.05, 2.25, -1.25, 1.25, [0.25, 0.45, 0.70], 4, undefined, 0.35);
    BS(-15.68, -15.2, 0, 0.5, -1.8, 1.8, DARKW);
    C('cyl', -14.6, 0, 9.6, 0.7, 0.6, [0.80, 0.78, 0.74]); C('dome', -14.6, 0.6, 9.6, 1.5, 1.0, [0.22, 0.50, 0.24]);     // 鉢植え
    C('cyl', 2.2, 0, -9.8, 0.7, 0.6, [0.80, 0.78, 0.74]); C('dome', 2.2, 0.6, -9.8, 1.4, 0.9, [0.22, 0.50, 0.24]);
    // 1階 台所・食堂
    BS(4.6, 5.6, 0, 0.92, -9, -4, WHITE); B(4.55, 5.65, 0.92, 0.96, -9.05, -3.95, [0.20, 0.20, 0.22]);
    BS(14.9, 15.68, 0, 0.92, 2, 6.3, WHITE); B(14.85, 15.68, 0.92, 0.96, 2, 6.3, [0.20, 0.20, 0.22]);
    BS(3.3, 4.2, 0, 2.0, 4.2, 5.3, [0.80, 0.82, 0.84]);                                           // 冷蔵庫
    BS(9, 12, 0.7, 0.78, -1.1, 1.1, DARKW); B(9.2, 9.35, 0, 0.7, -0.9, -0.75, DARKW); B(11.65, 11.8, 0, 0.7, -0.9, -0.75, DARKW);
    B(9.2, 9.35, 0, 0.7, 0.75, 0.9, DARKW); B(11.65, 11.8, 0, 0.7, 0.75, 0.9, DARKW);
    for (let k = 0; k < 3; k++) for (let sd = -1; sd <= 1; sd += 2) {
      const x = 9.5 + k, z = sd * 1.6;
      B(x - 0.22, x + 0.22, 0, 0.45, z - 0.22, z + 0.22, SOFA); B(x - 0.22, x + 0.22, 0.45, 0.95, z + sd * 0.16, z + sd * 0.22, SOFA);
    }
    // 2階 客用寝室・書斎・浴室
    bed(-15.5, FH, -3, [0.45, 0.55, 0.70]);
    BS(-7.4, -5.4, FH, FH + 2.3, -10.6, -9.9, DARKW);                                             // 洋服だんす
    BS(-2, 2, FH + 0.7, FH + 0.76, -9.6, -8.6, DARKW); B(-1.9, -1.8, FH, FH + 0.7, -9.5, -8.7, DARKW); B(1.8, 1.9, FH, FH + 0.7, -9.5, -8.7, DARKW);
    B(-0.25, 0.25, FH, FH + 0.45, -8.2, -7.7, [0.20, 0.20, 0.22]); B(-0.25, 0.25, FH + 0.45, FH + 1.0, -7.76, -7.7, [0.20, 0.20, 0.22]);
    B(-0.5, 0.5, FH + 0.76, FH + 1.3, -9.5, -9.45, [0.05, 0.06, 0.08]);
    BS(-5.08, -4.7, FH, FH + 2.5, -6, 5.5, [0.36, 0.26, 0.18], 5); BS(4.7, 5.08, FH, FH + 2.5, -6, 5.5, [0.36, 0.26, 0.18], 5);     // 本棚
    BS(12.6, 14.6, FH, FH + 0.62, -9.9, -8.9, WHITE); B(12.75, 14.45, FH + 0.56, FH + 0.6, -9.75, -9.05, [0.35, 0.72, 0.85], 4, undefined, 0.15);   // 浴槽
    BS(6, 8.6, FH, FH + 0.88, -10.6, -10.0, WHITE); B(6.4, 8.2, FH + 1.1, FH + 2.2, -10.68, -10.64, [0.70, 0.80, 0.86], 4, undefined, 0.1);
    // 3階 主寝室とラウンジ
    bed(-15.5, 2 * FH, -3.2, [0.62, 0.30, 0.30]);
    B(-12.5, -6.5, 2 * FH, 2 * FH + 0.02, -5.2, 1.4, [0.82, 0.78, 0.68]);
    BS(-3.2, -0.3, 2 * FH, 2 * FH + 2.3, -10.6, -9.9, DARKW);
    BS(-3, -1, 2 * FH, 2 * FH + 0.45, 1, 3, SOFA); B(-1.5, -1, 2 * FH + 0.45, 2 * FH + 0.95, 1, 3, SOFA);
    BS(9.5, 11.5, 2 * FH, 2 * FH + 0.45, -3, 2, SOFA); B(9.5, 10, 2 * FH + 0.45, 2 * FH + 0.95, -3, 2, SOFA);
    BS(12.2, 13.2, 2 * FH, 2 * FH + 0.4, -1.3, 0.3, DARKW);
    BS(2, 6, 2 * FH, 2 * FH + 1.05, -9.2, -8.5, DARKW); B(1.9, 6.1, 2 * FH + 1.05, 2 * FH + 1.1, -9.3, -8.4, [0.20, 0.20, 0.22]);   // バーカウンター
    BS(2, 6, 2 * FH, 2 * FH + 2.2, -10.68, -10.3, [0.36, 0.26, 0.18], 5);
    for (let k = 0; k < 3; k++) C('cyl', 2.8 + k * 1.2, 2 * FH, -7.7, 0.4, 0.7, [0.20, 0.20, 0.22]);
    C('cyl', 14.6, 2 * FH, 5.4, 0.7, 0.6, [0.80, 0.78, 0.74]); C('dome', 14.6, 2 * FH + 0.6, 5.4, 1.5, 1.0, [0.22, 0.50, 0.24]);

    // ---- まとめて描く ----
    const mat = GL.material(VS, FS, null, {}), gmat = GL.material(VS, GFS, null, { transparent: true, depthWrite: false, side: THREE.DoubleSide });
    for (const k in lampU) { mat.uniforms[k] = lampU[k]; gmat.uniforms[k] = lampU[k]; }
    const grp = new THREE.Group();
    grp.matrixAutoUpdate = false;
    grp.matrix.set(E[0], UP[0], 0, O[0], E[1], UP[1], 0, O[1], E[2], UP[2], 1, O[2], 0, 0, 0, 1);
    bag.build(grp, true, { box: mat, cyl: mat, dome: mat, cone: mat });
    const n0 = grp.children.length;
    glass.build(grp, false, { box: gmat });
    for (let k = n0; k < grp.children.length; k++) grp.children[k].renderOrder = 3;
    sceneRef.add(grp);
    grp.updateMatrixWorld(true);
    syncLamps();
  }

  // ================= 売地の看板 =================
  function buildSign() {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    const c = cv.getContext('2d');
    c.fillStyle = '#f7f5ee'; c.fillRect(0, 0, 1024, 512);
    c.fillStyle = '#c62828'; c.fillRect(0, 0, 1024, 150);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff'; c.font = 'bold 118px sans-serif'; c.fillText('売　地', 512, 78);
    c.fillStyle = '#222'; c.font = 'bold 54px sans-serif'; c.fillText('豪邸 建設用地（3階建て・屋上つき）', 512, 215);
    c.fillStyle = '#c62828'; c.font = 'bold 100px sans-serif'; c.fillText(COL.fmtCr(ECON.PRICE), 512, 330);
    c.fillStyle = '#333'; c.font = '40px sans-serif'; c.fillText('海と宇宙が見える角地 ／ E キーで購入', 512, 440);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 8;
    const su = -1358, sz = 29892, th = COL.landTheta(0, su), f = COL.frameAt(th), g = COL.groundH(th, sz), p = COL.toWorld(th, sz, g);
    const k = Math.SQRT1_2, X = [(0 - f.east[0]) * k, (0 - f.east[1]) * k, k], Yv = f.up, Zv = V.cross(X, Yv);
    signGrp = new THREE.Group();
    signGrp.matrixAutoUpdate = false;
    signGrp.matrix.set(X[0], Yv[0], Zv[0], p[0], X[1], Yv[1], Zv[1], p[1], X[2], Yv[2], Zv[2], p[2], 0, 0, 0, 1);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.6), new THREE.MeshBasicMaterial({ map: tex }));
    board.position.set(0, 3.9, 0.09);
    const dark = COL.objectMaterial(0x3a3d42);
    const back = new THREE.Mesh(new THREE.BoxGeometry(7.5, 3.9, 0.16), dark);
    back.position.set(0, 3.9, 0);
    signGrp.add(board); signGrp.add(back);
    for (let s = -1; s <= 1; s += 2) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 6.4, 0.25), dark);
      post.position.set(s * 3.2, 2.2, -0.2);
      signGrp.add(post);
    }
    sceneRef.add(signGrp);
    signGrp.updateMatrixWorld(true);
    signGrp.userData.pos = COL.toWorld(th, sz, g + 1.5);
  }

  // 世界の位置 → 建物の座標
  function toLocal(w) {
    const d = V.sub(w, O);
    return [V.dot(d, E), V.dot(d, UP), d[2]];
  }

  COL.buildMansion = function (scene) {
    Kit = COL.CityKit; sceneRef = scene;
    TH0 = COL.landTheta(0, U0);
    // 床の高さ: 敷地でいちばん高い地面より少し上
    let mx = -1e9;
    for (let x = -17; x <= 31; x += 2) for (let z = -12; z <= 12; z += 2) mx = Math.max(mx, COL.groundH(COL.landTheta(0, U0 + x), Z0 + z));
    Y0 = mx + 0.3;
    const f = COL.frameAt(TH0);
    E = f.east; UP = f.up; O = COL.toWorld(TH0, Z0, Y0);
    syncLamps();
    if (COL.save.owned) build(); else buildSign();
  };

  // セーブデータを選んだあと: そのデータの状態（建っているか・明かり）に合わせる
  //  （起動時は売地の看板で作っておく。一度建てた家は、そのページでは消さない）
  COL.syncMansion = function () {
    if (COL.save.owned && !built) { if (signGrp) { sceneRef.remove(signGrp); signGrp = null; } build(); }
    syncLamps();
  };

  // H キー: 自宅（買う前は売地の看板の前）へ移動
  COL.goHome = function (p) {
    let u, z, fw;
    if (COL.save.owned) { u = U0; z = Z0 - 34; fw = [0, 0, 1]; }
    else { u = -1358 - 9; z = 29892 - 9; const f = COL.frameAt(COL.landTheta(0, u)); fw = V.norm([f.east[0], f.east[1], 1]); }
    const th = COL.landTheta(0, u), np = COL.createPlayer(th, z, COL.groundH(th, z) + 0.1);
    p.pos = np.pos; p.vel = [0, 0, 0]; p.up = np.up; p.fwd = fw; p.pitch = COL.save.owned ? 0.12 : 0.1; p.fly = false;
    COL.stepPlayer(p, {}, 0);
  };

  function buy() {
    COL.save.money -= ECON.PRICE; COL.save.owned = true;
    COL.save.lamps[0] = 1;
    COL.storeSave();
    if (signGrp) { sceneRef.remove(signGrp); signGrp = null; }
    build();
    COL.toast('豪邸が建ちました！\n玄関は道路の側です。明かりのスイッチとベッドは E キーで使えます\n（H キーでいつでも自宅へ戻れます）', 9);
  }

  // 眠る: 暗くなる → 時刻を進める（0時をまたげば日付も進む） → 明るくなる
  //  wake: 7 = 次の朝、18 = 夜のはじまり（日の入り）
  function sleep(wake) {
    COL.fadeThen(function () {
      COL.setClock(wake);
      COL.toast(wake === 7 ? 'おはようございます\n' + COL.save.day + ' 日目の朝 7:00'
                           : 'よく眠れました\n' + COL.save.day + ' 日目の夕方 18:00　これから夜です', 5);
    }, 700);
  }

  // 毎フレーム。use: E キー, alt: Q キー。戻り値 { text: 案内の文, used: E を使ったか }
  COL.updateMansion = function (dt, p, use, alt) {
    if (COL.isFading()) return { text: '', used: false };
    if (COL.pilot || COL.ride || COL.driving || COL.onTrain) return { text: '', used: false };
    if (!COL.save.owned) {
      if (!signGrp || V.len(V.sub(p.pos, signGrp.userData.pos)) > 20) return { text: '', used: false };
      const lack = ECON.PRICE - COL.save.money;
      if (lack > 0) return { text: '売地: 豪邸の建設用地 ' + COL.fmtCr(ECON.PRICE) + '　（あと ' + COL.fmtCr(lack) + ' 足りません。宇宙港の採掘船で稼げます）', used: false };
      if (use) { buy(); return { text: '', used: true }; }
      return { text: 'E: この土地に豪邸を建てる（' + COL.fmtCr(ECON.PRICE) + '）', used: false };
    }
    const e = toLocal(COL.eyePos(p));
    if (Math.abs(e[0]) > 40 || Math.abs(e[2]) > 30 || e[1] < -3 || e[1] > 18) return { text: '', used: false };
    // 明かりのスイッチ
    let best = null, bd = 1.9;
    for (let k = 0; k < switches.length; k++) {
      const s = switches[k], d = Math.hypot(e[0] - s.p[0], e[1] - s.p[1], e[2] - s.p[2]);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) {
      const on = COL.save.lamps[best.room];
      if (use) { COL.save.lamps[best.room] = on ? 0 : 1; syncLamps(); COL.storeSave(); return { text: '', used: true }; }
      return { text: 'E: ' + ROOMS[best.room] + 'の明かりを' + (on ? '消す' : 'つける'), used: false };
    }
    // ベッド
    for (let k = 0; k < beds.length; k++) {
      const b = beds[k];
      if (Math.hypot(e[0] - b.p[0], e[2] - b.p[2]) > 2.4 || Math.abs(e[1] - 1.7 - (b.p[1] - 0.6)) > 1.2) continue;
      if (use) { sleep(7); return { text: '', used: true }; }
      if (alt) { sleep(18); return { text: '', used: true }; }
      return { text: 'ベッド　E: 朝 7:00 まで眠る　／　Q: 夜のはじまり（18:00）まで眠る', used: false };
    }
    return { text: '', used: false };
  };
})();
