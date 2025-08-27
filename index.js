const express = require("express");
const fetch = require("node-fetch"); // v2-style require
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();

const PROXY_KEY = process.env.PROXY_KEY || ""; // optional: set on Railway

// simple API-key middleware (if PROXY_KEY is set)
app.use((req, res, next) => {
  if (!PROXY_KEY) return next();
  const key = req.query.key || req.get("x-api-key");
  if (key === PROXY_KEY) return next();
  res.status(401).send("Unauthorized: missing or invalid proxy key");
});

// homepage with a form to enter a URL
app.get("/", (req, res) => {
  res.send(`
    <h2>Mini Proxy (Navigation-enabled)</h2>
    <form method="get" action="/proxy">
      <input type="text" name="url" placeholder="https://example.com" size="60" />
      <input type="text" name="key" placeholder="API key (if required)" size="30"/>
      <button type="submit">Go</button>
    </form>
    <p>Tip: to keep browsing working, use links on the fetched pages (they will be rewritten to route through this proxy).</p>
  `);
});

// main proxy endpoint: rewrites HTML, streams other types
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url=...");

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).send("Only http/https URLs supported");
    }
  } catch (err) {
    return res.status(400).send("Invalid URL");
  }

  try {
    // forward some request headers (user-agent, accept) to improve compatibility
    const forwardedHeaders = {
      "user-agent": req.get("user-agent") || "node-proxy",
      accept: req.get("accept") || "*/*",
      // cookies could be forwarded if desired:
      cookie: req.get("cookie") || undefined,
    };

    const upstreamRes = await fetch(parsed.toString(), {
      headers: forwardedHeaders,
      redirect: "follow",
    });

    const contentType = upstreamRes.headers.get("content-type") || "";

    // If it's HTML, parse & rewrite links so they point back to /proxy?url=...
    if (contentType.includes("text/html")) {
      const body = await upstreamRes.text();
      const $ = cheerio.load(body, { decodeEntities: false });

      // helper: convert a possibly-relative URL to absolute based on the page's base
      const resolveAbsolute = (maybeUrl) => {
        if (!maybeUrl || typeof maybeUrl !== "string") return null;
        // handle javascript: and data: and mailto:
        if (/^(javascript:|data:|mailto:|#)/i.test(maybeUrl)) return maybeUrl;
        try {
          return new URL(maybeUrl, upstreamRes.url).toString();
        } catch {
          return null;
        }
      };

      // rewrite attributes for elements that reference other resources
      const rewriteAttr = (selector, attrName) => {
        $(selector).each((i, el) => {
          const orig = $(el).attr(attrName);
          if (!orig) return;
          const abs = resolveAbsolute(orig);
          if (!abs) return;
          // keep api key if provided in incoming query
          const keyParam = req.query.key ? `&key=${encodeURIComponent(req.query.key)}` : "";
          $(el).attr(attrName, `/proxy?url=${encodeURIComponent(abs)}${keyParam}`);
        });
      };

      // common rewrites
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

      // forms: rewrite action attribute
      $("form").each((i, form) => {
        const $form = $(form);
        const action = $form.attr("action") || "";
        const abs = resolveAbsolute(action || upstreamRes.url);
        if (abs) {
          const keyParam = req.query.key ? `&key=${encodeURIComponent(req.query.key)}` : "";
          // we'll proxy form submissions to /proxy?url=ABS and preserve method on client-side
          $form.attr("action", `/proxy?url=${encodeURIComponent(abs)}${keyParam}`);
          // if method is POST, we need to allow that — but this minimal proxy currently only handles GET.
          // Add a small hint for non-GET forms
          if (($form.attr("method") || "GET").toUpperCase() === "POST") {
            // insert hidden input to signal server - not implementing full POST proxy here
            $form.prepend(
              `<input type="hidden" name="_proxied_original_method" value="POST" />`
            );
          }
        }
      });

      // handle srcset attribute (images with multiple candidates)
      $("img").each((i, img) => {
        const srcset = $(img).attr("srcset");
        if (!srcset) return;
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .map((candidate) => {
            // candidate looks like: "image-640.jpg 640w" or "image.jpg 2x"
            const [urlPart, descriptor] = candidate.split(/\s+/, 2);
            const abs = resolveAbsolute(urlPart);
            if (!abs) return candidate;
            const keyParam = req.query.key ? `&key=${encodeURIComponent(req.query.key)}` : "";
            return `/proxy?url=${encodeURIComponent(abs)}${keyParam}` + (descriptor ? ` ${descriptor}` : "");
          });
        $(img).attr("srcset", parts.join(", "));
      });

      // Insert a small banner so user knows they're proxied (optional)
      $("body").prepend(
        `<div style="background:#f2f2f2;padding:6px 10px;border-bottom:1px solid #ddd;font-size:13px;">
           Proxied via Mini Proxy — <a href="/?${req.query.key ? "key=" + encodeURIComponent(req.query.key) : ""}">Home</a>
         </div>`
      );

      // Send rewritten HTML
      res.set("content-type", "text/html; charset=utf-8");
      return res.send($.html());
    }

    // Non-HTML: stream it back and copy content-type and content-length where possible
    // also copy cache-related headers if present
    const headersToCopy = ["content-type", "content-length", "cache-control", "content-encoding", "last-modified"];
    headersToCopy.forEach((h) => {
      const val = upstreamRes.headers.get(h);
      if (val) res.set(h, val);
    });

    // pipe the stream for binary content
    const upstreamBody = upstreamRes.body;
    if (!upstreamBody) return res.status(500).send("Upstream had no body");
    upstreamBody.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Error fetching target: " + err.message);
  }
});

// small health endpoint
app.get("/_health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
