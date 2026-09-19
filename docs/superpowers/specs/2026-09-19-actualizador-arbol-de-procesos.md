# El actualizador y el árbol de procesos de la app (v3.3.1)

Fecha: 2026-09-19 · Versión: 3.3.1

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

Con eso monté un arnés que replica el flujo real —un proceso con nombre único que lanza al
asistente **y después sale**, como la app— y un señuelo que registra con qué argumentos le
llaman. Resultado, 3 pasadas de 3 variantes:

| Cómo se lanzaba el asistente | ¿Llegó a ejecutarse el instalador? |
|---|---|
| hijo directo (lo que hacía la app) | **NO, 3 de 3** |
| `detached: true` + `unref()` | NO, 3 de 3 (ni siquiera escribía la primera línea) |
| `cmd /c start /b powershell …` | Sí, 3 de 3 — **cuando el padre es un proceso normal** |

Ese último renglón es la trampa: con un padre Node normal `start` funciona. Y por eso
parecía que el diseño estaba bien. **Con Electron no funciona**, y la app es Electron:
repetido con un proceso Electron de verdad, `start` tampoco sobrevive. Un señuelo lento
(que escribe 3 s después) tampoco: **la app mata todo su árbol de procesos al cerrarse.**

Conclusión: el diseño entero —«un asistente que espera a que la app desaparezca»— era
imposible mientras el asistente fuera un hijo de la app, con cualquier bandera. No era un
comando mal escrito: era un supuesto equivocado.

---

## 2. El arreglo: dos etapas y una prueba antes de cerrar

```
 app ──spawn──▶ PUENTE (etapa 1, corto, puede morir con la app)
                 │  Invoke-CimMethod Win32_Process Create
                 ▼
                ASISTENTE (etapa 2)  ← hijo de WmiPrvSE.exe, NO de la app
                 │  espera a que SAGITARI desaparezca
                 ▼
                Setup /S --updated --force-run
```

- **Etapa 1 (el puente)** es lo único que la app ejecuta. Su único trabajo es pedirle a
  Windows (WMI) que cree la etapa 2. Un proceso creado por WMI es hijo de `WmiPrvSE.exe`,
  así que **no está en el árbol de la app** y la sobrevive. Medido: la etapa 2 vive, ve la
  app desaparecer y termina su trabajo con la app ya cerrada.
- **Etapa 2 (el asistente)** es el guion que ya existía: espera a que no quede ninguna
  instancia, lanza el Setup en silencio y lo anota todo.
- **La app espera pruebas antes de cerrarse.** No espera a que «el proceso que lancé siga
  vivo» —eso no prueba nada, y es exactamente lo que fallaba: el asistente estaba vivo,
  escribía una línea, y moría—. Espera a que **la etapa 2 deje su rastro** en el diario
  (`asistente iniciado`). Si no lo consigue (sin PowerShell, WMI bloqueado por política), la
  app **no se cierra**: te lo dice, guarda el intento como pendiente y puedes reintentarlo o
  instalarlo a mano. Un cierre sin instalación es el peor resultado posible y ya no ocurre.
- Presupuesto: 30 s. El puente carga los módulos CIM de PowerShell en frío; medido, el
  asistente está vivo en ~2,3 s.

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

- **Punta a punta con Electron de verdad** (`3 de 3`): la app lanza el puente, WMI crea la
  etapa 2 fuera del árbol, la app espera su rastro (~2,3 s) y sale; la etapa 2 ve la app
  desaparecer y ejecuta el señuelo con `/S --updated`, dejando `instalador termino con
  codigo 0` en el diario.
- **Prueba de regresión en la suite** (367 tests): un proceso con nombre único lanza el
  puente con la orden real y sale; la prueba exige que el señuelo se ejecute **después**.
  Es la prueba que faltaba y por eso el fallo vivió tanto: todas las anteriores lanzaban el
  asistente desde un proceso que seguía vivo, así que nunca se ejercitaba el único caso que
  importa.
- **La integración existente** ahora recorre la cadena completa (puente → WMI → asistente →
  señuelo) y comprueba la orden que recibe el instalador.

### Lo que NO está verificado

- **El ciclo real de la edición instalada** (app abierta → se cierra → el Setup sustituye
  los archivos → al reabrir eres la versión nueva). Cada pieza está probada por separado,
  incluido el propio instalador silencioso leído en sus plantillas, pero el encadenado real
  exige instalar dos versiones en una máquina. Es el paso que queda a mano, una vez.
- WMI puede estar bloqueado por política en equipos gestionados. En ese caso el puente lo
  deja escrito en el diario, la app no se cierra y el usuario tiene la ruta del instalador
  para hacerlo a mano.
