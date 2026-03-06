r"""
Servicio Flask que recibe las respuestas de inferencia (rois) del proyecto SolomonV2,
aplica tracking con Norfair y devuelve las mismas detecciones con track_id estable.

Uso:
  cd python && python -m venv .venv && source .venv/bin/activate  (Windows: .venv\Scripts\activate)
  pip install -r requirements.txt
  python tracker_service.py

POST /track
  Body: { "rois": [[x1,y1,x2,y2], ...], "scores": [0.9, ...] }  (scores opcional)
  Response: { "tracked": [ { "track_id": 1, "roi": [x1,y1,x2,y2], "score": 0.9 }, ... ] }

POST /track/inference
  Body: mismo JSON que devuelve /api/inference (objeto con flow "principal" y data[].rois).
  Response: mismo objeto con data[].track_id añadidos (por elemento de data).
"""
import os
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Norfair: import después de tener el venv con norfair instalado
try:
    from norfair import Detection, Tracker
    NORFAIR_AVAILABLE = True
except ImportError:
    NORFAIR_AVAILABLE = False

# Tracker global: un solo tracker para mantener IDs entre llamadas
_tracker = None

# Historial para delta entre frames: IDs del frame anterior y todos los vistos
_last_frame_ids = set()
_all_time_ids = set()


def get_tracker():
    global _tracker
    if _tracker is None and NORFAIR_AVAILABLE:
        # Centroid + euclidean evita el error del filtro Kalman con bbox (dim 2 vs 4).
        # Usamos un distance_threshold muy alto para que un mismo objeto pueda
        # moverse por toda la imagen y conserve su track_id; solo cuando deja
        # de verse suficientes frames (hit_counter_max) y luego vuelve a entrar,
        # se le asignará un track_id nuevo.
        _tracker = Tracker(
            distance_function="euclidean",
            distance_threshold=10000.0,
            hit_counter_max=5,
            initialization_delay=0,
        )
    return _tracker


def _roi_centroid(roi):
    """Centroide de [x1, y1, x2, y2]."""
    if len(roi) != 4:
        return None
    x1, y1, x2, y2 = float(roi[0]), float(roi[1]), float(roi[2]), float(roi[3])
    return np.array([[(x1 + x2) / 2, (y1 + y2) / 2]], dtype=np.float32)


def rois_to_detections(rois, scores=None):
    """Convierte rois [x1,y1,x2,y2] a Norfair Detection con un punto (centroide)."""
    if not NORFAIR_AVAILABLE or not rois:
        return []
    dets = []
    for i, roi in enumerate(rois):
        if len(roi) != 4:
            continue
        x1, y1, x2, y2 = float(roi[0]), float(roi[1]), float(roi[2]), float(roi[3])
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        points = np.array([[cx, cy]], dtype=np.float32)
        score = (scores[i] if scores and i < len(scores) else 1.0)
        dets.append(Detection(points=points, scores=np.array([score])))
    return dets


def _get_estimate_point(obj):
    """Extrae (x, y) del estimate del TrackedObject. estimate puede ser ndarray o tener .points."""
    if not hasattr(obj, "estimate") or obj.estimate is None:
        return None
    est = obj.estimate
    pts = getattr(est, "points", None)
    if pts is None and isinstance(est, np.ndarray):
        pts = est
    if pts is None:
        return None
    pts = np.asarray(pts)
    if pts.size < 2:
        return None
    if pts.ndim == 2:
        return pts[0]
    return pts[:2]


def tracked_to_rois(tracked_objects, original_rois, original_scores=None):
    """
    Empareja cada TrackedObject con el roi original más cercano por centroide
    y devuelve lista de { track_id, roi, score }.
    """
    if not original_rois:
        return []
    rois = []
    for r in original_rois:
        nr = _normalize_roi(r)
        if nr is None and isinstance(r, (list, tuple)) and len(r) >= 4:
            nr = [float(r[0]), float(r[1]), float(r[2]), float(r[3])]
        if nr is not None:
            rois.append(nr)
    if not rois:
        return []
    used = set()
    out = []
    for obj in tracked_objects:
        est = _get_estimate_point(obj)
        if est is None:
            continue
        est = np.asarray(est).flatten()[:2]
        score = 1.0
        if hasattr(obj, "estimate") and obj.estimate is not None and getattr(obj.estimate, "scores", None) is not None:
            s = obj.estimate.scores
            if len(s):
                score = float(s[0])
        best_i = None
        best_d = np.inf
        for i, roi in enumerate(rois):
            if i in used:
                continue
            c = _roi_centroid(roi)
            if c is None:
                continue
            d = float(np.linalg.norm(np.asarray(c).flatten()[:2] - est))
            if d < best_d:
                best_d = d
                best_i = i
        if best_i is not None:
            used.add(best_i)
            sc = original_scores[best_i] if original_scores and best_i < len(original_scores) else score
            out.append({
                "track_id": int(obj.id),
                "roi": list(rois[best_i]),
                "score": sc,
            })
    return out


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "norfair": NORFAIR_AVAILABLE,
    })


def _normalize_roi(roi):
    """Convierte roi a [x1, y1, x2, y2] (lista de 4 números). Acepta lista o dict."""
    if isinstance(roi, (list, tuple)) and len(roi) >= 4:
        return [float(roi[0]), float(roi[1]), float(roi[2]), float(roi[3])]
    if isinstance(roi, dict):
        x1 = roi.get("x1") or roi.get("xmin") or roi.get("left")
        y1 = roi.get("y1") or roi.get("ymin") or roi.get("top")
        x2 = roi.get("x2") or roi.get("xmax") or roi.get("right")
        y2 = roi.get("y2") or roi.get("ymax") or roi.get("bottom")
        if x1 is not None and y1 is not None and x2 is not None and y2 is not None:
            return [float(x1), float(y1), float(x2), float(y2)]
    return None


def _extract_rois_and_scores(data):
    """Extrae rois y scores del body. Acepta { rois, scores } o { principal: { data: [ { rois, scores } ] } }."""
    rois = data.get("rois") or []
    scores = data.get("scores")
    if not rois and data.get("principal"):
        d = data.get("principal", {}).get("data") or []
        if d and isinstance(d, list) and len(d) > 0:
            first = d[0] if isinstance(d[0], dict) else None
            if first:
                rois = first.get("rois") or []
                scores = first.get("scores")
    normalized = []
    for r in rois:
        nr = _normalize_roi(r)
        if nr is not None:
            normalized.append(nr)
    return normalized, scores


def _reset_history():
    """Limpia el historial (útil al iniciar una nueva sesión de conteo)."""
    global _last_frame_ids, _all_time_ids
    _last_frame_ids = set()
    _all_time_ids = set()


def _compute_history(tracked):
    """
    Compara los track_id del frame actual con el anterior.
    Devuelve dict con: current_count, previous_count, entered, exited, total_unique_seen.
    """
    global _last_frame_ids, _all_time_ids
    current_ids = {t["track_id"] for t in tracked}
    previous_count = len(_last_frame_ids)
    current_count = len(current_ids)
    entered = list(current_ids - _last_frame_ids)
    exited = list(_last_frame_ids - current_ids)
    _all_time_ids |= current_ids
    _last_frame_ids = current_ids

    history = {
        "current_count": current_count,
        "previous_count": previous_count,
        "entered": entered,
        "exited": exited,
        "total_unique_seen": len(_all_time_ids),
    }

    # Log simple en consola del servicio Python
    print("[tracker] current_ids=", sorted(current_ids),
          "entered=", sorted(entered),
          "exited=", sorted(exited),
          "total_unique_seen=", history["total_unique_seen"]),
    flush = getattr(__builtins__, "flush", None)
    try:
        # Forzar flush si estamos en entorno buffered
        import sys
        sys.stdout.flush()
    except Exception:
        pass

    return history


@app.route("/track/reset", methods=["POST"])
def track_reset():
    """Resetea el historial de conteo (entered/exited/total_unique_seen). Útil al iniciar nueva sesión."""
    _reset_history()
    return jsonify({"ok": True, "message": "Historial reseteado."})


@app.route("/track", methods=["POST"])
def track():
    """Entrada: { rois: [[x1,y1,x2,y2], ...], scores?: number[] } o formato inference (principal.data[].rois). Query: ?reset=1 para resetear historial antes de procesar."""
    if not NORFAIR_AVAILABLE:
        return jsonify({"error": "Norfair no está instalado. Ejecuta: pip install -r requirements.txt"}), 503
    if request.args.get("reset") in ("1", "true", "yes"):
        _reset_history()
    data = request.get_json() or {}
    rois, scores = _extract_rois_and_scores(data)
    tracker = get_tracker()
    # Si no hay rois en este frame, igualmente avanzamos el tracker con detections=None
    # para que los tracks existentes puedan "morir" después de varios frames sin verse.
    if not rois:
        if tracker is not None:
            tracker.update(detections=None)
        return jsonify({"tracked": [], "history": _compute_history([])})

    detections = rois_to_detections(rois, scores)
    if not detections:
        if tracker is not None:
            tracker.update(detections=None)
        return jsonify({"tracked": [], "history": _compute_history([])})
    tracked_objects = tracker.update(detections=detections)
    tracked = tracked_to_rois(tracked_objects, rois, scores)
    history = _compute_history(tracked)
    return jsonify({"tracked": tracked, "history": history})


def add_track_ids_to_inference_response(body):
    """
    Recibe el cuerpo de respuesta de /api/inference (principal con data[].rois).
    Por cada elemento en data[], aplica tracking y añade "tracked_detections" con track_id por detección.
    """
    if not NORFAIR_AVAILABLE or not body:
        return body
    principal = body.get("principal") or body
    data = principal.get("data")
    if not isinstance(data, list):
        return body
    tracker = get_tracker()
    any_rois = False
    for item in data:
        rois = item.get("rois")
        if not rois:
            continue
        any_rois = True
        scores = item.get("scores") if isinstance(item.get("scores"), list) else None
        detections = rois_to_detections(rois, scores)
        tracked_objects = tracker.update(detections=detections)
        tracked = tracked_to_rois(tracked_objects, rois, scores)
        item["tracked_detections"] = tracked
    # Si en este frame no hubo ningún item con rois, avanzamos el tracker con detections=None
    # para que los tracks vayan expirando con hit_counter_max.
    if tracker is not None and not any_rois:
        tracker.update(detections=None)
    return body


@app.route("/track/inference/example", methods=["GET"])
def track_inference_example():
    """
    Ejemplo de respuesta que deberías ver al hacer POST /track/inference con el body de tu /api/inference.
    """
    return jsonify({
        "principal": {
            "data": [
                {
                    "rois": [[10, 20, 110, 120], [200, 50, 300, 150]],
                    "class_ids": [1, 1],
                    "tracked_detections": [
                        {"track_id": 1, "roi": [10, 20, 110, 120], "score": 1.0},
                        {"track_id": 2, "roi": [200, 50, 300, 150], "score": 1.0},
                    ],
                }
            ]
        },
        "_comment": "POST /track/inference devuelve tu mismo JSON con principal.data[].tracked_detections añadido.",
    })


@app.route("/track/inference", methods=["POST"])
def track_inference():
    """
    Entrada: mismo JSON que devuelve tu /api/inference (principal.data[].rois).
    Salida: mismo JSON con data[].tracked_detections y history (conteo vs frame anterior).
    """
    if not NORFAIR_AVAILABLE:
        return jsonify({"error": "Norfair no instalado."}), 503
    if request.args.get("reset") in ("1", "true", "yes"):
        _reset_history()
    body = request.get_json() or {}
    result = add_track_ids_to_inference_response(body)
    # Historial a partir del primer data[].tracked_detections
    tracked_list = []
    principal = result.get("principal") or result
    data = principal.get("data") or []
    if data and isinstance(data, list):
        for item in data:
            td = item.get("tracked_detections") or []
            tracked_list.extend(td)
    result["history"] = _compute_history(tracked_list)
    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("TRACKER_PORT", "8083"))
    app.run(host="0.0.0.0", port=port, debug=False)
