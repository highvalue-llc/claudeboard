# ClaudeBoard v3 — Product Requirements Document

## Visión
ClaudeBoard es una CLI + dashboard web que permite orquestar equipos de agentes Claude Code en paralelo. El usuario describe lo que quiere construir, el sistema genera las tareas, las distribuye entre agentes y muestra el progreso en tiempo real en un tablero Kanban.

**Principios:**
- Sin API key — usa el CLI de `claude` con sesión de membresía (plan Max)
- Sin base de datos — todo en archivos JSON locales en `.claudeboard/` del proyecto
- Cross-platform — Windows y Mac
- Open source — publicable en npm y GitHub

---

## Flujo principal

```
npx claudeboard
→ Health check (claude instalado y autenticado?)
→ Selección de equipo (1 / 3 / 6 / 9 agentes)
→ Browser abre en localhost:PORT
→ Chat con Orquestador: "¿Qué querés construir?"
→ Orquestador lee archivos del proyecto (si existen)
→ Orquestador genera PRD + lista de tareas
→ Tareas aparecen en el Kanban automáticamente
→ Agentes ejecutan las tareas en paralelo
→ Agente Verificador testea cada tarea completada
→ Si falla → nueva tarea de fix creada automáticamente
→ Webhook opcional notifica cuando todo terminó
```

---

## Estado actual del código

### Lo que YA ESTÁ construido
- `bin/cli.js` — CLI con flags, health check de claude, selección de equipo interactiva
- `src/server.js` — Express + WebSocket, solo escucha en 127.0.0.1
- `src/store.js` — CRUD sobre JSON en `.claudeboard/` del directorio del usuario
- `src/scanner.js` — Escanea el proyecto (fileTree, techStack, PRD existente, README)
- `src/orchestrator.js` — Maneja conversación con el usuario, genera PRD y tareas, spawnea agentes
- `src/verifier.js` — Verifica tareas completadas, crea tareas de fix si falla
- `src/notifier.js` — Webhook POST en eventos de tareas
- `public/index.html` — Dashboard SPA: chat + Kanban + terminal en vivo
- `public/style.css` — Estilos HighValue brand (negro + #e3c69a dorado, Poppins)
- `public/app.js` — WebSocket client, Kanban, renderizado de markdown en chat

### Bugs conocidos a resolver
1. **Spawn de claude en Windows** — El mecanismo actual usa PowerShell para pipear el prompt. Verificar que `Get-Content | claude --print` funciona correctamente y que los agentes de tareas también ejecutan via este mecanismo.
2. **JSON de tareas** — Claude a veces genera JSON con comillas simples o comentarios. El parser ya tiene limpieza básica pero puede necesitar mejoras.
3. **Orquestador repite saludo** — Ya corregido con system prompt que indica "conversación en curso". Verificar que no vuelva a pasar.

---

## Arquitectura de spawn (CRÍTICO para Windows)

El mecanismo correcto para llamar a `claude --print` desde Node.js en Windows:

```js
// En src/orchestrator.js y src/verifier.js
function spawnClaude(prompt, cwd) {
  const tmpFile = path.join(os.tmpdir(), `cb-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt, { encoding: 'utf8' });

  let child;
  if (process.platform === 'win32') {
    // PowerShell pipe — única forma confiable en Windows
    const psCmd = `Get-Content -Raw -Encoding UTF8 '${tmpFile}' | claude --permission-mode bypassPermissions --print`;
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
  } else {
    child = spawn('sh', ['-c', `claude --permission-mode bypassPermissions --print < '${tmpFile}'`], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
  }
  child.on('close', () => { try { fs.unlinkSync(tmpFile); } catch (_) {} });
  return child;
}
```

---

## Features requeridas

### 1. Orquestador inteligente
- Al iniciar, lee el proyecto (scanner.js) y adapta el saludo:
  - Proyecto nuevo → "¿Qué querés construir?"
  - Proyecto existente → "Vi tu PRD. ¿Qué querés hacer ahora?"
- Genera PRD en markdown dentro de `<PRD>...</PRD>`
- Genera tareas en JSON dentro de `<TASKS>...</TASKS>`
- Responde SIEMPRE en español argentino
- NO repite el saludo en mensajes subsiguientes
- Si ya tiene suficiente contexto del primer mensaje → genera tareas directamente sin preguntar más
- System prompt debe incluir el árbol de archivos y PRD existente como contexto

### 2. Tareas en el Kanban
Columnas: **Pendiente → En Progreso → Verificando → Listo → Error**

Cada tarea tiene:
- Título, descripción, criterio de éxito, prioridad (high/medium/low)
- Estado actual
- Output en vivo del agente (click en card → mini terminal)
- Tiempo transcurrido

### 3. Agentes de tareas
- Máximo `maxAgents` en paralelo (configurado en el selector de equipo)
- Cada agente: ejecuta `claude --permission-mode bypassPermissions --print <prompt_de_tarea>`
- El prompt incluye: título, descripción, criterio de éxito, directorio de trabajo
- Output streameado via WebSocket al card de la tarea
- Timeout: 10 minutos por agente

### 4. Agente Verificador
- Se activa automáticamente cuando una tarea pasa a "done"
- Corre claude con instrucciones de verificar el criterio de éxito
- Si VERIFIED → tarea queda en ✅ Listo
- Si FAILED → crea nueva tarea "Fix: {título original}" en Backlog

### 5. Selección de equipo (al iniciar)
```
? Seleccioná tu equipo:
❯ 🧑‍💻  Solo Dev     — 1 agente    ~1x tokens
  👥  Small Team  — 3 agentes   ~3x tokens
  🚀  Full Team   — 6 agentes   ~6x tokens
  🏭  Enterprise  — 9 agentes   ~9x tokens
```
Usa readline nativo (sin dependencias externas). Guarda en `.claudeboard/config.json`.

### 6. Health check al iniciar
```
Verificando requisitos...
✅ Claude CLI encontrado
✅ Claude autenticado
✅ Node.js v24
✅ Proyecto escaneado: mi-proyecto (React + Express)

Iniciando ClaudeBoard...
```
- Si claude no está → error claro + instrucción, no stack trace
- Si claude no está autenticado → "Ejecutá: claude login"

### 7. Almacenamiento local por proyecto
```
.claudeboard/
├── prd.md        — PRD generado
├── tasks.json    — todas las tareas (historial)
├── agents.json   — sesiones de agentes activos
└── config.json   — webhook URL, maxAgents, etc.
```

### 8. Webhook (opcional)
- `claudeboard --webhook https://tu-url.com/hook`
- Se guarda en `.claudeboard/config.json`
- Dispara en: tarea completada, tarea fallida, PRD generado, todos los agentes terminados
- Payload: `{ event, taskTitle, status, timestamp, projectName }`
- Timeout: 5s, solo URLs https

### 9. Seguridad (es repo público)
- Servidor SOLO en 127.0.0.1, nunca 0.0.0.0
- `spawn()` siempre con array de args, nunca interpolación de string en shell
- `.claudeboard/` en `.gitignore`
- No loguear paths del sistema ni output completo de agentes (max 1MB)
- No hardcodear ningún valor

---

## CLI flags
```
claudeboard                    # Inicia en directorio actual
claudeboard --port 4000        # Puerto custom
claudeboard --open false       # No abrir browser automáticamente
claudeboard --webhook <url>    # URL de webhook
claudeboard --max-agents 5     # Max agentes paralelos (default 3)
```

---

## Stack
```json
{
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "open": "^10.1.0",
    "chalk": "^4.1.2",
    "commander": "^12.0.0"
  }
}
```
**Sin frameworks de frontend.** Vanilla JS + HTML + CSS.

---

## Design tokens (HighValue brand)
- Background: `#000000` / cards `#1a1a1a`
- Acento: `#e3c69a` (dorado cálido)
- Acento dim: `#d4b896`
- Texto: `#ffffff` / muted `rgba(255,255,255,0.7)`
- Border: `rgba(227,198,154,0.3)`
- Font: Poppins (Google Fonts)
- Border radius: `1rem`
- Animaciones: shimmer, pulse-glow en CTAs

---

## Criterio de éxito final
Ejecutar `node bin/cli.js` en cualquier directorio de proyecto:
1. Muestra health check ✅
2. Muestra selector de equipo
3. Abre browser en localhost:PORT
4. El chat del orquestador saluda en español
5. Al describir el proyecto, genera tareas en el Kanban
6. Las tareas se ejecutan con agentes Claude
7. El output aparece en vivo en el card
8. El verificador aprueba o crea fix automáticamente
9. Todo sin API key, solo con sesión de claude CLI
