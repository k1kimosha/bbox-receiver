# Belabox SRTLA receiver

***Provided by [IRLServer](https://irlserver.com)***

SRTLA Belabox receiver with support for multiple streams and per-stream authentication.

This Docker container is kept semi up-to-date, but is only community-supported.
It is used by multiple streamers around the world, but I am using a different setup for paid production services.

**WARNING: This is not an official Belabox project. Please don't spam rationalirl about it!**

We using the following great open-source projects:

- srt from <https://github.com/IRLServer/srt>
- srtla_rec from <https://github.com/IRLServer/srtla>
- irl-srt-server (srt-live-server fork) from <https://github.com/IRLServer/irl-srt-server>

These [IRLServer](https://irlserver.com)-supported forks have enhanced algorithms and improvements to enhance stream stability.

## Manual

The server now uses separate ports for playing and publishing. Publish the ports you need:

| Port | Proto | Purpose |
| ---- | ----- | ------- |
| 5000 | udp | SRTLA bonded input (Belabox connects here) |
| 4000 | udp | Player port (pull the stream here, any publish method) |
| 4001 | udp | Direct SRT publishers (OBS, FFmpeg, anything without SRTLA) |
| 8181 | tcp | Statistics HTTP API |
| 3000 | tcp | Legacy statistics and event hooks |
| 8282 | udp | Legacy combined publish/play port (kept for backwards compatibility) |

Port 4002/udp is the SRTLA publisher port. It only receives traffic from `srtla_rec` over localhost, so it does not need to be published.

Create a config.json file containing:

```json
{
  "auth": [
    {
      "user": "belabox",
      "key": "belabox"
    },
    {
      "user": "second_user",
      "key": "secret_key"
    }
  ]
}
```

Modify everything in bold below, then start with:

docker run -d --name belabox-receiver -p 5000:5000/udp -p 4000:4000/udp -p 4001:4001/udp -p 8181:8181/tcp -p 3000:3000/tcp -v ./config.json:/app/config.json datagutt/belabox-receiver:latest

### Publishing (Belabox / SRTLA)

Configure the SRT receiver and SRT port within Belabox to point to the docker container's IP address (or a port-forward on your router), using port 5000.
Within Belabox, set "live/stream/belabox?srtauth=belabox" as SRT streamid.

### Publishing (direct SRT, no SRTLA)

For a direct SRT publisher (OBS, FFmpeg) without bonding, publish to port 4001:
srt://your-public-container-ip:4001?streamid=live/stream/belabox?srtauth=belabox

### Playing

To retrieve the SRT stream (via OBS, VLC etc.), regardless of how it was published, open the following URL on the player port 4000:
srt://your-public-container-ip:4000?streamid=play/stream/belabox?srtauth=belabox

The legacy port 8282 still serves both publishing and playing for older setups.

Statistics-URL: <http://your-public-container-ip:8181/stats?publisher=live%2Fstream%2Fbelabox%3Fsrtauth%3Dbelabox>

Legacy Statistics-URL: <http://your-public-container-ip:3000/stats?streamer=belabox&key=belabox>
