"""The scene description handed to Blender.

This module is the interface between the two halves of the pipeline, so it is
deliberately dependency-free: dataclasses, pathlib and json only. The Blender
side re-reads this same JSON with its own interpreter and must not import this
file, so the *format* is the contract - not these classes.

Conventions, fixed here once so nothing downstream has to guess:

* **Units are metres.** Every image-to-3D model emits meshes normalised into a
  unit cube, which makes a lamp and a wardrobe the same size. Real dimensions
  therefore have to be asserted somewhere, and this is that somewhere.
* **Z is up**, matching Blender. glTF is Y-up, but its exporter converts on the
  way out, so nothing here needs to pre-rotate.
* **The room's floor sits at z=0**, centred on the origin in x and y. Object
  positions are the centre of the object's footprint, so a bed at
  ``(0, 1.2, 0)`` rests on the floor 1.2 m along +y.
* **Rotation is yaw only**, in degrees about z. Furniture stands upright; a
  full quaternion would be three extra ways to get a sideways sofa.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

SCHEMA_VERSION = 1

Vec3 = tuple[float, float, float]


def _vec3(value, label: str) -> Vec3:
    """Coerce to a 3-tuple of floats.

    JSON has no tuple type, so a spec that round-trips through a file comes back
    with lists where it started with tuples. Normalising on construction keeps
    ``load(save(x)) == x`` true and means downstream code can always unpack
    three floats without checking what it was handed.
    """
    items = tuple(value)
    if len(items) != 3:
        raise ValueError(f"{label} must have 3 components, got {len(items)}")
    return (float(items[0]), float(items[1]), float(items[2]))


@dataclass
class SourceSpec:
    """Where an object came from in the photo it was found in.

    Nothing downstream reads this - the assembler has no use for pixels. It is
    recorded so a finished mesh can be traced back to the patch of the original
    image that produced it, which is the first thing anyone asks when a result
    looks wrong. Optional: a hand-written spec has no detector behind it.
    """

    image: str = ""               # the photo the object was detected in
    crop: str = ""                # the patch fed to the reconstructor
    label: str = ""               # what the detector called it, before uniquing
    score: float = 0.0            # detector confidence, 0-1
    box: tuple = (0.0, 0.0, 0.0, 0.0)   # x0, y0, x1, y1 in source pixels

    def __post_init__(self) -> None:
        items = tuple(float(v) for v in self.box)
        if len(items) != 4:
            raise ValueError(f"source.box needs 4 values, got {len(items)}")
        self.box = items
        self.score = float(self.score)


@dataclass
class ObjectSpec:
    """One piece of furniture: a mesh file plus where to put it."""

    name: str
    mesh: str                     # path to a .glb/.obj, absolute or repo-relative
    position: Vec3 = (0.0, 0.0, 0.0)
    size: Vec3 = (1.0, 1.0, 1.0)  # target bounding box (x, y, z) in metres
    rotation_z: float = 0.0       # degrees, counter-clockwise seen from above

    # Reconstructed meshes arrive in no particular orientation - TripoSR emits
    # chairs lying on their side - so the assembler reorients each mesh to
    # whichever axis permutation best matches `size` before scaling. Set False
    # when a mesh is already known-good and the shape is near-cubic, where the
    # best-fit choice is close to arbitrary.
    auto_orient: bool = True

    # "mesh"      - import `mesh` as geometry and fit it to `size`.
    # "billboard" - `mesh` is an IMAGE; build a textured quad of exactly `size`.
    #   Reconstructing a painting or a curtain produces a volumetric blob, and
    #   uniform-fitting that blob into a 5 cm-deep target collapses it to a
    #   6 cm lump. Flat things should be flat: a quad cut from the source crop
    #   looks better, weighs ~2 KB, and needs no reconstruction at all.
    kind: str = "mesh"

    # Provenance, not instruction. See SourceSpec.
    source: "SourceSpec | None" = None

    def __post_init__(self) -> None:
        self.position = _vec3(self.position, f"{self.name}.position")
        self.size = _vec3(self.size, f"{self.name}.size")
        self.rotation_z = float(self.rotation_z)
        # Reloading a saved spec hands this back as a plain dict, since JSON has
        # no way to say which dataclass a mapping came from.
        if isinstance(self.source, dict):
            self.source = SourceSpec(**self.source)

    def validate(self) -> None:
        if not self.name:
            raise ValueError("object needs a name")
        if any(d <= 0 for d in self.size):
            raise ValueError(f"{self.name}: size must be positive, got {self.size}")


@dataclass
class RoomSpec:
    """The shell: floor, ceiling and four walls, built procedurally.

    Walls are generated rather than reconstructed on purpose. A room is six
    boxes; generating them yields exact right angles, flat faces, correct
    normals and a couple of kilobytes. Reconstructed walls are wavy, holed and
    heavy - strictly worse output for strictly more work.
    """

    width: float = 4.0        # x extent, metres
    depth: float = 4.0        # y extent
    height: float = 2.7       # z extent, floor to ceiling
    wall_thickness: float = 0.1
    with_ceiling: bool = False

    # Which walls to build, from {"-x", "+x", "-y", "+y"}. Two by default:
    # a fully enclosed box is correct and also useless, because a viewer
    # orbiting outside it sees six blank faces and nothing of the room. Keeping
    # the far corner is the standard dollhouse cutaway.
    walls: tuple[str, ...] = ("-x", "+y")

    def validate(self) -> None:
        for label, value in (("width", self.width), ("depth", self.depth),
                             ("height", self.height)):
            if value <= 0:
                raise ValueError(f"room {label} must be positive, got {value}")
        if self.wall_thickness <= 0:
            raise ValueError("wall_thickness must be positive")
        self.walls = tuple(self.walls)
        unknown = set(self.walls) - {"-x", "+x", "-y", "+y"}
        if unknown:
            raise ValueError(f"unknown wall(s) {sorted(unknown)}; "
                             f"use any of -x, +x, -y, +y")


@dataclass
class SceneSpec:
    """A complete room, ready to assemble."""

    room: RoomSpec = field(default_factory=RoomSpec)
    objects: list[ObjectSpec] = field(default_factory=list)
    name: str = "scene"
    schema_version: int = SCHEMA_VERSION

    # -- validation ---------------------------------------------------------
    def validate(self) -> None:
        self.room.validate()
        seen: set[str] = set()
        for obj in self.objects:
            obj.validate()
            # Blender silently renames collisions to "bed.001", which would
            # quietly break any later lookup by name.
            if obj.name in seen:
                raise ValueError(f"duplicate object name: {obj.name!r}")
            seen.add(obj.name)

    # -- serialisation ------------------------------------------------------
    def to_dict(self) -> dict:
        return asdict(self)

    def save(self, path: Path) -> Path:
        self.validate()
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        return path

    @classmethod
    def from_dict(cls, data: dict) -> "SceneSpec":
        version = data.get("schema_version", SCHEMA_VERSION)
        if version != SCHEMA_VERSION:
            raise ValueError(
                f"scene.json is schema v{version}, this build expects "
                f"v{SCHEMA_VERSION}"
            )
        room = RoomSpec(**data.get("room", {}))
        objects = [ObjectSpec(**o) for o in data.get("objects", [])]
        spec = cls(room=room, objects=objects, name=data.get("name", "scene"))
        spec.validate()
        return spec

    @classmethod
    def load(cls, path: Path) -> "SceneSpec":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
