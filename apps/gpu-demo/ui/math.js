'use strict';
// Small matrix and camera helpers shared by the WebGPU and WebGL2 renderers. Column-major Float32Arrays.
// Loaded as a classic script (the CSP allows script-src 'self' only); everything hangs off window.P3D.

(() => {
  const FOV_Y = (50 * Math.PI) / 180;

  /** Right-handed perspective matrix. `zeroToOne` selects WebGPU clip depth [0,1] instead of WebGL's [-1,1]. */
  function perspective(aspect, near, far, zeroToOne) {
    const f = 1 / Math.tan(FOV_Y / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[11] = -1;
    if (zeroToOne) {
      m[10] = far / (near - far);
      m[14] = (far * near) / (near - far);
    } else {
      m[10] = (far + near) / (near - far);
      m[14] = (2 * far * near) / (near - far);
    }
    return m;
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };

  /** An orbit camera looking at the origin: the eye and the orthonormal basis (right, up, forward). */
  function basis(yaw, pitch, dist) {
    const eye = [dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)];
    const forward = norm([-eye[0], -eye[1], -eye[2]]);
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    return { eye, forward, right, up };
  }

  function lookAt(b) {
    const { eye, forward, right, up } = b;
    const m = new Float32Array(16);
    m[0] = right[0];
    m[4] = right[1];
    m[8] = right[2];
    m[12] = -dot(right, eye);
    m[1] = up[0];
    m[5] = up[1];
    m[9] = up[2];
    m[13] = -dot(up, eye);
    m[2] = -forward[0];
    m[6] = -forward[1];
    m[10] = -forward[2];
    m[14] = dot(forward, eye);
    m[15] = 1;
    return m;
  }

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
    return o;
  }

  /** View-projection matrix of the orbit camera. */
  function viewProj(aspect, yaw, pitch, dist, zeroToOne) {
    return mul(perspective(aspect, 0.05, 30, zeroToOne), lookAt(basis(yaw, pitch, dist)));
  }

  /** The point on the plane through the origin that faces the camera, under the pointer (nx, ny in -1..1, y up). */
  function pointerToWorld(nx, ny, aspect, yaw, pitch, dist) {
    const b = basis(yaw, pitch, dist);
    const t = Math.tan(FOV_Y / 2);
    const dir = [
      b.forward[0] + nx * t * aspect * b.right[0] + ny * t * b.up[0],
      b.forward[1] + nx * t * aspect * b.right[1] + ny * t * b.up[1],
      b.forward[2] + nx * t * aspect * b.right[2] + ny * t * b.up[2],
    ];
    // dot(dir, forward) is exactly 1 (right and up are perpendicular to forward), and dot(-eye, forward) = dist
    return [b.eye[0] + dir[0] * dist, b.eye[1] + dir[1] * dist, b.eye[2] + dir[2] * dist];
  }

  window.P3D = { viewProj, pointerToWorld, basis, sub, norm, MAX_PARTICLES: 2000000, MAX_ATTRACTORS: 9 };
})();
