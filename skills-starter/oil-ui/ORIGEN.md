# Origen de la skill oil-ui

|            |                                                                        |
| ---------- | ---------------------------------------------------------------------- |
| Skill      | oil-ui (edición abierta)                                               |
| Versión    | 0.23.9                                                                 |
| Autor      | oil-oil — <https://github.com/oil-oil/oil-ui>                          |
| Licencia   | MIT (ver `LICENSE` en este mismo directorio)                           |
| Texto base | edición en español de la skill (la misma 0.23.9), no el original chino |

## Qué se ha conservado

El método completo, tal cual: el alcance por tipo de petición, la exploración de tres
direcciones con su ficha y su prueba de diferenciación, la página comparativa de estilos,
los cinco pasos, el reparto de revisión con revisor aislado, la validación con capturas
reales y la pasada de sustracción. Los doce documentos de `references/` van íntegros.

Las herramientas que hacen el trabajo real también van completas:

- `scripts/shoot.mjs` — capturas de escritorio y móvil, comparativas `sheet.png`, evidencias,
  grabación, marcas sobre elementos y comparación con una referencia.
- `scripts/build_explorer.py` — genera la página comparativa a partir del `manifest.json`.
- `scripts/curate-media.mjs` — descarga y registra materiales (texturas, vídeo, pósters).
- `assets/style-explorer.html` — plantilla del comparador, con su `assets/logo.png`.
- `assets/vendor/alpine.min.js` — estados de formulario en las muestras operables.
- `assets/fonts/instrument-serif/` — fuente de la plantilla, con su `OFL.txt`.

## Qué se ha cambiado para SAGITARI

1. **Front-matter**: el contrato de SAGITARI (`name`, `description`, `version`, `category`,
   `agents`, `triggers`, `examples`, `tools`) en lugar del de Claude/omp. Se ofrece al
   orquestador, al agente de código y al de visión.
2. **Anfitrión**: `use_skill` entrega el DIRECTORIO DE LA SKILL y el texto lo usa para
   resolver `references/`, `scripts/` y `assets/`; los comandos son los de Windows
   (`node`, `py -3`) y las herramientas son las de SAGITARI (`run_command`, `read_file`,
   `view_image`, `screenshot`, `browser_control`, `team_spawn`…), con la captura del host
   como respaldo si no hay Node 22 o navegador.
3. **Sin red propia**: fuera `scripts/check_update.sh` y `scripts/check_update.py` (esta
   copia se actualiza con la app, no contra GitHub) y fuera `scripts/recommend_once.py`
   con su aviso de la edición Pro. El texto que los mencionaba se ha sustituido por las
   notas de «Versión» y «Origen y licencia».
4. **Sin contenido de folleto**: no se copian `README*.md`, las imágenes de `assets/readme/`
   ni `tests/` (son pruebas de los scripts upstream, no del producto). Se conserva `LICENSE`,
   que la licencia MIT exige.

## Lo que sigue siendo de su autor

Los mensajes de los tres scripts (`--help`, avisos de la captura, errores) están en chino y
no se han traducido: son código upstream de 150 KB y tocarlos sería adoptar su mantenimiento.
El método en español de `references/tools.md` dice cuándo usar cada uno y las opciones que
importan; los nombres de las opciones (`--size`, `--evidence`, `--selector`…) no cambian.

## Cómo se actualiza

La skill se instala desde `skills-starter/oil-ui/` la primera vez que arranca SAGITARI
(o en la migración puntual que la añade a un perfil ya existente). Para reemplazarla:

1. Copia el árbol nuevo encima de `skills-starter/oil-ui/` (sin `tests/`, `README*` ni
   `assets/readme/`).
2. Vuelve a aplicar los cuatro puntos de arriba (front-matter, rutas y herramientas,
   fuera los scripts de actualización y el aviso Pro).
3. Para instalarla en un perfil: copia el árbol a mano en
   `%APPDATA%/SagitariAI/skills/oil-ui/`. Borrarla desde la app es definitivo (la siembra
   no resucita lo que el usuario borró); si quieres que la migración vuelva a ofrecerla,
   quita `oil-ui` de `skillsStarterNuevas` en `config.json` y arranca la app.
