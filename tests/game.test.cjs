// お金と鉱石の値段の計算を Node で確かめる:  node tests/game.test.cjs
const path = require('path');
require(path.join(__dirname, '..', 'js', 'core.js'));
require(path.join(__dirname, '..', 'js', 'game.js'));
const COL = globalThis.COL, E = COL.ECON;
let fail = 0;
function ok(name, cond, info) {
  if (!cond) fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}

const wsum = E.ORES.reduce((s, o) => s + o.w, 0);
ok('鉱石の割合の合計は 1', Math.abs(wsum - 1) < 1e-9, wsum);

// ふつうの鉱石で満載にしたときの平均の売値は、豪邸の約 20%（5往復ほどで買える）
const avg = E.ORES.reduce((s, o) => s + o.w * o.value, 0) * E.HOLD;
ok('満載の平均の売値は豪邸の 18〜22%', avg / E.PRICE > 0.18 && avg / E.PRICE < 0.22, (avg / E.PRICE * 100).toFixed(1) + '%');
ok('レア鉱石は 1個で豪邸の 80%', E.RARE.value === E.PRICE * 0.8);
ok('レア隕石が現れるのは 5回に1回', E.RARE_CHANCE === 0.2);

// 乱数で選んだ鉱石の割合が、設定どおりになる
const r = COL.rng(12345), n = [0, 0, 0, 0], N = 200000;
for (let k = 0; k < N; k++) n[COL.pickOre(r())]++;
ok('鉱石の出る割合', E.ORES.every((o, k) => Math.abs(n[k] / N - o.w) < 0.01), n.map((v) => (v / N).toFixed(3)).join(' '));

// 積み荷の売値
const c = COL.newCargo();
ok('空の積み荷は 0 Cr', COL.cargoValue(c) === 0 && COL.cargoCount(c) === 0);
c.counts[0] = 3; c.counts[3] = 2;
ok('鉄3 + 白金2 の売値', COL.cargoValue(c) === 3 * E.ORES[0].value + 2 * E.ORES[3].value && COL.cargoCount(c) === 5, COL.fmtCr(COL.cargoValue(c)));
c.rare = true;
ok('レア鉱石は積み荷の数に数えない', COL.cargoCount(c) === 5 && COL.cargoValue(c) === 3 * E.ORES[0].value + 2 * E.ORES[3].value + E.RARE.value);
ok('金額の表示', COL.fmtCr(10000000) === '10,000,000 Cr' && COL.fmtCr(0) === '0 Cr' && COL.fmtCr(960000) === '960,000 Cr');

// 何往復で豪邸が買えるか（毎回ふつうに満載、レアは 20% で見つけて持ち帰るとして 1万人ぶん）
const rr = COL.rng(777);
let total = 0, worst = 0;
for (let p = 0; p < 10000; p++) {
  let money = 0, trips = 0;
  while (money < E.PRICE) {
    trips++;
    for (let k = 0; k < E.HOLD; k++) money += E.ORES[COL.pickOre(rr())].value;
    if (rr() < E.RARE_CHANCE) money += E.RARE.value;
  }
  total += trips; worst = Math.max(worst, trips);
}
ok('豪邸が買えるまでの往復は平均 3〜5 回、最悪でも 6 回', total / 10000 >= 3 && total / 10000 <= 5 && worst <= 6, '平均 ' + (total / 10000).toFixed(2) + ' 回・最悪 ' + worst + ' 回');

// 保存が無い環境（Node）でも動く
COL.loadSave(); COL.storeSave();
ok('保存が使えなくても初期値で始まる', COL.save.money === 0 && COL.save.owned === false && COL.save.lamps.length === 10);

// プレイヤーごとのセーブデータ（localStorage の代わりに、メモリ上の入れ物を使う）
{
  const mem = {};
  globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  mem.colSave1 = JSON.stringify({ money: 5000000, owned: true, trips: 3, day: 4, lamps: [1, 1, 0, 0, 0, 0, 0, 0, 0, 1] });
  let list = COL.listSaves();
  ok('以前の保存を「これまでのデータ」として取り込む', list.length === 1 && list[0].name === 'これまでのデータ' && list[0].money === 5000000 && list[0].owned && !('colSave1' in mem));
  const a = COL.newSave('たろう', false);
  ok('あたらしく始めると何も持っていない', COL.save === a && a.money === 0 && !a.owned && a.day === 1 && a.pos === null && !a.dev);
  COL.save.money = 1234567; COL.save.pos = { p: [1, 2, 3], f: [0, 0, 1], pitch: 0.1, fly: false }; COL.storeSave();
  const b = COL.newSave('', true);
  ok('名前が空なら自動で付ける・開発者モード', /^プレイヤー/.test(b.name) && b.dev);
  COL.save.money = 99; COL.storeSave();
  COL.useSave(a.id);
  ok('続きから: たろうのデータに戻る', COL.save.name === 'たろう' && COL.save.money === 1234567 && COL.save.pos.p[2] === 3);
  COL.useSave(b.id);
  ok('続きから: 別のプレイヤーのデータは別', COL.save.money === 99 && COL.save.pos === null);
  ok('一覧は 3 人ぶん', COL.listSaves().length === 3);
  COL.deleteSave(a.id);
  ok('削除すると一覧から消える', COL.listSaves().length === 2 && !COL.listSaves().some((s) => s.name === 'たろう'));
  mem.colSaves1 = '{壊れたデータ';
  ok('保存が壊れていても空の一覧で動く', COL.listSaves().length === 0);
  delete globalThis.localStorage;
  COL.loadSave();
}

// 時刻を飛ばす: 0時をまたいだときだけ日付が進む
COL.clock = 23; COL.save.day = 1; COL.setClock(7);
ok('夜 23時に眠って朝 7時 → 翌日', COL.clock === 7 && COL.save.day === 2);
COL.setClock(18);
ok('朝 7時から夕方 18時まで → 同じ日', COL.clock === 18 && COL.save.day === 2);
COL.clock = 20; COL.setClock(18);
ok('夜 20時に眠って次の 18時 → 翌日', COL.clock === 18 && COL.save.day === 3);
COL.clock = 3; COL.setClock(7);
ok('夜中の 3時に眠って朝 7時 → 同じ日', COL.clock === 7 && COL.save.day === 3);
COL.clock = 23.9; COL.setClock(23.9 + 0.5);
ok('モノレールで 0時をまたぐ → 翌日', Math.abs(COL.clock - 0.4) < 1e-9 && COL.save.day === 4);

console.log(fail ? '\n失敗 ' + fail + ' 件' : '\nすべて成功');
process.exit(fail ? 1 : 0);
