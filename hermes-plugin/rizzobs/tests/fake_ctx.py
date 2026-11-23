"""Minimal PluginContext double for registration tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


class FakeCtx:
    def __init__(self) -> None:
        self.tools: dict[str, dict[str, Any]] = {}
        self.hooks: dict[str, Callable] = {}
        self.hook_kwargs: dict[str, dict[str, Any]] = {}
        self.skills: dict[str, Path] = {}

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict,
        handler: Callable,
        check_fn=None,
        requires_env=None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        override: bool = False,
    ) -> None:
        if name in self.tools:
            raise ValueError(f"duplicate tool {name}")
        self.tools[name] = {
            "toolset": toolset,
            "schema": schema,
            "handler": handler,
            "description": description,
            "check_fn": check_fn,
            "requires_env": requires_env,
            "is_async": is_async,
            "emoji": emoji,
            "override": override,
        }

    def register_hook(self, name: str, fn: Callable, **kwargs: Any) -> None:
        self.hooks[name] = fn
        self.hook_kwargs[name] = kwargs

    def register_skill(self, name: str, path: Path) -> None:
        self.skills[name] = Path(path)
