from agent_team_backend.frozen_env import restore_bundled_library_path
restore_bundled_library_path()
from agent_team_backend.__main__ import main
import sys
sys.exit(main())
