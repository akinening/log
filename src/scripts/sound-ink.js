/* ------------------------------------------------------------------
   SOUND ページ — アンビエントサウンドを青いインクとして可視化する
   インタラクティブアート
   - ページ全体を透明な水面と見立て、ambient.js の発音イベント
     （akinen:tone）を受けて、音階に応じた濃淡・大きさの青インクを
     ふわっと滲ませる（低い音ほど濃く大きな滴、高い音ほど淡く小さな滴）
   - GPU 上の安定流体ソルバ（移流 → 渦度強化 → 圧力射影）でインクが
     ぐにゃりと歪み、混ざり合う。マウス／タッチは速度場だけをかき混ぜ、
     インクそのものは音からしか生まれない
   - インクは吸光度（-ln(色)）で保持し、表示時に exp(-吸光度) で
     紙色へ乗せる。重なるほど濃く沈む、本物のインクの減法混色になる
   - 音の減衰とともにインクも薄れ、完全に静まったら描画ループを止めて
     フィールドをクリアする（無音のとき＝真っ白な水面・GPU 負荷ゼロ）
   - WebGL2 を優先し、WebGL1 + OES_texture_half_float にフォール
     バック。どちらも使えない環境と reduced-motion では白いページの
     まま（.is-static）
------------------------------------------------------------------- */

import { enableAmbient, saveChoice, readChoice, NOTE_MIN, NOTE_MAX } from "./ambient";

/* ---- チューニング定数 --------------------------------------------- */
const SIM_RES = 144; // 速度場・圧力場の解像度（短辺）
const DYE_RES = 768; // インク場の解像度（短辺）
const PRESSURE_ITERS = 20; // 圧力ヤコビ反復回数
const CURL_STRENGTH = 10; // 渦度強化（ぐにゃり感の源）
const VEL_DISSIPATION = 0.35; // 速度の減衰 /s
const DYE_DISSIPATION = 0.3; // インクの減衰 /s（音の余韻）
const DYE_DISSIPATION_FAST = 1.6; // サウンド OFF 後の早い減衰
const MOUSE_FORCE = 3800; // ポインタ移動 → 速度注入の係数
const MOUSE_RADIUS = 0.0035; // ポインタのかき混ぜ半径（uv²）
const BLEED_FORCE = 12; // インクを外へ押し出す滲みの力
const CURRENT_FORCE = 1.6; // 常に漂うごく弱い環流
const EMIT_SATURATION = 1.55; // 1音あたりの総吸光度スケール
const QUIET_TAIL_MS = 12000; // 最後の入力から描画を止めるまで
const UI_IDLE_MS = 6000; // UI が退場するまでの無操作時間

// 音階 → インクの濃淡。吸光度（-ln(色)）空間で補間すると、
// 表示時の exp(-A) で実際のインクのような減法混色になる
// 青チャンネルをほぼ吸収しない（B≈0）ことで、どの濃度でも彩度の高い
// ウルトラマリンになる。Bまで吸収するとグレーがかった鈍い青に沈む
const INK_DEEP = [3.6, 2.1, 0.12]; // 低音: 濃い群青（≒ rgb(0.03, 0.12, 0.89)）
const INK_PALE = [0.66, 0.3, 0.015]; // 高音: 明るい空色（≒ rgb(0.52, 0.74, 0.99)）

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* ---- シェーダ ------------------------------------------------------ */

// 全パス共通の頂点シェーダ。近傍テクセル座標も varying で渡す
const BASE_VERT = `
precision highp float;
attribute vec2 aPos;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const CLEAR_FRAG = `
precision mediump float;
precision mediump sampler2D;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uValue;
void main () {
  gl_FragColor = uValue * texture2D(uTexture, vUv);
}
`;

// ガウス状の値をフィールドへ加算（インク・速度の両方に使う）
const SPLAT_FRAG = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
void main () {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  vec3 base = texture2D(uTarget, vUv).xyz;
  gl_FragColor = vec4(base + splat, 1.0);
}
`;

// セミラグランジュ移流。半精度の線形補間が使えない環境では
// MANUAL_FILTERING で手動バイリニア補間にフォールバックする
const ADVECTION_FRAG = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform vec2 dyeTexelSize;
uniform float dt;
uniform float uDissipation;

#ifdef MANUAL_FILTERING
vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}
#endif

void main () {
#ifdef MANUAL_FILTERING
  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
  vec4 result = bilerp(uSource, coord, dyeTexelSize);
#else
  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
  vec4 result = texture2D(uSource, coord);
#endif
  gl_FragColor = result / (1.0 + uDissipation * dt);
}
`;

const DIVERGENCE_FRAG = `
precision mediump float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const CURL_FRAG = `
precision mediump float;
precision highp sampler2D;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

// 渦度強化。数値拡散で消えた小さな渦を復元し、有機的なうねりを作る
const VORTICITY_FRAG = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float dt;
void main () {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uCurlStrength * C;
  force.y *= -1.0;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity += force * dt;
  velocity = min(max(velocity, -1000.0), 1000.0);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

const PRESSURE_FRAG = `
precision mediump float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float divergence = texture2D(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const GRADIENT_FRAG = `
precision mediump float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

// 表示。吸光度 → exp(-A) で紙色へ乗せ、濃度勾配で縁をわずかに
// 濃くして水彩のにじみのエッジを出す
const DISPLAY_FRAG = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uDye;
uniform vec3 uBack;

float lum (vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main () {
  vec3 a = texture2D(uDye, vUv).rgb;
  float gx = lum(texture2D(uDye, vR).rgb) - lum(texture2D(uDye, vL).rgb);
  float gy = lum(texture2D(uDye, vT).rgb) - lum(texture2D(uDye, vB).rgb);
  float edge = min(length(vec2(gx, gy)) * 2.4, 0.5);
  vec3 col = uBack * exp(-a * (1.0 + edge));
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---- WebGL ユーティリティ ------------------------------------------ */

const compile = (gl, type, src) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
  }
  return shader;
};

const createProgram = (gl, fragSrc, uniformNames, defines = "") => {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, BASE_VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, defines + fragSrc));
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "program link failed");
  }
  const u = {};
  uniformNames.forEach((name) => {
    u[name] = gl.getUniformLocation(prog, name);
  });
  return { prog, u };
};

function supportRenderTexture(gl, internalFormat, format, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  return ok;
}

// R → RG → RGBA の順にレンダリング可能なフォーマットへフォールバック
function getSupportedFormat(gl, internalFormat, format, type) {
  if (supportRenderTexture(gl, internalFormat, format, type)) {
    return { internalFormat, format };
  }
  if (internalFormat === gl.R16F) return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
  if (internalFormat === gl.RG16F) return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
  return null;
}

function getContext(canvas) {
  const params = { alpha: false, depth: false, stencil: false, antialias: false };
  let gl = canvas.getContext("webgl2", params);
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext("webgl", params);
  if (!gl) return null;

  let halfFloatType;
  let linear;
  if (isGL2) {
    gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("EXT_color_buffer_half_float");
    halfFloatType = gl.HALF_FLOAT;
    linear = true; // WebGL2 は半精度テクスチャの線形補間をコアでサポート
  } else {
    const ext = gl.getExtension("OES_texture_half_float");
    if (!ext) return null;
    halfFloatType = ext.HALF_FLOAT_OES;
    linear = !!gl.getExtension("OES_texture_half_float_linear");
  }

  const formats = isGL2
    ? {
        rgba: getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatType),
        rg: getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatType),
        r: getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatType)
      }
    : {
        rgba: getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatType),
        rg: getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatType),
        r: getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatType)
      };
  if (!formats.rgba || !formats.rg || !formats.r) return null;
  return { gl, halfFloatType, linear, formats };
}

// サイトの紙色（--paper）を表示シェーダの背景として使う
function paperColor() {
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return [0.98, 0.98, 0.968];
  return m.slice(0, 3).map((v) => Math.min(1, parseFloat(v) / 255));
}

/* ---- 本体 ---------------------------------------------------------- */

class SoundInk {
  constructor(stage, signal) {
    this.stage = stage;
    const canvas = document.createElement("canvas");
    canvas.className = "sound-canvas";
    canvas.setAttribute("aria-hidden", "true");

    const ctx = getContext(canvas);
    if (!ctx) throw new Error("WebGL unavailable");
    this.gl = ctx.gl;
    this.halfFloatType = ctx.halfFloatType;
    this.linear = ctx.linear;
    this.formats = ctx.formats;

    const gl = this.gl;
    gl.disable(gl.BLEND);

    // フルスクリーントライアングル
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const defs = this.linear ? "" : "#define MANUAL_FILTERING\n";
    this.programs = {
      clear: createProgram(gl, CLEAR_FRAG, ["texelSize", "uTexture", "uValue"]),
      splat: createProgram(gl, SPLAT_FRAG, [
        "texelSize",
        "uTarget",
        "uAspect",
        "uColor",
        "uPoint",
        "uRadius"
      ]),
      advection: createProgram(
        gl,
        ADVECTION_FRAG,
        ["texelSize", "dyeTexelSize", "uVelocity", "uSource", "dt", "uDissipation"],
        defs
      ),
      divergence: createProgram(gl, DIVERGENCE_FRAG, ["texelSize", "uVelocity"]),
      curl: createProgram(gl, CURL_FRAG, ["texelSize", "uVelocity"]),
      vorticity: createProgram(gl, VORTICITY_FRAG, [
        "texelSize",
        "uVelocity",
        "uCurl",
        "uCurlStrength",
        "dt"
      ]),
      pressure: createProgram(gl, PRESSURE_FRAG, ["texelSize", "uPressure", "uDivergence"]),
      gradient: createProgram(gl, GRADIENT_FRAG, ["texelSize", "uPressure", "uVelocity"]),
      display: createProgram(gl, DISPLAY_FRAG, ["texelSize", "uDye", "uBack"])
    };

    this.canvas = canvas;
    this.back = paperColor();
    this.emitters = [];
    this.pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, has: false, moved: false };
    this.downPos = null;
    this.downAt = 0;
    this.raf = 0;
    this.lastTime = 0;
    this.quietAt = 0;
    this.fastFade = false;
    this.frameBound = (now) => this.frame(now);

    stage.prepend(canvas);
    this.resize();

    document.addEventListener("akinen:tone", (e) => this.onTone(e.detail), { signal });
    document.addEventListener(
      "akinen:ambient-state",
      (e) => {
        // サウンド OFF では新しい音が来ないので、残ったインクを早めに引かせる
        if (!e.detail.on) this.fastFade = true;
      },
      { signal }
    );
    stage.addEventListener("pointermove", (e) => this.onMove(e), { signal });
    stage.addEventListener("pointerdown", (e) => this.onDown(e), { signal });
    stage.addEventListener("pointerleave", () => (this.pointer.has = false), { signal });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(stage);
    signal.addEventListener("abort", () => {
      this.ro.disconnect();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    });
  }

  /* -- フレームバッファ -- */

  createFBO(w, h, fmt, filter) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, this.halfFloatType, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture,
      fbo,
      w,
      h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      attach: (id) => {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }
    };
  }

  destroyFBO(f) {
    if (!f) return;
    this.gl.deleteTexture(f.texture);
    this.gl.deleteFramebuffer(f.fbo);
  }

  createDoubleFBO(w, h, fmt, filter) {
    let a = this.createFBO(w, h, fmt, filter);
    let b = this.createFBO(w, h, fmt, filter);
    return {
      get read() {
        return a;
      },
      get write() {
        return b;
      },
      swap() {
        const t = a;
        a = b;
        b = t;
      },
      destroy: () => {
        this.destroyFBO(a);
        this.destroyFBO(b);
      }
    };
  }

  getResolution(base) {
    const aspect = this.canvas.width / this.canvas.height;
    const max = Math.round(base * Math.max(aspect, 1 / aspect));
    return aspect > 1 ? { w: max, h: base } : { w: base, h: max };
  }

  initFramebuffers() {
    const gl = this.gl;
    const simRes = this.getResolution(SIM_RES);
    const dyeRes = this.getResolution(DYE_RES);
    const filter = this.linear ? gl.LINEAR : gl.NEAREST;
    this.velocity?.destroy();
    this.dye?.destroy();
    this.pressure?.destroy();
    this.destroyFBO(this.divergence);
    this.destroyFBO(this.curlTex);
    this.velocity = this.createDoubleFBO(simRes.w, simRes.h, this.formats.rg, filter);
    this.dye = this.createDoubleFBO(dyeRes.w, dyeRes.h, this.formats.rgba, filter);
    this.pressure = this.createDoubleFBO(simRes.w, simRes.h, this.formats.r, gl.NEAREST);
    this.divergence = this.createFBO(simRes.w, simRes.h, this.formats.r, gl.NEAREST);
    this.curlTex = this.createFBO(simRes.w, simRes.h, this.formats.r, gl.NEAREST);
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w === this.canvas.width && h === this.canvas.height && this.dye) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.initFramebuffers();
    this.render();
  }

  /* -- 描画パス -- */

  blit(target) {
    const gl = this.gl;
    if (target) {
      gl.viewport(0, 0, target.w, target.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  splat(target, x, y, color, radius) {
    const gl = this.gl;
    const p = this.programs.splat;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, target.read.texelSizeX, target.read.texelSizeY);
    gl.uniform1i(p.u.uTarget, target.read.attach(0));
    gl.uniform1f(p.u.uAspect, this.canvas.width / this.canvas.height);
    gl.uniform2f(p.u.uPoint, x, y);
    gl.uniform3f(p.u.uColor, color[0], color[1], color[2]);
    gl.uniform1f(p.u.uRadius, radius);
    this.blit(target.write);
    target.swap();
  }

  step(dt) {
    const gl = this.gl;
    const P = this.programs;
    const v = this.velocity;
    const simX = v.read.texelSizeX;
    const simY = v.read.texelSizeY;

    let p = P.curl;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform1i(p.u.uVelocity, v.read.attach(0));
    this.blit(this.curlTex);

    p = P.vorticity;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform1i(p.u.uVelocity, v.read.attach(0));
    gl.uniform1i(p.u.uCurl, this.curlTex.attach(1));
    gl.uniform1f(p.u.uCurlStrength, CURL_STRENGTH);
    gl.uniform1f(p.u.dt, dt);
    this.blit(v.write);
    v.swap();

    p = P.divergence;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform1i(p.u.uVelocity, v.read.attach(0));
    this.blit(this.divergence);

    p = P.clear;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform1i(p.u.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(p.u.uValue, 0.8);
    this.blit(this.pressure.write);
    this.pressure.swap();

    p = P.pressure;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform1i(p.u.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < PRESSURE_ITERS; i++) {
      gl.uniform1i(p.u.uPressure, this.pressure.read.attach(1));
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    p = P.gradient;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform1i(p.u.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(p.u.uVelocity, v.read.attach(1));
    this.blit(v.write);
    v.swap();

    p = P.advection;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, simX, simY);
    gl.uniform2f(p.u.dyeTexelSize, simX, simY);
    const velId = v.read.attach(0);
    gl.uniform1i(p.u.uVelocity, velId);
    gl.uniform1i(p.u.uSource, velId);
    gl.uniform1f(p.u.dt, dt);
    gl.uniform1f(p.u.uDissipation, VEL_DISSIPATION);
    this.blit(v.write);
    v.swap();

    gl.uniform2f(p.u.dyeTexelSize, this.dye.read.texelSizeX, this.dye.read.texelSizeY);
    gl.uniform1i(p.u.uVelocity, v.read.attach(0));
    gl.uniform1i(p.u.uSource, this.dye.read.attach(1));
    gl.uniform1f(p.u.uDissipation, this.fastFade ? DYE_DISSIPATION_FAST : DYE_DISSIPATION);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  render() {
    const gl = this.gl;
    const p = this.programs.display;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.texelSize, this.dye.read.texelSizeX, this.dye.read.texelSizeY);
    gl.uniform1i(p.u.uDye, this.dye.read.attach(0));
    gl.uniform3f(p.u.uBack, this.back[0], this.back[1], this.back[2]);
    this.blit(null);
  }

  clearAll() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    [
      this.velocity.read,
      this.velocity.write,
      this.dye.read,
      this.dye.write,
      this.pressure.read,
      this.pressure.write,
      this.divergence,
      this.curlTex
    ].forEach((f) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    this.emitters = [];
  }

  /* -- 入力 -- */

  toUv(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height
    };
  }

  onMove(e) {
    const { x, y } = this.toUv(e);
    const pt = this.pointer;
    if (pt.has) {
      pt.dx += x - pt.x;
      pt.dy += y - pt.y;
      pt.moved = true;
    }
    pt.x = x;
    pt.y = y;
    pt.has = true;
    if (pt.moved) this.wake();
  }

  onDown(e) {
    // クリック位置を覚えておき、直後に鳴った音のインクをそこへ落とす
    this.downPos = this.toUv(e);
    this.downAt = performance.now();
    this.wake();
  }

  onTone(detail) {
    if (!this.canvas.isConnected) return;
    this.fastFade = false;
    const now = performance.now();
    const t = clamp((detail.midi - NOTE_MIN) / (NOTE_MAX - NOTE_MIN), 0, 1);
    const intensity = clamp(detail.peak / 0.05, 0.45, 1.4);

    let x;
    let y;
    if (this.downPos && now - this.downAt < 600) {
      x = this.downPos.x + (Math.random() - 0.5) * 0.08;
      y = this.downPos.y + (Math.random() - 0.5) * 0.08;
    } else {
      // クリック由来でない音（アイドル発音など）はパンを水平位置に写す
      x = 0.5 + (detail.pan ?? 0) * 0.55 + (Math.random() - 0.5) * 0.12;
      y = 0.24 + Math.random() * 0.52;
    }

    const rUv = 0.035 + (1 - t) * 0.05; // 低い音ほど大きな滴
    const attack = Math.max(0.15, detail.attack);
    const tau = Math.max(0.4, detail.release / 3);
    this.emitters.push({
      x: clamp(x, 0.06, 0.94),
      y: clamp(y, 0.08, 0.92),
      t0: now,
      attack,
      tau,
      rad2: rUv * rUv,
      color: INK_DEEP.map((d, i) => (d + (INK_PALE[i] - d) * t) * intensity),
      // エンベロープ積分（attack/2 + tau）で割り、音量によらず
      // 1音の総吸光度が EMIT_SATURATION 程度に揃うようにする
      gain: EMIT_SATURATION / (attack / 2 + tau),
      angle: Math.random() * Math.PI * 2,
      kick: 8 + 18 * intensity,
      kicked: false
    });
    if (this.emitters.length > 14) this.emitters.shift();
    this.wake();
  }

  wake() {
    this.quietAt = performance.now() + QUIET_TAIL_MS;
    if (!this.raf) {
      this.lastTime = performance.now();
      this.raf = requestAnimationFrame(this.frameBound);
    }
  }

  applyInputs(now, dt) {
    const pt = this.pointer;
    if (pt.moved) {
      pt.moved = false;
      this.splat(this.velocity, pt.x, pt.y, [pt.dx * MOUSE_FORCE, pt.dy * MOUSE_FORCE, 0], MOUSE_RADIUS);
      pt.dx = 0;
      pt.dy = 0;
    }

    // ごく弱い環流をゆっくり回遊させ、静かな時間もインクが漂うようにする
    const tt = now * 0.00008;
    const cx = 0.5 + 0.34 * Math.sin(tt * 1.3 + 1.7);
    const cy = 0.5 + 0.3 * Math.sin(tt * 0.9 + 4.2);
    const vx = Math.cos(tt * 1.3 + 1.7);
    const vy = Math.cos(tt * 0.9 + 4.2);
    const len = Math.hypot(vx, vy) || 1;
    this.splat(this.velocity, cx, cy, [(vx / len) * CURRENT_FORCE, (vy / len) * CURRENT_FORCE, 0], 0.02);

    const aspect = this.canvas.width / this.canvas.height;
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      const age = (now - e.t0) / 1000;
      const env = age < e.attack ? age / e.attack : Math.exp(-(age - e.attack) / e.tau);
      if (age > e.attack && env < 0.004) {
        this.emitters.splice(i, 1);
        continue;
      }
      if (!e.kicked) {
        // 滴が落ちた瞬間のひと押し（ランダム方向）で滲みを非対称にする
        e.kicked = true;
        this.splat(
          this.velocity,
          e.x,
          e.y,
          [Math.cos(e.angle) * e.kick, Math.sin(e.angle) * e.kick, 0],
          e.rad2 * 2
        );
      }
      const amt = env * e.gain * dt;
      this.splat(this.dye, e.x, e.y, [e.color[0] * amt, e.color[1] * amt, e.color[2] * amt], e.rad2);

      // 回転する2点で外向きに押し出し、インクをじわじわ滲ませる
      const r = Math.sqrt(e.rad2);
      for (let k = 0; k < 2; k++) {
        const a = e.angle + age * 1.9 + k * Math.PI + Math.sin(age * 2.3 + e.angle) * 0.8;
        const ox = Math.cos(a);
        const oy = Math.sin(a);
        this.splat(
          this.velocity,
          e.x + (ox * r * 0.55) / aspect,
          e.y + oy * r * 0.55,
          [ox * BLEED_FORCE * env, oy * BLEED_FORCE * env, 0],
          e.rad2 * 0.6
        );
      }
      this.quietAt = now + QUIET_TAIL_MS;
    }
  }

  frame(now) {
    if (!this.canvas.isConnected) {
      this.raf = 0;
      return;
    }
    const dt = clamp((now - this.lastTime) / 1000, 1 / 240, 1 / 30);
    this.lastTime = now;
    this.applyInputs(now, dt);
    this.step(dt);
    this.render();
    if (now > this.quietAt && !this.emitters.length) {
      // 完全に静まったらフィールドを空にして停止（真っ白な水面へ）
      this.raf = 0;
      this.clearAll();
      this.render();
      return;
    }
    this.raf = requestAnimationFrame(this.frameBound);
  }
}

/* ---- ページ側の付帯 UI --------------------------------------------- */

// サウンド OFF のときだけ中央に案内と ON ボタンを出す
function initHint(stage, signal) {
  const hint = stage.querySelector("[data-sound-hint]");
  const btn = stage.querySelector("[data-sound-on]");
  if (!hint || !btn) return;

  const sync = (on) => hint.classList.toggle("is-hidden", on);
  sync(readChoice() === "on");
  document.addEventListener("akinen:ambient-state", (e) => sync(e.detail.on), { signal });

  btn.addEventListener(
    "click",
    () => {
      saveChoice("on");
      enableAmbient({ greet: true });
      // サイドバー／モバイルのトグル表示も追従させる
      document
        .querySelectorAll("[data-sound-switch]")
        .forEach((b) => b.setAttribute("aria-pressed", "true"));
    },
    { signal }
  );
}

// しばらく操作がないと UI（サイドバー・ステートメント）を退場させ、
// 水面だけを残す（展示モード）。操作があれば戻る
function initIdleFade(stage, signal) {
  let timer = 0;
  const idle = () => {
    if (stage.isConnected) document.body.classList.add("sound-ui-idle");
  };
  const wake = () => {
    clearTimeout(timer);
    if (!stage.isConnected) return;
    document.body.classList.remove("sound-ui-idle");
    timer = setTimeout(idle, UI_IDLE_MS);
  };
  ["pointermove", "pointerdown", "keydown"].forEach((type) =>
    window.addEventListener(type, wake, { signal, passive: true })
  );
  wake();
}

export function initSoundInk() {
  const stage = document.querySelector("[data-sound-ink]");
  if (!(stage instanceof HTMLElement) || stage.dataset.inkBound) return;
  stage.dataset.inkBound = "true";

  const controller = new AbortController();
  // View Transitions でページを離れたら（stage が外れたら）すべて解除する
  document.addEventListener(
    "astro:after-swap",
    () => {
      if (!stage.isConnected) controller.abort();
    },
    { signal: controller.signal }
  );

  initHint(stage, controller.signal);
  initIdleFade(stage, controller.signal);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    stage.classList.add("is-static");
    return;
  }
  try {
    new SoundInk(stage, controller.signal);
  } catch {
    // WebGL が使えない環境では白いページとステートメントのみ残る
    stage.classList.add("is-static");
  }
}
