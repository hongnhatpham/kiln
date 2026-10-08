import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import dracoWasmUrl from "../assets/draco/draco_decoder.wasm?url";
import dracoWrapperUrl from "../assets/draco/draco_wasm_wrapper.js.txt?url";

export type Slot = "source" | "optimized";
export type ViewMode = "source" | "optimized" | "split";
export type Lighting = "studio" | "raking";
/** Texture shows the model as published. Clay drops every map so only geometry shades. Wire adds triangle edges. */
export type Surface = "texture" | "clay" | "wire";

export type SlotStatus =
  | { state: "empty" }
  | { state: "loading"; progress: number | null }
  | { state: "ready" }
  | { state: "error"; message: string };

export interface ViewerEvents {
  onSlot(slot: Slot, status: SlotStatus): void;
  /** How many screen pixels one source texel covers at the orbit target. */
  onScale(pixelsPerTexel: number | null): void;
  onContextLost(): void;
}

/** DRACOLoader fetches its decoder by file name. Map those names to bundled, hashed asset URLs. */
class BundledDracoLoader extends DRACOLoader {
  _loadLibrary(url: string, responseType: string): Promise<unknown> {
    const files: Record<string, string> = {
      "draco_wasm_wrapper.js": dracoWrapperUrl,
      "draco_decoder.wasm": dracoWasmUrl,
    };
    const loader = new THREE.FileLoader(this.manager);
    loader.setResponseType(responseType as "text" | "arraybuffer");
    return loader.loadAsync(files[url] ?? url);
  }
}

const WIRE_OVERLAY = "kiln-wire-overlay";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * One renderer, one camera, two model slots. Split view draws the same camera twice with a scissor,
 * so both halves stay perfectly aligned. Frames render only on change: no idle loop.
 */
export class ComparisonViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  private readonly key = new THREE.DirectionalLight(0xffffff, 1);
  private readonly loader: GLTFLoader;
  private readonly draco = new BundledDracoLoader();
  private readonly resize: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly roots: Record<Slot, THREE.Object3D | null> = { source: null, optimized: null };
  private readonly urls: Record<Slot, string | null> = { source: null, optimized: null };
  private readonly tokens: Record<Slot, number> = { source: 0, optimized: 0 };
  private envMap: THREE.Texture;
  private mode: ViewMode = "source";
  private split = 0.5;
  private lighting: Lighting = "studio";
  private surface: Surface = "texture";
  /** Original materials, restored when leaving clay or wire. */
  private readonly originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  // Polygon offset pushes clay faces back a little so edges drawn on the same surface win the depth test.
  private readonly clay = new THREE.MeshStandardMaterial({
    color: 0xb3ada1,
    roughness: 0.9,
    metalness: 0,
    // Less ambient fill than textured mode so the key light models the form.
    envMapIntensity: 0.6,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  // Faint ink lines: dense regions read darker instead of turning solid black.
  private readonly wire = new THREE.MeshBasicMaterial({
    color: 0x1d1e20,
    wireframe: true,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  private frame = 0;
  private animation = 0;
  private offset: THREE.Vector3 | null = null;
  private bounds: THREE.Box3 | null = null;
  /** True until the user moves the camera. Resizing then refits the whole object. */
  private atHome = true;
  private size = 1;
  private texelWorld: number | null = null;
  private referenceTexels = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: ViewerEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.className = "viewer-canvas";
    canvas.setAttribute(
      "aria-label",
      "3D preview. Drag to orbit, scroll to zoom, double-click to focus a point.",
    );
    canvas.tabIndex = -1;
    container.appendChild(canvas);
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("dblclick", this.handleDoubleClick);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.add(this.key, this.key.target);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.zoomToCursor = true;
    this.controls.enableDamping = false;
    this.controls.addEventListener("start", this.leaveHome);
    this.controls.addEventListener("change", this.invalidate);

    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.loader.setDRACOLoader(this.draco);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.applyLighting();
  }

  /** Forget framing so the next loaded model sets the home view. Call when the source asset changes. */
  resetAsset(referenceTexels: number) {
    this.offset = null;
    this.bounds = null;
    this.atHome = true;
    this.texelWorld = null;
    this.referenceTexels = referenceTexels;
  }

  setModel(slot: Slot, url: string | null) {
    if (this.urls[slot] === url) return;
    this.urls[slot] = url;
    const token = ++this.tokens[slot];
    this.unload(slot);
    if (!url) {
      this.events.onSlot(slot, { state: "empty" });
      this.invalidate();
      return;
    }
    this.events.onSlot(slot, { state: "loading", progress: null });
    this.loader
      .loadAsync(url, (event) => {
        if (token !== this.tokens[slot]) return;
        const progress =
          event.lengthComputable && event.total > 0 ? event.loaded / event.total : null;
        this.events.onSlot(slot, { state: "loading", progress });
      })
      .then((gltf) => {
        if (this.disposed || token !== this.tokens[slot]) {
          disposeObject(gltf.scene);
          return;
        }
        this.place(slot, gltf.scene);
        this.events.onSlot(slot, { state: "ready" });
        this.invalidate();
      })
      .catch((error: unknown) => {
        if (token !== this.tokens[slot]) return;
        this.urls[slot] = null;
        const message = error instanceof Error ? error.message : String(error);
        this.events.onSlot(slot, { state: "error", message });
      });
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.invalidate();
  }

  setSplit(value: number) {
    this.split = THREE.MathUtils.clamp(value, 0, 1);
    this.invalidate();
  }

  setLighting(lighting: Lighting) {
    this.lighting = lighting;
    this.applyLighting();
    this.invalidate();
  }

  setSurface(surface: Surface) {
    if (surface === this.surface) return;
    this.surface = surface;
    for (const root of Object.values(this.roots)) if (root) this.applySurface(root);
    this.invalidate();
  }

  resetView() {
    const home = this.home();
    if (!home) return;
    this.animateTo(home.target, home.position);
    this.atHome = true;
  }

  /** Move in until one source texel covers about one screen pixel, at the surface under the view center. */
  showTexels() {
    if (!this.texelWorld) return;
    const hit = this.pick(new THREE.Vector2(0, 0)) ?? this.controls.target.clone();
    const height = this.renderer.domElement.height;
    const distance =
      (this.texelWorld * height) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const direction = this.camera.position.clone().sub(hit).normalize();
    this.atHome = false;
    this.animateTo(hit, hit.clone().add(direction.multiplyScalar(distance)));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.animation);
    this.resize.disconnect();
    this.controls.dispose();
    this.unload("source");
    this.unload("optimized");
    this.envMap.dispose();
    this.clay.dispose();
    this.wire.dispose();
    this.draco.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.renderer.dispose();
    canvas.remove();
  }

  readonly invalidate = () => {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };

  private place(slot: Slot, root: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(root);
    // Both slots share the first model's offset so source and optimized overlap exactly.
    if (!this.offset) this.offset = box.getCenter(new THREE.Vector3()).negate();
    root.position.add(this.offset);
    root.updateMatrixWorld(true);
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of materialsOf(mesh)) {
        for (const texture of texturesOf(material)) texture.anisotropy = anisotropy;
      }
    });
    this.roots[slot] = root;
    this.scene.add(root);
    if (!this.bounds) this.frameModel(box);
    if (!this.texelWorld && this.referenceTexels > 0) {
      const area = surfaceArea(root);
      // Assume scans use about 70% of their UV square. Good enough to land near 1:1.
      if (area > 0)
        this.texelWorld = Math.sqrt(area / (this.referenceTexels * this.referenceTexels * 0.7));
    }
    // After measuring: wire overlays share the geometry and would count its area twice.
    this.applySurface(root);
  }

  private frameModel(box: THREE.Box3) {
    // The model is already centered by `offset`, so the framed box sits around the origin.
    const centered = box.clone().translate(this.offset ?? new THREE.Vector3());
    this.bounds = centered;
    this.size = Math.max(centered.getSize(new THREE.Vector3()).length(), 1e-4);
    this.controls.minDistance = this.size * 0.0005;
    this.controls.maxDistance = this.size * 8;
    this.jumpHome();
  }

  /**
   * Home view that fits every bounding-box corner inside both the vertical and the horizontal field of view,
   * so wide objects in narrow windows (and tall ones in wide windows) never start clipped.
   */
  private home(): { target: THREE.Vector3; position: THREE.Vector3 } | null {
    if (!this.bounds) return null;
    const target = this.bounds.getCenter(new THREE.Vector3());
    const forward = new THREE.Vector3(0.55, 0.38, 1).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(forward).normalize();
    const up = forward.clone().cross(right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanH = tanV * this.camera.aspect;
    const { min, max } = this.bounds;
    let distance = 0;
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const corner = new THREE.Vector3(x, y, z).sub(target);
          const depth = corner.dot(forward);
          distance = Math.max(
            distance,
            depth + Math.abs(corner.dot(right)) / tanH,
            depth + Math.abs(corner.dot(up)) / tanV,
          );
        }
    // Leave room for the floating toolbars at the top and bottom of the stage.
    distance *= 1.18;
    return { target, position: target.clone().addScaledVector(forward, distance) };
  }

  private jumpHome() {
    const home = this.home();
    if (!home) return;
    this.stopAnimation();
    this.controls.target.copy(home.target);
    this.camera.position.copy(home.position);
    this.controls.update();
    this.atHome = true;
  }

  private unload(slot: Slot) {
    const root = this.roots[slot];
    if (!root) return;
    this.scene.remove(root);
    this.restoreSurface(root);
    disposeObject(root);
    this.roots[slot] = null;
  }

  /** Swap in clay, and in wire mode an edge overlay that shares the mesh geometry. */
  private applySurface(root: THREE.Object3D) {
    this.restoreSurface(root);
    if (this.surface === "texture") return;
    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    for (const mesh of meshes) {
      this.originals.set(mesh, mesh.material);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => this.clay) : this.clay;
      if (this.surface !== "wire") continue;
      const edges = new THREE.Mesh(mesh.geometry, this.wire);
      edges.name = WIRE_OVERLAY;
      edges.raycast = () => {};
      mesh.add(edges);
    }
  }

  private restoreSurface(root: THREE.Object3D) {
    const overlays: THREE.Object3D[] = [];
    root.traverse((object) => {
      if (object.name === WIRE_OVERLAY) overlays.push(object);
      const mesh = object as THREE.Mesh;
      const original = this.originals.get(mesh);
      if (!original) return;
      mesh.material = original;
      this.originals.delete(mesh);
    });
    for (const overlay of overlays) overlay.removeFromParent();
  }

  private fit() {
    const { clientWidth, clientHeight } = this.container;
    if (!clientWidth || !clientHeight) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    if (this.atHome) this.jumpHome();
    this.invalidate();
  }

  private applyLighting() {
    const raking = this.lighting === "raking";
    this.scene.environmentIntensity = raking ? 0.3 : 1;
    this.key.intensity = raking ? 3.6 : 0.9;
  }

  private render() {
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    this.camera.near = Math.max(distance * 0.01, this.size * 1e-5);
    this.camera.far = distance + this.size * 4;
    this.camera.updateProjectionMatrix();

    // The key light follows the camera: raking light always grazes across the current view.
    const direction =
      this.lighting === "raking"
        ? new THREE.Vector3(-1, 0.3, 0.42)
        : new THREE.Vector3(0.5, 0.85, 0.7);
    direction.normalize().applyQuaternion(this.camera.quaternion);
    this.key.position.copy(target).addScaledVector(direction, this.size * 3);
    this.key.target.position.copy(target);
    this.key.target.updateMatrixWorld();

    const { source, optimized } = this.roots;
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    this.renderer.setViewport(0, 0, width, height);
    if (this.mode === "split" && source && optimized) {
      const edge = Math.round(width * this.split);
      this.renderer.setScissorTest(true);
      this.draw(source, optimized, 0, edge, height);
      this.draw(optimized, source, edge, width - edge, height);
      this.renderer.setScissorTest(false);
    } else {
      const visible = this.mode === "optimized" ? optimized : source;
      const hidden = visible === source ? optimized : source;
      if (hidden) hidden.visible = false;
      if (visible) visible.visible = true;
      this.renderer.render(this.scene, this.camera);
    }
    this.reportScale(distance);
  }

  private draw(
    show: THREE.Object3D,
    hide: THREE.Object3D,
    x: number,
    width: number,
    height: number,
  ) {
    if (width <= 0) return;
    show.visible = true;
    hide.visible = false;
    this.renderer.setScissor(x, 0, width, height);
    this.renderer.render(this.scene, this.camera);
  }

  private reportScale(distance: number) {
    if (!this.texelWorld) return this.events.onScale(null);
    const pixelWorld =
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) /
      this.renderer.domElement.height;
    this.events.onScale(this.texelWorld / pixelWorld);
  }

  /** Surface point under normalized device coordinates, on whichever model is visible there. */
  private pick(ndc: THREE.Vector2): THREE.Vector3 | null {
    const { source, optimized } = this.roots;
    let root = this.mode === "optimized" ? optimized : source;
    if (this.mode === "split") root = (ndc.x + 1) / 2 < this.split ? source : optimized;
    if (!root) return null;
    const wasVisible = root.visible;
    root.visible = true;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(root, true)[0];
    root.visible = wasVisible;
    return hit ? hit.point.clone() : null;
  }

  private handleDoubleClick = (event: MouseEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const hit = this.pick(ndc);
    if (!hit) return;
    this.atHome = false;
    const shift = hit.clone().sub(this.controls.target);
    this.animateTo(hit, this.camera.position.clone().add(shift));
  };

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.events.onContextLost();
  };

  private leaveHome = () => {
    this.stopAnimation();
    this.atHome = false;
  };

  private stopAnimation = () => {
    cancelAnimationFrame(this.animation);
    this.animation = 0;
  };

  private animateTo(target: THREE.Vector3, position: THREE.Vector3) {
    this.stopAnimation();
    const fromTarget = this.controls.target.clone();
    const fromPosition = this.camera.position.clone();
    const apply = (t: number) => {
      this.controls.target.lerpVectors(fromTarget, target, t);
      this.camera.position.lerpVectors(fromPosition, position, t);
      this.controls.update();
    };
    if (reducedMotion()) return apply(1);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 420);
      apply(easeOut(t));
      this.animation = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.animation = requestAnimationFrame(step);
  }
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function texturesOf(material: THREE.Material): THREE.Texture[] {
  return Object.values(material).filter(
    (value): value is THREE.Texture => value instanceof THREE.Texture,
  );
}

/** Free GPU buffers and decoded images. 8K scans hold hundreds of MB each. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of materialsOf(mesh)) {
      for (const texture of texturesOf(material)) {
        texture.dispose();
        const image = texture.image as { close?: () => void } | null;
        image?.close?.();
      }
      material.dispose();
    }
  });
}

function surfaceArea(root: THREE.Object3D): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let area = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const [ia, ib, ic] = index
        ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
        : [i, i + 1, i + 2];
      a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
  });
  return area;
}
