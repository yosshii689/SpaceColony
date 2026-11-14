// テレビ: 家とホテルのテレビで同じ動画（Noraemon.mp4）を映す
//  - どちらかのテレビをつけると再生し、両方消すと止める（つけ直すと続きから）
//  - 画面は動画の縦横比に合わせて、テレビの枠の中に収める
//  - 音は、ついているテレビに近いほど大きく聞こえる
//  - 映し方は2通り:
//      gl  … 動画を 3D の画面（WebGL のテクスチャ）に貼る。ローカルサーバー（http://）で開いたとき
//      dom … index.html を直接開いた（file://）ときは、ブラウザの決まりで動画を WebGL に貼れないので、
//            動画の要素そのものを、画面上のテレビの枠の位置へ遠近をつけて重ねる
//    gl で読み込めなかったときも dom に切りかえて試す。それでも読めなければ「信号なし」と理由を出す
(function () {
  'use strict';
  const COL = window.COL, V = COL.V;
  const SRC = 'Noraemon.mp4';
  let video = null, tex = null, noSig = null, failed = false, mode = location.protocol === 'file:' ? 'dom' : 'gl', reason = '';
  const sets = {};                                 // テレビごと { on, screens: [{ mesh, w, h, pos }] }

  function makeVideo() {
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); if (video.parentNode) video.parentNode.removeChild(video); }
    video = document.createElement('video');
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (mode === 'gl') video.crossOrigin = 'anonymous';
    video.volume = 0;
    video.addEventListener('loadedmetadata', fitAll);
    video.addEventListener('error', onError);
    if (mode === 'dom') {
      // 画面に重ねる動画（位置と形は毎フレーム updateTV で決める）
      video.style.cssText = 'position:fixed;left:0;top:0;transform-origin:0 0;pointer-events:none;display:none;z-index:1;background:#000;object-fit:fill;';
      document.body.appendChild(video);
    }
    video.src = SRC;
    tex = mode === 'gl' ? new THREE.VideoTexture(video) : null;
    if (tex) {
      tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    }
    refresh();
  }
  function onError() {
    const code = video && video.error ? video.error.code : 0;
    if (mode === 'gl') { mode = 'dom'; makeVideo(); return; }      // WebGL に貼れない読み方だった → 重ねて映す方法で試す
    failed = true;
    reason = code === 4 ? SRC + ' が見つからないか、読めない形式です' : SRC + ' を読み込めませんでした（エラー ' + code + '）';
    drawNoSignal();
    refresh();
  }
  // 信号なしの画面（理由つき）
  function drawNoSignal() {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 288;
    const c = cv.getContext('2d');
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    bars.forEach(function (b, k) { c.fillStyle = b; c.fillRect(k * 512 / 7, 0, 512 / 7 + 1, 200); });
    c.fillStyle = '#111'; c.fillRect(0, 200, 512, 88);
    c.fillStyle = '#fff'; c.textAlign = 'center';
    c.font = 'bold 34px sans-serif'; c.fillText('信号なし', 256, 240);
    c.font = '18px sans-serif'; c.fillText(reason, 256, 272);
    noSig = new THREE.CanvasTexture(cv);
  }
  // 動画の縦横比に合わせて、枠（w × h）の中に収まる大きさにする
  function fitAll() {
    const ar = video && video.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9;
    for (const id in sets) sets[id].screens.forEach(function (s) {
      const sw = Math.min(s.w, s.h * ar), sh = sw / ar;
      s.mesh.scale.set(sw, sh, 1);
      s.mesh.updateMatrixWorld(true);
    });
  }
  function anyOn() { for (const id in sets) if (sets[id].on) return true; return false; }
  function refresh() {
    const any = anyOn();
    for (const id in sets) {
      const on = sets[id].on;
      sets[id].screens.forEach(function (s) {
        // gl: 3D の画面に動画。dom: 3D の画面は黒いまま（動画は上に重ねる）。読めないとき: 信号なし
        s.mesh.visible = on && (failed || mode === 'gl');
        s.mesh.material.map = failed ? noSig : tex;
        s.mesh.material.needsUpdate = true;
      });
    }
    if (!video || failed) { if (video && mode === 'dom') video.style.display = 'none'; return; }
    if (any && video.paused) { const pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); }
    if (!any && !video.paused) video.pause();
    if (!any && mode === 'dom') video.style.display = 'none';
  }

  // テレビの画面を作る。parent: 置く先（家・ホテルの Group）, id: テレビの名前, w / h: 枠の中の大きさ [m]
  //  pos: 画面の中心（parent の座標）, ny: 画面の向き（y 軸まわりの回転。0 で +z を向く）, world: 画面の中心の世界の位置（音の大きさを測る）
  COL.addTV = function (parent, id, w, h, pos, ny, world) {
    if (!video) makeVideo();
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.y = ny;
    mesh.visible = false;
    parent.add(mesh);
    mesh.updateMatrixWorld(true);
    if (!sets[id]) sets[id] = { on: false, screens: [] };
    sets[id].screens.push({ mesh: mesh, w: w, h: h, pos: world });
    fitAll();
    return mesh;
  };
  COL.tvVideo = function () { return video; };     // 確認用
  COL.tvMode = function () { return failed ? 'failed' : mode; };
  COL.tvOn = function (id) { return !!(sets[id] && sets[id].on); };
  COL.setTV = function (id, on) {
    if (!sets[id]) return;
    sets[id].on = !!on;
    refresh();
  };

  // 単位正方形 → 画面上の四角形（四隅 p0 左上, p1 右上, p2 右下, p3 左下）の射影変換を、CSS の matrix3d にする
  function quadMatrix(w, h, p) {
    const x0 = p[0][0], y0 = p[0][1], x1 = p[1][0], y1 = p[1][1], x2 = p[2][0], y2 = p[2][1], x3 = p[3][0], y3 = p[3][1];
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    const den = dx1 * dy2 - dx2 * dy1;
    const g = (sx * dy2 - dx2 * sy) / den, k = (dx1 * sy - sx * dy1) / den;
    const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + k * y3, f = y0;
    return 'matrix3d(' + [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, c, f, 0, 1].join(',') + ')';
  }
  const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
  // 毎フレーム（カメラを動かした後）: 音の大きさと、dom のときは動画を重ねる位置
  COL.updateTV = function (p, camera) {
    if (!video || failed) return;
    const e = COL.eyePos(p);
    let best = null, bd = 1e9;
    for (const id in sets) if (sets[id].on) sets[id].screens.forEach(function (s) {
      const d = s.pos ? V.len(V.sub(e, s.pos)) : 1e9;
      if (d < bd) { bd = d; best = s; }
    });
    // 音: ついているテレビとの距離で決める（12m 先でほぼ聞こえない）
    const vol = COL.muted ? 0 : Math.max(0, Math.min(1, 1.15 - bd / 11)) * 0.8;
    video.volume += (vol - video.volume) * 0.2;
    if (mode !== 'dom') return;
    // 重ねて映す: 近くのテレビが見えている（前に立っていて、画面がカメラの前にある）ときだけ
    let show = false;
    if (best && camera && bd < 30 && !(COL.mapOpen && COL.mapOpen())) {
      const m = best.mesh.matrixWorld;
      _c.setFromMatrixPosition(m);
      _n.set(0, 0, 1).transformDirection(m);
      if (_n.dot(_v.copy(camera.position).sub(_c)) > 0) {
        const W = window.innerWidth, H = window.innerHeight, pts = [];
        const corners = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
        show = true;
        for (let k = 0; k < 4 && show; k++) {
          _v.set(corners[k][0], corners[k][1], 0).applyMatrix4(m);
          const inFront = _v.clone().applyMatrix4(camera.matrixWorldInverse).z < -camera.near;
          if (!inFront) { show = false; break; }
          _v.project(camera);
          pts.push([(_v.x + 1) / 2 * W, (1 - _v.y) / 2 * H]);
        }
        if (show) {
          const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
          video.style.width = vw + 'px'; video.style.height = vh + 'px';
          video.style.transform = quadMatrix(vw, vh, pts);
        }
      }
    }
    video.style.display = show ? 'block' : 'none';
  };
})();
