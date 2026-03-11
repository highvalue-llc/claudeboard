# Security Guidelines — ClaudeBoard

Este archivo es para los agentes y para el equipo de desarrollo.

## Reglas obligatorias (público en npm + GitHub)

### Nunca en el código
- No hardcodear tokens, API keys, webhooks, URLs privadas
- No logs de información sensible del usuario
- No exponer paths del sistema operativo en respuestas de API
- No `eval()`, no `new Function()`, no `vm.runInContext()` con input del usuario

### Sanitización de inputs
- Todo input del usuario que se pase al CLI de claude DEBE sanitizarse
- Escapar caracteres especiales del shell antes de pasarlos a `spawn()`
- Usar siempre `spawn()` con array de argumentos (NUNCA `exec()` con string interpolado)
- Validar y sanitizar nombres de tareas, rutas de archivos y cualquier config externa

### .gitignore obligatorio
```
.claudeboard/        # datos locales del usuario — NUNCA commitear
node_modules/
*.log
.env
.env.*
```

### Webhook / notificaciones
- La URL del webhook SOLO se guarda en `.claudeboard/config.json` (que está en .gitignore)
- Nunca en package.json ni en código fuente
- Validar que sea una URL https:// antes de hacer el POST
- Timeout en todas las llamadas HTTP (máx 5s)

### Servidor local
- El servidor SOLO escucha en `127.0.0.1` (localhost), NUNCA en `0.0.0.0`
- No exponer endpoints que ejecuten comandos arbitrarios
- Rate limit básico en WebSocket: máx 10 mensajes/segundo por conexión

### Procesos de claude
- Siempre usar `spawn()` con array de args, nunca interpolación de strings en shell
- Timeout máximo por agente: configurable, default 10 minutos
- Limpiar procesos huérfanos al cerrar el servidor (SIGTERM handler)

### Almacenamiento
- `.claudeboard/` en el directorio de trabajo del usuario, nunca en directorios del sistema
- No guardar el output completo de los agentes si supera 1MB (truncar)
- No guardar credenciales bajo ningún concepto

## Para el README público
Incluir sección de seguridad que explique:
- El servidor corre solo en localhost
- No se envía ningún dato a servidores externos (excepto webhook opcional configurado por el usuario)
- Los procesos de claude usan la sesión local del usuario
- Cómo reportar vulnerabilidades (abrir issue con tag [SECURITY])
