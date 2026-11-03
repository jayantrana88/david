"""Test setup: config.py is imported without real settings. Set before any project import: the settings are
read from an empty temporary database, never the real one."""

import os
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(prefix="job_applier_tests_"), "settings.db")
