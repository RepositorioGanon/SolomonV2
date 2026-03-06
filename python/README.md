# Norfair tracker (Python)

Servicio opcional que aplica **tracking multi-objeto con Norfair** sobre las detecciones (rois) que devuelve la inferencia del proyecto. Así puedes mantener IDs estables entre frames.

## Requisitos

- **Python 3.8+** (recomendado 3.10 o 3.11).

## Instalación en esta carpeta

Todo se hace dentro de `python/`, sin tocar el resto del proyecto.

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate   # En Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Ejecutar el servicio

```bash
# Desde la carpeta python, con el venv activado
python tracker_service.py
```

Por defecto escucha en **http://0.0.0.0:8083**. Para otro puerto:

```bash
TRACKER_PORT=5000 python tracker_service.py
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio y si Norfair está disponible. |
| POST | `/track` | Entrada: `{ "rois": [[x1,y1,x2,y2], ...], "scores": [...] }`. Devuelve `{ "tracked": [ { "track_id", "roi", "score" }, ... ] }`. |
| POST | `/track/inference` | Entrada: mismo JSON que devuelve tu `/api/inference`. Devuelve el mismo objeto con `principal.data[].tracked_detections` añadido (cada detección con `track_id`). |

## Integrar con Node

Desde tu `server.js` puedes, después de obtener la respuesta de inferencia, enviarla al tracker y devolver la respuesta enriquecida:

1. Tras `runInference()` y montar `responseBody`, hacer un `POST` a `http://localhost:8083/track/inference` con el cuerpo de la respuesta (incluyendo `principal`, etc.).
2. Usar la respuesta del tracker como respuesta final al cliente (ya incluye `tracked_detections` en cada elemento de `data`).

Si no quieres instalar Python ni ejecutar este servicio, la app sigue funcionando igual; el tracker es opcional.
