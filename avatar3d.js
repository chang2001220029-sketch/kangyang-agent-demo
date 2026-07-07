/* =====================================================================
 * 乐颐 · 3D 写实数字人 (Three.js + facecap 面部 blendshape)
 * 以 ES 模块加载，成功后把控制接口挂到 window.__leyi3d 供 app.js 调用。
 * 失败(无 WebGL / 加载错误)则不设置 loaded，app.js 自动回退到 SVG 数字人。
 * ===================================================================== */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const API = {
  loaded: false,
  failed: false,
  setMood: function () {}, startTalk: function () {}, stopTalk: function () {}, pulse: function () {}
};
window.__leyi3d = API;

(function init() {
  const canvas = document.getElementById("avatar3d");
  if (!canvas) { API.failed = true; return; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  } catch (e) { console.warn("[3D] WebGL 初始化失败，回退 SVG", e); API.failed = true; return; }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

  // 灯光：暖色主光 + 柔补光 + 冷轮廓光，营造自然肤质
  scene.add(new THREE.HemisphereLight(0xfff0e0, 0x40382f, 1.15));
  const key = new THREE.DirectionalLight(0xfff1e0, 1.9); key.position.set(1.2, 1.5, 2.4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55); fill.position.set(-2, 0.4, 1.4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xbfe0ff, 0.85); rim.position.set(-0.6, 1.3, -2.6); scene.add(rim);

  const group = new THREE.Group(); scene.add(group);

  // 追踪的 morph 目标：mesh -> {name: index}
  const morphMeshes = [];
  function forEachMorph(name, fn) {
    for (const m of morphMeshes) {
      const idx = m.dict[name];
      if (idx !== undefined) fn(m.mesh.morphTargetInfluences, idx);
    }
  }
  function setMorph(name, v) { forEachMorph(name, function (inf, idx) { inf[idx] = v; }); }
  function lerpMorph(name, target, k) { forEachMorph(name, function (inf, idx) { inf[idx] += (target - inf[idx]) * k; }); }

  // ---- 状态 ----
  let mood = "calm";
  let talking = false;
  let pulseVal = 0;
  let baseRotY = 0, baseRotX = 0;
  const clock = new THREE.Clock();

  const MOODS = {
    calm:    { mouthSmile_L: 0.2, mouthSmile_R: 0.2, cheekSquint_L: 0.1, cheekSquint_R: 0.1 },
    happy:   { mouthSmile_L: 0.5, mouthSmile_R: 0.5, cheekSquint_L: 0.35, cheekSquint_R: 0.35, browInnerUp: 0.12 },
    care:    { mouthSmile_L: 0.18, mouthSmile_R: 0.18, browInnerUp: 0.4 },
    serious: { browDown_L: 0.32, browDown_R: 0.32, mouthPress_L: 0.16, mouthPress_R: 0.16 },
    think:   { browInnerUp: 0.22, eyeLookUp_L: 0.3, eyeLookUp_R: 0.3, mouthPucker: 0.12 }
  };
  const MOOD_KEYS = ["mouthSmile_L", "mouthSmile_R", "cheekSquint_L", "cheekSquint_R", "browInnerUp",
    "browDown_L", "browDown_R", "mouthPress_L", "mouthPress_R", "eyeLookUp_L", "eyeLookUp_R", "mouthPucker"];

  // 眨眼状态机
  let nextBlink = 1.5, blinkStart = -1;

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // 头部自然微动
    group.rotation.y = baseRotY + Math.sin(t * 0.55) * 0.05;
    group.rotation.x = baseRotX + Math.sin(t * 0.9) * 0.018;

    // 情绪表情（平滑趋近）
    const mt = MOODS[mood] || MOODS.calm;
    for (const k of MOOD_KEYS) lerpMorph(k, mt[k] || 0, 0.12);

    // 口型
    let jaw = 0, funnel = 0, lowerL = 0, lowerR = 0;
    if (talking) {
      jaw = 0.10 + Math.abs(Math.sin(t * 10.5)) * 0.22 + pulseVal;
      funnel = Math.abs(Math.sin(t * 4.3)) * 0.14;
      lowerL = lowerR = Math.abs(Math.sin(t * 8.0)) * 0.12;
    }
    pulseVal *= 0.86;
    lerpMorph("jawOpen", Math.min(jaw, 0.55), 0.4);
    lerpMorph("mouthFunnel", funnel, 0.3);
    lerpMorph("mouthLowerDown_L", lowerL, 0.3);
    lerpMorph("mouthLowerDown_R", lowerR, 0.3);

    // 眨眼
    if (blinkStart < 0 && t > nextBlink) { blinkStart = t; }
    if (blinkStart >= 0) {
      const p = (t - blinkStart) / 0.13;
      let bv;
      if (p >= 1) { bv = 0; blinkStart = -1; nextBlink = t + 2 + Math.random() * 3.2; }
      else bv = p < 0.5 ? p * 2 : (1 - p) * 2;
      setMorph("eyeBlink_L", bv); setMorph("eyeBlink_R", bv);
    }

    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 400;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight || 400;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  // ---- 加载模型（纯 GLB，无 KTX2/meshopt 依赖）----
  const loader = new GLTFLoader();

  loader.load("./assets/models/leyi_face.glb", function (gltf) {
    const root = gltf.scene;
    root.traverse(function (o) {
      if (o.isMesh) {
        if (o.morphTargetDictionary && o.morphTargetInfluences) {
          morphMeshes.push({ mesh: o, dict: o.morphTargetDictionary });
        }
        if (o.material && o.material.isMeshStandardMaterial) {
          o.material.roughness = Math.min(o.material.roughness != null ? o.material.roughness : 1, 0.92);
          o.material.envMapIntensity = 0.5;
        }
      }
    });
    group.add(root);

    // 自动取景：以头部包围盒居中，聚焦面部
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // 面部中心略偏上
    const focus = new THREE.Vector3(center.x, center.y + size.y * 0.16, center.z);
    const dist = Math.max(size.x, size.y) * 2.7;
    camera.position.set(focus.x, focus.y, focus.z + dist);
    camera.lookAt(focus);
    baseRotY = 0; baseRotX = 0;

    resize();
    canvas.style.display = "block";
    const svgHost = document.getElementById("avatarHost");
    if (svgHost) svgHost.style.display = "none";

    API.loaded = true;
    API.setMood = function (m) { mood = m; };
    API.startTalk = function () { talking = true; };
    API.stopTalk = function () { talking = false; };
    API.pulse = function () { pulseVal = Math.min(0.32, pulseVal + 0.2); };

    animate();
    window.dispatchEvent(new Event("leyi3d-ready"));
  }, undefined, function (err) {
    console.warn("[3D] 模型加载失败，回退 SVG 数字人", err);
    API.failed = true;
  });

  window.addEventListener("resize", resize);
  // 舞台尺寸变化（场景切换等）时也重算
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
})();
