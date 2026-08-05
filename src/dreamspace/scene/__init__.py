"""Room-scale assembly: segmented objects + a room shell -> one GLB.

The pipeline deliberately splits in two, because Blender ships its own Python
(3.13 here) that cannot see this venv (3.10) and never will:

    dreamspace (venv) ──writes──> scene.json ──read by──> Blender (bpy)

Everything upstream of that JSON file is ordinary Python and testable without
Blender installed. Everything downstream is pure bpy and testable without a GPU.
`spec.py` defines the file that joins them.
"""
