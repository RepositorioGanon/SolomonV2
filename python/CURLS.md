# Curls para probar el servicio Norfair

El servicio debe estar corriendo en **http://localhost:8083** (por defecto). Para arrancarlo:

```bash
cd python
./run.sh
# o: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python tracker_service.py
```

---

## 1. Health

```bash
curl -s http://localhost:8083/health | jq
```

Respuesta esperada: `{ "ok": true, "norfair": true }`

---

## 2. Track (solo rois)

Envía una lista de cajas `[x1, y1, x2, y2]` y opcionalmente `scores`. El tracker devuelve las mismas cajas con `track_id` estable.

```bash
curl -s -X POST http://localhost:8083/track \
  -H "Content-Type: application/json" \
  -d '{
    "rois": [
      [100, 50, 200, 150],
      [300, 80, 400, 180]
    ],
    "scores": [0.95, 0.87]
  }' | jq
```

Ejemplo de respuesta:

```json
{
  "tracked": [
    { "track_id": 1, "roi": [100, 50, 200, 150], "score": 0.95 },
    { "track_id": 2, "roi": [300, 80, 400, 180], "score": 0.87 }
  ]
}
```

Llamar de nuevo con rois similares (mismo objeto movido un poco) y verás que los `track_id` se mantienen.

```bash
curl -s -X POST http://localhost:8083/track \
  -H "Content-Type: application/json" \
  -d '{
    "rois": [
      [105, 52, 205, 152],
      [305, 82, 405, 182]
    ],
    "scores": [0.93, 0.88]
  }' | jq
```

---

## 3. Track / inference (formato respuesta de tu API)

Simula el cuerpo que devuelve tu `/api/inference` (flow `principal` con `data[].rois`). El servicio devuelve el mismo JSON con `principal.data[].tracked_detections` añadido.

```bash
curl -s -X POST http://localhost:8083/track/inference \
  -H "Content-Type: application/json" \
  -d '{
    "principal": {
      "data": [
        {
          "rois": [[10, 20, 110, 120], [200, 50, 300, 150]],
          "class_ids": [1, 1]
        }
      ]
    }
  }' | jq
```

En la respuesta verás algo como:

```json
{
  "principal": {
    "data": [
      {
        "rois": [[10, 20, 110, 120], [200, 50, 300, 150]],
        "class_ids": [1, 1],
        "tracked_detections": [
          { "track_id": 1, "roi": [10, 20, 110, 120], "score": 1.0 },
          { "track_id": 2, "roi": [200, 50, 300, 150], "score": 1.0 }
        ]
      }
    ]
  }
}
```

---

## Variar puerto

Si arrancas el servicio en otro puerto:

```bash
TRACKER_PORT=5000 .venv/bin/python tracker_service.py
```

Usa en los curls el puerto que hayas configurado (ej. `http://localhost:5000`).
