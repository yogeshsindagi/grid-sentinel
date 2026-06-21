#!/bin/bash
cd /home/site/wwwroot
pip install -r backend/requirements.txt --quiet
gunicorn -w 1 -k uvicorn.workers.UvicornWorker backend.main:app \
  --timeout 600 \
  --bind 0.0.0.0:8000 \
  --preload
