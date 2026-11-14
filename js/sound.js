// 環境音: 風・街のざわめき・波・鳥のさえずり・エンジン音・モノレールの走行音・ドックの低い音
//  音声ファイルは使わず、ブラウザの音声合成（Web Audio）でその場で作る
(function () {
  'use strict';
  const COL = window.COL;
  let ctx = null, master = null, muted = false, timer = 0, chirpT = 2, songT = 4, nbuf = null;
  const g = {};                       // 音ごとの音量つまみ
  let engine = null, rail = null;

  function noiseBuffer() {
    const len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  // 雑音にフィルターをかけた持続音
  function noiseLoop(name, buf, type, freq, q) {
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), gain = ctx.createGain();
    src.buffer = buf; src.loop = true;
    f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7;
    gain.gain.value = 0;
    src.connect(f); f.connect(gain); gain.connect(master);
    src.start(0, Math.random() * 2);
    g[name] = gain;
    return f;
  }
  function tone(name, type, freq, cutoff) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), gain = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    gain.gain.value = 0;
    o.connect(f); f.connect(gain); gain.connect(master);
    o.start();
    g[name] = gain;
    return o;
  }
  // 最初のクリックやキー操作のときに呼ぶ（ブラウザは操作の前に音を出せない）
  COL.initSound = function () {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
      const buf = noiseBuffer();
      nbuf = buf;
      noiseLoop('wind', buf, 'lowpass', 380, 0.5);
      noiseLoop('city', buf, 'lowpass', 170, 0.6);
      noiseLoop('waves', buf, 'bandpass', 520, 0.6);
      noiseLoop('rush', buf, 'bandpass', 900, 0.8);      // 速く動いたときの風切り音
      noiseLoop('dock', buf, 'lowpass', 90, 1.2);
      engine = tone('engine', 'sawtooth', 60, 420);
      rail = tone('rail', 'triangle', 90, 600);
    } catch (e) { ctx = null; }
  };
  // クジラの潮吹き: 「シュー」という息の音（近いほど大きい）
  COL.whaleBlowSound = function (dist) {
    if (!ctx || muted || ctx.state !== 'running' || !nbuf) return;
    const k = Math.max(0, 1 - dist / 1200);
    if (k <= 0) return;
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t0 = ctx.currentTime;
    src.buffer = nbuf; f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.6;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.35 * k * k, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 2.4);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0, Math.random() * 0.5); src.stop(t0 + 2.5);
  };
  // クジラの歌: 低い音がゆっくり上がって下がる（海の中で、クジラが近いとき）
  function whaleSong(k) {
    const o = ctx.createOscillator(), vib = ctx.createOscillator(), vg = ctx.createGain(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t0 = ctx.currentTime;
    const base = 90 + Math.random() * 110, len = 3 + Math.random() * 2.5;
    o.type = 'sine';
    o.frequency.setValueAtTime(base, t0);
    o.frequency.exponentialRampToValueAtTime(base * (1.6 + Math.random()), t0 + len * 0.4);
    o.frequency.exponentialRampToValueAtTime(base * (0.9 + Math.random() * 0.5), t0 + len);
    vib.frequency.value = 5 + Math.random() * 3; vg.gain.value = base * 0.02;
    vib.connect(vg); vg.connect(o.frequency);
    f.type = 'lowpass'; f.frequency.value = 900;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.09 * k, t0 + 0.6);
    g.gain.linearRampToValueAtTime(0.06 * k, t0 + len * 0.7);
    g.gain.linearRampToValueAtTime(0, t0 + len);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t0); vib.start(t0); o.stop(t0 + len + 0.1); vib.stop(t0 + len + 0.1);
  }
  COL.toggleMute = function () {
    muted = !muted;
    COL.muted = muted;                             // テレビの音も消す（js/tv.js）
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.1);
    return muted;
  };
  function set(name, v, tc) { g[name].gain.setTargetAtTime(Math.max(0, v), ctx.currentTime, tc || 0.6); }
  // 鳥のさえずり: 高い音を短く2〜4回
  function chirp() {
    const n = 2 + Math.floor(Math.random() * 3), base = 2600 + Math.random() * 1800, pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; pan.connect(master); }
    for (let k = 0; k < n; k++) {
      const o = ctx.createOscillator(), gain = ctx.createGain(), t0 = ctx.currentTime + k * (0.09 + Math.random() * 0.05);
      o.type = 'sine';
      o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.3), t0);
      o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.4), t0 + 0.06);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.035, t0 + 0.012);
      gain.gain.linearRampToValueAtTime(0, t0 + 0.07);
      o.connect(gain); gain.connect(pan || master);
      o.start(t0); o.stop(t0 + 0.09);
    }
  }
  const NATURE = { park: 1, forest: 1, meadow: 0.7, mountain: 0.5, farm: 0.6, resort: 0.5, beach: 0.3 };

  // 0.2秒ごとに、いる場所と動きに合わせて音量を決める
  COL.updateSound = function (dt, p) {
    if (!ctx || ctx.state !== 'running') return;
    timer -= dt;
    if (timer > 0) return;
    timer = 0.2;
    const c = COL.toCyl(p.pos), speed = COL.V.len(p.vel), night = COL.GL.U.night.value;
    const inDock = c.z < 5, lc = (!inDock && c.z > COL.TERRAIN_Z0) ? COL.landCoord(c.theta) : null;
    let urban = 0, nature = 0, water = 0;
    const alt = Math.max(0, c.h - COL.groundH(c.theta, Math.max(c.z, 0))), low = Math.max(0, 1 - alt / 350);
    if (lc) {
      const zone = COL.zoneOf(lc.index, lc.u, c.z), d = COL.waterSdf(lc.index, lc.u, c.z);
      urban = COL.GRID_ZONES[zone] ? (zone === 'downtown' || zone === 'commercial' ? 1 : 0.55) : 0;
      nature = NATURE[zone] || 0;
      water = Math.max(0, 1 - Math.max(0, d) / 180) * (zone === 'beach' || d < 60 ? 1 : 0.6);
    }
    const uw = COL.underwater ? 1 : 0, riding = COL.onTrain ? 1 : 0, driving = (COL.driving || COL.pilot) ? 1 : 0;
    set('wind', (0.05 + 0.10 * (1 - low)) * (1 - uw) * (inDock ? 0.2 : 1));
    set('city', 0.22 * urban * low * (1 - 0.4 * night) * (1 - uw));
    set('waves', (0.16 * water * low + 0.25 * uw) * (0.75 + 0.25 * Math.sin(ctx.currentTime * 0.9)));
    set('rush', Math.min(0.22, speed / 400 * 0.22) * (1 - uw) * (riding ? 0.4 : 1), 0.3);
    set('dock', inDock ? 0.5 : 0);
    set('engine', driving ? 0.05 + 0.05 * Math.min(1, speed / 30) : 0, 0.15);
    engine.frequency.setTargetAtTime(55 + speed * 3.4, ctx.currentTime, 0.15);
    set('rail', riding ? 0.02 + 0.07 * Math.min(1, speed / 33) : 0, 0.3);
    rail.frequency.setTargetAtTime(70 + speed * 2.2, ctx.currentTime, 0.3);
    // さえずり: 昼の自然の多い場所で、ときどき
    songT -= 0.2;
    if (songT <= 0) {
      songT = 5 + Math.random() * 9;
      if (!muted && COL.underwaterSea && COL.whaleDist < 2000) whaleSong(1 - COL.whaleDist / 2000);
    }
    chirpT -= 0.2;
    if (chirpT <= 0) {
      chirpT = 0.8 + Math.random() * 3.5;
      if (!muted && night < 0.5 && !uw && Math.random() < (nature * 0.9 + urban * 0.12) * low) chirp();
    }
  };
})();
