const express = require("express");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();

const PROXY_KEY = process.env.PROXY_KEY || "";

// Optional API-key middleware
app.use((req, res, next) => {
  if (!PROXY_KEY) return next();
  const key = req.query.key || req.get("x-api-key");
  if (key === PROXY_KEY) return next();
  res.status(401).send("Unauthorized: missing or invalid proxy key");
});

// Homepage with URL form
app.get("/", (req, res) => {
  res.send(`
    <h2>Mini Proxy (Navigation-enabled)</h2>
    <form method="get" action="/proxy">
      <input type="text" name="url" placeholder="https://example.com" size="60" />
      <input type="text" name="key" placeholder="API key (if required)" size="30"/>
      <button type="submit">Go</button>
    </form>
  `);
});

// Main proxy endpoint
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url=...");

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).send("Only http/https URLs supported");
    }
  } catch {
    return res.status(400).send("Invalid URL");
  }

  try {
    const forwardedHeaders = {
      "user-agent": req.get("user-agent") || "node-proxy",
      accept: req.get("accept") || "*/*",
      cookie: req.get("cookie") || undefined,
    };

    const upstreamRes = await fetch(parsed.toString(), {
      headers: forwardedHeaders,
      redirect: "follow",
    });

    const contentType = upstreamRes.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      const body = await upstreamRes.text();
      const $ = cheerio.load(body, { decodeEntities: false });

      const resolveAbsolute = (maybeUrl) => {
        if (!maybeUrl || typeof maybeUrl !== "string") return null;
        if (/^(javascript:|data:|mailto:|#)/i.test(maybeUrl)) return maybeUrl;
        try {
          return new URL(maybeUrl, upstreamRes.url).toString();
        } catch {
          return null;
        }
      };

      const rewriteAttr = (selector, attrName) => {
        $(selector).each((i, el) => {
          const orig = $(el).attr(attrName);
          if (!orig) return;
          const abs = resolveAbsolute(orig);
          if (!abs) return;
          const keyParam = req.query.key ? `&key=${encodeURIComponent(req.query.key)}` : "";
          $(el).attr(attrName, `/proxy?url=${encodeURIComponent(abs)}${keyParam}`);
        });
      };

      rewriteAttr("a", "href");
      rewriteAttr("img", "src");
      rewriteAttr("script", "src");
      rewriteAttr("link", "href");
      rewriteAttr("iframe", "src");
      rewriteAttr("source", "src");
      rewriteAttr("video", "src");
      rewriteAttr("audio", "src");
      rewriteAttr("embed", "src");
      rewriteAttr("object", "data");

      $("form").each((i, form) => {
        const $form = $(form);
        const action = $form.attr("action") || "";
        const abs = resolveAbsolute(action || upstreamRes.url);
        if (abs) {
          const keyParam = req.query.key ? `&key=${encodeURIComponent(req.query.key)}` : "";
          $form.attr("action", `/proxy?url=${encodeURIComponent(abs)}${keyParam}`);
          if (($form.attr("method") || "GET").toUpperCase() === "POST") {
            $form.prepend(
              `<input type="hidden" name="_proxied_original_method" value="POST" />`
            );
          }
        }
      });

      $("img").each((i, img) => {
        const srcset = $(img).attr("srcset");
        if (!srcset) return;
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .map((candidate) => {
            const [urlPart, descriptor] = candidate.split(/\s+/, 2);
            const abs = resolveAbsolute(urlPart);
            if (!abs) return candidate;
            const keyParam = req.query.key ? `&key=${encodeURIComponent(req.query.key)}` : "";
            return `/proxy?url=${encodeURIComponent(abs)}${keyParam}` + (descriptor ? ` ${descriptor}` : "");
          });
        $(img).attr("srcset", parts.join(", "));
      });

      $("body").prepend(
        `<div style="background:#f2f2f2;padding:6px 10px;border-bottom:1px solid #ddd;font-size:13px;">
           Proxied via Mini Proxy — <a href="/?${req.query.key ? "key=" + encodeURIComponent(req.query.key) : ""}">Home</a>
         </div>`
      );

      res.set("content-type", "text/html; charset=utf-8");
      return res.send($.html());
    }

    // Non-HTML: stream binary data
    const headersToCopy = ["content-type", "content-length", "cache-control", "content-encoding", "last-modified"];
    headersToCopy.forEach((h) => {
      const val = upstreamRes.headers.get(h);
      if (val) res.set(h, val);
    });

    const reader = upstreamRes.body.getReader();
    const stream = new ReadableStream({
      async start(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      },
    });
    const resStream = stream.pipeThrough(new TransformStream());
    const buffer = await new Response(resStream).arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Error fetching target: " + err.message);
  }
});

app.get("/_health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
