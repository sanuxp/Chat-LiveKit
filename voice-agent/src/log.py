import logging
import os


def setup_logger(name: str) -> logging.Logger:
    """Plain stdout logger. Logging rule (same as the backend): never log what people say, prompts or tool arguments."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
    logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    return logger
