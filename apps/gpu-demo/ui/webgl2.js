'use strict';
// The WebGL2 fallback, used when navigator.gpu is missing, no adapter is found, or WebGPU fails: the same physics as the WebGPU
// compute shader, run as a vertex shader with transform feedback (ping-pong buffers), and the same additive drawing with trails
// into a half-float framebuffer when the browser can render to one. Classic script; exposes window.WebGl2Renderer.

(() => {
  const MAX = window.P3D.MAX_PARTICLES;

  const UPDATE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aPL; // pos.xyz, life
layout(location = 1) in vec4 aVS; // vel.xyz, seed
uniform vec4 uAttr[9];
uniform int uN;
uniform float uDt;
uniform float uTime;
uniform float uG;
uniform float uDrag;
uniform float uSwirl;
uniform float uNoise;
uniform uint uFrame;
out vec4 vPL;
out vec4 vVS;

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd(uint v) { return float(pcg(v)) * (1.0 / 4294967296.0); }

void main() {
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
  uint i = uint(gl_VertexID);
  vec3 pos = aPL.xyz;
  float life = aPL.w;
  vec3 vel = aVS.xyz;
  float seed = aVS.w;
  if (life <= 0.0 || dot(pos, pos) > 36.0 || pos.x != pos.x) {
    uint k = i * 5u + uFrame * 2654435761u;
    float z = rnd(k) * 2.0 - 1.0;
    float phi = rnd(k + 1u) * 6.2831853;
    float rad = 0.15 + 0.85 * pow(rnd(k + 2u), 0.3333);
    float s = sqrt(max(0.0, 1.0 - z * z));
    pos = vec3(s * cos(phi), z * 0.3, s * sin(phi)) * rad;
    vel = cross(vec3(0.0, 1.0, 0.0), pos) * 0.8;
    life = 3.0 + 9.0 * rnd(k + 3u);
    seed = rnd(k + 4u);
  } else {
    vec3 a = vec3(0.0);
    for (int k = 0; k < 9; k++) {
      if (k >= uN) break;
      vec4 A = uAttr[k];
      vec3 d = A.xyz - pos;
      float r2 = dot(d, d) + 0.004;
      float inv = inversesqrt(r2);
      float inv3 = inv * inv * inv;
      a += d * (A.w * uG * inv3);
      a += cross(vec3(0.0, 1.0, 0.0), d) * (A.w * uSwirl * uG * inv3);
    }
    vec3 q = pos * 2.3 + vec3(uTime * 0.31, uTime * 0.23, uTime * 0.17);
    a += vec3(sin(q.y + 1.7 * sin(q.z)), sin(q.z + 1.3 * sin(q.x)), sin(q.x + 1.1 * sin(q.y))) * (uNoise * 2.0);
    a -= pos * vec3(0.4, 1.2, 0.4); // a soft, flattened well around the origin keeps the cloud in view and gives it a disc
    float am = length(a);
    if (am > 40.0) a = a * (40.0 / am);
    vel = (vel + a * uDt) * exp(-uDrag * uDt);
    float vm = length(vel);
    if (vm > 4.0) vel = vel * (4.0 / vm);
    pos = pos + vel * uDt;
    life = life - uDt;
  }
  vPL = vec4(pos, life);
  vVS = vec4(vel, seed);
}`;

  const UPDATE_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

  const DRAW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPL;
layout(location = 1) in vec4 aVS;
uniform mat4 uVP;
uniform float uSize;
uniform float uHue;
uniform float uExposure;
out vec3 vCol;
// hue wheel at 80% saturation (no dark gaps like a cosine palette has)
vec3 palette(float h) {
  vec3 p = abs(fract(vec3(h) + vec3(1.0, 0.6666667, 0.3333333)) * 6.0 - 3.0);
  return mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), 0.8);
}
void main() {
  float size = max(uSize, 2.0);
  float area = (uSize / size) * (uSize / size);
  gl_Position = uVP * vec4(aPL.xyz, 1.0);
  gl_PointSize = size;
  float t = clamp(length(aVS.xyz) * 0.35, 0.0, 1.0);
  vCol = mix(palette(uHue + 0.3 * aVS.w + 0.35 * t), vec3(1.0), 0.15 + 0.35 * t) * (0.4 + 1.2 * t) * uExposure * area;
}`;

  const DRAW_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  float a = 1.0 - smoothstep(0.0, 1.0, r);
  o = vec4(vCol * a, 1.0);
}`;

  const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, uFade); }`;

  const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec3 c = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb;
  vec2 uv = gl_FragCoord.xy / uRes - vec2(0.5);
  vec3 bg = vec3(0.010, 0.014, 0.032) * (1.0 - dot(uv, uv) * 1.2);
  vec3 m = vec3(1.0) - exp(-c * 1.3);
  o = vec4(clamp(bg + m * (vec3(1.0) - bg), 0.0, 1.0), 1.0);
}`;

  function compile(gl, type, src, label) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${label}: ${gl.getShaderInfoLog(s)}`);
    return s;
  }

  function program(gl, vs, fs, label, varyings) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, `${label} vertex shader`));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, `${label} fragment shader`));
    if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.SEPARATE_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${label}: ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms };
  }

  class WebGl2Renderer {
    /** Returns a renderer, or throws an Error whose message says why WebGL2 cannot be used. */
    static create(canvas) {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('canvas.getContext("webgl2") returned null');
      return new WebGl2Renderer(canvas, gl);
    }

    constructor(canvas, gl) {
      this.canvas = canvas;
      this.gl = gl;
      this.api = 'webgl2';
      this.error = null;
      this.lostReason = null;
      this.onLost = null;
      this.gpuMs = null;
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lostReason = 'WebGL context lost';
        if (this.onLost) this.onLost(this.lostReason);
      });
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const floatExt = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
      this.halfFloat = !!floatExt;
      this.info = {
        api: 'webgl2',
        vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
        renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
        version: String(gl.getParameter(gl.VERSION)),
        glsl: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
        trails: this.halfFloat ? 'RGBA16F framebuffer' : 'RGBA8 framebuffer (no half-float rendering: trails are coarser)',
        limits: { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), pointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)) },
      };

      this.upd = program(gl, UPDATE_VS, UPDATE_FS, 'update', ['vPL', 'vVS']);
      this.draw = program(gl, DRAW_VS, DRAW_FS, 'draw');
      this.fade = program(gl, FULL_VS, FADE_FS, 'fade');
      this.blit = program(gl, FULL_VS, BLIT_FS, 'blit');

      this.pl = [gl.createBuffer(), gl.createBuffer()];
      this.vs = [gl.createBuffer(), gl.createBuffer()];
      this.vao = [gl.createVertexArray(), gl.createVertexArray()];
      for (let k = 0; k < 2; k++) {
        for (const b of [this.pl[k], this.vs[k]]) {
          gl.bindBuffer(gl.ARRAY_BUFFER, b);
          gl.bufferData(gl.ARRAY_BUFFER, MAX * 16, gl.DYNAMIC_COPY); // zero-filled: life 0, so every particle spawns on the first step
        }
        gl.bindVertexArray(this.vao[k]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pl[k]);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vs[k]);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
      }
      gl.bindVertexArray(null);
      // the global ARRAY_BUFFER binding must not keep pointing at a buffer that is later a transform-feedback target
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.tf = gl.createTransformFeedback();
      this.emptyVao = gl.createVertexArray();
      this.cur = 0;
      this.frameNo = 0;
      this.width = 0;
      this.height = 0;
      this.tex = null;
      this.fbo = gl.createFramebuffer();
      this.resize(Math.max(1, canvas.width), Math.max(1, canvas.height));
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`WebGL error 0x${err.toString(16)} while setting up`);
    }

    resize(w, h) {
      const gl = this.gl;
      if (w === this.width && h === this.height && this.tex) return;
      this.width = w;
      this.height = h;
      if (this.tex) gl.deleteTexture(this.tex);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.halfFloat ? gl.RGBA16F : gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`the accumulation framebuffer is incomplete (0x${st.toString(16)})`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.clearNext = true;
    }

    /** Simulates, draws into the accumulation framebuffer, tone-maps to the canvas. */
    frame(s) {
      const gl = this.gl;
      this.frameNo++;

      // ---- update (transform feedback) ----
      const src = this.cur;
      const dst = 1 - src;
      const U = this.upd.u;
      gl.useProgram(this.upd.p);
      gl.uniform4fv(U.uAttr, s.attr);
      gl.uniform1i(U.uN, s.nAttr);
      gl.uniform1f(U.uDt, s.dt);
      gl.uniform1f(U.uTime, s.time);
      gl.uniform1f(U.uG, s.G);
      gl.uniform1f(U.uDrag, s.drag);
      gl.uniform1f(U.uSwirl, s.swirl);
      gl.uniform1f(U.uNoise, s.noise);
      gl.uniform1ui(U.uFrame, this.frameNo >>> 0);
      gl.bindVertexArray(this.vao[src]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.pl[dst]);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.vs[dst]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, s.count);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      this.cur = dst;

      // ---- draw into the accumulation framebuffer ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.width, this.height);
      const clear = this.clearNext || s.fade >= 0.999;
      this.clearNext = false;
      if (clear) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.fade.p);
        gl.uniform1f(this.fade.u.uFade, s.fade);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.draw.p);
      gl.uniformMatrix4fv(this.draw.u.uVP, false, s.viewProj);
      gl.uniform1f(this.draw.u.uSize, s.pointSize);
      gl.uniform1f(this.draw.u.uHue, s.hue);
      gl.uniform1f(this.draw.u.uExposure, s.exposure);
      gl.bindVertexArray(this.vao[this.cur]);
      gl.drawArrays(gl.POINTS, 0, s.count);

      // ---- tone-map to the canvas ----
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(this.blit.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.blit.u.uAccum, 0);
      gl.uniform2f(this.blit.u.uRes, this.width, this.height);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Runs `frames` frames back to back (not tied to the display's refresh) and reports how long the GPU took. */
    async benchmark(frames, makeState) {
      for (let i = 0; i < 4; i++) this.frame(makeState(i));
      this._sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        this.frame(makeState(i));
        if (i % 8 === 7) this._sync();
      }
      this._sync();
      return performance.now() - t0;
    }

    /** Waits for the GPU to finish everything submitted so far. gl.finish() does not do that in Chromium (it only flushes); a pixel read-back does. */
    _sync() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel || (this.pixel = new Uint8Array(4)));
    }

    destroy() {
      try {
        const ext = this.gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch {
        /* already gone */
      }
    }
  }

  window.WebGl2Renderer = WebGl2Renderer;
})();
