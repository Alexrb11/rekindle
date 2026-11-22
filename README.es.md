# Herdr Codex Resume

**Para usuarios de Codex CLI en Herdr de escritorio para Windows.**

[Read in English](README.md)

Recupera los chats de Codex que dejaste abiertos en Herdr al volver a iniciar la aplicación después de reiniciar Windows. Cada panel recuerda su propio ID y abre la conversación en el mismo sitio.

## Instalación

Necesitas Herdr de escritorio con herdr-core, Codex CLI y una terminal de Herdr que cargue un perfil de PowerShell. [Herdr para Windows](https://herdr.dev/download/), [Codex CLI](https://developers.openai.com/codex/cli/)

1. Descarga y extrae el ZIP, o clona el código. Abre PowerShell en la carpeta del proyecto.
2. Ejecuta el instalador.

   ```powershell
   .\Install.ps1
   ```

3. Abre un panel nuevo de Codex desde Herdr. Escribe `/hooks` y marca como confiable el hook `SessionStart` que ejecuta `herdr-codex-session.ps1`. [Revisión de hooks de Codex](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
4. Envía un primer mensaje y deja el panel abierto para que se recupere en el siguiente arranque.

Si Windows bloquea el instalador descargado, revisa el archivo y ejecuta `Unblock-File -LiteralPath .\Install.ps1` antes de instalar. Puedes usar `.\Install.ps1 -WhatIf` para ver los archivos que modificará.

La restauración vuelve a abrir el chat y queda a la espera de que escribas. Si sales de Codex y mantienes abierto el panel, se conserva el último chat de ese panel. Las conversaciones de paneles que hayas cerrado siguen disponibles con `codex resume --all`.

## Desinstalación

```powershell
.\Install.ps1 -Uninstall
```

El desinstalador quita sus entradas del perfil y de los hooks. El historial permanece en Codex. La [guía en inglés](README.md) describe los perfiles personalizados, las versiones comprobadas y las pruebas.
