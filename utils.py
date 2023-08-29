


def safe_to_float(x: str | None) -> float | None:
    if x is None:
        return None
    
    try:
        return float(x)
    except ValueError:
        return None