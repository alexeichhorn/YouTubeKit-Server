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

        raw_response = await ws.receive_str()
        response = RemoteURLResponse.model_validate_json(raw_response)
        print(response)
        return response
        

    yt = YouTubeExtraction(video_id, url_request_callback=handle_url_request)
    await yt.extract()

    #async for msg in ws:
    #    print(msg)

    return ws

app = web.Application()
app.add_routes([web.get('/v1', websocket_handler)])

if __name__ == '__main__':
    web.run_app(app, host="127.0.0.1", port=8080)