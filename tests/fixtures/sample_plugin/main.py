import decky


class Helper:
    async def not_exposed(self):
        pass


class Plugin:
    counter: int = 0

    async def get_status(self) -> dict:
        """Report the plugin state.

        More detail that is not returned."""
        return {"counter": self.counter}

    async def set_volume(self, level: int, fade: float = 0.5, *, channel: str = "main"):
        return level

    async def log_many(self, *lines, **extra):
        pass

    def sync_helper(self):
        pass

    async def _main(self):
        pass

    async def _private(self):
        pass
