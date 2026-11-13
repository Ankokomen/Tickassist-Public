"""The composition root: every service is built here, once, and wired together.

Nothing else creates services or holds module-level state, so a test can
build an App around a temporary data folder and drive it directly.
"""

from . import storage
from .services import owner as owner_file
from .services.callwatch import Calls
from .services.d365 import D365Client
from .services.features import SETTING as FEATURES_SETTING, Features
from .services.lists import Lists
from .services.settings import Settings
from .services.update import Updates


class App:
    def __init__(self, config, store=None, owner=None):
        self.config = config
        self.store = store or storage.open_store(config)
        # The office build's owner file: feature defaults and shared settings.
        self.owner = owner_file.load(config.owner_file) if owner is None else owner
        self.settings = Settings(self.store.settings, owner_file.office_settings(self.owner))
        self.settings.retire_old_defaults()
        extra, updates = (), Updates
        if config.dev:
            from . import dev
            extra, updates = dev.FEATURES, dev.Updates
        self.features = Features(self.owner, extra)
        self.lists = Lists(self.store.lists, self.settings)
        self.calls = Calls()
        self.crm = D365Client(self.settings)
        self.updates = updates(config, self.settings)

    def feature_on(self, key):
        return self.features.enabled(self.settings.all(), key)

    def apply_office_push(self):
        """A pending owner "push to every PC": forget this PC's own copies, once."""
        return owner_file.apply_push(self.settings, self.owner, FEATURES_SETTING)

    def configure_calls(self, settings=None):
        self.calls.configure(settings or self.settings.all(), self.features)

    def shutdown(self):
        self.calls.stop()
