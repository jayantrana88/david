"""State carried by a LinkedIn run, and its abort signal. The outcome is a SourcingRun."""
from dataclasses import dataclass, field


class RunAborted(Exception):
    """LinkedIn keeps refusing our requests, the search key was refused, or the fetch cap was hit: stop the run."""


@dataclass
class RunState:
    known: set[str] = field(default_factory=set)   # normalized website URLs already saved (DB + this run)
    pages: dict = field(default_factory=dict)      # slug -> parsed page, so a company found by two searches is fetched once
    fetches: int = 0
    consecutive_failures: int = 0
