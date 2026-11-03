"""Exceptions a service raises to tell the worker how a lead ended, when it didn't simply succeed.

Anything else a service raises is an unexpected failure: the worker logs it with its traceback and treats
it like a (non-permanent) `LeadFailed`.
"""


class LeadFailed(RuntimeError):
    """The lead couldn't be processed this time (a page didn't load, the AI didn't answer ...).

    The worker retries the lead after an in-memory backoff; nothing is written to the DB for this alone.
    `permanent=True` retires the lead for good: nothing a retry could fix (no draft passed the rules).
    """

    def __init__(self, message: str, *, permanent: bool = False) -> None:
        super().__init__(message)
        self.permanent = permanent


class LeadSkipped(Exception):
    """Nothing to do for this lead, and not a failure (no usable address ...): the worker leaves it alone
    until the daemon restarts, without counting an attempt."""
