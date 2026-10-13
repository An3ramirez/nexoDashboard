'use strict';

// Catálogo explícito, no un escáner de puertos. Las URLs proceden de los
// subdominios facilitados por el administrador; no se envían cookies del panel.
const DEFAULT_APPLICATIONS = [
  { id: 'player', name: 'Reproductor', description: 'Tu música, biblioteca y listas de reproducción.', url: 'https://corposoft.net/player/', category: 'Multimedia', logo: 'music', color: 'pink' },
  { id: 'vault', name: 'Vaultwarden', description: 'Contraseñas y credenciales en tu bóveda personal.', url: 'https://vault.corposoft.net', category: 'Seguridad', logo: 'vault', color: 'blue' },
  { id: 'plane', name: 'Plane', description: 'Proyectos, tareas y trabajo en equipo.', url: 'https://plane.corposoft.net', category: 'Productividad', logo: 'plane', color: 'purple' },
  { id: 'syncthing', name: 'Syncthing', description: 'Sincronización de archivos entre tus dispositivos.', url: 'https://syncthing.corposoft.net', category: 'Archivos', logo: 'syncthing', color: 'cyan' },
  { id: 'openclaw', name: 'OpenClaw', description: 'Asistentes, agentes y conversaciones.', url: 'https://app.corposoft.net', category: 'Productividad', logo: 'openclaw', color: 'coral' },
  { id: 'cockpit', name: 'Cockpit', description: 'Administración del sistema y servicios del servidor.', url: 'https://admin.corposoft.net', category: 'Sistema', logo: 'cockpit', color: 'mint' },
  { id: 'casa', name: 'Casa · NAS', description: 'Tu servidor de archivos NAS y almacenamiento en red.', url: 'https://casa.corposoft.net', category: 'Archivos', logo: 'home', color: 'amber' },
  { id: 'dashboard', name: 'NexoDashboard', description: 'Métricas, infraestructura y operación del servidor.', url: 'https://corposoft.net', category: 'Sistema', logo: 'nexo', color: 'purple' },
  { id: 'files', name: 'Archivos públicos', description: 'Subir archivos y compartir enlaces de descarga.', url: 'https://corposoft.net/files', category: 'Archivos', logo: 'files', color: 'cyan' },
];

function registerApplicationRoutes(app, storage) {
  // Se registra DESPUÉS de requireDashAuth: el listado público de archivos no
  // implica hacer pública la consola o el catálogo administrativo de apps.
  app.get('/api/applications', (req, res) => {
    res.json({ ok: true, applications: storage.getApplications(DEFAULT_APPLICATIONS), availabilityChecked: false });
  });
}
module.exports = { DEFAULT_APPLICATIONS, registerApplicationRoutes };
