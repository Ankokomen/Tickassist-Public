class ListItemExistsError(Exception):
    """Adding a list entry whose name is already on the list."""


class MacroExistsError(Exception):
    """Adding a macro whose trigger already exists."""
