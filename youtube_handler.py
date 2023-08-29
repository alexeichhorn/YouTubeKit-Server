import asyncio
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Awaitable, Callable, Literal

import requests
import yt_dlp

from models import RemoteURLRequest, RemoteURLResponse, YouTubeStream

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
     

    def set_url_callback(self, callback: URLRequestCallback, event_loop: asyncio.AbstractEventLoop | None = None):
        self._url_callback = callback
        self._url_callback_event_loop = event_loop or asyncio.get_event_loop()

    async def urlopen_async(self, req: urllib.request.Request | str) -> WrappedResponse:
        """ Start an HTTP download """

        if isinstance(req, str):
            remote_req = RemoteURLRequest(url=req, method="GET")
        else:
            remote_req = RemoteURLRequest.from_urllib_request(req)

        #res = await self._url_callback(remote_req)
        res = asyncio.run_coroutine_threadsafe(self._url_callback(remote_req), self._url_callback_event_loop).result()
        
            
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
        self.ytdl.set_url_callback(url_request_callback, event_loop=asyncio.get_event_loop())

    async def extract(self) -> list[YouTubeStream]:
        def _extract():
            return self.ytdl.extract_info(self.video_id, download=False)

        info_dict = await asyncio.to_thread(_extract)

        if not info_dict:
            raise Exception("Invalid youtube-dl response")

        streams = []
        for format in info_dict['formats']:
            
            itag = format['format_id']
            if not itag.isnumeric():
                continue

            average_bitrate = format.get('tbr')
            average_bitrate = int(average_bitrate * 1000) if average_bitrate else None

            audio_bitrate = format.get('abr')
            audio_bitrate = int(audio_bitrate * 1000) if audio_bitrate else None

            video_bitrate = format.get('vbr')
            video_bitrate = int(video_bitrate * 1000) if video_bitrate else None

            codecs = [format.get('vcodec'), format.get('acodec')] #, format.get('scodec')]
            codecs = [c for c in codecs if c is not None and c != 'none']

            stream = YouTubeStream(
                url=format['url'],
                itag=itag,
                ext=format['ext'],
                codecs=codecs,
                average_bitrate=average_bitrate,
                audio_bitrate=audio_bitrate,
                video_bitrate=video_bitrate,
                filesize=format.get('filesize'),
            )
            streams.append(stream)

        return streams