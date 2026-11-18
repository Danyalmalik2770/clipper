# Clipper Local-First Architecture

Clipper eliminates external servers by running two tightly coupled local layers inside Electron:

1. **Main Process (`electron/`)**: Manages local `yt-dlp` and `ffmpeg` subprocesses, rolling disk segments, `better-sqlite3`, Whisper ONNX inference (`@huggingface/transformers`), virality signal fusion, `.ass` subtitle compilation, and `1080x1920` MP4 rendering.
2. **Renderer Process (`src/`)**: Static-exported Next.js UI communicating with the Main process over typed `ipcRenderer` channels (`window.clipper`) and playing local MP4s directly via the custom `clipper-media://` protocol. Face detection executes on-device via `@mediapipe/tasks-vision`.
