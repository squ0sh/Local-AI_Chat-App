# Bundled runtime

This directory makes the Capsule self-contained across its supported desktop
targets. `index.json` lists the packaged versions and platforms.

- `platforms/<target>/node`: Node.js 26.8.1
- `platforms/<target>/ollama`: Ollama 0.33.3
- platform-specific portable CPU inference libraries
- `licenses/`: upstream license texts shipped with the runtimes

The launcher selects a matching target and never silently falls back to a host
installation. The bundled targets cover Windows, Linux, and macOS on x64 and
ARM64.

The CPU baseline is the portable compatibility path. Ollama may use compatible
GPU support available on the host, but a GPU is not required.
