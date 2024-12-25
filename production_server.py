# Monkey patch before any other imports
from gevent import monkey
monkey.patch_all()

import multiprocessing
import logging
import os

logging.basicConfig(level=logging.INFO)

# Calculate number of workers based on CPU cores
workers = os.environ.get('NUM_WORKERS', (multiprocessing.cpu_count() * 2) + 1)
print(f"Using {workers} workers")

# Gunicorn config
bind = '0.0.0.0:8080'
worker_class = 'gevent'  # Required for websocket support
timeout = 120  # 2 minutes timeout for long requests
keepalive = 5

# Import the Flask app
from server import app