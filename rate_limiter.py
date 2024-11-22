from collections import defaultdict
import time
from dataclasses import dataclass
from typing import DefaultDict
from aiohttp import web


@dataclass
class RateLimitState:
    requests: list[float]
    window_size: float
    max_requests: int

    def is_allowed(self) -> bool:
        current_time = time.time()
        # Remove old requests outside the window
        self.requests = [t for t in self.requests if current_time - t <= self.window_size]
        return len(self.requests) < self.max_requests

    def add_request(self) -> None:
        self.requests.append(time.time())


class RateLimiter:
    def __init__(self, window_size: float = 60.0, max_requests: int = 10):
        self.window_size = window_size
        self.max_requests = max_requests
        self.states: DefaultDict[str, RateLimitState] = defaultdict(
            lambda: RateLimitState([], window_size, max_requests)
        )

    def key_is_allowed(self, key: str) -> bool:
        return self.states[key].is_allowed()

    def add_request_key(self, key: str) -> None:
        self.states[key].add_request() 

    def _get_key(self, request: web.Request) -> str:
        return request.headers.get('User-Agent', 'unknown')

    def is_allowed(self, request: web.Request) -> bool:
        user_agent = self._get_key(request)
        return self.key_is_allowed(user_agent)
    
    def add_request(self, request: web.Request) -> None:
        user_agent = self._get_key(request)
        self.add_request_key(user_agent)
