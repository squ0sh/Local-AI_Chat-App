Local Models Folder
===================

Drop your own model files here to run them 100% offline (no API key, no
internet). The chat app scans this folder on startup and lists them in the
model selector.

Supported: .gguf  (and Ollama Modelfile.txt / *.modelfile)

How to use
----------
1. Download a GGUF model (e.g. from huggingface.co or ollama.com) and place the
   .gguf file in this folder.
   Example:  chat-app/models/gemma3-1b.gguf

2. Start the chat app (option 6 in the launcher, or `node server.mjs`).

3. On startup the app auto-registers any .gguf here with the bundled local
   Ollama instance, so the model appears in the model dropdown ready to use.

Notes
-----
- The bundled Ollama binary must be present (data/ollama/). The root launcher
  provides it for offline mode.
- Use a small quantized model (Q4_K_M or Q5_K_M) for best CPU performance.
- You can also trigger a manual import by name via:
    POST /api/models/register  { "name": "gemma3-1b" }
