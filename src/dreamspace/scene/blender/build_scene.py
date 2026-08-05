"""Assemble a room from a scene.json into a single GLB. Runs inside Blender.

    blender --background --factory-startup --python build_scene.py -- \
        --spec scene.json --out scene.glb

Blender bundles its own interpreter, so this file may not import `dreamspace`
or anything from the project venv: standard library and `bpy` only. The scene
JSON is the entire interface - see dreamspace/scene/spec.py for the format.

Two conventions worth restating because everything here depends on them:
Z is up, and units are metres with the floor surface at z=0.
"""

import itertools
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# Printed on the last line of a successful run. Blender does not reliably
# return a non-zero exit code when an embedded Python script raises, so the
# driver looks for this sentinel rather than trusting the exit status alone.
SENTINEL = "DREAMSPACE_ASSEMBLE_OK"


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def box_geometry(center, size, index_offset=0):
    """Return (verts, faces) for an axis-aligned box.

    Built by hand rather than via primitive_cube_add because operators depend
    on a context that is awkward in background mode, and because accumulating
    raw geometry lets the whole room shell become one mesh with one draw call.
    """
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2.0, size[1] / 2.0, size[2] / 2.0

    verts = [
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ]
    # Wound counter-clockwise seen from outside, so normals face out and the
    # room reads correctly in a viewer that culls backfaces.
    faces = [
        (0, 3, 2, 1), (4, 5, 6, 7),          # bottom, top
        (0, 1, 5, 4), (1, 2, 6, 5),          # -Y, +X
        (2, 3, 7, 6), (3, 0, 4, 7),          # +Y, -X
    ]
    o = index_offset
    return verts, [tuple(i + o for i in f) for f in faces]


def world_bounds(objects):
    """Axis-aligned world-space bounding box over every mesh in `objects`."""
    corners = [
        obj.matrix_world @ Vector(corner)
        for obj in objects
        if obj.type == "MESH"
        for corner in obj.bound_box
    ]
    if not corners:
        return None
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi


def best_orientation(dims, target):
    """Pick the axis permutation whose proportions best match `target`.

    Reconstructed meshes have no canonical up-axis: TripoSR hands back chairs
    lying on their side, and nothing in a GLB says which way is up. Guessing
    from the geometry alone is unreliable, but the spec already states the real
    dimensions, and those imply an orientation - a 0.55 x 0.55 x 0.9 target is
    unambiguously upright.

    So try all six permutations and keep whichever fills the target box best
    after a uniform fit. Returns (rotation matrix, permuted dims).
    """
    best = None
    for perm in itertools.permutations(range(3)):
        permuted = [dims[perm[i]] for i in range(3)]
        if min(permuted) <= 1e-9:
            continue
        scale = min(target[i] / permuted[i] for i in range(3))
        # Fraction of the target box filled by the uniformly scaled mesh. The
        # orientation that wastes least space is the one that matches.
        fill = (scale ** 3 * permuted[0] * permuted[1] * permuted[2]) / (
            target[0] * target[1] * target[2]
        )
        if best is None or fill > best[0]:
            best = (fill, perm, permuted)

    if best is None:
        return Matrix.Identity(4), list(dims)

    _, perm, permuted = best

    # Build the matrix sending source axis perm[i] to target axis i.
    rot = Matrix.Identity(3)
    rot.zero()
    for i, src in enumerate(perm):
        rot[i][src] = 1.0

    # Half the permutations are reflections. Negating a row restores a positive
    # determinant, turning it back into a true rotation - otherwise the mesh
    # would come out mirrored, which on asymmetric furniture is very visible.
    if rot.determinant() < 0:
        for col in range(3):
            rot[0][col] = -rot[0][col]

    return rot.to_4x4(), permuted


def make_material(name, rgba, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = roughness
        # Walls and floors are dielectric; leaving metallic at its default
        # would make the room render like a steel box under image-based light.
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


# --------------------------------------------------------------------------
# the room shell
# --------------------------------------------------------------------------
def build_room(room):
    """Create floor, walls and optional ceiling as one mesh named `room_shell`.

    Generated rather than reconstructed on purpose: six boxes give exact right
    angles, flat faces, correct normals and a couple of kilobytes, where a
    reconstructed room gives wavy holed geometry and megabytes.
    """
    w = float(room["width"])
    d = float(room["depth"])
    h = float(room["height"])
    t = float(room["wall_thickness"])

    # Interior spans x in [-w/2, w/2], y in [-d/2, d/2], z in [0, h].
    # The X walls run the full depth including corners; the Y walls butt into
    # them at exactly w, so no two boxes overlap and the shell stays manifold.
    available = {
        "-x": ((-(w + t) / 2.0, 0.0, h / 2.0), (t, d + 2 * t, h)),
        "+x": ((+(w + t) / 2.0, 0.0, h / 2.0), (t, d + 2 * t, h)),
        "-y": ((0.0, -(d + t) / 2.0, h / 2.0), (w, t, h)),
        "+y": ((0.0, +(d + t) / 2.0, h / 2.0), (w, t, h)),
    }
    wanted = room.get("walls") or ["-x", "+y"]

    parts = [((0.0, 0.0, -t / 2.0), (w + 2 * t, d + 2 * t, t))]       # floor
    for key in wanted:
        if key in available:
            parts.append(available[key])
    if room.get("with_ceiling", False):
        parts.append(((0.0, 0.0, h + t / 2.0), (w + 2 * t, d + 2 * t, t)))
    print(f"walls: {', '.join(wanted) if wanted else 'none'}")

    verts, faces = [], []
    for center, size in parts:
        v, f = box_geometry(center, size, index_offset=len(verts))
        verts.extend(v)
        faces.extend(f)

    mesh = bpy.data.meshes.new("room_shell")
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()

    obj = bpy.data.objects.new("room_shell", mesh)
    obj.data.materials.append(make_material("room_surface", (0.82, 0.80, 0.76, 1.0)))
    bpy.context.collection.objects.link(obj)
    return obj


# --------------------------------------------------------------------------
# furniture
# --------------------------------------------------------------------------
def import_mesh(path):
    """Import a mesh file and return only the objects it added."""
    before = set(bpy.data.objects)

    suffix = path.suffix.lower()
    if suffix in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    else:
        raise ValueError(f"unsupported mesh type: {path.suffix}")

    added = [o for o in bpy.data.objects if o not in before]
    if not added:
        raise RuntimeError(f"{path.name} imported no objects")
    return added


def place_billboard(entry):
    """Build a textured quad for a flat object, straight from its source crop.

    Paintings, curtains and rugs have essentially no depth. Reconstruction
    gives them one anyway - a lumpy volumetric blob - and fitting that blob
    into a 5 cm-deep target shrinks the whole thing to a 6 cm lump, which is
    how a 0.9 m painting ended up the size of a matchbox.

    A quad carrying the original pixels is both more faithful and far cheaper:
    two triangles instead of twenty thousand.
    """
    name = entry["name"]
    image_path = Path(entry["mesh"])
    w, _, h = [float(v) for v in entry["size"]]
    pos = [float(v) for v in entry["position"]]
    yaw = float(entry.get("rotation_z", 0.0))

    # Upright quad in the XZ plane, normal facing -Y, base at z=0. rotation_z
    # then turns it to face into the room from whichever wall it hangs on.
    verts = [(-w / 2, 0.0, 0.0), (w / 2, 0.0, 0.0), (w / 2, 0.0, h), (-w / 2, 0.0, h)]
    mesh = bpy.data.meshes.new(f"{name}_panel")
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.validate()
    mesh.update()

    uv = mesh.uv_layers.new(name="UVMap")
    for loop_index, coord in enumerate([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]):
        uv.data[loop_index].uv = coord

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

    material = bpy.data.materials.new(f"{name}_mat")
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    tex = material.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(str(image_path))
    material.node_tree.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
    bsdf.inputs["Roughness"].default_value = 0.8
    bsdf.inputs["Metallic"].default_value = 0.0
    mesh.materials.append(material)

    obj.rotation_euler = (0.0, 0.0, math.radians(yaw))
    obj.location = (pos[0], pos[1], pos[2])
    bpy.context.view_layer.update()

    print(f"  panel  {name:16s} {w:.2f} x {h:.2f} m "
          f"at ({pos[0]:.2f}, {pos[1]:.2f}, {pos[2]:.2f})  yaw {yaw:g}")
    return obj


def decimate(objects, ratio):
    """Add a Decimate modifier to every mesh, baked in by export_apply.

    Reconstructed furniture is dense - a single TripoSR chair runs to ~80k
    triangles, which is fine in Blender and painful over the wire. Collapse
    decimation keeps the silhouette and UVs usable down to roughly 0.2.

    The room shell is deliberately never decimated: it is six boxes, already
    minimal, and collapsing it would put diagonal creases in flat walls.
    """
    for obj in objects:
        if obj.type != "MESH":
            continue
        modifier = obj.modifiers.new(name="dreamspace_decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio


def place_object(entry):
    """Import one furniture item, scale it to real size, rotate and position it.

    Every image-to-3D model normalises its output into a unit cube, so an
    imported bed and an imported lamp arrive the same size. This is where the
    spec's metres are actually imposed on the geometry.
    """
    name = entry["name"]
    path = Path(entry["mesh"])
    target = [float(v) for v in entry["size"]]
    pos = [float(v) for v in entry["position"]]
    yaw = float(entry.get("rotation_z", 0.0))

    added = import_mesh(path)
    if entry.get("_decimate"):
        decimate(added, float(entry["_decimate"]))

    # Group under a named empty rather than joining the meshes. Joining would
    # need operator context juggling and would flatten the material split; an
    # empty keeps the import intact and leaves a named node in the exported
    # GLB, which is what lets a viewer select "bed" as one thing.
    holder = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(holder)

    for obj in added:
        if obj.parent is None:
            obj.parent = holder

    bpy.context.view_layer.update()

    bounds = world_bounds(added)
    if bounds is None:
        raise RuntimeError(f"{name}: imported file contains no mesh data")
    raw = bounds[1] - bounds[0]
    if max(raw) <= 1e-9:
        raise RuntimeError(f"{name}: mesh has zero extent in every axis")

    if entry.get("auto_orient", True):
        orient, oriented = best_orientation([raw.x, raw.y, raw.z], target)
    else:
        orient, oriented = Matrix.Identity(4), [raw.x, raw.y, raw.z]

    # Fit into the target box, allowing a bounded amount of stretch.
    #
    # Strictly uniform scaling is bound by whichever axis reaches its target
    # first, which is punishing when the mesh has the wrong proportions - and
    # reconstructed furniture usually does. A wardrobe whose blob is nearly
    # cubic came out 0.89 x 0.60 x 0.75 m against a 1.20 x 0.60 x 2.30 target,
    # because its depth pinned every other axis.
    #
    # So the tightest axis still sets the floor, and the others may scale up to
    # `stretch` times that - never past their own target. At 1.0 this is exactly
    # uniform; the distortion is capped at `stretch`:1 rather than unbounded.
    ideal = [target[i] / oriented[i] for i in range(3)]
    tightest = min(ideal)
    stretch = max(1.0, float(entry.get("_max_stretch") or 1.0))
    scales = [min(ideal[i], tightest * stretch) for i in range(3)]

    # Order matters: `orient` maps the mesh's axes onto the target's, and
    # `scales` is expressed per target axis, so the scale has to be applied
    # after the reorientation. Yaw comes last, so a bed turned 90 degrees keeps
    # its length instead of being resized to its own rotated bounding box.
    # (`orient` is a signed permutation, so this still decomposes exactly into
    # Blender's rotation-then-scale object transform.)
    holder.matrix_basis = (
        Matrix.Rotation(math.radians(yaw), 4, "Z")
        @ Matrix.Diagonal((*scales, 1.0))
        @ orient
    )
    bpy.context.view_layer.update()

    # Position from the final bounds: centred on x/y, resting on z.
    lo, hi = world_bounds(added)
    centre = (lo + hi) / 2.0
    holder.location = (
        holder.location.x + (pos[0] - centre.x),
        holder.location.y + (pos[1] - centre.y),
        holder.location.z + (pos[2] - lo.z),
    )
    bpy.context.view_layer.update()

    fitted = [oriented[i] * scales[i] for i in range(3)]
    note = "" if orient == Matrix.Identity(4) else "  (reoriented)"
    if max(scales) > min(scales) * 1.01:
        note += f"  (stretch {max(scales) / min(scales):.2f}x)"
    print(f"  placed {name:16s} {fitted[0]:.2f} x {fitted[1]:.2f} x {fitted[2]:.2f} m "
          f"at ({pos[0]:.2f}, {pos[1]:.2f}, {pos[2]:.2f}){note}")
    return holder


# --------------------------------------------------------------------------
def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = {}
    for i in range(0, len(argv) - 1, 2):
        args[argv[i].lstrip("-")] = argv[i + 1]
    if "spec" not in args or "out" not in args:
        raise SystemExit("usage: -- --spec scene.json --out scene.glb "
                         "[--decimate 0.3] [--max-stretch 1.5]")
    ratio = float(args["decimate"]) if args.get("decimate") else None
    stretch = float(args["max-stretch"]) if args.get("max-stretch") else 1.0
    return Path(args["spec"]), Path(args["out"]), ratio, stretch


def main():
    spec_path, out_path, ratio, stretch = parse_args()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    # Start from a genuinely empty file. Blender's startup scene ships a cube,
    # a camera and a light, all of which would otherwise land in the export.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.length_unit = "METERS"

    room = spec.get("room", {})
    print(f"room: {room.get('width')} x {room.get('depth')} x {room.get('height')} m")
    build_room(room)

    if ratio:
        print(f"decimating furniture to {ratio:g} of original triangles")
    if stretch > 1.0:
        print(f"allowing up to {stretch:g}x stretch to reach target sizes")
    for entry in spec.get("objects", []):
        # Passed via the entry rather than the spec file: how aggressively to
        # compress for delivery, and how much distortion to tolerate, are build
        # options rather than part of the scene description.
        entry["_decimate"] = ratio
        entry["_max_stretch"] = stretch
        if entry.get("kind") == "billboard":
            place_billboard(entry)
        else:
            place_object(entry)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        export_format="GLB",
        # Bake modifiers and object transforms into the exported vertices, so
        # the scale and placement computed above survive as geometry rather
        # than as node transforms a consumer might ignore.
        export_apply=True,
        export_yup=True,          # glTF is Y-up; Blender is Z-up
        use_selection=False,
    )

    size_mb = out_path.stat().st_size / 1e6
    print(f"wrote {out_path} ({size_mb:.2f} MB)")
    print(SENTINEL)


if __name__ == "__main__":
    main()
