# Catálogo de aplicaciones

`/apps` es una página privada del dashboard, disponible en escritorio y móvil.
Muestra nueve accesos iniciales: reproductor, Vaultwarden, Plane, Syncthing,
OpenClaw, Cockpit, Casa/NAS, NexoDashboard y archivos públicos. Las rutas vienen
de los subdominios facilitados por el administrador. Casa se identifica como
NAS por confirmación explícita, no como CasaOS. Nginx confirmó OpenClaw en
`app.corposoft.net` y el servicio Cockpit en el puerto 9090.

Cada tarjeta abre la URL del servidor en una nueva pestaña, incluso desde la
vista local. No se transmiten claves ni cookies del dashboard y las apps
mantienen su propia autenticación. El catálogo no prueba disponibilidad: no
confundir una ruta publicada con un servicio en línea.

El catálogo inicial está definido en `applications.js`; se conserva como
configuración `applications` dentro de SQLite al primer acceso. Los siguientes
arranques respetan la configuración guardada. Cambiar la lista inicial en
código no sobrescribe automáticamente el catálogo existente. Esta versión no
incluye edición administrativa del catálogo ni descubrimiento automático de
aplicaciones nuevas.

La interfaz usa logos SVG locales de Plane, Syncthing y Cockpit procedentes de
[Simple Icons](https://github.com/simple-icons/simple-icons), publicados bajo
CC0, en `public/app-logos.svg`. El logo de NexoDashboard usa su asset existente;
los demás accesos utilizan iconos representativos del sistema visual del panel
(bóveda, música, NAS, archivos y agentes), no logos oficiales de esas marcas.
No se consultan favicons externos ni se amplía la política CSP para cargar
imágenes de terceros.

La búsqueda admite nombre, descripción, dominio y categoría; se combina con
los filtros de categoría. Hay estados de carga, error/reintento y búsqueda sin
resultados. Los enlaces usan `noopener noreferrer`; el renderer acepta solo
URLs HTTP/HTTPS sin credenciales y crea texto mediante DOM, no HTML dinámico.
