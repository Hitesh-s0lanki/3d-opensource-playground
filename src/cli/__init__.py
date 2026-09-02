"""The same services, driven from a terminal instead of over HTTP.

These are thin by design: parse flags, call a service, render the result with
rich. Any logic that appears here and not in `services/` is logic the API
cannot reach.
"""
