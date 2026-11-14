// お金・鉱石の値段・保存（描画に依存しない部分は Node でも動く）
//  - 稼ぎ方: 宇宙港の採掘船で隕石から鉱石を採り、宇宙港へ戻ると売れる
//  - 使い道: 陸地A・港町の売地に豪邸を建てる
(function (g) {
  'use strict';
  const COL = g.COL = g.COL || {};

  // ---- 値段の設定（ここを変えれば稼ぐ速さが変わる） ----
  //  ふつうの鉱石で満載にすると約 200万 Cr（豪邸の約 20% → 5往復ほどで買える）
  //  レア鉱石は 5回に1回ほどの出航でだけ現れ、1個で豪邸の 80%
  const ECON = COL.ECON = {
    PRICE: 10000000,            // 豪邸の値段 [Cr]
    HOLD: 10,                   // 採掘船に積める鉱石の数
    RARE_CHANCE: 0.2,           // 1回の出航でレア隕石が現れる確率
    RARE: { id: 'rare', name: '星光石', value: 8000000, col: [0.75, 0.45, 1.0] },
    // w: 隕石がその鉱石である割合
    ORES: [
      { id: 'iron',     name: '鉄鉱石',   value: 160000, w: 0.45, col: [0.62, 0.36, 0.26] },
      { id: 'nickel',   name: 'ニッケル', value: 200000, w: 0.30, col: [0.62, 0.66, 0.60] },
      { id: 'titanium', name: 'チタン',   value: 240000, w: 0.18, col: [0.45, 0.62, 0.80] },
      { id: 'platinum', name: '白金',     value: 300000, w: 0.07, col: [0.95, 0.93, 0.80] },
    ],
  };
  // 0〜1 の乱数 v から鉱石の種類（ORES の番号）を選ぶ
  COL.pickOre = function (v) {
    for (let k = 0; k < ECON.ORES.length; k++) { if (v < ECON.ORES[k].w) return k; v -= ECON.ORES[k].w; }
    return 0;
  };
  // 積み荷 { counts: [鉱石ごとの数], rare: レア鉱石を持っているか } の売値
  COL.cargoValue = function (cargo) {
    let s = cargo.rare ? ECON.RARE.value : 0;
    for (let k = 0; k < ECON.ORES.length; k++) s += (cargo.counts[k] || 0) * ECON.ORES[k].value;
    return s;
  };
  COL.cargoCount = function (cargo) {
    let n = 0;
    for (let k = 0; k < ECON.ORES.length; k++) n += cargo.counts[k] || 0;
    return n;
  };
  COL.newCargo = function () { return { counts: ECON.ORES.map(function () { return 0; }), rare: false }; };
  // 金額の表示（3桁ごとの区切り）
  COL.fmtCr = function (n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' Cr';
  };

  // ---- 保存（ブラウザの localStorage）。プレイヤーごとに別のセーブデータ ----
  //  colSaves1 = { slots: [セーブデータ, …] }。セーブデータは id・名前・モードと、所持金などの中身
  //  （以前の1人ぶんの保存 colSave1 があれば、最初に「これまでのデータ」として取り込む）
  const KEY = 'colSaves1', KEY_OLD = 'colSave1', LAMPS = 10;
  const fresh = function () {
    const lamps = [];
    for (let k = 0; k < LAMPS; k++) lamps.push(k === 0 ? 1 : 0);      // 最初は居間だけ点いている
    return { id: '', name: '', dev: false, created: 0, updated: 0,
             money: 0, owned: false, trips: 0, day: 1, lamps: lamps, clock: 10, pos: null, hotelPaid: false, hotelVisited: false };
  };
  const num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d; };
  const vec3 = function (a) { return Array.isArray(a) && a.length === 3 && a.every(function (v) { return typeof v === 'number' && isFinite(v); }); };
  // 読み込んだ値を確かめて、足りない所は初期値で埋める
  function clean(d) {
    if (!d || typeof d !== 'object') return null;
    const s = fresh();
    s.id = String(d.id || ''); s.name = String(d.name || '').slice(0, 20); s.dev = !!d.dev;
    s.created = num(d.created, 0); s.updated = num(d.updated, 0);
    s.money = Math.max(0, num(d.money, 0)); s.owned = !!d.owned; s.hotelPaid = !!d.hotelPaid; s.hotelVisited = !!d.hotelVisited || s.hotelPaid;
    s.trips = d.trips | 0; s.day = Math.max(1, d.day | 0);
    if (Array.isArray(d.lamps)) for (let k = 0; k < LAMPS; k++) s.lamps[k] = d.lamps[k] ? 1 : 0;
    s.clock = ((num(d.clock, 10) % 24) + 24) % 24;
    if (d.pos && vec3(d.pos.p) && vec3(d.pos.f)) s.pos = { p: d.pos.p.slice(), f: d.pos.f.slice(), pitch: num(d.pos.pitch, 0), fly: !!d.pos.fly };
    return s;
  }
  const newId = function () { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); };
  function readAll() {
    let all = null;
    try { all = JSON.parse(g.localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (!all || !Array.isArray(all.slots)) all = { slots: [] };
    all.slots = all.slots.map(clean).filter(function (s) { return s && s.id; });
    // 以前の保存を取り込む（一度だけ）
    try {
      const old = JSON.parse(g.localStorage.getItem(KEY_OLD) || 'null');
      if (old && typeof old.money === 'number') {
        const s = clean(old);
        s.id = newId(); s.name = 'これまでのデータ'; s.dev = true; s.created = s.updated = Date.now();
        all.slots.push(s);
        g.localStorage.setItem(KEY, JSON.stringify(all));
        g.localStorage.removeItem(KEY_OLD);
      }
    } catch (e) {}
    return all;
  }
  function writeAll(all) {
    try { g.localStorage.setItem(KEY, JSON.stringify(all)); return true; } catch (e) { return false; }
  }

  COL.save = fresh();
  COL.saveId = null;                  // 今使っているセーブデータ（null なら保存しない: 確認用の起動など）
  COL.loadSave = function () { COL.save = fresh(); COL.saveId = null; return COL.save; };
  // セーブデータの一覧（最近遊んだ順）
  COL.listSaves = function () {
    return readAll().slots.sort(function (a, b) { return b.updated - a.updated; });
  };
  // あたらしく始める: 何も持っていない状態のセーブデータを作って、それを使う
  COL.newSave = function (name, dev) {
    const all = readAll(), s = fresh();
    s.id = newId(); s.name = String(name || '').trim().slice(0, 20) || 'プレイヤー' + (all.slots.length + 1);
    s.dev = !!dev; s.created = s.updated = Date.now();
    all.slots.push(s);
    writeAll(all);
    COL.save = s; COL.saveId = s.id;
    return s;
  };
  // 続きから始める
  COL.useSave = function (id) {
    const s = readAll().slots.find(function (x) { return x.id === id; });
    if (!s) return null;
    COL.save = s; COL.saveId = id;
    return s;
  };
  COL.deleteSave = function (id) {
    const all = readAll();
    all.slots = all.slots.filter(function (x) { return x.id !== id; });
    writeAll(all);
  };
  COL.storeSave = function () {
    if (!COL.saveId) return false;
    const all = readAll(), k = all.slots.findIndex(function (x) { return x.id === COL.saveId; });
    COL.save.id = COL.saveId; COL.save.updated = Date.now();
    if (k >= 0) all.slots[k] = COL.save; else all.slots.push(COL.save);      // 別の画面で消されていても残す
    return writeAll(all);
  };

  // ---- 時刻を飛ばす（眠る・モノレールの早送り） ----
  //  h 時にする。0時をまたいだら日付を進める
  COL.setClock = function (h) {
    h = ((h % 24) + 24) % 24;
    if (h < COL.clock) { COL.save.day++; COL.storeSave(); }
    COL.clock = h;
  };
  // 画面を暗くしてから fn を実行し、また明るくする（暗転中は true を返す）
  let fading = false;
  COL.isFading = function () { return fading; };
  COL.fadeThen = function (fn, hold) {
    if (fading || !g.document) return false;
    const el = g.document.getElementById('fade');
    fading = true;
    el.style.opacity = '1';
    setTimeout(function () {
      try { fn(); } catch (e) { console.error(e); }
      setTimeout(function () { el.style.opacity = '0'; fading = false; }, hold || 400);
    }, 1150);
    return true;
  };

  // ---- 画面中央のお知らせ（数秒で消える） ----
  let toastT = 0;
  COL.toast = function (text, seconds) {
    if (!g.document) return;
    const el = g.document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.style.opacity = '1';
    toastT = seconds || 4;
  };
  COL.updateToast = function (dt) {
    if (toastT <= 0) return;
    toastT -= dt;
    if (toastT <= 0) g.document.getElementById('toast').style.opacity = '0';
  };
})(typeof window !== 'undefined' ? window : globalThis);
