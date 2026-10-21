# Publicar una versión

La release la crea **el tag**, no el push a `main`: `.github/workflows/release.yml`
solo escucha `push` de tags `v*` (o un `workflow_dispatch` con el tag a mano). Así
que hay un solo camino bueno y es corto:

```bash
# 1. subir la versión en package.json y escribir su sección en RELEASE_NOTES.md
#    (cabecera exacta: `# SAGITARI 5.3.0`)
git add -A && git commit -m "chore(version): 5.3.0"
git push

# 2. comprobar + etiquetar + empujar el tag
npm run release
```

`npm run release` se niega a etiquetar si el árbol tiene cambios, si `main` no
está al día con `origin/main`, si `RELEASE_NOTES.md` no trae la sección de esa
versión (el CI abortaría igual, pero después de crear el tag), si el tag ya
existe —local o remoto— o si el lint o alguna de las dos suites están en rojo.
Con `--rapido` se salta las pruebas y con `--si` no pregunta.

Después, el CI: compila, prueba, **instala el `.exe` en un runner limpio y lo
abre** para comprobar que siembra las skills de serie, y publica con las notas y
los SHA-256.

## Lo que NO se hace

**No subas assets a mano por la API de GitHub.** El CI recompila desde el tag y
los pisa, así que la release acaba con ficheros que no son los que subiste. Pasó
el 21/10/2026 con la 5.2.0: el `latest.yml` publicado no casaba con el `.exe` del
`dist/` local y el hash de la release era de otra compilación.

**No construyas con `electron-builder` a pelo.** `npm run dist` hace los mismos
tres pasos que el CI (compilar, completar `latest.yml` con **todos** los
binarios y verificarlo). Llamar al binario directamente deja un `latest.yml` que
solo firma el Setup, que es el estado que en la 3.2.1 dejó al portable sin poder
actualizarse nunca.
