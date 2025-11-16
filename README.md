# YouTubeKit Server

Remote extraction server for [YouTubeKit](https://github.com/alexeichhorn/YouTubeKit), running on Cloudflare Workers.

## Overview

This server enables remote YouTube stream extraction when local extraction fails. It uses a WebSocket-based architecture where the server orchestrates HTTP requests through the client device, ensuring stream URLs remain playable on the client's network.

## How It Works

1. Client establishes WebSocket connection with video ID
2. Server uses [youtubei.js](https://github.com/LuanRT/YouTube.js) to determine required requests
3. Server sends HTTP request specifications to client via WebSocket
4. Client executes requests and returns responses
5. Server processes responses and extracts stream URLs
6. Stream URLs are sent back to client

This architecture ensures that streams work with the client's IP address and location, avoiding geo-restrictions.

## Deployment

### Prerequisites

-  [Cloudflare Workers](https://workers.cloudflare.com/) account
-  [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

### Deploy to Cloudflare Workers

```bash
npm install
npm run deploy
```

For local development:

```bash
npm run dev
```
