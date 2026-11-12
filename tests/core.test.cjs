// core.js の計算を Node で確かめる:  node tests/core.test.cjs
const path = require('path');
require(path.join(__dirname, '..', 'js', 'core.js'));
require(path.join(__dirname, '..', 'js', 'terrain.js'));
require(path.join(__dirname, '..', 'js', 'rail.js'));
const COL = globalThis.COL, V = COL.V;
let fail = 0;
function ok(name, cond, info) {
  if (!cond) fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}
const DT = 1 / 60;
// 地面からの高さ
function above(p) { const c = COL.toCyl(p.pos); return c.h - COL.groundH(c.theta, c.z); }
function run(p, input, seconds) {
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) COL.stepPlayer(p, input, DT);
}

ok('自転周期は約114秒', Math.abs(COL.PERIOD - 114.4) < 0.5, COL.PERIOD.toFixed(1));
ok('真下は陸地A', COL.stripAt(-Math.PI / 2).name === '陸地A');
ok('帯は 陸地→窓 の順に6枚', [0, 1, 2, 3, 4, 5].map(i => COL.stripAt(COL.THETA0 + COL.STRIP * (i + 0.5)).name).join() === '陸地A,窓A,陸地B,窓B,陸地C,窓C');

// 落下して着地する
let p = COL.createPlayer(-Math.PI / 2, 15000, 10);
run(p, {}, 3);
ok('落ちて地表に立つ', p.grounded && Math.abs(above(p)) < 1e-3, above(p));

// 軸方向に歩く: θ は変わらず z だけ進む
p = COL.createPlayer(-Math.PI / 2, 15000, 20);
run(p, {}, 3);
run(p, { f: 1 }, 100);
let c = COL.toCyl(p.pos);
ok('前進100秒で約500m進む', Math.abs(c.z - 15500) < 5, c.z.toFixed(1));
ok('前進中 θ は変わらない', Math.abs(c.theta + Math.PI / 2) < 1e-9);

// 周方向へ一周して元の場所に戻る（円筒の計算だけを確かめるので、地形は一時的に平らにする）
const savedTerrain = [COL.groundH, COL.waterAt];
COL.groundH = null; COL.waterAt = null;
p = COL.createPlayer(-Math.PI / 2, 15000, 0);
COL.stepPlayer(p, { yaw: Math.PI / 2 }, DT);           // 右を向く
const fwd0 = p.fwd.slice();
const lap = 2 * Math.PI * COL.R / COL.SPEED.run;         // 走って一周にかかる秒数
let maxH = 0, sum = 0, prev = COL.toCyl(p.pos).theta;
for (let i = 0, n = Math.round(lap / DT); i < n; i++) {
  COL.stepPlayer(p, { f: 1, run: true }, DT);
  const cc = COL.toCyl(p.pos);
  maxH = Math.max(maxH, Math.abs(cc.h));
  let d = cc.theta - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
  sum += d; prev = cc.theta;
}
c = COL.toCyl(p.pos);
ok('一周のあいだ地表から離れない', maxH < 1e-6, maxH);
ok('ちょうど一周する', Math.abs(Math.abs(sum) - 2 * Math.PI) < 0.01, (sum * 180 / Math.PI).toFixed(2) + '°');
ok('一周しても z はずれない', Math.abs(c.z - 15000) < 0.5, c.z);
ok('一周すると向きも元に戻る', V.len(V.sub(p.fwd, fwd0)) < 0.02);
ok('向きは常に地面と平行', Math.abs(V.dot(p.fwd, p.up)) < 1e-9);
COL.groundH = savedTerrain[0]; COL.waterAt = savedTerrain[1];

// ジャンプ
p = COL.createPlayer(0, 100, 0);
let top = 0;
COL.stepPlayer(p, { jump: true }, DT);
for (let i = 0; i < 120; i++) { COL.stepPlayer(p, {}, DT); top = Math.max(top, COL.toCyl(p.pos).h); }
ok('ジャンプの高さは約1.3m', top > 1.1 && top < 1.4, top.toFixed(2));
ok('ジャンプ後に着地', p.grounded);

// 飛行: 見上げて進むと軸へ近づき、重力が弱まる
p = COL.createPlayer(-Math.PI / 2, 15000, 0);
p.fly = true; p.pitch = Math.PI / 2 - 0.01;
run(p, { f: 1, run: true }, 6);
c = COL.toCyl(p.pos);
ok('飛行で上昇できる', c.h > 1500, c.h.toFixed(0));
ok('上空では重力が弱い', COL.gravityAt(c.r) < COL.G * 0.6, (COL.gravityAt(c.r) / COL.G).toFixed(2) + 'G');
run(p, { f: 1, run: true }, 20);
ok('反対側の地表で止まる', Math.hypot(p.pos[0], p.pos[1]) <= COL.R + 1e-6 && COL.stripAt(COL.toCyl(p.pos).theta).name === '窓B', COL.stripAt(COL.toCyl(p.pos).theta).name);
ok('数値が壊れていない', p.pos.concat(p.vel, p.up, p.fwd).every(Number.isFinite));

// 端の壁
p = COL.createPlayer(-Math.PI / 2, COL.CAP_DEPTH + 20, 1);
p.fwd = [0, 0, -1];
run(p, { f: 1, run: true }, 5);
ok('宇宙港側の山のすそで止まる', Math.abs(p.pos[2] - (COL.CAP_DEPTH + 1)) < 0.01, p.pos[2]);
p = COL.createPlayer(Math.PI / 2, COL.L - 20, 0);
run(p, { f: 1, run: true }, 5);
ok('ガラスの端で止まる', Math.abs(p.pos[2] - (COL.L - 1)) < 0.01, p.pos[2]);

// ---- 地形と水 ----
const HW = COL.LAND_HW, G = COL.GRID;
let minEdge = 0, maxAll = -1e9, minAll = 1e9, bad = 0;
for (let i = 0; i < 3; i++) {
  const gr = COL.landGrid(i);
  for (let k = 0; k < gr.H.length; k++) {
    const h = gr.H[k];
    if (!Number.isFinite(h)) bad++;
    maxAll = Math.max(maxAll, h); minAll = Math.min(minAll, h);
    // 水域の外で水位より低い地面があると、水の無い「くぼ地」になってしまう
    const ju = k % gr.W, jz = Math.floor(k / gr.W);
    if (gr.D[k] > 0 && ju > 12 && ju < G.NU - 12 && jz > 30 && h < COL.WATER[i].level) minEdge++;
  }
}
ok('地形の高さがすべて有限', bad === 0);
ok('最高峰は 350〜600 m', maxAll > 350 && maxAll < 600, maxAll.toFixed(0));
ok('一番深い所は海底（-30m 以下）', minAll < -30 && minAll > -40, minAll.toFixed(1));
ok('水域の外に水位より低い地面が無い', minEdge === 0, minEdge);
ok('陸地の縁は高さ 0', COL.groundH(COL.landTheta(1, HW - 0.01), 16000) < 0.05 && COL.groundH(COL.landTheta(1, -HW + 0.01), 9000) < 0.05);
ok('窓の上は高さ 0 で水も無い', COL.groundH(0, 15000) === 0 && COL.waterAt(0, 15000) === null);
let w = COL.waterAt(-Math.PI / 2, 28000);
ok('陸地Aの奥は海', w && w.kind === '海' && w.level === 0 && w.depth > 20, w && w.kind + ' 深さ' + w.depth.toFixed(1));
w = COL.waterAt(-Math.PI / 2, COL.L - 2);
ok('海はガラスの端まで続く', !!w && w.depth > 10);
ok('陸地Bに湖がある', (function () { const q = COL.waterAt(COL.landTheta(1, -210), 5000); return q && q.kind === '湖' && q.level === 20; })());
ok('市街の中心は陸の上', COL.waterAt(COL.landTheta(0, 600), 12000) === null && COL.zoneOf(0, 600, 12000) === 'downtown');
ok('ゾーン: 山岳と農地', COL.zoneOf(1, 420, 16000) === 'mountain' && COL.zoneOf(2, -600, 10000) === 'farm');

// 山へ向かって歩く: 地面にめり込まず、標高を稼げる
p = COL.createPlayer(COL.landTheta(1, 420), 12000, 400);
p.fly = true; run(p, { ud: -1, run: true }, 3); p.fly = false; run(p, {}, 12);
let sunk = 0, air = 0, hStart = COL.toCyl(p.pos).h, hTop = hStart;
for (let i = 0; i < 60 * 300; i++) {
  COL.stepPlayer(p, { f: 1 }, DT);
  sunk = Math.min(sunk, above(p)); if (!p.grounded) air++;
  hTop = Math.max(hTop, COL.toCyl(p.pos).h);
}
ok('山道で地面にめり込まない', sunk > -1e-3, sunk.toExponential(1));
ok('山道ではほぼ接地したまま', air < 60 * 300 * 0.05, air + ' / ' + 60 * 300 + ' ステップが空中');
ok('歩いて標高を稼げる', hTop - hStart > 60, hStart.toFixed(0) + ' → ' + hTop.toFixed(0) + ' m');

// 海へ歩いて入ると泳ぐ。潜って、離すと浮かぶ。岸へ戻ると歩きに戻る
p = COL.createPlayer(-Math.PI / 2, 24600, 30);
run(p, {}, 4);
ok('海の手前は砂浜か港', !p.swim && p.grounded, COL.placeName(-Math.PI / 2, 24600));
run(p, { f: 1, run: true }, 60);
c = COL.toCyl(p.pos);
ok('海に入ると泳ぐ', p.swim && c.z > 25050, 'z=' + c.z.toFixed(0));
ok('水面に浮かぶ（目は水面の上）', Math.abs(c.h + 1.45) < 0.05, c.h.toFixed(2));
run(p, { ud: -1 }, 3);
ok('下降キーで潜る', COL.toCyl(p.pos).h < -4, COL.toCyl(p.pos).h.toFixed(2));
run(p, {}, 5);
ok('離すと浮かび上がる', Math.abs(COL.toCyl(p.pos).h + 1.45) < 0.05);
run(p, { f: -1, run: true }, 80);
ok('岸に戻ると歩きに戻る', !p.swim && p.grounded && COL.toCyl(p.pos).h > 0, COL.toCyl(p.pos).h.toFixed(2));
ok('数値が壊れていない（水泳後）', p.pos.concat(p.vel, p.up, p.fwd).every(Number.isFinite));

// ---- 宇宙港ドック ----
p = COL.createPlayer(-Math.PI / 2, 3000, 3200);          // 中心軸の近くから宇宙港へ飛ぶ
p.fly = true; p.fwd = [0, 0, -1];
COL.stepPlayer(p, {}, 0);
run(p, { f: 1, run: true }, 40);
c = COL.toCyl(p.pos);
ok('中心軸からドックの奥まで入れる', Math.abs(c.z - (-COL.DOCK_LEN + 3)) < 0.01 && c.r < COL.HUB_R, 'z=' + c.z.toFixed(1) + ' r=' + c.r.toFixed(0));
p.fly = false;
run(p, {}, 60);
c = COL.toCyl(p.pos);
ok('ドックの内壁に降りて立てる', p.grounded && Math.abs(c.r - (COL.HUB_R - 0.6)) < 0.01, 'r=' + c.r.toFixed(2));
ok('ドックの重力は約0.09G', Math.abs(COL.gravityAt(c.r) / COL.G - 0.092) < 0.005);
run(p, { f: 1 }, 20);
ok('内壁を歩いても壁の外へ出ない', COL.toCyl(p.pos).r <= COL.HUB_R && COL.toCyl(p.pos).z < 0, COL.toCyl(p.pos).r.toFixed(2));
p = COL.createPlayer(-Math.PI / 2, 600, COL.R - 800);    // 軸から 800m の山肌の前
p.fly = true; p.fwd = [0, 0, -1];
COL.stepPlayer(p, {}, 0);
run(p, { f: 1, run: true }, 10);
ok('ドックの外の山肌は通り抜けられない', p.pos[2] > 0, p.pos[2].toFixed(1));
ok('数値が壊れていない（ドック）', p.pos.concat(p.vel, p.up, p.fwd).every(Number.isFinite));

// ---- 天井: 頭が当たったら止まる（駅の屋根など。当たり判定は COL.solidCeil が返す） ----
{
  const saved = [COL.groundH, COL.waterAt, COL.solidCeil];
  COL.groundH = null; COL.waterAt = null;
  COL.solidCeil = function (th, z, h) { return h + 1.8 <= 2.6 ? 2.6 : 1e9; };     // 高さ 2.6m の天井
  let q = COL.createPlayer(-Math.PI / 2, 5000, 0), headTop = 0;
  COL.stepPlayer(q, { jump: true }, DT);
  for (let i = 0; i < 120; i++) { COL.stepPlayer(q, {}, DT); headTop = Math.max(headTop, COL.toCyl(q.pos).h + 1.85); }
  ok('ジャンプしても天井で頭が止まる', headTop <= 2.6 + 1e-6 && headTop > 2.5 && q.grounded, headTop.toFixed(3));
  q.fly = true;
  run(q, { ud: 1, run: true }, 3);
  ok('飛んでも天井を抜けられない', COL.toCyl(q.pos).h + 1.85 <= 2.6 + 1e-6, (COL.toCyl(q.pos).h + 1.85).toFixed(3));
  COL.groundH = saved[0]; COL.waterAt = saved[1]; COL.solidCeil = saved[2];
}

// ---- 車 ----
{
  const saved = [COL.groundH, COL.waterAt];
  COL.groundH = null; COL.waterAt = null;                 // まず平らな地面で走りだけ確かめる
  let car = COL.createCar(COL.toWorld(-Math.PI / 2, 5000, 0), [0, 0, 1]);
  let v10 = 0;
  for (let i = 0; i < 60 * 40; i++) { COL.stepCar(car, { throttle: 1 }, DT); if (i === 60 * 5) v10 = car.speed; }
  ok('車: 5秒で 80km/h 以上', v10 * 3.6 > 80, (v10 * 3.6).toFixed(0) + ' km/h');
  ok('車: 最高速は 180km/h', car.speed * 3.6 > 175 && car.speed * 3.6 <= 180.01, (car.speed * 3.6).toFixed(1) + ' km/h');
  ok('車: まっすぐ進む（θ は変わらない）', Math.abs(COL.toCyl(car.pos).theta + Math.PI / 2) < 1e-9 && COL.toCyl(car.pos).z > 6000);
  for (let i = 0; i < 60 * 6; i++) COL.stepCar(car, { brake: true }, DT);
  ok('車: ブレーキで止まる', Math.abs(car.speed) < 1e-6);
  const f0 = car.fwd.slice();
  for (let i = 0; i < 60 * 4; i++) COL.stepCar(car, { throttle: 0.5, steer: 1 }, DT);
  ok('車: ハンドルで向きが変わり、地表から離れない', V.dot(f0, car.fwd) < 0.5 && Math.abs(COL.toCyl(car.pos).h) < 1e-6);
  COL.groundH = saved[0]; COL.waterAt = saved[1];
  // 海へ向かって全開で走っても、水際で止まる
  const th = -Math.PI / 2;
  car = COL.createCar(COL.toWorld(th, 24500, COL.groundH(th, 24500)), [0, 0, 1]);
  for (let i = 0; i < 60 * 30; i++) COL.stepCar(car, { throttle: 1 }, DT);
  const cw = COL.toCyl(car.pos), ww = COL.waterAt(cw.theta, cw.z);
  ok('車: 海の手前で止まる', (!ww || ww.depth <= 0.75) && cw.z > 24600 && car.speed === 0, 'z=' + cw.z.toFixed(0));
  ok('車: 地面に乗っている', Math.abs(cw.h - COL.groundH(cw.theta, cw.z)) < 1e-3);
}

// ---- モノレール ----
{
  const rl = COL.rail();
  ok('路線の一周は 120〜135km', rl.len > 120000 && rl.len < 135000, (rl.len / 1000).toFixed(1) + ' km');
  let gap = 0, minClear = 1e9;
  for (let k = 0; k < rl.N; k++) {
    const a = rl.at(k * rl.ds), b = rl.at((k + 1) * rl.ds);
    let dx = b.x - a.x; dx -= Math.round(dx / rl.WRAP) * rl.WRAP;
    gap = Math.max(gap, Math.abs(Math.hypot(dx, b.z - a.z) - rl.ds));
    minClear = Math.min(minClear, a.h - a.g);
  }
  ok('路線は切れ目なくつながっている', gap < 0.5, gap.toFixed(3));
  ok('桁は地面・水面から 8m 以上の高さ', minClear > 8, minClear.toFixed(1) + ' m');
  const st = rl.stations;
  let minSp = 1e9;
  for (let i = 0; i < st.length; i++) minSp = Math.min(minSp, ((st[(i + 1) % st.length].s - st[i].s) % rl.len + rl.len) % rl.len);
  ok('駅は 39、駅間は 1.2km 以上', st.length === 39 && minSp > 1200, st.length + ' 駅, 最短 ' + minSp.toFixed(0) + ' m');
  ok('運転間隔は約2分', Math.abs(rl.headway - 120) < 2, rl.headway.toFixed(1) + ' 秒 × ' + rl.trains + ' 編成, 一周 ' + (rl.lap / 60).toFixed(0) + ' 分');
  let maxV = 0, back = 0;
  for (let t = 0; t < rl.lap; t += 0.5) {
    const d = (rl.distAt(t + 0.5) - rl.distAt(t) + rl.len) % rl.len;
    if (d > rl.len / 2) back++; else maxV = Math.max(maxV, d / 0.5);
  }
  ok('列車は後戻りせず、最高 120km/h', back === 0 && maxV * 3.6 < 120.5 && maxV * 3.6 > 119, (maxV * 3.6).toFixed(1) + ' km/h');
  let worst = 0, bad2 = 0;
  for (let j = 0; j < st.length; j += 3) for (let t = 0; t < 600; t += 7) for (let rev = 0; rev < 2; rev++) {
    const inf = rl.stationInfo(j, !!rev, t);
    worst = Math.max(worst, inf.wait);
    if (inf.present >= 0 && Math.abs(((rl.trainDist(!!rev, inf.present, t) - st[j].s + rl.len / 2) % rl.len + rl.len) % rl.len - rl.len / 2) > 0.01) bad2++;
  }
  ok('どの駅でも待ち時間は2分以内', worst <= rl.headway, worst.toFixed(0) + ' 秒');
  ok('「停車中」の列車は本当にその駅にいる', bad2 === 0, bad2);
}

// ---- モノレールの車内を歩く（vehicles.js の計算部分だけを使う） ----
{
  globalThis.window = globalThis;
  require(path.join(__dirname, '..', 'js', 'vehicles.js'));
  COL.initRailOnly();
  const rl = COL.rail(), pl = COL.createPlayer(-Math.PI / 2, 5000, 0);
  const tick = function (inp, sec, use) {
    for (let i = 0, n = Math.max(1, Math.round(sec / DT)); i < n; i++) {
      if (COL.onTrain) COL.trainStep(pl, inp, DT); else COL.stepPlayer(pl, inp, DT);
      COL.updateVehicles(DT, pl, !!use && i === 0, false, pl.pos);
    }
  };
  // 駅0 に外回りの電車が止まるまで待って乗る
  let waited = 0;
  while (rl.stationInfo(0, false, waited).present < 0) waited += DT;
  tick({}, waited + DT);
  COL.debugVehicle(pl, 'plat', 0);
  COL.debugVehicle(pl, 'train', 0);
  const tr = COL.onTrain;
  ok('ホームから電車に乗れる', !!tr && !tr.rev);
  tick({ f: 1 }, 6);
  ok('車内: 前へ歩くと先頭の壁で止まる', Math.abs(tr.lz - 11.85) < 0.01, tr.lz.toFixed(2));
  tick({ s: 1 }, 2);
  ok('車内: 横へ歩くと壁で止まる', Math.abs(Math.abs(tr.lx) - 1.04) < 0.01, tr.lx.toFixed(2));
  tick({ f: -1 }, 6);
  ok('車内: 車両の間は真ん中の口しか通れない', Math.abs(tr.lz - 0.68) < 0.01, tr.lz.toFixed(2));
  tick({ s: tr.lx < 0 ? -1 : 1 }, 0.21);
  tick({ f: -1 }, 3);
  ok('車内: 真ん中からなら隣の車両へ行ける', tr.lz < -5, tr.lz.toFixed(2));
  let jy = 0;
  tick({ jump: true }, DT);
  for (let i = 0; i < 90; i++) { tick({}, DT); jy = Math.max(jy, tr.ly); }
  ok('車内: 跳んでも天井で頭が止まる', Math.abs(jy - (3.0 - 0.39 - 1.85)) < 0.01, jy.toFixed(2));
  tr.lz = -6.3; tr.lx = 0; tr.yaw = 0;
  tick({ s: 1 }, 1);
  ok('車内: 座席に上がれる', Math.abs(tr.ly - 0.45) < 0.01, tr.ly.toFixed(2));
  const p0 = pl.pos.slice();
  tick({}, 40);
  ok('電車が走ると一緒に動く', COL.V.len(COL.V.sub(pl.pos, p0)) > 300 && !!COL.onTrain, COL.V.len(COL.V.sub(pl.pos, p0)).toFixed(0) + ' m');
  // 走っている途中で E: 外へ飛び降りる
  tick({}, DT, true);
  ok('走行中でも E で降りられる', COL.onTrain === null && !pl.fly);
  tick({}, 4);
  const cl = COL.toCyl(pl.pos);
  ok('飛び降りると地面まで落ちる', pl.grounded && Math.abs(cl.h - Math.max(COL.groundH(cl.theta, cl.z), (COL.waterAt(cl.theta, cl.z) || { level: -1e9 }).level - 1.45)) < 0.05, cl.h.toFixed(1));
  // 駅に止まっているときに E: その駅の外回りのホームへ（node では駅の床の当たり判定が無いので、置かれた高さと横の位置で確かめる）
  let w2 = 0;
  while (rl.stationInfo(0, false, waited + 4 + 40 + w2).present < 0) w2 += DT;
  tick({}, 4 + w2);
  COL.debugVehicle(pl, 'plat', 0);
  COL.debugVehicle(pl, 'train', 0);
  let rode = 0;
  while (rode < 400 && !(rode > 20 && COL.V.len(pl.vel) < 1e-6)) { tick({}, 0.25); rode += 0.25; }   // 次の駅に止まるまで乗る
  tick({}, DT, true);
  let best = null;
  rl.stations.forEach(function (st) { const q = rl.world(st.s, 0, 0); const e = COL.V.len(COL.V.sub(q.pos, pl.pos)); if (!best || e < best.e) best = { e: e, st: st }; });
  const a2 = rl.at(best.st.s), c2 = COL.toCyl(pl.pos), w0 = rl.world(best.st.s, 0, 0);
  const lat2 = COL.V.dot(COL.V.sub(pl.pos, w0.pos), w0.Rw);
  ok('駅で E を押すと、その電車側（外回り）のホームに降りる', COL.onTrain === null && !pl.fly && Math.abs(c2.h - (a2.h + 0.44)) < 0.05 && lat2 > 4.05 && lat2 < 8.35,
     best.st.name + ' 横 ' + lat2.toFixed(2) + ' m');
}

console.log(fail ? '\n' + fail + ' 件失敗' : '\nすべて成功');
process.exit(fail ? 1 : 0);
