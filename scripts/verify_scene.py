"""Check an assembled GLB against the spec it was built from. Runs in Blender.

    blender --background --factory-startup --python scripts/verify_scene.py -- \
        --glb outputs/bedroom.glb --spec outputs/bedroom/scene.json

Re-imports the export and asserts that what came out matches what was asked
for. Building a file without errors is not evidence the geometry is right: the
first working build here placed a chair 0.29 m tall against a 0.9 m target and
reported success, and a later one pushed a bed through the back wall.

Exits non-zero if any check fails, so it can gate a build.
"""

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

TOLERANCE = 0.05          # metres; placement is estimated, not machined
MIN_FACES = 200           # below this a mesh is a failed reconstruction


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = {}
    for i in range(0, len(argv) - 1, 2):
        args[argv[i].lstrip("-")] = argv[i + 1]
    if "glb" not in args or "spec" not in args:
        raise SystemExit("usage: -- --glb scene.glb --spec scene.json")
    return Path(args["glb"]), Path(args["spec"])


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner)
              for obj in objects for corner in obj.bound_box]
    if not points:
        return None
    return (Vector((min(p.x for p in points), min(p.y for p in points),
                    min(p.z for p in points))),
            Vector((max(p.x for p in points), max(p.y for p in points),
                    max(p.z for p in points))))


def main():
    glb_path, spec_path = parse_args()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    bpy.context.view_layer.update()

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    for mesh in meshes:
        mesh.data.calc_loop_triangles()

    failures = []
    warnings = []

    total_tris = sum(len(m.data.loop_triangles) for m in meshes)
    size_mb = glb_path.stat().st_size / 1e6
    print(f"file      : {glb_path.name}  {size_mb:.2f} MB")
    print(f"meshes    : {len(meshes)}   triangles: {total_tris:,}")

    # -- the shell ---------------------------------------------------------
    room = spec["room"]
    scene = bounds(meshes)
    extent = scene[1] - scene[0]
    expected_x = room["width"] + 2 * room["wall_thickness"]
    expected_y = room["depth"] + 2 * room["wall_thickness"]
    print(f"bounds    : {extent.x:.2f} x {extent.y:.2f} x {extent.z:.2f} m "
          f"(room implies {expected_x:.2f} x {expected_y:.2f})")

    # Anything sticking out past the shell means furniture through a wall.
    if extent.x > expected_x + TOLERANCE:
        failures.append(f"scene is {extent.x:.2f} m wide, room implies {expected_x:.2f}")
    if extent.y > expected_y + TOLERANCE:
        failures.append(f"scene is {extent.y:.2f} m deep, room implies {expected_y:.2f}")
    if abs(scene[0].z + room["wall_thickness"]) > TOLERANCE:
        failures.append(f"floor underside at z={scene[0].z:.3f}, "
                        f"expected {-room['wall_thickness']:.3f}")

    if not any(o.name == "room_shell" for o in bpy.data.objects):
        failures.append("room_shell missing from the export")

    # -- each object -------------------------------------------------------
    print(f"\n{'object':22s} {'built (m)':22s} {'tris':>7s}  status")
    for entry in spec["objects"]:
        name = entry["name"]
        group = [o for o in meshes
                 if o.name == name or (o.parent and o.parent.name == name)]
        if not group:
            failures.append(f"{name}: missing from the export")
            print(f"{name:22s} {'-':22s} {'-':>7s}  MISSING")
            continue

        low, high = bounds(group)
        dims = high - low
        centre = (low + high) / 2
        tris = sum(len(o.data.loop_triangles) for o in group)
        px, py, pz = entry["position"]

        notes = []
        if abs(centre.x - px) > TOLERANCE or abs(centre.y - py) > TOLERANCE:
            notes.append(f"xy at ({centre.x:.2f},{centre.y:.2f}) want ({px},{py})")
        if abs(low.z - pz) > TOLERANCE:
            notes.append(f"base z {low.z:.2f} want {pz}")

        # `size` is the object's own box; yawing it enlarges the world-aligned
        # one by w|cos t| + d|sin t|, so compare against that or every rotated
        # item looks oversized.
        target = entry["size"]
        yaw = math.radians(entry.get("rotation_z", 0.0))
        cos_y, sin_y = abs(math.cos(yaw)), abs(math.sin(yaw))
        allow_x = target[0] * cos_y + target[1] * sin_y + TOLERANCE
        allow_y = target[0] * sin_y + target[1] * cos_y + TOLERANCE
        if dims.x > allow_x or dims.y > allow_y or dims.z > target[2] + TOLERANCE:
            notes.append(f"exceeds target {target}")

        if entry.get("kind") != "billboard" and tris < MIN_FACES:
            warnings.append(f"{name}: only {tris} triangles - likely a failed "
                            f"reconstruction")

        for note in notes:
            failures.append(f"{name}: {note}")
        built = f"{dims.x:5.2f} x {dims.y:5.2f} x {dims.z:5.2f}"
        print(f"{name:22s} {built:22s} {tris:7d}  {'ok' if not notes else 'FAIL'}")

    # -- verdict -----------------------------------------------------------
    print()
    for warning in warnings:
        print(f"warn  {warning}")
    if failures:
        for failure in failures:
            print(f"FAIL  {failure}")
        print(f"\n{len(failures)} check(s) failed")
        return 1
    print(f"all checks passed ({len(spec['objects'])} objects)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
