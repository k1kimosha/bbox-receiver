import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const authConfig = new Map();

config?.auth?.forEach((object) => authConfig.set(object.user, object.key));

/**
 * @param {import('http').ServerResponse} res
 * @param {Object} query
 * @param {'on_connect' | 'on_close'} query.on_event
 * @param {'publisher'} query.role_name
 * @param {string} query.srt_url - Example: 'input/live/pack'
 * @param {string} query.remote_ip - Example: '172.17.0.1'
 * @param {string} query.remote_port - Example: '57374'
 */
const handleSlsEvent = (res, query) => {
  console.log("event", query);
  const { role_name, srt_url, remote_ip, remote_port } = query;
  const srtUrl = srt_url.split("/");
  const [, , streamName] = srtUrl;
  if (!streamName) {
    res.statusCode = 400;
    res.end("Invalid stream name");
    return;
  }
  // get streamKey from streamName in format ?srtauth=<streamkey>
  const [streamer, p] = streamName.split("?");
  const params = new URLSearchParams(p);

  const streamKey = params.get("srtauth");

  if (query.on_event === "on_connect") {
    if (streamKey) {
      const auth = authConfig.get(streamer);
      if (auth === streamKey) {
        console.log(`${role_name} connected to ${streamer}`);
        res.statusCode = 200;
        res.end();
        return;
      } else {
        console.log(`${role_name} connected to ${streamer} with wrong key`);
        res.statusCode = 401;
        res.end();
        return;
      }
    }
  } else if (query.on_event === "on_close") {
    console.log(`${role_name} disconnected from ${streamer}`);
    res.statusCode = 200;
    res.end();
  } else {
    console.log(`${role_name} connected to ${streamer} with wrong event`);
    res.statusCode = 401;
    res.end();
  }
};

/**
 * @param {import('http').ServerResponse} res
 * @param {Object} query
 * @param {string} query.streamer
 * @param {string} query.key
 */
const handleStats = async (res, query) => {
  // URL: /sls/stats?streamer=<streamer>&key=<key>
  const { streamer, key } = query;
  const auth = authConfig.get(streamer);
  const authed = auth === key && streamer && key;
  let result = {};
  if (authed) {
    try {
      const publisherName = `live/stream/${streamer}?srtauth=${auth}`;
      // get data from stats page at localhost:8181/stats
      const pub = encodeURIComponent(publisherName);
      const data = await fetch(`http://localhost:8181/stats?publisher=${pub}`);
      const json = await data.json();
      if (json?.publishers) result = json?.publishers;
    } catch (e) {
      console.log(e);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ publishers: result ?? {}, status: "ok" }));
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "error" }));
  return;
};

const endpoints = {
  GET: { "/stats": handleStats },
  POST: { "/sls/event": handleSlsEvent },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams.entries());

  const handler = endpoints[req.method]?.[url.pathname];
  if (handler) return handler(res, query);

  res.statusCode = 404;
  res.end("Not Found");
});

server.listen(3000, () => console.log("Server started"));
