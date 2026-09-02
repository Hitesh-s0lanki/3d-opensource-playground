"""The work itself, with no HTTP anywhere in it.

Every module here is callable from a controller, from the CLI or from a test
with equal ease, which is the point of keeping FastAPI out of them.

Scene assembly deliberately splits in two, because Blender ships its own Python
(3.13 here) that cannot see this venv (3.10) and never will:

    services (venv) ──writes──> scene.json ──read by──> Blender (bpy)

Everything upstream of that JSON file is ordinary Python and testable without
Blender installed. Everything downstream is pure bpy and testable without a GPU.
`schemas/scene.py` defines the file that joins them.
"""
