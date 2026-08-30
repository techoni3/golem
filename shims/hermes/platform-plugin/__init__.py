"""Golem platform adapter plugin — entry point for Hermes loader.

Hermes scans ~/.hermes/plugins/<name>/ for plugin.yaml + __init__.py
and calls register(ctx). The actual adapter lives in golem_platform/adapter.py.
"""

from .golem_platform.adapter import register

__all__ = ["register"]
