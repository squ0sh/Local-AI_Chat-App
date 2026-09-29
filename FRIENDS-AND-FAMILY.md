# Capsule for friends and family

Capsule is an AI assistant that runs on your computer. Chatting with a model
you have already installed does not need a cloud AI account.

1. Get the ZIP for your computer from the [official release page](https://github.com/squ0sh/Local-AI_Chat-App/releases). Unzip it into a folder you can write to.
2. Follow your platform's line below. Your computer may ask whether to open downloaded software. Check the source; never turn off its security protections.
3. Capsule checks its protected files and prepares the local AI engine. The first start may offer to download a missing engine. That download needs internet access.
4. In **Model library**, choose the model marked **Best fit**. Check the displayed download size, approve it, and wait for **Ready to use**. Then pick it in the chat model menu and send a message.

| Your computer | Download and start |
| --- | --- |
| Windows | Windows x64 ZIP → Extract All → double-click `start-portable.cmd` |
| Mac with Intel processor | macOS Intel ZIP → extract → double-click `Local AI Chat.command` |
| Linux | Linux x64 ZIP → extract → open `Local AI Chat.desktop`; approve Allow Launching if your file manager requests it |

Keep the launcher window open. Your browser opens automatically; if not, visit
`http://127.0.0.1:5173`. Mac's launcher opens Terminal for you; no typing is
needed during normal startup. This release does not include Apple Silicon or
other ARM64 ZIPs.

Capsule is **not Apple-notarized**. Gatekeeper may block first launch; consult
[Apple's guidance](https://support.apple.com/en-us/102445) or ask the person
who shared it. Do not disable Gatekeeper or remove quarantine attributes.
The Capsule release signature is not Apple code signing.

On Linux, some file managers display desktop entries as text or require
Properties → Permissions → Allow executing and/or Allow Launching. Capsule
does not grant itself trust. If unsupported, open a terminal in the extracted
folder and run `bash start-portable.sh`. Use an executable filesystem, not a
noexec-mounted drive. Optional menu registration is explained in
`START HERE - Linux.txt`; each ZIP contains only its matching START HERE file.

**Verified release** means Capsule checked its protected app files against its
signed file list. It does not guarantee that your computer or a downloaded
model is safe. If Capsule says verification failed, stop using that copy and
download a fresh ZIP from the official release page.

If a model download stops, check your connection and available drive space,
then try the same model again; partial downloads can usually resume. If the
engine will not start, close Capsule, restart your computer, and try again.
If your computer is unsupported, or a system security warning cannot be
resolved by checking the source and publisher, ask the person who shared the
release for help. Never disable antivirus or operating-system protections.

Keep the Capsule folder if you want to keep your local models and data. The
`.portable` folder inside it holds chats, model files, and settings. Back it
up privately before replacing the app folder. To uninstall, close Capsule and
remove its folder after saving anything you want to keep. If you installed an
optional background service, uninstall that service using the app's advanced
instructions first.
