# Reglas de este proyecto

## Configuración

- `config/produccion.json` es la configuración de producción: **no se modifica nunca**
  desde una petición de desarrollo. Si hace falta un valor distinto, se cambia en
  `config/desarrollo.json`.
- Los dos archivos comparten las mismas claves, así que un valor nuevo se añade en
  desarrollo y producción se actualiza en su propio despliegue.
