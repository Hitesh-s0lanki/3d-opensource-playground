/** The 3D viewport: one GLB at a time, orbit controls, and the inspection
 * toggles the keyboard shortcuts drive. Plain three.js behind a small
 * imperative API - the React component around it only forwards events.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface StageStats {
  name: string | null;
  triangles: number;
  materials: number;
  /** metres, [x, y, z] of the bounding box */
  size: [number, number, number] | null;
}

export interface StageToggles {
  wireframe: boolean;
  grid: boolean;
  bbox: boolean;
  backdrop: boolean;
  spin: boolean;
}

const BACKDROP_LIGHT = 0xe9ecf4; // soft blue-grey, matching the page ground
const BACKDROP_DARK = 0x1c2130; // deep slate, for meshes too pale to read on it

export class GlbStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private loader = new GLTFLoader();
  private observer: ResizeObserver;

  private model: THREE.Group | null = null;
  private box = new THREE.Box3();
  private grid: THREE.GridHelper | null = null;
  private boxHelper: THREE.Box3Helper | null = null;
  private loadSeq = 0;
  private framed = false;

  toggles: StageToggles = {
    wireframe: false,
    grid: false,
    bbox: false,
    backdrop: false,
    spin: false,
  };

  constructor(
    private container: HTMLElement,
    private onStats: (stats: StageStats | null) => void,
    private onToggles: (toggles: StageToggles) => void,
    private onError: (message: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(BACKDROP_LIGHT);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    this.camera.position.set(2.5, 1.8, 3.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Snappy, not floaty: the default 0.05 keeps drifting long after the drag.
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomToCursor = true;
    this.controls.autoRotateSpeed = 1.6;

    // Double-click re-pivots the orbit onto the clicked spot on the mesh -
    // without it, once you pan (or step into a room) the camera keeps circling
    // a point that is nowhere near what you are looking at, which reads as
    // "rotation is broken". Double-clicking empty space re-frames the model.
    this.renderer.domElement.addEventListener("dblclick", this.onDoubleClick);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // -- loading ---------------------------------------------------------------

  async load(url: string, name: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.onStats(null);
    try {
      const gltf = await this.loader.loadAsync(url);
      if (seq !== this.loadSeq) {
        disposeObject(gltf.scene); // a newer load already replaced this one
        return;
      }
      this.setModel(gltf.scene, name);
    } catch (exc) {
      if (seq === this.loadSeq) {
        this.onError(exc instanceof Error ? exc.message : `could not load ${name}`);
      }
    }
  }

  /** Inspect a .glb dropped from anywhere, without it being a run. */
  async loadFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      await this.load(url, file.name);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  clear(): void {
    this.loadSeq++;
    this.removeModel();
    this.onStats(null);
  }

  private removeModel(): void {
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject(this.model);
      this.model = null;
    }
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    if (this.boxHelper) {
      this.scene.remove(this.boxHelper);
      this.boxHelper = null;
    }
  }

  private setModel(model: THREE.Group, name: string): void {
    this.removeModel();
    this.model = model;
    this.scene.add(model);
    this.box.setFromObject(model);

    // Stats: what came back, in numbers the pipeline talks in.
    let triangles = 0;
    const materials = new Set<string>();
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        const geometry = node.geometry as THREE.BufferGeometry;
        const index = geometry.getIndex();
        triangles += Math.round(
          (index ? index.count : geometry.getAttribute("position")?.count ?? 0) / 3,
        );
        for (const material of arrayify(node.material)) materials.add(material.uuid);
      }
    });
    const size = new THREE.Vector3();
    this.box.getSize(size);
    this.onStats({
      name,
      triangles,
      materials: materials.size,
      size: [size.x, size.y, size.z],
    });

    this.applyWireframe();
    this.rebuildHelpers();
    this.fit();
  }

  // -- camera ------------------------------------------------------------------

  /** Frame the model. Keeps the current viewing angle once the user has one -
   * a fit that also snapped the orientation back would throw away whatever
   * rotation they had just found. */
  fit(keepAngle = true): void {
    if (!this.model) return;
    const sphere = new THREE.Sphere();
    this.box.getBoundingSphere(sphere);
    const radius = Math.max(sphere.radius, 0.05);

    const direction = new THREE.Vector3();
    if (keepAngle && this.framed) {
      direction.subVectors(this.camera.position, this.controls.target);
      if (direction.lengthSq() < 1e-8) direction.set(1, 0.55, 1.35);
      direction.normalize();
    } else {
      direction.set(1, 0.55, 1.35).normalize();
    }

    this.camera.position.copy(sphere.center).addScaledVector(direction, radius * 2.4);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    // Sensible zoom range for this model: close enough to inspect a surface,
    // never so far the mesh is a speck - unbounded zoom is the other half of
    // "rotation feels broken", because orbiting from 200 m away barely moves.
    this.controls.minDistance = radius * 0.25;
    this.controls.maxDistance = radius * 10;
    this.controls.update();
    this.framed = true;
  }

  private onDoubleClick = (event: MouseEvent): void => {
    if (!this.model) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObject(this.model, true)[0];
    if (hit) {
      this.controls.target.copy(hit.point);
      this.controls.update();
    } else {
      this.fit();
    }
  };

  // -- toggles -----------------------------------------------------------------

  toggle(key: keyof StageToggles): void {
    this.toggles = { ...this.toggles, [key]: !this.toggles[key] };
    if (key === "wireframe") this.applyWireframe();
    if (key === "grid" || key === "bbox") this.rebuildHelpers();
    if (key === "backdrop") {
      this.scene.background = new THREE.Color(
        this.toggles.backdrop ? BACKDROP_DARK : BACKDROP_LIGHT,
      );
    }
    if (key === "spin") this.controls.autoRotate = this.toggles.spin;
    this.onToggles(this.toggles);
  }

  private applyWireframe(): void {
    this.model?.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        for (const material of arrayify(node.material)) {
          if ("wireframe" in material) {
            (material as THREE.MeshStandardMaterial).wireframe = this.toggles.wireframe;
          }
        }
      }
    });
  }

  private rebuildHelpers(): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    if (this.boxHelper) {
      this.scene.remove(this.boxHelper);
      this.boxHelper = null;
    }
    if (!this.model) return;

    if (this.toggles.grid) {
      // 1 m squares for rooms, finer pitches for smaller objects.
      const size = new THREE.Vector3();
      this.box.getSize(size);
      const largest = Math.max(size.x, size.z);
      const pitch = largest > 3 ? 1 : largest > 0.8 ? 0.25 : 0.1;
      const cells = Math.max(Math.ceil((largest * 1.6) / pitch), 4);
      this.grid = new THREE.GridHelper(cells * pitch, cells, 0x94a0bd, 0xd4dbea);
      const center = new THREE.Vector3();
      this.box.getCenter(center);
      this.grid.position.set(center.x, this.box.min.y, center.z);
      this.scene.add(this.grid);
    }
    if (this.toggles.bbox) {
      this.boxHelper = new THREE.Box3Helper(this.box.clone(), new THREE.Color(0xd97706));
      this.scene.add(this.boxHelper);
    }
  }

  // -- lifecycle -----------------------------------------------------------------

  private resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.loadSeq++;
    this.observer.disconnect();
    this.renderer.domElement.removeEventListener("dblclick", this.onDoubleClick);
    this.renderer.setAnimationLoop(null);
    this.removeModel();
    this.controls.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function arrayify(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      (node.geometry as THREE.BufferGeometry).dispose();
      for (const material of arrayify(node.material)) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
    }
  });
}
