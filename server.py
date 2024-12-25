import json
import logging
import time
from flask import Flask, request, Response
from flask_sock import Sock
from typing import Final

from models import RemoteURLRequest, RemoteURLResponse, WebSocketServerMessage, YouTubeStream
from youtube_handler import YouTubeExtraction
from rate_limiter import RateLimiter

RATE_LIMIT_WINDOW: Final = 60.0  # 1 minute window
RATE_LIMIT_MAX_REQUESTS: Final = 10  # num requests per window

app = Flask(__name__)
sock = Sock(app)
rate_limiter = RateLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_REQUESTS)

@sock.route('/v1')
def youtube_handler(ws):
    video_id = request.args.get('videoID')
    if not (isinstance(video_id, str) and len(video_id) == 11):
        return

    # check rate limit per user agent and IP
    if not rate_limiter.is_allowed(request):
        logging.info(f"Rate limit exceeded for {request.headers.get('User-Agent', 'unknown')} from {request.remote_addr}")
        ws.send(json.dumps({
            "error": "Too many requests",
            "retry_after": RATE_LIMIT_WINDOW
        }))
        return

    rate_limiter.add_request(request)

    def handle_url_request(req: RemoteURLRequest) -> RemoteURLResponse:
        req_start_time = time.time()

        message = WebSocketServerMessage(
            type='urlRequest',
            content=req,
        )
        ws.send(message.model_dump_json())

        raw_response = ws.receive()
        response = RemoteURLResponse.model_validate_json(raw_response)

        logging.info(f'[{video_id}] URL request for "{req.url}" took {time.time() - req_start_time:.2f} seconds')

        return response
        
    start_time = time.time()

    try:
        yt = YouTubeExtraction(video_id, url_request_callback=handle_url_request)
        streams = yt.extract()

        message = WebSocketServerMessage(
            type='result',
            content=streams,
        )
        ws.send(message.model_dump_json())

        logging.info(f'Request for {video_id} took {time.time() - start_time:.2f} seconds')
    except Exception as e:
        logging.error(f"Error processing video {video_id}: {str(e)}")
        ws.send(json.dumps({"error": str(e)}))

@app.route('/ping')
def ping():
    return 'pong'

if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    app.run(host="127.0.0.1", port=8080)