# Diagnóstico del volumen del reproductor interno

Revisión de solo lectura del servidor, 13 de octubre de 2026. No se modificó
volumen, mute, pista ni reproducción. MPD estaba pausado durante la lectura;
este diagnóstico compara niveles, no realiza una prueba de escucha.

Resultados:

- `mpc status`: volumen MPD 100 %.
- Flujo PulseAudio identificado como `Music Player Daemon`: 100 %, 0 dB,
  sin mute, conectado al sink 0.
- Salida predeterminada: analógica estéreo; volumen PulseAudio 77 %,
  −6,75 dB en ambos canales, sin mute.
- ALSA `Master`: 90 %, −6,75 dB. Es otra representación del mismo nivel
  atenuado; no multiplicar 90 % por 77 % como si fueran dos atenuaciones
  independientes. ALSA `PCM`: 100 %, 0 dB.

El endpoint `/api/player/volume` del dashboard solo manda `setvol` a MPD,
limitado a 0–100. No modifica el volumen de salida de PulseAudio/ALSA. Por eso
el panel puede mostrar 100 % aunque la salida final del sistema siga atenuada.
No se demostró un límite defectuoso del slider: lo comprobado es una segunda
capa de volumen que la UI actualmente no representa.

Mejora propuesta, pendiente de autorización de implementación: mostrar por
separado «Volumen de música (MPD)» y «Salida del sistema», dispositivo de
salida y mute. El control del sistema debe actuar en el sink correcto, admitir
fallos/permisos y confirmar el resultado real. No subir automáticamente el
master ni añadir amplificación superior a 100 %; conservar los niveles del
usuario. Avisar que subir la salida puede aumentar también el volumen de
otras aplicaciones.
