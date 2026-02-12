(function () {
  'use strict';

  angular
    .module('miApp', [])
    .controller('RtspController', RtspController);

  function RtspController($scope, $http, $timeout, $interval) {
    $scope.rtspUrl = '';
    $scope.cargando = false;
    $scope.mensaje = '';
    $scope.mensajeError = false;
    $scope.servidorOk = true;

    var apiBase = (window.location.protocol === 'http:' && window.location.port === '8080')
      ? ''
      : 'http://localhost:8080';

    $scope.captureIntervalMs = 500;

    $http.get(apiBase + '/api/health').then(function (r) {
      $scope.servidorOk = r.data && r.data.ok;
      if (r.data && typeof r.data.captureIntervalMs === 'number' && r.data.captureIntervalMs > 0) {
        $scope.captureIntervalMs = r.data.captureIntervalMs;
      }
    }).catch(function (err) {
      $scope.servidorOk = false;
      if (err.status === 503 && err.data && err.data.error) {
        $scope.mensaje = err.data.error;
      } else {
        $scope.mensaje = 'No se pudo conectar al servidor. Ejecuta en la terminal: npm start';
      }
      $scope.mensajeError = true;
    });

    $scope.imagenBase64 = '';
    $scope.transaccionTexto = '';
    $scope.transaccionInfo = null;
    $scope.transaccionItems = [];
    $scope.transMensaje = '';
    $scope.transMensajeError = false;
    var intervalAutoCaptura = null;
    $scope.autoCapturaActiva = false;

    $scope.iniciarAutoCaptura = function () {
      var url = ($scope.rtspUrl || '').trim();
      if (!url || !url.toLowerCase().match(/^rtsp:\/\//)) {
        $scope.mensaje = 'Escribe una URL RTSP válida para iniciar.';
        $scope.mensajeError = true;
        return;
      }
      if (intervalAutoCaptura) return;
      $scope.autoCapturaActiva = true;
      $scope.capturarEInferir();
      intervalAutoCaptura = $interval(function () {
        if (!$scope.cargando && $scope.autoCapturaActiva) {
          $scope.capturarEInferir();
        }
      }, $scope.captureIntervalMs || 500);
    };

    $scope.detenerAutoCaptura = function () {
      if (intervalAutoCaptura) {
        $interval.cancel(intervalAutoCaptura);
        intervalAutoCaptura = null;
      }
      $scope.autoCapturaActiva = false;
    };

    $scope.$on('$destroy', function () {
      $scope.detenerAutoCaptura();
    });

    $scope.capturarEInferir = function () {
      var url = ($scope.rtspUrl || '').trim();
      if (!url || !url.toLowerCase().match(/^rtsp:\/\//)) {
        $scope.mensaje = 'Escribe una URL RTSP válida (ej: rtsp://...)';
        $scope.mensajeError = true;
        return;
      }

      var esAuto = $scope.autoCapturaActiva;
      $scope.cargando = true;
      if (!esAuto) {
        $scope.mensaje = 'Capturando...';
        $scope.mensajeError = false;
        $scope.imagenBase64 = '';
        $scope.base64Jpg = '';
        $scope.inferenceResult = null;
      }

      $http({ method: 'POST', url: apiBase + '/api/capture', data: { url: url } })
        .then(function (res) {
          var data = res.data || {};
          var base64Jpg = data.base64Jpg || (data.image ? data.image.replace(/^data:image\/jpeg;base64,/, '') : '');
          if (!base64Jpg) {
            $scope.mensaje = 'No se recibió imagen.';
            $scope.mensajeError = true;
            return;
          }
          if (!esAuto) $scope.mensaje = 'Enviando a inferencia...';
          $scope.base64Jpg = base64Jpg;
          return $http.post(apiBase + '/api/inference', { base64Jpg: base64Jpg });
        })
        .then(function (inferenceRes) {
          if (!inferenceRes) return;
          $scope.inferenceResult = inferenceRes.data;
          if (!esAuto) $scope.mensaje = 'Listo.';
          $scope.mensajeError = false;
          var dataUrlImagen = 'data:image/jpeg;base64,' + $scope.base64Jpg;
          // El marcado/enmascarado debe basarse en el flow PRIMARIO
          var mascaraResponse = ($scope.inferenceResult && $scope.inferenceResult.principal)
            ? $scope.inferenceResult.principal
            : $scope.inferenceResult;
          return aplicarMascaraDesdeResponse(dataUrlImagen, mascaraResponse);
        })
        .then(function (dataUrl) {
          $timeout(function () {
            if (dataUrl) {
              $scope.imagenBase64 = dataUrl;
              $scope.base64Jpg = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
            } else {
              $scope.imagenBase64 = 'data:image/jpeg;base64,' + $scope.base64Jpg;
            }
          }, 0);
        })
        .catch(function (err) {
          if (err.status === 0 || (err.config && !err.config.url)) {
            $scope.mensaje = 'No se pudo conectar al servidor. Inicia el servidor con: npm start';
          } else if (err.status === 400) {
            $scope.mensaje = (err.data && err.data.error) ? err.data.error : 'URL RTSP no válida.';
          } else if (err.data && err.data.error) {
            $scope.mensaje = err.data.error;
            if (err.data.detail) $scope.mensaje += ' ' + err.data.detail;
          } else {
            $scope.mensaje = err.mensaje || (err.data && err.data.error) || 'Error en captura o inferencia.';
          }
          $scope.inferenceResult = err.data || null;
          $scope.mensajeError = true;
        })
        .finally(function () {
          $scope.cargando = false;
        });
    };

    $scope.copiarBase64 = function () {
      if (!$scope.imagenBase64) return;
      var raw = $scope.base64Jpg || $scope.imagenBase64.replace(/^data:image\/jpeg;base64,/, '');
      var ta = document.createElement('textarea');
      ta.value = raw;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        $scope.mensaje = 'Base64 copiado al portapapeles (solo datos, sin data URL).';
        $scope.mensajeError = false;
      } catch (e) {
        $scope.mensaje = 'No se pudo copiar. Usa la vista previa o el texto debajo.';
        $scope.mensajeError = true;
      }
      document.body.removeChild(ta);
    };

    $scope.buscarTransaccion = function () {
      var doc = ($scope.transaccionTexto || '').trim();
      if (!doc) {
        $scope.transMensaje = 'Escribe un número de transacción (documentNumber).';
        $scope.transMensajeError = true;
        return;
      }
      $scope.transMensaje = 'Buscando transacción principal...';
      $scope.transMensajeError = false;
      $scope.transaccionInfo = null;
      $scope.transaccionItems = [];

      $http.post(apiBase + '/api/transaction', { documentnumber: doc })
        .then(function (res) {
          var data = res.data || {};
          if (!data.success) {
            $scope.transMensaje = data.error || 'No se encontró la transacción.';
            $scope.transMensajeError = true;
            return;
          }
          $scope.transaccionInfo = data.transaction || null;
          $scope.transaccionItems = (data.items || []).map(function (it) {
            var total = Number(it.quantity) || 0;
            return angular.extend({}, it, {
              totalQty: total,
              capturada: 0
            });
          });
          $scope.transMensaje = 'Transacción principal cargada.';
          $scope.transMensajeError = false;

          // Al cargar la transacción principal, iniciar también la vista previa (autocaptura),
          // siempre que haya una URL RTSP válida y no esté ya activa.
          var url = ($scope.rtspUrl || '').trim();
          if (url.toLowerCase().match(/^rtsp:\/\//) && !$scope.autoCapturaActiva) {
            $scope.iniciarAutoCaptura();
          }
        })
        .catch(function (err) {
          $scope.transMensaje = (err.data && err.data.error) || 'Error al consultar la transacción.';
          $scope.transMensajeError = true;
        });
    };

    $scope.actualizarSuma = function (item) {
      if (!item) return;
      if (item.capturada == null || isNaN(item.capturada)) item.capturada = 0;
      if (item.capturada < 0) item.capturada = 0;
      if (item.capturada > item.totalQty) item.capturada = item.totalQty;
    };

    $scope.inferenceResult = null;

    function aplicarMascaraDesdeResponse(dataUrlImagen, response) {
      var data0 = response && response.data && response.data[0];
      if (!data0 || !data0.masks || !data0.masks_shape_list || !data0.rois || !data0.masks_shape_list.length || !data0.rois.length) {
        return Promise.resolve(null);
      }
      var masksStr = data0.masks;
      var shapes = data0.masks_shape_list;
      var rois = data0.rois;

      var img = new Image();
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var deferred = { resolve: null, reject: null };
      var p = new Promise(function (resolve, reject) {
        deferred.resolve = resolve;
        deferred.reject = reject;
      });

      img.onload = function () {
        try {
          var w = img.width;
          var h = img.height;
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, 0, 0);
          var imageData = ctx.getImageData(0, 0, w, h);
          var data = imageData.data;
          var offset = 0;
          var overlayR = 0;
          var overlayG = 255;
          var overlayB = 0;
          var overlayA = 0.45;

          for (var m = 0; m < shapes.length && m < rois.length; m++) {
            var mh = shapes[m][0];
            var mw = shapes[m][1];
            var roi = rois[m];
            var x1 = roi[0];
            var y1 = roi[1];
            var x2 = roi[2];
            var y2 = roi[3];
            var roiW = x2 - x1;
            var roiH = y2 - y1;
            var size = mh * mw;
            var end = offset + size;
            if (end > masksStr.length) break;
            for (var row = 0; row < mh; row++) {
              for (var col = 0; col < mw; col++) {
                var idx = offset + row * mw + col;
                var ch = masksStr.charCodeAt(idx);
                if (ch === 1) {
                  var px = x1 + Math.floor((col / mw) * roiW);
                  var py = y1 + Math.floor((row / mh) * roiH);
                  if (px >= 0 && px < w && py >= 0 && py < h) {
                    var i = (py * w + px) * 4;
                    data[i] = Math.round(data[i] * (1 - overlayA) + overlayR * overlayA);
                    data[i + 1] = Math.round(data[i + 1] * (1 - overlayA) + overlayG * overlayA);
                    data[i + 2] = Math.round(data[i + 2] * (1 - overlayA) + overlayB * overlayA);
                  }
                }
              }
            }
            offset = end;
          }
          ctx.putImageData(imageData, 0, 0);
          deferred.resolve(canvas.toDataURL('image/jpeg'));
        } catch (e) {
          deferred.reject(e);
        }
      };
      img.onerror = function () { deferred.reject(new Error('Error al cargar imagen')); };
      img.src = dataUrlImagen;
      return p;
    }

  }
})();
