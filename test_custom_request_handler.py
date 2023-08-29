import asyncio
from youtube_handler import YouTubeExtraction
from models import RemoteURLRequest, RemoteURLResponse
import httpx


async def main():

    async def url_callback(req: RemoteURLRequest) -> RemoteURLResponse:
        # if req.get_method() == "GET":
        #     res = requests.get(req.full_url, headers=req.headers)
        #     x = WrappedResponse(res)

        # elif req.get_method() == "POST":
        #     res = requests.post(req.full_url, headers=req.headers, data=req.data)
        #     x = WrappedResponse(res)

        # else:
        #     raise NotImplementedError(f"Method {req.get_method()} not implemented")

        async with httpx.AsyncClient() as client:
            res = await client.request(req.method, req.url, headers=req.headers, content=req.body)

            print(res.url)

            return RemoteURLResponse(
                url=str(res.url),
                data=res.content,
                status_code=res.status_code,
                headers=dict(res.headers.multi_items()),
                intermediates=None,
            )

    yt = YouTubeExtraction("2lAe1cqCOXo", url_callback)
    print(await yt.extract())


if __name__ == '__main__':
    asyncio.run(main())