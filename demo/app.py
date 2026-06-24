"""Tiny zero-dependency HTTP API used by the demo workflow to prove a job runs
end-to-end on a Cloudflare Container runner. Stdlib only - no pip, no network."""

from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ok":true}' if self.path == "/health" else b"flare-runner demo\n"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):  # quiet
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
