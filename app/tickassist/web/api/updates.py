"""Health, and Settings > Updates."""

from ...services.update import restart
from ..http import HttpError
from ..router import Routes

routes = Routes()


@routes.get("/api/health")
def health(app, req):
    # app/db let a second launch recognise this exact instance.
    return {"status": "ok", "app": "TickAssist", "version": app.updates.current(),
            "running_version": app.updates.started_version, "db": app.store.identity}


def _without_zip_url(info):
    info.pop("zip_url", None)
    return info


@routes.get("/api/update/check")
def check(app, req):
    info = _without_zip_url(app.updates.check())
    info["restart_needed"] = app.updates.restart_needed()
    info["auto_message"] = app.updates.auto_message
    return info


@routes.get("/api/update/versions")
def versions(app, req):
    return {"current": app.updates.current(),
            "versions": [_without_zip_url(i) for i in app.updates.versions()]}


@routes.post("/api/update/apply")
def install_latest(app, req):
    return app.updates.install_latest()


@routes.post("/api/update/install-version")
def install_version(app, req):
    result = app.updates.install_version(req.json().get("version"))
    if result is None:
        raise HttpError(404, "That version isn't in the published list.")
    return result


@routes.post("/api/update/restart")
def restart_now(app, req):
    restart(app.config)
    return {"restarting": True}
