from __future__ import annotations
import base64
import urllib.request
from pydantic import BaseModel
from typing import Any, Literal


class RemoteURLRequest(BaseModel): 
    url: str
    method: str
    body: bytes | None = None
    headers: dict[str, str] = {}
    allow_redirects: bool = True
    apply_cookies_on_redirect: bool = False
    save_intermediate_responses: bool = False
    
    # def model_dump(self, **kwargs):
    #     base_dict = super().model_dump(**kwargs)
    #     if self.body is not None:
    #         base_dict['body'] = base64.b64encode(self.body).decode('utf-8')
    #     return base_dict

    def model_post_init(self, __context: Any):
        super().model_post_init(__context)
        if self.body is not None:
            # encode to base64 for later JSON serialization (TODO: find a better way at a later stage)
            self.body = base64.b64encode(self.body)

    @staticmethod
    def from_urllib_request(req: urllib.request.Request):
        return RemoteURLRequest(
            url=req.full_url,
            method=req.get_method(),
            body=req.data, # type: ignore
            headers=dict(req.headers),
        )



class RemoteURLResponse(BaseModel):
    url: str
    data: bytes
    status_code: int | None = None
    headers: dict[str, str]
    intermediates: list[RemoteURLResponse] | None = None

    def model_post_init(self, __context: Any):
        super().model_post_init(__context)
        # decode from base64 (TODO: find a better way to only convert when coming from JSON)
        self.data = base64.b64decode(self.data)



# YouTube streams

class YouTubeStream(BaseModel):
    url: str
    itag: int
    ##mime_type: str
    ext: str
    video_codec: str | None
    audio_codec: str | None
    average_bitrate: int | None
    audio_bitrate: int | None
    video_bitrate: int | None
    filesize: int | None


# Websocket wrappers

class WebSocketServerMessage(BaseModel):
    type: Literal['urlRequest', 'result']
    content: RemoteURLRequest | list[YouTubeStream]
