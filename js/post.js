// 最高画質の仕上げ（画面全体にかける処理）
//  1. いったん明るさに上限のない画像として描く（太陽の照り返しや夜の明かりが「白」で頭打ちにならない）
//  2. 物の隅・地面との境目の陰り（奥行きから計算する）
//  3. 強い光のにじみ
//  4. 明るさの階調を整える（白飛びをなだらかに、少しだけ締まった色に）
//  5. 輪郭のギザギザをならす
(function () {
  'use strict';
  const COL = window.COL;
  let W = 0, H = 0, rtScene = null, rtAO = null, rtAOb = null, rtLDR = null, down = [], up = [], broken = false;
  const LEVELS = 5;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), qScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  qScene.add(quad);
  const _size = new THREE.Vector2();

  const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  function mat(fs, uniforms) {
    return new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms: uniforms, depthTest: false, depthWrite: false });
  }
  const DEPTH = `
    uniform sampler2D tDepth;
    uniform mat4 projInv;
    vec3 viewPos(vec2 uv) {
      vec4 c = projInv * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0);
      return c.xyz / c.w;
    }`;
  // ---- 隅の陰り ----
  const mAO = mat(DEPTH + `
    uniform vec2 px, pscale;          // px: 奥行きの画像の1画素, pscale: 1m が画面の何割に当たるか（距離 1m のとき）
    varying vec2 vUv;
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main() {
      float d = texture2D(tDepth, vUv).x;
      if (d >= 0.999999) { gl_FragColor = vec4(1.0); return; }
      vec3 P = viewPos(vUv);
      float dist = -P.z;
      if (dist > 260.0) { gl_FragColor = vec4(1.0); return; }
      vec3 Pr = viewPos(vUv + vec2(px.x, 0.0)), Pl = viewPos(vUv - vec2(px.x, 0.0));
      vec3 Pu = viewPos(vUv + vec2(0.0, px.y)), Pd = viewPos(vUv - vec2(0.0, px.y));
      vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
      vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
      vec3 N = normalize(cross(dx, dy));
      float radius = clamp(0.55 + dist * 0.03, 0.55, 3.2);
      float ang = ign(gl_FragCoord.xy) * 6.2831853, occ = 0.0;
      for (int i = 0; i < 12; i++) {
        float a = ang + float(i) * 2.39996, rr = sqrt((float(i) + 0.5) / 12.0) * radius;
        vec2 o = vec2(cos(a), sin(a)) * rr * pscale / dist;
        vec3 v = viewPos(vUv + o) - P;
        float l = length(v);
        occ += max(dot(N, v) / (l + 1e-4) - 0.10, 0.0) * (1.0 - smoothstep(radius * 0.7, radius * 1.7, l));
      }
      float ao = clamp(1.0 - occ / 12.0 * 2.3, 0.0, 1.0);
      gl_FragColor = vec4(mix(ao, 1.0, smoothstep(140.0, 260.0, dist)));
    }`, { tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, px: { value: new THREE.Vector2() }, pscale: { value: new THREE.Vector2() } });
  // 陰りのざらつきを、奥行きの近い画素どうしでならす
  const mAOBlur = mat(DEPTH + `
    uniform sampler2D tAO;
    uniform vec2 px;
    varying vec2 vUv;
    void main() {
      float z0 = -viewPos(vUv).z, sum = 0.0, wsum = 0.0;
      for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
        vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * px;
        float w = max(0.0, 1.0 - abs(-viewPos(uv).z - z0) / (0.04 * z0 + 0.15)) + 1e-3;
        sum += texture2D(tAO, uv).r * w; wsum += w;
      }
      gl_FragColor = vec4(sum / wsum);
    }`, { tDepth: { value: null }, projInv: mAO.uniforms.projInv, tAO: { value: null }, px: { value: new THREE.Vector2() } });
  // ---- 光のにじみ ----
  const mBright = mat(`
    uniform sampler2D tex;
    uniform vec2 px;
    varying vec2 vUv;
    vec3 pick(vec2 uv) {
      vec3 c = min(texture2D(tex, uv).rgb, vec3(6.0));
      float b = max(c.r, max(c.g, c.b));
      return c * smoothstep(1.02, 1.45, b);
    }
    void main() {
      gl_FragColor = vec4((pick(vUv + px * vec2(-0.5, -0.5)) + pick(vUv + px * vec2(0.5, -0.5))
                         + pick(vUv + px * vec2(-0.5, 0.5)) + pick(vUv + px * vec2(0.5, 0.5))) * 0.25, 1.0);
    }`, { tex: { value: null }, px: { value: new THREE.Vector2() } });
  const mDown = mat(`
    uniform sampler2D tex;
    uniform vec2 px;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vec4((texture2D(tex, vUv + px * vec2(-1.0, -1.0)).rgb + texture2D(tex, vUv + px * vec2(1.0, -1.0)).rgb
                         + texture2D(tex, vUv + px * vec2(-1.0, 1.0)).rgb + texture2D(tex, vUv + px * vec2(1.0, 1.0)).rgb) * 0.25, 1.0);
    }`, { tex: { value: null }, px: { value: new THREE.Vector2() } });
  const mUp = mat(`
    uniform sampler2D tex, tAdd;
    uniform vec2 px;
    varying vec2 vUv;
    void main() {
      vec3 c = (texture2D(tex, vUv + px * vec2(-1.0, -1.0)).rgb + texture2D(tex, vUv + px * vec2(1.0, -1.0)).rgb
              + texture2D(tex, vUv + px * vec2(-1.0, 1.0)).rgb + texture2D(tex, vUv + px * vec2(1.0, 1.0)).rgb) * 0.25;
      gl_FragColor = vec4(c + texture2D(tAdd, vUv).rgb, 1.0);
    }`, { tex: { value: null }, tAdd: { value: null }, px: { value: new THREE.Vector2() } });
  // ---- まとめ: 陰り + にじみ + 階調 ----
  const mComp = mat(`
    uniform sampler2D tScene, tAO, tBloom;
    uniform float aoK, bloomK;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tScene, vUv).rgb;
      c *= mix(1.0, texture2D(tAO, vUv).r, aoK);
      c += texture2D(tBloom, vUv).rgb * bloomK;
      // 明るい所はなだらかに白へ近づける（0.6 までは元のまま）
      c *= 1.06;
      vec3 hi = 0.6 + 0.4 * (1.0 - exp(-(max(c, 0.6) - 0.6) / 0.4));
      c = mix(c, hi, step(0.6, c));
      // 少しだけ締まった階調と、濃いめの色
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.15);
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.10);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`, { tScene: { value: null }, tAO: { value: null }, tBloom: { value: null }, aoK: { value: 0.85 }, bloomK: { value: 0.55 } });
  // ---- 仕上げ: 輪郭のギザギザをならす + 四隅を少し暗く + 色の段差を散らす ----
  const mFinal = mat(`
    uniform sampler2D tex;
    uniform vec2 px;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec3 cM = texture2D(tex, vUv).rgb;
      float lNW = luma(texture2D(tex, vUv + px * vec2(-1.0, -1.0)).rgb), lNE = luma(texture2D(tex, vUv + px * vec2(1.0, -1.0)).rgb);
      float lSW = luma(texture2D(tex, vUv + px * vec2(-1.0, 1.0)).rgb), lSE = luma(texture2D(tex, vUv + px * vec2(1.0, 1.0)).rgb);
      float lM = luma(cM), lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0) * px;
      vec3 a = 0.5 * (texture2D(tex, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tex, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
      vec3 b = a * 0.5 + 0.25 * (texture2D(tex, vUv - dir * 0.5).rgb + texture2D(tex, vUv + dir * 0.5).rgb);
      float lB = luma(b);
      vec3 c = (lB < lMin || lB > lMax) ? a : b;
      vec2 q = vUv - 0.5;
      c *= 1.0 - 0.28 * smoothstep(0.25, 0.85, dot(q, q) * 2.0);
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      gl_FragColor = vec4(c + (n - 0.5) / 255.0, 1.0);
    }`, { tex: { value: null }, px: { value: new THREE.Vector2() } });

  function target(w, h, type, depth) {
    const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: type, depthBuffer: !!depth, stencilBuffer: false });
    t.texture.generateMipmaps = false;
    if (depth) {
      t.depthTexture = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
      t.depthTexture.type = THREE.UnsignedIntType;
      t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
    }
    return t;
  }
  function dispose() {
    [rtScene, rtAO, rtAOb, rtLDR].concat(down, up).forEach(function (t) { if (t) { if (t.depthTexture) t.depthTexture.dispose(); t.dispose(); } });
    rtScene = rtAO = rtAOb = rtLDR = null; down = []; up = [];
  }
  function resize(w, h) {
    dispose();
    W = w; H = h;
    rtScene = target(w, h, THREE.HalfFloatType, true);
    rtLDR = target(w, h, THREE.UnsignedByteType, false);
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    rtAO = target(hw, hh, THREE.UnsignedByteType, false);
    rtAOb = target(hw, hh, THREE.UnsignedByteType, false);
    for (let k = 0, cw = hw, ch = hh; k < LEVELS; k++, cw = Math.ceil(cw / 2), ch = Math.ceil(ch / 2)) {
      down.push(target(cw, ch, THREE.HalfFloatType, false));
      if (k < LEVELS - 1) up.push(target(cw, ch, THREE.HalfFloatType, false));
    }
  }
  function run(renderer, material, out) {
    quad.material = material;
    renderer.setRenderTarget(out);
    renderer.render(qScene, cam);
  }

  // 最高画質のときの1フレーム。うまく動かない環境では、ふつうの描き方に戻す
  COL.renderPost = function (renderer, scene, camera) {
    if (broken) { renderer.render(scene, camera); return; }
    try {
      renderer.info.autoReset = false;          // 画面の左上の「負荷」に、仕上げの分ではなく景色を描いた分を出す
      renderer.info.reset();
      renderer.getDrawingBufferSize(_size);
      if (_size.x !== W || _size.y !== H || !rtScene) resize(_size.x, _size.y);
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      const bg = scene.background;
      // 隅の陰り（半分の解像度）
      mAO.uniforms.tDepth.value = mAOBlur.uniforms.tDepth.value = rtScene.depthTexture;
      mAO.uniforms.projInv.value.copy(camera.projectionMatrixInverse);
      mAO.uniforms.px.value.set(1 / W, 1 / H);
      const pe = camera.projectionMatrix.elements;
      mAO.uniforms.pscale.value.set(pe[0] * 0.5, pe[5] * 0.5);
      run(renderer, mAO, rtAO);
      mAOBlur.uniforms.tAO.value = rtAO.texture;
      mAOBlur.uniforms.px.value.set(1 / rtAO.width, 1 / rtAO.height);
      run(renderer, mAOBlur, rtAOb);
      // 光のにじみ: 明るい所だけ取り出して、縮めながらぼかし、広げながら重ねる
      mBright.uniforms.tex.value = rtScene.texture; mBright.uniforms.px.value.set(1 / W, 1 / H);
      run(renderer, mBright, down[0]);
      for (let k = 1; k < LEVELS; k++) {
        mDown.uniforms.tex.value = down[k - 1].texture; mDown.uniforms.px.value.set(0.5 / down[k - 1].width, 0.5 / down[k - 1].height);
        run(renderer, mDown, down[k]);
      }
      let src = down[LEVELS - 1];
      for (let k = LEVELS - 2; k >= 0; k--) {
        mUp.uniforms.tex.value = src.texture; mUp.uniforms.tAdd.value = down[k].texture; mUp.uniforms.px.value.set(0.5 / src.width, 0.5 / src.height);
        run(renderer, mUp, up[k]);
        src = up[k];
      }
      mComp.uniforms.tScene.value = rtScene.texture; mComp.uniforms.tAO.value = rtAOb.texture; mComp.uniforms.tBloom.value = src.texture;
      mComp.uniforms.aoK.value = COL.underwater ? 0.3 : 0.85;
      run(renderer, mComp, rtLDR);
      mFinal.uniforms.tex.value = rtLDR.texture; mFinal.uniforms.px.value.set(1 / W, 1 / H);
      run(renderer, mFinal, null);
      scene.background = bg;
    } catch (e) {
      broken = true;
      renderer.setRenderTarget(null);
      if (window.console) console.warn('最高画質の仕上げを止めました: ' + (e && e.message));
      renderer.render(scene, camera);
    }
  };
})();
