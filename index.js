const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

// Replace with the site/API you want to proxy to
const target = "https://example.com"; 

// Proxy route
app.use(
  "/api",
  createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: { "^/api": "" }, // so "/api/foo" -> "https://example.com/foo"
  })
);

app.get("/", (req, res) => {
  res.send("Proxy is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
});
