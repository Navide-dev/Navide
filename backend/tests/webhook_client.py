"""HTTP client for the webhook listener tests."""

from __future__ import annotations

import http.client


class OneWriteConnection(http.client.HTTPConnection):
    """Sends the head and the body in one write, as a single packet.

    The listener refuses some requests from the head alone and closes. A body
    arriving after that makes Windows answer with a reset, which throws away the
    response the client has not read yet (WinError 10054).
    """

    def _send_output(self, message_body=None, encode_chunked=False) -> None:
        if message_body is not None and not isinstance(message_body, bytes):
            super()._send_output(message_body, encode_chunked)  # chunked: sent piece by piece
            return
        self._buffer.extend((b"", b""))
        head = b"\r\n".join(self._buffer)
        del self._buffer[:]
        self.send(head + (message_body or b""))
