from __future__ import annotations
import urllib.request
from pydantic import BaseModel
from typing import Literal


class RemoteURLRequest(BaseModel): 
    url: str
    method: str
    body: bytes | None = None
    headers: dict[str, str] = {}
    allow_redirects: bool = True
    apply_cookies_on_redirect: bool = False
    save_intermediate_responses: bool = False

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
    status_code: int | None
    headers: dict[str, str]
    intermediates: list[RemoteURLResponse] | None




# Websocket wrappers

class WebSocketServerMessage(BaseModel):
    type: Literal['urlRequest', 'result']
    content: RemoteURLRequest | None
