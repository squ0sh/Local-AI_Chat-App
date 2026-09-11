Local Models Folder
===================

Drop your own model files here to run them 100% offline (no API key, no
internet). The chat app scans this folder and registers valid files with the
portable Ollama library before listing them in the model selector.

Supported: .gguf (single-file and named multi-shard sets)

How to use
----------
1. Download a GGUF model (e.g. from huggingface.co or ollama.com) and place the
   .gguf file in this folder.
   Example:  chat-app/models/gemma3-1b.gguf

2. Start the chat app with start-portable.sh or start-portable.cmd.

3. On startup the app auto-registers any .gguf here with the bundled local
   Ollama instance, so the model appears in the model dropdown ready to use.

Notes
-----
- The matching bundled Ollama binary under runtime/platforms/ is used; a
  system Ollama installation is not required.
- Use a small quantized model (Q4_K_M or Q5_K_M) for best CPU performance.
- You can also use Model library > Import / explore, or trigger a manual import:
    POST /api/models/register
    { "source": "gemma3-1b", "model": "gemma3-1b" }
