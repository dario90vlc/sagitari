# Juego y controles de fuerte sensación táctil

En los minijuegos, los sorteos, las máquinas de cápsulas, el cultivo con temporizador y los controles de fuerte sensación táctil como perillas, palancas y joysticks, el proceso mismo es el producto: el usuario viene a ver cómo la ruleta desacelera, cómo empujan la moneda hacia fuera, cómo el peluche casi se resbala. Para este tipo de interfaces, lee primero este documento; el resto de las normas se aplican con normalidad.

## El proceso es la jugabilidad

- La puesta en escena puede durar más que un cambio de interfaz normal; por ejemplo, tres ruletas que se detienen una tras otra en unos 2 segundos en total, sin recortarlo por la regla de «si supera los 500 ms, el usuario espera».
- Si se ha cobrado y ya hay resultado, guárdalo primero: refrescar no debe perderlo, no debe cobrarse dos veces y la recompensa se liquida una sola vez. En qué momento guardar depende de la jugabilidad.
- Durante la puesta en escena, indica claramente qué operaciones quedan bloqueadas; pulsar repetidamente no puede cobrar dos veces.
- Los gestos como perillas y palancas siguen el dedo desde el punto en que se pulsan; solo cuentan cuando se supera el punto de activación, y soltar antes no cobra.
- Con movimiento reducido, la jugabilidad calcula el resultado con normalidad y solo la pantalla va directa al estado final; no se puede detener la jugabilidad en sí.
- La sensación táctil se juzga con la grabación de pantalla: si la desaceleración es continua, si hay tirones al detenerse y de dónde vuela la ganancia y hacia dónde. Tres fotogramas solo muestran estados.

## Materiales y renderizado

- Los personajes, las colecciones, los objetos, los símbolos y las texturas de material son los protagonistas de este tipo de interfaces; por defecto se hacen con generación de imágenes, así que haz primero una lista de materiales antes de empezar. El SVG y el CSS escritos a mano solo dibujan iconos de interfaz y formas simples; usarlos para personajes y objetos acaba en la textura de un paquete de iconos. Para producir imágenes en conjuntos, consulta «Materiales en conjuntos» de [Materiales](media.md); si el host no puede generar imágenes, entrega un informe de materiales con el mismo documento y no hagas pasar formas dibujadas a mano por producto terminado.
- Cuando la diversión provenga del espacio y la física, usa escenas renderizadas en 3D en tiempo real, por ejemplo apilamientos, colisiones, empujones, oscilaciones, o materiales transparentes y metálicos; las imágenes generadas se usan como texturas y sprites, según «3D en tiempo real» de [Materiales](media.md). Para cambios naturales como el crecimiento de árboles o el clima, suele ser mejor usar imágenes generadas en conjuntos.
- Vuelve a mirar los materiales una vez colocados en la escena: la iluminación debe coincidir con la de la escena, debe haber sombras de contacto y no deben asomar los bordes de cartón en los laterales, la parte trasera o al caer. Que la imagen esté generada no significa que resulte creíble dentro de la escena.
