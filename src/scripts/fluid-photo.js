// 写真・スナップショットの流体ディストーション。
// ポインタの動きを低解像度フローマップ（ピンポンFBO）に描き込み、
// 毎フレーム減衰させながらテクスチャのUVを歪ませる。何もしなければ
// フローがゼロへ戻り、元の見た目に復帰する。
// ソースは <img> のほか、事前描画済み <canvas>（hero-fluid.js）も受け付ける。
// WebGL が使えない環境・reduced-motion 環境では元のDOMがそのまま残る。

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// フローマップ更新。RG に速度を 0..1 へエンコードして保持する。
// 8bit 量子化で減衰しきらない残差は epsilon 減算で確実にゼロへ戻す。
const FLOW_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFlow;
uniform vec2 uMouse;
uniform vec2 uVelocity;
uniform float uAspect;
uniform float uFalloff;
uniform float uDissipation;
uniform float uClick;
void main() {
  vec2 flow = texture2D(uFlow, vUv).rg * 2.0 - 1.0;
  flow *= uDissipation;
  flow = sign(flow) * max(abs(flow) - 0.004, 0.0);
  vec2 d = vUv - uMouse;
  d.x *= uAspect;
  float g = exp(-dot(d, d) / uFalloff);
  flow += uVelocity * g;
  /* クリック時：中心から放射状に押し出すインパルス（水面のぽちゃん） */
  flow += (d / max(length(d), 0.001)) * g * uClick;
  flow = clamp(flow, -1.0, 1.0);
  gl_FragColor = vec4(flow * 0.5 + 0.5, 0.0, 1.0);
}
`;

// 表示。フローで画像UVをずらし、RGBをわずかに分離して液体感を出す。
// uSpread は色分離の量（1で従来どおり、0で虹色なしの純粋な歪みのみ）。
const DRAW_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uFlow;
uniform vec2 uCover;
uniform float uStrength;
uniform float uSpread;
void main() {
  vec2 flow = texture2D(uFlow, vUv).rg * 2.0 - 1.0;
  vec2 uv = (vUv - 0.5) * uCover + 0.5;
  vec2 off = flow * uStrength;
  float r = texture2D(uImage, uv - off * (1.0 + 0.15 * uSpread)).r;
  float g = texture2D(uImage, uv - off).g;
  float b = texture2D(uImage, uv - off * (1.0 - 0.12 * uSpread)).b;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

const compile = (gl, type, src) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
  }
  return shader;
};

const createProgram = (gl, fragSrc, uniformNames) => {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
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

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// テクスチャ用に2Dキャンバスへラスタライズしてから取り込む。
// SVGサムネイルの鮮明なラスタライズとブラウザ間の互換性を兼ねる。
const rasterize = (img) => {
  const ratio = img.naturalWidth / img.naturalHeight;
  const w = Math.min(1600, img.naturalWidth || 1600);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = Math.round(w / ratio);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
};

export class FluidPhoto {
  constructor(figure, source, opts = {}) {
    this.figure = figure;
    // falloff: ブラシ半径（UV²・小さいほど狭い） / dissipation: 減衰（1に近いほど残る）
    // strength: UV変位量 / velocity: ポインタ速度の注入係数 / spread: RGB分離量（0で虹色なし）
    this.opts = {
      falloff: 0.02,
      dissipation: 0.93,
      strength: 0.085,
      velocity: 12,
      spread: 1,
      ...opts
    };

    const canvas = document.createElement("canvas");
    canvas.className = "fluid-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false
    });
    if (!gl) return;
    this.canvas = canvas;
    this.gl = gl;

    // フルスクリーントライアングル
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.flowProg = createProgram(gl, FLOW_FRAG, [
      "uFlow",
      "uMouse",
      "uVelocity",
      "uAspect",
      "uFalloff",
      "uDissipation",
      "uClick"
    ]);
    this.drawProg = createProgram(gl, DRAW_FRAG, ["uImage", "uFlow", "uCover", "uStrength", "uSpread"]);

    this.imgTex = this.createTexture();
    this.uploadSource(source);

    this.fbos = null;
    this.mouse = { x: 0.5, y: 0.5 };
    this.velo = { x: 0, y: 0 };
    this.last = null;
    this.energy = 0;
    this.raf = 0;
    this.click = 0;

    figure.appendChild(canvas);
    figure.classList.add("has-fluid");
    this.resize();

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    figure.addEventListener("pointermove", (e) => this.onMove(e));
    figure.addEventListener("pointerdown", (e) => this.onDown(e));
    figure.addEventListener("pointerleave", () => {
      this.last = null;
    });
    new ResizeObserver(() => this.resize()).observe(figure);
  }

  uploadSource(source) {
    const gl = this.gl;
    this.srcW = source.naturalWidth || source.width;
    this.srcH = source.naturalHeight || source.height;
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source instanceof HTMLImageElement ? rasterize(source) : source
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  // ソース差し替え（heroのリサイズ再スナップショットなど）
  setSource(source) {
    this.uploadSource(source);
    this.draw();
  }

  createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  createFbo(w, h) {
    const gl = this.gl;
    const tex = this.createTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }

  clearFlow() {
    const gl = this.gl;
    gl.clearColor(0.5, 0.5, 0.0, 1.0);
    this.fbos.forEach((f) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
  }

  resize() {
    const rect = this.figure.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);

    const scale = 144 / Math.max(rect.width, rect.height);
    this.flowW = Math.max(16, Math.round(rect.width * scale));
    this.flowH = Math.max(16, Math.round(rect.height * scale));
    if (this.fbos) {
      this.fbos.forEach((f) => {
        gl.deleteTexture(f.tex);
        gl.deleteFramebuffer(f.fb);
      });
    }
    this.fbos = [this.createFbo(this.flowW, this.flowH), this.createFbo(this.flowW, this.flowH)];
    this.clearFlow();
    this.draw();
  }

  onMove(e) {
    const rect = this.figure.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    if (this.last) {
      this.velo.x += (x - this.last.x) * this.opts.velocity;
      this.velo.y += (y - this.last.y) * this.opts.velocity;
    }
    this.last = { x, y };
    this.mouse = { x, y };
    this.energy = 1;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  onDown(e) {
    const rect = this.figure.getBoundingClientRect();
    this.mouse = {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height
    };
    this.click = 0.55;
    this.energy = 1;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  update() {
    const gl = this.gl;
    const [src, dst] = this.fbos;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, this.flowW, this.flowH);
    const { prog, u } = this.flowProg;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(u.uFlow, 0);
    gl.uniform2f(u.uMouse, this.mouse.x, this.mouse.y);
    gl.uniform2f(u.uVelocity, clamp(this.velo.x, -1, 1), clamp(this.velo.y, -1, 1));
    gl.uniform1f(u.uAspect, this.canvas.width / this.canvas.height);
    gl.uniform1f(u.uFalloff, this.opts.falloff);
    gl.uniform1f(u.uDissipation, this.opts.dissipation);
    gl.uniform1f(u.uClick, this.click);
    this.click = 0;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.fbos.reverse();
  }

  draw() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const { prog, u } = this.drawProg;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
    gl.uniform1i(u.uImage, 0);
    gl.uniform1i(u.uFlow, 1);
    const ca = this.canvas.width / this.canvas.height;
    const ia = this.srcW / this.srcH;
    const cover = ca > ia ? [1, ia / ca] : [ca / ia, 1];
    gl.uniform2f(u.uCover, cover[0], cover[1]);
    gl.uniform1f(u.uStrength, this.opts.strength);
    gl.uniform1f(u.uSpread, this.opts.spread);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  frame() {
    // View Transitions などで要素が外れたらループを止める
    if (!this.canvas.isConnected) {
      this.raf = 0;
      return;
    }
    this.update();
    this.draw();
    this.velo.x = 0;
    this.velo.y = 0;
    this.energy *= 0.96;
    if (this.energy > 0.003) {
      this.raf = requestAnimationFrame(() => this.frame());
    } else {
      // 静止したらフローを完全にゼロへ戻して停止（アイドル時のGPU負荷ゼロ）
      this.raf = 0;
      this.clearFlow();
      this.draw();
    }
  }
}

export const initFluidPhotos = (selector = ".xp-photo") => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll(selector).forEach((figure) => {
    if (!(figure instanceof HTMLElement) || figure.dataset.fluidBound) return;
    figure.dataset.fluidBound = "true";
    const img = figure.querySelector("img");
    if (!img) return;
    const start = () => {
      try {
        new FluidPhoto(figure, img);
      } catch {
        // WebGL 初期化に失敗しても <img> がそのまま表示される
      }
    };
    if (img.complete && img.naturalWidth) start();
    else img.addEventListener("load", start, { once: true });
  });
};
