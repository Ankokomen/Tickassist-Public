"""TickAssist - a portable, local ticket-handling tool.

Package layout (dependencies only point down this list):

    main.py      command line entry: single instance, auto-update, serve
    web/         HTTP: router, request handler, one module of routes per area
    app.py       composition root: builds every service once and wires them
    services/    behaviour that talks to the outside world or combines stores
                 (features, calls from MAX, D365, sheets, AI Polish, updates...)
    storage/     persistence: the stores behind one Store facade
    domain/      plain definitions and rules: ticket fields, lists, settings
    config.py    paths and version - no imports from the package

A copy may also carry dev/, an optional package the layers above pick up
when it is there (config.dev).

Standard library only, so the vendored embeddable Python runs it as is.
"""
