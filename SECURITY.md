# Seguridad

SAGITARI ejecuta comandos, escribe archivos y maneja el navegador **con tus
permisos de usuario**. Eso es lo que lo hace útil y también lo que define qué
cuenta como vulnerabilidad.

## Cómo reportar

Usa **Security → Report a vulnerability** en este repositorio (aviso privado de
GitHub). No abras un issue público: el aviso privado permite arreglarlo y
publicar la versión antes de que el fallo esté a la vista.

Incluye, si puedes: versión (Ajustes ▸ Acerca de), sistema, pasos para
reproducirlo y qué esperabas que pasara. Si el fallo necesita una herramienta o
un nivel de permiso concreto, dilo: el motor de permisos es la pieza más
delicada del proyecto.

## Qué entra

- **Saltarse el motor de permisos**: ejecutar una herramienta marcada como
  «preguntar» o «bloquear» sin confirmación, o escalar de nivel por una vía que
  la interfaz no ofrece.
- **Escaparse del espacio de trabajo**: leer o escribir fuera de la carpeta del
  proyecto con las herramientas de archivos, `git`, checkpoints o adjuntos.
- **Filtrar secretos**: claves de API, tokens de MCP o cookies que acaben en
  logs, conversaciones, el rastro del turno o un mensaje al proveedor.
- **Actualizador**: aceptar una descarga sin la firma SHA-512 publicada, o
  instalar algo que no venga de la release oficial.
- **Superficie del renderer**: llegar a un IPC privilegiado desde contenido
  remoto (una página del navegador, un `SKILL.md` importado, markdown del modelo).

## Qué NO entra

- Que el agente pueda borrar tus archivos **si tú se lo permites** y la
  confirmación decía exactamente eso. La app promete enseñarte la orden literal
  antes de ejecutarla; si el texto que viste no coincidía con lo que se ejecutó,
  eso sí es un fallo.
- Que Windows SmartScreen avise al instalar: los binarios no están firmados
  (decisión del proyecto, no un descuido). Los hashes SHA-256 van en cada release.
- Fallos de un proveedor de modelos o de una web que el agente visite.

## Cómo se arregla

Un fallo de seguridad se arregla en una versión nueva, con la corrección
publicada en las notas y el crédito a quien lo reportó si lo quiere. La rama
`main` no se reescribe: el arreglo va hacia delante y el actualizador lo reparte.

---

# Security

SAGITARI runs commands, writes files and drives a browser **with your user
privileges**. That is the point, and it is also what defines a vulnerability.

Please report privately through **Security → Report a vulnerability** (GitHub
private advisory) — not as a public issue. In scope: bypassing the permission
engine, escaping the workspace, leaking API keys or MCP tokens into logs,
conversations or provider calls, accepting an update whose SHA-512 is not the
published one, and reaching a privileged IPC channel from remote content.

Out of scope: the agent deleting files **you allowed it to delete** with a
confirmation that said so; the unsigned-binary SmartScreen warning (a known
project decision, SHA-256 published per release); bugs in third-party providers.
