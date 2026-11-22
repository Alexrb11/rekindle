# Herdr Codex Resume

**For Codex CLI users running Herdr Desktop on Windows.**

[Leer en español](README.es.md)

Reopen the Codex chats you left in Herdr when you start the desktop app after a Windows reboot. Each pane remembers its own conversation ID and resumes it in place.

## Requirements

- Windows with Herdr Desktop, its local herdr-core, and Codex CLI.
- A Herdr shell running Windows PowerShell 5.1 or PowerShell 7. The Codex hook uses the Windows PowerShell executable.

The initial Windows 11 verification used Herdr Desktop 0.1.16, herdr-core 0.1.21, Codex CLI 0.171.0, and Windows PowerShell 5.1. [Herdr Desktop](https://herdr.dev/download/), [Codex CLI](https://developers.openai.com/codex/cli/)

## Install

1. Download and extract the release ZIP, or clone the source. Open PowerShell in the project folder.
2. Run the installer.

   ```powershell
   .\Install.ps1
   ```

3. Open a **new** Codex pane from the Herdr tab bar. Run `/hooks` and trust the `SessionStart` hook whose command runs `herdr-codex-session.ps1`. Codex asks for this once per hook definition. [Codex hook review](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
4. Send a message in that pane. Leave the pane open to bring the chat back on the next startup.

If Windows marks the downloaded installer as blocked, review the file, then run `Unblock-File -LiteralPath .\Install.ps1` before installing.

Run `.\Install.ps1 -WhatIf` to preview file changes. The installer uses `CODEX_HOME` when set, or `%USERPROFILE%\.codex`, and finds profiles for the installed PowerShell editions. For a custom setup, use `-CodexDirectory` and `-ProfilePaths`. For a symlinked profile, pass its target path. Run the installer again to update an existing installation.

## What comes back

The first message makes a new Codex chat available to resume. Herdr's Codex menu gives each pane an independent Codex process. The installer also gives plain `codex` the same behavior inside new Herdr PowerShell panes, where you have no existing alias or function for it. With a custom launcher, start Codex with `--no-daemon`. [Herdr program launch documentation](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md#programs-programsjson)

When herdr-core recreates a kept pane, the PowerShell profile runs `codex --no-daemon resume <id>`. It opens the chat and waits for your input. Closing the Herdr window leaves existing processes running. Closing a pane removes it from automatic recovery. If you exit Codex and leave its shell open, the pane still remembers its last chat. [Herdr terminal lifecycle](https://github.com/herdrdev/herdr-app/blob/v0.1.16/README.md)

For a conversation in a pane you already closed, use `codex resume --all` to choose it manually. For automatic recovery, use Herdr's local Windows panes and a PowerShell profile that loads at startup.

The integration stores the chat ID and the terminal process start time in the `codex.resume` label in herdr-core's local state. Codex keeps the conversation history in its own storage.

## Uninstall

```powershell
.\Install.ps1 -Uninstall
```

Use the same path options if you supplied them at install time. The installer removes its hook, runtime and profile blocks while preserving other profile code and hooks. Your conversations stay available through `codex resume`.

## Verify changes

```powershell
.\tests\Install.Tests.ps1
powershell.exe -NoProfile -File .\tests\Resume.Tests.ps1
```

The installer test uses temporary profiles and hook configurations. The restore test uses the installed [herdr-core CLI](https://herdr.dev/core/) with a separate state directory and a simulated Codex executable. It stops and starts that instance and checks that two panes each resume their exact ID. It can run without a Codex login.

Licensed under [MIT](LICENSE).
