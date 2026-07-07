# Distribution & packaging

How satsearch ships to end users, and why it's built this way.

## The problem

satsearch is an Electron app that spawns a **Python GPU sidecar** — FastAPI/uvicorn
running PyTorch (CUDA) + SigLIP2. PyTorch with CUDA is ~2.5 GB of platform-specific
wheels, and the model is another ~3 GB. That mass has to reach the user somehow.

Two things make the naïve approach fail:

1. **A venv is not relocatable.** A virtualenv built on a CI machine hardcodes the build
   machine's interpreter path in `pyvenv.cfg` and its `bin/python` is a symlink to a base
   interpreter that doesn't exist on the user's box. Copying it into the installer produces
   a venv that imports nothing on first launch.
2. **The resources dir is read-only at runtime.** An AppImage is a read-only mount; an nsis
   install lives under `Program Files`. So we cannot create/repair a venv in place next to
   the app.

## The model: thin installer + first-run `uv` bootstrap

The installer ships:

- the Electron app (`out/**` in the asar),
- the **sidecar source** as `extraResources` (`sidecar/` — `pyproject.toml`, `uv.lock`,
  `.python-version`, `satsearch_sidecar/`), **without** any `.venv`,
- a bundled [`uv`](https://docs.astral.sh/uv/) binary (`resources/bin/uv[.exe]`, ~35 MB),
  downloaded per-OS at build time by [`scripts/fetch-uv.mjs`](../scripts/fetch-uv.mjs).

On **first launch** (`src/main/provision.ts`), the app runs:

```
uv sync --frozen --inexact --group gpu --project <resources>/sidecar
```

with every writable location redirected under `userData/runtime`:

| env var | location | holds |
|---|---|---|
| `UV_PROJECT_ENVIRONMENT` | `userData/runtime/venv` | the virtualenv |
| `UV_PYTHON_INSTALL_DIR` | `userData/runtime/python` | uv's managed CPython |
| `UV_CACHE_DIR` | `userData/runtime/uv-cache` | wheel cache |

uv downloads a relocatable managed CPython (python-build-standalone) and resolves the
correct CUDA torch wheels **for the user's machine** from the pinned `uv.lock`. The sidecar
is then spawned with `userData/runtime/venv`'s interpreter (`python -m satsearch_sidecar`,
cwd = the read-only source dir — the package resolves from cwd, nothing is written there).

### Idempotency & offline

`provision()` writes a `.provisioned` sentinel containing the `uv.lock` hash. On later
launches, if the venv exists and the hash matches, it returns the interpreter path
immediately — no network, fully offline. It re-syncs only when the venv is missing or the
lockfile changed (an app update).

Offline *first* run can't complete (it must download). That surfaces as a network-specific
HealthGate error with a **Retry** button (`sidecar:retry` IPC), not a crash.

### Progress UI

`uv` run over a pipe emits discrete step lines, not a byte percentage, so the big download
phase is honestly **indeterminate**. `parseUvLine()` maps uv's output to boot phases shown
on the HealthGate:

`Provisioning Python → Downloading GPU libraries (~2.5 GB) → Building environment`

then the sidecar's own stderr drives `Downloading model → Loading onto GPU → Warming up`
(these do report real percentages, via `parseBootLine()`).

## Platforms

Linux (**AppImage**) and Windows (**nsis**), both **NVIDIA CUDA only**. No macOS (no CUDA).
Because native artifacts (`uv`, `sharp`) are per-OS, each installer is built on its own
runner — you cannot cross-build. CI (`.github/workflows/release.yml`) builds both on a
`v*` tag and attaches them to a GitHub Release.

## Trade-offs

- **Small installer, deferred download.** First run needs internet and several minutes for
  ~5–6 GB; every run after is offline and fast. We chose this over a ~3 GB "fat" installer
  with a baked relocatable venv because the CUDA wheels are machine-specific and uv
  resolving them on the user's box is more robust than freezing one CUDA build for everyone.
- **No freezing (PyInstaller/Nuitka).** Freezing CUDA torch is ~2.6 GB anyway and fragile
  (per-release hidden-import and CUDA-.so babysitting). Shipping uv + a relocatable
  interpreter is simpler and reuses the lockfile we already maintain.
