#!/usr/bin/env python
"""Checks for the pure logic - no GPU, no Blender, no model weights.

    python scripts/selftest.py

Covers the parts that have actually broken during development: spec
round-tripping, detection de-duplication, the camera model, and room sizing.
Deliberately plain asserts rather than pytest, so it runs in the project venv
with nothing extra installed.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

# The backend is imported as `src.…`, which means the repo root has to be on
# sys.path. Running a file inside scripts/ puts scripts/ there instead, so this
# has to be fixed up before the imports below - and doing it here means the
# checks run against a plain checkout, with no editable install needed.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.services.layout_service import (  # noqa: E402
    Camera, Prior, _auto_walls, _choose_wall, depth_from_height,
    estimate_layout, lookup_prior,
)
from src.schemas.scene import ObjectSpec, RoomSpec, SceneSpec  # noqa: E402
from src.services.segmentation_service import Detection, deduplicate  # noqa: E402

PASSED = 0
FAILED: list[str] = []


def check(label, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok    {label}")
    else:
        FAILED.append(f"{label}: {detail}")
        print(f"  FAIL  {label}  {detail}")


def expect_raises(label, exc, fn):
    try:
        fn()
    except exc:
        check(label, True)
    except Exception as other:                       # noqa: BLE001
        check(label, False, f"raised {type(other).__name__}, wanted {exc.__name__}")
    else:
        check(label, False, "did not raise")


# ---------------------------------------------------------------------------
print("\nspec")

spec = SceneSpec(
    name="t",
    room=RoomSpec(width=4, depth=3, height=2.7),
    objects=[ObjectSpec(name="bed", mesh="a.glb", position=(1, 2, 0),
                        size=(2.0, 1.6, 1.1))],
)
with tempfile.TemporaryDirectory() as tmp:
    path = spec.save(Path(tmp) / "s.json")
    reloaded = SceneSpec.load(path)
# JSON has no tuples; without coercion this comes back as lists and compares
# unequal, which silently broke the first round-trip test.
check("round-trips exactly", reloaded.to_dict() == spec.to_dict())
check("position stays a tuple", isinstance(reloaded.objects[0].position, tuple))

expect_raises("rejects duplicate names", ValueError, lambda: SceneSpec(
    objects=[ObjectSpec("a", "x.glb"), ObjectSpec("a", "y.glb")]).validate())
expect_raises("rejects zero width", ValueError,
              lambda: SceneSpec(room=RoomSpec(width=0)).validate())
expect_raises("rejects unknown wall", ValueError,
              lambda: RoomSpec(walls=("up",)).validate())
expect_raises("rejects a 2-component size", ValueError,
              lambda: ObjectSpec("a", "x.glb", size=(1, 2)))

# ---------------------------------------------------------------------------
print("\ndetection de-duplication")

big = Detection("wardrobe", 0.90, (0, 0, 100, 400))
same = Detection("cabinet", 0.80, (2, 2, 98, 398))       # same box, other word
inside = Detection("drawer", 0.50, (10, 10, 90, 200))    # nested
apart = Detection("bed", 0.70, (200, 0, 300, 400))       # elsewhere

kept = {d.label for d in deduplicate([big, same, inside, apart])}
check("drops a synonym on the same box", "cabinet" not in kept)
# Nesting is the failure mode IoU misses: a small box inside a large one has a
# small intersection over a large union, so it survives NMS.
check("drops a nested box", "drawer" not in kept)
check("keeps a separate object", "bed" in kept)
check("keeps the best-scoring box", "wardrobe" in kept)

# ---------------------------------------------------------------------------
print("\ncamera model")

camera = Camera(fov_x_deg=85.0)
focal = camera.focal_px(1400)
check("wide lens shortens focal length", 700 < focal < 800, f"focal={focal:.0f}")
# The measured case: a 2.3 m wardrobe spanning 390 px in the sample bedroom.
distance = depth_from_height(390, 2.30, focal)
check("wardrobe lands at a room-sized distance", 4.0 < distance < 5.0,
      f"{distance:.2f} m")
narrow = depth_from_height(390, 2.30, Camera(fov_x_deg=62).focal_px(1400))
check("a narrow lens pushes it too far", narrow > 6.0, f"{narrow:.2f} m")
check("zero pixel height is not a crash", depth_from_height(0, 2.3, focal) == float("inf"))

# ---------------------------------------------------------------------------
print("\npriors and walls")

check("matches a joined detector phrase",
      lookup_prior("wardrobe_cabinet").size == Prior((1.20, 0.60, 2.30)).size)
check("prefers the longer key",
      lookup_prior("lamp_pendant_light").mount == "ceiling")
check("paintings are flat", lookup_prior("painting").flat)
check("beds are not flat", not lookup_prior("bed").flat)
check("unknown words fall back", lookup_prior("zzz").size == (0.60, 0.60, 0.60))

check("far wall for a centred item", _choose_wall(0.0, ("-x", "+y")) == "+y")
check("side wall for an edge item", _choose_wall(0.9, ("+x", "+y")) == "+x")
# Hanging a picture on a wall that was never built leaves it floating.
check("never picks an unbuilt wall", _choose_wall(0.9, ("-x", "+y")) == "+y")
check("auto keeps the side with content",
      _auto_walls([("p", "m", None, 0.8, 1.5)]) == ("+x", "+y"))

# ---------------------------------------------------------------------------
print("\nroom sizing")

# A bed 1.27 m from the centre with 1.6 m of depth used to poke 0.35 m through
# the back wall, because the room was sized from object centres alone.
built = estimate_layout(
    [("bed", (400, 300, 1000, 770), "bed.glb")], (1400, 777),
    camera=Camera(), name="t", walls=("-x", "+y"),
)
bed = built.objects[0]
half_depth = built.room.depth / 2
front = abs(bed.position[1]) + bed.size[1] / 2
check("furniture fits inside the room", front <= half_depth + 1e-6,
      f"reaches {front:.2f} m, half-depth {half_depth:.2f}")
check("room is a plausible size", 2.0 < built.room.width < 12.0,
      f"{built.room.width:.2f} m")
check("floor objects rest on the floor", bed.position[2] == 0.0)

flat = estimate_layout(
    [("painting", (1000, 100, 1200, 320), "painting.png")], (1400, 777),
    camera=Camera(), name="t", walls=("+x", "+y"),
)
check("flat items become panels", flat.objects[0].kind == "billboard")
check("panels face into the room", flat.objects[0].rotation_z in (0.0, 90.0, -90.0, 180.0))

# ---------------------------------------------------------------------------
print("\nmarching cubes shim")

# PyMCubes returns vertices in array-index order (i, j, k); torchmcubes returns
# them reversed. TripoSR's isosurface.py unconditionally applies
# v_pos[..., [2, 1, 0]] to undo the torchmcubes ordering, so a shim that hands
# back index order makes that line reflect the mesh across x=z instead - which
# mirrors the model and inverts every normal. That shipped for a while, hidden
# behind FLIP_FACES=true, so it is worth a standing check.
import numpy as np
import torch
import trimesh

from src.services.backends.compat import install_torchmcubes_shim

install_torchmcubes_shim()
import torchmcubes

RES = 48
# Distinct value per axis, kept clear of the grid edges so the blob stays closed.
CENTRE = np.array([12.0, 24.0, 34.0])
ii, jj, kk = np.meshgrid(*(np.arange(RES),) * 3, indexing="ij")
sq = (ii - CENTRE[0]) ** 2 + (jj - CENTRE[1]) ** 2 + (kk - CENTRE[2]) ** 2
density = 100.0 * np.exp(-sq / (2 * 5.0**2))

# extract_mesh() passes -(density - threshold); MarchingCubeHelper.forward()
# negates a second time, so the field reaching marching_cubes is the raw offset.
verts, faces = torchmcubes.marching_cubes(torch.from_numpy(density - 25.0), 0.0)
v_pos = verts.numpy()[:, [2, 1, 0]]                  # isosurface.py's swizzle
mesh = trimesh.Trimesh(v_pos, faces.numpy(), process=False)

offset = float(np.linalg.norm(v_pos.mean(axis=0) - CENTRE))
check("shim survives TripoSR's [2,1,0] swizzle", offset < 0.5,
      f"blob landed {offset:.2f} voxels from where it was queried")
check("shim yields outward-facing normals", mesh.volume > 0,
      f"signed volume {mesh.volume:+.1f}; FLIP_FACES should not be needed")
check("shim mesh is closed", mesh.is_watertight)


# ---------------------------------------------------------------------------
# The API's own wiring: auth, validation and status codes. No GPU is involved -
# nothing here reaches modal_service, which is the point. What is being checked
# is that a bad request is refused at the edge rather than after Modal has been
# billed for it.
print()
print("api")

try:
    from fastapi.testclient import TestClient
except ImportError as exc:
    print(f"  skip  fastapi not installed ({exc})")
else:
    from src.config import Config  # noqa: E402
    from src.main import app  # noqa: E402
    from src.routes.dependencies import get_config  # noqa: E402

    app.dependency_overrides[get_config] = lambda: Config(api_token="s3cret")
    client = TestClient(app)
    auth = {"X-Dioramic-Token": "s3cret"}

    body = client.get("/health").json()
    check("health needs no token", body["status"] == "ok")
    check("health reports the auth requirement", body["auth_required"] is True)

    check("generate rejects a missing token",
          client.post("/generate", json={"image_b64": "aGk="}).status_code == 401)
    check("generate rejects a wrong token",
          client.post("/generate", json={"image_b64": "aGk="},
                      headers={"X-Dioramic-Token": "nope"}).status_code == 401)

    # Caught by GenerateRequest.image_bytes() before anything is queued.
    check("generate rejects unparseable base64",
          client.post("/generate", json={"image_b64": "not base64!"},
                      headers=auth).status_code == 400)
    check("generate rejects an out-of-range knob",
          client.post("/generate", json={"image_b64": "aGk=", "steps": 9999},
                      headers=auth).status_code == 422)
    check("result requires a call id",
          client.get("/result", headers=auth).status_code == 422)

    # SceneSpec.from_dict does this validation, and the controller turns its
    # ValueError into a 422 rather than letting it become a 500.
    check("assemble rejects a spec with a zero-sized room",
          client.post("/scenes/assemble",
                      json={"spec": {"room": {"width": 0}, "objects": []}},
                      headers=auth).status_code == 422)

    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
print()
if FAILED:
    print(f"{len(FAILED)} failed, {PASSED} passed")
    for item in FAILED:
        print(f"  {item}")
    sys.exit(1)
print(f"all {PASSED} checks passed")
