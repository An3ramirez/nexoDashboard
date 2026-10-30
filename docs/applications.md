# Aplicaciones: catálogo, estado y control

`/apps` es privado y conserva búsqueda, categorías, logos y enlaces en una
nueva pestaña. Cada app mantiene su propia autenticación. No se reenvían cookies
o claves del dashboard a las apps.

## Estados

Se consulta cada 15 segundos mientras la página está visible. El servidor cachea
lecturas durante 10 segundos y aplica tiempos máximos a las consultas.

- **Activo / Detenido:** unidad systemd o contenedor consultado.
- **Con fallo:** systemd informa `failed`; permite intentar iniciar de nuevo.
- **Parcial:** no todos los componentes obligatorios de una app están activos.
- **Degradado:** Docker informa un contenedor pausado o activo con salud `unhealthy`.
- **En transición:** un proceso está arrancando, parando o reiniciando.
- **Sin verificar:** no hay permiso, falta un objetivo o no se puede determinar
  el estado. No equivale a detenido y desactiva controles.
- **Responde HTTP / No disponible:** solo hay una sonda HTTP local; acepta como
  respuesta válida 2xx/3xx, 401 y 403, sin seguir redirecciones. No demuestra que
  el servicio autenticado funcione ni verifica DNS, TLS, CDN o el acceso externo.
- **Sin configurar:** no hay asociación ni sonda.

Si falla la actualización del catálogo, la interfaz marca el estado como
**Sin actualizar** y desactiva botones hasta volver a comprobarlo.

## Perfil incluido y límites

Los nombres se contrastaron con el servidor original el 29 de octubre de 2026.
No son un descubrimiento automático ni un instalador:

| App | Asociación / control |
| --- | --- |
| Vaultwarden | Contenedor `vaultwarden`. |
| Plane | Grupo de 11 contenedores existentes `plane-*`; arranque de dependencias primero y parada en orden inverso. No ejecuta `plane-migrator`, que es una tarea de migración de una sola ejecución. |
| OpenClaw | Unidad de usuario `openclaw-gateway.service`. |
| Cockpit | Socket `cockpit.socket` y servicio `cockpit.service`. El socket determina disponibilidad de activación; que el servicio opcional esté inactivo sin usuarios es normal. Al parar se detienen socket y servicio. |
| Reproductor | Sonda local `http://127.0.0.1/player/`. Sin control para no detener Nginx/PHP compartidos. |
| Syncthing | Sonda `http://127.0.0.1:8384/`; control pendiente de identificar su servicio real. |
| Casa / NAS | Sin asociación ni sonda: la ruta original al puerto 8080 coincidía con Plane y no certifica la identidad del NAS. Requiere identificar su proceso para consultar/controlar el servicio correcto. |
| Dashboard / Archivos | Activos en este proceso. Nunca se pueden detener desde estas tarjetas, para no perder la consola. |

Iniciar contenedores no los crea, no instala apps, no ejecuta Compose ni cambia
políticas de reinicio. Si se han eliminado contenedores, se deben restaurar con
su despliegue original antes de controlarlos. Un proceso activo no garantiza
que sus dependencias hayan terminado de arrancar.

La operación del grupo puede quedar parcial si falla un componente. Se informa
el error, se consulta de nuevo y se conserva el estado real; no se hace un
rollback que pueda interrumpir servicios iniciados correctamente.

## Configuración propia

Define `APP_SERVICES_CONFIG` como ruta absoluta a un archivo JSON fuera del
checkout, legible por el servicio y modificable únicamente por administradores.
El archivo reemplaza **todo** el perfil; no se mezcla con los defaults. Su
contenido se valida al iniciar; si no es válido, el arranque falla.

Ejemplo ilustrativo (sustituye por nombres reales comprobados):

```json
{
  "vault": {
    "targets": [{ "type": "docker", "name": "vaultwarden", "sudo": true }]
  },
  "syncthing": {
    "targets": [{ "type": "systemd", "unit": "syncthing@usuario.service", "sudo": true }]
  },
  "openclaw": {
    "targets": [{ "type": "systemd", "unit": "openclaw-gateway.service", "scope": "user" }]
  },
  "player": {
    "probe": { "port": 80, "path": "/player/" },
    "reason": "Solo disponibilidad HTTP; servicio compartido."
  }
}
```

Las claves son IDs del catálogo, no nombres visibles. `targets` admite hasta 16
componentes Docker/systemd por app. `scope: "user"` utiliza el bus del usuario
que ejecuta Node; no inicia sesión como otro usuario. No se permite combinar
`sudo` con el ámbito `user`. `optional: true` permite componentes auxiliares
que no determinan el estado agregado, pero sí participan en las órdenes.

Las sondas solo aceptan puerto y ruta en **127.0.0.1**, no hosts ni URLs externas.
No uses el mismo proxy compartido como objetivo de varias apps. Los objetivos
deben ser unidades/contenedores dedicados; el perfil se considera configuración
administrativa de confianza, no un archivo editable por visitantes.

Para desactivar controles externos, usa un archivo con `{}`. Conserva el mismo
`APP_SERVICES_CONFIG` en systemd y cualquier arranque manual. Es necesario
reiniciar Node para cambiar asociaciones.

## Permisos y seguridad

Los comandos se ejecutan con `execFile` y argumentos separados, nunca con shell.
El navegador solo envía ID del catálogo, `start`/`stop` y confirmación. El
servidor rechaza otros parámetros, peticiones de origen cruzado y aplicaciones
que no figuren en el catálogo. Los endpoints están detrás del login.

- El diálogo ofrece Cancelar/Confirmar, sin texto ni clave adicional.
- Bloqueo de órdenes concurrentes sobre los mismos objetivos, hasta 6 intentos
  por aplicación/minuto y duración máxima del grupo de 60 segundos.
- Auditoría en la misma bitácora de acciones del dashboard, sin filtrar stderr
  del sistema a la respuesta del navegador.
- No se ejecuta `enable`, `disable`, `rm`, `prune`, migraciones ni reinicios del
  servidor. Parar un servicio sí interrumpe sus sesiones/tareas en curso.
- El propio dashboard, Nginx, Docker y SSH están protegidos como unidades.

Para `sudo: true`, el servicio utiliza `sudo -n`: sin permisos falla sin pedir
contraseña interactiva. No se modifican sudoers ni grupos automáticamente.
Un administrador debe aprobar permisos **limitados a los comandos y objetivos
necesarios**. No concedas `NOPASSWD: ALL`, acceso general a systemctl ni añadas
el usuario a Docker sin considerar que eso otorga control privilegiado del host.
Nunca ejecutes el dashboard como root para evitar configurar permisos.

## Catálogo y logos

El catálogo inicial está en `applications.js`. SQLite lo guarda bajo la clave
`applications` al primer acceso; editar la lista inicial no sobrescribe uno
existente. No hay editor del catálogo ni descubrimiento automático. Las
asociaciones de procesos viven separadas en el perfil para no confundir enlaces
publicados con autoridad para ejecutar comandos.

Los enlaces solo aceptan HTTP/HTTPS sin credenciales y usan
`noopener noreferrer`. El render crea nodos de texto, no HTML con datos externos.
Los logos locales de Plane, Syncthing y Cockpit de `public/app-logos.svg`
proceden de [Simple Icons](https://github.com/simple-icons/simple-icons) (CC0).
Los demás iconos son representativos, no logos oficiales. No se cargan favicons
externos ni se amplía CSP para imágenes de terceros.
