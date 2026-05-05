"""Shared test setup for rex-loop dashboard tests."""
import sys
from pathlib import Path

PLUGIN_DIR = Path("/home/ubuntu/.hermes/hermes-agent/plugins/rex-loop/dashboard")
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))
