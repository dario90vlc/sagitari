# Actualizador en la app: por qué «se cierra y no pasa nada» y cómo queda

Fecha: 2026-09-18 · Ámbito: `main/updater.js`, `main/main.js`, `renderer/app.js` · Estado: corregido y probado

## El síntoma (reportado por un usuario)

> Nueva actualización disponible → Descargar → **Cerrar e Instalar** → la aplicación se cierra,
> aparece una nueva ventana de terminal, se cierra y no pasa nada. Vuelves a abrir la aplicación
> y la nueva versión no se ha instalado. (Windows, v3.0.1)

Los tres pasos anteriores funcionaban (comprobar, descargar, verificar el SHA-512): lo que fallaba
era el último, **lanzar el instalador**.

## La causa

El lanzamiento era una única orden de `cmd.exe`:

```js
spawn('cmd.exe', ['/d', '/c', 'timeout /t 2 /nobreak >nul & start "" "%SAGITARI_UPDATE%" /S'], {
  detached: true, stdio: 'ignore', windowsHide: true,
  env: { ...process.env, SAGITARI_UPDATE: d.path },
}).unref();
```

Comprobado con un señuelo (`.bat` que anota cómo lo han invocado), ejecutando la forma exacta del
código en Windows: **el señuelo no se ejecutaba nunca**. La ruta tiene que sobrevivir a dos
intérpretes de comillas a la vez —el escapado de Node y el análisis de `cmd.exe`— y no sobrevive;
la orden muere antes de llegar al `start`. Lo único que el usuario veía era la ventana de consola
que abre un proceso `detached` en Windows (documentado en Node: el hijo «tiene su propia ventana
de consola»; `windowsHide` no la cancela), y que se cerraba al terminar el `timeout`.

Hay un segundo defecto, más silencioso: aunque la orden hubiera llegado, la app se cerraba **0,5 s
después** y la espera eran 2 s fijos adivinados. El instalador de electron-builder decide si hay
una app en ejecución mirando su **proceso padre**: lanzado desde la propia app, el padre es
`SAGITARI.exe` y el instalador se salta la comprobación y se queda a medias con los ficheros en
uso (instalación en silencio = fallo sin mensaje).

## El arreglo

**El instalador lo lanza un ayudante que espera a que la app muera.** `updater.afterExitCommand()`
construye un guion de PowerShell que viaja en `-EncodedCommand` (base64 de UTF-16LE): así la ruta
del instalador es texto, no una línea de órdenes que analizar, y una ruta con espacios, `&`, `/` o
`%` deja de ser un problema. El guion:

1. escribe su diario en `%TEMP%\sagitari-update\instalar.log` (lo que hizo, cuándo y con qué resultado);
2. espera (hasta 90 s, sondeo cada 400 ms) a que **no quede ninguna instancia** de `SAGITARI.exe`;
3. espera 1,2 s de gracia para que Windows suelte los ficheros;
4. lanza el Setup con `/S --updated` — silencio y «esto es una actualización de lo instalado», que
   es lo que hace que el instalador reutilice la carpeta del registro en vez de una por defecto.

Detalles que importan y se probaron en la máquina:

- **Sin `detached`.** En Windows, un PowerShell separado sale con código 0 y **no ejecuta nada**
  (medido); un hijo normal sí sobrevive a la muerte del padre, que es lo único que hacía falta de
  `detached`. Con `windowsHide` y `-WindowStyle Hidden`, **no aparece ninguna ventana**.
- **Se comprueba que el ayudante arranca antes de cerrar la app.** Si el hijo muere en 1,2 s (sin
  PowerShell, bloqueado por política), no se cierra nada y el usuario recibe el motivo, en vez de
  quedarse con la app cerrada y nada instalado.
- **Se vuelve a verificar el SHA-512 justo antes de lanzar** (ya existía) y también al reintentar.

## Que un fallo deje de ser invisible

Para instalar hay que cerrar la app, así que en el momento del fallo no hay a quién contárselo. Se
anota en `%APPDATA%\SagitariAI\update-pending.json` ({version, path, sha512 esperado, fecha}) y el
arranque siguiente, si la versión sigue siendo la vieja:

- avisa en el chat (un toast, sin modales);
- deja el punto en Ajustes;
- y en **Ajustes ▸ Acerca de** ofrece **Reintentar la instalación** (vuelve a comprobar el hash y
  relanza el ayudante) o, si el archivo ya no está, invita a descargarla otra vez.

`updater.pendingFor()` decide si el aviso sigue teniendo sentido: se borra solo en cuanto la
versión instalada alcanza la que se intentó (o si el fichero está corrupto).

## Cómo queda probado

- `test/run.js`: el guion del ayudante (ruta con `'`, `&` y `%`, `-EncodedCommand` que decodifica al
  guion exacto, espera por nombre de proceso, `/S --updated`, sin líneas de `cmd.exe`),
  `pendingFor` con sus cuatro casos y **una prueba de integración que ejecuta el ayudante de
  verdad** contra un señuelo y comprueba que recibe `/S --updated` y deja su diario — el fallo
  original, cubierto para que no vuelva.
- `scripts/ui-check.js`: la tarjeta de Ajustes pinta la instalación a medias con su botón
  «Reintentar la instalación», y si el archivo ya no está invita a descargarla.

## Nota para la próxima release (importante)

Todas las versiones publicadas desde **v2.2.1** (v3.0.0, v3.0.1, v3.1.0, v3.1.1 y v3.2.0) llevan
este lanzamiento roto, así que **quien tenga una de ellas no podrá actualizarse sola a la versión
corregida**: el primer salto hay que hacerlo a mano. Las notas de la release que incluya este
arreglo deben decirlo, y basta con descargar el instalador de la página de releases una vez; a
partir de ahí el actualizador ya funciona.

La prueba que había antes de publicar no cubría este camino (el motor se probaba con `fetch`
inyectado, pero nadie ejecutaba el lanzamiento real). Es el tipo de fallo que solo aparece al
lanzar un proceso de verdad, así que el test que lo cubre ahora lanza uno.
