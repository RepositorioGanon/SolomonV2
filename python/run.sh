#!/usr/bin/env bash
# Ejecutar el servicio Norfair. Requiere: cd python && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# (En Debian/Ubuntu puede hacer falta: sudo apt install python3.12-venv)
set -e
cd "$(dirname "$0")"
if [[ ! -d .venv ]] || [[ ! -x .venv/bin/python ]]; then
  echo "Creando venv en $(pwd)/.venv ..."
  rm -rf .venv
  python3 -m venv .venv
fi
PIP=".venv/bin/python -m pip"
if ! $PIP --version &>/dev/null; then
  echo "El venv no tiene pip. Eliminando .venv."
  rm -rf .venv
  echo "Instala: sudo apt install python3.12-venv   y vuelve a ejecutar ./run.sh"
  exit 1
fi
echo "Instalando/actualizando dependencias en .venv ..."
$PIP install -q -r requirements.txt
export TRACKER_PORT="${TRACKER_PORT:-8083}"
exec .venv/bin/python tracker_service.py
