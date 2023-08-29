import asyncio
import json

import websockets
from aiohttp import web

from models import RemoteURLRequest, RemoteURLResponse, WebSocketServerMessage
from youtube_handler import YouTubeExtraction


async def websocket_handler(request: web.Request):
    video_id = request.query.get('videoID')
    if not (isinstance(video_id, str) and len(video_id) == 11):
        return web.Response(status=400)

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async def handle_url_request(req: RemoteURLRequest) -> RemoteURLResponse:
        message = WebSocketServerMessage(
            type='urlRequest',
            content=req,
        )
        await ws.send_str(message.model_dump_json())

        raw_response_bytes = await ws.receive_bytes()
        raw_response = raw_response_bytes.decode('utf-8')
        response = RemoteURLResponse.model_validate_json(raw_response)

        return response
        

    yt = YouTubeExtraction(video_id, url_request_callback=handle_url_request)
    streams = await yt.extract()

    message = WebSocketServerMessage(
        type='result',
        content=streams,
    )
    await ws.send_str(message.model_dump_json())

    return ws

app = web.Application()
app.add_routes([web.get('/v1', websocket_handler)])

if __name__ == '__main__':
    web.run_app(app, host="127.0.0.1", port=8080)