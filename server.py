import asyncio
import json
import logging
import time

import websockets
from aiohttp import web

from models import RemoteURLRequest, RemoteURLResponse, WebSocketServerMessage
from youtube_handler import YouTubeExtraction
from rate_limiter import RateLimiter
from typing import Final

RATE_LIMIT_WINDOW: Final = 60.0  # 1 minute window
RATE_LIMIT_MAX_REQUESTS: Final = 10  # num requests per window

rate_limiter = RateLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS)

async def websocket_handler(request: web.Request):
    video_id = request.query.get('videoID')
    if not (isinstance(video_id, str) and len(video_id) == 11):
        return web.Response(status=400)

    # check rate limit per user agent
    if not rate_limiter.is_allowed(request):
        return web.Response(
            status=429,
            text=json.dumps({
                "error": "Too many requests",
                "retry_after": RATE_LIMIT_WINDOW
            }),
            content_type='application/json'
        )

    rate_limiter.add_request(request)

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async def handle_url_request(req: RemoteURLRequest) -> RemoteURLResponse:
        req_start_time = time.time()

        message = WebSocketServerMessage(
            type='urlRequest',
            content=req,
        )
        await ws.send_str(message.model_dump_json())

        raw_response_bytes = await ws.receive_bytes()
        raw_response = raw_response_bytes.decode('utf-8')
        response = RemoteURLResponse.model_validate_json(raw_response)

        logging.info(f'[{video_id}] URL request for "{req.url}" took {time.time() - req_start_time:.2f} seconds')

        return response
        
    start_time = time.time()

    yt = YouTubeExtraction(video_id, url_request_callback=handle_url_request)
    streams = await yt.extract()

    message = WebSocketServerMessage(
        type='result',
        content=streams,
    )
    await ws.send_str(message.model_dump_json())

    logging.info(f'Request for {video_id} took {time.time() - start_time} seconds')

    return ws


async def ping_handler(request: web.Request):
    return web.Response(text='pong')
    

app = web.Application()
app.add_routes([web.get('/v1', websocket_handler)])
app.router.add_get('/ping', ping_handler)

if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    web.run_app(app, host="127.0.0.1", port=8080)