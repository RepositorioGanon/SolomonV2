require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const https = require('https');

const ffmpegPath = require('ffmpeg-static');
if (!ffmpegPath) {
  console.error('FFmpeg no disponible para esta plataforma. Instala ffmpeg en el sistema.');
}

const app = express();
// Servidor alterno en otro puerto (por ejemplo 8081)
const PORT = process.env.PORT_ALT || 8082;
const CAPTURE_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS) || 25000;
const CAPTURE_INTERVAL_MS = Number(process.env.CAPTURE_INTERVAL_MS) || 500;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (req, res) => {
  if (ffmpegPath) {
    return res.json({
      ok: true,
      ffmpeg: 'embebido',
      captureIntervalMs: CAPTURE_INTERVAL_MS
    });
  }
  res.status(503).json({ ok: false, error: 'FFmpeg no disponible. Instala con: sudo apt install ffmpeg' });
});

// Manejamos streams RTSP persistentes por URL para no reconectar FFmpeg en cada captura
const rtspStreams = new Map();

function getOrStartRtspStream(rtspUrl) {
  if (rtspStreams.has(rtspUrl)) return rtspStreams.get(rtspUrl);

  const stream = {
    ffmpeg: null,
    buffer: Buffer.alloc(0),
    lastFrame: null,
    lastFrameAt: 0,
    waiters: []
  };

  const ffmpeg = spawn(ffmpegPath, [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '5',
    '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  stream.ffmpeg = ffmpeg;
  rtspStreams.set(rtspUrl, stream);

  const SOI = Buffer.from([0xff, 0xd8]); // start of image
  const EOI = Buffer.from([0xff, 0xd9]); // end of image

  ffmpeg.stdout.on('data', (chunk) => {
    stream.buffer = Buffer.concat([stream.buffer, chunk]);
    let start = stream.buffer.indexOf(SOI);
    let end = stream.buffer.indexOf(EOI, start + 2);
    while (start !== -1 && end !== -1) {
      const frame = stream.buffer.slice(start, end + 2);
      stream.lastFrame = frame;
      stream.lastFrameAt = Date.now();
      if (stream.waiters.length) {
        const waiters = stream.waiters.slice();
        stream.waiters = [];
        waiters.forEach(w => {
          if (w && !w.done) {
            w.done = true;
            clearTimeout(w.timer);
            w.resolve(frame);
          }
        });
      }
      stream.buffer = stream.buffer.slice(end + 2);
      start = stream.buffer.indexOf(SOI);
      end = stream.buffer.indexOf(EOI, start + 2);
    }
  });

  ffmpeg.stderr.on('data', () => {
    // Podemos loguear si hace falta: console.error('ffmpeg rtsp stderr:', data.toString());
  });

  function cleanup(err) {
    rtspStreams.delete(rtspUrl);
    if (stream.waiters.length) {
      const waiters = stream.waiters.slice();
      stream.waiters = [];
      waiters.forEach(w => {
        if (w && !w.done) {
          w.done = true;
          clearTimeout(w.timer);
          w.reject(err || new Error('Stream RTSP cerrado'));
        }
      });
    }
  }

  ffmpeg.on('error', (err) => {
    cleanup(err);
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      cleanup(new Error('FFmpeg terminó con código ' + code));
    } else {
      cleanup();
    }
  });

  return stream;
}

// Captura un frame desde RTSP sin usar HTTP interno
function captureFrame(rtspUrl) {
  return new Promise((resolve, reject) => {
    const stream = getOrStartRtspStream(rtspUrl);

    if (stream.lastFrame) return resolve(stream.lastFrame);

    const waiter = { done: false };
    waiter.timer = setTimeout(() => {
      if (waiter.done) return;
      waiter.done = true;
      reject(new Error('Tiempo de espera agotado: la cámara no entregó frame'));
    }, CAPTURE_TIMEOUT_MS);

    waiter.resolve = (frame) => {
      if (waiter.done) return;
      waiter.done = true;
      clearTimeout(waiter.timer);
      resolve(frame);
    };

    waiter.reject = (err) => {
      if (waiter.done) return;
      waiter.done = true;
      clearTimeout(waiter.timer);
      reject(err);
    };

    stream.waiters.push(waiter);
  });
}

app.post('/api/capture', async (req, res) => {
  if (!ffmpegPath) {
    return res.status(503).json({
      error: 'FFmpeg no disponible.',
      detail: 'Instala FFmpeg en el sistema: sudo apt install ffmpeg (Linux) o brew install ffmpeg (macOS).'
    });
  }

  const rtspUrl = req.body?.url?.trim();
  if (!rtspUrl || !rtspUrl.toLowerCase().startsWith('rtsp://')) {
    return res.status(400).json({ error: 'URL RTSP no válida' });
  }

  try {
    const frame = await captureFrame(rtspUrl);
    const base64 = frame.toString('base64');
    res.json({
      image: 'data:image/jpeg;base64,' + base64,
      base64Jpg: base64
    });
  } catch (err) {
    res.status(500).json({
      error: 'Error al capturar la imagen',
      detail: err && err.message ? err.message : String(err || '')
    });
  }
});

const LOGIN_URL = process.env.LOGIN_URL;
// URL base del servidor de inferencia (para proyectos)
const INFERENCE_BASE = process.env.INFERENCE_BASE;
// URL de la inferencia principal (variable de entorno PRINCIPAL_INFERENCE_URL)
const PRINCIPAL_INFERENCE_URL = process.env.PRINCIPAL_INFERENCE_URL;
const LOGIN_USERNAME = process.env.LOGIN_USERNAME;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
// Flow principal de inferencia (cabecera Flow-Url)
const PRINCIPAL_FLOW_URL = process.env.PRINCIPAL_FLOW_URL;
const SECONDARY_FLOW_URL = process.env.SECONDARY_FLOW_URL;
const THIRD_FLOW_URL = process.env.THIRD_FLOW_URL;
// IDs de proyecto para resolver dinámicamente los flows
const PRINCIPAL_PROJECT_ID = process.env.PRINCIPAL_PROJECT_ID;
const SECONDARY_PROJECT_ID = process.env.SECONDARY_PROJECT_ID;
const THIRD_PROJECT_ID = process.env.THIRD_PROJECT_ID;
const TOKEN_TTL_MINUTES = process.env.TOKEN_TTL_MINUTES;
const TOKEN_TTL_MS = (Number(TOKEN_TTL_MINUTES) || 0) * 60 * 1000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Token usado para las peticiones de inferencia ("token inference")
let cachedInferenceToken = null;
let cachedInferenceTokenAt = 0;

function getInferenceToken() {
  const now = Date.now();
  if (cachedInferenceToken && (now - cachedInferenceTokenAt) < TOKEN_TTL_MS) {
    return Promise.resolve(cachedInferenceToken);
  }
  return axios.post(LOGIN_URL, { username: LOGIN_USERNAME, password: LOGIN_PASSWORD }, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'insomnia/12.1.0' },
    httpsAgent
  }).then((loginRes) => {
    const tokenInference = loginRes.data?.token;
    if (!tokenInference) {
      throw new Error('Login no devolvió token inference');
    }
    cachedInferenceToken = tokenInference;
    cachedInferenceTokenAt = Date.now();
    return tokenInference;
  });
}

// Obtiene flow_url y mapa class_id -> name desde un proyecto dado su ID.
// Devuelve { flowUrl, classIdToName } o null.
async function getFlowUrlFromProject(projectId, tokenInference) {
  if (!projectId || !INFERENCE_BASE) return null;
  const base = INFERENCE_BASE.replace(/\/+$/, '');
  const url = `${base}/v3/sol_server/project/${projectId}`;

  console.log('[project-flow] GET', url, 'projectId=', projectId);

  const resp = await axios.get(url, {
    headers: {
      Authorization: 'Bearer ' + tokenInference,
      'User-Agent': 'Mozilla/5.0'
    },
    httpsAgent,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  const data = resp.data && resp.data.data;
  const projectRule = data && data.project_rule;
  if (!projectRule || typeof projectRule !== 'object') return null;

  const firstKey = Object.keys(projectRule)[0];
  const state = firstKey && projectRule[firstKey];
  const flowUrl = state && state.flow_url;
  const resolvedFlowUrl = flowUrl ? String(flowUrl).trim() : null;

  // data.project_rule.State_1.client.config.class_name (array) -> mapa class_id -> name
  const client = state && state.client;
  const config = client && client.config;
  const classNameArr = config && Array.isArray(config.class_name) ? config.class_name : [];
  const classIdToName = {};
  for (const item of classNameArr) {
    if (item && typeof item.class_id !== 'undefined') {
      classIdToName[item.class_id] = item.name != null ? String(item.name) : String(item.class_id);
    }
  }

  console.log('[project-flow] resolved flow_url from project', projectId, '=>', resolvedFlowUrl, 'classIdToName =>', classIdToName);
  return { flowUrl: resolvedFlowUrl, classIdToName };
}

// Resuelve los flows (principal / secondary / third) usando SOLO el body del request.
// - Si el valor es un ID numérico (ej. 1), se resuelve vía getFlowUrlFromProject.
// - Si el valor es un string con el flow (ej. \"/test_4f5370...\"), se usa directamente.
async function resolveFlows(body, tokenInference) {
  const flows = [];
  const src = body || {};

  async function addFlow(name, key) {
    const raw = src[key];
    if (raw == null) return;
    const value = String(raw).trim();
    if (!value) return;

    let flowUrl = value;
    let classIdToName = null;


      console.log('[flows] resolving flowUrl from project id for', name, 'id =', value);
      try {
        const projectRes = await getFlowUrlFromProject(value, tokenInference);
        if (projectRes && projectRes.flowUrl) {
          flowUrl = projectRes.flowUrl;
          classIdToName = projectRes.classIdToName || null;
        } else {
          flowUrl = null;
        }
      } catch (e) {
        console.error('[flows] error resolving flow from project id', value, e.message || e);
        flowUrl = null;
      }
    
    if (!flowUrl) return;

    console.log('[flows] using', name, 'flowUrl =>', flowUrl);
    flows.push({ name, flowUrl, classIdToName });
  }

  await addFlow('principal', 'flowUrl');
  await addFlow('secondary', 'secondaryFlowUrl');
  await addFlow('third', 'thirdFlowUrl');

  return flows;
}

// Resuelve flows solo desde el body (strings). Sin consulta a proyecto ni classIdToName.
// Solo para inference-from-capture.
function resolveFlowsFromBodyOnly(body) {
  const flows = [];
  const src = body || {};
  const principal = (src.flowUrl != null ? String(src.flowUrl) : '').trim();
  if (principal) flows.push({ name: 'principal', flowUrl: principal });
  const secondary = (src.secondaryFlowUrl != null ? String(src.secondaryFlowUrl) : '').trim();
  if (secondary) flows.push({ name: 'secondary', flowUrl: secondary });
  const third = (src.thirdFlowUrl != null ? String(src.thirdFlowUrl) : '').trim();
  if (third) flows.push({ name: 'third', flowUrl: third });
  return flows;
}

// Inferencia directa al servidor externo, sin HTTP interno
async function runInference(buffer, flows, inferenceUrl, tokenInference) {
  const requests = flows.map((flow) => {
    const form = new FormData();
    form.append('files', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    form.append('llm_prompt', '{}');

    return axios.post(inferenceUrl, form, {
      headers: {
        'Authorization': 'Bearer ' + tokenInference,
        'Flow-Url': flow.flowUrl,
        'User-Agent': 'insomnia/12.1.0',
        ...form.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      httpsAgent
    })
      .then((r) => ({ name: flow.name, ok: true, status: r.status, data: r.data }))
      .catch((err) => ({
        name: flow.name,
        ok: false,
        status: err.response?.status || 500,
        error: { message: err.message, response: err.response?.data }
      }));
  });
  return Promise.all(requests);
}

// Añade class[] a cada elemento de data[]: [{ id, name }, ...] por cada class_id (por flow)
function enrichInferenceWithClassNames(flowData, classIdToName) {
  if (!flowData || typeof flowData !== 'object') return flowData;
  // classIdToName puede ser {} si el proyecto no tiene class_name; aun así añadimos class con id como name
  const map = classIdToName && typeof classIdToName === 'object' ? classIdToName : {};
  let dataArr = flowData.data;
  if (!Array.isArray(dataArr) && Array.isArray(flowData)) dataArr = flowData;
  if (!Array.isArray(dataArr)) return flowData;

  const enriched = {
    ...flowData,
    data: dataArr.map((item) => {
      const classIds = item && Array.isArray(item.class_ids) ? item.class_ids : [];
      const classArr = classIds.map((id) => ({
        id,
        name: map[id] != null ? map[id] : String(id)
      }));
      return { ...item, class: classArr };
    })
  };
  console.log('[enrich] class aplicado a', dataArr.length, 'elemento(s) con classIdToName', Object.keys(map).length ? map : '(sin mapa)');
  return enriched;
}

// Aplica la máscara en un Worker Thread para no bloquear el event loop
function aplicarMascaraEnWorker(base64Jpg, response) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'mask-worker.js'), {
      workerData: { base64Jpg, response }
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error('mask-worker salió con código ' + code));
    });
  });
}

app.post('/api/inference', async (req, res) => {
  const base64Jpg = (req.body?.base64Jpg || '').trim();
  if (!base64Jpg) {
    return res.status(400).json({ error: 'Falta base64Jpg (imagen en base64 JPG).' });
  }
  let buffer;
  try {
    buffer = Buffer.from(base64Jpg, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'base64Jpg no es base64 válido.', detail: e.message });
  }
  const inferenceUrl = (req.body?.inferenceUrl || PRINCIPAL_INFERENCE_URL || '').trim();

  try {
    const tokenInference = await getInferenceToken();
    const flows = await resolveFlows(req.body || {}, tokenInference);

    const principalFlow = flows.find(f => f.name === 'principal');
    if (!principalFlow) {
      return res.status(400).json({ error: 'Falta flowUrl (flow principal es obligatorio).' });
    }

    const results = await runInference(buffer, flows, inferenceUrl, tokenInference);

    const responseBody = {};
    let anyOk = false;
    let firstStatus = 200;
    results.forEach((r, idx) => {
      if (idx === 0) firstStatus = r.status || 200;
      if (r.ok) {
        anyOk = true;
        const flowMeta = flows.find((f) => f.name === r.name);
        const classIdToName = flowMeta && flowMeta.classIdToName ? flowMeta.classIdToName : null;
        responseBody[r.name] = enrichInferenceWithClassNames(r.data, classIdToName) || r.data;
      } else {
        responseBody[r.name] = { error: 'Error en inferencia', detail: r.error };
      }
    });

    // Aplicar máscara usando el flujo principal (si existe) y devolver también la imagen enmascarada
    const mascaraResponse = responseBody.principal || responseBody;
    let maskedBase64Jpg = null;
    try {
      maskedBase64Jpg = await aplicarMascaraEnWorker(base64Jpg, mascaraResponse);
    } catch (_) {
      // Si falla el enmascarado, seguimos respondiendo solo con los datos de inferencia
    }

    res.status(anyOk ? 200 : firstStatus).json({
      maskedBase64Jpg: maskedBase64Jpg || base64Jpg,
      ...responseBody
    });
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({
      error: 'Error al obtener token o llamar al servidor de inferencia.',
      detail: err.message,
      response: err.response?.data
    });
  }
});

// POST /api/inference-from-capture: pipeline completo sin llamadas HTTP internas
app.post('/api/inference-from-capture', async (req, res) => {
  try {
    const rtspUrl = (req.body?.url || '').trim();
    if (!rtspUrl || !rtspUrl.toLowerCase().startsWith('rtsp://')) {
      return res.status(400).json({ error: 'URL RTSP no válida' });
    }
    const inferenceUrl = (req.body?.inferenceUrl || PRINCIPAL_INFERENCE_URL || '').trim();

    // Captura y token en paralelo (no hay dependencia entre sí)
    const [frame, tokenInference] = await Promise.all([captureFrame(rtspUrl), getInferenceToken()]);

    const base64Jpg = frame.toString('base64');

    // Aquí SÍ resolvemos también IDs de proyecto y clases, igual que en /api/inference
    const flows = await resolveFlows(req.body || {}, tokenInference);
    console.log('[inference-from-capture] flows =>', flows);
    const principalFlow = flows.find(f => f.name === 'principal');
    if (!principalFlow) {
      return res.status(400).json({ error: 'Falta flowUrl (flow principal es obligatorio).' });
    }

    // Inferencia directa (sin HTTP interno)
    const results = await runInference(frame, flows, inferenceUrl, tokenInference);

    const inferenceData = {};
    results.forEach((r) => {
      if (r.ok) {
        const flowMeta = flows.find((f) => f.name === r.name);
        const classIdToName = flowMeta && flowMeta.classIdToName ? flowMeta.classIdToName : null;
        inferenceData[r.name] = enrichInferenceWithClassNames(r.data, classIdToName) || r.data;
      } else {
        inferenceData[r.name] = { error: 'Error en inferencia', detail: r.error };
      }
    });

    // Máscara en Worker Thread (no bloquea el event loop)
    const mascaraResponse = inferenceData.principal || inferenceData;
    let maskedBase64Jpg = null;
    try {
      maskedBase64Jpg = await aplicarMascaraEnWorker(base64Jpg, mascaraResponse);
    } catch (_) {
      // Si falla el enmascarado, se usa la imagen original
    }

    return res.json({
      originalBase64Jpg: base64Jpg,
      maskedBase64Jpg: maskedBase64Jpg || base64Jpg,
      inference: inferenceData
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Error en /api/inference-from-capture',
      detail: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor alterno en http://localhost:${PORT}`);
});

