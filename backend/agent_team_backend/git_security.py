"""Moved to ``navide_plugin_sdk.git_security``, which plugin backends bundle.

The core backend keeps importing it by this name. This module replaces itself
with that one, so both names are one module object: a patch through either
reaches every caller.
"""

import sys

from navide_plugin_sdk import git_security as _module

sys.modules[__name__] = _module
