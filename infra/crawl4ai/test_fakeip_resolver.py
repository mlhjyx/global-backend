import socket
import unittest
from unittest.mock import Mock

import fakeip_resolver


def answer(ip: str, port: int = 443):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr = (ip, port, 0, 0) if family == socket.AF_INET6 else (ip, port)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)


class FakeIpFallbackTest(unittest.TestCase):
    def test_all_fake_ip_answers_use_fixed_doh(self):
        system = Mock(return_value=[answer("198.18.0.25")])
        doh = Mock(return_value=[answer("104.20.23.154")])

        resolver = fakeip_resolver.make_resolver(system, doh_lookup=doh, enabled=True)

        self.assertEqual(resolver("example.com", 443), [answer("104.20.23.154")])
        doh.assert_called_once_with("example.com", 443)

    def test_private_and_mixed_answers_never_fall_back(self):
        doh = Mock(return_value=[answer("104.20.23.154")])
        for answers in (
            [answer("10.0.0.2")],
            [answer("198.18.0.25"), answer("127.0.0.1")],
        ):
            with self.subTest(answers=answers):
                system = Mock(return_value=answers)
                resolver = fakeip_resolver.make_resolver(system, doh_lookup=doh, enabled=True)
                self.assertEqual(resolver("private.example", 443), answers)
        doh.assert_not_called()

    def test_public_system_dns_is_untouched(self):
        answers = [answer("1.1.1.1")]
        doh = Mock(return_value=[answer("8.8.8.8")])
        resolver = fakeip_resolver.make_resolver(
            Mock(return_value=answers), doh_lookup=doh, enabled=True
        )

        self.assertEqual(resolver("public.example", 443), answers)
        doh.assert_not_called()

    def test_disabled_fallback_preserves_upstream_guard_behavior(self):
        answers = [answer("198.18.0.25")]
        doh = Mock(return_value=[answer("1.1.1.1")])
        resolver = fakeip_resolver.make_resolver(
            Mock(return_value=answers), doh_lookup=doh, enabled=False
        )

        self.assertEqual(resolver("example.com", 443), answers)
        doh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
