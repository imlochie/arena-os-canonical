import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import importedRouter from "./routes/imported";
import path from "node:path";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.set("trust proxy", process.env.ARENA_DESKTOP_MODE === "1" ? false : 1);
if (process.env.ARENA_DESKTOP_MODE === "1") {
  // The native app is single-owner and unauthenticated. Refuse DNS rebinding,
  // forwarded-host spoofing, and remote browser reads, not just cross-site writes.
  app.use((req, res, next) => {
    if (req.get("host") !== `127.0.0.1:${process.env.PORT}`
      || req.get("sec-fetch-site") === "cross-site"
      || (req.get("origin") && req.get("origin") !== `http://127.0.0.1:${process.env.PORT}`)) {
      res.status(403).json({ error: "Desktop requests must come from this app" });
      return;
    }
    delete req.headers["x-forwarded-host"];
    delete req.headers["x-forwarded-proto"];
    next();
  });
}
app.use("/api", importedRouter);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

if (process.env.ARENA_DESKTOP_MODE === "1") {
  const webRoot = process.env.ARENA_WEB_ROOT;
  if (!webRoot || !path.isAbsolute(webRoot)) throw new Error("ARENA_WEB_ROOT must be an absolute built Vite directory");
  app.use(express.static(webRoot, { index: false }));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) { next(); return; }
    res.sendFile(path.join(webRoot, "index.html"));
  });
}

export default app;
