from collections import defaultdict
import time
from dataclasses import dataclass
from typing import DefaultDict
from flask import Request


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

    def _get_key(self, request: Request) -> str:
        """Get a unique key for rate limiting based on User-Agent and IP"""
        user_agent = request.headers.get('User-Agent', 'unknown')
        ip = request.remote_addr or 'unknown'
        return f"{user_agent}:{ip}"

    def is_allowed(self, request: Request) -> bool:
        """Check if request is allowed based on rate limits"""
        key = self._get_key(request)
        return self.states[key].is_allowed()
    
    def add_request(self, request: Request) -> None:
        """Record a request for rate limiting"""
        key = self._get_key(request)
        self.states[key].add_request()
