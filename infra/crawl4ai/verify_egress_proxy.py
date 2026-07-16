"""No-pytest verification of the pinned Crawl4AI browser egress proxy.

Run against the built image:
  docker run --rm --entrypoint python \
    -e CRAWL4AI_FAKEIP_DOH_FALLBACK=true \
    -v "$PWD/infra/crawl4ai/verify_egress_proxy.py:/tmp/verify.py:ro" \
    global-crawl4ai:local /tmp/verify.py
"""

from __future__ import annotations

import asyncio
import sys
from unittest.mock import Mock, patch

sys.path.insert(0, "/app")
import egress_proxy
from egress_broker import EgressBlocked, PinnedTarget
from playwright.async_api import async_playwright


async def read_headers(reader: asyncio.StreamReader) -> bytes:
    return await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)


async def main() -> None:
    async def echo(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        data = await asyncio.wait_for(reader.read(4), timeout=5)
        writer.write(b"PONG" if data == b"PING" else b"FAIL")
        await writer.drain()
        writer.close()

    upstream = await asyncio.start_server(echo, "127.0.0.1", 0)
    upstream_port = upstream.sockets[0].getsockname()[1]
    proxy = egress_proxy.PinningProxy()
    await proxy.start()
    try:
        resolver = Mock(
            return_value=PinnedTarget(
                scheme="https",
                host="rebind.example",
                port=upstream_port,
                ip="127.0.0.1",  # test injection: prove the proxy dials the returned pin
            )
        )
        with patch.object(egress_proxy, "resolve_and_pin", resolver):
            reader, writer = await asyncio.open_connection(proxy.bound_host, proxy.bound_port)
            writer.write(
                f"CONNECT rebind.example:{upstream_port} HTTP/1.1\r\nHost: rebind.example\r\n\r\n".encode()
            )
            await writer.drain()
            headers = await read_headers(reader)
            assert headers.startswith(b"HTTP/1.1 200"), headers
            writer.write(b"PING")
            await writer.drain()
            assert await asyncio.wait_for(reader.readexactly(4), timeout=5) == b"PONG"
            writer.close()
            resolver.assert_called_once()
        print("  ✅ browser proxy 只连接 resolve_and_pin 返回的单一 pin（无二次 DNS）")

        with patch.object(egress_proxy, "resolve_and_pin", side_effect=EgressBlocked()):
            reader, writer = await asyncio.open_connection(proxy.bound_host, proxy.bound_port)
            writer.write(
                b"CONNECT metadata.google.internal:80 HTTP/1.1\r\nHost: metadata.google.internal\r\n\r\n"
            )
            await writer.drain()
            headers = await read_headers(reader)
            assert headers.startswith(b"HTTP/1.1 403"), headers
            writer.close()
        print("  ✅ rebind/private 解析结果由 proxy 在连接前 403 拒绝")

        # 真 Chromium 跟随公网 302 后必须在 metadata 连接前停下；最终页面只能是
        # pinning proxy 自己的固定 403 body，不能是 metadata 响应或普通网络误差。
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=True, proxy={"server": proxy.url}
            )
            try:
                page = await browser.new_page()
                response = await page.goto(
                    "https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F",
                    wait_until="domcontentloaded",
                    timeout=30_000,
                )
                body = ((await page.text_content("body")) or "").strip()
                assert response is not None and response.status == 403, response
                assert body == "URL blocked", body
            finally:
                await browser.close()
        print("  ✅ 真 Chromium 跟随公网 redirect 后由 pinning proxy 403 metadata")
    finally:
        await proxy.stop()
        upstream.close()
        await upstream.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
