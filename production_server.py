import logging
from aiohttp import web
from server import app

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    web.run_app(app, host="0.0.0.0", port=8080)