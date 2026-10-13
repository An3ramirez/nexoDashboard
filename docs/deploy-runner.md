# Despliegue automático

El workflow `.github/workflows/deploy.yml` despliega cada push a `main` (por
lo tanto, también cada merge a esa rama). Usa un runner autoalojado porque el
servidor de producción está en una red privada y no es accesible desde los
runners públicos de GitHub.

En GitHub: `Settings → Actions → Runners → New self-hosted runner`, seleccionar
Linux x64 y ejecutar los comandos de instalación en `server-local` con el
usuario `andres`. El workflow usa las etiquetas estándar `self-hosted`,
`linux` y `x64`.

El servicio del runner debe quedar habilitado para iniciar con el servidor.
El workflow conserva `auth.json`, `data/` y `node_modules/` del servidor; las
cargas permanecen en `/home/andres/nexodashboard-files`.
