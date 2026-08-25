/**
 * WebGL renderer — the diorama.
 *
 * The photograph becomes a backdrop, and every object the model found is
 * extruded into a slab standing in front of it, with the matching crop of the
 * photo mapped onto its face. The result reads as a paper theatre built out of
 * your own room.
 *
 * Gameplay stays strictly on the z = 0 plane. That is deliberate: the solver
 * proves each level completable from a two-dimensional jump arc, and letting
 * the player move in depth would invalidate every one of those proofs. This
 * file changes how the world looks and nothing about how it behaves.
 *
 * Everything below is built once per level and then only transformed per frame.
 * Allocating geometry inside the loop is the usual reason a WebGL scene of this
 * size stutters.
 */

import * as THREE from "three";
import {
  Entity,
  Level,
  MATERIAL_SPECS,
  Material,
  WORLD_H,
  WORLD_W,
  toWorld,
} from "./level";
import { Body, MONSTER_H, MONSTER_W, PLAYER_H, PLAYER_W, World } from "./physics";
import { CharacterKind } from "./character";
import { Renderer, RenderOpts } from "./renderer";

/** How far each material stands out of the backdrop. */
const DEPTH: Record<Material, number> = {
  solid: 62,
  bouncy: 54,
  slippery: 44,
  crumbling: 26,
  climbable: 22,
  hazard: 46,
  collectible: 26,
  tunnel: 84,
};

const BACKDROP_Z = -70;
const MAX_PARTICLES = 260;
const WHITE = new THREE.Color(0xffffff);

/** World space is y-down; three is y-up. One conversion, in one place. */
const flipY = (y: number) => -y;

function hexOf(c: string) {
  return new THREE.Color(c);
}

export class Renderer3D implements Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  /** Rebuilt whenever the level changes. */
  private staticGroup = new THREE.Group();
  private dynamicGroup = new THREE.Group();

  private backdrop?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private photoTexture?: THREE.Texture;
  private photoSource: HTMLImageElement | null = null;

  /** Mesh plus the body it belongs to, so the frame loop never searches. */
  private slabs = new Map<
    string,
    { mesh: THREE.Mesh; body: Body; baseX: number; tint: THREE.Color }
  >();
  private coins = new Map<string, { mesh: THREE.Mesh; body: Body; baseY: number }>();
  /** THREE.Color is an allocation; particles would make hundreds per frame. */
  private colorCache = new Map<string, THREE.Color>();
  private monsterMeshes: THREE.Group[] = [];
  private player?: THREE.Group;
  private playerKind?: CharacterKind;
  private playerColor?: string;
  private goal?: THREE.Group;

  private particleGeom = new THREE.BufferGeometry();
  private particlePoints?: THREE.Points;
  private particlePos = new Float32Array(MAX_PARTICLES * 3);
  private particleCol = new Float32Array(MAX_PARTICLES * 3);

  private builtFor: Level | null = null;
  private disposed = false;
  private lastW = 0;
  private lastH = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x05070d, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Frame the 1280x720 plane exactly, so world coordinates and screen
    // coordinates still correspond and the 2D and 3D views are comparable.
    const fov = 32;
    // A small margin over an exact fit, and the camera is clamped inside it
    // below. Framing the plane precisely means any camera movement crops the
    // level; framing it loosely leaves dead borders around the photo. A tight
    // margin plus a hard clamp gets both.
    const dist = (WORLD_H / 2 / Math.tan((fov / 2) * (Math.PI / 180))) * 1.06;
    this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, 10, 6000);
    this.camera.position.set(WORLD_W / 2, flipY(WORLD_H / 2), dist);
    this.camera.lookAt(WORLD_W / 2, flipY(WORLD_H / 2), 0);

    this.scene.add(this.staticGroup, this.dynamicGroup);
    this.scene.fog = new THREE.Fog(0x05070d, dist * 0.9, dist * 2.1);

    const ambient = new THREE.AmbientLight(0x8fa6c8, 1.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-500, 900, 1100);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const cam = key.shadow.camera as THREE.OrthographicCamera;
    cam.left = -1100;
    cam.right = 1100;
    cam.top = 900;
    cam.bottom = -900;
    cam.near = 10;
    cam.far = 3500;
    const rim = new THREE.DirectionalLight(0x7dd3fc, 0.8);
    rim.position.set(700, -300, 600);
    this.scene.add(ambient, key, rim);

    this.particleGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(this.particlePos, 3),
    );
    this.particleGeom.setAttribute(
      "color",
      new THREE.BufferAttribute(this.particleCol, 3),
    );
    this.particlePoints = new THREE.Points(
      this.particleGeom,
      new THREE.PointsMaterial({
        size: 9,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.particlePoints.frustumCulled = false;
    this.scene.add(this.particlePoints);
  }

  /* ------------------------------------------------------------ building */

  private ensurePhoto(image: HTMLImageElement | null) {
    if (this.photoSource === image) return;
    this.photoSource = image;
    this.photoTexture?.dispose();
    this.photoTexture = undefined;
    if (image) {
      const tex = new THREE.Texture(image);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this.photoTexture = tex;
    }
  }

  /** A texture showing only the part of the photo behind one entity. */
  private cropOf(e: Entity): THREE.Texture | null {
    if (!this.photoTexture) return null;
    const t = this.photoTexture.clone();
    t.needsUpdate = true;
    // UV origin is bottom-left; level boxes are top-left.
    t.offset.set(e.box.x, 1 - e.box.y - e.box.h);
    t.repeat.set(e.box.w, e.box.h);
    return t;
  }

  private buildSlab(e: Entity): THREE.Mesh {
    const r = toWorld(e.box);
    const d = DEPTH[e.material];
    const spec = MATERIAL_SPECS[e.material];
    const base = hexOf(spec.color);

    const side = new THREE.MeshStandardMaterial({
      color: base.clone().multiplyScalar(0.42),
      roughness: 0.85,
      metalness: 0.05,
    });
    // The top face is the surface the player actually stands on, so it is lit
    // brightest — it is the one edge that carries gameplay meaning.
    const top = new THREE.MeshStandardMaterial({
      color: base,
      emissive: base.clone().multiplyScalar(0.35),
      roughness: 0.5,
    });
    const crop = this.cropOf(e);
    const front = new THREE.MeshStandardMaterial({
      color: crop ? 0xffffff : base.clone().multiplyScalar(0.7),
      map: crop,
      roughness: 0.78,
    });

    if (e.material === "hazard") {
      front.emissive = base.clone().multiplyScalar(0.5);
      side.emissive = base.clone().multiplyScalar(0.35);
    }

    const geom = new THREE.BoxGeometry(r.w, r.h, d);
    // BoxGeometry groups: +x, -x, +y, -y, +z, -z
    const mesh = new THREE.Mesh(geom, [side, side, top, side, front, side]);
    mesh.position.set(r.x + r.w / 2, flipY(r.y + r.h / 2), d / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }


  /** A pipe, matching the 2D renderer: shaft, wider lip, dark mouth. */
  private buildTunnel(e: Entity): THREE.Group {
    const r = toWorld(e.box);
    const d = DEPTH.tunnel;
    const g = new THREE.Group();

    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x2f7d55,
      roughness: 0.6,
    });
    const lipMat = new THREE.MeshStandardMaterial({
      color: 0x46a877,
      roughness: 0.45,
      emissive: 0x123a26,
    });

    const lipH = Math.min(22, r.h * 0.42);
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(r.w - 16, r.h - lipH, d - 14),
      shaftMat,
    );
    shaft.position.set(0, -lipH / 2, 0);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(r.w, lipH, d), lipMat);
    lip.position.set(0, (r.h - lipH) / 2, 0);
    const mouth = new THREE.Mesh(
      new THREE.PlaneGeometry(r.w - 22, d - 20),
      new THREE.MeshBasicMaterial({ color: 0x07170f }),
    );
    mouth.rotation.x = -Math.PI / 2;
    mouth.position.set(0, r.h / 2 + 0.6, 0);

    shaft.castShadow = true;
    lip.castShadow = true;
    shaft.receiveShadow = true;
    lip.receiveShadow = true;
    g.add(shaft, lip, mouth);
    g.position.set(r.x + r.w / 2, flipY(r.y + r.h / 2), d / 2);
    return g;
  }

  private buildCoin(e: Entity): THREE.Mesh {
    const r = toWorld(e.box);
    const geom = new THREE.CylinderGeometry(
      Math.min(r.w, r.h) / 2,
      Math.min(r.w, r.h) / 2,
      6,
      20,
    );
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: 0xf5d049,
        emissive: 0x6b5410,
        metalness: 0.75,
        roughness: 0.28,
      }),
    );
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(r.x + r.w / 2, flipY(r.y + r.h / 2), DEPTH.collectible);
    mesh.castShadow = true;
    return mesh;
  }

  private buildGoal(level: Level): THREE.Group {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(3, 3, 64, 8),
      new THREE.MeshStandardMaterial({ color: 0xe0f2fe, roughness: 0.4 }),
    );
    pole.position.y = 32;
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 24),
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x1a6d99,
        side: THREE.DoubleSide,
      }),
    );
    flag.position.set(19, 50, 0);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(46, 20, 16),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    halo.position.y = 24;
    g.add(pole, flag, halo);
    g.position.set(
      level.goal.x * WORLD_W,
      flipY(level.goal.y * WORLD_H),
      DEPTH.solid + 10,
    );
    return g;
  }

  private buildCharacter(kind: CharacterKind, color: string): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({
      color: hexOf(color),
      roughness: 0.42,
      metalness: 0.08,
      emissive: hexOf(color).multiplyScalar(0.12),
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b1220 });

    let shell: THREE.Mesh;
    switch (kind) {
      case "ball":
        shell = new THREE.Mesh(new THREE.SphereGeometry(PLAYER_W / 2, 24, 18), body);
        shell.scale.y = PLAYER_H / PLAYER_W;
        break;
      case "ghost": {
        shell = new THREE.Mesh(
          new THREE.CapsuleGeometry(PLAYER_W / 2, PLAYER_H - PLAYER_W, 8, 16),
          body,
        );
        break;
      }
      case "robot":
        shell = new THREE.Mesh(
          new THREE.BoxGeometry(PLAYER_W, PLAYER_H, PLAYER_W * 0.8),
          body,
        );
        break;
      case "cat": {
        shell = new THREE.Mesh(
          new THREE.SphereGeometry(PLAYER_W / 2, 22, 16),
          body,
        );
        shell.scale.y = PLAYER_H / PLAYER_W;
        for (const sx of [-1, 1]) {
          const ear = new THREE.Mesh(new THREE.ConeGeometry(7, 14, 12), body);
          ear.position.set(sx * 9, PLAYER_H / 2 - 2, 0);
          g.add(ear);
        }
        break;
      }
      case "slime":
        shell = new THREE.Mesh(new THREE.SphereGeometry(PLAYER_W / 2, 24, 18), body);
        shell.scale.set(1.25, (PLAYER_H / PLAYER_W) * 0.72, 1);
        shell.position.y = -PLAYER_H * 0.12;
        break;
      default:
        shell = new THREE.Mesh(
          new THREE.BoxGeometry(PLAYER_W, PLAYER_H, PLAYER_W * 0.8),
          body,
        );
    }
    shell.castShadow = true;
    g.add(shell);

    // Eyes, so the character has a front and reads as alive.
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(3.4, 12, 10), dark);
      eye.position.set(sx * 6, PLAYER_H * 0.14, PLAYER_W * 0.42);
      g.add(eye);
    }
    return g;
  }

  private buildMonster(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(MONSTER_W / 2, 20, 14),
      new THREE.MeshStandardMaterial({
        color: 0xe0556f,
        emissive: 0x4a1524,
        roughness: 0.5,
      }),
    );
    body.scale.y = (MONSTER_H / MONSTER_W) * 1.05;
    body.castShadow = true;
    g.add(body);
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const dark = new THREE.MeshStandardMaterial({ color: 0x20101a });
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(5.2, 12, 10), white);
      e.position.set(sx * 7, 3, MONSTER_W * 0.4);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(2.4, 10, 8), dark);
      pupil.position.set(sx * 7, 3, MONSTER_W * 0.46);
      g.add(e, pupil);
    }
    return g;
  }

  private build(world: World) {
    this.disposeGroup(this.staticGroup);
    this.disposeGroup(this.dynamicGroup);
    this.slabs.clear();
    this.coins.clear();
    this.monsterMeshes = [];
    this.player = undefined;
    this.playerKind = undefined;
    this.goal = undefined;

    const level = world.level;

    // Backdrop.
    const backMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.photoTexture ?? null,
      transparent: true,
    });
    if (!this.photoTexture) backMat.color = new THREE.Color(0x0b1017);
    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W, WORLD_H),
      backMat,
    );
    this.backdrop.position.set(WORLD_W / 2, flipY(WORLD_H / 2), BACKDROP_Z);
    this.backdrop.receiveShadow = true;
    this.staticGroup.add(this.backdrop);

    for (const e of level.entities) {
      const body = world.bodies.find((b) => b.entity.id === e.id);
      if (!body) continue;
      if (e.material === "collectible") {
        const mesh = this.buildCoin(e);
        this.coins.set(e.id, { mesh, body, baseY: mesh.position.y });
        this.dynamicGroup.add(mesh);
      } else if (e.material === "tunnel") {
        this.staticGroup.add(this.buildTunnel(e));
      } else {
        const mesh = this.buildSlab(e);
        this.slabs.set(e.id, {
          mesh,
          body,
          baseX: mesh.position.x,
          tint: hexOf(MATERIAL_SPECS[e.material].color),
        });
        this.staticGroup.add(mesh);
      }
    }

    this.goal = this.buildGoal(level);
    this.dynamicGroup.add(this.goal);

    for (let i = 0; i < world.monsters.length; i++) {
      const m = this.buildMonster();
      this.monsterMeshes.push(m);
      this.dynamicGroup.add(m);
    }

    this.builtFor = level;
  }

  /* -------------------------------------------------------------- frame */

  private syncSize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(world: World, opts: RenderOpts) {
    if (this.disposed) return;
    this.syncSize();
    this.ensurePhoto(opts.image);

    if (this.builtFor !== world.level) this.build(world);

    const t = world.elapsed;

    // Backdrop fades out under X-ray, exactly as in the 2D view.
    if (this.backdrop) {
      const m = this.backdrop.material;
      m.opacity = 1 - opts.xray * 0.88;
      m.needsUpdate = true;
    }

    // Slabs: crumbling flicker, removed platforms, X-ray emphasis.
    for (const [id, { mesh, body, baseX, tint }] of this.slabs) {
      mesh.visible = body.respawnAt === undefined;
      const mats = mesh.material as THREE.MeshStandardMaterial[];
      const hovered = opts.hover?.id === id;
      const boost = opts.xray * 0.5 + (hovered ? 0.3 : 0);
      for (const mm of mats) {
        if (!mm.emissive) continue;
        mm.emissiveIntensity = 0.6 + boost;
      }
      // Wash the photographed face toward its material colour under X-ray, so
      // the mode shows collision volumes rather than a dimmer photograph. The
      // texture stays bound — swapping maps per frame forces a shader
      // recompile, which is exactly the stutter this renderer avoids.
      const front = mats[4];
      if (front) {
        front.color.copy(WHITE).lerp(tint, opts.xray * 0.92);
        front.emissive.copy(tint).multiplyScalar(opts.xray * 0.45);
      }
      // Shake relative to where it was built. Nudging the live position each
      // frame accumulates, and the platform slowly walks off its own collider.
      mesh.position.x =
        body.entity.material === "crumbling" && body.crumbleAt !== undefined
          ? baseX + (Math.random() - 0.5) * 2
          : baseX;
    }

    for (const { mesh, body, baseY } of this.coins.values()) {
      mesh.visible = !body.taken;
      if (!mesh.visible) continue;
      mesh.rotation.z = t / 260;
      // Bob around the built position for the same reason as above.
      mesh.position.y = baseY + Math.sin(t / 260 + mesh.position.x) * 4;
    }

    // Player.
    if (
      !this.player ||
      this.playerKind !== opts.wearing ||
      this.playerColor !== opts.settings.color
    ) {
      if (this.player) {
        this.dynamicGroup.remove(this.player);
        this.disposeObject(this.player);
      }
      this.player = this.buildCharacter(opts.wearing, opts.settings.color);
      this.playerKind = opts.wearing;
      this.playerColor = opts.settings.color;
      this.dynamicGroup.add(this.player);
    }
    const p = world.player;
    const stretch = opts.frozen
      ? 0
      : Math.max(-0.22, Math.min(0.22, p.vy / 4200));
    this.player.position.set(
      p.x + PLAYER_W / 2,
      flipY(p.y + PLAYER_H / 2),
      DEPTH.solid + 34,
    );
    this.player.scale.set(1 - stretch * 0.75, 1 + stretch, 1);
    // Turn to face the way it is travelling, rather than snapping.
    const wanted = p.facing > 0 ? 0.35 : -0.35;
    this.player.rotation.y += (wanted - this.player.rotation.y) * 0.2;

    // Monsters.
    world.monsters.forEach((m, i) => {
      const mesh = this.monsterMeshes[i];
      if (!mesh) return;
      const dead = !m.alive;
      mesh.visible = !dead || (m.goneAt ?? 0) > t;
      mesh.position.set(
        m.x + MONSTER_W / 2,
        flipY(m.y + MONSTER_H / 2),
        DEPTH.solid + 26,
      );
      mesh.scale.set(1, dead ? 0.25 : 1, 1);
      mesh.rotation.y = m.dir > 0 ? 0.4 : -0.4;
    });

    // Particles.
    const ps = opts.particles;
    const n = Math.min(ps.length, MAX_PARTICLES);
    for (let i = 0; i < n; i++) {
      const q = ps[i];
      this.particlePos[i * 3] = q.x;
      this.particlePos[i * 3 + 1] = flipY(q.y);
      this.particlePos[i * 3 + 2] = DEPTH.solid + 40;
      let c = this.colorCache.get(q.color);
      if (!c) {
        c = hexOf(q.color);
        this.colorCache.set(q.color, c);
      }
      this.particleCol[i * 3] = c.r * Math.max(0, q.life);
      this.particleCol[i * 3 + 1] = c.g * Math.max(0, q.life);
      this.particleCol[i * 3 + 2] = c.b * Math.max(0, q.life);
    }
    this.particleGeom.setDrawRange(0, n);
    this.particleGeom.attributes.position.needsUpdate = true;
    this.particleGeom.attributes.color.needsUpdate = true;

    // Camera: a little parallax toward the player, plus screen shake.
    const targetX = WORLD_W / 2 + (p.x - WORLD_W / 2) * 0.05;
    const targetY = flipY(WORLD_H / 2 + (p.y - WORLD_H / 2) * 0.03);
    this.camera.position.x += (targetX - this.camera.position.x) * 0.08;
    this.camera.position.y += (targetY - this.camera.position.y) * 0.08;
    if (opts.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * opts.shake;
      this.camera.position.y += (Math.random() - 0.5) * opts.shake;
    }
    // Hard stop at the margin: parallax and shake are additive and would
    // otherwise combine, on exactly the frames with the most going on, to pull
    // the edge of the level into view.
    const halfH = Math.tan((this.camera.fov / 2) * (Math.PI / 180)) * this.camera.position.z;
    const halfW = halfH * this.camera.aspect;
    const slackX = Math.max(0, halfW - WORLD_W / 2);
    const slackY = Math.max(0, halfH - WORLD_H / 2);
    this.camera.position.x = Math.max(
      WORLD_W / 2 - slackX,
      Math.min(WORLD_W / 2 + slackX, this.camera.position.x),
    );
    this.camera.position.y = Math.max(
      flipY(WORLD_H / 2) - slackY,
      Math.min(flipY(WORLD_H / 2) + slackY, this.camera.position.y),
    );
    // Look straight ahead. Aiming the camera at the player tilts the frustum
    // and reintroduces exactly the edge-cropping the clamp just prevented.
    this.camera.lookAt(this.camera.position.x, this.camera.position.y, 0);

    this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------ teardown */

  private disposeObject(obj: THREE.Object3D) {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
  }

  private disposeGroup(g: THREE.Group) {
    for (const child of [...g.children]) {
      this.disposeObject(child);
      g.remove(child);
    }
  }

  dispose() {
    this.disposed = true;
    this.disposeGroup(this.staticGroup);
    this.disposeGroup(this.dynamicGroup);
    this.particleGeom.dispose();
    this.photoTexture?.dispose();
    this.renderer.dispose();
  }
}

/** Returns null when WebGL is unavailable, so the caller can fall back to 2D. */
export function tryCreateRenderer3D(
  canvas: HTMLCanvasElement,
): Renderer3D | null {
  try {
    return new Renderer3D(canvas);
  } catch {
    return null;
  }
}
