# Сервер превью. Отличается от python -m http.server ровно одним: каждому ответу
# ставит Cache-Control: no-store. Иначе браузер держит app.js в своём кэше, и
# правки смотрятся из вчерашней сборки - ровно это и случилось 21.09.2026.
#
# Запуск:  python preview-server.py       (порт 8000)
import functools, http.server, socketserver

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # Тихий лог: в консоли нужен только факт запуска.
    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", 8000), NoCache) as httpd:
        print("preview: http://localhost:8000/preview.html (no-store)")
        httpd.serve_forever()
