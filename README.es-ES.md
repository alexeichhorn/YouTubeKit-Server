

# YouTubeKit Server

Servidor de extracción remota para [YouTubeKit](https://github.com/alexeichhorn/YouTubeKit), que se ejecuta en Cloudflare Workers.

## Descripción general

Este servidor permite la extracción remota de transmisiones de YouTube cuando la extracción local falla. Utiliza una arquitectura basada en WebSocket en la que el servidor orquesta solicitudes HTTP a través del dispositivo del cliente, asegurando que las URLs de las transmisiones sigan siendo reproducibles en la red del cliente.

## Cómo funciona

1. El cliente establece una conexión WebSocket con el ID del video
2. El servidor utiliza [youtubei.js](https://github.com/LuanRT/YouTube.js) para determinar las solicitudes necesarias
3. El servidor envía las especificaciones de las solicitudes HTTP al cliente a través de WebSocket
4. El cliente ejecuta las solicitudes y devuelve las respuestas
5. El servidor procesa las respuestas y extrae las URLs de las transmisiones
6. Las URLs de las transmisiones se envían de vuelta al cliente

Esta arquitectura garantiza que las transmisiones funcionen con la dirección IP y ubicación del cliente, evitando restricciones geográficas.

## Despliegue

### Requisitos previos

- Cuenta de [Cloudflare Workers](https://workers.cloudflare.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) instalado

### Desplegar en Cloudflare Workers

```bash
npm install
npm run deploy
```

Para desarrollo local:

```bash
npm run dev
```

## Limitación de tasa

Las solicitudes están limitadas por ID de aplicación (`X-AppID-v1`) utilizando un Durable Object con ventanas ancladas:

- la ventana diaria comienza con la primera solicitud y dura 24 horas
- la ventana semanal comienza con la primera solicitud y dura 7 días
- cuando una ventana expira, la siguiente solicitud inicia una nueva ventana

Configure los límites mediante variables de entorno en `wrangler.toml`:

- `RATE_LIMIT_DAILY_REQUESTS`: solicitudes máximas por ID de aplicación en cada ventana de 24 horas.
- `RATE_LIMIT_WEEKLY_REQUESTS`: solicitudes máximas por ID de aplicación en cada ventana de 7 días.
