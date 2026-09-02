"""One function per route: validate, call services, shape the response.

Controllers are the only layer that knows about both HTTP and the pipeline.
They translate the services' own exceptions into status codes - which is why
those services raise domain errors (ModalUnavailable, CallNotFound) rather than
HTTPException, and stay usable from the CLI.

The rich Console the services want for progress goes to stderr here, so
generation logs land in the server's log rather than in a response body.
"""

from rich.console import Console

# Both the generation and the assembly routes hand back a binary mesh.
GLB_MEDIA_TYPE = "model/gltf-binary"

# stderr: uvicorn's own logging already owns stdout, and interleaving a
# progress rule with an access log line makes both unreadable.
console = Console(stderr=True)
