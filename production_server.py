# Monkey patch before any other imports
from gevent import monkey
monkey.patch_all()

import multiprocessing
import logging
import os

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)

# Calculate number of workers based on CPU cores
workers = int(os.environ.get('NUM_WORKERS', (multiprocessing.cpu_count() * 2) + 1))
logging.info(f"Using {workers} workers")

# Gunicorn config
bind = '0.0.0.0:8080'
worker_class = 'gevent'  # Required for websocket support
timeout = 120  # 2 minutes timeout for long requests
keepalive = 5
backlog = int(os.environ.get('BACKLOG', 2048))  # Connection queue size
max_requests = 1000  # Restart workers after this many requests to prevent memory leaks
max_requests_jitter = 50  # Add randomness to max_requests to prevent all workers restarting at once
worker_connections = 1000  # Maximum number of simultaneous clients per worker

# Log config
accesslog = '-'  # Log to stdout
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(L)s'  # Include request time
loglevel = 'info'

# Import the Flask app
from server import app