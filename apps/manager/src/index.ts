import { app } from "./app";

export default {
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8090),
  fetch: app.fetch,
};
