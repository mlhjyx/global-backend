"""Build-time, fail-loud patch for the pinned Crawl4AI egress broker."""

from pathlib import Path

TARGET = Path("/app/egress_broker.py")
MARKER = "# global-backend fake-IP fallback (R1-safety)"
PATCH = f"""

{MARKER}
from fakeip_resolver import make_resolver as _global_make_resolver
_resolve = _global_make_resolver(_resolve)
"""

source = TARGET.read_text(encoding="utf-8")
for required in ("def _resolve(host: str, port: int):", "def resolve_and_pin", "def set_egress_proxy"):
    if required not in source:
        raise SystemExit(f"pinned Crawl4AI egress contract changed: missing {required}")
if MARKER in source:
    raise SystemExit("fake-IP fallback patch already present unexpectedly")
TARGET.write_text(source + PATCH, encoding="utf-8")
compile(TARGET.read_text(encoding="utf-8"), str(TARGET), "exec")
