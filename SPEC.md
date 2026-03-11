# ClaudeBoard v3 — Spec

## Concepto
CLI + Dashboard web para orquestar agentes Claude Code en equipos.
El agente hace todo: entrevista al usuario, genera el PRD, desglosa tareas, las distribuye, verifica resultados.

## Cómo arranca
```
npx claudeboard
```
1. Levanta un servidor local (puerto 3000)
2. Abre el browser automáticamente en localhost:3000
3. Muestra un chat de onboarding: "¿Qué querés construir?"
4. El Orchestrator Agent conversa con el usuario hasta tener suficiente contexto
5. Genera el PRD en markdown
6. Desglosa el PRD en tareas con prioridad, descripción, criterio de éxito
7. Puebla el Kanban board automáticamente
8. Lanza sub-agentes (claude CLI) para cada tarea según prioridad
9. Agente Verifier testea tareas completadas → aprueba o crea tarea de fix
10. Notificaciones via webhook configurable (Telegram, etc.)

## Stack
- **Runtime:** Node.js (>=18)
- **Backend:** Express + ws (WebSockets nativos)
- **Frontend:** Vanilla JS + HTML + CSS (sin frameworks, sin build step)
- **Storage:** JSON files en `.claudeboard/` dentro del proyecto del usuario
  - `prd.md` — PRD generado
  - `tasks.json` — todas las tareas
  - `agents.json` — sesiones de agentes activos
  - `config.json` — configuración del board
- **Claude:** claude CLI (sin API key — usa sesión de membresía)
- **Cross-platform:** Windows + Mac

## Estructura del proyecto
```
claudeboard-v3/
├── bin/
│   └── cli.js              # Entry point: `claudeboard` command
├── src/
│   ├── server.js           # Express + WebSocket server
│   ├── orchestrator.js     # Maneja claude CLI sessions (spawn)
│   ├── store.js            # CRUD sobre JSON files
│   ├── verifier.js         # Agente verificador de tareas
│   └── notifier.js         # Webhooks/Telegram notifications
├── public/
│   ├── index.html          # Dashboard SPA
│   ├── style.css           # HighValue brand: negro + #e3c69a
│   └── app.js              # Frontend JS (WebSocket client + UI)
├── package.json
└── README.md
```

## UI del Dashboard

### Layout
- **Sidebar izquierda:** Chat con el Orchestrator (onboarding + comandos)
- **Main panel:** Kanban board
- **Bottom drawer:** Output en vivo del agente seleccionado (mini terminal)

### Kanban columns
1. 📋 **Backlog** — tareas generadas, esperando asignación
2. ⚡ **En progreso** — agente trabajando, con output en vivo
3. 🔍 **Verificando** — agente verifier testeando
4. ✅ **Listo** — verificado y aprobado
5. ❌ **Error** — verificación fallida, necesita fix

### Task card
- Título de la tarea
- Descripción corta
- Agente asignado (avatar con número)
- Tiempo transcurrido
- Badge de estado
- Click → expande output en vivo (terminal stream)

## Orchestrator Agent
- Corre como proceso `claude --print` en background
- Recibe mensajes del usuario via WebSocket → stdin del proceso
- Devuelve respuestas via stdout → WebSocket al browser
- Cuando tiene suficiente contexto: genera PRD y llama a función interna `createTasks([])`
- `createTasks` puebla tasks.json y emite evento WebSocket `tasks:created`

## Sub-agentes
- Uno por tarea en progreso (máx configurable, default 3 paralelos)
- Cada uno: `claude --permission-mode bypassPermissions --print "<task prompt>"`
- stdout streameado via WebSocket al task card correspondiente
- Al terminar: emite `task:done` → Verifier Agent toma la tarea

## Verifier Agent
- Recibe tarea completada
- Corre `claude --print "Verify this task was completed correctly: <descripción> <criterio de éxito>. Check the files. If OK respond VERIFIED. If not, respond FAILED: <reason>"`
- Si VERIFIED → tarea pasa a ✅ Listo
- Si FAILED → crea nueva tarea en Backlog con descripción del fix

## Notificaciones
- Config en `.claudeboard/config.json`: `{ "webhook": "https://..." }`
- Eventos que notifican: task completada, task fallida, PRD generado, todos los agentes terminaron
- Payload simple: `{ event, taskTitle, status, timestamp }`

## Design tokens (HighValue brand)
- Background: #000000 / cards #1a1a1a
- Accent: #e3c69a (gold)
- Accent dim: #d4b896
- Text: #ffffff / muted rgba(255,255,255,0.7)
- Border: rgba(227,198,154,0.3)
- Font: Poppins (Google Fonts)
- Border radius: 1rem
- Shimmer + pulse-glow animations on CTAs

## CLI flags
```
claudeboard                    # Start in current dir
claudeboard --port 4000        # Custom port
claudeboard --open false       # Don't open browser
claudeboard --webhook <url>    # Set webhook URL
claudeboard --max-agents 5     # Max parallel agents (default 3)
```

## package.json
```json
{
  "name": "claudeboard",
  "version": "3.0.0",
  "description": "Visual orchestrator for Claude Code agent teams",
  "bin": { "claudeboard": "bin/cli.js" },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "open": "^10.1.0",
    "chalk": "^5.3.0",
    "commander": "^12.0.0"
  }
}
```
