"""Moved to ``navide_plugin_sdk.fs_write``, which plugin backends bundle.

The core backend keeps importing it by this name. This module replaces itself
with that one, so both names are one module object: a patch through either
reaches every caller.
"""

import sys

from navide_plugin_sdk import fs_write as _module

sys.modules[__name__] = _module
