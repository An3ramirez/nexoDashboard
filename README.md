# NexoDashboard

Panel web de monitoreo local para servidor: rendimiento, memoria, swap,
discos, red, visitantes en tiempo real, procesos, gateway, reproductor y
acciones administrativas. Incluye un módulo público de intercambio temporal
de archivos con enlaces compartibles, caducidad configurable y cargas grandes
por fragmentos.

![Icono de NexoDashboard](public/app-icon.png)

## Requisitos

- Node.js 20 o superior
- npm
- Linux para obtener todas las métricas del sistema

## Ejecutar en local

```bash
npm ci
PORT=3100 node index.js
```

El dashboard queda disponible en `http://127.0.0.1:3100`. El archivo
`auth.json` debe existir y no se versiona; contiene la clave de acceso local.

## Rutas principales

- `/` — dashboard protegido
- `/login.html` — inicio de sesión
- `/files` — carga y descarga pública de archivos temporales
- `/health` — comprobación de estado del servicio
- `/api/public-files` — inventario público de archivos

## Archivos públicos

Las cargas se escriben en streaming directamente al disco. Para archivos que
pueden superar el límite de una petición del proxy, el navegador usa fragmentos
de 32 MB y el servidor los ensambla en disco.

En producción la carpeta es:

```text
/home/andres/nexodashboard-files
```

Se configura mediante `PUBLIC_FILES_DIR`. Esta carpeta está fuera del checkout
para conservar los archivos al actualizar el código.

Los binarios se guardan como archivos en esa carpeta y sus metadatos (nombre,
tamaño, expiración, estado persistente y origen de subida) se mantienen en
`index.json`. El proyecto no usa una base de datos para el módulo de archivos.
El servicio systemd y el workflow de despliegue deben compartir la misma ruta
`PUBLIC_FILES_DIR`; el unit file versionado está en `deploy/nexodashboard.service`.
El administrador puede generar claves y usarlas para marcar archivos como
persistentes; las claves se guardan como hashes. El limpiador intenta borrar
cada archivo vencido antes de retirarlo del índice y reintenta en el siguiente
ciclo si el disco o el guardado del índice falla.

## Despliegue automático

El workflow `.github/workflows/deploy.yml` se ejecuta en cada push a `main`,
incluido un merge de Pull Request. Usa un runner autoalojado instalado en el
servidor porque este se encuentra en una red privada.

El runner debe tener las etiquetas estándar `self-hosted`, `linux` y `x64`, y
ejecutarse como servicio. El despliegue conserva `auth.json`, `data/` y la
carpeta de archivos públicos, actualiza dependencias, reinicia Node y valida
`/health` antes de marcar el job como correcto.

La configuración detallada del runner está en
[`docs/deploy-runner.md`](docs/deploy-runner.md).

## Seguridad

- Las claves no se guardan en el repositorio.
- Las rutas de archivos usan identificadores aleatorios, no nombres del usuario.
- Los archivos caducados se eliminan automáticamente según la configuración del
  administrador.
- El servicio escucha en localhost; Nginx gestiona el acceso externo y el
  límite de carga del proxy.
