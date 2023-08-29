import asyncio
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Awaitable, Callable, Literal

import requests
import yt_dlp

from models import RemoteURLRequest, RemoteURLResponse

URLRequestCallback = Callable[[RemoteURLRequest], Awaitable[RemoteURLResponse]]

class FakeYoutubeDL(yt_dlp.YoutubeDL):

    class WrappedResponse:
        def __init__(self, response: RemoteURLResponse):
            self.response = response

        def read(self) -> bytes:
            return self.response.data
        
        @property
        def headers(self):
            return self.response.headers

        def geturl(self):
            return self.response.url
     

    def set_url_callback(self, callback: URLRequestCallback):
        self._url_callback = callback

    async def urlopen_async(self, req: urllib.request.Request | str) -> WrappedResponse:
        """ Start an HTTP download """

        if isinstance(req, str):
            remote_req = RemoteURLRequest(url=req, method="GET")
        else:
            remote_req = RemoteURLRequest.from_urllib_request(req)

        res = await self._url_callback(remote_req)
        
            
        # TODO: add saved cookies to request

        # if req.get_method() == "GET":
        #     res = requests.get(req.full_url, headers=req.headers)
        #     x = WrappedResponse(res)

        # elif req.get_method() == "POST":
        #     res = requests.post(req.full_url, headers=req.headers, data=req.data)
        #     x = WrappedResponse(res)

        # else:
        #     raise NotImplementedError(f"Method {req.get_method()} not implemented")
            
        return self.WrappedResponse(res)
    


    def urlopen(self, req: urllib.request.Request | str) -> WrappedResponse:
        """ Start an HTTP download """

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        task = loop.create_task(self.urlopen_async(req))
        loop.run_until_complete(task)
        return task.result()
        



class YouTubeExtraction:

    def __init__(self, video_id: str, url_request_callback: URLRequestCallback):
        self.video_id = video_id
        self.ytdl = FakeYoutubeDL({
            'outtmpl': '%(id)s%(ext)s',
            'quiet': True,
        })
        self.ytdl.set_url_callback(url_request_callback)

    async def extract(self):
        def _extract():
            return self.ytdl.extract_info(self.video_id, download=False)

        info_dict = await asyncio.to_thread(_extract)
        #print(info_dict)
        print(len(info_dict))
        print(len(info_dict['formats']))

        import json
        print(json.dumps(info_dict['formats'][0:20]))