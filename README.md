# Captura de imagen desde cámara RTSP

Interfaz para introducir una URL RTSP y descargar una imagen (frame) de la cámara.

## Requisitos

- **Node.js** (v14 o superior)
- **FFmpeg**: incluido en el proyecto vía `ffmpeg-static` (Linux, macOS, Windows). Si en tu plataforma no funciona, instala FFmpeg en el sistema: `sudo apt install ffmpeg` (Ubuntu/Debian) o `brew install ffmpeg` (macOS).

## Cómo ejecutar

```bash
npm install
npm start
```

Abre en el navegador: **http://localhost:8080**

1. Pega la URL de tu cámara RTSP (ej: `rtsp://usuario:password@192.168.1.100:554/stream`).
2. Pulsa **"Descargar imagen"**.
3. Se descargará un archivo `camara-capture.jpg` con el frame actual.
