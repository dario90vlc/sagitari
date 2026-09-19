# El actualizador y el árbol de procesos de la app (v3.3.2)

Fecha: 2026-09-19 · Versión: 3.3.2

Síntoma del usuario: «Nueva actualización disponible → Descargar → Cerrar e Instalar. La
aplicación se cierra, aparece una ventana de terminal, se cierra y no pasa nada. Vuelves a
abrir la aplicación y la nueva versión no se ha instalado.»

Esta es la tercera vez que el actualizador se toca. Las dos anteriores arreglaron cosas
reales (el escapado de comillas en `cmd.exe`, y que la release firmara **todos** los
binarios) pero **no** esta, porque la causa era otra y no se había medido.

---

## 1. La causa, medida y no supuesta

La app deja un diario de lo que hace el asistente en
`%TEMP%\sagitari-update\instalar.log`. En el equipo del usuario decía exactamente esto, dos
veces (dos intentos, 17 s aparte):

```
asistente iniciado (pid=3292, PowerShell 5.1.26100.9444)
asistente iniciado (pid=16816, PowerShell 5.1.26100.9444)
```

**Y nada más.** Ni «la app ya no está en ejecución», ni «instalador lanzado», ni el error
de lanzamiento. El asistente escribía su primera línea y moría durante la espera.

Con eso monté un arnés que replica el flujo real —un **Electron de verdad** con nombre único
que lanza al asistente **y después sale**, como la app— y un señuelo que registra con qué
argumentos le llaman. El mismo guion, lanzado de cuatro formas, con un padre Electron real:

| Cómo se lanzaba el asistente | ¿Ejecutó el instalador? |
|---|---|
| `powershell.exe` directo, hijo normal (**lo que hacían la 3.2.3 y la 3.3.0**) | **NO** — escribe «asistente iniciado» (a los 0,4 s) y **muere con la app** |
| `powershell.exe` directo, desligado | **NO** — ni arranca: 30 s sin dejar rastro |
| `cmd.exe` → powershell, hijo normal | Sí |
| `cmd.exe` → powershell, **desligado** (lo que se envía) | Sí |

Las dos primeras filas son el fallo, y la primera reproduce el diario del usuario **letra por
letra**: el asistente arranca, escribe su línea y desaparece antes de poder hacer nada.

Dos lecciones de esta tabla, porque las dos nos costaron una versión:

- **No basta con que el asistente arranque.** La 3.2.3 lanzaba un `powershell.exe` y *sí*
arrancaba — de ahí la conclusión equivocada de que «un hijo normal sobrevive al padre». Sí
sobrevive… a un padre normal. Al cerrarse **un Electron**, ese hijo muere.
- **Y desligar un PowerShell suelto no arregla nada**, porque entonces no arranca (fila 2).
  Eso ya estaba anotado en el código de la 3.2.3 como «un PowerShell separado no llega a
  ejecutar nada», y era cierto; lo que se dedujo de ahí era lo falso.

---

## 2. El arreglo: envolverlo en `cmd.exe`, desligarlo, y una prueba antes de cerrar

```
 app ──spawn(detached)──▶ cmd.exe  ──hijo──▶ ASISTENTE (PowerShell)
                                               │ espera a que SAGITARI desaparezca
                                               ▼
                                              Setup /S --updated --force-run
```

Son dos cosas, y ninguna es cosmética:

- **El proceso que se lanza es un `cmd.exe`**, porque a un PowerShell suelto no hay forma de
  arrancarlo y sostenerlo a la vez: como hijo normal muere con la app, y desligado ni
  arranca. El `cmd` es un proceso corriente: arranca de las dos maneras y es él quien
  mantiene vivo a PowerShell como hijo suyo.
- **Va desligado** (`detached`, que en Windows es DETACHED_PROCESS más un grupo de procesos
  propio): la forma estándar de pasar el relevo a otro proceso cuando el que lanza se va a
  cerrar, y lo que hace `electron-updater`.

Así el mecanismo no depende de nada externo: ni WMI, ni módulos CIM, ni tareas programadas.
(Se probó y también funcionaba crear el ayudante con WMI —hijo de `WmiPrvSE.exe`, fuera del
árbol—, y se descartó a propósito: más piezas y una dependencia —WMI puede estar bloqueado
por política en equipos gestionados— para exactamente el mismo resultado. Menos es más.)

**Y la app espera pruebas antes de cerrarse.** No espera a que «el proceso que lancé siga
vivo» —eso no prueba nada, y es exactamente lo que fallaba: el ayudante estaba vivo,
escribía una línea, y moría—. Espera a que el asistente **deje su rastro** en el diario
(`asistente iniciado`). Si no lo consigue (sin PowerShell, bloqueado por política), la app
**no se cierra**: te lo dice, guarda el intento como pendiente y puedes reintentarlo o
instalarlo a mano. Un cierre sin instalación es el peor resultado posible y ya no ocurre.

Presupuesto: 30 s. Medido, el asistente deja su rastro en ~1,5 s (PowerShell en frío).

### Lo que además se aprovechó para arreglar

- **`--force-run`**: el Setup vuelve a abrir SAGITARI al terminar. Antes se cerraba y el
  usuario no veía nada —aunque la instalación hubiera ido bien—.
- **El diario recoge el código de salida del instalador** y si la app seguía viva al
  lanzarlo. Sin eso, un instalador que falla deja el mismo rastro que uno que no llegó a
  arrancar.
- **La interfaz avisa** («Preparando la instalación… no cierres la app todavía») mientras se
  espera la prueba; antes el botón parecía colgado esos segundos.
- El fallo de arranque **guarda el intento como pendiente**, así que la tarjeta ofrece
  Reintentar en vez de dejar al usuario sin salida.

### Por qué el instalador necesita que la app se cierre

Leído en las plantillas NSIS del propio electron-builder
(`installSection.nsh`, `allowOnlyOneInstallerInstance.nsh`, `multiUser.nsh`):

- `SilentInstall silent` + `/S`: instalación silenciosa.
- Con `--updated` (`isUpdated`) y la app en marcha, el instalador **la cierra él mismo**
  (primero con gracia, luego a la fuerza) y sigue; en silencio no pregunta nada.
- El modo de instalación se decide leyendo `HKLM`/`HKCU` `Software\<APP_GUID>`: con una
  instalación por usuario existente (la de SAGITARI) es **por usuario**, o sea **sin UAC** y
  en la misma carpeta.

Aun así el asistente espera a que la app desaparezca: cerrar nosotros significa cierre
ordenado (se matan los PowerShell del motor de voz, los servidores MCP y el navegador), y
eso es mejor que dejar que un instalador nos mate.

---

## 3. Cómo está verificado

- **Punta a punta con un Electron de verdad**, con la orden de producción tal cual
  (`plan.file` / `plan.args` / `plan.spawnOpts`): la app lanza el ayudante desligado, espera
  su rastro (~1,5 s) y sale; el ayudante ve la app desaparecer y ejecuta el señuelo con
  `/S --updated --force-run`, dejando `instalador termino con codigo 0` en el diario.
  Repetible a mano: `npm run verificar:actualizador`.
- **La prueba de regresión de la suite usa ese mismo escenario** (367 tests), y ahora **se
  autovalida**: además de exigir que el instalador se ejecute después de que la app salga,
  ejecuta un **CONTROL** con el diseño anterior (PowerShell directo) y exige que NO instale.
  Ese control es lo que demuestra que el escenario mide el cierre de verdad.

### La prueba que había antes no servía (y por eso el fallo duró dos versiones)

La prueba anterior se llamaba «el ayudante SOBREVIVE al cierre de la app» y usaba un
**`node.exe` renombrado** como padre. Medido: con un padre Node, el diseño roto **también
pasa** —Windows no mata al hijo de un Node al cerrarse—, así que la prueba no podía fallar
por el fallo que decía guardar. El doctorado de este fallo es exactamente eso: un test que
pasa siempre es peor que no tenerlo, porque da por cubierto lo que no lo está.

De ahí las dos reglas que quedan en el arnés: **el padre tiene que ser Electron** (lo único
que se cierra como la app) y **tiene que existir un control que deba fallar**. Si algún día
esas pruebas se relajaran, el propio test lo delataría.

### Lo que NO está verificado

- **El ciclo real de la edición instalada** (app abierta → se cierra → el Setup sustituye
  los archivos → al reabrir eres la versión nueva). Cada pieza está probada por separado,
  incluido el propio instalador silencioso leído en sus plantillas, pero el encadenado real
  exige instalar dos versiones en una máquina. Es el paso que queda a mano, una vez.
- Si PowerShell estuviera bloqueado por política, el ayudante no arrancaría: la app lo
detecta, no se cierra y ofrece instalar a mano.
- El comportamiento de cierre (qué hijo sobrevive y cuál no) está medido en **Windows 10/11
  con Electron 44**. Depende del sistema, no de nuestro código, así que un cambio futuro
  podría alterarlo — pero ya no se descubre en producción: la prueba de regresión con
  Electron y su control lo cazan antes de que salga una release.
