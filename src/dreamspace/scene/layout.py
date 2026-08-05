"""Turn 2D detections into a 3D room layout.

A single photo has no depth, so something has to supply the missing dimension.
Two assumptions do it, and they are the whole trick:

1. **Furniture has known real-world sizes.** A double bed is about 2.0 x 1.6 m
   whoever made it. `SIZE_PRIORS` is the scale oracle - without it every mesh
   would stay in the unit cube it was generated in.
2. **Floor-standing objects touch the floor.** So the bottom edge of a
   detection box is a point on the floor plane, and back-projecting it through
   a camera model gives a real position. Objects further away have their base
   higher in the frame; that is the entire depth cue, and it is a reliable one
   for interiors.

Neither assumption holds for a painting or a pendant light, so priors also
record how each thing is mounted and those are placed against a wall or the
ceiling instead.

The output is a plausible, editable starting layout - not a measurement. Treat
the numbers as a first draft a designer nudges, which is also why SceneSpec is
plain JSON.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .spec import ObjectSpec, RoomSpec, SceneSpec

FLOOR, WALL, CEILING = "floor", "wall", "ceiling"


def _mm(value: float) -> float:
    """Round to millimetres.

    Estimates carry no meaning past this, and the spec is meant to be opened
    and nudged by hand - a room 6.002087772034161 m wide invites nobody to
    edit it.
    """
    return round(float(value), 3)


@dataclass(frozen=True)
class Prior:
    """Typical real-world size (x, y, z in metres) and how the item is fixed."""

    size: tuple[float, float, float]
    mount: str = FLOOR
    # Flat things are built as textured quads from their source crop rather
    # than reconstructed. See ObjectSpec.kind for why.
    flat: bool = False


# Longest dimension first as (width, depth, height). These are ordinary
# furniture sizes, not precision figures - being within ~20% is enough to make
# a room read correctly, and the alternative is everything at unit scale.
SIZE_PRIORS: dict[str, Prior] = {
    "bed":              Prior((2.00, 1.60, 1.10)),
    "sofa":             Prior((2.00, 0.90, 0.85)),
    "bench":            Prior((1.40, 0.50, 0.45)),
    "wardrobe":         Prior((1.20, 0.60, 2.30)),
    "cabinet":          Prior((1.00, 0.55, 2.00)),
    "chest of drawers": Prior((1.00, 0.50, 0.80)),
    "chest":            Prior((1.00, 0.50, 0.80)),
    "nightstand":       Prior((0.50, 0.45, 0.55)),
    "desk":             Prior((1.40, 0.65, 0.75)),
    "table":            Prior((1.20, 0.80, 0.75)),
    "chair":            Prior((0.55, 0.55, 0.90)),
    "rug":              Prior((2.00, 1.40, 0.02)),
    "potted plant":     Prior((0.35, 0.35, 0.50)),
    "plant":            Prior((0.35, 0.35, 0.50)),
    "lamp":             Prior((0.30, 0.30, 0.45)),
    "pendant light":    Prior((0.25, 0.25, 0.40), mount=CEILING),
    "painting":         Prior((0.90, 0.05, 0.70), mount=WALL, flat=True),
    "curtain":          Prior((1.60, 0.10, 1.80), mount=WALL, flat=True),
    "window":           Prior((1.40, 0.10, 1.30), mount=WALL, flat=True),
    "mirror":           Prior((0.70, 0.05, 1.00), mount=WALL, flat=True),
}

DEFAULT_PRIOR = Prior((0.60, 0.60, 0.60))


def lookup_prior(name: str) -> Prior:
    """Best-matching prior for a detection name.

    Names arrive joined from the detector's own phrases - a wardrobe matched by
    two synonyms becomes "wardrobe_cabinet" - so this matches on substrings and
    prefers the longest key, letting "pendant light" win over "light".
    """
    key = name.lower().replace("_", " ")
    best = None
    for candidate, prior in SIZE_PRIORS.items():
        if candidate in key and (best is None or len(candidate) > len(best[0])):
            best = (candidate, prior)
    return best[1] if best else DEFAULT_PRIOR


def _auto_walls(mounted) -> tuple[str, ...]:
    """Keep the far wall plus whichever side wall actually holds something.

    Two walls, because a closed box shows a viewer nothing. Which two matters:
    keeping a bare wall while dropping the one with the artwork on it means the
    art has nowhere to hang, and it ends up on the wrong surface.
    """
    left = sum(1 for item in mounted if item[3] < -0.45)
    right = sum(1 for item in mounted if item[3] > 0.45)
    return (("+x" if right > left else "-x"), "+y")


def _choose_wall(lateral: float, walls) -> str:
    """Pick a wall for a mounted item from `lateral` in -1 (left) .. +1 (right).

    Only walls that are actually being built are eligible - hanging a painting
    on an omitted wall would leave it floating in mid-air.
    """
    walls = list(walls) or ["+y"]
    if lateral < -0.45 and "-x" in walls:
        return "-x"
    if lateral > 0.45 and "+x" in walls:
        return "+x"
    if "+y" in walls:
        return "+y"
    return walls[0]


def _wall_placement(wall: str, lateral: float, room_width: float,
                    room_depth: float, inset: float):
    """Position and yaw for an item on `wall`, facing into the room.

    A panel is authored facing -Y, so yaw turns it to face inward: 0 on the far
    wall, 180 on the near one, +/-90 on the sides.
    """
    half_w, half_d = room_width / 2.0, room_depth / 2.0
    along = lateral * half_w * 0.8         # position along a front/back wall

    if wall == "+y":
        return along, half_d - inset, 0.0
    if wall == "-y":
        return along, -half_d + inset, 180.0
    if wall == "-x":
        # Side walls give no depth cue from a single view, so centre the item
        # along the wall rather than invent a position.
        return -half_w + inset, 0.0, 90.0
    return half_w - inset, 0.0, -90.0      # "+x"


@dataclass
class Camera:
    """A simple pinhole camera looking into the room.

    The default field of view is wide on purpose. Interior renders and estate
    photography use 85-95 degree lenses to make rooms look spacious, where a
    photographic default of ~60 would be normal for anything else - and the
    assumed FOV sets the scale of the whole room. Measured on the sample
    bedroom, 62 degrees put the wardrobe 6.9 m away and produced a 9 x 10 m
    "bedroom"; 85 degrees puts it at 4.5 m, which is a real room.
    """

    fov_x_deg: float = 85.0
    height: float = 1.35
    pitch_deg: float = 0.0

    def focal_px(self, image_width: int) -> float:
        return (image_width / 2.0) / math.tan(math.radians(self.fov_x_deg) / 2.0)


def floor_point(u: float, v: float, image_size, camera: Camera):
    """Back-project a pixel onto the floor plane.

    Returns (lateral, forward) in metres relative to the camera, or None if the
    ray points at or above the horizon - which happens for anything not
    actually standing on the floor, and is the signal to place it another way.
    """
    width, height = image_size
    f = camera.focal_px(width)
    cx, cy = width / 2.0, height / 2.0

    # Ray through the pixel in camera coordinates (x right, y down, z forward).
    dx, dy, dz = (u - cx) / f, (v - cy) / f, 1.0

    # Apply pitch: rotate the ray about the camera's x axis.
    pitch = math.radians(camera.pitch_deg)
    cos_p, sin_p = math.cos(pitch), math.sin(pitch)
    dy, dz = dy * cos_p + dz * sin_p, -dy * sin_p + dz * cos_p

    if dy <= 1e-6:                     # at or above the horizon: never lands
        return None

    t = camera.height / dy
    return t * dx, t * dz


def depth_from_height(pixel_height: float, real_height: float, focal: float) -> float:
    """Distance to an object of known height spanning `pixel_height` pixels.

    Preferred over back-projecting the box's bottom edge, for two reasons.

    Projected *height* is unaffected by yaw - an upright wardrobe covers the
    same vertical span whichever way it faces - whereas projected width shrinks
    as an object turns, which would read as extra distance.

    More importantly it survives occlusion of the base. In the sample bedroom
    the wardrobe stands behind the bed, so the bottom of its detection box is
    where the duvet begins, not where the wardrobe meets the floor. Treating
    that as a floor contact point put it 13 m away.
    """
    if pixel_height <= 1e-6:
        return float("inf")
    return focal * real_height / pixel_height


def estimate_layout(
    items,
    image_size,
    *,
    camera: Camera | None = None,
    name: str = "scene",
    margin: float = 0.45,
    room_height: float = 2.70,
    min_room: float = 2.5,
    max_depth: float = 9.0,
    walls="auto",
) -> SceneSpec:
    """Build a SceneSpec from detections.

    `items` is an iterable of (name, box, mesh_path) where box is the pixel
    (x0, y0, x1, y1) from segmentation.
    """
    camera = camera or Camera()
    width, height = image_size
    focal = camera.focal_px(width)
    horizon_v = height / 2.0 + math.tan(math.radians(camera.pitch_deg)) * focal

    placed = []          # (name, mesh, prior, lateral, forward)
    mounted = []         # (name, mesh, prior, lateral, z)

    for obj_name, box, mesh in items:
        x0, y0, x1, y1 = box
        u = (x0 + x1) / 2.0
        prior = lookup_prior(obj_name)

        # A floor-standing item whose box ends above the horizon is not on the
        # floor: it is a wall unit the prior guessed wrong about, like the
        # cupboards above a window. Reclassify rather than place it at infinity.
        on_floor = prior.mount == FLOOR and y1 > horizon_v + 1.0

        if on_floor:
            depth = depth_from_height(y1 - y0, prior.size[2], focal)
            # A single bad box should not stretch the room to the horizon.
            depth = min(depth, max_depth)
            lateral = (u - width / 2.0) * depth / focal
            placed.append((obj_name, mesh, prior, lateral, depth))
            continue

        # Wall and ceiling items get their height from where they sit in frame,
        # read as a simple fraction of the image: the top of the frame is the
        # ceiling, the bottom is the floor. Crude, but it puts paintings above
        # beds and pendants near the ceiling, which is what matters visually.
        centre_v = (y0 + y1) / 2.0
        z = room_height * (1.0 - centre_v / height)
        lateral = (u - width / 2.0) / (width / 2.0)     # -1 .. +1 across frame
        mounted.append((obj_name, mesh, prior, lateral, z))

    # Size the room around what landed on the floor, counting each object's
    # footprint rather than just its centre. Sizing on centres alone lets a bed
    # 1.27 m from the middle of a 3.44 m room push 0.35 m through the back wall,
    # because half its 1.6 m depth is more than the margin.
    if placed:
        x_lo = min(p[3] - p[2].size[0] / 2 for p in placed)
        x_hi = max(p[3] + p[2].size[0] / 2 for p in placed)
        y_lo = min(p[4] - p[2].size[1] / 2 for p in placed)
        y_hi = max(p[4] + p[2].size[1] / 2 for p in placed)

        half_w = max(max(abs(x_lo), abs(x_hi)) + margin, min_room / 2)
        near, far = y_lo - margin, y_hi + margin
    else:
        half_w, near, far = min_room / 2, 0.0, min_room

    room_width = half_w * 2
    room_depth = max(far - near, min_room)
    # Rebase forward distances onto a room centred on the origin.
    y_centre = (near + far) / 2.0

    objects = []
    for obj_name, mesh, prior, lateral, forward in placed:
        objects.append(ObjectSpec(
            name=obj_name,
            mesh=str(mesh),
            position=(_mm(lateral), _mm(forward - y_centre), 0.0),
            size=prior.size,
        ))

    if isinstance(walls, str):
        walls = _auto_walls(mounted) if walls == "auto" else (walls,)

    inset = 0.02          # sit just clear of the wall, avoiding z-fighting
    for obj_name, mesh, prior, lateral, z in mounted:
        if prior.mount == CEILING:
            objects.append(ObjectSpec(
                name=obj_name,
                mesh=str(mesh),
                position=(_mm(lateral * room_width / 2.0 * 0.8), 0.0,
                          _mm(room_height - prior.size[2])),
                size=prior.size,
            ))
            continue

        # Which wall? Read it off the horizontal position in frame: things near
        # the edges are on the side walls, things in the middle on the far one.
        # Putting everything on the far wall - as this used to - hangs pictures
        # from the wrong surface, which is glaring in a viewer.
        wall = _choose_wall(lateral, walls)
        x, y, yaw = _wall_placement(wall, lateral, room_width, room_depth, inset)

        # `position.z` is the base of an object, so a panel's height is
        # measured from its bottom edge, not its centre.
        base = max(0.0, z - prior.size[2] / 2.0)
        objects.append(ObjectSpec(
            name=obj_name,
            mesh=str(mesh),
            position=(_mm(x), _mm(y), _mm(base)),
            size=prior.size,
            rotation_z=yaw,
            kind="billboard" if prior.flat else "mesh",
        ))

    spec = SceneSpec(
        name=name,
        room=RoomSpec(width=_mm(room_width), depth=_mm(room_depth),
                      height=room_height, with_ceiling=False,
                      walls=tuple(walls)),
        objects=objects,
    )
    spec.validate()
    return spec
