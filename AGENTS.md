# Instrucciones del proyecto

## Versionado obligatorio

Antes de cada commit propio, incrementa la versión de la aplicación siguiendo
SemVer, según el cambio de mayor impacto incluido:

- PATCH: correcciones, ajustes visuales, documentación o mantenimiento sin una
  funcionalidad nueva.
- MINOR: funcionalidades nuevas compatibles; reinicia PATCH a cero.
- MAJOR: cambios incompatibles; reinicia MINOR y PATCH a cero.

Actualiza en el mismo commit `package.json`, las versiones raíz y del paquete
raíz de `package-lock.json`, los indicadores de versión en `public/index.html`
y el encabezado de `README.md`. No cambies versiones de dependencias ni las
referencias históricas (capturas, novedades previas o esquema SQLite).

Ejecuta `npm test` y `git diff --check` antes de publicar. No reescribas commits
ya publicados para corregir un olvido: crea un nuevo commit con el incremento.
No generes commits vacíos solo para incrementar versiones.

## Datos locales

No incluyas credenciales, bases de datos, archivos cargados ni muestras runtime
en commits. Preserva los cambios locales de esos datos.
