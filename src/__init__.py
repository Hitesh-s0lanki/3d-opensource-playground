"""Image to 3D: single-object reconstruction, and room-scale scene assembly.

Layout, top to bottom - a request enters at the top and only ever moves down:

    main.py        the FastAPI app: middleware, error handling, router mount
    routes/        HTTP surface only - paths, status codes, auth dependency
    controllers/   one function per route; validates, orchestrates, shapes
                   the response. Knows about HTTP, knows nothing about models.
    services/      the actual work: Modal, the local backends, segmentation,
                   layout, Blender. Knows nothing about HTTP.
    schemas/       the data that crosses those lines, and scene.json itself
    cli/           the same services driven from a terminal instead

The GPU never runs here. `services/modal_service.py` hands the work to the
deployed Modal app (scripts/modal_app/hunyuan3d.py) and polls for the result,
so this process stays small enough to run on any box.
"""

__version__ = "0.3.0"
