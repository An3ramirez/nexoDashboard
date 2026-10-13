# NexoDashboard

Panel web de monitoreo local para servidor: rendimiento, memoria, swap,
discos, red, visitantes en tiempo real, procesos, gateway, reproductor y
acciones administrativas. Incluye un módulo público de intercambio temporal
de archivos con enlaces compartibles, caducidad configurable y cargas grandes
por fragmentos.

![Icono de NexoDashboard](public/app-icon.png)

## Requisitos

- Node.js 22.13 o superior (servidor comprobado con Node 24)
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
- `/apps` — catálogo privado de aplicaciones con logos, búsqueda y categorías
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
tamaño, expiración, estado persistente y origen de subida), configuración y
claves hasheadas se mantienen en SQLite. Los archivos grandes no se guardan
como blobs de la base de datos.
El servicio systemd y el workflow de despliegue deben compartir la misma ruta
`PUBLIC_FILES_DIR`; el unit file versionado está en `deploy/nexodashboard.service`.
El administrador puede generar claves y usarlas para marcar archivos como
persistentes; las claves se guardan como hashes. El limpiador intenta borrar
cada archivo vencido antes de retirarlo del catálogo y reintenta en el siguiente
ciclo si el disco o el guardado del catálogo falla.

## Base de datos e historial

Se usa `node:sqlite`, incluido en Node, sin instalar un servidor de base de
datos. Por defecto la base está en `$PUBLIC_FILES_DIR/nexodashboard.sqlite`;
`DASHBOARD_DB_PATH` permite cambiarla. En producción ambas ubicaciones deben
quedar fuera del checkout y ser escribibles por el usuario del servicio.
Referencia: [API SQLite de Node](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

SQLite guarda catálogo de archivos, claves de persistencia hasheadas,
configuración del módulo, catálogo de aplicaciones e historial de CPU/RAM. Autenticación, checks, enlaces
y bitácora de acciones aún conservan sus formatos existentes; las alertas por
Telegram no se implementan en esta entrega.

El historial conserva **180 días** por defecto, con una muestra por minuto.
`HISTORY_RETENTION_DAYS` permite ajustar de 1 a 3650 días. Se eliminan muestras
anteriores al corte temporal al arrancar y al guardar nuevas muestras; las
consultas también excluyen datos fuera de retención. Esta política **no cambia
el TTL ni elimina los archivos persistentes**.

La API `/api/history?range=180d` acepta `24h`, `7d`, `30d`, `90d` y `180d`.
Las gráficas reciben como máximo unos 400 puntos agregados por rango. El CSV
incluye las muestras retenidas; al arrancar, las gráficas en vivo solo recuperan
las últimas 24 horas para no cargar seis meses en memoria.

### Migración y recuperación

- Al primer arranque se importan `index.json` del almacenamiento de archivos y
  `data/samples.jsonl` del proyecto, si existen. Se crean copias
  `.pre-sqlite.bak` y los originales quedan sin modificar.
- La importación de cada fuente y su marcador se confirman en una transacción.
  Reiniciar no vuelve a importar un JSON antiguo sobre datos nuevos.
- Un catálogo/historial inválido bloquea el arranque con error: no se sustituye
  silenciosamente por un inventario vacío. Revisar y reparar la fuente antes
  de reintentar; no borrar la base para resolver errores sin diagnóstico.
- Los datos anteriores a 180 días no se importan al historial activo, pero
  permanecen en el JSONL original conservado. Datos eliminados antes de esta
  migración no pueden recuperarse automáticamente.
- SQLite usa WAL, transacciones y permisos 0600 para el archivo principal. Para
  hacer una copia manual consistente, detener el servicio y respaldar la base
  junto a sus archivos `-wal`/`-shm` si existen, además de los binarios. No copiar
  solamente el `.sqlite` mientras el servicio escribe.
- Los JSON conservados son una foto anterior a la migración, **no** una copia
  actualizada. Volver al código antiguo requiere exportar los datos vigentes o
  restaurar un backup completo elegido conscientemente; no usar el JSON viejo
  como rollback automático porque perdería cambios posteriores.
- No ejecutar dos instancias escritoras del dashboard sobre el mismo catálogo:
  la aplicación todavía mantiene una caché de metadatos por proceso.

## Pruebas

```bash
npm test
```

Las pruebas crean bases y archivos ficticios en directorios temporales. Cubren
migración, errores/rollback, reinicio, retención, rangos, subida, descarga y
persistencia. La prueba HTTP necesita poder escuchar en localhost y no utiliza
credenciales ni archivos de producción. El workflow ejecuta estas pruebas
antes de copiar código al servidor.

El catálogo de aplicaciones está documentado en
[`docs/applications.md`](docs/applications.md).

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
