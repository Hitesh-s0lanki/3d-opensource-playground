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
  /** how many pickable top-level parts the file contains */
  parts: number;
}

export interface StageToggles {
  wireframe: boolean;
  grid: boolean;
  bbox: boolean;
  backdrop: boolean;
  spin: boolean;
}

/** The six canonical inspection angles, plus the three-quarter default. */
export const VIEWS = {
  iso: [1, 0.55, 1.35],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0001], // a hair off-axis, so "up" stays defined
  bottom: [0, -1, 0.0001],
} as const;

export type ViewName = keyof typeof VIEWS;

/** Exported so React can seed its mirror of the toggle row without waiting for
 * the stage to be constructed and call back. */
export const DEFAULT_TOGGLES: StageToggles = {
  wireframe: false,
  grid: false,
  bbox: false,
  backdrop: false,
  spin: false,
};

interface StageHandlers {
  onStats: (stats: StageStats | null) => void;
  onToggles: (toggles: StageToggles) => void;
  onError: (message: string) => void;
  /** 0-1 while a mesh streams in, or null when the size is unknown. */
  onProgress: (fraction: number | null) => void;
  /** A part of the loaded scene was clicked, or empty space was (null). */
  onPick: (name: string | null) => void;
  /** The part under the cursor, for the label the React layer draws. */
  onHover: (name: string | null) => void;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export class GlbStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private loader = new GLTFLoader();
  private observer: ResizeObserver;
  private themeObserver: MutationObserver | null = null;

  private model: THREE.Group | null = null;
  private box = new THREE.Box3();
  private grid: THREE.GridHelper | null = null;
  private boxHelper: THREE.Box3Helper | null = null;
  private hoverHelper: THREE.Box3Helper | null = null;
  private selectHelper: THREE.Box3Helper | null = null;
  private loadSeq = 0;
  private framed = false;

  /** Top-level pickable parts of the current model, by name. */
  private parts: THREE.Object3D[] = [];
  private hovered: THREE.Object3D | null = null;
  private selected: THREE.Object3D | null = null;
  private pointer = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  /** Where a drag began, so an orbit is never mistaken for a click. */
  private pressAt: { x: number; y: number } | null = null;
  private hoverDirty = false;

  /** Colors resolved from CSS custom properties, refreshed on theme change. */
  private palette = {
    bg: new THREE.Color(0xe9ecf4),
    bgAlt: new THREE.Color(0x1c2130),
    grid: new THREE.Color(0x94a0bd),
    gridSoft: new THREE.Color(0xd4dbea),
  };

  toggles: StageToggles = { ...DEFAULT_TOGGLES };

  constructor(
    private container: HTMLElement,
    private handlers: StageHandlers,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      // Snapshots read the drawing buffer back after the frame has been
      // presented, which is only defined when it is preserved.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Without this, a one-finger orbit on a phone scrolls the page instead.
    this.renderer.domElement.style.touchAction = "none";
    this.renderer.domElement.style.display = "block";
    container.appendChild(this.renderer.domElement);

    this.readPalette();
    this.scene.background = this.palette.bg.clone();
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
    const canvas = this.renderer.domElement;
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();

    // The scheme lives in a class on <html>, written by the theme provider in
    // its own effect. Watching the attribute is the only ordering-proof way to
    // hear about it: a React effect in the stage's own component runs first,
    // and would sample the palette it is about to stop being.
    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() => this.refreshTheme());
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }

    this.start();
  }

  private start(): void {
    this.renderer.setAnimationLoop(() => {
      // Picking is done once per frame rather than per pointer event: a fast
      // drag fires dozens of moves, and only the last one is worth a raycast.
      if (this.hoverDirty) {
        this.hoverDirty = false;
        this.updateHover();
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Stop or resume the render loop. A stage that has scrolled out of view, or
   * is in a hidden tab, is drawing 60 frames a second of something nobody can
   * see; on the landing page, where three of these can exist at once, that is
   * the difference between a warm laptop and a quiet one. */
  setRunning(running: boolean): void {
    if (running) this.start();
    else this.renderer.setAnimationLoop(null);
  }

  // -- theme -------------------------------------------------------------------

  /** Re-read the stage colors from CSS. Called when the color scheme flips. */
  refreshTheme(): void {
    this.readPalette();
    this.scene.background = (
      this.toggles.backdrop ? this.palette.bgAlt : this.palette.bg
    ).clone();
    this.rebuildHelpers();
  }

  private readPalette(): void {
    if (typeof window === "undefined") return;
    const style = getComputedStyle(this.container);
    const read = (name: string, fallback: THREE.Color) => {
      const value = style.getPropertyValue(name).trim();
      if (!value) return fallback;
      try {
        return new THREE.Color(value);
      } catch {
        return fallback;
      }
    };
    this.palette = {
      bg: read("--stage-bg", this.palette.bg),
      bgAlt: read("--stage-bg-alt", this.palette.bgAlt),
      grid: read("--stage-grid", this.palette.grid),
      gridSoft: read("--stage-grid-soft", this.palette.gridSoft),
    };
  }

  // -- loading ---------------------------------------------------------------

  async load(url: string, name: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.handlers.onStats(null);
    this.handlers.onProgress(null);
    try {
      const gltf = await this.loader.loadAsync(url, (event) => {
        if (seq !== this.loadSeq) return;
        this.handlers.onProgress(
          event.lengthComputable && event.total > 0 ? event.loaded / event.total : null,
        );
      });
      if (seq !== this.loadSeq) {
        disposeObject(gltf.scene); // a newer load already replaced this one
        return;
      }
      this.setModel(gltf.scene, name);
    } catch (exc) {
      if (seq === this.loadSeq) {
        this.handlers.onError(exc instanceof Error ? exc.message : `could not load ${name}`);
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
    this.handlers.onStats(null);
  }

  private removeModel(): void {
    this.setHovered(null);
    this.setSelected(null);
    this.parts = [];
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject(this.model);
      this.model = null;
    }
    this.disposeGrid();
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

    // What can be clicked: the named children of the scene root. A single
    // object export has one, an assembled room has one per placed item.
    this.parts = model.children.filter((child) => hasGeometry(child));

    // Stats: what came back, in numbers the pipeline talks in.
    let triangles = 0;
    const materials = new Set<string>();
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        const geometry = node.geometry as THREE.BufferGeometry;
        const index = geometry.getIndex();
        triangles += Math.round(
          (index ? index.count : (geometry.getAttribute("position")?.count ?? 0)) / 3,
        );
        for (const material of arrayify(node.material)) materials.add(material.uuid);
      }
    });
    const size = new THREE.Vector3();
    this.box.getSize(size);
    this.handlers.onStats({
      name,
      triangles,
      materials: materials.size,
      size: [size.x, size.y, size.z],
      parts: this.parts.length,
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
      if (direction.lengthSq() < 1e-8) direction.set(...VIEWS.iso);
      direction.normalize();
    } else {
      direction.set(...VIEWS.iso).normalize();
    }

    this.frame(sphere.center, radius, direction);
  }

  /** Snap to one of the canonical angles, framing whatever is selected if
   * something is - inspecting one chair in a room should not fly the camera
   * back out to the whole room. */
  view(name: ViewName): void {
    if (!this.model) return;
    const target = this.selected ? new THREE.Box3().setFromObject(this.selected) : this.box;
    const sphere = new THREE.Sphere();
    target.getBoundingSphere(sphere);
    const direction = new THREE.Vector3(...VIEWS[name]).normalize();
    this.frame(sphere.center, Math.max(sphere.radius, 0.05), direction);
  }

  /** Frame the current selection, or the whole model when there is none. */
  focusSelection(): void {
    if (!this.model) return;
    if (!this.selected) {
      this.fit(false);
      return;
    }
    const sphere = new THREE.Sphere();
    new THREE.Box3().setFromObject(this.selected).getBoundingSphere(sphere);
    const direction = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize();
    if (direction.lengthSq() < 1e-8) direction.set(...VIEWS.iso).normalize();
    this.frame(sphere.center, Math.max(sphere.radius, 0.02), direction);
  }

  private frame(center: THREE.Vector3, radius: number, direction: THREE.Vector3): void {
    this.camera.position.copy(center).addScaledVector(direction, radius * 2.4);
    this.camera.near = radius / 100;
    this.camera.far = radius * 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    // Sensible zoom range for this model: close enough to inspect a surface,
    // never so far the mesh is a speck - unbounded zoom is the other half of
    // "rotation feels broken", because orbiting from 200 m away barely moves.
    this.controls.minDistance = radius * 0.25;
    this.controls.maxDistance = radius * 12;
    this.controls.update();
    this.framed = true;
  }

  /** A PNG of exactly what is on screen, for pasting into a review thread. */
  snapshot(): string | null {
    if (!this.renderer) return null;
    this.renderer.render(this.scene, this.camera);
    try {
      return this.renderer.domElement.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  // -- picking -----------------------------------------------------------------

  /** Highlight a part by name, driven from the panels rather than the canvas. */
  highlight(name: string | null): void {
    const part = name ? (this.parts.find((p) => p.name === name) ?? null) : null;
    this.setSelected(part);
  }

  private toNdc(event: PointerEvent | MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** The top-level part under the pointer, or null. */
  private partAtPointer(): THREE.Object3D | null {
    if (!this.model || this.parts.length === 0) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.parts, true)[0];
    if (!hit) return null;
    let node: THREE.Object3D | null = hit.object;
    while (node && node.parent !== this.model) node = node.parent;
    return node;
  }

  private onPointerMove = (event: PointerEvent): void => {
    this.toNdc(event);
    this.hoverDirty = true;
  };

  private updateHover(): void {
    // Only one part is not worth hover affordances: there is nothing to choose
    // between, and the outline would just flicker under every drag.
    const next = this.parts.length > 1 ? this.partAtPointer() : null;
    if (next === this.hovered) return;
    this.setHovered(next);
    this.renderer.domElement.style.cursor = next ? "pointer" : "grab";
    this.handlers.onHover(next?.name || null);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pressAt = { x: event.clientX, y: event.clientY };
    this.renderer.domElement.style.cursor = "grabbing";
  };

  private onPointerUp = (event: PointerEvent): void => {
    const from = this.pressAt;
    this.pressAt = null;
    this.renderer.domElement.style.cursor = this.hovered ? "pointer" : "grab";
    if (!from) return;
    // Anything past a few pixels was an orbit, not a click on a part.
    if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 5) return;
    if (this.parts.length < 2) return;
    this.toNdc(event);
    const part = this.partAtPointer();
    this.handlers.onPick(part?.name || null);
  };

  private onPointerLeave = (): void => {
    this.pressAt = null;
    if (this.hovered) {
      this.setHovered(null);
      this.handlers.onHover(null);
    }
  };

  private setHovered(part: THREE.Object3D | null): void {
    this.hovered = part;
    this.hoverHelper = this.drawOutline(this.hoverHelper, part, this.palette.grid, false);
  }

  private setSelected(part: THREE.Object3D | null): void {
    this.selected = part;
    this.selectHelper = this.drawOutline(
      this.selectHelper,
      part,
      new THREE.Color(0x4f46e5),
      true,
    );
  }

  private drawOutline(
    helper: THREE.Box3Helper | null,
    part: THREE.Object3D | null,
    color: THREE.Color,
    onTop: boolean,
  ): THREE.Box3Helper | null {
    if (helper) {
      this.scene.remove(helper);
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    // A lone part is already "the model"; boxing it adds nothing but clutter.
    if (!part || this.parts.length < 2) return null;
    const next = new THREE.Box3Helper(new THREE.Box3().setFromObject(part), color);
    const material = next.material as THREE.LineBasicMaterial;
    material.depthTest = !onTop;
    material.transparent = true;
    material.opacity = onTop ? 1 : 0.7;
    next.renderOrder = onTop ? 2 : 1;
    this.scene.add(next);
    return next;
  }

  private onDoubleClick = (event: MouseEvent): void => {
    if (!this.model) return;
    this.toNdc(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.model, true)[0];
    if (hit) {
      this.controls.target.copy(hit.point);
      this.controls.update();
    } else {
      this.fit();
    }
  };

  // -- toggles -----------------------------------------------------------------

  toggle(key: keyof StageToggles, force?: boolean): void {
    const next = force ?? !this.toggles[key];
    if (next === this.toggles[key]) return;
    this.toggles = { ...this.toggles, [key]: next };
    if (key === "wireframe") this.applyWireframe();
    if (key === "grid" || key === "bbox") this.rebuildHelpers();
    if (key === "backdrop") {
      this.scene.background = (
        this.toggles.backdrop ? this.palette.bgAlt : this.palette.bg
      ).clone();
    }
    // Someone who has asked the OS for less motion did not ask for a
    // permanently rotating model; the toggle stays, it just does not spin.
    if (key === "spin") this.controls.autoRotate = this.toggles.spin && !reducedMotion();
    this.handlers.onToggles(this.toggles);
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

  private disposeGrid(): void {
    if (!this.grid) return;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    for (const material of arrayify(this.grid.material)) material.dispose();
    this.grid = null;
  }

  private rebuildHelpers(): void {
    this.disposeGrid();
    if (this.boxHelper) {
      this.scene.remove(this.boxHelper);
      this.boxHelper.geometry.dispose();
      (this.boxHelper.material as THREE.Material).dispose();
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
      this.grid = new THREE.GridHelper(
        cells * pitch,
        cells,
        this.palette.grid,
        this.palette.gridSoft,
      );
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
    this.themeObserver?.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.renderer.setAnimationLoop(null);
    this.removeModel();
    this.controls.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}

function arrayify(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function hasGeometry(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) found = true;
  });
  return found;
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
