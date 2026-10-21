# Documentación

Los dos documentos de diseño del proyecto viven en la raíz; aquí está el resto.

| Documento | Qué es |
| --- | --- |
| [../DESIGN.md](../DESIGN.md) | Sistema visual: tokens, tipografía, superficies, movimiento. Lo que la interfaz puede y no puede hacer. |
| [../PRODUCT.md](../PRODUCT.md) | Qué es SAGITARI, para quién, y qué se promete en cada superficie. |
| [PUBLICAR.md](PUBLICAR.md) | Cómo sale una versión: `npm run dist`, `npm run release`, qué hace el CI y qué **no** hay que hacer. |
| [AUDITORIA-2026-10-17.md](AUDITORIA-2026-10-17.md) | Primera auditoría: motor de permisos, rutas, secretos, actualizador. |
| [AUDITORIA-2026-10-19.md](AUDITORIA-2026-10-19.md) | Segunda auditoría: lo que quedó abierto de la primera y lo que apareció al arreglarlo. |
| [../SECURITY.md](../SECURITY.md) | Qué cuenta como vulnerabilidad y cómo reportarla. |
| [../RELEASE_NOTES.md](../RELEASE_NOTES.md) | Histórico de versiones, en español e inglés. El CI publica la sección de la versión que sale. |

## Las capturas

`docs/*.png` son las que usa el README. Las genera `npm run shots` (no se
versionan las de `shots/`, que son de trabajo).
