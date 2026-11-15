"""Moved to ``navide_plugin_sdk.plan_versions``, which plugin backends bundle.

The core backend keeps importing it by this name. This module replaces itself
with that one, so both names are one module object: a patch through either
reaches every caller.
"""

import sys

from navide_plugin_sdk import plan_versions as _module

sys.modules[__name__] = _module
