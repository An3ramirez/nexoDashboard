# Almacenamiento, migración y recuperación

SQLite (`node:sqlite`) guarda archivos, claves hasheadas, configuración, catálogo
de aplicaciones e historial. Los binarios permanecen en `PUBLIC_FILES_DIR`,
fuera del directorio web. Autenticación, checks, enlaces y bitácora de acciones
conservan sus formatos existentes.

## Historial

Una muestra por minuto, retención predeterminada de 180 días, configurable entre
1 y 3650 con `HISTORY_RETENTION_DAYS`. El servicio limpia al arrancar y al guardar;
las consultas también excluyen datos fuera de retención. Esta política no cambia
el TTL de archivos ni elimina los persistentes.

`/api/history?range=180d` admite `15m`, `1h`, `6h`, `24h`, `7d`, `30d`, `90d` y
`180d`. Agrega los datos a unos 400 puntos por consulta. El CSV contiene las
muestras retenidas de CPU/RAM, no únicamente el intervalo de pantalla.

La versión 3.1.0 migra el esquema a v2 para agregar temperatura y Swap como
campos opcionales. Conserva CPU/RAM existentes; los nuevos campos antiguos
permanecen en `NULL`. La versión del esquema SQLite no es la versión de la app.

## Migración desde JSON

- Al primer arranque se importan `index.json` del almacenamiento de archivos y
  `data/samples.jsonl` del proyecto, si existen. Se crean copias
  `.pre-sqlite.bak` y los originales quedan sin modificar.
- Cada importación y su marcador se confirman en una transacción. Reiniciar no
  vuelve a importar un JSON antiguo sobre registros nuevos.
- Una fuente inválida bloquea el arranque con error; no se reemplaza por un
  inventario vacío. Diagnostica y repara antes de reintentar.
- Los registros fuera de retención no se importan al historial activo, pero
  permanecen en el JSONL original. Datos borrados previamente no se recuperan.

## Copias y restauración

1. Detén el servicio para obtener una copia manual consistente.
2. Respalda el SQLite y sus archivos `-wal`/`-shm` si existen, los binarios de
   `PUBLIC_FILES_DIR`, `auth.json` y los demás datos runtime necesarios.
3. Restaura el conjunto coherente, conserva permisos y propietario, y comprueba
   las mismas rutas de datos antes de reiniciar.

No copies solamente el `.sqlite` mientras hay escrituras. El archivo principal
usa permisos 0600; protege también las copias.

Los JSON conservados son una fotografía anterior a la migración, no un respaldo
actualizado. Volver a código antiguo requiere exportar los datos vigentes o
restaurar conscientemente un backup completo. No uses el JSON viejo como rollback
automático: perderías cambios posteriores.

No borres la base para resolver un fallo sin diagnosticarlo y no ejecutes dos
instancias escritoras sobre el mismo catálogo: hay caché de metadatos por proceso.
