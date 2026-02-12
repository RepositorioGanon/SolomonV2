require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const FormData = require('form-data');
const axios = require('axios');
const https = require('https');

const ffmpegPath = require('ffmpeg-static');
if (!ffmpegPath) {
  console.error('FFmpeg no disponible para esta plataforma. Instala ffmpeg en el sistema.');
}

const app = express();
const PORT = 8080;
const CAPTURE_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS);
const CAPTURE_INTERVAL_MS = Number(process.env.CAPTURE_INTERVAL_MS);

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

app.post('/api/capture', (req, res) => {
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

  const stream = getOrStartRtspStream(rtspUrl);
  let responded = false;

  function sendError(status, body) {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  }

  function sendFrame(frame) {
    if (responded) return;
    if (!frame) {
      return sendError(500, { error: 'No se obtuvo frame de la cámara' });
    }
    const base64 = frame.toString('base64');
    responded = true;
    res.json({
      image: 'data:image/jpeg;base64,' + base64,
      base64Jpg: base64
    });
  }

  if (stream.lastFrame) {
    return sendFrame(stream.lastFrame);
  }

  const waiter = {};
  waiter.timer = setTimeout(() => {
    if (waiter.done) return;
    waiter.done = true;
    sendError(500, {
      error: 'Tiempo de espera agotado.',
      detail: 'La cámara no entregó ningún frame en el tiempo esperado.'
    });
  }, CAPTURE_TIMEOUT_MS);

  waiter.resolve = (frame) => {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    sendFrame(frame);
  };

  waiter.reject = (err) => {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    sendError(500, {
      error: 'Error al capturar la imagen',
      detail: err && err.message ? err.message : String(err || '')
    });
  };

  stream.waiters.push(waiter);
});

// Buscar información de transacción (principal) por documentnumber
app.post('/api/transaction', async (req, res) => {
  try {
    const documentnumber = (req.body?.documentnumber || '').trim();
    if (!documentnumber) {
      return res.status(400).json({ success: false, error: 'Falta documentnumber' });
    }

    const url = `https://4804048-sb1.extforms.netsuite.com/app/site/hosting/scriptlet.nl?script=5764&deploy=1&compid=4804048_SB1&ns-at=AAEJ7tMQ4qcVMm95zZ5sVOGeKI5a3vV726o76TlrAkQ6K0HfOMs&documentnumber=${encodeURIComponent(documentnumber)}`;
    const requestBody = { url };

    const resp = await axios.post(
      'https://sb.broches.com.mx/Herramientas/RG-Solomon-CA/services/bypass_get.ss',
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'rtsp-inference-ui/1.0'
        }
      }
    );

    res.status(200).json(resp.data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Error al consultar la transacción principal',
      detail: err && err.message ? err.message : String(err || '')
    });
  }
});

const LOGIN_URL = process.env.LOGIN_URL;
// URL de la inferencia principal (variable de entorno PRINCIPAL_INFERENCE_URL)
const PRINCIPAL_INFERENCE_URL = process.env.PRINCIPAL_INFERENCE_URL;
const LOGIN_USERNAME = process.env.LOGIN_USERNAME;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
// Flow principal de inferencia (cabecera Flow-Url)
const PRINCIPAL_FLOW_URL = process.env.PRINCIPAL_FLOW_URL;
const SECONDARY_FLOW_URL = process.env.SECONDARY_FLOW_URL;
const THIRD_FLOW_URL = process.env.THIRD_FLOW_URL;
const TOKEN_TTL_MINUTES = process.env.TOKEN_TTL_MINUTES;
const TOKEN_TTL_MS = (Number(TOKEN_TTL_MINUTES) || 0) * 60 * 1000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Token usado para las peticiones de inferencia (\"token inference\")
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

app.post('/api/inference', (req, res) => {
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
  // URL de inferencia (misma para todos los flows)
  const inferenceUrl = (req.body?.inferenceUrl || PRINCIPAL_INFERENCE_URL || '').trim();

  getInferenceToken()
    .then((tokenInference) => {
      // Definimos los flows a consultar con la MISMA imagen
      const flows = [
        {
          name: 'principal',
          flowUrl: (req.body?.flowUrl || PRINCIPAL_FLOW_URL || '').trim()
        },
        {
          name: 'secondary',
          flowUrl: (req.body?.secondaryFlowUrl || SECONDARY_FLOW_URL || '').trim()
        },
        {
          name: 'third',
          flowUrl: (req.body?.thirdFlowUrl || THIRD_FLOW_URL || '').trim()
        }
      ].filter(f => f.flowUrl);

      if (!flows.length) {
        throw new Error('No hay flows configurados para la inferencia');
      }

      // Ejecutamos las inferencias en paralelo, reutilizando el mismo buffer de imagen
      const requests = flows.map((flow) => {
        const form = new FormData();
        form.append('files', buffer, {
          filename: 'image.jpg',
          contentType: 'image/jpeg'
        });
        form.append('llm_prompt', '{}');

        const headers = {
          'Authorization': 'Bearer ' + tokenInference,
          'Flow-Url': flow.flowUrl,
          'User-Agent': 'insomnia/12.1.0',
          ...form.getHeaders()
        };

        return axios.post(inferenceUrl, form, {
          headers,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          httpsAgent
        }).then((axRes) => ({
          name: flow.name,
          ok: true,
          status: axRes.status,
          data: axRes.data
        })).catch((err) => ({
          name: flow.name,
          ok: false,
          status: err.response?.status || 500,
          error: {
            message: err.message,
            response: err.response?.data
          }
        }));
      });

      return Promise.all(requests);
    })
    .then((results) => {
      // Armamos un único JSON con los nodos por flow
      const responseBody = {};
      let anyOk = false;
      let firstStatus = 200;

      results.forEach((r, idx) => {
        if (idx === 0) firstStatus = r.status || 200;
        if (r.ok) {
          anyOk = true;
          responseBody[r.name] = r.data;
        } else {
          responseBody[r.name] = {
            error: 'Error en inferencia',
            detail: r.error
          };
        }
      });

      const status = anyOk ? 200 : firstStatus;
      res.status(status).json(responseBody);
    })
    .catch((err) => {
      if (err.message === 'Login no devolvió token' || (err.config && !err.config.url.includes('/inference'))) {
        return res.status(502).json({
          error: 'Error al obtener token (login).',
          detail: err.message,
          response: err.response?.data
        });
      }
      const status = err.response?.status || 500;
      const data = err.response?.data;
      res.status(status).json({
        error: 'Error al llamar al servidor de inferencia.',
        detail: err.message,
        response: data
      });
    });
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
